// Server URL config — localStorage-based, scanner-app contract.

const SERVER_URL_KEY = 'ev_server_url';

export const DEFAULT_SERVER_URL: string = import.meta.env.DEV
  ? 'http://127.0.0.1:8100'
  : 'https://api.eigenvertex.com';

let _override: string | null = null;

export function getDefaultServerUrl(): string {
  return DEFAULT_SERVER_URL;
}

export function getServerUrl(): string {
  return _override ?? DEFAULT_SERVER_URL;
}

export function isProxyMode(): boolean {
  return import.meta.env.DEV && _override === null;
}

/** For fetch() calls — uses Vite proxy in dev. */
export function getApiBase(): string {
  if (_override) return `${_override}/v1`;
  if (import.meta.env.DEV) return '/api/v1';
  return `${DEFAULT_SERVER_URL}/v1`;
}

/** For browser navigations (OAuth redirect) — always absolute. */
export function getDirectApiBase(): string {
  return `${_override ?? DEFAULT_SERVER_URL}/v1`;
}

export function setServerUrl(url: string): void {
  const clean = url.trim().replace(/\/+$/, '');
  _override = clean;
  try { localStorage.setItem(SERVER_URL_KEY, clean); } catch { /* ignore */ }
}

export function resetServerUrl(): void {
  _override = null;
  try { localStorage.removeItem(SERVER_URL_KEY); } catch { /* ignore */ }
}

export function loadConfig(): void {
  try {
    const stored = localStorage.getItem(SERVER_URL_KEY);
    if (stored && stored.trim()) _override = stored.trim();
  } catch { /* ignore */ }
}
