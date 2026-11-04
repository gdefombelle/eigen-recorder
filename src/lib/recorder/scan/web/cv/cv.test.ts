import { describe, it, expect } from 'vitest';
import '../testing/imageDataPolyfill.js';
import { toGrayscale, detectEdgesFromGray } from './edges.js';
import { findDocumentQuad, isValidDocumentQuad, scaleQuad, targetSizeFromQuad } from './quad.js';
import { perspectiveWarp } from './homography.js';
import { BasicEnhanceStage } from '../pipeline/stages/enhance.js';
import type { Quad } from '../types.js';

const W = 240, H = 180;
const quad = (tl: [number, number], tr: [number, number], br: [number, number], bl: [number, number]): Quad => ({
  tl: { x: tl[0], y: tl[1] }, tr: { x: tr[0], y: tr[1] }, br: { x: br[0], y: br[1] }, bl: { x: bl[0], y: bl[1] },
});

/** Point-in-convex-quad fill: a bright "sheet" on a dark desk, like a photographed document. */
function sheetImage(q: Quad, bg = 30, fg = 235): ImageData {
  const d = new Uint8ClampedArray(W * H * 4);
  const pts = [q.tl, q.tr, q.br, q.bl];
  const inside = (x: number, y: number) => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = pts[i]!, b = pts[(i + 1) % 4]!;
      const cr = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (cr !== 0) { const s = cr > 0 ? 1 : -1; if (sign && s !== sign) return false; sign = s; }
    }
    return true;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = inside(x, y) ? fg : bg, i = (y * W + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  return new ImageData(d, W, H);
}

const near = (a: { x: number; y: number }, b: { x: number; y: number }, tol: number) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;

describe('document quad detection (ported from DocScan)', () => {
  it('finds a slightly skewed sheet on a dark background within a few pixels', () => {
    const truth = quad([40, 30], [200, 22], [210, 150], [32, 156]);
    const img = sheetImage(truth);
    const gray = toGrayscale(img);
    const found = findDocumentQuad(gray, detectEdgesFromGray(gray, W, H), W, H);
    expect(found).not.toBeNull();
    for (const k of ['tl', 'tr', 'br', 'bl'] as const) expect(near(found![k], truth[k], 12), k).toBe(true);
  });

  it('returns no quad on an empty, uniform scene', () => {
    const d = new Uint8ClampedArray(W * H * 4).fill(120);
    const gray = toGrayscale(new ImageData(d, W, H));
    expect(findDocumentQuad(gray, detectEdgesFromGray(gray, W, H), W, H)).toBeNull();
  });
});

describe('quad validation and geometry', () => {
  it('accepts a plausible document and rejects out-of-frame, non-convex and sliver quads', () => {
    expect(isValidDocumentQuad(quad([40, 30], [200, 25], [205, 150], [35, 155]), W, H)).toBe(true);
    expect(isValidDocumentQuad(quad([0, 0], [W, 0], [W, H], [0, H]), W, H)).toBe(false);                 // whole frame
    expect(isValidDocumentQuad(quad([40, 30], [200, 30], [60, 100], [40, 150]), W, H)).toBe(false);     // non-convex "bow-tie-ish"
    expect(isValidDocumentQuad(quad([20, 80], [220, 80], [220, 86], [20, 86]), W, H)).toBe(false);      // thin sliver
  });
  it('rejects a quad that covers most of the frame (the whole desk, not the sheet), by area alone', () => {
    expect(isValidDocumentQuad(quad([12, 10], [228, 10], [228, 170], [12, 170]), W, H)).toBe(false);   // 80 % of the frame
  });
  it('rejects a concave quad that passes every other guard (convexity is the only reason)', () => {
    expect(isValidDocumentQuad(quad([30, 20], [210, 110], [70, 110], [30, 170]), W, H)).toBe(false);
    expect(isValidDocumentQuad(quad([30, 20], [210, 20], [210, 110], [30, 170]), W, H)).toBe(true);    // same corners, convex → fine
  });
  it('scaleQuad DIVIDES by the scale (DocScan convention) and targetSizeFromQuad uses the longer sides', () => {
    const q = scaleQuad(quad([10, 20], [110, 20], [110, 220], [10, 220]), 0.5);
    expect(q.tl).toEqual({ x: 20, y: 40 });
    expect(q.br).toEqual({ x: 220, y: 440 });
    expect(targetSizeFromQuad(quad([0, 0], [100, 0], [110, 150], [0, 140]))).toEqual({ width: 110, height: 150 });
  });
});

