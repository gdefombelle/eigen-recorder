/**
 * Contract tests for the attachments API layer.
 *
 * Retry policy under test (decided with the product owner): automatic retry
 * ONLY for network failures, 5xx and 429. 400/403/404/413/422 fail straight
 * to a manual-retry state — an automatic loop on those would hammer the
 * server forever for a request that can never succeed.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('$lib/auth/api', async () => {
  const actual = await vi.importActual<typeof import('$lib/auth/api')>('$lib/auth/api');
  return { ...actual, request: vi.fn(), uploadMultipart: vi.fn() };
});

import { request, uploadMultipart, ApiError, UploadAbortedError } from '$lib/auth/api';
import { httpAttachmentApi, classifyAttachmentError, AttachmentTooLargeError, getAttachmentApi, setAttachmentApi } from './attachmentApi';
import { MockAttachmentApi } from './mockAttachmentApi';
import { MAX_ATTACHMENT_BYTES, type UploadAttachmentInput } from './types';

const mockRequest = request as ReturnType<typeof vi.fn>;
const mockUpload  = uploadMultipart as ReturnType<typeof vi.fn>;

afterEach(() => vi.clearAllMocks());

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';

function input(over: Partial<UploadAttachmentInput> = {}): UploadAttachmentInput {
  return {
    sessionId: 'sess-1',
    file: new Blob(['jpegbytes'], { type: 'image/jpeg' }),
    filename: 'photo.jpg',
    clientAttachmentId: CLIENT_ID,
    startOffsetMs: 10_400,
    sha256: 'a'.repeat(64),
    title: 'Whiteboard',
    ...over,
  };
}

describe('classifyAttachmentError — retry policy', () => {
  it.each([[0], [500], [502], [503], [429]])('status %i → transient (auto retry)', (status) => {
    const retriable = status === 0 || status >= 500 || status === 429;
    expect(classifyAttachmentError(new ApiError(status, 'x', retriable)).kind).toBe('transient');
  });

  it.each([[400], [403], [404], [413], [422]])('status %i → permanent (manual retry only)', (status) => {
    expect(classifyAttachmentError(new ApiError(status, 'x', false)).kind).toBe('permanent');
  });

  it('401 that survived the silent refresh → permanent, not a loop', () => {
    expect(classifyAttachmentError(new ApiError(401, 'x', false)).kind).toBe('permanent');
  });

  it('409 + code session_cancelled → session_cancelled (definitive)', () => {
    expect(classifyAttachmentError(new ApiError(409, 'cancelled', false, 'session_cancelled')).kind).toBe('session_cancelled');
  });

  it('any other 409 → permanent, never mistaken for a cancelled session', () => {
    expect(classifyAttachmentError(new ApiError(409, 'Only failed attachments can be retried', false)).kind).toBe('permanent');
  });

  it('user cancel → aborted, never a failure', () => {
    expect(classifyAttachmentError(new UploadAbortedError()).kind).toBe('aborted');
  });

  it('unknown errors are not retried blindly', () => {
    expect(classifyAttachmentError(new TypeError('boom')).kind).toBe('permanent');
  });
});

describe('httpAttachmentApi.upload — wire format', () => {
  it('sends exactly the fields the backend form expects', async () => {
    mockUpload.mockResolvedValueOnce({ attachment_id: 'a1' });

    await httpAttachmentApi.upload(input({ endOffsetMs: 12_000 }));

    const [path, form] = mockUpload.mock.calls[0] as [string, FormData];
    expect(path).toBe('/knowledge-sessions/sess-1/attachments');
    expect(form.get('client_attachment_id')).toBe(CLIENT_ID);
    expect(form.get('start_offset_ms')).toBe('10400');
    expect(form.get('end_offset_ms')).toBe('12000');
    expect(form.get('sha256')).toBe('a'.repeat(64));
    expect(form.get('title')).toBe('Whiteboard');
    expect((form.get('file') as File).name).toBe('photo.jpg');
  });

  it('omits end_offset_ms when absent and rounds/clamps start to a non-negative integer', async () => {
    mockUpload.mockResolvedValueOnce({});

    await httpAttachmentApi.upload(input({ startOffsetMs: -3.7 }));

    const form = mockUpload.mock.calls[0][1] as FormData;
    expect(form.has('end_offset_ms')).toBe(false);
    expect(form.get('start_offset_ms')).toBe('0');
  });

  it('refuses a file over the server limit without any network call', async () => {
    const big = { size: MAX_ATTACHMENT_BYTES + 1, type: 'application/pdf' } as unknown as Blob;
    await expect(httpAttachmentApi.upload(input({ file: big }))).rejects.toBeInstanceOf(AttachmentTooLargeError);
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

describe('httpAttachmentApi.upload — multipart construction, photo vs document', () => {
  const build = async (over: Partial<UploadAttachmentInput>) => {
    mockUpload.mockResolvedValueOnce({});
    await httpAttachmentApi.upload(input(over));
    return mockUpload.mock.calls.at(-1)![1] as FormData;
  };

  it('a photo and a document carry the same fields, in the same order, with the file LAST', async () => {
    const photo = await build({ file: new Blob(['jpg'], { type: 'image/jpeg' }), filename: 'photo-1000.jpg' });
    const doc = await build({ file: new Blob(['%PDF'], { type: 'application/pdf' }), filename: 'devis piano.pdf' });
    const expected = ['client_attachment_id', 'start_offset_ms', 'sha256', 'title', 'file'];
    expect([...photo.keys()]).toEqual(expected);
    expect([...doc.keys()]).toEqual(expected);
  });

  it('a document whose MIME type is empty (iOS picker) still gets its name; the type falls back to what the platform sends', async () => {
    const doc = await build({ file: new Blob(['%PDF'], { type: '' }), filename: 'Devis piano – n°12 é.pdf' });
    const part = doc.get('file') as File;
    expect(part.name).toBe('Devis piano – n°12 é.pdf');
    expect(doc.get('client_attachment_id')).toBe(CLIENT_ID);
    expect(doc.get('start_offset_ms')).toBe('10400');
  });
});

describe('httpAttachmentApi.upload — request summary for diagnostics', () => {
  it('describes the file (name, MIME — "(empty)" when the iOS picker gives none — and size) and the fields sent', async () => {
    mockUpload.mockResolvedValueOnce({});
    await httpAttachmentApi.upload(input({ file: new Blob(['%PDF-1.4'], { type: '' }), filename: 'devis piano.pdf', endOffsetMs: 12_000 }));
    const opts = mockUpload.mock.calls[0][2] as { sent: string };
    expect(opts.sent).toBe('file "devis piano.pdf" type=(empty) size=8B; fields=client_attachment_id,start_offset_ms,end_offset_ms,sha256,title');
  });
});

describe('httpAttachmentApi — other endpoints', () => {
  it('list unwraps { attachments }', async () => {
    mockRequest.mockResolvedValueOnce({ session_id: 's', attachments: [{ attachment_id: 'a' }] });
    expect(await httpAttachmentApi.list('sess-1')).toEqual([{ attachment_id: 'a' }]);
  });

  it('update PATCHes only the provided fields', async () => {
    mockRequest.mockResolvedValueOnce({});
    await httpAttachmentApi.update('sess-1', 'att-1', { title: 'New' });
    expect(mockRequest).toHaveBeenCalledWith('/knowledge-sessions/sess-1/attachments/att-1', {
      method: 'PATCH',
      body: JSON.stringify({ title: 'New' }),
    });
  });

  it('remove issues DELETE and resolves void', async () => {
    mockRequest.mockResolvedValueOnce({ removed: true });
    await expect(httpAttachmentApi.remove('sess-1', 'att-1')).resolves.toBeUndefined();
    expect(mockRequest).toHaveBeenCalledWith('/knowledge-sessions/sess-1/attachments/att-1', { method: 'DELETE' });
  });

  it('retry POSTs to /retry', async () => {
    mockRequest.mockResolvedValueOnce({});
    await httpAttachmentApi.retry('sess-1', 'att-1');
    expect(mockRequest).toHaveBeenCalledWith('/knowledge-sessions/sess-1/attachments/att-1/retry', { method: 'POST' });
  });
});

describe('MockAttachmentApi — mirrors the server', () => {
  it('is idempotent on client_attachment_id: a retry returns the same record, no duplicate', async () => {
    const api = new MockAttachmentApi();
    const first = await api.upload(input());
    const second = await api.upload(input());

    expect(second.attachment_id).toBe(first.attachment_id);
    expect(await api.list('sess-1')).toHaveLength(1);
  });

  it('reports progress up to 1', async () => {
    const api = new MockAttachmentApi({ steps: 4 });
    const seen: number[] = [];
    await api.upload(input(), { onProgress: (f) => seen.push(f) });
    expect(seen).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it('a transient failure injected mid-upload leaves no record; the retry then succeeds once', async () => {
    const api = new MockAttachmentApi();
    api.failNext(503);

    const err = await api.upload(input()).catch((e) => e);
    expect(classifyAttachmentError(err).kind).toBe('transient');
    expect(await api.list('sess-1')).toHaveLength(0);

    await api.upload(input());
    expect(await api.list('sess-1')).toHaveLength(1);
    expect(api.uploadAttempts).toBe(2);
  });

  it('a CLOSED session still accepts upload, update and delete', async () => {
    const api = new MockAttachmentApi();
    api.setSessionState('sess-1', 'closed');

    const rec = await api.upload(input());
    await api.update('sess-1', rec.attachment_id, { title: 'x' });
    await api.remove('sess-1', rec.attachment_id);
    expect(await api.list('sess-1')).toHaveLength(0);
  });

  it('a CANCELLED session answers 409 session_cancelled on upload, update and delete', async () => {
    const api = new MockAttachmentApi();
    const rec = await api.upload(input());
    api.setSessionState('sess-1', 'cancelled');

    for (const call of [
      () => api.upload(input({ clientAttachmentId: '22222222-2222-4222-8222-222222222222' })),
      () => api.update('sess-1', rec.attachment_id, { title: 'x' }),
      () => api.remove('sess-1', rec.attachment_id),
    ]) {
      const e = await call().catch((x) => x);
      expect(classifyAttachmentError(e).kind).toBe('session_cancelled');
    }
  });

  it('aborting mid-upload throws aborted and stores nothing', async () => {
    const api = new MockAttachmentApi({ steps: 4 });
    const ac = new AbortController();
    const err = await api.upload(input(), { signal: ac.signal, onProgress: (f) => { if (f >= 0.5) ac.abort(); } }).catch((e) => e);

    expect(classifyAttachmentError(err).kind).toBe('aborted');
    expect(await api.list('sess-1')).toHaveLength(0);
  });

  it('validates offsets like the server (end >= start → 422, permanent)', async () => {
    const api = new MockAttachmentApi();
    const err = await api.upload(input({ startOffsetMs: 5000, endOffsetMs: 1000 })).catch((e) => e);
    expect(classifyAttachmentError(err)).toMatchObject({ kind: 'permanent', status: 422 });
  });

  it('lists by timeline order and hides soft-deleted rows', async () => {
    const api = new MockAttachmentApi();
    const a = await api.upload(input({ clientAttachmentId: 'c-a', startOffsetMs: 30_000 }));
    await api.upload(input({ clientAttachmentId: 'c-b', startOffsetMs: 5_000 }));
    await api.remove('sess-1', a.attachment_id);

    const list = await api.list('sess-1');
    expect(list.map((r) => r.start_offset_ms)).toEqual([5_000]);
  });
});


describe('implementation switch', () => {
  it('uses the real HTTP client unless VITE_ATTACHMENTS_MOCK=true (the backend is deployed)', async () => {
    setAttachmentApi(null);
    expect(import.meta.env.VITE_ATTACHMENTS_MOCK).not.toBe('true');
    expect(await getAttachmentApi()).toBe(httpAttachmentApi);
  });
});
