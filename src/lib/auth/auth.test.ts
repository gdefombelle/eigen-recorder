/**
 * Tests for auth.ts session restoration.
 *
 * Regression guard for the re-login loop: initAuth() used to DELETE the stored
 * user as soon as its 15-minute access token had expired. Because api.ts only
 * attempts a refresh when a user is present (`if (!getUser()) return`), that
 * deletion meant requests went out unauthenticated and the Keychain refresh
 * token — valid for weeks — was never used.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';

import {
  initAuth,
  clearUser,
  setUser,
  getUser,
  isAuthenticated,
  hasSessionStore,
  authReadyStore,
  setAuthReady,
  type EVUser,
} from './auth';

const TOKEN_KEY = 'ev_token';

// Minimal in-memory localStorage — the default vitest environment is node.
function installStorage(seed?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  vi.stubGlobal('localStorage', {
    getItem:    (k: string) => store.get(k) ?? null,
    setItem:    (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  return store;
}

function makeUser(overrides?: Partial<EVUser>): EVUser {
  return {
    token:        'evtxa_access_token',
    email:        'user@example.com',
    expiresAt:    Date.now() + 15 * 60_000,
    refreshToken: 'evtxr_refresh_token',
    ...overrides,
  };
}

beforeEach(() => {
  installStorage();
  clearUser();
  setAuthReady(false);
});

// ── Expired access token must NOT end the session ──────────────────────────

describe('initAuth — expired access token', () => {
  it('restores the user even when the access token has already expired', () => {
    const expired = makeUser({ expiresAt: Date.now() - 60_000 });
    installStorage({ [TOKEN_KEY]: JSON.stringify(expired) });

    initAuth();

    // Present, so api.ts will attempt a silent refresh on the next request.
    expect(getUser()).not.toBeNull();
    expect(getUser()?.email).toBe('user@example.com');
    // ...but the access token itself is correctly reported as stale.
    expect(isAuthenticated()).toBe(false);
  });

  it('keeps the stored session in localStorage instead of deleting it', () => {
    const expired = makeUser({ expiresAt: Date.now() - 60_000 });
    const store = installStorage({ [TOKEN_KEY]: JSON.stringify(expired) });

    initAuth();

    expect(store.get(TOKEN_KEY)).toBeDefined();
  });

  it('restores a still-valid session as authenticated', () => {
    installStorage({ [TOKEN_KEY]: JSON.stringify(makeUser()) });

    initAuth();

    expect(isAuthenticated()).toBe(true);
  });

  it('clears malformed stored data', () => {
    const store = installStorage({ [TOKEN_KEY]: '{"not":"a user"}' });

    initAuth();

    expect(getUser()).toBeNull();
    expect(store.get(TOKEN_KEY)).toBeUndefined();
  });
});

// ── UI gate ────────────────────────────────────────────────────────────────

describe('hasSessionStore', () => {
  it('is false with no session', () => {
    expect(get(hasSessionStore)).toBe(false);
  });

  it('stays true while the access token is expired, so the UI does not flap', () => {
    setUser(makeUser({ expiresAt: Date.now() - 60_000 }));

    expect(get(hasSessionStore)).toBe(true);
    expect(isAuthenticated()).toBe(false);
  });

  it('returns to false after logout', () => {
    setUser(makeUser());
    expect(get(hasSessionStore)).toBe(true);

    clearUser();
    expect(get(hasSessionStore)).toBe(false);
  });
});

// ── Bootstrap gate ─────────────────────────────────────────────────────────

describe('authReadyStore', () => {
  it('starts false and flips once bootstrap settles', () => {
    expect(get(authReadyStore)).toBe(false);
    setAuthReady(true);
    expect(get(authReadyStore)).toBe(true);
  });
});
