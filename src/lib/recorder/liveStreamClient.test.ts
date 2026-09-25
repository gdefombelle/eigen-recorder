/**
 * Unit tests for LiveStreamClient reliability guarantees.
 *
 * Verifies:
 *  - Frames are buffered (not dropped) when the WebSocket is not open.
 *  - Buffered frames are replayed after a reconnect.
 *  - The frame buffer is bounded: oldest frames drop first on overflow.
 *  - commitAndClose() drains the buffer before sending session_commit.
 *  - commitAndClose() waits for an in-progress reconnect before committing.
 *  - commitAndClose() handles permanent failure gracefully (no throw).
 *  - Reconnect session_hello includes is_reconnect + resume_from_frame_index.
 *  - Server frame_ack updates lastAckIndex.
 *  - onStats fires with accurate framesSent counts.
 *  - onFrameDropped fires when the buffer overflows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LiveStreamClient } from './liveStreamClient';

// ── Mock pcmCapture constants ──────────────────────────────────────────────
vi.mock('./pcmCapture', () => ({
  FRAME_DURATION_MS: 320,
  LIVE_SAMPLE_RATE:  16_000,
}));

// ── MockWebSocket ──────────────────────────────────────────────────────────

class MockWebSocket {
  static OPEN       = 1;
  static CONNECTING = 0;
  static CLOSING    = 2;
  static CLOSED     = 3;

  readyState    = MockWebSocket.CONNECTING;
  binaryType    = '';
  bufferedAmount = 0;
  sent: Array<string | ArrayBuffer> = [];

  onopen?:    () => void;
  onclose?:   (ev: { code: number }) => void;
  onerror?:   (ev: unknown) => void;
  onmessage?: (ev: { data: string | ArrayBuffer }) => void;

  send(data: string | ArrayBuffer) { this.sent.push(data); }
  close(code = 1000)               { this.readyState = MockWebSocket.CLOSED; this.onclose?.({ code }); }

  // Test helpers
  open()               { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
  drop(code = 1006)    { this.readyState = MockWebSocket.CLOSED; this.onclose?.({ code }); }
  serverAck(idx: number) {
    this.onmessage?.({ data: JSON.stringify({ type: 'frame_ack', last_frame_index: idx }) });
  }

  sentJson(): string[] { return this.sent.filter((m): m is string => typeof m === 'string'); }
}

let lastWs: MockWebSocket;

function WsFactory(_url: string): MockWebSocket {
  lastWs = new MockWebSocket();
  return lastWs;
}
// Attach static constants so WebSocket.OPEN etc. work inside the client
Object.assign(WsFactory, {
  OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3,
  prototype: MockWebSocket.prototype,
});

beforeEach(() => {
  // getWsBase() uses window.location; stub it so tests don't need a DOM env.
  vi.stubGlobal('window', { location: { protocol: 'http:', host: 'localhost' } });
  vi.stubGlobal('WebSocket', WsFactory);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── helpers ────────────────────────────────────────────────────────────────

function makePcm(byteLength = 10_240): ArrayBuffer { return new ArrayBuffer(byteLength); }

function makeClient() { return new LiveStreamClient('sess-abc', 'dev-xyz'); }

async function openClient() {
  const client = makeClient();
  const p = client.connect();
  lastWs.open();
  await p;
  return { client, ws: lastWs };
}

// Flush all pending microtasks
const tick = () => new Promise(r => setTimeout(r, 0));

// ── Tests ──────────────────────────────────────────────────────────────────

describe('LiveStreamClient', () => {

  it('sends frame directly when connected', async () => {
    const { client, ws } = await openClient();
    client.sendFrame(makePcm(), { frameIndex: 0, startMs: 0, endMs: 320 });

    // ws.sent = [hello JSON, frame meta JSON, frame binary]
    expect(ws.sent).toHaveLength(3);
    expect(ws.sentJson().some(m => m.includes('audio_frame_meta'))).toBe(true);
    expect(client.stats.framesSent).toBe(1);
    expect(client.stats.framesDropped).toBe(0);
    expect(client.stats.framesPending).toBe(0);
  });

  it('buffers frames when WebSocket is not yet open', async () => {
    const client = makeClient();
    const p = client.connect(); // WS in CONNECTING state
    // lastWs exists but readyState = CONNECTING

    client.sendFrame(makePcm(), { frameIndex: 0, startMs: 0, endMs: 320 });
    client.sendFrame(makePcm(), { frameIndex: 1, startMs: 320, endMs: 640 });

    expect(client.stats.framesPending).toBe(2);
    expect(client.stats.framesSent).toBe(0);

    lastWs.open();
    await p;
    await tick(); // let _drainPending() microtask run

    // After connect and drain, both frames should be sent
    expect(client.stats.framesPending).toBe(0);
    expect(client.stats.framesSent).toBe(2);

    client.close();
  });

  it('buffers frames during reconnect and replays after reconnect', async () => {
    vi.useFakeTimers();
    const { client, ws: ws1 } = await openClient();

    // 1 frame sent before disconnect
    client.sendFrame(makePcm(), { frameIndex: 0, startMs: 0, endMs: 320 });
    expect(client.stats.framesSent).toBe(1);

    // Drop the connection
    ws1.drop(1006);
    expect(client.state).toBe('reconnecting');

    // 3 frames buffered during reconnect
    for (let i = 1; i <= 3; i++) {
      client.sendFrame(makePcm(), { frameIndex: i, startMs: i * 320, endMs: (i + 1) * 320 });
    }
    // pending = 1 (unACKd frame 0 moved from _unacked) + 3 (buffered) = 4
    expect(client.stats.framesPending).toBe(4);
    expect(client.stats.framesSent).toBe(1); // unchanged — buffered, not sent

    // Advance timer to fire the reconnect setTimeout (1 × 1500 ms)
    vi.advanceTimersByTime(1_600);

    // New WS was created; open it
    const ws2 = lastWs;
    expect(ws2).not.toBe(ws1);
    ws2.open();

    await vi.runAllTimersAsync();
    vi.useRealTimers();

    expect(client.state).toBe('streaming');
    expect(client.stats.framesPending).toBe(0);
    // 1 direct + 1 unacked-replayed + 3 buffered-replayed = 5
    // (the pre-disconnect frame was in _unacked and moves to _pending on drop)
    expect(client.stats.framesSent).toBe(5);

    // session_hello on ws2 should carry is_reconnect flag
    const hello = ws2.sentJson().find(m => m.includes('session_hello'));
    expect(hello).toBeDefined();
    const parsed = JSON.parse(hello!);
    expect(parsed.is_reconnect).toBe(true);
    // resume_from_frame_index = _lastAckIndex + 1 = -1 + 1 = 0 (no ACK received yet)
    expect(parsed.resume_from_frame_index).toBe(0);

    client.close();
  });

  it('drops oldest frames when buffer overflows', async () => {
    const { client, ws } = await openClient();
    ws.drop(1006); // disconnect

    const dropped: number[] = [];
    client.onFrameDropped = (n) => dropped.push(n);

    // Use tiny PCM buffers (100 bytes) so the byte cap (3 MB) doesn't interfere
    // and only the frame count cap (300) is binding.
    const tinyPcm = makePcm(100);
    for (let i = 0; i < 305; i++) {
      client.sendFrame(tinyPcm, { frameIndex: i, startMs: i * 320, endMs: (i + 1) * 320 });
    }

    expect(client.stats.framesPending).toBe(300);
    expect(client.stats.framesDropped).toBe(5);
    expect(dropped).toHaveLength(5);
    expect(dropped[dropped.length - 1]).toBe(5);
  });

  it('commitAndClose drains buffer before sending session_commit', async () => {
    vi.useFakeTimers();
    const { client, ws: ws1 } = await openClient();

    // Buffer 2 frames during disconnect (no frames sent before, so no unacked)
    ws1.drop(1006);
    client.sendFrame(makePcm(), { frameIndex: 1, startMs: 320, endMs: 640 });
    client.sendFrame(makePcm(), { frameIndex: 2, startMs: 640, endMs: 960 });

    // Reconnect
    vi.advanceTimersByTime(1_600);
    const ws2 = lastWs;
    ws2.open();
    await vi.runAllTimersAsync();

    // Commit — drains first, no ACK wait (lastAckIndex = -1)
    await client.commitAndClose();
    vi.useRealTimers();

    const msgs = ws2.sentJson();
    const metaIdxs = msgs.reduce<number[]>((acc, m, i) => {
      if (m.includes('audio_frame_meta')) acc.push(i);
      return acc;
    }, []);
    const commitIdx = msgs.findIndex(m => m.includes('session_commit'));

    // commit must come after all frame meta messages
    expect(metaIdxs).toHaveLength(2);
    expect(commitIdx).toBeGreaterThan(metaIdxs[metaIdxs.length - 1]);
  });

  it('commitAndClose waits for an in-progress reconnect before committing', async () => {
    vi.useFakeTimers();
    const { client, ws: ws1 } = await openClient();
    ws1.drop(1006);

    // Start commitAndClose while still reconnecting
    const done = client.commitAndClose();

    // Before reconnect fires, nothing committed yet
    expect(ws1.sentJson().some(m => m.includes('session_commit'))).toBe(false);

    // Fire the reconnect
    vi.advanceTimersByTime(1_600);
    const ws2 = lastWs;
    ws2.open();
    await vi.runAllTimersAsync();

    await done;
    vi.useRealTimers();

    // commit landed on the new socket
    expect(ws2.sentJson().some(m => m.includes('session_commit'))).toBe(true);
  });

  it('commitAndClose handles permanent failure without throwing', async () => {
    vi.useFakeTimers();
    const { client, ws: ws1 } = await openClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Exhaust all 3 reconnects
    ws1.drop(1006);
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(RECONNECT_BASE_MS * (i + 2)); // generous advance
      lastWs.drop(1006);
    }
    vi.advanceTimersByTime(20_000); // exhaust all timers
    await vi.runAllTimersAsync();
    vi.useRealTimers();

    await expect(client.commitAndClose()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('tracks server frame_ack and updates lastAckIndex', async () => {
    const { client, ws } = await openClient();

    expect(client.stats.lastAckIndex).toBe(-1);
    ws.serverAck(41);
    expect(client.stats.lastAckIndex).toBe(41);
    ws.serverAck(99);
    expect(client.stats.lastAckIndex).toBe(99);

    client.close();
  });

  it('calls onStats on each frame sent', async () => {
    const { client } = await openClient();
    const counts: number[] = [];
    client.onStats = (s) => counts.push(s.framesSent);

    client.sendFrame(makePcm(), { frameIndex: 0, startMs: 0, endMs: 320 });
    client.sendFrame(makePcm(), { frameIndex: 1, startMs: 320, endMs: 640 });

    expect(counts).toEqual([1, 2]);
    client.close();
  });

  it('does not send frames after close', async () => {
    const { client, ws } = await openClient();
    client.close();
    const sentBefore = ws.sent.length;

    // These should buffer but client is closed so WS is gone
    client.sendFrame(makePcm(), { frameIndex: 0, startMs: 0, endMs: 320 });
    // Doesn't reach the closed WS
    expect(ws.sent.length).toBe(sentBefore);
  });
});

// ── Back-pressure test (bufferedAmount) ───────────────────────────────────────

describe('LiveStreamClient back-pressure', () => {
  it('buffers frames when ws.bufferedAmount is high', async () => {
    const { client, ws } = await openClient();

    // Simulate a saturated socket
    ws.bufferedAmount = 600_000; // > MAX_BUFFERED_BYTES (512_000)

    client.sendFrame(makePcm(), { frameIndex: 0, startMs: 0, endMs: 320 });

    // Frame should be buffered, not sent
    expect(client.stats.framesPending).toBe(1);
    expect(client.stats.framesSent).toBe(0);

    // Unsaturate and drain (no frame_ack ever received → no ACK wait)
    ws.bufferedAmount = 0;
    await client.commitAndClose();

    expect(client.stats.framesPending).toBe(0);
    expect(client.stats.framesSent).toBe(1);
  });
});

// Export for vitest
const RECONNECT_BASE_MS = 1_500; // mirrors the constant in liveStreamClient.ts

// ── Unacked buffer recovery ────────────────────────────────────────────────────

describe('LiveStreamClient unacked-buffer recovery', () => {
  it('moves sent-but-unACKd frames back to pending on WS drop', async () => {
    const { client, ws } = await openClient();

    // Send 3 frames (all in the unacked window)
    for (let i = 0; i < 3; i++) {
      client.sendFrame(makePcm(), { frameIndex: i, startMs: i * 320, endMs: (i + 1) * 320 });
    }
    expect(client.stats.framesUnacked).toBe(3);
    expect(client.stats.framesPending).toBe(0);

    // Drop WS — unacked frames should migrate to pending
    ws.drop(1006);

    expect(client.stats.framesUnacked).toBe(0);
    expect(client.stats.framesPending).toBe(3);
    expect(client.state).toBe('reconnecting');
  });

  it('replays unACKd frames after reconnect', async () => {
    vi.useFakeTimers();
    const { client, ws: ws1 } = await openClient();

    // Send 2 frames
    client.sendFrame(makePcm(), { frameIndex: 0, startMs: 0, endMs: 320 });
    client.sendFrame(makePcm(), { frameIndex: 1, startMs: 320, endMs: 640 });

    // Drop — frames move to pending
    ws1.drop(1006);

    // Reconnect
    vi.advanceTimersByTime(1_600);
    const ws2 = lastWs;
    ws2.open();
    await vi.runAllTimersAsync();
    vi.useRealTimers();

    // Both frames should be replayed on ws2
    const metaMsgs = ws2.sentJson().filter(m => m.includes('audio_frame_meta'));
    expect(metaMsgs).toHaveLength(2);
    expect(client.stats.framesSent).toBe(4); // 2 original + 2 replayed
    expect(client.stats.framesPending).toBe(0);

    client.close();
  });

  it('skips frames already confirmed by next_frame_index on reconnect', async () => {
    vi.useFakeTimers();
    const { client, ws: ws1 } = await openClient();

    // Send frames 0, 1, 2
    for (let i = 0; i < 3; i++) {
      client.sendFrame(makePcm(), { frameIndex: i, startMs: i * 320, endMs: (i + 1) * 320 });
    }
    ws1.drop(1006); // all 3 move to pending

    // Reconnect
    vi.advanceTimersByTime(1_600);
    const ws2 = lastWs;
    ws2.open();

    // Server responds with type:"ack" and next_frame_index: 2 (it already has 0 and 1)
    ws2.onmessage?.({ data: JSON.stringify({ type: 'ack', next_frame_index: 2 }) });

    await vi.runAllTimersAsync();
    vi.useRealTimers();

    // Only frame 2 should be replayed (frames 0 and 1 skipped)
    const metaMsgs = ws2.sentJson().filter(m => m.includes('audio_frame_meta'));
    expect(metaMsgs).toHaveLength(1);
    const replayed = JSON.parse(metaMsgs[0]);
    expect(replayed.frame_index).toBe(2);

    client.close();
  });

  it('clears unacked on frame_ack and resolves ack waiters', async () => {
    const { client, ws } = await openClient();

    client.sendFrame(makePcm(), { frameIndex: 0, startMs: 0, endMs: 320 });
    client.sendFrame(makePcm(), { frameIndex: 1, startMs: 320, endMs: 640 });
    expect(client.stats.framesUnacked).toBe(2);

    ws.serverAck(1); // ACKs both frames
    expect(client.stats.framesUnacked).toBe(0);
    expect(client.stats.lastAckIndex).toBe(1);

    client.close();
  });

  it('resume_from_frame_index uses _lastAckIndex + 1, not _lastSentFrameIndex + 1', async () => {
    vi.useFakeTimers();
    const { client, ws: ws1 } = await openClient();

    // Send frames 0..4, server ACKs up to frame 2
    for (let i = 0; i < 5; i++) {
      client.sendFrame(makePcm(), { frameIndex: i, startMs: i * 320, endMs: (i + 1) * 320 });
    }
    ws1.serverAck(2);
    // _lastAckIndex=2, _lastSentFrameIndex=4, frames 3 and 4 are unACKd

    ws1.drop(1006);
    expect(client.stats.lastAckIndex).toBe(2);

    vi.advanceTimersByTime(1_600);
    const ws2 = lastWs;
    ws2.open();
    await vi.runAllTimersAsync();
    vi.useRealTimers();

    const hello = ws2.sentJson().find(m => m.includes('session_hello'));
    const parsed = JSON.parse(hello!);
    // Must be _lastAckIndex(2) + 1 = 3, NOT _lastSentFrameIndex(4) + 1 = 5
    expect(parsed.resume_from_frame_index).toBe(3);

    client.close();
  });

  it('defers drain until server type:"ack" with next_frame_index is received', async () => {
    vi.useFakeTimers();
    const { client, ws: ws1 } = await openClient();

    // 2 frames sent → go to _unacked
    client.sendFrame(makePcm(), { frameIndex: 0, startMs: 0, endMs: 320 });
    client.sendFrame(makePcm(), { frameIndex: 1, startMs: 320, endMs: 640 });

    ws1.drop(1006); // unacked → pending
    expect(client.stats.framesPending).toBe(2);

    vi.advanceTimersByTime(1_600); // trigger reconnect
    const ws2 = lastWs;
    ws2.open(); // WS open, session_hello sent, hello ACK wait started

    // Flush any pending microtasks — drain must NOT start yet (ACK not received)
    await Promise.resolve();
    await Promise.resolve();

    expect(ws2.sentJson().filter(m => m.includes('audio_frame_meta'))).toHaveLength(0);

    // Server sends { type: 'ack', next_frame_index: 0 } — unblocks the drain gate
    ws2.onmessage?.({ data: JSON.stringify({ type: 'ack', next_frame_index: 0 }) });

    // Flush microtasks so the drain .then() callback and drain loop run
    await Promise.resolve();
    await Promise.resolve();

    vi.useRealTimers();

    expect(ws2.sentJson().filter(m => m.includes('audio_frame_meta'))).toHaveLength(2);
    client.close();
  });
});

// ── Fatal error handling ───────────────────────────────────────────────────────

describe('LiveStreamClient fatal error handling', () => {
  it('fires onFatal and sets state=failed on realtime_resume_unavailable', async () => {
    const { client, ws } = await openClient();

    const fatalCodes: string[] = [];
    client.onFatal = (code) => fatalCodes.push(code);

    ws.onmessage?.({ data: JSON.stringify({ type: 'fatal', code: 'realtime_resume_unavailable' }) });

    expect(fatalCodes).toEqual(['realtime_resume_unavailable']);
    expect(client.state).toBe('failed');
    expect(client.fatalCode).toBe('realtime_resume_unavailable');
  });

  it('does not reconnect after fatal error', async () => {
    const { client, ws } = await openClient();
    client.onFatal = () => {};
    const wsSpy = vi.fn();
    vi.stubGlobal('WebSocket', wsSpy);

    ws.onmessage?.({ data: JSON.stringify({ type: 'fatal', code: 'realtime_resume_unavailable' }) });
    ws.drop(1006); // WS closes after fatal

    // Should NOT attempt to create a new WebSocket
    expect(wsSpy).not.toHaveBeenCalled();
    expect(client.state).toBe('failed');

    vi.unstubAllGlobals();
    vi.stubGlobal('WebSocket', WsFactory); // restore for afterEach
  });

  it('commitAndClose resolves immediately after fatal (no hang)', async () => {
    const { client, ws } = await openClient();
    client.onFatal = () => {};

    ws.onmessage?.({ data: JSON.stringify({ type: 'fatal', code: 'realtime_resume_unavailable' }) });
    ws.drop(1006);

    // Should resolve without hanging
    await expect(client.commitAndClose()).resolves.toBeUndefined();
  });
});

// ── Wait-for-ACK before commit ────────────────────────────────────────────────

describe('LiveStreamClient wait-for-ack before commit', () => {
  it('waits for unacked frames to be ACKd before sending session_commit', async () => {
    const { client, ws } = await openClient();

    // Frame 0 sent and immediately ACKd → establishes that server supports ACKs
    // (sets lastAckIndex = 0, which triggers the ACK-wait logic in commitAndClose)
    client.sendFrame(makePcm(), { frameIndex: 0, startMs: 0, endMs: 320 });
    ws.serverAck(0);
    expect(client.stats.lastAckIndex).toBe(0);

    // Frame 1 sent but NOT yet ACKd
    client.sendFrame(makePcm(), { frameIndex: 1, startMs: 320, endMs: 640 });
    expect(client.stats.framesUnacked).toBe(1); // frame 1 unACKd

    // Start commitAndClose in background — should wait for ACK of frame 1
    let committed = false;
    const done = client.commitAndClose().then(() => { committed = true; });

    // Confirm: commit NOT sent yet (waiting for ACK of frame 1)
    await tick();
    expect(committed).toBe(false);

    // Server ACKs frame 1 — should unblock commitAndClose
    ws.serverAck(1);
    await done;

    expect(ws.sentJson().some(m => m.includes('session_commit'))).toBe(true);
    expect(committed).toBe(true);
  });

  it('skips ACK wait when server never sent any ACK (server does not support protocol)', async () => {
    const { client, ws } = await openClient();

    // Send frame but no ACK ever received (lastAckIndex stays -1)
    client.sendFrame(makePcm(), { frameIndex: 0, startMs: 0, endMs: 320 });
    expect(client.stats.lastAckIndex).toBe(-1);
    expect(client.stats.framesUnacked).toBe(1);

    // commitAndClose should NOT wait for ACK — resolves quickly
    await client.commitAndClose();

    expect(ws.sentJson().some(m => m.includes('session_commit'))).toBe(true);
  });
});
