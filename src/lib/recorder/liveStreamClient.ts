// LiveStreamClient — WebSocket transport for real-time PCM16 audio streaming.
//
// Protocol (per frame):
//   1. JSON  → { type: "audio_frame_meta", ... }
//   2. Binary → raw PCM16 little-endian ArrayBuffer
//
// Connection lifecycle:
//   idle → connecting → streaming ↔ reconnecting → failed
//
// Reliability guarantees:
//   • Frames produced during reconnect are buffered (up to MAX_PENDING_FRAMES).
//   • On reconnect, unACKed frames are moved back to the replay buffer so no
//     audio is silently lost during a disconnect, even mid-drain.
//   • The server's next_frame_index (from session_ack / frame_ack) is used to
//     skip already-confirmed frames in the replay, preventing duplicates.
//   • commitAndClose() drains the buffer, waits for server ACKs (if supported),
//     then sends session_commit. Commit is never dropped while reconnecting.
//   • Back-pressure via ws.bufferedAmount: frames are held locally when the
//     socket's send queue exceeds MAX_BUFFERED_BYTES.
//   • { type:"fatal", code:"realtime_resume_unavailable" } halts reconnection
//     and calls onFatal so the store can trigger audio-recovery upload.
//
// Backend contract:
//   session_hello (reconnect)  →  { is_reconnect:true, resume_from_frame_index:N }
//   server hello ACK           →  { type:"ack", next_frame_index:N }
//   server frame_ack           →  { type:"frame_ack", last_frame_index:N }
//   server fatal               →  { type:"fatal", code:"realtime_resume_unavailable" }

import { FRAME_DURATION_MS, LIVE_SAMPLE_RATE } from './pcmCapture';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LiveStreamState = 'idle' | 'connecting' | 'streaming' | 'reconnecting' | 'failed';

export interface FrameMeta {
  frameIndex: number;
  startMs:    number;
  endMs:      number;
}

export interface LiveStreamStats {
  framesSent:    number;
  framesDropped: number;  // lost due to buffer overflow (unrecoverable)
  framesPending: number;  // in local buffer, not yet sent
  framesUnacked: number;  // sent to server, awaiting frame_ack
  lastAckIndex:  number;  // last frame index confirmed by server (-1 = no ACK)
}

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

function getWsBase(): string {
  // import.meta.env.DEV is a Vite build-time boolean:
  //   • true  in `vite dev` — route through the /ws Vite proxy to localhost:8100
  //   • false in production builds (deployed PWA, iOS Capacitor)
  if (import.meta.env.DEV) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }
  return 'wss://api.eigenvertex.com';
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RECONNECTS      = 3;
const RECONNECT_BASE_MS   = 1_500;
const CONNECT_TIMEOUT_MS  = 8_000;
const ACK_WAIT_TIMEOUT_MS   = 15_000;
// Max wait for the server's { type:"ack", next_frame_index } after a reconnect hello.
// After this delay the drain proceeds without server-side dedup info (server still
// deduplicates by frame_index, so replaying confirmed frames is safe but wasteful).
const HELLO_ACK_TIMEOUT_MS  = 5_000;

// Back-pressure threshold on the socket kernel send buffer.
const MAX_BUFFERED_BYTES  = 512_000;   // 512 KB

// Local frame buffer bounds. ~300 frames × 10 240 bytes ≈ 3 MB — safe on iOS.
const MAX_PENDING_FRAMES  = 300;       // ~96 s at 320 ms/frame
const MAX_PENDING_BYTES   = 3_000_000;

// Sliding window of sent-but-not-ACKd frames. Older entries evicted if server
// doesn't support frame_ack — accepting the same "best effort" loss as before.
const MAX_UNACKED_FRAMES  = 400;       // ~128 s at 320 ms/frame

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

interface PendingFrame {
  pcm:  ArrayBuffer;
  meta: FrameMeta;
}

