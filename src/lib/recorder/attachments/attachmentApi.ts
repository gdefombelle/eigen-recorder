// attachmentApi — real HTTP implementation of AttachmentApiContract.
//
// Not yet deployed server-side: see mockAttachmentApi.ts, selected with
// VITE_ATTACHMENTS_MOCK=true (or setAttachmentApi() in tests).
//
// Backend facts worth knowing (eigenvertex f920838 + the allow_closed follow-up):
//   • POST/PATCH/DELETE/retry accept CLOSED sessions (attachments queued offline
//     are delivered after the record ends). Only a CANCELLED session is refused:
//     409 with detail.code = "session_cancelled".
//   • POST /{id}/retry only works for failed attachments that have an ingestion
//     task (corpus destination); for session-only files it answers 409.
//   • Duplicate client_attachment_id → 200 with the existing record (idempotent).

import { request, uploadMultipart, ApiError, UploadAbortedError } from '$lib/auth/api';
import {
  MAX_ATTACHMENT_BYTES,
  type AttachmentApiContract,
  type AttachmentRecord,
  type ClassifiedAttachmentError,
  type UpdateAttachmentPatch,
  type UploadAttachmentInput,
  type UploadCallOptions,
} from './types';

const base = (sessionId: string) => `/knowledge-sessions/${encodeURIComponent(sessionId)}/attachments`;

export function classifyAttachmentError(e: unknown): ClassifiedAttachmentError {
  if (e instanceof UploadAbortedError) return { kind: 'aborted', status: 0, message: e.message };
  if (e instanceof ApiError) {
    if (e.retriable) return { kind: 'transient', status: e.status, message: e.message };       // 0, 5xx, 429
    if (e.status === 409 && e.code === 'session_cancelled') return { kind: 'session_cancelled', status: 409, message: e.message };
    return { kind: 'permanent', status: e.status, message: e.message };
  }
  // Anything we cannot classify is not retried blindly: a loop on an unknown error is worse than a manual button.
  return { kind: 'permanent', status: 0, message: e instanceof Error ? e.message : String(e) };
}

export class AttachmentTooLargeError extends Error {
  constructor(public readonly sizeBytes: number) {
    super(`Attachment is ${sizeBytes} bytes; the limit is ${MAX_ATTACHMENT_BYTES}`);
    this.name = 'AttachmentTooLargeError';
  }
}

class HttpAttachmentApi implements AttachmentApiContract {
  async upload(input: UploadAttachmentInput, opts: UploadCallOptions = {}): Promise<AttachmentRecord> {
    if (input.file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentTooLargeError(input.file.size);
    const form = new FormData();
    form.append('file', input.file, input.filename);
    form.append('client_attachment_id', input.clientAttachmentId);
    form.append('start_offset_ms', String(Math.max(0, Math.round(input.startOffsetMs))));
    if (input.endOffsetMs != null) form.append('end_offset_ms', String(Math.round(input.endOffsetMs)));
    form.append('sha256', input.sha256);
    form.append('title', input.title);
    return uploadMultipart<AttachmentRecord>(base(input.sessionId), form, opts);
  }

  async list(sessionId: string): Promise<AttachmentRecord[]> {
    const res = await request<{ attachments: AttachmentRecord[] }>(base(sessionId));
    return res.attachments ?? [];
  }

  get(sessionId: string, attachmentId: string): Promise<AttachmentRecord> {
    return request<AttachmentRecord>(`${base(sessionId)}/${encodeURIComponent(attachmentId)}`);
  }

  update(sessionId: string, attachmentId: string, patch: UpdateAttachmentPatch): Promise<AttachmentRecord> {
    return request<AttachmentRecord>(`${base(sessionId)}/${encodeURIComponent(attachmentId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  async remove(sessionId: string, attachmentId: string): Promise<void> {
    await request<unknown>(`${base(sessionId)}/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' });
  }

  retry(sessionId: string, attachmentId: string): Promise<AttachmentRecord> {
    return request<AttachmentRecord>(`${base(sessionId)}/${encodeURIComponent(attachmentId)}/retry`, { method: 'POST' });
  }
}

export const httpAttachmentApi: AttachmentApiContract = new HttpAttachmentApi();

// ── Implementation switch ──────────────────────────────────────────────────

let _api: AttachmentApiContract | null = null;

export async function getAttachmentApi(): Promise<AttachmentApiContract> {
  if (_api) return _api;
  if (import.meta.env.VITE_ATTACHMENTS_MOCK === 'true') {
    _api = (await import('./mockAttachmentApi')).mockAttachmentApi;
  } else {
    _api = httpAttachmentApi;
  }
  return _api;
}

/** Test seam. Pass null to restore the env-based default. */
export function setAttachmentApi(api: AttachmentApiContract | null): void {
  _api = api;
}
