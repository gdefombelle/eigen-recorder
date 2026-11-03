// Record attachments — wire types for /v1/knowledge-sessions/{id}/attachments.
// Source of truth: eigenvertex src/common/schemas/knowledge_session.py
// (KnowledgeSessionAttachmentRead / Update) and the routes in
// src/api/routes/knowledge_sessions.py (commit f920838).

export type AttachmentKind = 'photo' | 'document';

/** Server-side lifecycle. Local-only states (queued, uploading…) live in the queue, not here. */
export type ServerAttachmentStatus = 'uploaded' | 'processing' | 'ready' | 'failed';

/** Hard server limit (KNOWLEDGE_SESSION_ATTACHMENT_MAX_UPLOAD_BYTES default) — checked client-side to avoid a 413 round-trip. */
export const MAX_ATTACHMENT_BYTES = 25_000_000;

export interface AttachmentRecord {
  attachment_id:        string;
  client_attachment_id: string;
  status:               ServerAttachmentStatus;
  start_offset_ms:      number;
  end_offset_ms:        number | null;
  document_id:          string | null;
  task_id:              string | null;
  created_at:           string;
  // GET list/detail also merge the legacy shape; present there, absent on POST/PATCH/retry.
  title?:               string | null;
  kind?:                AttachmentKind;
}

export interface UploadAttachmentInput {
  sessionId:          string;
  file:               Blob;
  filename:           string;
  /** Generated on the device once, reused on every retry (server dedups on it). */
  clientAttachmentId: string;
  /** Position on the audio timeline, pauses excluded (same referential as the transcript). */
  startOffsetMs:      number;
  endOffsetMs?:       number | null;
  /** SHA-256 hex of the exact bytes sent. */
  sha256:             string;
  title:              string;
}

export interface UploadCallOptions {
  onProgress?: (fraction: number) => void;
  signal?:     AbortSignal;
}

export interface UpdateAttachmentPatch {
  start_offset_ms?: number;
  end_offset_ms?:   number | null;
  title?:           string;
}

export interface AttachmentApiContract {
  /** 201 on creation, 200 on duplicate client_attachment_id — both resolve to the stored record. */
  upload(input: UploadAttachmentInput, opts?: UploadCallOptions): Promise<AttachmentRecord>;
  list(sessionId: string): Promise<AttachmentRecord[]>;
  get(sessionId: string, attachmentId: string): Promise<AttachmentRecord>;
  update(sessionId: string, attachmentId: string, patch: UpdateAttachmentPatch): Promise<AttachmentRecord>;
  /** Soft delete. Refused (409) when the session is closed. */
  remove(sessionId: string, attachmentId: string): Promise<void>;
  /** Server-side re-ingestion of a failed attachment — does NOT re-upload the file. */
  retry(sessionId: string, attachmentId: string): Promise<AttachmentRecord>;
}

// ── Error classification ───────────────────────────────────────────────────
//
//   transient        network (status 0), 5xx, 429       → automatic retry with backoff
//   session_cancelled 409 with detail.code = "session_cancelled" → definitive: abandon the session's queue.
//                    (A closed session is ACCEPTED by the server — it is not an error.)
//   aborted          caller cancelled the upload         → not a failure
//   permanent        400/401/403/404/413/422, other 409… → state Failed, manual retry only, no loop
export type AttachmentErrorKind = 'transient' | 'session_cancelled' | 'aborted' | 'permanent';

export interface ClassifiedAttachmentError {
  kind:    AttachmentErrorKind;
  status:  number;          // 0 when no HTTP response
  message: string;
}
