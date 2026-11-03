import { describe, it, expect } from 'vitest';
import { toAttachmentView, visibleViews, summarize, formatOffset, formatSize } from './attachmentView';
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
const ctx = { hasRemoteSession: true };

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
  it('queued with a backend session → waiting for network', () => expect(toAttachmentView(att(), ctx).status).toBe('waiting_network'));
  it('queued in "local only" mode (no backend session yet) → waiting for the share, not "network"', () => {
    expect(toAttachmentView(att(), { hasRemoteSession: false }).status).toBe('waiting_share');
  });
  it('uploaded + server processing → processing', () => expect(toAttachmentView(att({ state: 'uploaded', server_status: 'processing' }), ctx).status).toBe('processing'));
  it('failed upload → failed, retry offered, message kept', () => {
    const v = toAttachmentView(att({ state: 'failed', last_error: { kind: 'permanent', status: 422, message: 'bad' } }), ctx);
    expect(v).toMatchObject({ status: 'failed', canRetry: true, errorMessage: 'bad' });
  });
  it('server-side processing failure → retry offered too', () => {
    expect(toAttachmentView(att({ state: 'uploaded', server_status: 'failed' }), ctx)).toMatchObject({ status: 'processing_failed', canRetry: true });
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
    const views = visibleViews([
      att({ local_attachment_id: '1', state: 'queued' }),
      att({ local_attachment_id: '2', state: 'uploading' }),
      att({ local_attachment_id: '3', state: 'failed' }),
      att({ local_attachment_id: '4', state: 'uploaded', server_status: 'ready' }),
      att({ local_attachment_id: '5', state: 'abandoned' }),
    ], () => ctx);
    expect(summarize(views)).toEqual({ total: 5, uploading: 1, waitingNetwork: 1, waitingShare: 0, failed: 1, abandoned: 1 });
  });

  it('separates "waiting for the share" from "waiting for network"', () => {
    const views = visibleViews([att({ local_attachment_id: '1' }), att({ local_attachment_id: '2' })], () => ({ hasRemoteSession: false }));
    expect(summarize(views)).toMatchObject({ waitingShare: 2, waitingNetwork: 0 });
  });
});
