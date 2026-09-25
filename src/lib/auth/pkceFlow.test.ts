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
import { getUser, setUser } from './auth';
import { silentRefresh, ensureFreshToken, keychainErrorStore, _resetForTests } from './pkceFlow';
import type { EVUser } from './auth';

const mockSecureGet    = secureGet    as ReturnType<typeof vi.fn>;
const mockSecureSave   = secureSave   as ReturnType<typeof vi.fn>;
const mockSecureRemove = secureRemove as ReturnType<typeof vi.fn>;
const mockGetUser      = getUser      as ReturnType<typeof vi.fn>;
const mockSetUser      = setUser      as ReturnType<typeof vi.fn>;

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
  _resetForTests(); // reset _keychainBroken flag and keychainErrorStore between tests
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  it('logs out and returns null on 401 refresh response', async () => {
    mockSecureGet.mockResolvedValue('evtxr_revoked');
    mockSecureRemove.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ detail: 'token revoked' }),
    }));

    const user = await silentRefresh();
    expect(user).toBeNull();
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
