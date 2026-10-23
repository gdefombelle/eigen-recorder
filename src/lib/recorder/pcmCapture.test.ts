/**
 * PcmCapture.resume() — mic re-acquisition.
 *
 * Gabriel's on-device report, second round: after Resume the vu meter itself
 * stops moving — not just the transcript. That rules out a pure networking/
 * timing bug and points at the capture graph: ctx.resume() can report the
 * AudioContext as 'running' again while the underlying getUserMedia track
 * stays muted/ended (an iOS/WebKit quirk independent of AudioContext state),
 * so the worklet is fed silence with nothing anywhere reporting a failure.
 *
 * resume() now re-acquires a fresh mic track and reconnects it into the
 * still-live graph instead of trusting ctx.state alone. These tests pin that
 * mechanical behavior — mocked AudioContext/AudioWorkletNode/getUserMedia,
 * since none of the real Web Audio API exists in this test environment.
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
  suspend = vi.fn(async () => { this.state = 'suspended'; });
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
  it('re-acquires the microphone and reconnects it into the graph on resume', async () => {
    const capture = new PcmCapture();
    await capture.start();
    expect(mockGetUserMedia).toHaveBeenCalledTimes(1);

    const ctx = ctxInstances[0]!;
    const firstSource = ctx.createMediaStreamSource.mock.results[0]!.value as FakeNode;

    await capture.pause();
    expect(ctx.state).toBe('suspended');

    await capture.resume();

    expect(mockGetUserMedia).toHaveBeenCalledTimes(2); // fresh track pulled on resume
    expect(firstSource.disconnect).toHaveBeenCalled();  // stale source dropped

    const secondSource = ctx.createMediaStreamSource.mock.results[1]!.value as FakeNode;
    expect(secondSource).not.toBe(firstSource);
    expect(secondSource.connect).toHaveBeenCalled();    // new source wired back in
  });

  it('throws instead of silently resuming when the context never actually reports running', async () => {
    const capture = new PcmCapture();
    await capture.start();
    await capture.pause();

    const ctx = ctxInstances[0]!;
    // Simulate iOS silently declining the resume: resume() resolves but the
    // context stays suspended — exactly the case ctx.state alone can't catch.
    ctx.resume = vi.fn(async () => {});

    await expect(capture.resume()).rejects.toThrow(/did not resume/);
  });
});
