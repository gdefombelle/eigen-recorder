// audioHealth — did the live audio stream keep flowing while the scanner was in front of the record?
//
// In "Stream" mode the WebView sends one PCM frame about every 320 ms (recorderStore.framesStreamed). A scan that took
// a few seconds and added (almost) no frames means the microphone stopped feeding the stream — in a browser a second
// camera capture can do that. We cannot prove the audio was fine, but we can tell the user when it probably was not.
// Local-only records have no such counter: no verdict.

export interface StreamSnap {
  state:          string;
  syncMode:       string;
  framesStreamed: number;
}

export const FRAME_MS = 320;
export const MIN_SCAN_MS = 4_000;
/** Fewer than this share of the expected frames = suspect. */
export const MIN_FRAME_SHARE = 0.5;

export function streamGapSuspected(before: StreamSnap, after: StreamSnap, durationMs: number): boolean {
  if (before.syncMode !== 'stream' || after.syncMode !== 'stream') return false;
  if (before.state !== 'recording_offline' || after.state !== 'recording_offline') return false;   // paused / stopped: no frames expected
  if (durationMs < MIN_SCAN_MS) return false;
  const expected = Math.floor(durationMs / FRAME_MS);
  const got = after.framesStreamed - before.framesStreamed;
  return got < expected * MIN_FRAME_SHARE;
}
