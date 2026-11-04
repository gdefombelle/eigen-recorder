import { describe, it, expect, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { buildPdfFromJpegs, buildScanPdf, PdfTooLargeError, QUALITY_LADDER, PDF_DPI, type ScannedPage } from './pdf.js';
import { JPEG_HIGH, JPEG_MID, JPEG_LOW } from './testing/jpegFixtures.js';

const jpeg = (b64: string): Blob => new Blob([Uint8Array.from(Buffer.from(b64, 'base64'))], { type: 'image/jpeg' });
const page = (b64 = JPEG_HIGH): ScannedPage => ({ blob: jpeg(b64), width: 120, height: 160 });
const HIGH = jpeg(JPEG_HIGH).size, MID = jpeg(JPEG_MID).size, LOW = jpeg(JPEG_LOW).size;

describe('buildPdfFromJpegs', () => {
  it('makes one PDF page per scanned page, sized from the pixels at 200 DPI', async () => {
    const bytes = await buildPdfFromJpegs([page(), page(JPEG_MID), page(JPEG_LOW)], { title: 'Scan 00:46' });
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });     // pdf-lib otherwise rewrites the producer on load
    expect(doc.getPageCount()).toBe(3);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeCloseTo((120 / PDF_DPI) * 72, 3);
    expect(height).toBeCloseTo((160 / PDF_DPI) * 72, 3);
    expect(doc.getTitle()).toBe('Scan 00:46');
    expect(doc.getProducer()).toBe('Eigen Pocket');
  });

  it('embeds the JPEG as it is (no re-encoding): the PDF is the JPEG bytes plus a small structure', async () => {
    const bytes = await buildPdfFromJpegs([page(), page()]);
    expect(bytes.byteLength).toBeGreaterThanOrEqual(2 * HIGH);
    expect(bytes.byteLength - 2 * HIGH).toBeLessThan(8_000);
  });

  it('starts with the PDF magic (what the engine and the server check)', async () => {
    const bytes = await buildPdfFromJpegs([page()]);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });
});

describe('buildScanPdf — the 25 MB budget', () => {
  const reencode = (map: Record<number, string>) => vi.fn(async (_p: ScannedPage, step: { maxPixels: number; quality: number }) => {
    const b64 = map[QUALITY_LADDER.findIndex((s) => s.maxPixels === step.maxPixels && s.quality === step.quality)] ?? JPEG_LOW;
    return page(b64);
  });

  it('fits on the first rung: nothing is re-encoded, the PDF is written once', async () => {
    const re = reencode({});
    const build = vi.fn(buildPdfFromJpegs);
    const r = await buildScanPdf([page(), page()], { limitBytes: 25_000_000, reencode: re, build });
    expect(build).toHaveBeenCalledTimes(1);
    expect(r.recompressed).toBe(false);
    expect(r.step).toEqual(QUALITY_LADDER[0]);
    expect(re).not.toHaveBeenCalled();
  });

  it('goes down the ladder until the PDF fits, re-encoding from the ORIGINAL pages each time', async () => {
    const originals = [page(), page()];
    const seen: Blob[] = [];
    const re = vi.fn(async (p: ScannedPage, step: { maxPixels: number; quality: number }) => { seen.push(p.blob); return page(step.quality <= 0.55 ? JPEG_LOW : JPEG_MID); });
    const limit = 2 * LOW + 6_000;                                  // only the LOW pages fit
    const r = await buildScanPdf(originals, { limitBytes: limit, reencode: re });
    expect(r.recompressed).toBe(true);
    expect(r.bytes.byteLength).toBeLessThanOrEqual(limit);
    expect(r.step.quality).toBeLessThanOrEqual(0.55);
    expect(seen.every((b) => b === originals[0]!.blob || b === originals[1]!.blob)).toBe(true);
    expect((await PDFDocument.load(r.bytes)).getPageCount()).toBe(2);
  });

  it('a rung whose JPEG payload alone exceeds the limit never builds a PDF', async () => {
    const re = reencode({});
    const build = vi.fn(buildPdfFromJpegs);
    await expect(buildScanPdf([page(), page()], { limitBytes: 100, reencode: re, build })).rejects.toBeInstanceOf(PdfTooLargeError);
    expect(build).not.toHaveBeenCalled();                                  // the JPEGs alone are over the limit on every rung
    expect(re).toHaveBeenCalledTimes(2 * (QUALITY_LADDER.length - 1));  // every lower rung was tried first, page by page
  });

  it('too large at every rung → PdfTooLargeError carrying the best size, the limit and the page count', async () => {
    const err = await buildScanPdf([page(), page(), page()], { limitBytes: 5_000, reencode: reencode({}) }).catch((e) => e);
    expect(err).toBeInstanceOf(PdfTooLargeError);
    expect(err).toMatchObject({ limitBytes: 5_000, pages: 3 });
    expect(err.bestBytes).toBeGreaterThan(5_000);
  });

  it('an empty scan is refused', async () => {
    await expect(buildScanPdf([], { limitBytes: 1, reencode: reencode({}) })).rejects.toThrow(/at least one page/);
  });

  it('the ladder matches the iOS plugin: default 2000 px / 0.8, strictly shrinking', () => {
    expect(QUALITY_LADDER[0]).toEqual({ maxPixels: 2000, quality: 0.8 });
    for (let i = 1; i < QUALITY_LADDER.length; i++) {
      const a = QUALITY_LADDER[i - 1]!, b = QUALITY_LADDER[i]!;
      expect(b.maxPixels <= a.maxPixels && b.quality < a.quality).toBe(true);
    }
    expect(MID).toBeGreaterThan(LOW);
  });
});
