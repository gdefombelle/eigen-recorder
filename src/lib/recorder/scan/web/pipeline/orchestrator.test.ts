import { describe, it, expect } from 'vitest';
import '../testing/imageDataPolyfill.js';
import { runPipeline } from './orchestrator.js';
import { createDefaultPipeline } from './factory.js';
import type { PipelineSettings, RawFrame } from '../types.js';

function makeFrame(w = 32, h = 32): RawFrame {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 100;
    data[i + 1] = 150;
    data[i + 2] = 200;
    data[i + 3] = 255;
  }
  return {
    kind: 'raw',
    image: new ImageData(data, w, h),
    capturedAt: 0
  };
}

const settings: PipelineSettings = {
  enhancement: 'document-bw',
  dewarpStrategy: 'naive',
  outputDpi: 200,
  preserveRaw: false
};

describe('pipeline orchestrator', () => {
  it('runs all stages end to end', async () => {
    const pipeline = createDefaultPipeline();
    const result = await runPipeline(pipeline, makeFrame(), settings);
    expect(result.page.kind).toBe('enhanced');
    expect(result.record.stages.length).toBe(4);
    expect(result.record.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('emits progress events for each stage', async () => {
    const pipeline = createDefaultPipeline();
    const events: string[] = [];
    await runPipeline(pipeline, makeFrame(), settings, undefined, (e) => events.push(e.stage));
    // Each stage emits at least 'start' (progress 0) and 'end' (progress 1)
    expect(events.length).toBeGreaterThanOrEqual(8);
  });

  it('respects abort signal', async () => {
    const pipeline = createDefaultPipeline();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      runPipeline(pipeline, makeFrame(), settings, ctrl.signal)
    ).rejects.toThrow();
  });
});