// ---------------------------------------------------------------------------
// LiveStreamClient
// ---------------------------------------------------------------------------

export class LiveStreamClient {
  private ws:                 WebSocket | null = null;
  private _state:             LiveStreamState  = 'idle';
  private _reconnects         = 0;
  private _closed             = false;
  private _fatalCode:         string | null    = null;

  // Local frame buffer: holds frames when WS is not OPEN or saturated.
  private _pending:           PendingFrame[]   = [];
  private _pendingBytes       = 0;

  // Sent-but-not-ACKd window: frames sent to ws.send() but no frame_ack yet.
  private _unacked:           Map<number, PendingFrame> = new Map();

  // Server-reported frame index tracking.
  private _serverNextFrameIndex: number | null = null;
  private _lastSentFrameIndex    = -1;  // frameIndex of the last _sendDirect() call

  // Diagnostics
  private _framesSent    = 0;
  private _framesDropped = 0;
  private _lastAckIndex  = -1;

  // Internal flags / waiters
  private _draining         = false;
  private _drainPromise:    Promise<void> | null             = null;
  // Gate that blocks _drainPending() until the server's hello ACK (with
  // next_frame_index) arrives after a reconnect, so already-confirmed frames
  // are skipped. Resolved by onmessage or by HELLO_ACK_TIMEOUT_MS.
  private _helloAckPending  = false;
  private _helloAckWaiters: Array<() => void>                = [];
  private _stateWaiters: Array<(s: LiveStreamState) => void> = [];
  private _ackWaiters:   Array<() => void>                   = [];

  // Callbacks
  onStateChange?:  (state: LiveStreamState) => void;
  onStats?:        (stats: LiveStreamStats) => void;
  onFrameDropped?: (totalDropped: number)   => void;
  onFatal?:        (code: string)           => void;

  constructor(
    private readonly sessionId: string,
    private readonly deviceId:  string,
  ) {}

  get state():         LiveStreamState { return this._state; }
  get droppedFrames(): number          { return this._framesDropped; }
  get fatalCode():     string | null   { return this._fatalCode; }
  get stats():         LiveStreamStats {
    return {
      framesSent:    this._framesSent,
      framesDropped: this._framesDropped,
      framesPending: this._pending.length,
      framesUnacked: this._unacked.size,
      lastAckIndex:  this._lastAckIndex,
    };
  }

