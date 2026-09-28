/**
 * Tests for pkceFlow.ts auth fixes:
 *  - single-flight silentRefresh (concurrent callers share one token request)
 *  - Keychain save failure (remove consumed token; block refresh when both fail)
 *  - ensureFreshToken proactive refresh (skips fetch when token is fresh)
 *  - email/name preserved from existing user on token rotation
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { get } from 'svelte/store';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('./secureStorage', () => ({
  secureGet:    vi.fn(),
  secureSave:   vi.fn(),
  secureRemove: vi.fn(),
}));

vi.mock('$lib/platform', () => ({ isNative: () => false }));

// auth store mock — keeps a mutable user so setUser() is observable
let _mockUser: import('./auth').EVUser | null = null;
vi.mock('./auth', () => ({
  getUser:    vi.fn(() => _mockUser),
  setUser:    vi.fn((u: import('./auth').EVUser) => { _mockUser = u; }),
  clearUser:  vi.fn(() => { _mockUser = null; }),
}));

import { secureGet, secureSave, secureRemove } from './secureStorage';
import { getUser, setUser, clearUser } from './auth';
import { silentRefresh, ensureFreshToken, keychainErrorStore, _resetForTests } from './pkceFlow';
import type { EVUser } from './auth';

const mockSecureGet    = secureGet    as ReturnType<typeof vi.fn>;
const mockSecureSave   = secureSave   as ReturnType<typeof vi.fn>;
const mockSecureRemove = secureRemove as ReturnType<typeof vi.fn>;
const mockGetUser      = getUser      as ReturnType<typeof vi.fn>;
const mockSetUser      = setUser      as ReturnType<typeof vi.fn>;
const mockClearUser    = clearUser    as ReturnType<typeof vi.fn>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTokenBody(
  accessToken  = 'evtxa_new',
  refreshToken = 'evtxr_new',
  expiresIn    = 3600,
) {
  return { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn };
}

function makeFetchOk(body: object) {
  return vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(body) });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  _mockUser = null;
  vi.clearAllMocks();
  // clearAllMocks() does NOT undo mockReturnValue()/mockImplementation(): a few
  // tests below pin getUser() to a fixed value, and that override would leak
  // into every later test, making getUser() ignore setUser() for the rest of
  // the file. Restore the live behaviour explicitly.
  mockGetUser.mockReset();
  mockGetUser.mockImplementation(() => _mockUser);
  _resetForTests(); // reset _keychainBroken flag and keychainErrorStore between tests
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('silentRefresh — single-flight', () => {
  it('concurrent calls share one token request', async () => {
    mockSecureGet.mockResolvedValue('evtxr_stored');
    mockSecureSave.mockResolvedValue(undefined);
    _mockUser = { email: 'user@test.com', name: 'Test', token: 'evtxa_old', expiresAt: 0 };

    let fetchCallCount = 0;
    let resolveFirstFetch!: (v: object) => void;
    const gate = new Promise<object>(r => { resolveFirstFetch = r; });

    vi.stubGlobal('fetch', vi.fn(() => {
      fetchCallCount++;
      return gate.then(body => ({ ok: true, json: () => Promise.resolve(body) }));
    }));

    // Two concurrent refresh calls before the HTTP response arrives
    const p1 = silentRefresh();
    const p2 = silentRefresh();

    resolveFirstFetch(makeTokenBody('evtxa_shared', 'evtxr_shared'));

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(fetchCallCount).toBe(1);
    expect(r1).toBe(r2); // same Promise, same result object
    expect(r1?.token).toBe('evtxa_shared');
  });

  it('second call after completion starts a fresh request', async () => {
    mockSecureGet.mockResolvedValue('evtxr_stored');
    mockSecureSave.mockResolvedValue(undefined);
    _mockUser = { email: 'u@t.com', name: undefined, token: 'evtxa_old', expiresAt: 0 };

    vi.stubGlobal('fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(makeTokenBody('evtxa_first')) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(makeTokenBody('evtxa_second')) }),
    );

    const r1 = await silentRefresh();
    _mockUser = { ...r1!, expiresAt: 0 };
    const r2 = await silentRefresh();

    expect(r1?.token).toBe('evtxa_first');
    expect(r2?.token).toBe('evtxa_second');
  });
});

describe('silentRefresh — Keychain save failure', () => {
  it('removes consumed token from Keychain when save fails, returns fresh user', async () => {
    mockSecureGet.mockResolvedValue('evtxr_stored');
    mockSecureSave.mockRejectedValue(new Error('Keychain unavailable'));
    mockSecureRemove.mockResolvedValue(undefined);
    _mockUser = { email: 'u@test.com', name: 'Test User', token: 'evtxa_old', expiresAt: 0 };

    vi.stubGlobal('fetch', makeFetchOk(makeTokenBody('evtxa_fresh', 'evtxr_new')));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const user = await silentRefresh();

    expect(user).not.toBeNull();
    expect(user?.token).toBe('evtxa_fresh');
    expect(user?.email).toBe('u@test.com');
    expect(user?.name).toBe('Test User');
    // Stale consumed token removed from Keychain to prevent replay
    expect(mockSecureRemove).toHaveBeenCalledWith('pkce_refresh_token');
  });

  it('sets keychainErrorStore and blocks refresh when both save and remove fail', async () => {
    mockSecureGet.mockResolvedValue('evtxr_stored');
    mockSecureSave.mockRejectedValue(new Error('write failed'));
    mockSecureRemove.mockRejectedValue(new Error('remove failed'));
    _mockUser = { email: 'u@t.com', name: undefined, token: 'evtxa_old', expiresAt: 0 };

    vi.stubGlobal('fetch', makeFetchOk(makeTokenBody('evtxa_fresh')));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // First call: rotation succeeds, access token is fresh, but Keychain is broken
    const user = await silentRefresh();
    expect(user?.token).toBe('evtxa_fresh');
    expect(get(keychainErrorStore)).toMatch(/reconnexion requise/);

    // Second call: immediately returns null — no network request
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const user2 = await silentRefresh();
    expect(user2).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('logs a warning when Keychain save fails and remove succeeds', async () => {
    mockSecureGet.mockResolvedValue('evtxr_stored');
    mockSecureSave.mockRejectedValue(new Error('permission denied'));
    mockSecureRemove.mockResolvedValue(undefined);
    _mockUser = { email: 'u@t.com', name: undefined, token: 'evtxa_old', expiresAt: 0 };

    vi.stubGlobal('fetch', makeFetchOk(makeTokenBody()));

    const warnMessages: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      warnMessages.push(String(args[0]));
    });
    await silentRefresh();
    warnSpy.mockRestore();

    expect(warnMessages.some(m => m.includes('Keychain') || m.includes('PKCE'))).toBe(true);
    // Store must NOT be set — remove succeeded, this is a recoverable state
    expect(get(keychainErrorStore)).toBeNull();
  });
});

describe('silentRefresh — identity preservation', () => {
  it('preserves email and name from existing user on token rotation', async () => {
    mockSecureGet.mockResolvedValue('evtxr_stored');
    mockSecureSave.mockResolvedValue(undefined);
    _mockUser = {
      email:    'alice@eigenvertex.com',
      name:     'Alice',
      token:    'evtxa_old',
      expiresAt: 0,
    };

    vi.stubGlobal('fetch', makeFetchOk(makeTokenBody('evtxa_rotated', 'evtxr_rotated')));

    const user = await silentRefresh();

    expect(user?.email).toBe('alice@eigenvertex.com');
    expect(user?.name).toBe('Alice');
    expect(user?.token).toBe('evtxa_rotated');
    expect(mockSetUser).toHaveBeenCalledWith(expect.objectContaining({
      email: 'alice@eigenvertex.com',
      name:  'Alice',
      token: 'evtxa_rotated',
    }));
  });

  it('returns null without fetch when no refresh token in Keychain', async () => {
    mockSecureGet.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const user = await silentRefresh();

    expect(user).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Regression guard: webPost/nativePost used to throw a bare Error with no
  // `status`, so the `status === 401` branch never fired and a revoked refresh
  // token left a zombie session — signed-in UI, every request 401ing, no way
  // back to the login screen. These tests assert the session is actually cleared.
  it('clears the session on a 401 refresh response', async () => {
    mockSecureGet.mockResolvedValue('evtxr_revoked');
    mockSecureRemove.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ detail: 'token revoked' }),
    }));

    const user = await silentRefresh();

    expect(user).toBeNull();
    // The refresh token must be wiped, not left to be replayed forever.
    expect(mockSecureRemove).toHaveBeenCalled();
    expect(getUser()).toBeNull();
  });

  it('clears the session on a 403 refresh response', async () => {
    mockSecureGet.mockResolvedValue('evtxr_revoked');
    mockSecureRemove.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ detail: 'family revoked' }),
    }));

    await silentRefresh();

    expect(mockSecureRemove).toHaveBeenCalled();
    expect(getUser()).toBeNull();
  });

  it('KEEPS the session when the refresh fails from a network error', async () => {
    const existing: EVUser = {
      email: 'u@t.com', name: undefined,
      token: 'evtxa_stale',
      expiresAt: Date.now() - 1000,
      refreshToken: 'evtxr_valid',
    };
    setUser(existing);
    mockSecureGet.mockResolvedValue('evtxr_valid');
    mockSecureRemove.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const user = await silentRefresh();

    expect(user).toBeNull();
    // Offline is transient — a flaky network must never destroy a good session.
    expect(mockSecureRemove).not.toHaveBeenCalled();
    expect(getUser()).not.toBeNull();
  });

  it('KEEPS the session when the refresh fails with a 5xx', async () => {
    setUser({
      email: 'u@t.com', name: undefined,
      token: 'evtxa_stale', expiresAt: Date.now() - 1000, refreshToken: 'evtxr_valid',
    });
    mockSecureGet.mockResolvedValue('evtxr_valid');
    mockSecureRemove.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ detail: 'upstream down' }),
    }));

    await silentRefresh();

    expect(mockSecureRemove).not.toHaveBeenCalled();
    expect(getUser()).not.toBeNull();
  });
});

describe('ensureFreshToken — proactive refresh', () => {
  it('returns current user immediately when token has >60 s remaining', async () => {
    const fresh: EVUser = {
      email: 'u@t.com', name: undefined,
      token: 'evtxa_valid',
      expiresAt: Date.now() + 3_600_000,
    };
    _mockUser = fresh;
    mockGetUser.mockReturnValue(fresh);

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureFreshToken();

    expect(result).toBe(fresh);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('triggers silentRefresh when token expires within 60 s', async () => {
    const almostExpired: EVUser = {
      email: 'u@t.com', name: undefined,
      token: 'evtxa_old',
      expiresAt: Date.now() + 30_000, // 30 s — below the 60 s threshold
    };
    _mockUser = almostExpired;
    mockGetUser.mockReturnValue(almostExpired);
    mockSecureGet.mockResolvedValue('evtxr_stored');
    mockSecureSave.mockResolvedValue(undefined);

    vi.stubGlobal('fetch', makeFetchOk(makeTokenBody('evtxa_refreshed', 'evtxr_new', 3600)));

    const result = await ensureFreshToken();

    expect(result?.token).toBe('evtxa_refreshed');
  });

  it('triggers silentRefresh when there is no current user', async () => {
    _mockUser = null;
    mockGetUser.mockReturnValue(null);
    mockSecureGet.mockResolvedValue('evtxr_stored');
    mockSecureSave.mockResolvedValue(undefined);

    vi.stubGlobal('fetch', makeFetchOk(makeTokenBody('evtxa_new')));

    const result = await ensureFreshToken();

    expect(result?.token).toBe('evtxa_new');
  });
});

// ── Regression: a stalled /auth/token call must not hang forever ────────────
//
// webPost()/nativePost() had no timeout at all. On native, CapacitorHttp
// defaults to a 600_000ms (10 MINUTE) timeout when none is passed. Because
// every request() call in api.ts awaits ensureFreshToken() BEFORE its own
// (separately timed-out) transport call, a stalled refresh blocked ALL data
// loading upstream of it — this was the actual cause of the "stuck forever"
// session-content spinner and the Chat tab never appearing (gated on
// `minutes`, which never arrived), not a hang in the data call itself.

describe('silentRefresh — stalled token endpoint', () => {
  it('does not hang for anywhere near 10 minutes when fetch never settles', async () => {
    vi.useFakeTimers();
    mockSecureGet.mockResolvedValue('evtxr_valid');

    // Never resolves on its own, but honors AbortSignal like real fetch does —
    // this exercises OUR timeout, not the browser's abort plumbing.
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));

    const pending = silentRefresh();
    const assertion = expect(pending).resolves.toBeNull();

    // Our timeout (20s) must fire well before CapacitorHttp's 10-minute default.
    await vi.advanceTimersByTimeAsync(20_000);

    await assertion;
  });

  it('keeps the session after a stalled refresh — a timeout is transient, not a revocation', async () => {
    vi.useFakeTimers();
    const existing: EVUser = {
      email: 'u@t.com', name: undefined,
      token: 'evtxa_stale', expiresAt: Date.now() - 1000, refreshToken: 'evtxr_valid',
    };
    setUser(existing);
    mockSecureGet.mockResolvedValue('evtxr_valid');
    mockSecureRemove.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));

    const pending = silentRefresh();
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;

    // clearUser() is the one operation that would actually end the session, so
    // its call count is the direct signal. (An earlier version asserted on
    // getUser() instead and failed here; that was blamed on fake timers, but the
    // real cause was an earlier test's mockReturnValue(null) leaking — now
    // reset in beforeEach.)
    expect(result).toBeNull();
    expect(mockSecureRemove).not.toHaveBeenCalled();
    expect(mockClearUser).not.toHaveBeenCalled();
  });

  // The severe one: silentRefresh() caches _refreshPromise and only clears it
  // in .finally(). If an attempt never settles, that never runs and EVERY later
  // call returns the same dead promise — auth deadlocks for the whole app
  // session. That is why the spinner never recovered on its own and only a full
  // re-login cleared it. A later attempt must always be able to succeed.
  it('recovers on the next attempt — a stalled Keychain WRITE must not deadlock the guard', async () => {
    vi.useFakeTimers();
    mockSecureGet.mockResolvedValue('evtxr_valid');

    // The token call succeeds, then the Keychain WRITE never settles. This is
    // the one step with no timeout of its own, so only the outer budget can
    // rescue it — exactly what this test exists to prove.
    vi.stubGlobal('fetch', makeFetchOk(makeTokenBody('evtxa_ok')));
    mockSecureSave.mockImplementation(() => new Promise(() => {}));

    const first = silentRefresh();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await first).toBeNull();

    // Attempt 2 must run a FRESH request, not hand back the dead promise.
    vi.useRealTimers();
    mockSecureSave.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', makeFetchOk(makeTokenBody('evtxa_recovered')));

    const second = await silentRefresh();

    expect(second?.token).toBe('evtxa_recovered');
  });
});

// ── Logout: server-side revoke must actually authenticate ───────────────────
//
// POST /auth/oauth/revoke authenticates the caller (backend:
// _require_session_user_id). It was sent with no Authorization header, so the
// gateway answered 401 "API key missing" every time and a swallowed .catch hid
// it: logout wiped the local tokens but the refresh token stayed valid on the
// server. Settings even carried a comment claiming it "revokes refresh token".

import { pkceLogout } from './pkceFlow';

function revokeCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('/auth/oauth/revoke'));
}

function headerOf(call: unknown[], name: string): string | undefined {
  const init = (call[1] ?? {}) as { headers?: unknown };
  const h = init.headers as Record<string, string> | Headers | undefined;
  if (!h) return undefined;
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name) ?? undefined;
  const entry = Object.entries(h as Record<string, string>).find(([k]) => k.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

describe('pkceLogout — server-side revoke', () => {
  const user: EVUser = {
    email: 'u@t.com', name: undefined,
    token: 'evtxa_current', expiresAt: Date.now() + 600_000, refreshToken: 'evtxr_current',
  };

  function okFetch() {
    return vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ status: 'revoked' }),
      text: () => Promise.resolve('{"status":"revoked"}'),
    });
  }

  it('sends the caller\'s access token as a Bearer credential', async () => {
    setUser(user);
    mockSecureGet.mockResolvedValue('family-1');
    mockSecureRemove.mockResolvedValue(undefined);
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    await pkceLogout();
    await vi.waitFor(() => expect(revokeCalls(fetchMock).length).toBe(1));

    expect(headerOf(revokeCalls(fetchMock)[0], 'authorization')).toBe('Bearer evtxa_current');
  });

  it('does not attempt a revoke it knows will fail when there is no access token', async () => {
    _mockUser = null;
    mockSecureGet.mockResolvedValue('family-1');
    mockSecureRemove.mockResolvedValue(undefined);
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    await pkceLogout();
    await new Promise((r) => setTimeout(r, 20));

    expect(revokeCalls(fetchMock)).toHaveLength(0);
  });

  it('skips the revoke when the server already rejected the refresh token', async () => {
    setUser(user);
    mockSecureGet.mockResolvedValue('family-1');
    mockSecureRemove.mockResolvedValue(undefined);
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    await pkceLogout({ revokeOnServer: false });
    await new Promise((r) => setTimeout(r, 20));

    expect(revokeCalls(fetchMock)).toHaveLength(0);
    expect(mockClearUser).toHaveBeenCalled();
  });

  it('STILL signs out when the Keychain read throws — logout must never be blockable', async () => {
    setUser(user);
    mockSecureGet.mockRejectedValue(new Error('OSStatus -25308'));
    mockSecureRemove.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', okFetch());

    await expect(pkceLogout()).resolves.toBeUndefined();

    expect(mockSecureRemove).toHaveBeenCalled();
    expect(mockClearUser).toHaveBeenCalled();
  });

  it('STILL signs out when the revoke request fails', async () => {
    setUser(user);
    mockSecureGet.mockResolvedValue('family-1');
    mockSecureRemove.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await pkceLogout();

    expect(mockClearUser).toHaveBeenCalled();
  });
});
