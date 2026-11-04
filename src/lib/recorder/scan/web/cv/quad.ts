/**
 * Document quadrilateral detection.
 *
 * Strategy:
 *  1. Strong box blur (r=10) to fill text/chart holes and smooth the image.
 *  2. Otsu threshold — then sweep ±offsets if initial attempt fails.
 *  3. BFS flood fill from the image center to isolate the document blob.
 *  4. Extremal diagonal projection → 4 candidate corners.
 *  5. Strict geometric validation — reject anything that isn't plausibly
 *     a document quadrilateral (out-of-frame, non-convex, bad angles, etc.).
 *  6. Edge-based fallback (Canny extremal projection) if all brightness
 *     attempts fail.
 */

import type { Quad, Size } from '../types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param gray       Grayscale pixel array (same size as edges).
 * @param edges      Canny edge map.
 * @param w / h      Image dimensions.
 * @param threshBias Shift applied to the Otsu threshold.
 *                   Negative → more aggressive (catches low-contrast docs).
 *                   Positive → less aggressive. Default 0.
 */
export function findDocumentQuad(
  gray: Uint8Array,
  edges: Uint8Array,
  w: number,
  h: number,
  threshBias = 0
): Quad | null {
  const blurred = boxBlur(gray, w, h, 10);
  const baseT   = otsuThreshold(blurred);
  const margin  = Math.round(Math.min(w, h) * 0.02);

  // Try several threshold offsets (auto-retry for low-contrast scenes)
  const biases = [threshBias, threshBias - 20, threshBias - 40, threshBias + 20];

  for (const bias of biases) {
    const t = Math.max(10, Math.min(245, baseT + bias));
    const binary = new Uint8Array(w * h);
    for (let i = 0; i < blurred.length; i++) binary[i] = blurred[i]! > t ? 1 : 0;

    const cx = w >> 1, cy = h >> 1;
    const starts: Array<[number, number]> = [
      [cx, cy],
      [cx, (cy * 0.6) | 0],
      [cx, (cy * 1.4) | 0],
      [(cx * 0.6) | 0, cy],
      [(cx * 1.4) | 0, cy],
    ];

    for (const [sx, sy] of starts) {
      if (!binary[sy * w + sx]) continue;
      const { mask, size } = floodFill(binary, w, h, sx, sy);
      if (size < w * h * 0.04) continue;

      const q = extremalQuad(mask, w, h, margin);
      if (q && isValidDocumentQuad(q, w, h)) return q;
    }
  }

  // Edge-based fallback
  const eq = extremalQuad(edges, w, h, Math.round(Math.min(w, h) * 0.04));
  if (eq && isValidDocumentQuad(eq, w, h)) return eq;

  return null;
}

/**
 * Strict geometric validation — rejects candidates that can't be a document.
 * This is the key guard against out-of-frame or degenerate quads.
 */
export function isValidDocumentQuad(q: Quad, w: number, h: number): boolean {
  const TOL = 0.04; // 4% tolerance for corners near the image edge

  // 1. All corners must be strictly inside the image frame.
  // No tolerance — corners at the very edge indicate the blob engulfed
  // the whole scene rather than the document.
  for (const pt of [q.tl, q.tr, q.br, q.bl]) {
    if (
      pt.x < w * TOL || pt.x > w * (1 - TOL) ||
      pt.y < h * TOL || pt.y > h * (1 - TOL)
    ) return false;
  }

  // 2. Area: 5%–65% of frame.
  // Above 65% the detection almost certainly captured the whole surface,
  // not just the document.
  const area = quadArea(q);
  if (area < w * h * 0.05 || area > w * h * 0.65) return false;

  // 3. Strict convexity (all cross-products same sign)
  if (!isConvex(q)) return false;

  // 4. Interior angles between 25° and 155° (no degenerate corners)
  const pts = [q.tl, q.tr, q.br, q.bl] as const;
  for (let i = 0; i < 4; i++) {
    const a = pts[(i + 3) % 4]!, b = pts[i]!, c = pts[(i + 1) % 4]!;
    const v1x = a.x - b.x, v1y = a.y - b.y;
    const v2x = c.x - b.x, v2y = c.y - b.y;
    const dot = v1x * v2x + v1y * v2y;
    const mag = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (mag < 1) return false;
    const angle = Math.acos(Math.max(-1, Math.min(1, dot / mag))) * (180 / Math.PI);
    if (angle < 25 || angle > 155) return false;
  }

  // 5. Aspect ratio between 0.15 and 6.5 (not a thin sliver)
  const { width, height } = targetSizeFromQuad(q);
  const ratio = width / (height || 1);
  if (ratio < 0.15 || ratio > 6.5) return false;

  // 6. Both diagonals must be long enough
  if (dist(q.tl, q.br) < Math.min(w, h) * 0.15) return false;
  if (dist(q.tr, q.bl) < Math.min(w, h) * 0.15) return false;

  return true;
}