  // ── Connect ───────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this._closed               = false;
    this._reconnects           = 0;
    this._fatalCode            = null;
    this._pending              = [];
    this._pendingBytes         = 0;
    this._unacked.clear();
    this._serverNextFrameIndex = null;
    this._helloAckPending      = false;
    this._helloAckWaiters      = [];
    return this._openSocket();
  }

  // ── Send frame ────────────────────────────────────────────────────────────
  // Sends a PCM16 frame. If the WebSocket is not OPEN or the send buffer is
  // saturated, the frame is buffered locally instead of dropped.

  sendFrame(pcm: ArrayBuffer, meta: FrameMeta): void {
    if (
      this.ws?.readyState === WebSocket.OPEN &&
      this.ws.bufferedAmount < MAX_BUFFERED_BYTES &&
      !this._draining
    ) {
      this._sendDirect(pcm, meta);
      return;
    }
    this._bufferFrame(pcm, meta);
  }

  // ── Commit + close ────────────────────────────────────────────────────────
  // Drains the pending buffer, waits for server ACKs (if the server sent any),
  // sends session_commit, then closes the WebSocket.

  async commitAndClose(): Promise<void> {
    // Wait for reconnect to finish if one is in progress
    if (this._state === 'reconnecting') {
      await this._waitForOpen();
    }
    // Wait for the server's hello ACK so _serverNextFrameIndex is set before
    // we drain. No-op unless a reconnect just completed with pending frames.
    await this._waitForHelloAck();

    if (this.ws?.readyState === WebSocket.OPEN) {
      await this._drainPending();
      // Wait for server ACKs only if the server has already sent at least one
      // frame_ack (indicating it supports the protocol). If no ACK was ever
      // received, the server likely doesn't implement it — skip the wait.
      if (this._lastAckIndex >= 0) {
        await this._waitForAcks();
      }
      this._sendCommit();
    } else {
      console.warn(
        `[LiveStreamClient] commitAndClose: WS not open (state=${this._state}, ` +
        `fatal=${this._fatalCode}). ` +
        `Sent: ${this._framesSent}, Dropped: ${this._framesDropped}, ` +
        `Pending: ${this._pending.length}, Unacked: ${this._unacked.size}`
      );
    }

    this.close();
  }

  // ── Close ─────────────────────────────────────────────────────────────────

  close(): void {
    this._closed = true;
    if (this.ws) {
      this.ws.close(1000, 'session_end');
      this.ws = null;
    }
    this._setState('idle');
  }

  // ── Private: send helpers ─────────────────────────────────────────────────

  private _sendDirect(pcm: ArrayBuffer, meta: FrameMeta): void {
    const ws = this.ws!;
    ws.send(JSON.stringify({
      type:               'audio_frame_meta',
      session_id:         this.sessionId,
      device_id:          this.deviceId,
      frame_index:        meta.frameIndex,
      sample_rate:        LIVE_SAMPLE_RATE,
      channels:           1,
      encoding:           'pcm_s16le',
      duration_ms:        FRAME_DURATION_MS,
      capture_started_ms: meta.startMs,
      capture_ended_ms:   meta.endMs,
    }));
    ws.send(pcm);
    this._framesSent++;
    this._lastSentFrameIndex = meta.frameIndex;

    // Track in the unACKd window so we can replay on disconnect
    this._unacked.set(meta.frameIndex, { pcm, meta });
    if (this._unacked.size > MAX_UNACKED_FRAMES) {
      // Evict the oldest entry (lowest frameIndex, first inserted)
      this._unacked.delete(this._unacked.keys().next().value!);
    }

    this.onStats?.(this.stats);
  }

  private _bufferFrame(pcm: ArrayBuffer, meta: FrameMeta): void {
    // Drop oldest frame(s) if buffer is at capacity
    while (
      this._pending.length >= MAX_PENDING_FRAMES ||
      this._pendingBytes + pcm.byteLength > MAX_PENDING_BYTES
    ) {
      const dropped = this._pending.shift();
      if (dropped) {
        this._pendingBytes -= dropped.pcm.byteLength;
        this._framesDropped++;
        this.onFrameDropped?.(this._framesDropped);
      }
    }
    this._pending.push({ pcm, meta });
    this._pendingBytes += pcm.byteLength;
    this.onStats?.(this.stats);
  }

  private _drainPending(): Promise<void> {
    // If a drain is already running, return the same promise so callers
    // (including commitAndClose) properly await its completion.
    if (this._drainPromise !== null) return this._drainPromise;
    if (this._pending.length === 0) return Promise.resolve();

    this._draining     = true;
    this._drainPromise = (async () => {
      try {
        while (this._pending.length > 0) {
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) break;
          if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
            await new Promise(r => setTimeout(r, 50));
            continue;
          }
          const frame = this._pending[0];
          // Skip frames the server already confirmed via next_frame_index.
          // The server deduplicates by frameIndex, but skipping here avoids
          // unnecessary network round-trips for already-confirmed frames.
          if (
            this._serverNextFrameIndex !== null &&
            frame.meta.frameIndex < this._serverNextFrameIndex
          ) {
            this._pending.shift();
            this._pendingBytes -= frame.pcm.byteLength;
            continue;
          }
          this._pending.shift();
          this._pendingBytes -= frame.pcm.byteLength;
          this._sendDirect(frame.pcm, frame.meta);
        }
      } finally {
        this._draining     = false;
        this._drainPromise = null;
      }
    })();
    return this._drainPromise;
  }

  private _sendCommit(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      type:       'session_commit',
      session_id: this.sessionId,
      device_id:  this.deviceId,
    }));
  }

  // ── Private: waiters ──────────────────────────────────────────────────────

  private _waitForHelloAck(): Promise<void> {
    if (!this._helloAckPending) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;

      const handler = () => {
        // Called either by onmessage (ACK arrived) or by the timeout below.
        if (timer !== null) { clearTimeout(timer); timer = null; }
        resolve();
      };
      this._helloAckWaiters.push(handler);

      timer = setTimeout(() => {
        timer = null;
        // Timeout: mark done and unblock ALL active waiters (not just this one),
        // so a concurrent commitAndClose() doesn't wait a second full timeout.
        this._helloAckPending = false;
        console.warn(
          `[LiveStreamClient] hello ACK wait timed out after ${HELLO_ACK_TIMEOUT_MS}ms; ` +
          'draining without server-side dedup info'
        );
        const waiters = this._helloAckWaiters.splice(0);
        waiters.forEach(fn => fn());
      }, HELLO_ACK_TIMEOUT_MS);
    });
  }

  private _waitForOpen(): Promise<void> {
    if (this._state === 'streaming' || this._state === 'failed' || this._closed) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this._stateWaiters = this._stateWaiters.filter(fn => fn !== handler);
        resolve();
      }, MAX_RECONNECTS * RECONNECT_BASE_MS * 2 + CONNECT_TIMEOUT_MS);

      const handler = (s: LiveStreamState) => {
        if (s === 'streaming' || s === 'failed' || this._closed) {
          clearTimeout(timeout);
          this._stateWaiters = this._stateWaiters.filter(fn => fn !== handler);
          resolve();
        }
      };
      this._stateWaiters.push(handler);
    });
  }

  private _waitForAcks(): Promise<void> {
    if (this._unacked.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this._ackWaiters = this._ackWaiters.filter(fn => fn !== handler);
        console.warn(
          `[LiveStreamClient] ACK wait timed out after ${ACK_WAIT_TIMEOUT_MS}ms. ` +
          `Unacked: ${this._unacked.size}. Proceeding with commit.`
        );
        resolve();
      }, ACK_WAIT_TIMEOUT_MS);

      const handler = () => {
        clearTimeout(timeout);
        resolve();
      };
      this._ackWaiters.push(handler);
    });
  }

  // ── Private: state ────────────────────────────────────────────────────────

  private _setState(s: LiveStreamState) {
    this._state = s;
    this.onStateChange?.(s);
    const waiters = this._stateWaiters.splice(0);
    waiters.forEach(fn => fn(s));
  }

  private _wsUrl(): string {
    return `${getWsBase()}/v1/knowledge-sessions/${this.sessionId}/audio-stream?device_id=${encodeURIComponent(this.deviceId)}`;
  }

  private _openSocket(isReconnect = false): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this._setState('connecting');

      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve();
      };

      const ws = new WebSocket(this._wsUrl());
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      const timer = setTimeout(() => {
        ws.close();
        settle(new Error('WebSocket connection timeout'));
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        const hello: Record<string, unknown> = {
          type:         'session_hello',
          session_id:   this.sessionId,
          device_id:    this.deviceId,
          client_type:  'recorder_web',
          app_version:  'dev',
          audio_format: {
            encoding:          'pcm_s16le',
            sample_rate:       LIVE_SAMPLE_RATE,
            channels:          1,
            frame_duration_ms: FRAME_DURATION_MS,
          },
        };
        if (isReconnect) {
          // Signal the server we are resuming.
          // resume_from_frame_index = _lastAckIndex + 1 (first unACKd frame).
          // Using _lastAckIndex avoids announcing an index beyond what the
          // server confirmed — the backend rejects a resume past its expected
          // next frame. _lastAckIndex + 1 is the conservative, safe value:
          //   • -1 → 0 (no ACK received: replay everything)
          //   • 364 → 365 (server confirmed up to 364: replay from 365)
          // The server replies with { type:"ack", next_frame_index } to refine.
          this._serverNextFrameIndex = null; // reset: wait for a fresh ACK
          hello['is_reconnect']            = true;
          hello['resume_from_frame_index'] = this._lastAckIndex + 1;
        }
        ws.send(JSON.stringify(hello));
        this._setState('streaming');
        this._reconnects = 0;
        settle();

        if (isReconnect && this._pending.length > 0) {
          // Block the drain until the server's { type:"ack", next_frame_index }
          // arrives, so we know exactly which frames to skip. Falls back after
          // HELLO_ACK_TIMEOUT_MS so a non-responsive server doesn't stall forever.
          this._helloAckPending = true;
          this._waitForHelloAck().then(() => this._drainPending());
        } else if (this._pending.length > 0) {
          this._drainPending();
        }
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          return;
        }

        // frame_ack: server confirmed receipt of frames up to last_frame_index.
        if (msg['type'] === 'frame_ack' && typeof msg['last_frame_index'] === 'number') {
          const ackIdx = msg['last_frame_index'] as number;
          this._lastAckIndex = ackIdx;
          for (const idx of Array.from(this._unacked.keys())) {
            if (idx <= ackIdx) this._unacked.delete(idx);
          }
          // Notify any commit waiters if all sent frames are now confirmed
          if (this._unacked.size === 0) {
            const waiters = this._ackWaiters.splice(0);
            waiters.forEach(fn => fn());
          }
          this.onStats?.(this.stats);
        }

        // next_frame_index: server tells us what frame it needs next.
        // Sent in the hello ACK ({ type:"ack" }) and optionally in frame_ack.
        if (typeof msg['next_frame_index'] === 'number') {
          this._serverNextFrameIndex = msg['next_frame_index'] as number;
          // Unblock any drain waiting for this index after a reconnect hello.
          if (this._helloAckPending) {
            this._helloAckPending = false;
            const waiters = this._helloAckWaiters.splice(0);
            waiters.forEach(fn => fn());
          }
        }

        // fatal: unrecoverable server error — do not reconnect, trigger recovery.
        if (msg['type'] === 'fatal' && typeof msg['code'] === 'string') {
          this._fatalCode = msg['code'] as string;
          this._setState('failed');
          this.onFatal?.(this._fatalCode);
        }
      };

      ws.onerror = () => {
        if (!settled) settle(new Error('WebSocket connection failed'));
      };

      ws.onclose = (ev) => {
        // Do not reconnect after user-initiated close or server fatal error
        if (this._closed || this._fatalCode) return;

        // Move sent-but-unACKd frames back to the replay buffer.
        // These were delivered to ws.send() but may not have reached the server
        // if the socket dropped before the data was flushed.
        if (this._unacked.size > 0) {
          const toReplay = Array.from(this._unacked.entries())
            .sort(([a], [b]) => a - b)
            .map(([, frame]) => frame);
          this._pending     = [...toReplay, ...this._pending];
          this._pendingBytes += toReplay.reduce((sum, f) => sum + f.pcm.byteLength, 0);
          this._unacked.clear();
        }

        if (this._reconnects < MAX_RECONNECTS) {
          this._reconnects++;
          this._setState('reconnecting');
          const delay = RECONNECT_BASE_MS * this._reconnects;
          setTimeout(() => {
            if (!this._closed && !this._fatalCode) {
              this._openSocket(true).catch(() => this._setState('failed'));
            }
          }, delay);
        } else {
          this._setState('failed');
          console.warn(
            `[LiveStreamClient] permanently failed after ${MAX_RECONNECTS} reconnects ` +
            `(code ${ev.code}). Sent: ${this._framesSent}, ` +
            `Dropped: ${this._framesDropped}, Pending: ${this._pending.length}, ` +
            `Unacked: ${this._unacked.size}`
          );
        }
      };
    });
  }
}
