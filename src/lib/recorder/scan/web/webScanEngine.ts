// webScanEngine — "Scan a document" in the PWA / browser. Same ScanEngine interface as the iOS one, so the rest of the
// app (capture offsets, queue, upload, cards) does not know which scanner produced the PDF.
//
// The scanner screen (WebScanner.svelte) is the DocScan web scanner: viewfinder with live edge detection, capture,
// perspective correction, enhancement, optional manual corner adjustment. Its pages become a PDF here, inside the
// 25 MB budget. pdf-lib is loaded only when a scan is finished (the iOS app never pays for it).

import { MAX_ATTACHMENT_BYTES } from '../../attachments/types';
import { prepareDocument } from '../../attachments/imagePrep';
import { ScanFailedError, ScanTooLargeError, type ScanEngine, type ScanOptions, type ScanResult } from '../scanEngine';
import type { QualityStep, ScannedPage } from './pdf.js';
import type { WebScannerHost } from './webScannerHost.js';

export interface WebScanDeps {
  getHost:  () => WebScannerHost | null;
  reencode: (page: ScannedPage, step: QualityStep) => Promise<ScannedPage>;
  /** Test seam for the lazily loaded PDF builder. */
  loadPdf?: () => Promise<typeof import('./pdf.js')>;
}

export function createWebScanEngine(deps: WebScanDeps): ScanEngine {
  return {
    id: 'web',

    async scan(opts: ScanOptions = {}): Promise<ScanResult | null> {
      const host = deps.getHost();
      if (!host) throw new ScanFailedError('The scanner screen is not available');

      const pages = await host.open();
      if (!pages || pages.length === 0) return null;                        // abandoned
      opts.onCaptured?.();                                                   // the scanner just closed: end_offset_ms is NOW

      const pdf = await (deps.loadPdf ?? (() => import('./pdf.js')))();
      const limit = opts.maxBytes ?? MAX_ATTACHMENT_BYTES;
      let built;
      try {
        built = await pdf.buildScanPdf(pages, { limitBytes: limit, reencode: deps.reencode });
      } catch (e) {
        if (e instanceof pdf.PdfTooLargeError) throw new ScanTooLargeError(e.bestBytes, e.limitBytes, e.pages);
        throw new ScanFailedError(e instanceof Error ? e.message : String(e));
      }

      // In memory, never file-backed (same rule as every document), with its SHA-256.
      const prepared = await prepareDocument(new Blob([built.bytes as BlobPart], { type: 'application/pdf' }));
      return {
        file:         prepared.blob,
        sha256:       prepared.sha256,
        pageCount:    built.pageCount,
        thumbnail:    pages[0]?.thumbnail ?? null,
        recompressed: built.recompressed,
      };
    },
  };
}

/** The scanner needs a camera stream, workers and canvas: present in current Safari / Chrome, absent elsewhere. */
export function webScanSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
    && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
}
