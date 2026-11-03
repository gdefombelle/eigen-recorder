// imagePrep — photo normalisation before queueing.
//
// Photos are sent as JPEG, long side ≤ 2048 px, quality ≈ 0.85, and the SHA-256
// is computed on the exact bytes that will be uploaded (the server verifies it).
// Documents are sent untouched (only their hash is computed).
//
// Re-encoding through a canvas also converts HEIC → JPEG and drops EXIF
// metadata (including GPS), which is what we want for a meeting capture.

export const PHOTO_MAX_SIDE = 2048;
export const PHOTO_QUALITY  = 0.85;

/** Scale (w, h) down so the long side is ≤ max. Never upscales; keeps the aspect ratio. */
export function fitWithin(width: number, height: number, max = PHOTO_MAX_SIDE): { width: number; height: number } {
  const longSide = Math.max(width, height);
  if (longSide <= max) return { width, height };
  const k = max / longSide;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

export async function sha256Hex(data: Blob | ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data instanceof Blob ? await data.arrayBuffer() : data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface PreparedFile {
  blob:    Blob;
  sha256:  string;
  width?:  number;
  height?: number;
}

/** Decode → resize → JPEG q0.85. Needs a real browser (createImageBitmap + canvas). */
export async function preparePhoto(source: Blob): Promise<PreparedFile> {
  // 'from-image' applies the EXIF orientation, so portrait photos aren't saved sideways.
  const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG encoding failed'))), 'image/jpeg', PHOTO_QUALITY));
    return { blob, sha256: await sha256Hex(blob), width, height };
  } finally {
    bitmap.close();
  }
}

/**
 * Documents go as-is (same bytes, same type) — but as an in-memory Blob, not the File the picker handed us.
 * A picked File can be file-backed by a temporary path the system may reclaim; a Blob built from the bytes
 * read NOW is self-contained, like the canvas Blobs photos already are (and photos upload fine).
 */
export async function prepareDocument(source: Blob): Promise<PreparedFile> {
  const bytes = await source.arrayBuffer();
  return { blob: new Blob([bytes], { type: source.type }), sha256: await sha256Hex(bytes) };
}
