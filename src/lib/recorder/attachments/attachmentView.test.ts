import { describe, it, expect } from 'vitest';
import { toAttachmentView, visibleViews, summarize, formatOffset, formatSize, formatDiagnostic } from './attachmentView';
import type { LocalAttachment } from './localTypes';

function att(over: Partial<LocalAttachment> = {}): LocalAttachment {
  return {
    local_attachment_id: 'a1', local_session_id: 'l1', kind: 'photo', filename: 'p.jpg', mime_type: 'image/jpeg',
    size_bytes: 1_200_000, sha256: 'x', title: 'Tableau blanc', start_offset_ms: 9_400, end_offset_ms: null,
    created_at: '2026-11-03T10:00:00Z', state: 'queued', server_attachment_id: null, server_status: null,
    attempts: 0, next_attempt_at: null, last_error: null, upload_started: false, pending_delete: false, title_dirty: false,
    ...over,
  };
}
const ctx = { hasRemoteSession: true, online: true };

describe('formatOffset', () => {
  it.each([[0, '00:00'], [9_999, '00:09'], [46_300, '00:46'], [61_000, '01:01'], [3_600_000, '1:00:00'], [-5, '00:00']])('%i ms → %s', (ms, out) => {
    expect(formatOffset(ms)).toBe(out);
  });
});

describe('formatSize', () => {
  it('uses a decimal comma in French and a point in English', () => {
    expect(formatSize(1_200_000, 'fr', 'Mo')).toBe('1,2 Mo');
    expect(formatSize(1_200_000, 'en', 'MB')).toBe('1.2 MB');
  });
  it('never shows 0.0 for a real (tiny) file', () => {
    expect(formatSize(4, 'en', 'MB')).toBe('0.1 MB');
  });
});

describe('toAttachmentView — status mapping (mockup states)', () => {
  it('uploaded + ready → ready', () => expect(toAttachmentView(att({ state: 'uploaded', server_status: 'ready' }), ctx).status).toBe('ready'));
  it('uploaded with the neutral "uploaded" server status → ready (session-only files never go further)', () => {
    expect(toAttachmentView(att({ state: 'uploaded', server_status: 'uploaded' }), ctx).status).toBe('ready');
  });
  it('uploading → percent from progress, clamped to 0..100', () => {
    expect(toAttachmentView(att({ state: 'uploading' }), { ...ctx, progress: 0.62 })).toMatchObject({ status: 'uploading', percent: 62 });
    expect(toAttachmentView(att({ state: 'uploading' }), { ...ctx, progress: 7 }).percent).toBe(100);
    expect(toAttachmentView(att({ state: 'uploading' }), ctx).percent).toBe(0);
  });
  it('percent is null when not uploading', () => expect(toAttachmentView(att({ state: 'uploaded' }), ctx).percent).toBeNull());
  it('queued, online, session exists, nothing failed yet → "queued" (about to be sent) — NOT "waiting for network"', () => {
    expect(toAttachmentView(att(), ctx).status).toBe('queued');
  });
  it('queued while the device is offline → offline (the only case that means "waiting for network")', () => {
    expect(toAttachmentView(att(), { ...ctx, online: false }).status).toBe('offline');
  });
  it('queued after a failed attempt while ONLINE → retrying, with the real cause (server unreachable)', () => {
    const v = toAttachmentView(att({ attempts: 2, next_attempt_at: 5_000, last_error: { kind: 'transient', status: 0, message: 'blocked' } }), ctx);
    expect(v).toMatchObject({ status: 'retrying', retryKind: 'network', attempts: 2, nextAttemptAt: 5_000, canRetry: true });
  });
  it('… or a server error (5xx/429)', () => {
    const v = toAttachmentView(att({ attempts: 1, last_error: { kind: 'transient', status: 503, message: 'down' } }), ctx);
    expect(v).toMatchObject({ status: 'retrying', retryKind: 'server', lastStatus: 503 });
  });
  it('queued in "local only" mode (no backend session yet) → waiting for the share, whatever the connectivity', () => {
    expect(toAttachmentView(att(), { hasRemoteSession: false, online: true }).status).toBe('waiting_share');
    expect(toAttachmentView(att(), { hasRemoteSession: false, online: false }).status).toBe('waiting_share');
  });
  it('uploaded + server processing → processing', () => expect(toAttachmentView(att({ state: 'uploaded', server_status: 'processing' }), ctx).status).toBe('processing'));
  it('failed upload → failed, retry offered, message kept', () => {
    const v = toAttachmentView(att({ state: 'failed', last_error: { kind: 'permanent', status: 422, message: 'bad' } }), ctx);
    expect(v).toMatchObject({ status: 'failed', canRetry: true, errorMessage: 'bad' });
  });
  it('server-side processing failure → retry offered too', () => {
    expect(toAttachmentView(att({ state: 'uploaded', server_status: 'failed' }), ctx)).toMatchObject({ status: 'processing_failed', canRetry: true });
  });
  it('only the states where a retry makes sense offer one: not queued, offline, uploading, ready', () => {
    for (const state of ['uploading', 'uploaded'] as const) expect(toAttachmentView(att({ state, server_status: 'ready' }), ctx).canRetry).toBe(false);
    expect(toAttachmentView(att(), ctx).canRetry).toBe(false);
    expect(toAttachmentView(att(), { ...ctx, online: false }).canRetry).toBe(false);
  });
  it('abandoned (cancelled session) → no retry', () => {
    expect(toAttachmentView(att({ state: 'abandoned' }), ctx)).toMatchObject({ status: 'abandoned', canRetry: false });
  });
  it('carries the timeline position as mm:ss', () => expect(toAttachmentView(att(), ctx).offsetLabel).toBe('00:09'));
});

