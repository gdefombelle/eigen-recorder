/**
 * PcmCapture.pause()/resume() — full pipeline rebuild on resume.
 *
 * Gabriel's on-device reports, in order:
 *   1. ctx.resume() not awaited/checked → fixed, no effect.
 *   2. ctx.state checked but re-acquiring just the mic track into the same
 *      (resumed) context → fixed, no effect: the vu meter still went flat
 *      and stayed flat after Resume.
 * That second result means the AudioContext itself can go "zombie" on iOS —
 * ctx.resume() resolves, ctx.state reads 'running', but the context never
 * reconnects to real hardware input again, with no signal anywhere in the
 * Web Audio API to detect it.
 *
 * So pause() now tears down the entire pipeline (closes the AudioContext,
 * stops the mic track) and resume() rebuilds it completely from scratch —
 * new AudioContext, new getUserMedia track, new worklet — exactly the code
 * path start() uses, which we know works (an uninterrupted recording
 * transcribes correctly). These tests pin that mechanical behavior against
 * a mocked AudioContext/AudioWorkletNode/getUserMedia, since none of the
 * real Web Audio API exists in this test environment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PcmCapture } from './pcmCapture';

class FakeNode {
  connect    = vi.fn();
  disconnect = vi.fn();
  gain       = { value: 0 };
}

class FakeAudioContext {
  state: 'running' | 'suspended' | 'closed' = 'running';
  sampleRate  = 16_000;
  destination = {};
  audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
  resume = vi.fn(async () => { this.state = 'running'; });
  close  = vi.fn(async () => { this.state = 'closed'; });
  createMediaStreamSource      = vi.fn(() => new FakeNode());
  createGain                   = vi.fn(() => new FakeNode());
  createMediaStreamDestination = vi.fn(() => ({ stream: {} }));
}

let ctxInstances: FakeAudioContext[] = [];
const mockGetUserMedia = vi.fn();

function makeStream() {
  const track = { stop: vi.fn() };
  return { getTracks: vi.fn(() => [track]), getAudioTracks: vi.fn(() => [track]) };
}

beforeEach(() => {
  vi.clearAllMocks();
  ctxInstances = [];
  mockGetUserMedia.mockReset().mockImplementation(async () => makeStream());

  vi.stubGlobal('navigator', {
    userAgent: 'vitest', platform: 'test', maxTouchPoints: 0,
    mediaDevices: { getUserMedia: mockGetUserMedia },
  });
  vi.stubGlobal('AudioContext', vi.fn().mockImplementation(() => {
    const ctx = new FakeAudioContext();
    ctxInstances.push(ctx);
    return ctx;
  }));
  vi.stubGlobal('AudioWorkletNode', vi.fn().mockImplementation(() => ({
    port: { onmessage: null, onmessageerror: null, close: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  })));
  vi.stubGlobal('Blob', vi.fn().mockImplementation(() => ({})));
  vi.stubGlobal('URL', { createObjectURL: vi.fn().mockReturnValue('blob:fake'), revokeObjectURL: vi.fn() });
});

describe('PcmCapture pause()/resume()', () => {
  it('closes the context on pause and builds a brand new one on resume', async () => {
    const capture = new PcmCapture();
    await capture.start();
    expect(mockGetUserMedia).toHaveBeenCalledTimes(1);

    const firstCtx    = ctxInstances[0]!;
    const firstStream = await mockGetUserMedia.mock.results[0]!.value;
    const firstTrack  = firstStream.getTracks()[0];

    await capture.pause();
    expect(firstCtx.close).toHaveBeenCalled();
    expect(firstTrack.stop).toHaveBeenCalled();

    await capture.resume();

    expect(mockGetUserMedia).toHaveBeenCalledTimes(2); // fresh track pulled on resume
    expect(ctxInstances).toHaveLength(2);
    expect(ctxInstances[1]).not.toBe(firstCtx);        // genuinely new AudioContext, not the old one revived
  });

  it('exposes a usable amplifiedStream after resume for the caller to rebind its backup recorder', async () => {
    const capture = new PcmCapture();
    await capture.start();
    const streamBeforePause = capture.amplifiedStream;

    await capture.pause();
    await capture.resume();

    const streamAfterResume = capture.amplifiedStream;
    expect(streamAfterResume).not.toBeNull();
    expect(streamAfterResume).not.toBe(streamBeforePause); // old one belonged to the closed context
  });

  it('rejects instead of silently succeeding when the rebuilt pipeline fails to acquire a mic', async () => {
    const capture = new PcmCapture();
    await capture.start();
    await capture.pause();

    mockGetUserMedia.mockRejectedValueOnce(new Error('NotAllowedError'));

    await expect(capture.resume()).rejects.toThrow(/NotAllowedError/);
  });
});
