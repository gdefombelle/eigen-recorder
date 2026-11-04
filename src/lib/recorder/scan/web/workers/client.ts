/**
 * Type-safe client for the pipeline worker. Hides the message protocol behind
 * a Promise-returning API and exposes progress as an async iterator.
 */

import type {
  PipelineRecord,
  PipelineSettings,
  ProgressEvent,
  RawFrame
} from '../types.js';

export interface PipelineRunResult {
  readonly image: ImageData;
  readonly record: PipelineRecord;
}

export class PipelineClient {
  private readonly worker: Worker;
  private readonly handlers = new Map<
    string,
    {
      resolve: (r: PipelineRunResult) => void;
      reject: (e: unknown) => void;
      onProgress?: (e: ProgressEvent) => void;
    }
  >();

  constructor() {
    this.worker = new Worker(new URL('./pipeline.worker.ts', import.meta.url), {
      type: 'module'
    });
    this.worker.addEventListener('message', this.handleMessage);
  }


  private handleMessage = (ev: MessageEvent): void => {
    const data = ev.data as
      | { type: 'progress'; id: string; stage: string; progress: number; message?: string }
      | { type: 'done'; id: string; image: ImageData; record: PipelineRecord }
      | { type: 'error'; id: string; message: string };
    const handler = this.handlers.get(data.id);
    if (!handler) return;
    if (data.type === 'progress') {
      handler.onProgress?.({ stage: data.stage, progress: data.progress, message: data.message });
    } else if (data.type === 'done') {
      handler.resolve({ image: data.image, record: data.record });
      this.handlers.delete(data.id);
    } else {
      handler.reject(new Error(data.message));
      this.handlers.delete(data.id);
    }
  };

  async process(
    frame: RawFrame,
    settings: PipelineSettings,
    onProgress?: (e: ProgressEvent) => void,
    forcedQuad?: import('../types.js').Quad
  ): Promise<PipelineRunResult> {
    const id = crypto.randomUUID();
    return new Promise<PipelineRunResult>((resolve, reject) => {
      this.handlers.set(id, { resolve, reject, onProgress });
      this.worker.postMessage(
        { type: 'process', id, frame, settings, forcedQuad },
        [frame.image.data.buffer]
      );
    });
  }

  cancel(id: string): void {
    this.worker.postMessage({ type: 'cancel', id });
  }

  destroy(): void {
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.terminate();
    this.handlers.clear();
  }
}
