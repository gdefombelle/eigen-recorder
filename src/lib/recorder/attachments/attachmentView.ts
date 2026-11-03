// attachmentView — pure mapping from a persisted LocalAttachment to what the UI shows.
// No Svelte, no storage: testable on its own.

import type { LocalAttachment } from './localTypes';
import type { AttachmentKind } from './types';

export type AttachmentStatus =
  | 'ready'              // on the server, usable
  | 'uploading'          // request in flight (percent known)
  | 'waiting_network'    // queued; session exists, waiting for connectivity / backoff
  | 'waiting_share'      // queued; "local only" — the backend session does not exist yet
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
}

export interface ViewContext {
  /** 0..1 for the item currently uploading. */
  progress?:        number;
  /** Whether the record's backend session exists yet. */
  hasRemoteSession: boolean;
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

export function toAttachmentView(att: LocalAttachment, ctx: ViewContext): AttachmentView {
  let status: AttachmentStatus;
  switch (att.state) {
    case 'uploaded':
      status = att.server_status === 'processing' ? 'processing'
             : att.server_status === 'failed'     ? 'processing_failed'
             : 'ready';
      break;
    case 'uploading': status = 'uploading'; break;
    case 'queued':    status = ctx.hasRemoteSession ? 'waiting_network' : 'waiting_share'; break;
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
  waitingNetwork: number;
  waitingShare:   number;
  failed:         number;      // upload failures + processing failures
  abandoned:      number;
}

export function summarize(views: AttachmentView[]): AttachmentSummary {
  const count = (pred: (v: AttachmentView) => boolean) => views.filter(pred).length;
  return {
    total:          views.length,
    waitingNetwork: count((v) => v.status === 'waiting_network' || v.status === 'uploading'),
    waitingShare:   count((v) => v.status === 'waiting_share'),
    failed:         count((v) => v.status === 'failed' || v.status === 'processing_failed'),
    abandoned:      count((v) => v.status === 'abandoned'),
  };
}
