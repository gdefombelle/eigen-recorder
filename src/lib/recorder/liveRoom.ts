// liveRoom.ts — open the Live Room web UI for a knowledge session.
//
// Uses @capacitor/browser (in-app SFSafariViewController on iOS) when running
// natively, and window.open('_blank') in a browser context. This is the same
// approach as the PKCE OAuth flow (pkceFlow.ts) — no extra dependency needed.
//
// Usage:
//   await openLiveRoom(knowledgeSessionId);
//   // or, if you already have the URL:
//   await openLiveRoomUrl('https://app.eigenvertex.com/rooms/…');

import { getRoomForSession } from './knowledgeSessionApi';
import { isNative } from '$lib/platform';

/**
 * Open the Live Room for the given knowledge session ID.
 * Fetches the Room URL from the backend, then opens it.
 * Throws if the session has no Room yet (backend 404).
 */
export async function openLiveRoom(knowledgeSessionId: string): Promise<void> {
  const room = await getRoomForSession(knowledgeSessionId);
  await openLiveRoomUrl(room.url);
}

/**
 * Open an already-resolved Room URL.
 * Prefers in-app SFSafariViewController on iOS (Capacitor Browser),
 * falls back to window.open on web.
 */
export async function openLiveRoomUrl(url: string): Promise<void> {
  if (isNative()) {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url, windowName: '_blank' });
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
