// Secure storage abstraction — Keychain (iOS) / EncryptedSharedPreferences (Android)
// Falls back to localStorage on web (non-native) for local dev.
//
// Uses capacitor-secure-storage-plugin.
// On iOS the plugin stores values in the app's Keychain, which survives app updates.

import { isNative } from '$lib/platform';

// Dynamic import so the bundle doesn't fail on web/SSR
async function getPlugin() {
  if (!isNative()) return null;
  try {
    const { SecureStoragePlugin } = await import('capacitor-secure-storage-plugin');
    return SecureStoragePlugin;
  } catch {
    return null;
  }
}

export async function secureSave(key: string, value: string): Promise<void> {
  const plugin = await getPlugin();
  if (plugin) {
    await plugin.set({ key, value });
  } else {
    try { localStorage.setItem(`_sec_${key}`, value); } catch { /* ignore */ }
  }
}

export async function secureGet(key: string): Promise<string | null> {
  const plugin = await getPlugin();
  if (plugin) {
    try {
      const { value } = await plugin.get({ key });
      return value ?? null;
    } catch {
      return null; // key not found
    }
  } else {
    try { return localStorage.getItem(`_sec_${key}`); } catch { return null; }
  }
}

export async function secureRemove(key: string): Promise<void> {
  const plugin = await getPlugin();
  if (plugin) {
    try { await plugin.remove({ key }); } catch { /* ignore if key missing */ }
  } else {
    try { localStorage.removeItem(`_sec_${key}`); } catch { /* ignore */ }
  }
}
