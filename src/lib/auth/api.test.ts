/**
 * Tests for api.ts transport.
 *
 * Regression guard for the infinite-spinner bug: request() always used
 * fetch(), even on native iOS. fetch() can hang forever with no error when
 * WKWebView's WebProcess is suspended (the same risk pkceFlow.ts already
 * documents and works around for the token exchange) — a hung fetch never
 * resolves nor rejects, so Promise.allSettled callers like the session-content
 * workspace spin forever with no way to recover.
 *
 * Fix: native builds route JSON requests through CapacitorHttp, and every
 * transport gets an explicit timeout so a stuck request eventually fails
 * with a retriable ApiError(0) instead of hanging indefinitely.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let _native = false;
vi.mock('$lib/platform', () => ({ isNative: () => _native }));

let _mockUser: { token: string } | null = { token: 'evtxa_test' };
vi.mock('./auth', () => ({
  getUser: vi.fn(() => _mockUser),
}));

vi.mock('./config', () => ({
  getApiBase:       () => 'https://api.eigenvertex.com/v1',
  getDirectApiBase: () => 'https://api.eigenvertex.com/v1',
}));

// pkceFlow is imported lazily inside api.ts to avoid a circular dependency —
// mock it so tryEnsureFresh()/tryRefresh() are no-ops during these tests.
vi.mock('./pkceFlow', () => ({
  ensureFreshToken: vi.fn().mockResolvedValue(null),
  silentRefresh:    vi.fn().mockResolvedValue(null),
}));

const mockCapacitorHttpRequest = vi.fn();
vi.mock('@capacitor/core', () => ({
  CapacitorHttp: { request: (...args: unknown[]) => mockCapacitorHttpRequest(...args) },
}));

import { request, uploadMultipart, ApiError, UploadAbortedError } from './api';

beforeEach(() => {
  _native = false;
  _mockUser = { token: 'evtxa_test' };
  mockCapacitorHttpRequest.mockReset();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Native routes through CapacitorHttp, never fetch() ──────────────────────

describe('request() — native transport', () => {
  it('uses CapacitorHttp, not fetch, when isNative() is true', async () => {
    _native = true;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    mockCapacitorHttpRequest.mockResolvedValue({ status: 200, data: { ok: true } });

    const result = await request('/knowledge-sessions/abc/live-state');

    expect(result).toEqual({ ok: true });
    expect(mockCapacitorHttpRequest).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('passes a connect/read timeout so a stuck native request cannot hang forever', async () => {
    _native = true;
    mockCapacitorHttpRequest.mockResolvedValue({ status: 200, data: {} });

    await request('/knowledge-sessions/abc/live-state');

    const opts = mockCapacitorHttpRequest.mock.calls[0][0];
    expect(opts.connectTimeout).toBeGreaterThan(0);
    expect(opts.readTimeout).toBeGreaterThan(0);
  });

  it('sends a pre-stringified JSON body as a parsed object, not double-encoded', async () => {
    _native = true;
    mockCapacitorHttpRequest.mockResolvedValue({ status: 200, data: {} });

    await request('/knowledge-sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'Sprint review' }),
    });

    const opts = mockCapacitorHttpRequest.mock.calls[0][0];
    expect(opts.data).toEqual({ title: 'Sprint review' });
  });

  it('still uses fetch() for FormData bodies even when native (file uploads)', async () => {
    _native = true;
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const form = new FormData();
    form.append('file', new Blob(['x']));
    await request('/knowledge-sessions/abc/chunks', { method: 'POST', body: form });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockCapacitorHttpRequest).not.toHaveBeenCalled();
  });
});

// ── Web keeps fetch(), but now with a timeout ────────────────────────────────

describe('request() — web transport', () => {
  it('uses fetch when isNative() is false', async () => {
    _native = false;
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200, ok: true, json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await request('/knowledge-sessions/abc/live-state');

    expect(result).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockCapacitorHttpRequest).not.toHaveBeenCalled();
  });

  it('aborts and rejects with a retriable ApiError instead of hanging forever', async () => {
    vi.useFakeTimers();
    _native = false;
    // A fetch that never settles on its own — the exact WKWebView-suspension
    // failure mode — but honors AbortSignal like the real implementation does,
    // so this exercises our timeout rather than the browser's abort plumbing.
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));

    const pending = request('/knowledge-sessions/abc/live-state');
    const assertion = expect(pending).rejects.toBeInstanceOf(ApiError);

    await vi.advanceTimersByTimeAsync(20_000);

    await assertion;
    await pending.catch((e) => {
      expect((e as ApiError).status).toBe(0);
      expect((e as ApiError).retriable).toBe(true);
    });
  });
});

// ── 401 retry path also uses the safe transport ─────────────────────────────

describe('request() — 401 retry', () => {
  it('retries through CapacitorHttp on native after a refresh succeeds', async () => {
    _native = true;
    const { silentRefresh } = await import('./pkceFlow');
    (silentRefresh as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ token: 'evtxa_fresh' });

    mockCapacitorHttpRequest
      .mockResolvedValueOnce({ status: 401, data: { detail: 'expired' } })
      .mockResolvedValueOnce({ status: 200, data: { ok: true } });

    const result = await request('/knowledge-sessions/abc/live-state');

    expect(result).toEqual({ ok: true });
    expect(mockCapacitorHttpRequest).toHaveBeenCalledTimes(2);
  });
});


// ── Structured error detail ─────────────────────────────────────────────────

describe('request() — structured detail { code, message }', () => {
  it('exposes detail.code on the ApiError (session_cancelled is told apart from other 409s)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 409,
      json: async () => ({ detail: { code: 'session_cancelled', message: 'Session cancelled' } }),
    }));

    const err = (await request('/x').catch((e) => e)) as ApiError;

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('session_cancelled');
    expect(err.message).toBe('Session cancelled');
    expect(err.retriable).toBe(false);
  });

  it('a plain string detail keeps working and carries no code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 409, json: async () => ({ detail: 'nope' }) }));
    const err = (await request('/x').catch((e) => e)) as ApiError;
    expect(err.message).toBe('nope');
    expect(err.code).toBeUndefined();
  });
});

// ── uploadMultipart ─────────────────────────────────────────────────────────

class FakeXHR {
  static instances: FakeXHR[] = [];
  static script: Array<(x: FakeXHR) => void> = [];
  headers: Record<string, string> = {};
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  status = 0; responseText = ''; timeout = 0;
  onload: (() => void) | null = null; onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null; onabort: (() => void) | null = null;
  open = vi.fn(); aborted = false;
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  abort() { this.aborted = true; this.onabort?.(); }
  send = vi.fn(() => { FakeXHR.instances.push(this); queueMicrotask(() => FakeXHR.script.shift()?.(this)); });
}

describe('uploadMultipart()', () => {
  beforeEach(() => { FakeXHR.instances = []; FakeXHR.script = []; vi.stubGlobal('XMLHttpRequest', FakeXHR); });

  const respond = (status: number, body: unknown) => (x: FakeXHR) => { x.status = status; x.responseText = JSON.stringify(body); x.onload?.(); };

  it('sends the bearer token, reports progress as a fraction and resolves the JSON body', async () => {
    FakeXHR.script.push((x) => { x.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 }); respond(201, { attachment_id: 'a1' })(x); });
    const seen: number[] = [];

    const res = await uploadMultipart<{ attachment_id: string }>('/p', new FormData(), { onProgress: (f) => seen.push(f) });

    expect(res.attachment_id).toBe('a1');
    expect(seen).toEqual([0.25]);
    expect(FakeXHR.instances[0].headers.Authorization).toBe('Bearer evtxa_test');
  });

  it('maps a network failure to a retriable ApiError(0)', async () => {
    FakeXHR.script.push((x) => x.onerror?.());
    const err = (await uploadMultipart('/p', new FormData()).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.retriable).toBe(true);
  });

  it('a network error names the target and the page origin, so a device report can tell CORS from no connectivity', async () => {
    vi.stubGlobal('location', { origin: 'eigenvertex-recorder://localhost' });
    FakeXHR.script.push((x) => x.onerror?.());
    const err = (await uploadMultipart('/p', new FormData()).catch((e) => e)) as ApiError;
    expect(err.message).toContain('https://api.eigenvertex.com');
    expect(err.message).toContain('eigenvertex-recorder://localhost');
    expect(err.message).toMatch(/CORS/);
  });

  it('maps a timeout to a retriable ApiError(0)', async () => {
    FakeXHR.script.push((x) => x.ontimeout?.());
    const err = (await uploadMultipart('/p', new FormData()).catch((e) => e)) as ApiError;
    expect(err.retriable).toBe(true);
  });

  it('5xx is retriable, 413 is not, and detail.code is kept', async () => {
    FakeXHR.script.push(respond(503, { detail: 'down' }), respond(413, { detail: { code: 'attachment_too_large', message: 'big' } }));
    const a = (await uploadMultipart('/p', new FormData()).catch((e) => e)) as ApiError;
    const b = (await uploadMultipart('/p', new FormData()).catch((e) => e)) as ApiError;
    expect(a.retriable).toBe(true);
    expect(b.retriable).toBe(false);
    expect(b.code).toBe('attachment_too_large');
  });

  it('aborting through the signal throws UploadAbortedError (not an ApiError)', async () => {
    const ac = new AbortController();
    FakeXHR.script.push(() => ac.abort());   // abort while the request is in flight

    const err = (await uploadMultipart('/p', new FormData(), { signal: ac.signal }).catch((e) => e)) as ApiError;

    expect(err).toBeInstanceOf(UploadAbortedError);
    expect(err).not.toBeInstanceOf(ApiError);
    expect(FakeXHR.instances[0].aborted).toBe(true);
  });

  it('an already-aborted signal never sends anything', async () => {
    const ac = new AbortController(); ac.abort();
    await expect(uploadMultipart('/p', new FormData(), { signal: ac.signal })).rejects.toBeInstanceOf(UploadAbortedError);
    expect(FakeXHR.instances).toHaveLength(0);
  });
});
