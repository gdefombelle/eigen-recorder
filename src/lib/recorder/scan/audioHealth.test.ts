import { describe, it, expect } from 'vitest';
import { streamGapSuspected, type StreamSnap } from './audioHealth';

const snap = (over: Partial<StreamSnap> = {}): StreamSnap => ({ state: 'recording_offline', syncMode: 'stream', framesStreamed: 100, ...over });

describe('streamGapSuspected', () => {
  it('flags a long scan during which (almost) no frame was streamed', () => {
    expect(streamGapSuspected(snap(), snap({ framesStreamed: 100 }), 12_000)).toBe(true);
    expect(streamGapSuspected(snap(), snap({ framesStreamed: 110 }), 12_000)).toBe(true);     // 10 of ~37 expected
  });
  it('is quiet when the frames kept coming at about the normal rate (iPhone spike: 41 for ~40, 36 for ~37)', () => {
    expect(streamGapSuspected(snap({ framesStreamed: 44 }), snap({ framesStreamed: 85 }), 12_751)).toBe(false);
    expect(streamGapSuspected(snap({ framesStreamed: 163 }), snap({ framesStreamed: 199 }), 11_707)).toBe(false);
  });
  it('threshold: half of the expected frames is still fine, just under is not', () => {
    const expected = Math.floor(10_000 / 320);                                                   // 31
    expect(streamGapSuspected(snap(), snap({ framesStreamed: 100 + Math.ceil(expected * 0.5) }), 10_000)).toBe(false);
    expect(streamGapSuspected(snap(), snap({ framesStreamed: 100 + Math.ceil(expected * 0.5) - 1 }), 10_000)).toBe(true);
  });
  it('exactly half of the expected frames is NOT suspect (boundary)', () => {
    expect(streamGapSuspected(snap(), snap({ framesStreamed: 116 }), 10_240)).toBe(false);   // 16 of 32
    expect(streamGapSuspected(snap(), snap({ framesStreamed: 115 }), 10_240)).toBe(true);    // 15 of 32
  });
  it('short scans give no verdict', () => {
    expect(streamGapSuspected(snap(), snap(), 3_999)).toBe(false);
    expect(streamGapSuspected(snap(), snap(), 4_000)).toBe(true);
  });
  it('no verdict outside Stream mode or when the record was paused / stopped (no frames are expected then)', () => {
    expect(streamGapSuspected(snap({ syncMode: 'local' }), snap({ syncMode: 'local' }), 20_000)).toBe(false);
    expect(streamGapSuspected(snap({ state: 'paused' }), snap({ state: 'paused' }), 20_000)).toBe(false);
    expect(streamGapSuspected(snap(), snap({ state: 'stopping' }), 20_000)).toBe(false);
  });
});
