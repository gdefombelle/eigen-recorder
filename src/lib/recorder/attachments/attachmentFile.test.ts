import { describe, it, expect, vi, beforeEach } from 'vitest';

let native = false;
vi.mock('$lib/platform', () => ({ isNative: () => native }));
const writeFile = vi.fn(), getUri = vi.fn(), deleteFile = vi.fn(), share = vi.fn();
vi.mock('@capacitor/filesystem', () => ({
  Filesystem: { writeFile: (...a: unknown[]) => writeFile(...a), getUri: (...a: unknown[]) => getUri(...a), deleteFile: (...a: unknown[]) => deleteFile(...a) },
  Directory: { Cache: 'CACHE' },
}));
vi.mock('@capacitor/share', () => ({ Share: { share: (...a: unknown[]) => share(...a) } }));

import { attachmentFilename, fetchAttachmentBlob, openDocument } from './attachmentFile';
import { MockAttachmentApi } from './mockAttachmentApi';
import type { AttachmentRecord } from './types';

beforeEach(() => {
  native = false;
  writeFile.mockReset().mockResolvedValue(undefined);
  getUri.mockReset().mockResolvedValue({ uri: 'file:///cache/x.pdf' });
  deleteFile.mockReset().mockResolvedValue(undefined);
  share.mockReset().mockResolvedValue(undefined);
});

describe('attachmentFilename', () => {
  it('rebuilds the extension from the MIME type (the server stores the title as the file name)', () => {
    expect(attachmentFilename('devis-piano', 'application/pdf')).toBe('devis-piano.pdf');
    expect(attachmentFilename('Budget', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; charset=x')).toBe('Budget.xlsx');
  });
  it('does not double an extension that is already there', () => {
    expect(attachmentFilename('devis.pdf', 'application/pdf')).toBe('devis.pdf');
  });
  it('strips path separators and falls back when empty', () => {
    expect(attachmentFilename('a/b\\c', 'application/pdf')).toBe('a_b_c.pdf');
    expect(attachmentFilename('', null)).toBe('attachment');
  });
});

describe('fetchAttachmentBlob', () => {
  const record = { attachment_id: 'srv-1', client_attachment_id: 'cli-1', stored_file: { content_type: 'application/pdf' } } as AttachmentRecord;

  it('prefers the copy on this device — no download', async () => {
    const api = new MockAttachmentApi(); const dl = vi.spyOn(api, 'download');
    const local = new Blob(['local']);
    expect(await fetchAttachmentBlob({ getLocalBlob: async () => local, api }, 's', record)).toBe(local);
    expect(dl).not.toHaveBeenCalled();
  });

  it('otherwise downloads from the server, passing the MIME type (native transport returns untyped bytes)', async () => {
    const api = new MockAttachmentApi(); const remote = new Blob(['remote']);
    const dl = vi.spyOn(api, 'download').mockResolvedValue(remote);
    expect(await fetchAttachmentBlob({ getLocalBlob: async () => undefined, api }, 's', record)).toBe(remote);
    expect(dl).toHaveBeenCalledWith('s', 'srv-1', 'application/pdf');
  });
});

describe('fetchAttachmentBlob — photos', () => {
  it('asks for image/jpeg when the server gave no content type (our photos are always JPEG; the native transport needs a type to build the Blob)', async () => {
    const api = new MockAttachmentApi(); const dl = vi.spyOn(api, 'download').mockResolvedValue(new Blob(['x']));
    await fetchAttachmentBlob({ getLocalBlob: async () => undefined, api }, 's', { attachment_id: 'a', client_attachment_id: 'c', kind: 'photo' } as AttachmentRecord);
    expect(dl).toHaveBeenCalledWith('s', 'a', 'image/jpeg');
  });
});

describe('openDocument', () => {
  it('native: writes to the cache, opens the share sheet, then deletes the temp file', async () => {
    native = true;
    expect(await openDocument(new Blob(['pdf'], { type: 'application/pdf' }), 'devis.pdf')).toBe('shared');
    expect(writeFile).toHaveBeenCalledWith(expect.objectContaining({ directory: 'CACHE', data: expect.any(String) }));
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: 'file:///cache/x.pdf', title: 'devis.pdf' }));
    expect(deleteFile).toHaveBeenCalledTimes(1);
  });

  it('native: the base64 payload is the exact file, including past the 32 KB chunk boundary', async () => {
    native = true;
    const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 7) % 256);
    await openDocument(new Blob([bytes]), 'big.pdf');
    const sent = Uint8Array.from(atob(writeFile.mock.calls[0][0].data as string), (c) => c.charCodeAt(0));
    expect(sent.length).toBe(70_000);
    expect(sent.every((b, i) => b === bytes[i])).toBe(true);
  });

  it('native: a dismissed/failed share is not an error and still cleans up', async () => {
    native = true;
    share.mockRejectedValueOnce(new Error('dismissed'));
    expect(await openDocument(new Blob(['x']), 'a.pdf')).toBe('cancelled');
    expect(deleteFile).toHaveBeenCalledTimes(1);
  });

  it('native: nothing to clean when the write itself failed', async () => {
    native = true;
    writeFile.mockRejectedValueOnce(new Error('disk full'));
    expect(await openDocument(new Blob(['x']), 'a.pdf')).toBe('cancelled');
    expect(deleteFile).not.toHaveBeenCalled();
  });
});
