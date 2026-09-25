/**
 * Tests for liveRoom.ts — openFinalizedSession behaviour.
 *  - Cache hit: opens cached URL in browser, returns { kind: 'opened_url' }, no POST
 *  - No cache: calls GET /live-state (read-only), returns { kind: 'live_state', data }
 *  - Never calls POST /live-share for a finalized session
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

function makeLiveState(overrides?: Partial<LiveStateResponse>): LiveStateResponse {
  return {
    status:       'finalized',
    title:        'Sprint review',
    summary:      'Discussed Q3 goals and blockers.',
    transcript:   'Alice: Hello everyone.\nBob: Let\'s start.',
    action_items: ['Fix auth bug', 'Update docs'],
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

// ── No cache → GET /live-state ─────────────────────────────────────────────

describe('openFinalizedSession — no cache', () => {
  it('calls GET /live-state and returns { kind: live_state, data }', async () => {
    const liveState = makeLiveState();
    mockGetLiveState.mockResolvedValueOnce(liveState);

    const result = await openFinalizedSession('ks-live-state');

    expect(result.kind).toBe('live_state');
    if (result.kind === 'live_state') {
      expect(result.data.status).toBe('finalized');
      expect(result.data.summary).toBe('Discussed Q3 goals and blockers.');
      expect(result.data.participants).toHaveLength(2);
    }
    expect(mockCreateLiveShare).not.toHaveBeenCalled();
    expect(mockGetLiveState).toHaveBeenCalledWith('ks-live-state');
  });

  it('returns live_state data without action_items when absent', async () => {
    mockGetLiveState.mockResolvedValueOnce(makeLiveState({ action_items: null }));

    const result = await openFinalizedSession('ks-no-cache');

    expect(result.kind).toBe('live_state');
    if (result.kind === 'live_state') {
      expect(result.data.action_items).toBeNull();
      expect(result.data.summary).toBeTruthy();
    }
  });

  it('never opens a browser window when returning live_state', async () => {
    mockGetLiveState.mockResolvedValueOnce(makeLiveState({ summary: null, transcript: null }));
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
