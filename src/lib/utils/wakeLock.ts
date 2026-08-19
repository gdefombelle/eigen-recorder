// Screen wake lock — keeps the display on during recording and pause.
//
// Primary: Screen Wake Lock API (navigator.wakeLock) — Chrome 84+, Safari 16.4+,
//          WKWebView 16.4+ (works in the Capacitor iOS app on iOS 16.4+).
// Fallback: EigenAudio.setKeepAwake() → UIApplication.isIdleTimerDisabled
//           for iOS < 16.4 native builds.
//
// The browser releases the lock automatically when the tab/app goes to background.
// Call reacquireIfNeeded() on the visibilitychange event to re-take it.

import { isNative } from '$lib/platform';
import { EigenAudio } from '$lib/plugins/eigenAudio';

let _lock: WakeLockSentinel | null = null;
let _nativeFallback = false;

export async function acquireWakeLock(): Promise<void> {
  if (_lock && !_lock.released) return; // already held

  if ('wakeLock' in navigator) {
    try {
      _lock = await navigator.wakeLock.request('screen');
      _nativeFallback = false;
      return;
    } catch {
      // Denied (e.g. battery saver mode) or not available — try native fallback
    }
  }

  if (isNative()) {
    try {
      await EigenAudio.setKeepAwake({ enabled: true });
      _nativeFallback = true;
    } catch { /* non-critical — screen may still dim */ }
  }
}

export async function releaseWakeLock(): Promise<void> {
  if (_lock) {
    try { await _lock.release(); } catch { /* ignore */ }
    _lock = null;
  }
  if (_nativeFallback) {
    try { await EigenAudio.setKeepAwake({ enabled: false }); } catch { /* ignore */ }
    _nativeFallback = false;
  }
}

// Call on document visibilitychange: browser releases lock when app goes to
// background, so we must re-acquire when it comes back to the foreground.
export async function reacquireIfNeeded(shouldBeActive: boolean): Promise<void> {
  if (!shouldBeActive) return;
  if (!_lock || _lock.released) {
    await acquireWakeLock();
  }
}
