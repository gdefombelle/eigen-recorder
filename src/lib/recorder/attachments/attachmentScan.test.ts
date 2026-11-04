import { describe, it, expect, vi } from 'vitest';
import { captureScan } from './attachmentScan';
import { AttachmentTooLargeError } from './attachmentApi';
import { ScanTooLargeError, ScanFailedError, type ScanEngine, type ScanResult } from '../scan/scanEngine';
import type { AddAttachmentInput } from './attachmentQueue';

const result = (over: Partial<ScanResult> = {}): ScanResult =>
  ({ file: new Blob(['%PDF-1.4'], { type: 'application/pdf' }), sha256: 'f'.repeat(64), pageCount: 4, thumbnail: new Blob(['j'], { type: 'image/jpeg' }), recompressed: false, ...over });

function setup(opts: { engine?: Partial<ScanEngine> & { scan?: ScanEngine['scan'] }; clock?: () => Promise<number>; queueAdd?: (i: AddAttachmentInput) => Promise<any> } = {}) {
  const added: AddAttachmentInput[] = [];
  const clock = { ms: 0 };
  const engine: ScanEngine = { id: 'native-ios', scan: opts.engine?.scan ?? (async (o) => { clock.ms = 46_000; o?.onCaptured?.(); clock.ms = 52_000; return result(); }) };
  const queue = { add: opts.queueAdd ?? (async (i: AddAttachmentInput) => { added.push(i); return { local_attachment_id: 'A1' } as any; }) };
  const deps = { engine, queue, getOffsetMs: opts.clock ?? (async () => clock.ms) };
  return { deps, added, clock };
}
const opts = { localSessionId: 'L1', startOffsetMs: 31_000, title: 'Scan 00:31' };

describe('captureScan', () => {
  it('queues a PDF document with provenance, page count and thumbnail', async () => {
    const { deps, added } = setup();
    const out = await captureScan(deps, opts);
    expect(out.status).toBe('added');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      localSessionId: 'L1', kind: 'document', mimeType: 'application/pdf', filename: 'scan-31000.pdf',
      title: 'Scan 00:31', captureSource: 'scan', pageCount: 4, sha256: 'f'.repeat(64),
    });
    expect(added[0].thumbnail).toBeInstanceOf(Blob);
    expect(added[0].file.type).toBe('application/pdf');
  });

  it('start offset is the one frozen at sheet opening; end offset is the clock when the scanner CLOSED, not when processing ended', async () => {
    const { deps, added, clock } = setup();
    await captureScan(deps, opts);
    expect(added[0].startOffsetMs).toBe(31_000);
    expect(added[0].endOffsetMs).toBe(46_000);          // the clock read at onCaptured…
    expect(clock.ms).toBe(52_000);                      // …not the later one (PDF built, file read)
  });

  it('an engine that never signals capture end: the end offset is read when the result arrives', async () => {
    const { deps, added } = setup({ engine: { scan: async () => result() }, clock: async () => 60_000 });
    await captureScan(deps, opts);
    expect(added[0].endOffsetMs).toBe(60_000);
  });

  it('an unreadable clock or an end before the start → no end offset (never a wrong one)', async () => {
    const a = setup({ clock: async () => { throw new Error('clock'); } });
    await captureScan(a.deps, opts);
    expect(a.added[0].endOffsetMs).toBeNull();
    const b = setup({ clock: async () => 100 });         // before the 31 s start
    await captureScan(b.deps, opts);
    expect(b.added[0].endOffsetMs).toBeNull();
  });

  it('cancel adds nothing', async () => {
    const { deps, added } = setup({ engine: { scan: async () => null } });
    expect(await captureScan(deps, opts)).toEqual({ status: 'cancelled' });
    expect(added).toHaveLength(0);
  });

  it('a scan too large even at the lowest quality is reported with its size, and nothing is queued', async () => {
    const { deps, added } = setup({ engine: { scan: async () => { throw new ScanTooLargeError(31_000_000, 25_000_000, 40); } } });
    expect(await captureScan(deps, opts)).toEqual({ status: 'error', reason: 'too_large', sizeBytes: 31_000_000 });
    expect(added).toHaveLength(0);
  });

  it('a failed scan is reported as failed', async () => {
    const { deps, added } = setup({ engine: { scan: async () => { throw new ScanFailedError('boom'); } } });
    expect(await captureScan(deps, opts)).toEqual({ status: 'error', reason: 'failed' });
    expect(added).toHaveLength(0);
  });

  it('queue refusing the size maps to too_large; any other storage error to storage_failed', async () => {
    const big = setup({ queueAdd: async () => { throw new AttachmentTooLargeError(26_000_000); } });
    expect(await captureScan(big.deps, opts)).toEqual({ status: 'error', reason: 'too_large', sizeBytes: 26_000_000 });
    const full = setup({ queueAdd: async () => { throw new Error('QuotaExceededError'); } });
    expect(await captureScan(full.deps, opts)).toEqual({ status: 'error', reason: 'storage_failed' });
  });

  it('a scan without thumbnail is still queued (no thumbnail field)', async () => {
    const { deps, added } = setup({ engine: { scan: async () => result({ thumbnail: null }) } });
    await captureScan(deps, opts);
    expect(added[0]).not.toHaveProperty('thumbnail');
  });

  it('reports whether the quality had to be reduced', async () => {
    const { deps } = setup({ engine: { scan: async () => result({ recompressed: true }) } });
    expect(await captureScan(deps, opts)).toMatchObject({ status: 'added', recompressed: true });
  });
});
