import { describe, it, expect, vi } from 'vitest';
import { createNativeScanEngine, getScanEngine, ScanTooLargeError, ScanFailedError, type NativeScannerPlugin, type NativeScanResponse } from './scanEngine';
import { sha256Hex } from '../attachments/imagePrep';

const PDF = new TextEncoder().encode('%PDF-1.4\n…binary…\n%%EOF\n');
const pdfBlob = (bytes: Uint8Array = PDF) => new Blob([bytes as BlobPart], { type: 'application/pdf' });
const response = (over: Partial<NativeScanResponse> = {}): NativeScanResponse =>
  ({ scanId: 'S1', pdfPath: 'file:///tmp/S1/scan.pdf', thumbnailPath: 'file:///tmp/S1/thumb.jpg', pageCount: 3, sizeBytes: PDF.byteLength, recompressed: false, ...over });

function harness(over: { scanToPdf?: NativeScannerPlugin['scanToPdf']; readFile?: (p: string) => Promise<Blob> } = {}) {
  const events: string[] = [];
  const removeListener = vi.fn();
  const cleanup = vi.fn(async (_o: { scanId: string }) => { events.push('cleanup'); });
  let capturedCb: (() => void) | null = null;
  const plugin: NativeScannerPlugin = {
    scanToPdf: over.scanToPdf ?? (async () => { events.push('scan'); capturedCb?.(); return response(); }),
    cleanup,
    addListener: async (_e, cb) => { capturedCb = cb; return { remove: removeListener }; },
  };
  const readFile = over.readFile ?? (async (p: string) => (p.endsWith('thumb.jpg') ? new Blob(['jpg'], { type: 'image/jpeg' }) : pdfBlob()));
  const reads: string[] = [];
  const engine = createNativeScanEngine({ plugin, readFile: async (p) => { reads.push(p); return readFile(p); } });
  return { engine, plugin, cleanup, removeListener, reads, events };
}

