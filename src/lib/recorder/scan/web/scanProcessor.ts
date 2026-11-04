// scanProcessor — one captured frame → one scanned page. DocScan's `processAndSave` (scanner-app, scan page) without
// its storage: the same detection order and the same pipeline, then JPEG + thumbnail for the PDF.
//
// Detection on the CAPTURED image (always, whatever the live overlay showed):
//   1. OpenCV.js in a worker on a 1280 px copy, 15 s budget (the first run downloads ~8 MB)
//   2. the quad the viewfinder showed (or the guide rectangle)
//   3. the full frame
// Everything heavy (detect/rectify/enhance) runs in the pipeline Web Worker.

import type { PipelineSettings, Quad, RawFrame } from './types.js';
import { QUALITY_LADDER, type ScannedPage } from './pdf.js';

export const DETECT_PX = 1280;
export const OPENCV_BUDGET_MS = 15_000;
export const THUMB_PX = 256;

/** DocScan's settings for the web pipeline. */
export const WEB_PIPELINE_SETTINGS: PipelineSettings = {
  enhancement: 'auto',
  dewarpStrategy: 'naive',
  outputDpi: 200,
  preserveRaw: false,
};

export interface ProcessorDeps {
  /** OpenCV.js detector (null when unavailable, e.g. offline: the viewfinder quad is used instead). */
  detect: (img: ImageData) => Promise<Quad | null>;
  /** The pipeline worker: rectify + dewarp + enhance with this quad. */
  runPipeline: (frame: RawFrame, quad: Quad) => Promise<ImageData>;
  downscale: (img: ImageData, maxDim: number) => ImageData;
  rotateCW90: (img: ImageData) => ImageData;
  toJpeg: (img: ImageData, quality: number) => Promise<Blob>;
  now: () => number;
  timeout: <T>(ms: number, fallback: T) => Promise<T>;
}

/** Plain objects only: Svelte reactive proxies cannot go through postMessage / structured clone. */
export function plainQuad(q: Quad): Quad {
  return {
    tl: { x: q.tl.x, y: q.tl.y }, tr: { x: q.tr.x, y: q.tr.y },
    br: { x: q.br.x, y: q.br.y }, bl: { x: q.bl.x, y: q.bl.y },
  };
}

export function fullFrameQuad(w: number, h: number): Quad {
  return { tl: { x: 0, y: 0 }, tr: { x: w, y: 0 }, br: { x: w, y: h }, bl: { x: 0, y: h } };
}

export function guideQuad(w: number, h: number): Quad {
  const ix = w * 0.05, iy = h * 0.05;
  return { tl: { x: ix, y: iy }, tr: { x: w - ix, y: iy }, br: { x: w - ix, y: h - iy }, bl: { x: ix, y: h - iy } };
}

export async function processCapture(
  deps: ProcessorDeps,
  image: ImageData,
  viewfinderQuad: Quad | null,
): Promise<ScannedPage & { quad: Quad; detected: 'opencv' | 'viewfinder' | 'full-frame' }> {
  // Detection runs on a 1280 px copy; its quad is scaled back to the full image.
  const ds = Math.min(1, DETECT_PX / Math.max(image.width, image.height));
  const detectImg = ds < 1 ? deps.downscale(image, DETECT_PX) : image;
  const upscale = (q: Quad): Quad => ({
    tl: { x: q.tl.x / ds, y: q.tl.y / ds }, tr: { x: q.tr.x / ds, y: q.tr.y / ds },
    br: { x: q.br.x / ds, y: q.br.y / ds }, bl: { x: q.bl.x / ds, y: q.bl.y / ds },
  });

  let quad: Quad | null = null;
  let detected: 'opencv' | 'viewfinder' | 'full-frame' = 'full-frame';
  try {
    const cvq = await Promise.race([deps.detect(detectImg), deps.timeout<null>(OPENCV_BUDGET_MS, null)]);
    if (cvq) { quad = upscale(cvq); detected = 'opencv'; }
  } catch { /* OpenCV failed to load (offline, blocked): fall through to the viewfinder quad */ }
  if (!quad && viewfinderQuad) { quad = plainQuad(viewfinderQuad); detected = 'viewfinder'; }
  if (!quad) quad = fullFrameQuad(image.width, image.height);

  const frame: RawFrame = { kind: 'raw', image, capturedAt: deps.now() };
  const processed = await deps.runPipeline(frame, quad);

  let thumbData = deps.downscale(processed, THUMB_PX);
  if (processed.width > processed.height * 1.1) thumbData = deps.rotateCW90(thumbData);   // portrait card

  const first = QUALITY_LADDER[0]!;
  const pageImage = Math.max(processed.width, processed.height) > first.maxPixels ? deps.downscale(processed, first.maxPixels) : processed;
  const [blob, thumbnail] = await Promise.all([deps.toJpeg(pageImage, first.quality), deps.toJpeg(thumbData, 0.8)]);
  return { blob, thumbnail, width: pageImage.width, height: pageImage.height, quad, detected };
}