export function scaleQuad(q: Quad, scale: number): Quad {
  return {
    tl: { x: q.tl.x / scale, y: q.tl.y / scale },
    tr: { x: q.tr.x / scale, y: q.tr.y / scale },
    br: { x: q.br.x / scale, y: q.br.y / scale },
    bl: { x: q.bl.x / scale, y: q.bl.y / scale },
  };
}

export function targetSizeFromQuad(q: Quad): Size {
  const wTop    = dist(q.tl, q.tr);
  const wBottom = dist(q.bl, q.br);
  const hLeft   = dist(q.tl, q.bl);
  const hRight  = dist(q.tr, q.br);
  return {
    width:  Math.round(Math.max(wTop,   wBottom)),
    height: Math.round(Math.max(hLeft,  hRight)),
  };
}

// ---------------------------------------------------------------------------
// Box blur (fast separable sliding-window)
// ---------------------------------------------------------------------------

function boxBlur(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 0; x <= r && x < w; x++) sum += src[y * w + x]!;
    for (let x = 0; x < w; x++) {
      if (x + r < w) sum += src[y * w + x + r]!;
      const lo = Math.max(0, x - r), hi = Math.min(w - 1, x + r);
      tmp[y * w + x] = (sum / (hi - lo + 1)) | 0;
      if (x - r >= 0) sum -= src[y * w + x - r]!;
    }
  }

  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = 0; y <= r && y < h; y++) sum += tmp[y * w + x]!;
    for (let y = 0; y < h; y++) {
      if (y + r < h) sum += tmp[(y + r) * w + x]!;
      const lo = Math.max(0, y - r), hi = Math.min(h - 1, y + r);
      out[y * w + x] = (sum / (hi - lo + 1)) | 0;
      if (y - r >= 0) sum -= tmp[(y - r) * w + x]!;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Otsu threshold
// ---------------------------------------------------------------------------

function otsuThreshold(gray: Uint8Array): number {
  const hist = new Int32Array(256);
  for (let i = 0; i < gray.length; i++) { const v = gray[i] ?? 0; hist[v]!++; }

  const n = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;

  let sumB = 0, wB = 0, maxVar = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (!wB || wB === n) continue;
    const wF = n - wB;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) { maxVar = v; threshold = t; }
  }
  return threshold;
}

// ---------------------------------------------------------------------------
// BFS flood fill
// ---------------------------------------------------------------------------

function floodFill(
  binary: Uint8Array,
  w: number,
  h: number,
  x0: number,
  y0: number
): { mask: Uint8Array; size: number } {
  const mask  = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let qs = 0, qe = 0;

  const s = y0 * w + x0;
  mask[s] = 1; queue[qe++] = s;

  while (qs < qe) {
    const i = queue[qs++]!;
    const y = (i / w) | 0, x = i % w;
    if (x > 0     && binary[i - 1] && !mask[i - 1]) { mask[i - 1] = 1; queue[qe++] = i - 1; }
    if (x < w - 1 && binary[i + 1] && !mask[i + 1]) { mask[i + 1] = 1; queue[qe++] = i + 1; }
    if (y > 0     && binary[i - w] && !mask[i - w]) { mask[i - w] = 1; queue[qe++] = i - w; }
    if (y < h - 1 && binary[i + w] && !mask[i + w]) { mask[i + w] = 1; queue[qe++] = i + w; }
  }

  return { mask, size: qe };
}

// ---------------------------------------------------------------------------
// Extremal diagonal projection → quad corners
// ---------------------------------------------------------------------------

function extremalQuad(data: Uint8Array, w: number, h: number, margin: number): Quad | null {
  let tlScore = Infinity,  trScore = -Infinity;
  let brScore = -Infinity, blScore = Infinity;
  let tl = { x: 0, y: 0 }, tr = { x: 0, y: 0 };
  let br = { x: 0, y: 0 }, bl = { x: 0, y: 0 };
  let count = 0;

  for (let y = margin; y < h - margin; y++) {
    for (let x = margin; x < w - margin; x++) {
      if (!data[y * w + x]) continue;
      count++;
      const s1 = x + y, s2 = x - y;
      if (s1 < tlScore) { tlScore = s1; tl = { x, y }; }
      if (s2 > trScore) { trScore = s2; tr = { x, y }; }
      if (s1 > brScore) { brScore = s1; br = { x, y }; }
      if (s2 < blScore) { blScore = s2; bl = { x, y }; }
    }
  }

  if (count < 50) return null;
  return { tl, tr, br, bl };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function isConvex(q: Quad): boolean {
  const pts = [q.tl, q.tr, q.br, q.bl] as const;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i]!, b = pts[(i + 1) % 4]!, c = pts[(i + 2) % 4]!;
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cross) > 1) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

function quadArea(q: Quad): number {
  const pts = [q.tl, q.tr, q.br, q.bl];
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    area += pts[i]!.x * pts[j]!.y - pts[j]!.x * pts[i]!.y;
  }
  return Math.abs(area) / 2;
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
