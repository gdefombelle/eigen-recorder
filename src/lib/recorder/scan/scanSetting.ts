// scanSetting — the opt-in for "Scan a document" (Réglages → Diagnostics → « Scanner un document (expérimental) »).
//
// OFF by default, and it must stay off by default until the step-4 device gate has passed (see
// docs/scan-step4-gate.md): a build shipped to other users shows no scanner entry unless this is switched on.
// Per-device (localStorage); never read by anything that must keep working without it.

export const SCAN_SETTING_KEY = 'ev_scan_enabled';

export interface KeyValue { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

function defaultStore(): KeyValue | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function isScanEnabled(kv: KeyValue | null = defaultStore()): boolean {
  try { return kv?.getItem(SCAN_SETTING_KEY) === '1'; } catch { return false; }
}

export function setScanEnabled(enabled: boolean, kv: KeyValue | null = defaultStore()): void {
  try { enabled ? kv?.setItem(SCAN_SETTING_KEY, '1') : kv?.removeItem(SCAN_SETTING_KEY); } catch { /* blocked storage: stays off */ }
}