describe('native scan engine', () => {
  it('returns the PDF as an in-memory Blob with its SHA-256, the page count and the thumbnail', async () => {
    const h = harness();
    const r = (await h.engine.scan())!;
    expect(r.pageCount).toBe(3);
    expect(r.recompressed).toBe(false);
    expect(r.file.type).toBe('application/pdf');
    expect(r.file.size).toBe(PDF.byteLength);
    expect(r.sha256).toBe(await sha256Hex(pdfBlob()));
    expect(r.thumbnail?.type).toBe('image/jpeg');
    expect(h.reads).toEqual(['file:///tmp/S1/scan.pdf', 'file:///tmp/S1/thumb.jpg']);
  });

  it('asks the plugin for the 25 MB budget by default and passes a custom one through', async () => {
    const scanToPdf = vi.fn(async () => response());
    await harness({ scanToPdf }).engine.scan();
    expect(scanToPdf).toHaveBeenCalledWith({ maxBytes: 25_000_000 });
    const custom = vi.fn(async () => response());
    await harness({ scanToPdf: custom }).engine.scan({ maxBytes: 10_000_000 });
    expect(custom).toHaveBeenCalledWith({ maxBytes: 10_000_000 });
  });

  it('cleans the temp directory after the files were read — success', async () => {
    const h = harness();
    await h.engine.scan({ onCaptured: () => {} });
    expect(h.cleanup).toHaveBeenCalledExactlyOnceWith({ scanId: 'S1' });
    expect(h.removeListener).toHaveBeenCalledOnce();     // the event listener never leaks either
  });

  it('cleans up even when reading the PDF fails', async () => {
    const h = harness({ readFile: async () => { throw new Error('404'); } });
    await expect(h.engine.scan()).rejects.toThrow(ScanFailedError);
    expect(h.cleanup).toHaveBeenCalledExactlyOnceWith({ scanId: 'S1' });
  });

  it('refuses a PDF whose size differs from what the native side wrote (incomplete read), and still cleans up', async () => {
    const h = harness({ scanToPdf: async () => response({ sizeBytes: PDF.byteLength + 500 }) });
    await expect(h.engine.scan()).rejects.toThrow(/incompletely/);
    expect(h.cleanup).toHaveBeenCalledOnce();
  });

  it('refuses a file that is not a PDF', async () => {
    const junk = new TextEncoder().encode('<html>404 not found</html>'.padEnd(PDF.byteLength, ' '));
    const h = harness({ readFile: async () => new Blob([junk]), scanToPdf: async () => response({ sizeBytes: junk.byteLength }) });
    await expect(h.engine.scan()).rejects.toThrow(/not a PDF/);
    expect(h.cleanup).toHaveBeenCalledOnce();
  });

  it('a missing thumbnail never loses the scan', async () => {
    const h = harness({ readFile: async (p) => { if (p.endsWith('thumb.jpg')) throw new Error('gone'); return pdfBlob(); } });
    const r = (await h.engine.scan())!;
    expect(r.thumbnail).toBeNull();
    expect(r.pageCount).toBe(3);
  });

  it('no thumbnail path → null thumbnail, nothing read for it', async () => {
    const h = harness({ scanToPdf: async () => response({ thumbnailPath: undefined }) });
    expect((await h.engine.scan())!.thumbnail).toBeNull();
    expect(h.reads).toEqual(['file:///tmp/S1/scan.pdf']);
  });

  it('cancel resolves null (no error), nothing to clean', async () => {
    const h = harness({ scanToPdf: async () => { throw Object.assign(new Error('Cancelled'), { code: 'cancelled' }); } });
    expect(await h.engine.scan()).toBeNull();
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(h.removeListener).not.toHaveBeenCalled();     // no listener was requested
  });

  it('the legacy "Cancelled" message alone is also a cancel', async () => {
    const h = harness({ scanToPdf: async () => { throw new Error('Cancelled'); } });
    expect(await h.engine.scan()).toBeNull();
  });

  it('too_large carries best size, limit and pages', async () => {
    const h = harness({ scanToPdf: async () => { throw Object.assign(new Error('x'), { code: 'too_large', data: { bestBytes: 31_000_000, limitBytes: 25_000_000, pages: 40 } }); } });
    const err = await h.engine.scan().catch((e) => e);
    expect(err).toBeInstanceOf(ScanTooLargeError);
    expect(err).toMatchObject({ bestBytes: 31_000_000, limitBytes: 25_000_000, pages: 40 });
  });

  it('any other native failure is a ScanFailedError with its message', async () => {
    const h = harness({ scanToPdf: async () => { throw Object.assign(new Error('disk full'), { code: 'write_failed' }); } });
    await expect(h.engine.scan()).rejects.toThrow('disk full');
    await expect(harness({ scanToPdf: async () => { throw new Error('boom'); } }).engine.scan()).rejects.toBeInstanceOf(ScanFailedError);
  });

  it('onCaptured fires when the scanner closes, BEFORE the PDF is read', async () => {
    const order: string[] = [];
    const h = harness({ readFile: async () => { order.push('read'); return pdfBlob(); } });
    await h.engine.scan({ onCaptured: () => order.push('captured') });
    expect(order[0]).toBe('captured');
    expect(order.indexOf('captured')).toBeLessThan(order.indexOf('read'));
  });

  it('works when the event listener cannot be registered', async () => {
    const h = harness();
    h.plugin.addListener = async () => { throw new Error('no listener'); };
    expect(await h.engine.scan({ onCaptured: () => {} })).not.toBeNull();
  });
});

describe('getScanEngine — which scanner, where', () => {
  it('the native iOS scanner in the app, whatever the browser could do', () => {
    expect(getScanEngine(() => true, () => true)?.id).toBe('native-ios');
    expect(getScanEngine(() => true, () => false)?.id).toBe('native-ios');
  });
  it('the DocScan web scanner in a browser that has camera, workers and canvas', () => {
    expect(getScanEngine(() => false, () => true)?.id).toBe('web');
  });
  it('no scanner (the sheet hides the entry) where the browser cannot do it', () => {
    expect(getScanEngine(() => false, () => false)).toBeNull();
  });
  it('with no argument in Node (no camera API) there is none', () => {
    expect(getScanEngine(() => false)).toBeNull();
  });
});
