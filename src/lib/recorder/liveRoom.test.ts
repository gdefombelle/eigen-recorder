/**
 * Tests for liveRoom.ts — openFinalizedSession behaviour.
 *  - Cache hit: opens cached URL in browser, returns { kind: 'opened_url' }, no POST
 *  - No cache + view_url in live-state: opens Studio URL, returns { kind: 'opened_url' }
 *  - No cache + no view_url: returns { kind: 'live_state', data }
 *  - Never calls POST /live-share for a finalized session
 *
 * Backend field names (actual contract):
 *   summary_text, transcript_segments, actions, participants, view_url
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// Controllable per-test; defaults to web (false) so every existing test below
// keeps its original assumption unless a test opts into native.
let _native = false;
vi.mock('$lib/platform', () => ({ isNative: () => _native }));
vi.mock('./knowledgeSessionApi', () => ({
  createLiveShare: vi.fn(),
  getLiveState:    vi.fn(),
}));

const mockShareShare = vi.fn().mockResolvedValue(undefined);
vi.mock('@capacitor/share', () => ({ Share: { share: (...args: unknown[]) => mockShareShare(...args) } }));

import { createLiveShare, getLiveState } from './knowledgeSessionApi';
import type { LiveStateResponse } from './knowledgeSessionApi';
import {
  getLiveShareUrl,
  getCachedLiveShareUrl,
  openFinalizedSession,
  shareSessionContent,
  clearLiveShareCache,
} from './liveRoom';

const mockCreateLiveShare = createLiveShare as ReturnType<typeof vi.fn>;
const mockGetLiveState    = getLiveState    as ReturnType<typeof vi.fn>;

/** Build a realistic live-state response using the real backend field names. */
function makeLiveState(overrides?: Partial<LiveStateResponse>): LiveStateResponse {
  return {
    status:               'finalized',
    title:                'Sprint review',
    view_url:             null,
    summary_text:         'Discussed Q3 goals and blockers.',
    transcript_segments:  [
      { speaker_name: 'Alice', text: 'Hello everyone.', start_ms: 0 },
      { speaker_name: 'Bob',   text: "Let's start.", start_ms: 3_000 },
    ],
    actions: [
      { text: 'Fix auth bug' },
      { text: 'Update docs' },
    ],
    participants: [{ display_name: 'Alice' }, { display_name: 'Bob' }],
    started_at:   '2026-09-25T10:00:00Z',
    ended_at:     '2026-09-25T11:00:00Z',
    duration_ms:  3_600_000,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  _native = false;
  clearLiveShareCache('ks-001');
  clearLiveShareCache('ks-no-cache');
  clearLiveShareCache('ks-live-state');
  clearLiveShareCache('ks-view-url');
  clearLiveShareCache('ks-content');
});

// ── Cache hit ──────────────────────────────────────────────────────────────

