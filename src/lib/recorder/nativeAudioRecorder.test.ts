/**
 * Regression test for the silent pause/resume failure Gabriel hit on a flight:
 * tapped Resume after Pause, the UI kept showing an active recording, but the
 * transcript came back empty and the session was stuck in recording_offline
 * with no duration_ms — i.e. finalization never ran because stopRecording()
 * never actually got called on real audio.
 *
 * Root cause, confirmed in EigenAudioPlugin.swift:
 *  - resumeRecording() called `recorder?.record()` (AVAudioRecorder.record()
 *    returns Bool) WITHOUT checking the result, and always `call.resolve()`.
 *  - It never reactivated the AVAudioSession before resuming, so a resume
 *    after iOS tore the session down during the pause (interruption, or the
 *    OS reclaiming it in the background) was guaranteed to fail — silently.
 *  - NativeAudioRecorder.resume() then made it worse: `.catch(() => {})`
 *    swallowed whatever did come back, so the JS layer had no way to know
 *    even if the plugin DID start rejecting.
 *
 * The fix makes resumeRecording() reject on either failure (see
 * EigenAudioPlugin.swift, Swift-side — not reproducible from Vitest) and
 * makes the JS wrapper propagate instead of swallow. This test pins the JS
 * half: the one Vitest can actually exercise.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockResumeRecording = vi.fn();
const mockPauseRecording  = vi.fn();
const mockStartRecording  = vi.fn().mockResolvedValue(undefined);
const mockAddListener     = vi.fn().mockResolvedValue({ remove: vi.fn() });

vi.mock('$lib/plugins/eigenAudio', () => ({
  EigenAudio: {
    requestPermission: vi.fn(),
    startRecording:    (...args: unknown[]) => mockStartRecording(...args),
    pauseRecording:    (...args: unknown[]) => mockPauseRecording(...args),
    resumeRecording:   (...args: unknown[]) => mockResumeRecording(...args),
    stopRecording:     vi.fn(),
    getElapsedMs:      vi.fn(),
    getMicLevel:       vi.fn(),
    mergeChunks:       vi.fn(),
    addListener:       (...args: unknown[]) => mockAddListener(...args),
  },
}));

import { NativeAudioRecorder } from './nativeAudioRecorder';

beforeEach(() => {
  mockResumeRecording.mockReset();
  mockPauseRecording.mockReset();
  mockStartRecording.mockReset().mockResolvedValue(undefined);
  mockAddListener.mockReset().mockResolvedValue({ remove: vi.fn() });
});

describe('NativeAudioRecorder.start() — Voice Processing I/O plumbing', () => {
  it('passes voiceProcessing through and forces mono (stereo: false) when enabled', async () => {
    const recorder = new NativeAudioRecorder();

    await recorder.start('session-1', 5000, true);

    expect(mockStartRecording).toHaveBeenCalledWith(expect.objectContaining({
      voiceProcessing: true,
      stereo:          false,
    }));
  });

  it('defaults to stereo capture with voiceProcessing off', async () => {
    const recorder = new NativeAudioRecorder();

    await recorder.start('session-1', 5000);

    expect(mockStartRecording).toHaveBeenCalledWith(expect.objectContaining({
      voiceProcessing: false,
      stereo:          true,
    }));
  });
});

describe('NativeAudioRecorder.resume() — propagates native failure', () => {
  it('rejects when the plugin rejects (declined resume / dead audio session)', async () => {
    mockResumeRecording.mockRejectedValue(
      Object.assign(new Error('The system declined to resume recording.'), { code: 'RECORD_FAILED' }),
    );
    const recorder = new NativeAudioRecorder();

    await expect(recorder.resume()).rejects.toThrow('The system declined to resume recording.');
  });

  it('resolves when the plugin actually resumed', async () => {
    mockResumeRecording.mockResolvedValue(undefined);
    const recorder = new NativeAudioRecorder();

    await expect(recorder.resume()).resolves.toBeUndefined();
  });
});

describe('NativeAudioRecorder.pause() — propagates native failure too', () => {
  it('rejects when the plugin rejects', async () => {
    mockPauseRecording.mockRejectedValue(new Error('No active recorder.'));
    const recorder = new NativeAudioRecorder();

    await expect(recorder.pause()).rejects.toThrow('No active recorder.');
  });
});
