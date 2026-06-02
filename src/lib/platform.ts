// Platform detection — copie exacte de scanner-app/src/lib/platform.ts
// Capacitor injecte un global `Capacitor` dans le WebView natif.
// Sur le web/PWA : toutes les fonctions renvoient 'web' / false.

declare const Capacitor: { isNativePlatform(): boolean; getPlatform(): string } | undefined;

export function isNative(): boolean {
  return typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform();
}

export function getPlatform(): 'ios' | 'android' | 'web' {
  if (typeof Capacitor === 'undefined') return 'web';
  const p = Capacitor.getPlatform();
  if (p === 'ios')     return 'ios';
  if (p === 'android') return 'android';
  return 'web';
}

export function isIOS(): boolean     { return getPlatform() === 'ios'; }
export function isAndroid(): boolean { return getPlatform() === 'android'; }
export function isWeb(): boolean     { return getPlatform() === 'web'; }