describe('visibleViews / summarize', () => {
  it('hides items awaiting their server DELETE and orders by timeline position', () => {
    const views = visibleViews(
      [att({ local_attachment_id: 'late', start_offset_ms: 40_000 }), att({ local_attachment_id: 'gone', pending_delete: true }), att({ local_attachment_id: 'early', start_offset_ms: 1_000 })],
      () => ctx,
    );
    expect(views.map((v) => v.id)).toEqual(['early', 'late']);
  });

  it('counts what the end-of-record banner needs', () => {
    const err = { kind: 'transient' as const, status: 503, message: 'down' };
    const views = visibleViews([
      att({ local_attachment_id: '1', state: 'queued' }),
      att({ local_attachment_id: '2', state: 'uploading' }),
      att({ local_attachment_id: '3', state: 'failed' }),
      att({ local_attachment_id: '4', state: 'uploaded', server_status: 'ready' }),
      att({ local_attachment_id: '5', state: 'abandoned' }),
      att({ local_attachment_id: '6', state: 'queued', attempts: 1, last_error: err }),
    ], () => ctx);
    expect(summarize(views)).toEqual({ total: 6, sending: 2, offline: 0, retrying: 1, waitingShare: 0, failed: 1, abandoned: 1 });
  });

  it('"offline" and "waiting for the share" are counted apart, and only offline items mean "waiting for network"', () => {
    const offline = visibleViews([att({ local_attachment_id: '1' }), att({ local_attachment_id: '2' })], () => ({ hasRemoteSession: true, online: false }));
    expect(summarize(offline)).toMatchObject({ offline: 2, sending: 0, waitingShare: 0 });
    const noSession = visibleViews([att({ local_attachment_id: '1' })], () => ({ hasRemoteSession: false, online: true }));
    expect(summarize(noSession)).toMatchObject({ waitingShare: 1, offline: 0 });
  });
});

describe('formatDiagnostic', () => {
  it('shows the HTTP status and message', () => expect(formatDiagnostic({ kind: 'permanent', status: 413, message: 'attachment_too_large' })).toBe('HTTP 413 · attachment_too_large'));
  it('shows "network" when no response came back (status 0)', () => expect(formatDiagnostic({ kind: 'transient', status: 0, message: 'blocked by CORS' })).toBe('network · blocked by CORS'));
  it('nothing failed → null', () => expect(formatDiagnostic(null)).toBeNull());
  it('very long messages are truncated', () => expect(formatDiagnostic({ kind: 'permanent', status: 500, message: 'x'.repeat(500) })!.length).toBeLessThan(260));
});

describe('toAttachmentView — scans', () => {
  it('a scan exposes isScan and its page count', () => {
    const v = toAttachmentView(att({ kind: 'document', capture_source: 'scan', page_count: 5 }), ctx);
    expect(v).toMatchObject({ isScan: true, pageCount: 5, kind: 'document' });
  });
  it('a scan without a recorded page count has null pages; ordinary documents and photos are not scans', () => {
    expect(toAttachmentView(att({ kind: 'document', capture_source: 'scan' }), ctx)).toMatchObject({ isScan: true, pageCount: null });
    expect(toAttachmentView(att({ kind: 'document', page_count: 3 }), ctx)).toMatchObject({ isScan: false, pageCount: null });
    expect(toAttachmentView(att(), ctx)).toMatchObject({ isScan: false, pageCount: null });
  });
});
