// Auth state — Svelte 4 writable store, aligned with scanner-app EVUser contract.
// Drop-in compatible: same TOKEN_KEY, same EVUser shape, same helper functions.

import { writable, get, derived } from 'svelte/store';

const TOKEN_KEY = 'ev_token';

export interface EVUser {
  readonly token:             string;
  readonly email:             string;
  readonly name?:             string;
  readonly expiresAt:         number; // Unix ms
  // PKCE fields — present after OAuth 2.1 login, absent for legacy password sessions
  readonly refreshToken?:      string;
  readonly rotationFamilyId?:  string;
}

const _user = writable<EVUser | null>(null);

// Reactive store — subscribe in components: $authStore
export const authStore = { subscribe: _user.subscribe };

// Bootstrap gate: false until initAuth() + the first silent refresh have settled.
// The UI must distinguish "still restoring the session" from "logged out",
// otherwise gates evaluated during startup lock out an authenticated user.
const _authReady = writable(false);
export const authReadyStore = { subscribe: _authReady.subscribe };
export function setAuthReady(ready: boolean): void { _authReady.set(ready); }

/**
 * Reactive "a session exists" gate — use this for UI, not isAuthenticated().
 *
 * Deliberately does NOT test access-token expiry: an expired access token is
 * renewed transparently by ensureFreshToken() before the next request, so
 * gating UI on expiry makes it flap to "logged out" every 15 minutes.
 */
export const hasSessionStore = derived(_user, (u) => u !== null);

/**
 * Three-state auth gate for UI that offers a sign-in call to action.
 *
 * 'restoring' exists so a sign-in prompt is never shown while the session is
 * still being recovered from the Keychain — that flash is what made the app
 * look logged out to an authenticated user.
 */
export type AuthPhase = 'restoring' | 'authed' | 'anonymous';

export const authPhaseStore = derived(
  [_user, _authReady],
  ([u, ready]): AuthPhase => (u !== null ? 'authed' : ready ? 'anonymous' : 'restoring'),
);

export function getUser(): EVUser | null {
  return get(_user);
}

/** Imperative check that the ACCESS token is currently live. For UI gating use hasSessionStore. */
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
    // Restore the session even when the access token has already expired: the
    // Keychain refresh token can still renew it, and api.ts only attempts a
    // refresh when a user is present (`if (!getUser()) return`). Dropping the
    // user here is what silently forced a re-login on every cold start.
    if (user) _user.set(user);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}
