/// <reference lib="webworker" />
/**
 * Pipeline worker. Receives RawFrames from the main thread and runs the
 * configured pipeline against them. Communicates via structured-clone
 * messages; ImageData is transferred when possible to avoid copies.
 *
 * Protocol:
 *   in:  { type: 'process', id, frame, settings }
 *        { type: 'cancel', id }
 *   out: { type: 'progress', id, stage, progress, message? }
 *        { type: 'done', id, image, record }
 *        { type: 'error', id, message }
 */

import { createDefaultPipeline, runPipeline } from '../pipeline/index.js';
import type { DetectedFrame, PipelineContext, PipelineSettings, Quad, RawFrame } from '../types.js';

interface ProcessMsg {
  type: 'process';
  id: string;
  frame: RawFrame;
  settings: PipelineSettings;
  /** When set, skips detect stage and uses this quad directly (manual crop). */
  forcedQuad?: Quad;
}

interface CancelMsg {
  type: 'cancel';
  id: string;
}

type InMsg = ProcessMsg | CancelMsg;

const pipeline = createDefaultPipeline();
const inflight = new Map<string, AbortController>();

self.addEventListener('message', async (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;

  if (msg.type === 'cancel') {
    inflight.get(msg.id)?.abort();
    inflight.delete(msg.id);
    return;
  }

  if (msg.type === 'process') {
    const ctrl = new AbortController();
    inflight.set(msg.id, ctrl);
    try {
      let page, record;

      if (msg.forcedQuad) {
        // Manual crop path: skip detect, use the provided quad directly.
        const ctx: PipelineContext = { settings: msg.settings, signal: ctrl.signal };
        const detected: DetectedFrame = {
          kind: 'detected',
          image: msg.frame.image,
          capturedAt: msg.frame.capturedAt,
          confidence: 1,
          quad: msg.forcedQuad
        };
        const rectified = await pipeline.rectify.process(detected, ctx);
        const dewarped  = await pipeline.dewarp.process(rectified, ctx);
        const enhanced  = await pipeline.enhance.process(dewarped, ctx);
        page = enhanced;
        record = { stages: [], totalDurationMs: 0, settings: msg.settings };
      } else {
        ({ page, record } = await runPipeline(
          pipeline,
          msg.frame,
          msg.settings,
          ctrl.signal,
          (e) =>
            self.postMessage({
              type: 'progress',
              id: msg.id,
              stage: e.stage,
              progress: e.progress,
              message: e.message
            })
        ));
      }
      self.postMessage(
        { type: 'done', id: msg.id, image: page.image, record },
        { transfer: [page.image.data.buffer] }
      );
    } catch (err) {
      self.postMessage({
        type: 'error',
        id: msg.id,
        message: err instanceof Error ? err.message : String(err)
      });
    } finally {
      inflight.delete(msg.id);
    }
  }
});

export {};
