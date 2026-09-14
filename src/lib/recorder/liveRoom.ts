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

import { createLiveShare } from './knowledgeSessionApi';
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

// ── Open ───────────────────────────────────────────────────────────────────

/**
 * Open the Live Room for a session in the system browser.
 * Fetches (or returns cached) share_url, then opens it.
 * On iOS Capacitor: uses SFSafariViewController (@capacitor/browser).
 * On web: uses window.open (not window.location.href — blocked in WKWebView).
 */
export async function openLiveRoom(knowledgeSessionId: string): Promise<void> {
  const url = await getLiveShareUrl(knowledgeSessionId);
  await openLiveRoomUrl(url);
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
