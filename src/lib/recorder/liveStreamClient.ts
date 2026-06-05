// LiveStreamClient — WebSocket transport for real-time PCM16 audio streaming.
//
// Protocol (per frame):
//   1. JSON  → { type: "audio_frame_meta", ... }
//   2. Binary → raw PCM16 little-endian ArrayBuffer
//
// Connection lifecycle:
//   idle → connecting → streaming ↔ reconnecting → failed
//
// Reconnect: up to MAX_RECONNECTS attempts with linear back-off.

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

const MAX_RECONNECTS     = 3;
const RECONNECT_BASE_MS  = 1_500;
const CONNECT_TIMEOUT_MS = 8_000;

// ---------------------------------------------------------------------------
// LiveStreamClient
// ---------------------------------------------------------------------------

export class LiveStreamClient {
  private ws:          WebSocket | null = null;
  private _state:      LiveStreamState  = 'idle';
  private _reconnects  = 0;
  private _closed      = false; // true once user-initiated close

  onStateChange?: (state: LiveStreamState) => void;

  constructor(
    private readonly sessionId: string,
    private readonly deviceId:  string,
  ) {}

  get state(): LiveStreamState { return this._state; }

  // ── Connect ───────────────────────────────────────────────────────────────
  // Opens the WebSocket and sends session_hello.
  // Resolves when the connection is established and streaming starts.
  // Rejects on timeout or immediate connection failure.

  async connect(): Promise<void> {
    this._closed     = false;
    this._reconnects = 0;
    return this._openSocket();
  }

  // ── Send frame ────────────────────────────────────────────────────────────
  // JSON meta message immediately followed by binary PCM16 payload.
  // Silently dropped when not connected — caller should not buffer; frames
  // during reconnect are lost (the backend gets partial audio, not corrupted).

  sendFrame(pcm: ArrayBuffer, meta: FrameMeta): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
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
    this.ws.send(pcm);
  }

  // ── Commit ────────────────────────────────────────────────────────────────
  // Sends session_commit to signal end-of-recording to the backend.
  // Call this before closing so the backend can finalize the session.

  commit(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      type:       'session_commit',
      session_id: this.sessionId,
      device_id:  this.deviceId,
    }));
  }

  // ── Close ─────────────────────────────────────────────────────────────────
  // Graceful user-initiated close. Will not trigger reconnect.

  close(): void {
    this._closed = true;
    if (this.ws) {
      this.ws.close(1000, 'session_end');
      this.ws = null;
    }
    this._setState('idle');
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _setState(s: LiveStreamState) {
    this._state = s;
    this.onStateChange?.(s);
  }

  private _wsUrl(): string {
    return `${getWsBase()}/v1/knowledge-sessions/${this.sessionId}/audio-stream?device_id=${encodeURIComponent(this.deviceId)}`;
  }

  private _openSocket(): Promise<void> {
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
        // Send the hello handshake immediately on open
        ws.send(JSON.stringify({
          type:         'session_hello',
          session_id:   this.sessionId,
          device_id:    this.deviceId,
          client_type:  'recorder_web',
          app_version:  'dev',
          audio_format: {
            encoding:           'pcm_s16le',
            sample_rate:        LIVE_SAMPLE_RATE,
            channels:           1,
            frame_duration_ms:  FRAME_DURATION_MS,
          },
        }));
        this._setState('streaming');
        this._reconnects = 0;
        settle();
      };

      ws.onerror = () => {
        // onerror always fires before onclose; only reject on initial connect
        if (!settled) settle(new Error('WebSocket connection failed'));
      };

      ws.onclose = (ev) => {
        if (this._closed) return;
        // Unexpected close — attempt reconnect
        if (this._reconnects < MAX_RECONNECTS) {
          this._reconnects++;
          this._setState('reconnecting');
          const delay = RECONNECT_BASE_MS * this._reconnects;
          setTimeout(() => {
            if (!this._closed) {
              this._openSocket().catch(() => this._setState('failed'));
            }
          }, delay);
        } else {
          this._setState('failed');
          // Already settled (resolve was called earlier); this just updates state
          console.warn(`[LiveStreamClient] WebSocket permanently failed after ${MAX_RECONNECTS} reconnects (code ${ev.code})`);
        }
      };
    });
  }
}
