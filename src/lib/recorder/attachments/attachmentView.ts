// attachmentView — pure mapping from a persisted LocalAttachment to what the UI shows.
// No Svelte, no storage: testable on its own.

import type { LocalAttachment } from './localTypes';
import type { AttachmentKind } from './types';

export type AttachmentStatus =
  | 'ready'              // on the server, usable
  | 'uploading'          // request in flight (percent known)
  | 'queued'             // session exists, device online, nothing failed yet: the next pass sends it
  | 'offline'            // the device reports no connectivity — the ONLY case worded "waiting for network"
  | 'retrying'           // an attempt failed transiently (network unreachable / 5xx / 429): automatic retry pending
  | 'waiting_share'      // "local only" — the backend session does not exist yet
  | 'processing'         // server is reading it (OCR / ingestion)
  | 'processing_failed'  // server-side processing failed — POST /retry
  | 'failed'             // upload failed for good — manual retry re-sends the file
  | 'abandoned';         // session cancelled; never sent

export interface AttachmentView {
  id:              string;
  localSessionId:  string;
  title:           string;
  kind:            AttachmentKind;
  sizeBytes:       number;
  offsetMs:        number;
  offsetLabel:     string;       // mm:ss
  status:          AttachmentStatus;
  percent:         number | null;
  canRetry:        boolean;
  errorMessage:    string | null;
  /** Last failure, for the diagnostic line: "HTTP 503 · …" or "network · …". Null when nothing failed. */
  diagnostic:      string | null;
  /** Why an automatic retry is pending (only for status 'retrying'). */
  retryKind:       'network' | 'server' | null;
  /** HTTP status of the last failure (0 = no response). */
  lastStatus:      number | null;
  attempts:        number;
  nextAttemptAt:   number | null;
}

export interface ViewContext {
  /** 0..1 for the item currently uploading. */
  progress?:        number;
  /** Whether the record's backend session exists yet. */
  hasRemoteSession: boolean;
  /** navigator.onLine at mapping time. */
  online:           boolean;
}

/** mm:ss, or h:mm:ss from one hour on. Floors, like a player does. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Decimal megabytes (what the 25 MB server limit means), one decimal, localized separator. */
export function formatSize(bytes: number, lang: 'fr' | 'en', unit: string): string {
  const mb = bytes / 1_000_000;
  const text = mb >= 0.05 ? mb.toFixed(1) : '0.1';      // never show "0.0 MB" for a real file
  return `${lang === 'fr' ? text.replace('.', ',') : text} ${unit}`;
}

/** Last error as a short technical line: the HTTP status, or "network" when no response came back. */
export function formatDiagnostic(err: LocalAttachment['last_error']): string | null {
  if (!err) return null;
  const code = err.status === 0 ? 'network' : `HTTP ${err.status}`;
  const msg = err.message.length > 220 ? `${err.message.slice(0, 220)}…` : err.message;
  return msg ? `${code} · ${msg}` : code;
}

export function toAttachmentView(att: LocalAttachment, ctx: ViewContext): AttachmentView {
  let status: AttachmentStatus;
  switch (att.state) {
    case 'uploaded':
      status = att.server_status === 'processing' ? 'processing'
             : att.server_status === 'failed'     ? 'processing_failed'
             : 'ready';
      break;
    case 'uploading': status = 'uploading'; break;
    case 'queued':
      status = !ctx.hasRemoteSession ? 'waiting_share'
             : !ctx.online           ? 'offline'
             : att.last_error && att.attempts > 0 ? 'retrying'
             : 'queued';
      break;
    case 'failed':    status = 'failed'; break;
    case 'abandoned': status = 'abandoned'; break;
  }
  return {
    id: att.local_attachment_id,
    localSessionId: att.local_session_id,
    title: att.title,
    kind: att.kind,
    sizeBytes: att.size_bytes,
    offsetMs: att.start_offset_ms,
    offsetLabel: formatOffset(att.start_offset_ms),
    status,
    percent: status === 'uploading' ? Math.round(Math.min(1, Math.max(0, ctx.progress ?? 0)) * 100) : null,
    canRetry: status === 'failed' || status === 'processing_failed',
    errorMessage: att.last_error?.message ?? null,
    diagnostic: formatDiagnostic(att.last_error),
    retryKind: status === 'retrying' ? (att.last_error?.status === 0 ? 'network' : 'server') : null,
    lastStatus: att.last_error?.status ?? null,
    attempts: att.attempts,
    nextAttemptAt: att.next_attempt_at,
  };
}

/** What the list shows: everything except items the user already deleted (pending server DELETE). */
export function visibleViews(rows: LocalAttachment[], ctx: (a: LocalAttachment) => ViewContext): AttachmentView[] {
  return rows
    .filter((a) => !a.pending_delete)
    .map((a) => toAttachmentView(a, ctx(a)))
    .sort((a, b) => a.offsetMs - b.offsetMs);
}

export interface AttachmentSummary {
  total:          number;
  sending:        number;      // uploading now, or queued and about to be sent
  offline:        number;      // device has no connectivity
  retrying:       number;      // an attempt failed (server unreachable / 5xx / 429); automatic retry pending
  waitingShare:   number;      // "local only": the audio has not been shared yet
  failed:         number;      // upload failures + processing failures
  abandoned:      number;
}

export function summarize(views: AttachmentView[]): AttachmentSummary {
  const count = (pred: (v: AttachmentView) => boolean) => views.filter(pred).length;
  return {
    total:        views.length,
    sending:      count((v) => v.status === 'uploading' || v.status === 'queued'),
    offline:      count((v) => v.status === 'offline'),
    retrying:     count((v) => v.status === 'retrying'),
    waitingShare: count((v) => v.status === 'waiting_share'),
    failed:       count((v) => v.status === 'failed' || v.status === 'processing_failed'),
    abandoned:    count((v) => v.status === 'abandoned'),
  };
}
