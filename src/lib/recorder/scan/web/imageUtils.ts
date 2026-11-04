// imageUtils — canvas helpers from DocScan's scan page (scanner-app, src/routes/scan/+page.svelte), plus the re-encoder
// the PDF budget uses. Browser only (OffscreenCanvas / createImageBitmap); the pure logic that calls them is tested with fakes.

import type { QualityStep, ScannedPage } from './pdf.js';

export async function imageDataToBlob(img: ImageData, type: string, quality: number): Promise<Blob> {
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c.convertToBlob({ type, quality });
}

export function downscale(img: ImageData, maxDim: number): ImageData {
  const ratio = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.round(img.width * ratio), h = Math.round(img.height * ratio);
  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext('2d')!.putImageData(img, 0, 0);
  const dst = new OffscreenCanvas(w, h);
  dst.getContext('2d')!.drawImage(src, 0, 0, w, h);
  return dst.getContext('2d')!.getImageData(0, 0, w, h);
}

/** Rotate ImageData 90° clockwise (landscape → portrait for the thumbnail). */
export function rotateCW90(img: ImageData): ImageData {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const di = (x * h + (h - 1 - y)) * 4;     // new image is h wide, w tall
      out[di] = data[si]!; out[di + 1] = data[si + 1]!; out[di + 2] = data[si + 2]!; out[di + 3] = data[si + 3]!;
    }
  }
  return new ImageData(out, h, w);
}

/** One page re-encoded for a lower rung of the quality ladder (used only when the 25 MB budget needs it). */
export async function reencodePage(page: ScannedPage, step: QualityStep): Promise<ScannedPage> {
  const bitmap = await createImageBitmap(page.blob);
  try {
    const k = Math.min(1, step.maxPixels / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * k)), h = Math.max(1, Math.round(bitmap.height * k));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: step.quality });
    return { blob, width: w, height: h, ...(page.thumbnail ? { thumbnail: page.thumbnail } : {}) };
  } finally {
    bitmap.close();
  }
}
