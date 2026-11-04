import { describe, it, expect, vi } from 'vitest';
import { createWebScanEngine } from './webScanEngine.js';
import { PdfTooLargeError, type ScannedPage } from './pdf.js';
import { ScanFailedError, ScanTooLargeError } from '../scanEngine';
import { JPEG_HIGH, JPEG_LOW } from './testing/jpegFixtures.js';
import { sha256Hex } from '../../attachments/imagePrep';

const jpeg = (b64: string) => new Blob([Uint8Array.from(Buffer.from(b64, 'base64'))], { type: 'image/jpeg' });
const page = (b64 = JPEG_HIGH, thumb = true): ScannedPage => ({ blob: jpeg(b64), width: 120, height: 160, ...(thumb ? { thumbnail: new Blob(['t'], { type: 'image/jpeg' }) } : {}) });
const reencode = vi.fn(async () => page(JPEG_LOW));

const engine = (open: () => Promise<ScannedPage[] | null>, extra: Partial<Parameters<typeof createWebScanEngine>[0]> = {}) =>
  createWebScanEngine({ getHost: () => ({ open }), reencode, ...extra });

describe('web scan engine', () => {
  it('turns the scanned pages into a PDF with its SHA-256, page count and the page-1 thumbnail', async () => {
    const pages = [page(), page(JPEG_LOW, false), page()];
    const r = (await engine(async () => pages).scan())!;
    expect(r.pageCount).toBe(3);
    expect(r.file.type).toBe('application/pdf');
    expect(r.recompressed).toBe(false);
    expect(await r.file.slice(0, 5).text()).toBe('%PDF-');
    expect(r.sha256).toBe(await sha256Hex(r.file));
    expect(r.thumbnail).toBe(pages[0]!.thumbnail);
  });

  it('abandoning (null or no page) resolves null and builds nothing', async () => {
    const loadPdf = vi.fn();
    expect(await engine(async () => null, { loadPdf: loadPdf as never }).scan()).toBeNull();
    expect(await engine(async () => [], { loadPdf: loadPdf as never }).scan()).toBeNull();
    expect(loadPdf).not.toHaveBeenCalled();
  });

  it('onCaptured fires when the scanner closes, BEFORE the PDF is built', async () => {
    const order: string[] = [];
    const e = engine(async () => [page()], { loadPdf: async () => { order.push('pdf'); return import('./pdf.js'); } });
    await e.scan({ onCaptured: () => order.push('captured') });
    expect(order).toEqual(['captured', 'pdf']);
  });

  it('a scan that cannot fit under the limit becomes ScanTooLargeError with the sizes', async () => {
    const err = await engine(async () => [page(), page()]).scan({ maxBytes: 3_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(ScanTooLargeError);
    expect(err).toMatchObject({ limitBytes: 3_000, pages: 2 });
    expect(err.bestBytes).toBeGreaterThan(3_000);
  });

  it('a PdfTooLargeError from the builder maps to ScanTooLargeError; any other builder failure to ScanFailedError', async () => {
    const tooLarge = engine(async () => [page()], { loadPdf: async () => ({ ...(await import('./pdf.js')), buildScanPdf: async () => { throw new PdfTooLargeError(31_000_000, 25_000_000, 40); } }) as never });
    await expect(tooLarge.scan()).rejects.toMatchObject({ name: 'ScanTooLargeError', bestBytes: 31_000_000, pages: 40 });
    const broken = engine(async () => [page()], { loadPdf: async () => ({ ...(await import('./pdf.js')), buildScanPdf: async () => { throw new Error('bad jpeg'); } }) as never });
    await expect(broken.scan()).rejects.toBeInstanceOf(ScanFailedError);
  });

  it('recompression is reported', async () => {
    const big = [page(), page()];
    const total = big.reduce((s, p) => s + p.blob.size, 0);
    const r = (await engine(async () => big).scan({ maxBytes: Math.round(total * 0.6) }))!;
    expect(r.recompressed).toBe(true);
    expect(reencode).toHaveBeenCalled();
  });

  it('without a mounted scanner screen it fails clearly instead of hanging', async () => {
    const e = createWebScanEngine({ getHost: () => null, reencode });
    await expect(e.scan()).rejects.toBeInstanceOf(ScanFailedError);
  });
});