describe('perspective rectification', () => {
  it('maps the quad corners to the output corners (a crop for an axis-aligned quad)', () => {
    const d = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; d[i] = x; d[i + 1] = y; d[i + 2] = 0; d[i + 3] = 255; }
    const out = perspectiveWarp(new ImageData(d, W, H), quad([20, 10], [120, 10], [120, 90], [20, 90]), 100, 80);
    const px = (x: number, y: number) => [out.data[(y * 100 + x) * 4]!, out.data[(y * 100 + x) * 4 + 1]!];
    expect(px(1, 1)).toEqual([21, 11]);
    expect(px(98, 1)).toEqual([118, 11]);
    expect(px(1, 78)).toEqual([21, 88]);
    expect(px(50, 40)).toEqual([70, 50]);
  });

  it('flattens a skewed sheet: everything inside the output is the sheet, not the desk', () => {
    const truth = quad([40, 30], [200, 22], [210, 150], [32, 156]);
    const img = sheetImage(truth, 30, 235);
    const size = targetSizeFromQuad(truth);
    const out = perspectiveWarp(img, truth, size.width, size.height);
    let bright = 0, total = 0;
    expect(out.data[(Math.floor(size.height / 2) * size.width + Math.floor(size.width / 2)) * 4 + 3]).toBe(255);   // opaque inside
    for (let y = 3; y < size.height - 3; y++) for (let x = 3; x < size.width - 3; x++) { total++; if (out.data[(y * size.width + x) * 4]! > 200) bright++; }
    expect(bright / total).toBeGreaterThan(0.97);
  });
});

describe('grayscale', () => {
  it('weights the channels like luminance (red 77, green 150, blue 29 of 256)', () => {
    const g = toGrayscale(new ImageData(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]), 3, 1));
    expect(Array.from(g)).toEqual([76, 149, 28]);
  });
});

describe('enhancement', () => {
  it('ignores transparent border pixels (from the perspective warp) when stretching', async () => {
    const d = new Uint8ClampedArray(40 * 4);
    for (let i = 0; i < 40; i++) { const o = i * 4; if (i < 20) { d[o + 3] = 0; } else { const v = 100 + (i - 20) * 2; d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 255; } }
    const out = await new BasicEnhanceStage().process({ kind: 'dewarped', image: new ImageData(d, 40, 1), applied: false },
      { settings: { enhancement: 'auto', dewarpStrategy: 'none', outputDpi: 200, preserveRaw: false } });
    expect(out.image.data[20 * 4]!).toBeLessThan(20);          // darkest opaque pixel → near black, not stuck at 100
    expect(out.image.data[39 * 4]!).toBeGreaterThan(235);
  });
  it('stretches a dull, blue-cast page toward full contrast per channel', async () => {
    const d = new Uint8ClampedArray(64 * 64 * 4);
    for (let i = 0; i < d.length; i += 4) { const t = (i / 4) % 64 / 63; d[i] = 80 + t * 60; d[i + 1] = 90 + t * 60; d[i + 2] = 130 + t * 60; d[i + 3] = 255; }
    const stage = new BasicEnhanceStage();
    const out = await stage.process({ kind: 'dewarped', image: new ImageData(d, 64, 64), applied: false },
      { settings: { enhancement: 'auto', dewarpStrategy: 'none', outputDpi: 200, preserveRaw: false } });
    const row = (c: number, x: number) => out.image.data[x * 4 + c]!;
    for (const c of [0, 1, 2]) { expect(row(c, 0)).toBeLessThan(30); expect(row(c, 63)).toBeGreaterThan(225); }
  });
  it("'none' leaves the pixels untouched", async () => {
    const img = new ImageData(new Uint8ClampedArray([10, 20, 30, 255]), 1, 1);
    const out = await new BasicEnhanceStage().process({ kind: 'dewarped', image: img, applied: false },
      { settings: { enhancement: 'none', dewarpStrategy: 'none', outputDpi: 200, preserveRaw: false } });
    expect(Array.from(out.image.data)).toEqual([10, 20, 30, 255]);
  });
});
