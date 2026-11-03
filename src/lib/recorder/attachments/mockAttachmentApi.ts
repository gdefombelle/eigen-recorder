// MockAttachmentApi — in-memory stand-in for the not-yet-deployed attachments
// endpoints. Mirrors the real server's observable behaviour (idempotent on
// client_attachment_id, 409 on terminal sessions, 413 over the limit, sha256
// check) and lets tests/dev inject failures.

import { ApiError, UploadAbortedError } from '$lib/auth/api';
import {
  MAX_ATTACHMENT_BYTES,
  type AttachmentApiContract,
  type AttachmentRecord,
  type UpdateAttachmentPatch,
  type UploadAttachmentInput,
  type UploadCallOptions,
} from './types';

export type MockSessionState = 'open' | 'closed' | 'cancelled';

interface Stored {
  sessionId: string;
  record:    AttachmentRecord;
  deleted:   boolean;
  size:      number;
  file:      Blob;
}

export interface MockAttachmentApiOptions {
  /** Simulated latency per progress step (ms). 0 in tests. */
  stepDelayMs?: number;
  steps?:       number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class MockAttachmentApi implements AttachmentApiContract {
  private rows: Stored[] = [];
  private sessionStates = new Map<string, MockSessionState>();
  private failures: Array<{ status: number; message: string }> = [];
  private seq = 0;
  /** Number of upload() calls that actually reached the "server" (diagnostics for retry tests). */
  uploadAttempts = 0;

  constructor(private readonly opts: MockAttachmentApiOptions = {}) {}

  // ── test/dev controls ────────────────────────────────────────────────────
  setSessionState(sessionId: string, state: MockSessionState): void { this.sessionStates.set(sessionId, state); }
  /** Make the next call fail with this HTTP status (0 = network failure). Queued FIFO. */
  failNext(status: number, message = `Mock HTTP ${status}`): void { this.failures.push({ status, message }); }
  reset(): void { this.rows = []; this.sessionStates.clear(); this.failures = []; this.seq = 0; this.uploadAttempts = 0; }

  private maybeFail(): void {
    const f = this.failures.shift();
    if (!f) return;
    throw new ApiError(f.status, f.message, f.status === 0 || f.status >= 500 || f.status === 429);
  }

  /** Closed sessions are accepted; only a cancelled one is refused (409 + detail.code). */
  private assertWritable(sessionId: string): void {
    if (this.sessionStates.get(sessionId) === 'cancelled') {
      throw new ApiError(409, 'This knowledge session is cancelled.', false, 'session_cancelled');
    }
  }

  private find(sessionId: string, id: string): Stored {
    const row = this.rows.find(
      (r) => r.sessionId === sessionId && !r.deleted &&
        (r.record.attachment_id === id || r.record.client_attachment_id === id),
    );
    if (!row) throw new ApiError(404, 'Attachment not found', false);
    return row;
  }

  // ── contract ─────────────────────────────────────────────────────────────
  async upload(input: UploadAttachmentInput, opts: UploadCallOptions = {}): Promise<AttachmentRecord> {
    this.uploadAttempts++;
    this.assertWritable(input.sessionId);

    const steps = this.opts.steps ?? 4;
    const delay = this.opts.stepDelayMs ?? 0;
    for (let i = 1; i <= steps; i++) {
      if (opts.signal?.aborted) throw new UploadAbortedError();
      if (delay) await sleep(delay);
      if (opts.signal?.aborted) throw new UploadAbortedError();
      opts.onProgress?.(i / steps);
      // Failures land mid-upload, like a dropped connection or a 5xx after the body was sent.
      if (i === Math.ceil(steps / 2)) this.maybeFail();
    }

    const existing = this.rows.find(
      (r) => r.sessionId === input.sessionId && r.record.client_attachment_id === input.clientAttachmentId,
    );
    if (existing) return { ...existing.record };

    if (input.file.size > MAX_ATTACHMENT_BYTES) throw new ApiError(413, 'attachment_too_large', false);
    if (input.file.size === 0) throw new ApiError(400, 'The attachment is empty', false);
    if (input.endOffsetMs != null && input.endOffsetMs < input.startOffsetMs) {
      throw new ApiError(422, 'end_offset_ms must be >= start_offset_ms', false);
    }

    const record: AttachmentRecord = {
      attachment_id:        `mock-att-${++this.seq}`,
      client_attachment_id: input.clientAttachmentId,
      status:               'uploaded',
      start_offset_ms:      input.startOffsetMs,
      end_offset_ms:        input.endOffsetMs ?? null,
      document_id:          null,
      task_id:              null,
      created_at:           new Date().toISOString(),
      title:                input.title,
      kind:                 input.file.type.startsWith('image/') ? 'photo' : 'document',
    };
    this.rows.push({ sessionId: input.sessionId, record, deleted: false, size: input.file.size, file: input.file });
    return { ...record };
  }

  async list(sessionId: string): Promise<AttachmentRecord[]> {
    this.maybeFail();
    return this.rows
      .filter((r) => r.sessionId === sessionId && !r.deleted)
      .map((r) => ({ ...r.record }))
      .sort((a, b) => a.start_offset_ms - b.start_offset_ms);
  }

  async get(sessionId: string, attachmentId: string): Promise<AttachmentRecord> {
    this.maybeFail();
    return { ...this.find(sessionId, attachmentId).record };
  }

  async update(sessionId: string, attachmentId: string, patch: UpdateAttachmentPatch): Promise<AttachmentRecord> {
    this.maybeFail();
    this.assertWritable(sessionId);
    const row = this.find(sessionId, attachmentId);
    const start = patch.start_offset_ms ?? row.record.start_offset_ms;
    const end = 'end_offset_ms' in patch ? patch.end_offset_ms ?? null : row.record.end_offset_ms;
    if (end !== null && end < start) throw new ApiError(422, 'end_offset_ms must be >= start_offset_ms', false);
    row.record = {
      ...row.record,
      start_offset_ms: start,
      end_offset_ms:   end,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
    };
    return { ...row.record };
  }

  async remove(sessionId: string, attachmentId: string): Promise<void> {
    this.maybeFail();
    this.assertWritable(sessionId);
    this.find(sessionId, attachmentId).deleted = true;
  }

  async download(sessionId: string, attachmentId: string): Promise<Blob> {
    this.maybeFail();
    return this.find(sessionId, attachmentId).file;
  }

  async retry(sessionId: string, attachmentId: string): Promise<AttachmentRecord> {
    this.maybeFail();
    this.assertWritable(sessionId);
    const row = this.find(sessionId, attachmentId);
    if (row.record.status !== 'failed') throw new ApiError(409, 'Only failed attachments can be retried', false);
    row.record = { ...row.record, status: 'processing' };
    return { ...row.record };
  }
}

export const mockAttachmentApi = new MockAttachmentApi({ stepDelayMs: 120 });
