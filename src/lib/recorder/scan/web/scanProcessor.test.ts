import { describe, it, expect, vi } from 'vitest';
import './testing/imageDataPolyfill.js';
import { processCapture, plainQuad, fullFrameQuad, guideQuad, DETECT_PX, OPENCV_BUDGET_MS, type ProcessorDeps } from './scanProcessor.js';
import { QUALITY_LADDER } from './pdf.js';
import type { Quad } from './types.js';

const img = (w: number, h: number) => new ImageData(new Uint8ClampedArray(w * h * 4), w, h);
const Q = (x0: number, y0: number, x1: number, y1: number): Quad => ({ tl: { x: x0, y: y0 }, tr: { x: x1, y: y0 }, br: { x: x1, y: y1 }, bl: { x: x0, y: y1 } });

function deps(over: Partial<ProcessorDeps> & { processedSize?: [number, number] } = {}) {
  const calls = { pipelineQuad: null as Quad | null, downscales: [] as number[], rotated: 0, jpeg: [] as Array<[number, number]> };
  const [pw, ph] = over.processedSize ?? [1000, 1400];
  const d: ProcessorDeps = {
    detect: over.detect ?? (async () => null),
    runPipeline: over.runPipeline ?? (async (_f, q) => { calls.pipelineQuad = q; return img(pw, ph); }),
    downscale: over.downscale ?? ((i, max) => { calls.downscales.push(max); const k = Math.min(1, max / Math.max(i.width, i.height)); return img(Math.round(i.width * k), Math.round(i.height * k)); }),
    rotateCW90: over.rotateCW90 ?? ((i) => { calls.rotated++; return img(i.height, i.width); }),
    toJpeg: over.toJpeg ?? (async (i, q) => { calls.jpeg.push([i.width, q]); return new Blob(['jpg']); }),
    now: () => 42,
    timeout: over.timeout ?? (() => new Promise(() => { /* never fires */ })),
  };
  return { d, calls };
}

describe('processCapture — detection order (DocScan processAndSave)', () => {
  it('uses the OpenCV quad, scaled back from the 1280 px detection copy to the full image', async () => {
    const cv = Q(100, 50, 900, 700);                                    // in 1280-px space (image is 2560 wide → ds = 0.5)
    const { d, calls } = deps({ detect: async () => cv });
    const r = await processCapture(d, img(2560, 1920), Q(1, 1, 2, 2));
    expect(r.detected).toBe('opencv');
    expect(calls.pipelineQuad).toEqual(Q(200, 100, 1800, 1400));
    expect(calls.downscales[0]).toBe(DETECT_PX);
  });

  it('does not downscale for detection when the image is already within 1280 px', async () => {
    const seen: number[] = [];
    const { d, calls } = deps({ detect: async (i) => { seen.push(i.width); return Q(10, 10, 100, 100); } });
    await processCapture(d, img(1000, 800), null);
    expect(seen).toEqual([1000]);
    expect(calls.pipelineQuad).toEqual(Q(10, 10, 100, 100));              // scale 1: the quad is not stretched
  });

  it('falls back to the viewfinder quad when OpenCV finds nothing, then to the full frame', async () => {
    const a = deps({ detect: async () => null });
    const ra = await processCapture(a.d, img(800, 600), Q(40, 30, 700, 500));
    expect(ra.detected).toBe('viewfinder');
    expect(a.calls.pipelineQuad).toEqual(Q(40, 30, 700, 500));
    const b = deps({ detect: async () => null });
    const rb = await processCapture(b.d, img(800, 600), null);
    expect(rb.detected).toBe('full-frame');
    expect(b.calls.pipelineQuad).toEqual(fullFrameQuad(800, 600));
  });

  it('OpenCV failing to load (offline / blocked) is not an error: the viewfinder quad is used', async () => {
    const { d, calls } = deps({ detect: async () => { throw new Error('OpenCV load failed'); } });
    const r = await processCapture(d, img(800, 600), Q(40, 30, 700, 500));
    expect(r.detected).toBe('viewfinder');
    expect(calls.pipelineQuad).toEqual(Q(40, 30, 700, 500));
  });

  it('gives OpenCV at most 15 s, then moves on', async () => {
    const budgets: number[] = [];
    const { d } = deps({ detect: () => new Promise(() => { /* never answers */ }), timeout: async (ms, fb) => { budgets.push(ms); return fb; } });
    const r = await processCapture(d, img(800, 600), null);
    expect(budgets).toEqual([OPENCV_BUDGET_MS]);
    expect(r.detected).toBe('full-frame');
  });

  it('the viewfinder quad is flattened to a plain object (no Svelte proxy in the worker message)', () => {
    const proxyish = { tl: { x: 1, y: 2, extra: 1 }, tr: { x: 3, y: 4 }, br: { x: 5, y: 6 }, bl: { x: 7, y: 8 } } as unknown as Quad;
    expect(plainQuad(proxyish)).toEqual({ tl: { x: 1, y: 2 }, tr: { x: 3, y: 4 }, br: { x: 5, y: 6 }, bl: { x: 7, y: 8 } });
    expect(guideQuad(100, 200)).toEqual({ tl: { x: 5, y: 10 }, tr: { x: 95, y: 10 }, br: { x: 95, y: 190 }, bl: { x: 5, y: 190 } });
  });
});

describe('processCapture — the page and its thumbnail', () => {
  it('encodes the page at the default rung (≤ 2000 px, quality 0.8) and the thumbnail at 256 px', async () => {
    const { d, calls } = deps({ processedSize: [3000, 4000] });
    const r = await processCapture(d, img(800, 600), null);
    expect(calls.downscales).toContain(QUALITY_LADDER[0]!.maxPixels);
    expect(calls.downscales).toContain(256);
    expect(r.width).toBe(1500);
    expect(r.height).toBe(2000);
    expect(calls.jpeg).toContainEqual([1500, 0.8]);
    expect(calls.jpeg).toContainEqual([192, 0.8]);                       // the 256-px thumbnail (3:4 → 192 wide), quality 0.8
  });

  it('a page already within 2000 px is not downscaled again', async () => {
    const { d, calls } = deps({ processedSize: [1000, 1400] });
    await processCapture(d, img(800, 600), null);
    expect(calls.downscales.filter((m) => m === 2000)).toHaveLength(0);
  });

  it('rotates the thumbnail of a landscape page so the card is portrait, and only then', async () => {
    const land = deps({ processedSize: [1600, 900] });
    await processCapture(land.d, img(800, 600), null);
    expect(land.calls.rotated).toBe(1);
    const port = deps({ processedSize: [900, 1600] });
    await processCapture(port.d, img(800, 600), null);
    expect(port.calls.rotated).toBe(0);
    const sq = deps({ processedSize: [1000, 950] });                     // ratio 1.05 < 1.1: not rotated
    await processCapture(sq.d, img(800, 600), null);
    expect(sq.calls.rotated).toBe(0);
  });

  it('a pipeline failure is reported, not swallowed', async () => {
    const { d } = deps({ runPipeline: vi.fn(async () => { throw new Error('worker OOM'); }) });
    await expect(processCapture(d, img(800, 600), null)).rejects.toThrow('worker OOM');
  });
});
