/**
 * Pipeline orchestrator. Composes typed Stages into a single end-to-end
 * processing function. Records timing for each stage to populate PipelineRecord.
 *
 * Designed to run inside a Web Worker. The orchestrator itself is platform
 * agnostic; it just calls Stage.process() in sequence.
 */

import type {
  DetectedFrame,
  DewarpedPage,
  EnhancedPage,
  PipelineContext,
  PipelineRecord,
  PipelineSettings,
  RawFrame,
  RectifiedPage,
  Stage
} from '../types.js';

export interface ScanPipeline {
  readonly detect: Stage<RawFrame, DetectedFrame>;
  readonly rectify: Stage<DetectedFrame, RectifiedPage>;
  readonly dewarp: Stage<RectifiedPage, DewarpedPage>;
  readonly enhance: Stage<DewarpedPage, EnhancedPage>;
}

export interface PipelineResult {
  readonly page: EnhancedPage;
  readonly record: PipelineRecord;
}

export async function runPipeline(
  pipeline: ScanPipeline,
  input: RawFrame,
  settings: PipelineSettings,
  signal?: AbortSignal,
  onProgress?: (e: { stage: string; progress: number; message?: string }) => void
): Promise<PipelineResult> {
  const ctx: PipelineContext = { settings, signal, onProgress };

  const stages = [pipeline.detect, pipeline.rectify, pipeline.dewarp, pipeline.enhance] as const;
  const records: PipelineRecord['stages'][number][] = [];
  const totalStart = performance.now();

  // Stage 1: detect
  const t1 = performance.now();
  onProgress?.({ stage: pipeline.detect.name, progress: 0 });
  const detected = await pipeline.detect.process(input, ctx);
  records.push({
    name: pipeline.detect.name,
    version: pipeline.detect.version,
    durationMs: performance.now() - t1
  });
  onProgress?.({ stage: pipeline.detect.name, progress: 1 });
  signal?.throwIfAborted();

  // Stage 2: rectify
  const t2 = performance.now();
  onProgress?.({ stage: pipeline.rectify.name, progress: 0 });
  const rectified = await pipeline.rectify.process(detected, ctx);
  records.push({
    name: pipeline.rectify.name,
    version: pipeline.rectify.version,
    durationMs: performance.now() - t2
  });
  onProgress?.({ stage: pipeline.rectify.name, progress: 1 });
  signal?.throwIfAborted();

  // Stage 3: dewarp
  const t3 = performance.now();
  onProgress?.({ stage: pipeline.dewarp.name, progress: 0 });
  const dewarped = await pipeline.dewarp.process(rectified, ctx);
  records.push({
    name: pipeline.dewarp.name,
    version: pipeline.dewarp.version,
    durationMs: performance.now() - t3
  });
  onProgress?.({ stage: pipeline.dewarp.name, progress: 1 });
  signal?.throwIfAborted();

  // Stage 4: enhance
  const t4 = performance.now();
  onProgress?.({ stage: pipeline.enhance.name, progress: 0 });
  const enhanced = await pipeline.enhance.process(dewarped, ctx);
  records.push({
    name: pipeline.enhance.name,
    version: pipeline.enhance.version,
    durationMs: performance.now() - t4
  });
  onProgress?.({ stage: pipeline.enhance.name, progress: 1 });

  const totalDurationMs = performance.now() - totalStart;

  const record: PipelineRecord = {
    stages: records,
    totalDurationMs,
    settings
  };

  return { page: enhanced, record };
}
