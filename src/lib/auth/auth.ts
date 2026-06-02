// Auth state — Svelte 4 writable store, aligned with scanner-app EVUser contract.
// Drop-in compatible: same TOKEN_KEY, same EVUser shape, same helper functions.

import { writable, get } from 'svelte/store';

const TOKEN_KEY = 'ev_token';

export interface EVUser {
  readonly token:     string;
  readonly email:     string;
  readonly name?:     string;
  readonly expiresAt: number; // Unix ms
}

const _user = writable<EVUser | null>(null);

// Reactive store — subscribe in components: $authStore
export const authStore = { subscribe: _user.subscribe };

export function getUser(): EVUser | null {
  return get(_user);
}

export function isAuthenticated(): boolean {
  const u = get(_user);
  return u !== null && Date.now() < u.expiresAt;
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const [, payload] = token.split('.');
    return JSON.parse(atob(payload!.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

export function tokenToUser(token: string): EVUser | null {
  const payload = decodeJwt(token);
  if (!payload) return null;
  const exp =
    typeof payload['exp'] === 'number'
      ? payload['exp'] * 1000
      : Date.now() + 3_600_000;
  return {
    token,
    email:     String(payload['email'] ?? payload['sub'] ?? ''),
    name:      typeof payload['name'] === 'string' ? payload['name'] : undefined,
    expiresAt: exp,
  };
}

export function setUser(user: EVUser): void {
  _user.set(user);
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify(user)); } catch { /* ignore */ }
}

export function clearUser(): void {
  _user.set(null);
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

export function initAuth(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return;
    let user: EVUser | null = null;
    try {
      const parsed = JSON.parse(raw);
      user = parsed && typeof parsed.token === 'string' ? (parsed as EVUser) : null;
    } catch {
      user = tokenToUser(raw); // legacy: raw JWT string
    }
    if (user && Date.now() < user.expiresAt) {
      _user.set(user);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch { /* ignore */ }
}
