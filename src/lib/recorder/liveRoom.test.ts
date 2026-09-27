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

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('$lib/platform', () => ({ isNative: () => false }));
vi.mock('./knowledgeSessionApi', () => ({
  createLiveShare: vi.fn(),
  getLiveState:    vi.fn(),
}));

import { createLiveShare, getLiveState } from './knowledgeSessionApi';
import type { LiveStateResponse } from './knowledgeSessionApi';
import {
  getLiveShareUrl,
  getCachedLiveShareUrl,
  openFinalizedSession,
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
  clearLiveShareCache('ks-001');
  clearLiveShareCache('ks-no-cache');
  clearLiveShareCache('ks-live-state');
  clearLiveShareCache('ks-view-url');
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