describe('openFinalizedSession — cache hit', () => {
  it('opens cached URL in browser and returns { kind: opened_url }', async () => {
    mockCreateLiveShare.mockResolvedValueOnce({
      room_id:    'room-abc',
      session_id: 'ks-001',
      share_url:  'https://eigenvertex.com/rooms/abc',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    const openWindowSpy = vi.fn();
    vi.stubGlobal('window', { open: openWindowSpy });

    await getLiveShareUrl('ks-001'); // prime cache
    vi.clearAllMocks();

    const result = await openFinalizedSession('ks-001');

    expect(result.kind).toBe('opened_url');
    expect(mockCreateLiveShare).not.toHaveBeenCalled();
    expect(mockGetLiveState).not.toHaveBeenCalled();
    expect(openWindowSpy).toHaveBeenCalledWith(
      'https://eigenvertex.com/rooms/abc',
      '_blank',
      'noopener,noreferrer',
    );
  });
});

// ── No cache + view_url in live-state → open Studio ───────────────────────

describe('openFinalizedSession — live-state has view_url', () => {
  it('opens view_url from live-state and returns { kind: opened_url }', async () => {
    const openWindowSpy = vi.fn();
    vi.stubGlobal('window', { open: openWindowSpy });

    mockGetLiveState.mockResolvedValueOnce(makeLiveState({
      view_url: 'https://app.eigenvertex.com/sessions/ks-view-url',
    }));

    const result = await openFinalizedSession('ks-view-url');

    expect(result.kind).toBe('opened_url');
    expect(openWindowSpy).toHaveBeenCalledWith(
      'https://app.eigenvertex.com/sessions/ks-view-url',
      '_blank',
      'noopener,noreferrer',
    );
    expect(mockCreateLiveShare).not.toHaveBeenCalled();
    expect(mockGetLiveState).toHaveBeenCalledWith('ks-view-url');
  });

  it('never falls through to live_state when view_url is present', async () => {
    vi.stubGlobal('window', { open: vi.fn() });
    mockGetLiveState.mockResolvedValueOnce(makeLiveState({
      view_url: 'https://app.eigenvertex.com/sessions/ks-view-url',
    }));

    const result = await openFinalizedSession('ks-view-url');

    expect(result.kind).toBe('opened_url');
  });
});

// ── No cache, no view_url → return live_state data ────────────────────────

describe('openFinalizedSession — no cache, no view_url', () => {
  it('calls GET /live-state and returns { kind: live_state, data }', async () => {
    const liveState = makeLiveState();
    mockGetLiveState.mockResolvedValueOnce(liveState);

    const result = await openFinalizedSession('ks-live-state');

    expect(result.kind).toBe('live_state');
    if (result.kind === 'live_state') {
      expect(result.data.status).toBe('finalized');
      expect(result.data.summary_text).toBe('Discussed Q3 goals and blockers.');
      expect(result.data.transcript_segments).toHaveLength(2);
      expect(result.data.transcript_segments![0].speaker_name).toBe('Alice');
      expect(result.data.actions).toHaveLength(2);
      expect(result.data.actions![0].text).toBe('Fix auth bug');
      expect(result.data.participants).toHaveLength(2);
    }
    expect(mockCreateLiveShare).not.toHaveBeenCalled();
    expect(mockGetLiveState).toHaveBeenCalledWith('ks-live-state');
  });

  it('returns live_state data without actions when absent', async () => {
    mockGetLiveState.mockResolvedValueOnce(makeLiveState({ actions: null }));

    const result = await openFinalizedSession('ks-no-cache');

    expect(result.kind).toBe('live_state');
    if (result.kind === 'live_state') {
      expect(result.data.actions).toBeNull();
      expect(result.data.summary_text).toBeTruthy();
    }
  });

  it('never opens a browser window when returning live_state', async () => {
    mockGetLiveState.mockResolvedValueOnce(makeLiveState({ summary_text: null, transcript_segments: null }));
    const openWindowSpy = vi.fn();
    vi.stubGlobal('window', { open: openWindowSpy });

    await openFinalizedSession('ks-no-cache');

    expect(openWindowSpy).not.toHaveBeenCalled();
  });
});

// ── getCachedLiveShareUrl ──────────────────────────────────────────────────

describe('getCachedLiveShareUrl', () => {
  it('returns null before any getLiveShareUrl call', () => {
    expect(getCachedLiveShareUrl('ks-fresh')).toBeNull();
  });

  it('returns share_url after getLiveShareUrl populates the cache', async () => {
    mockCreateLiveShare.mockResolvedValueOnce({
      room_id:    'room-xyz',
      session_id: 'ks-001',
      share_url:  'https://eigenvertex.com/rooms/xyz',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });

    await getLiveShareUrl('ks-001');

    expect(getCachedLiveShareUrl('ks-001')).toBe('https://eigenvertex.com/rooms/xyz');
  });
});

// ── shareSessionContent ──────────────────────────────────────────────────────
//
// content_url's name and contract are confirmed with the backend — it points
// at Studio's /meetings/{sessionId}/post-treatment route, served absolute and
// verbatim — but it is not deployed yet. These tests pin the contract on both
// sides of that: without the field, the feature must announce itself as
// unavailable rather than silently sharing shareLiveRoom's Live Room URL,
// which would send recipients to the wrong page; once deployed, the
// 'content_url present' tests below describe exactly the behavior that
// activates, with no other Pocket change required.

describe('shareSessionContent — content_url not deployed yet', () => {
  it('returns unavailable when content_url is absent, for a live session', async () => {
    mockGetLiveState.mockResolvedValueOnce(makeLiveState({ status: 'recording', content_url: null }));

    const result = await shareSessionContent('ks-content', 'Sprint review');

    expect(result.kind).toBe('unavailable');
    expect(mockShareShare).not.toHaveBeenCalled();
  });

  it('returns unavailable for a stopped/synced session too — content_url is state-independent', async () => {
    mockGetLiveState.mockResolvedValueOnce(makeLiveState({ status: 'finalized', content_url: undefined }));

    const result = await shareSessionContent('ks-content', 'Sprint review');

    expect(result.kind).toBe('unavailable');
  });

  it('never falls back to view_url when content_url is missing', async () => {
    mockGetLiveState.mockResolvedValueOnce(makeLiveState({
      content_url: null,
      view_url:    'https://app.eigenvertex.com/rooms/live-room-only',
    }));

    const result = await shareSessionContent('ks-content', 'Sprint review');

    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(JSON.stringify(result)).not.toContain('live-room-only');
  });
});

describe('shareSessionContent — content_url present (once backend deploys it)', () => {
  it('shares content_url via native share on iOS, not view_url', async () => {
    _native = true;
    mockGetLiveState.mockResolvedValueOnce(makeLiveState({
      content_url: 'https://app.eigenvertex.com/meetings/ks-content/post-treatment',
      view_url:    'https://app.eigenvertex.com/rooms/live-room-only',
    }));

    const result = await shareSessionContent('ks-content', 'Sprint review');

    expect(result).toEqual({
      kind:   'shared',
      url:    'https://app.eigenvertex.com/meetings/ks-content/post-treatment',
      method: 'native_share',
    });
    expect(mockShareShare).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://app.eigenvertex.com/meetings/ks-content/post-treatment' }),
    );
  });

  it('copies content_url to the clipboard on web', async () => {
    const clipboardSpy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText: clipboardSpy } });
    mockGetLiveState.mockResolvedValueOnce(makeLiveState({
      content_url: 'https://app.eigenvertex.com/meetings/ks-content/post-treatment',
    }));

    const result = await shareSessionContent('ks-content', 'Sprint review');

    expect(result.kind).toBe('shared');
    expect(clipboardSpy).toHaveBeenCalledWith('https://app.eigenvertex.com/meetings/ks-content/post-treatment');
    expect(mockShareShare).not.toHaveBeenCalled();
  });

  it('works for a finalized/synced session, not just a live one', async () => {
    mockGetLiveState.mockResolvedValueOnce(makeLiveState({
      status:      'finalized',
      content_url: 'https://app.eigenvertex.com/meetings/ks-content/post-treatment',
    }));
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

    const result = await shareSessionContent('ks-content', 'Sprint review');

    expect(result.kind).toBe('shared');
  });
});

describe('shareSessionContent — errors', () => {
  it('returns a readable error when GET /live-state fails (e.g. unauthenticated)', async () => {
    mockGetLiveState.mockRejectedValueOnce(new Error('401 Unauthorized'));

    const result = await shareSessionContent('ks-content', 'Sprint review');

    expect(result).toEqual({ kind: 'error', message: '401 Unauthorized' });
    expect(mockShareShare).not.toHaveBeenCalled();
  });
});
