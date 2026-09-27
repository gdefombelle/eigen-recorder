// Secure storage abstraction — Keychain (iOS) / EncryptedSharedPreferences
// (Android) / localStorage on web.
//
// Three backends behind one interface, so the same call works on every target:
//
//   web / PWA → localStorage. No Keychain exists; this is the only option.
//   iOS       → EigenAudioPlugin's Security-framework methods, compiled
//               straight into the App target.
//   Android   → capacitor-secure-storage-plugin, which has a working Android
//               implementation (EncryptedSharedPreferences).
//
// iOS used to go through capacitor-secure-storage-plugin too, but on device its
// bridge call never returned — Settings › Diagnostics reported "Keychain read
// exceeded 5000ms". Since every token refresh begins with a Keychain read, that
// stalled the whole auth path and sessions died silently after 15 minutes. The
// iOS path now uses the plugin that is already proven in production here (audio
// capture, dictation), which does not depend on SPM plugin discovery.
//
// Every backend call is bounded: a storage backend that stops answering must
// surface as an error, never as a hang that blocks auth behind it.

import { isNative, isIOS } from '$lib/platform';

const OP_TIMEOUT_MS = 5_000;

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${OP_TIMEOUT_MS}ms`)), OP_TIMEOUT_MS);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Android (and any future non-iOS native target). */
async function communityPlugin() {
  try {
    const { SecureStoragePlugin } = await import('capacitor-secure-storage-plugin');
    return SecureStoragePlugin;
  } catch {
    return null;
  }
}

export async function secureSave(key: string, value: string): Promise<void> {
  if (!isNative()) {
    try { localStorage.setItem(`_sec_${key}`, value); } catch { /* ignore */ }
    return;
  }
  if (isIOS()) {
    const { EigenAudio } = await import('$lib/plugins/eigenAudio');
    await withTimeout(EigenAudio.keychainSet({ key, value }), 'Keychain write');
    return;
  }
  const plugin = await communityPlugin();
  if (plugin) await withTimeout(plugin.set({ key, value }), 'Secure storage write');
}

export async function secureGet(key: string): Promise<string | null> {
  if (!isNative()) {
    try { return localStorage.getItem(`_sec_${key}`); } catch { return null; }
  }
  if (isIOS()) {
    const { EigenAudio } = await import('$lib/plugins/eigenAudio');
    const { value } = await withTimeout(EigenAudio.keychainGet({ key }), 'Keychain read');
    return value ?? null;
  }
  const plugin = await communityPlugin();
  if (!plugin) return null;
  try {
    const { value } = await withTimeout(plugin.get({ key }), 'Secure storage read');
    return value ?? null;
  } catch {
    return null; // key not found, or backend unavailable
  }
}

export async function secureRemove(key: string): Promise<void> {
  if (!isNative()) {
    try { localStorage.removeItem(`_sec_${key}`); } catch { /* ignore */ }
    return;
  }
  if (isIOS()) {
    const { EigenAudio } = await import('$lib/plugins/eigenAudio');
    await withTimeout(EigenAudio.keychainRemove({ key }), 'Keychain delete');
    return;
  }
  const plugin = await communityPlugin();
  if (plugin) {
    try { await withTimeout(plugin.remove({ key }), 'Secure storage delete'); }
    catch { /* ignore if key missing */ }
  }
}
