import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPreparePhoto = vi.fn();
const mockPrepareDocument = vi.fn();
vi.mock('./imagePrep', () => ({
  preparePhoto: (...a: unknown[]) => mockPreparePhoto(...a),
  prepareDocument: (...a: unknown[]) => mockPrepareDocument(...a),
}));
vi.mock('$lib/auth/api', async () => {
  const actual = await vi.importActual<typeof import('$lib/auth/api')>('$lib/auth/api');
  return { ...actual, request: vi.fn(), uploadMultipart: vi.fn() };
});

import { addCaptured, documentExtension, type CapturedFile } from './attachmentCapture';
import { AttachmentTooLargeError } from './attachmentApi';
import type { AddAttachmentInput } from './attachmentQueue';
import type { LocalAttachment } from './localTypes';

let added: AddAttachmentInput[];
const queue = {
  add: vi.fn(async (i: AddAttachmentInput) => { added.push(i); return { local_attachment_id: `id-${added.length}`, ...i } as unknown as LocalAttachment; }),
};
const titleFor = () => 'Photo 00:46';

const photo = (name = 'x.heic'): CapturedFile => ({ blob: new Blob(['raw']), filename: name, kind: 'photo' });
const doc = (name: string): CapturedFile => ({ blob: new Blob(['doc'], { type: 'application/pdf' }), filename: name, kind: 'document' });

beforeEach(() => {
  added = [];
  queue.add.mockClear();
  mockPreparePhoto.mockReset().mockImplementation(async () => ({ blob: new Blob(['jpg'], { type: 'image/jpeg' }), sha256: 'h'.repeat(64) }));
  mockPrepareDocument.mockReset().mockImplementation(async (b: Blob) => ({ blob: b, sha256: 'd'.repeat(64) }));
});

describe('addCaptured', () => {
  it('multi-selection: every file is queued separately with the SAME offset (the one captured when the sheet opened)', async () => {
    const r = await addCaptured(queue, { localSessionId: 'l1', offsetMs: 46_300, files: [photo('a.jpg'), photo('b.jpg'), doc('devis.pdf')], titleFor });

    expect(r.errors).toEqual([]);
    expect(added).toHaveLength(3);
    expect(added.map((a) => a.startOffsetMs)).toEqual([46_300, 46_300, 46_300]);
    expect(added.every((a) => a.localSessionId === 'l1')).toBe(true);
  });

  it('photos are re-encoded (JPEG, hash of the bytes sent); documents go through untouched', async () => {
    await addCaptured(queue, { localSessionId: 'l1', offsetMs: 1_000, files: [photo(), doc('devis-piano.pdf')], titleFor });

    expect(mockPreparePhoto).toHaveBeenCalledTimes(1);
    expect(added[0]).toMatchObject({ kind: 'photo', mimeType: 'image/jpeg', sha256: 'h'.repeat(64), title: 'Photo 00:46', filename: 'photo-1000.jpg' });
    expect(mockPrepareDocument).toHaveBeenCalledTimes(1);
    expect(added[1]).toMatchObject({ kind: 'document', mimeType: 'application/pdf', sha256: 'd'.repeat(64), title: 'devis-piano', filename: 'devis-piano.pdf' });
    expect(added[1].file).toBeInstanceOf(Blob);
  });

  it('one bad file does not stop the others, and is reported by reason', async () => {
    mockPreparePhoto.mockRejectedValueOnce(new Error('cannot decode'));
    queue.add.mockRejectedValueOnce(new AttachmentTooLargeError(30_000_000));

    const r = await addCaptured(queue, {
      localSessionId: 'l1', offsetMs: 0, titleFor,
      files: [photo('broken.heic'), doc('huge.pdf'), doc('notes.txt'), doc('ok.docx')],
    });

    expect(r.errors).toEqual([
      { filename: 'broken.heic', reason: 'prepare_failed' },
      { filename: 'huge.pdf', reason: 'too_large' },
      { filename: 'notes.txt', reason: 'unsupported' },
    ]);
    expect(r.added).toHaveLength(1);
    expect(added.at(-1)?.filename).toBe('ok.docx');
  });

  it('a storage failure is reported, not thrown (adding must never break the recording screen)', async () => {
    queue.add.mockRejectedValueOnce(new Error('QuotaExceededError'));
    const r = await addCaptured(queue, { localSessionId: 'l1', offsetMs: 0, files: [doc('a.pdf')], titleFor });
    expect(r.errors).toEqual([{ filename: 'a.pdf', reason: 'storage_failed' }]);
  });
});

describe('documentExtension', () => {
  it.each([['a.PDF', 'pdf'], ['b.docx', 'docx'], ['c.xlsx', 'xlsx'], ['d.pptx', 'pptx']])('%s accepted', (n, e) => expect(documentExtension(n)).toBe(e));
  it.each([['e.txt'], ['f.exe'], ['noext'], ['g.pdf.zip']])('%s rejected', (n) => expect(documentExtension(n)).toBeNull());
});
