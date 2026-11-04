// pdf — multi-page PDF from the scanned pages (JPEG each), with the 25 MB budget.
//
// Same building blocks as DocScan (scanner-app, src/lib/pdf/export.ts): pdf-lib, every JPEG embedded as-is
// (embedJpg does not re-encode), page size from the pixel size at 200 DPI, producer in the info dictionary.
// Added for Pocket: the server limit. If the PDF is over it, the pages are re-encoded one rung lower on the same
// quality ladder the iOS plugin uses, until it fits; if even the last rung is over, PdfTooLargeError says by how much.

import { PDFDocument } from 'pdf-lib';

export interface ScannedPage {
  /** The processed page (rectified + enhanced), as JPEG. */
  blob:       Blob;
  width:      number;
  height:     number;
  /** Small preview (page 1's is the card in the attachment strip). */
  thumbnail?: Blob;
}

export interface QualityStep { maxPixels: number; quality: number }

/** First rung = the agreed default (2000 px, quality 0.8). Same ladder as ios/App/App/ScanPDF.swift. */
export const QUALITY_LADDER: readonly QualityStep[] = [
  { maxPixels: 2000, quality: 0.80 },
  { maxPixels: 2000, quality: 0.65 },
  { maxPixels: 1700, quality: 0.55 },
  { maxPixels: 1400, quality: 0.45 },
  { maxPixels: 1200, quality: 0.40 },
  { maxPixels: 1000, quality: 0.35 },
  { maxPixels:  800, quality: 0.30 },
];

export const PDF_DPI = 200;

export class PdfTooLargeError extends Error {
  constructor(public readonly bestBytes: number, public readonly limitBytes: number, public readonly pages: number) {
    super(`PDF of ${pages} page(s) is ${bestBytes} bytes at the lowest quality; the limit is ${limitBytes}`);
    this.name = 'PdfTooLargeError';
  }
}

export interface PdfBuildResult {
  bytes:        Uint8Array;
  pageCount:    number;
  step:         QualityStep;
  /** False when the first rung already fit. */
  recompressed: boolean;
}

export async function buildPdfFromJpegs(pages: readonly ScannedPage[], opts: { dpi?: number; title?: string } = {}): Promise<Uint8Array> {
  const dpi = opts.dpi ?? PDF_DPI;
  const pdf = await PDFDocument.create();
  if (opts.title) pdf.setTitle(opts.title);
  pdf.setProducer('Eigen Pocket');
  pdf.setCreationDate(new Date());
  for (const page of pages) {
    const img = await pdf.embedJpg(new Uint8Array(await page.blob.arrayBuffer()));
    const wPt = (img.width / dpi) * 72, hPt = (img.height / dpi) * 72;   // 1 pt = 1/72 inch
    pdf.addPage([wPt, hPt]).drawImage(img, { x: 0, y: 0, width: wPt, height: hPt });
  }
  return pdf.save();
}

export async function buildScanPdf(
  pages: readonly ScannedPage[],
  opts: {
    limitBytes: number;
    /** Re-encodes one page for a lower rung (canvas in the browser, a fake in tests). */
    reencode: (page: ScannedPage, step: QualityStep) => Promise<ScannedPage>;
    ladder?: readonly QualityStep[];
    title?: string;
    /** Test seam: lets a test observe which rungs actually reach the (slow) PDF writer. */
    build?: (pages: readonly ScannedPage[], o: { title?: string }) => Promise<Uint8Array>;
  },
): Promise<PdfBuildResult> {
  const ladder = opts.ladder ?? QUALITY_LADDER;
  if (pages.length === 0) throw new Error('A PDF needs at least one page');
  let best = Number.POSITIVE_INFINITY;
  let current: readonly ScannedPage[] = pages;

  for (const [n, step] of ladder.entries()) {
    if (n > 0) {
      const next: ScannedPage[] = [];
      for (const p of pages) next.push(await opts.reencode(p, step));      // from the ORIGINAL page, never from a re-encoded one
      current = next;
    }
    const payload = current.reduce((sum, p) => sum + p.blob.size, 0);
    if (payload > opts.limitBytes) { best = Math.min(best, payload); continue; }   // cannot fit: skip the (slower) PDF build
    const bytes = await (opts.build ?? buildPdfFromJpegs)(current, { title: opts.title });
    if (bytes.byteLength <= opts.limitBytes) return { bytes, pageCount: current.length, step, recompressed: n > 0 };
    best = Math.min(best, bytes.byteLength);
  }
  throw new PdfTooLargeError(best, opts.limitBytes, pages.length);
}
