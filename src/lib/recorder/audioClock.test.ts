/**
 * The audio clock must give the same answer whether or not any timer has run:
 * an attachment added behind the camera is placed from this clock, and the
 * WebView's setInterval can be frozen for the whole capture. Also covers
 * "pauses excluded" with a pause in the middle (the transcript's referential).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioRecorder } from './audioRecorder';

function startedRecorder() {
  const rec = new AudioRecorder();
  const media = {
    state: 'recording',
    requestData: vi.fn(),
    pause()  { this.state = 'paused'; },
    resume() { this.state = 'recording'; },
  };
  Object.assign(rec, { mediaRecorder: media, sessionStartEpoch: Date.now() });
  return rec;
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_000_000); });   // timers NOT faked: nothing ticks
afterEach(() => vi.useRealTimers());

describe('AudioRecorder.getElapsedMs() — pauses excluded, no timer involved', () => {
  it('10 s recording + 5 s pause + 3 s recording = 13 s', () => {
    const rec = startedRecorder();
    vi.setSystemTime(1_010_000); rec.pause();
    vi.setSystemTime(1_015_000); rec.resume();
    vi.setSystemTime(1_018_000);

    expect(rec.getElapsedMs()).toBe(13_000);
  });

  it('while paused the offset stays at the pause point (where the recording will resume)', () => {
    const rec = startedRecorder();
    vi.setSystemTime(1_010_000); rec.pause();
    vi.setSystemTime(1_090_000);                     // a long time on the camera while paused

    expect(rec.getElapsedMs()).toBe(10_000);
  });

  it('several pauses accumulate: 4 s + (2 s pause) + 4 s + (10 s pause) + 1 s = 9 s', () => {
    const rec = startedRecorder();
    vi.setSystemTime(1_004_000); rec.pause();
    vi.setSystemTime(1_006_000); rec.resume();
    vi.setSystemTime(1_010_000); rec.pause();
    vi.setSystemTime(1_020_000); rec.resume();
    vi.setSystemTime(1_021_000);

    expect(rec.getElapsedMs()).toBe(9_000);
  });
});
