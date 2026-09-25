// liveRoom.ts — Live Room share link: fetch, cache, open, share.
//
// Contract: POST /v1/knowledge-sessions/{session_id}/live-share
//   → { room_id, session_id, share_url, expires_at }
//
// share_url is built ONCE on the server and must be used verbatim — never
// reconstruct it from a token, session id, or title.
//
// Cache: per-session in memory for the lifetime of the app session. The cache
// is only invalidated by explicit revocation confirmed by the server (revokeLiveShare),
// never by client-side expiry calculation. The server is the authority.
//
// Opening: @capacitor/browser (SFSafariViewController on iOS) on native;
//           window.open on web. Never window.location.href (blocked in WKWebView).
//
// Sharing: @capacitor/share (native UIActivityViewController) on iOS — reliable,
//           unlike navigator.share() in WKWebView which is non-deterministic.
//           Falls back to Clipboard API on web.

import { createLiveShare, getLiveState } from './knowledgeSessionApi';
import type { LiveStateResponse } from './knowledgeSessionApi';
import { isNative } from '$lib/platform';

// ── In-memory cache ────────────────────────────────────────────────────────
// Keyed by knowledge_session_id (backend UUID).
// Value: the full LiveShareResponse from the last successful POST /live-share.
// Cleared only by revokeLiveShare(); never by expires_at comparison.

const _shareCache = new Map<string, { share_url: string; expires_at: string }>();

/**
 * Get the Live Room share URL for a session.
 * Returns the cached URL if available; otherwise calls POST /live-share.
 * The returned URL is always the server-provided value — never reconstructed locally.
 */
export async function getLiveShareUrl(knowledgeSessionId: string): Promise<string> {
  const cached = _shareCache.get(knowledgeSessionId);
  if (cached) return cached.share_url;

  const share = await createLiveShare(knowledgeSessionId);
  _shareCache.set(knowledgeSessionId, {
    share_url:  share.share_url,
    expires_at: share.expires_at,
  });
  return share.share_url;
}

/**
 * Clear the cached share URL for a session — call ONLY after server-confirmed revocation.
 */
export function clearLiveShareCache(knowledgeSessionId: string): void {
  _shareCache.delete(knowledgeSessionId);
}

/**
 * Return the cached Live Room URL without any API call.
 * Returns null if the URL was never fetched this app session.
 */
export function getCachedLiveShareUrl(knowledgeSessionId: string): string | null {
  return _shareCache.get(knowledgeSessionId)?.share_url ?? null;
}

// ── Open ───────────────────────────────────────────────────────────────────

/**
 * Open the Live Room for an ACTIVE (recording/paused) session.
 * Fetches (or returns cached) share_url via POST /live-share, then opens it.
 * Only call this while the session is active — use openFinalizedSession() after stop.
 */
export async function openLiveRoom(knowledgeSessionId: string): Promise<void> {
  const url = await getLiveShareUrl(knowledgeSessionId);
  await openLiveRoomUrl(url);
}

export type FinalizedSessionResult =
  /** Cache hit from active phase — share URL was opened in the system browser. */
  | { kind: 'opened_url' }
  /** No cached URL — live-state data returned for in-app rendering. */
  | { kind: 'live_state'; data: LiveStateResponse };

/**
 * Open or display a finalized (stopped/synced) session.
 * Never calls POST /live-share.
 *
 * Two paths:
 *  1. Cache hit (session was active this app session): opens the cached share URL
 *     in the system browser and returns { kind: 'opened_url' }.
 *  2. No cache: fetches GET /live-state (read-only, no side effects) and returns
 *     { kind: 'live_state', data } for the caller to render in-app.
 *     The backend returns transcript, summary, participants — no public share URL.
 */
export async function openFinalizedSession(knowledgeSessionId: string): Promise<FinalizedSessionResult> {
  const cached = getCachedLiveShareUrl(knowledgeSessionId);
  if (cached) {
    await openLiveRoomUrl(cached);
    return { kind: 'opened_url' };
  }
  const data = await getLiveState(knowledgeSessionId);
  return { kind: 'live_state', data };
}

/**
 * Open a resolved Live Room URL.
 * Never call with a URL you constructed locally — only with server-provided values.
 */
export async function openLiveRoomUrl(url: string): Promise<void> {
  if (!url || !url.startsWith('http')) {
    throw new Error(`Invalid Live Room URL: "${url}"`);
  }
  if (isNative()) {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url, windowName: '_blank' });
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

// ── Share ──────────────────────────────────────────────────────────────────

/**
 * Share the Live Room link for a session.
 *
 * On iOS Capacitor: uses @capacitor/share (UIActivityViewController) — reliable,
 * deterministic, shows Mail/Messages/AirDrop/etc. natively.
 * Unlike navigator.share() in a WKWebView, the native Share plugin outcome is
 * predictable from the calling code.
 *
 * On web: copies to clipboard (Clipboard API) with a visible confirmation.
 * Does NOT use navigator.share() — non-deterministic in embedded WebViews.
 * Does NOT use window.location.href = "mailto:..." — silently blocked in WKWebView.
 *
 * Returns the share_url that was shared (for showing a confirmation toast).
 */
export async function shareLiveRoom(
  knowledgeSessionId: string,
  sessionTitle: string,
): Promise<{ url: string; method: 'native_share' | 'clipboard' }> {
  const url = await getLiveShareUrl(knowledgeSessionId);

  if (isNative()) {
    const { Share } = await import('@capacitor/share');
    await Share.share({
      title:         `Live Room — ${sessionTitle}`,
      text:          `Rejoins la Live Room : ${sessionTitle}`,
      url,
      dialogTitle:   'Partager la Live Room',
    });
    return { url, method: 'native_share' };
  } else {
    // Web fallback: clipboard
    await navigator.clipboard.writeText(url);
    return { url, method: 'clipboard' };
  }
}
