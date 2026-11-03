// @vitest-environment node
/**
 * Integration test — record attachments against a REAL EigenVertex backend.
 *
 * Skipped unless EIGEN_IT_BASE_URL and EIGEN_IT_TOKEN are set, so `npm test`
 * never touches a server by accident:
 *
 *   EIGEN_IT_BASE_URL=https://api.eigenvertex.com \
 *   EIGEN_IT_TOKEN=<bearer token of a test account> \
 *   [EIGEN_IT_CLOSED_SESSION_ID=<id of a throwaway CLOSED session you can write to>] \
 *   npx vitest run src/lib/recorder/attachments/attachments.integration.test.ts
 *
 * It creates one throwaway session (title "[integration-test] …"), exercises the
 * real httpAttachmentApi (real api.ts, real multipart bodies, real server) and
 * cancels the session at the end. Attachments it creates are deleted by the test.
 *
 * The only simulated part is the transport primitive: Node has no
 * XMLHttpRequest, so a ~30-line shim maps it onto fetch(). Request bodies,
 * headers and error mapping are the production code paths.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const BASE  = (process.env.EIGEN_IT_BASE_URL ?? '').replace(/\/+$/, '');
const TOKEN = process.env.EIGEN_IT_TOKEN ?? '';
const CLOSED_SESSION = process.env.EIGEN_IT_CLOSED_SESSION_ID ?? '';
const enabled = !!BASE && !!TOKEN;

vi.mock('$lib/platform', () => ({ isNative: () => false }));
vi.mock('$lib/auth/auth', () => ({ getUser: () => ({ token: process.env.EIGEN_IT_TOKEN ?? '' }) }));
vi.mock('$lib/auth/config', () => ({
  getApiBase:       () => `${(process.env.EIGEN_IT_BASE_URL ?? '').replace(/\/+$/, '')}/v1`,
  getDirectApiBase: () => `${(process.env.EIGEN_IT_BASE_URL ?? '').replace(/\/+$/, '')}/v1`,
}));
// Same relative paths api.ts uses (it imports './auth' and './config').
vi.mock('$lib/auth/pkceFlow', () => ({ ensureFreshToken: async () => null, silentRefresh: async () => null }));

/** Minimal XMLHttpRequest over fetch(): enough for uploadMultipart (headers, FormData body, abort, load/error/timeout). */
class FetchXHR {
  upload: { onprogress: unknown } = { onprogress: null };
  status = 0; responseText = ''; timeout = 0;
  onload: (() => void) | null = null; onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null; onabort: (() => void) | null = null;
  private url = ''; private method = 'GET'; private headers: Record<string, string> = {};
  private ac = new AbortController();
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  abort() { this.ac.abort(); this.onabort?.(); }
  send(body: FormData) {
    const timer = this.timeout ? setTimeout(() => { this.ac.abort(); this.ontimeout?.(); }, this.timeout) : null;
    fetch(this.url, { method: this.method, headers: this.headers, body, signal: this.ac.signal })
      .then(async (r) => { this.status = r.status; this.responseText = await r.text(); this.onload?.(); })
      .catch(() => { if (!this.ac.signal.aborted) this.onerror?.(); })
      .finally(() => { if (timer) clearTimeout(timer); });
  }
}
vi.stubGlobal('XMLHttpRequest', FetchXHR);

import { httpAttachmentApi, classifyAttachmentError } from './attachmentApi';
import { sha256Hex } from './imagePrep';
import type { UploadAttachmentInput } from './types';

const authHeaders = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/v1${path}`, { method, headers: authHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

const uuid = () => crypto.randomUUID();

async function makeInput(sessionId: string, over: Partial<UploadAttachmentInput> = {}): Promise<UploadAttachmentInput> {
  // JPEG SOI + EOI markers: enough for a test payload; the server stores it as-is (session-only destination).
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const file = new Blob([bytes], { type: 'image/jpeg' });
  return {
    sessionId, file, filename: 'it.jpg', clientAttachmentId: uuid(),
    startOffsetMs: 12_345, sha256: await sha256Hex(file), title: 'IT photo', ...over,
  };
}

describe.skipIf(!enabled)('attachments — real backend', () => {
  let sessionId = '';

  beforeAll(async () => {
    const started = await api<{ session: { id: string } }>('POST', '/knowledge-sessions/start-now', {
      title: `[integration-test] attachments ${new Date().toISOString()}`,
      session_type: 'voice_note',
    });
    sessionId = started.session.id;
  });

  afterAll(async () => {
    if (sessionId) await api('POST', `/knowledge-sessions/${sessionId}/cancel`).catch(() => { /* best effort */ });
  });

  it('upload → duplicate (same client_attachment_id) → list → delete', async () => {
    const input = await makeInput(sessionId);

    const created = await httpAttachmentApi.upload(input);
    expect(created.client_attachment_id).toBe(input.clientAttachmentId);
    expect(created.start_offset_ms).toBe(12_345);
    expect(['uploaded', 'processing', 'ready']).toContain(created.status);

    // Retry with the SAME client_attachment_id: idempotent, no second row.
    const again = await httpAttachmentApi.upload(input);
    expect(again.attachment_id).toBe(created.attachment_id);

    const listed = (await httpAttachmentApi.list(sessionId)).filter((a) => a.client_attachment_id === input.clientAttachmentId);
    expect(listed).toHaveLength(1);
    expect(listed[0].attachment_id).toBe(created.attachment_id);

    await httpAttachmentApi.remove(sessionId, created.attachment_id);
    const afterDelete = await httpAttachmentApi.list(sessionId);
    expect(afterDelete.some((a) => a.client_attachment_id === input.clientAttachmentId)).toBe(false);
  });

  it('the server verifies sha256: a wrong hash is a permanent 400, never retried', async () => {
    const err = await httpAttachmentApi.upload(await makeInput(sessionId, { sha256: '0'.repeat(64) })).catch((e) => e);
    expect(classifyAttachmentError(err)).toMatchObject({ kind: 'permanent', status: 400 });
  });

  it('delete by client_attachment_id works (what the queue does after aborting an upload)', async () => {
    const input = await makeInput(sessionId);
    await httpAttachmentApi.upload(input);
    await httpAttachmentApi.remove(sessionId, input.clientAttachmentId);
    expect((await httpAttachmentApi.list(sessionId)).some((a) => a.client_attachment_id === input.clientAttachmentId)).toBe(false);
  });

  it('a CANCELLED session answers 409 session_cancelled', async () => {
    const started = await api<{ session: { id: string } }>('POST', '/knowledge-sessions/start-now', {
      title: '[integration-test] attachments (cancelled)', session_type: 'voice_note',
    });
    const id = started.session.id;
    await api('POST', `/knowledge-sessions/${id}/cancel`);

    const err = await httpAttachmentApi.upload(await makeInput(id)).catch((e) => e);
    expect(classifyAttachmentError(err)).toMatchObject({ kind: 'session_cancelled', status: 409 });
  });

  it.skipIf(!CLOSED_SESSION)('a CLOSED session accepts upload, list and delete', async () => {
    const input = await makeInput(CLOSED_SESSION);
    const created = await httpAttachmentApi.upload(input);
    expect(created.client_attachment_id).toBe(input.clientAttachmentId);
    expect((await httpAttachmentApi.list(CLOSED_SESSION)).some((a) => a.attachment_id === created.attachment_id)).toBe(true);
    await httpAttachmentApi.remove(CLOSED_SESSION, created.attachment_id);
  });
});
