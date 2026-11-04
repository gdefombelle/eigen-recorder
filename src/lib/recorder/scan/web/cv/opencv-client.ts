/**
 * TypeScript client for the classic OpenCV worker.
 * Handles lazy worker creation, message routing, and image downscaling.
 *
 * The worker runs at /workers/opencv-detect.js (static asset, not bundled).
 * OpenCV.js (~8 MB) is loaded once by the worker and cached by the Service Worker.
 */

import type { Quad } from '../types.js';
import { isValidDocumentQuad } from './quad.js';

interface WorkerMsg {
  id: string;
  quad?: { tl: {x:number;y:number}; tr: {x:number;y:number}; br: {x:number;y:number}; bl: {x:number;y:number} } | null;
  error?: string;
}

// Maximum width sent to OpenCV worker.
// Post-capture we can afford higher resolution than real-time (640px).
const MAX_W = 1280;

export class OpenCVDocumentDetector {
  private worker: Worker | null = null;
  private handlers = new Map<string, { resolve: (q: Quad | null) => void; reject: (e: Error) => void }>();
  private counter = 0;

  /** Detect the document quad in an image. Returns null if detection fails or is invalid. */
  async detect(image: ImageData): Promise<Quad | null> {
    if (!this.worker) this.boot();

    // Downsample for speed — still much higher than real-time detection
    const { img: proc, scale } = await this.resize(image);

    const id = `ocv-${Date.now()}-${this.counter++}`;
    const buffer = proc.data.slice().buffer; // copy, don't detach original

    const raw = await new Promise<WorkerMsg['quad']>((resolve, reject) => {
      this.handlers.set(id, { resolve: (q) => resolve(q ?? null), reject });
      this.worker!.postMessage({ id, buffer, width: proc.width, height: proc.height }, [buffer]);
    });

    if (!raw) return null;

    // Scale back to original image coordinates
    const quad: Quad = {
      tl: { x: raw.tl.x / scale, y: raw.tl.y / scale },
      tr: { x: raw.tr.x / scale, y: raw.tr.y / scale },
      br: { x: raw.br.x / scale, y: raw.br.y / scale },
      bl: { x: raw.bl.x / scale, y: raw.bl.y / scale },
    };

    return isValidDocumentQuad(quad, image.width, image.height) ? quad : null;
  }

  private boot() {
    this.worker = new Worker('/workers/opencv-detect.js');
    this.worker.onmessage = (ev: MessageEvent<WorkerMsg>) => {
      const { id, quad, error } = ev.data;
      const h = this.handlers.get(id);
      if (!h) return;
      this.handlers.delete(id);
      if (error) h.reject(new Error(error));
      else h.resolve(quad ?? null);
    };
    this.worker.onerror = (ev) => {
      for (const [, h] of this.handlers) h.reject(new Error(ev.message ?? 'OpenCV worker error'));
      this.handlers.clear();
    };
  }

  private async resize(image: ImageData): Promise<{ img: ImageData; scale: number }> {
    if (image.width <= MAX_W) return { img: image, scale: 1 };
    const scale = MAX_W / image.width;
    const w = Math.round(image.width  * scale);
    const h = Math.round(image.height * scale);
    const src = new OffscreenCanvas(image.width, image.height);
    src.getContext('2d')!.putImageData(image, 0, 0);
    const dst = new OffscreenCanvas(w, h);
    dst.getContext('2d')!.drawImage(src, 0, 0, w, h);
    return { img: dst.getContext('2d')!.getImageData(0, 0, w, h), scale };
  }

  destroy() {
    this.worker?.terminate();
    this.worker = null;
    this.handlers.clear();
  }
}

// Module-level singleton — reused across captures
let _instance: OpenCVDocumentDetector | null = null;

export function getOpenCVDetector(): OpenCVDocumentDetector {
  if (!_instance) _instance = new OpenCVDocumentDetector();
  return _instance;
}
