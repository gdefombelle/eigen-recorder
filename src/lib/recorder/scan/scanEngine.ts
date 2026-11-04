// scanEngine — the single interface the UI talks to for "Scan a document".
//
//   native iOS : DocumentScannerPlugin.scanToPdf — VisionKit in an isolated UIWindow, the PDF is assembled natively
//                into the temp directory, only file paths cross the bridge.
//   web / PWA  : no engine in V1 (getScanEngine() returns null and the sheet hides the entry). Opening the camera
//                from a PWA can suspend the page and cut the microphone; that has not been verified, so it is not offered.
//
// Everything platform-specific is injected, so the flow (read, verify, ALWAYS clean up) is tested without a device.

import { isNative } from '$lib/platform';
import { MAX_ATTACHMENT_BYTES } from '../attachments/types';
import { prepareDocument } from '../attachments/imagePrep';
import { isScanEnabled } from './scanSetting';

export interface ScanResult {
  /** The PDF, as an in-memory Blob (never file-backed) with its SHA-256. */
  file:         Blob;
  sha256:       string;
  pageCount:    number;
  /** Page-1 preview (small JPEG), null if the native side could not produce one. */
  thumbnail:    Blob | null;
  /** True when the 25 MB budget forced a lower quality than the default. */
  recompressed: boolean;
}

export interface ScanOptions {
  /** Fired the moment the scanner closes (before the PDF is built) — the instant `end_offset_ms` refers to. */
  onCaptured?: () => void;
  maxBytes?:   number;
}

export interface ScanEngine {
  readonly id: 'native-ios';
  /** Resolves to null when the user cancels. Rejects with ScanTooLargeError / ScanFailedError. */
  scan(opts?: ScanOptions): Promise<ScanResult | null>;
}

export class ScanTooLargeError extends Error {
  constructor(public readonly bestBytes: number, public readonly limitBytes: number, public readonly pages: number) {
    super(`Scan of ${pages} page(s) is ${bestBytes} bytes at the lowest quality; the limit is ${limitBytes}`);
    this.name = 'ScanTooLargeError';
  }
}

export class ScanFailedError extends Error {
  constructor(message: string) { super(message); this.name = 'ScanFailedError'; }
}

// ── Native implementation ──────────────────────────────────────────────────

export interface NativeScanResponse {
  scanId:        string;
  pdfPath:       string;
  thumbnailPath?: string;
  pageCount:     number;
  sizeBytes:     number;
  recompressed:  boolean;
}

export interface NativeScannerPlugin {
  scanToPdf(opts: { maxBytes: number }): Promise<NativeScanResponse>;
  cleanup(opts: { scanId: string }): Promise<void>;
  addListener(event: 'scanCaptured', cb: () => void): Promise<{ remove(): Promise<void> | void }>;
}

export interface NativeScanDeps {
  plugin:    NativeScannerPlugin;
  /** Reads a path the plugin returned (the WebView's file handler). */
  readFile:  (path: string) => Promise<Blob>;
}

const PDF_MAGIC = '%PDF-';

export function createNativeScanEngine(deps: NativeScanDeps): ScanEngine {
  return {
    id: 'native-ios',

    async scan(opts: ScanOptions = {}): Promise<ScanResult | null> {
      let listener: { remove(): Promise<void> | void } | null = null;
      let scanId: string | null = null;
      try {
        if (opts.onCaptured) listener = await deps.plugin.addListener('scanCaptured', opts.onCaptured).catch(() => null);

        let res: NativeScanResponse;
        try {
          res = await deps.plugin.scanToPdf({ maxBytes: opts.maxBytes ?? MAX_ATTACHMENT_BYTES });
        } catch (e) {
          const err = e as { code?: string; message?: string; data?: { bestBytes?: number; limitBytes?: number; pages?: number } };
          if (err.code === 'cancelled' || err.message === 'Cancelled') return null;
          if (err.code === 'empty') return null;
          if (err.code === 'too_large') throw new ScanTooLargeError(err.data?.bestBytes ?? 0, err.data?.limitBytes ?? MAX_ATTACHMENT_BYTES, err.data?.pages ?? 0);
          throw new ScanFailedError(err.message ?? 'Scan failed');
        }
        scanId = res.scanId;

        // Read the bytes NOW into memory (a file-backed Blob over a temp path is exactly what broke PDF uploads before),
        // then verify them against what the native side says it wrote.
        let raw: Blob;
        try { raw = await deps.readFile(res.pdfPath); }
        catch (e) { throw new ScanFailedError(`Cannot read the scanned PDF: ${e instanceof Error ? e.message : String(e)}`); }
        const prepared = await prepareDocument(new Blob([raw], { type: 'application/pdf' }));
        if (prepared.blob.size !== res.sizeBytes) {
          throw new ScanFailedError(`The scanned PDF was read incompletely (${prepared.blob.size} of ${res.sizeBytes} bytes)`);
        }
        const head = await prepared.blob.slice(0, PDF_MAGIC.length).text();
        if (head !== PDF_MAGIC) throw new ScanFailedError('The scanned file is not a PDF');
        if (prepared.blob.size > MAX_ATTACHMENT_BYTES) throw new ScanTooLargeError(prepared.blob.size, MAX_ATTACHMENT_BYTES, res.pageCount);

        let thumbnail: Blob | null = null;
        if (res.thumbnailPath) {
          try { thumbnail = new Blob([await (await deps.readFile(res.thumbnailPath)).arrayBuffer()], { type: 'image/jpeg' }); }
          catch { thumbnail = null; }      // a missing preview must never lose the scan
        }

        return { file: prepared.blob, sha256: prepared.sha256, pageCount: res.pageCount, thumbnail, recompressed: res.recompressed };
      } finally {
        // Systematic: success, cancel, error — the temp directory never outlives the call.
        if (scanId) { try { await deps.plugin.cleanup({ scanId }); } catch { /* the 1 h sweep catches leftovers */ } }
        try { await listener?.remove(); } catch { /* ignore */ }
      }
    },
  };
}

/**
 * The engine for this platform, or null when scanning is not offered: the PWA / web, Android, or the user has not
 * switched on Réglages → Diagnostics → « Scanner un document (expérimental) » (off by default).
 */
export function getScanEngine(enabled: boolean = isScanEnabled(), native: () => boolean = isNative): ScanEngine | null {
  if (!enabled || !native()) return null;
  return nativeEngine();
}

let _native: ScanEngine | null = null;
function nativeEngine(): ScanEngine {
  if (_native) return _native;
  _native = {
    id: 'native-ios',
    async scan(opts) {
      const { registerPlugin } = await import('@capacitor/core');
      const plugin = registerPlugin<NativeScannerPlugin>('DocumentScannerPlugin');
      return createNativeScanEngine({ plugin, readFile: async (path) => (await fetch(path)).blob() }).scan(opts);
    },
  };
  return _native;
}
