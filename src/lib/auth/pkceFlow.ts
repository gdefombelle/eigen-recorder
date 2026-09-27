// OAuth 2.1 authorization_code + PKCE flow
//
// Two paths depending on runtime context:
//
//   Native (iOS Capacitor) — existing flow, unchanged:
//     redirect_uri = 'eigenvertex-recorder://oauth/callback' (custom scheme)
//     @capacitor/browser opens the system browser; @capacitor/app captures the
//     deep-link callback; CapacitorHttp (native URLSession) does the token exchange
//     so WKWebView suspension during background→foreground doesn't drop the request.
//
//   Web (regular browser tab, e.g. recorder.eigenvertex.com in Chrome) — new path:
//     redirect_uri = window.location.origin + '/auth/callback' (HTTPS redirect back)
//     The custom scheme has no registered handler in a plain browser tab → redirect
//     to an HTTPS callback URL instead. PKCE verifier + state survive in sessionStorage
//     across the navigate-away/return. Token exchange uses fetch() (no WKWebView issue).
//
// IMPORTANT — backend prerequisite:
//   The HTTPS redirect URI (e.g. https://recorder.eigenvertex.com/auth/callback)
//   MUST be added to the allowed redirect_uris list for the 'eigenvertex-recorder'
//   OAuth client on the EigenVertex backend. The custom scheme must remain in that list
//   for the native app to keep working.
//
// IMPORTANT — CORS:
//   POST /v1/auth/token must allow the web origin (https://recorder.eigenvertex.com)
//   in the backend CORS config. CapacitorHttp (native) bypasses browser CORS;
//   fetch() (web) does not.

import { writable } from 'svelte/store';
import { generateCodeVerifier, generateCodeChallenge, generateState } from './pkce';
import { getDirectApiBase }  from './config';
import { setUser, clearUser, getUser } from './auth';
import { secureGet, secureSave, secureRemove } from './secureStorage';
import { isNative } from '$lib/platform';
import type { EVUser } from './auth';

// ── Keychain error store ───────────────────────────────────────────────────────
// Set when both secureSave and secureRemove fail after a rotation.
// The UI subscribes to show an explicit warning; silent refresh is blocked.

export const keychainErrorStore = writable<string | null>(null);
let _keychainBroken = false;

/** Reset module-level auth state. Only for unit tests. */
export function _resetForTests(): void {
  _keychainBroken = false;
  keychainErrorStore.set(null);
  _refreshPromise = null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CLIENT_ID    = 'eigenvertex-recorder';
/** Custom scheme — native app only (iOS deep-link handler). */
const NATIVE_REDIRECT_URI = 'eigenvertex-recorder://oauth/callback';
/** sessionStorage key — persists PKCE params across the authorize redirect on web. */
const WEB_PKCE_SESSION_KEY = 'pkce_web_pending';
const STORAGE_KEY_REFRESH  = 'pkce_refresh_token';
const STORAGE_KEY_FAMILY   = 'pkce_rotation_family_id';

// ── Token response from POST /v1/auth/token ───────────────────────────────────

interface TokenResponse {
  access_token:        string;
  refresh_token:       string;
  rotation_family_id?: string;
  expires_in?:         number; // seconds
  token_type?:         string;
}

// ── Build EVUser from token response ─────────────────────────────────────────

function buildUser(res: TokenResponse): EVUser {
  // access_token is opaque (evtxa_…) — never try to decode as JWT.
  // expiresAt comes from server-provided expires_in (authoritative).
  // email/name are carried forward from the existing user (token rotation doesn't
  // change the identity) or fetched from /auth/me after a fresh login.
  return {
    token:            res.access_token,
    email:            '',
    name:             undefined,
    expiresAt:        Date.now() + (res.expires_in ?? 3600) * 1000,
    refreshToken:     res.refresh_token,
    rotationFamilyId: res.rotation_family_id,
  };
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

/**
 * Token-endpoint failure that carries the HTTP status.
 *
 * The status is what lets _doSilentRefresh() tell a revoked refresh token
 * (401/403 — the session is definitively dead) from a transient failure
 * (offline, 5xx, timeout — keep the session). A plain Error loses that
 * distinction and leaves a dead session looking signed in forever.
 */
export class TokenHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'TokenHttpError';
  }
}

// CapacitorHttp defaults to a 600_000ms (10 MINUTE) timeout when neither
// connectTimeout nor readTimeout is given (see HttpRequestHandler.swift:
// `timeout = (connectTimeout ?? readTimeout ?? 600000.0) / 1000.0`). A stalled
// refresh call — poor signal, a backend hiccup — hung for up to 10 minutes
// with no way to recover, and because every request() call in api.ts awaits
// tryEnsureFresh() BEFORE its own (correctly timed-out) transport call, this
// hang blocked ALL data loading upstream of it: the "stuck forever" spinner
// and the missing Chat tab (gated on `minutes`, which never arrived) were both
// this same hang, not separate bugs. Same bound as api.ts's REQUEST_TIMEOUT_MS.
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Native HTTP POST via CapacitorHttp (routes through iOS URLSession).
 * Required for the token exchange on iOS: WKWebView's WebProcess is suspended
 * during the Safari→app transition (ProcessSuspension / markAllLayersVolatile),
 * causing any fetch() in that window to hang forever. CapacitorHttp is unaffected.
 */
async function nativePost<T>(path: string, body: Record<string, string>): Promise<T> {
  const { CapacitorHttp } = await import('@capacitor/core');
  const url = `${getDirectApiBase()}${path}`;
  console.log('[PKCE] nativePost →', url);
  const res = await CapacitorHttp.post({
    url,
    headers: { 'Content-Type': 'application/json' },
    data: body,
    connectTimeout: TOKEN_REQUEST_TIMEOUT_MS,
    readTimeout:    TOKEN_REQUEST_TIMEOUT_MS,
  });
  if (res.status < 200 || res.status >= 300) {
    const detail =
      typeof res.data?.detail === 'string' ? res.data.detail :
      typeof res.data?.message === 'string' ? res.data.message :
      `HTTP ${res.status}`;
    throw new TokenHttpError(res.status, detail);
  }
  return res.data as T;
}

/**
 * Web HTTP POST via fetch().
 * Safe to use in a regular browser context (no WKWebView suspension risk).
 * Requires the backend to have CORS configured for the web origin.
 */
async function webPost<T>(path: string, body: Record<string, string>): Promise<T> {
  const url = `${getDirectApiBase()}${path}`;
  console.log('[PKCE] webPost →', url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    const detail =
      typeof data?.detail  === 'string' ? data.detail  :
      typeof data?.message === 'string' ? data.message :
      `HTTP ${res.status}`;
    throw new TokenHttpError(res.status, detail as string);
  }
  return res.json() as Promise<T>;
}

// ── Token exchange ────────────────────────────────────────────────────────────

async function exchangeCode(
  code: string,
  verifier: string,
  redirectUri: string,
  useNativeHttp: boolean,
): Promise<EVUser> {
  const payload = {
    grant_type:    'authorization_code',
    client_id:     CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri:  redirectUri,
  };
  const tokens = useNativeHttp
    ? await nativePost<TokenResponse>('/auth/token', payload)
    : await webPost<TokenResponse>('/auth/token', payload);
  const user = buildUser(tokens);

  // If email is empty the access token is opaque (not a JWT) — fetch user info.
  if (!user.email) {
    try {
      if (useNativeHttp) {
        const { CapacitorHttp } = await import('@capacitor/core');
        const me = await CapacitorHttp.get({
          url: `${getDirectApiBase()}/auth/me`,
          headers: { Authorization: `Bearer ${tokens.access_token}` },
          connectTimeout: TOKEN_REQUEST_TIMEOUT_MS,
          readTimeout:    TOKEN_REQUEST_TIMEOUT_MS,
        });
        if (me.status === 200 && me.data?.email) {
          return { ...user, email: me.data.email, name: me.data.name ?? user.name };
        }
      } else {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);
        let res: Response;
        try {
          res = await fetch(`${getDirectApiBase()}/auth/me`, {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
            signal:  controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (res.ok) {
          const me = await res.json() as Record<string, unknown>;
          if (me?.email) return { ...user, email: String(me.email), name: typeof me.name === 'string' ? me.name : user.name };
        }
      }
    } catch (e) {
      console.warn('[PKCE] /auth/me failed (non-fatal):', e);
    }
  }
  return user;
}

// ── Single-flight refresh guard ───────────────────────────────────────────────
// All concurrent refresh callers share one Promise — the same evtxr_… token
// must never be replayed, as replaying a consumed token can revoke the entire
// rotation family.

let _refreshPromise: Promise<EVUser | null> | null = null;

// ── Refresh diagnostics ──────────────────────────────────────────────────────
// On-device visibility into WHY a silent refresh did or didn't happen, surfaced
// in Settings › Diagnostics. Records outcomes and HTTP statuses only — never a
// token, a prefix, or any part of one.

export interface RefreshDiag {
  at:      number;
  outcome: string;
}

export const refreshDiagStore = writable<RefreshDiag | null>(null);

function noteRefresh(outcome: string): void {
  refreshDiagStore.set({ at: Date.now(), outcome });
}

// Hard ceiling on a whole refresh attempt, as a STRUCTURAL backstop.
//
// The single-flight guard below caches _refreshPromise and only clears it in
// .finally(). If anything inside _doSilentRefresh() ever fails to settle — a
// Keychain bridge call that never calls back, a transport that slips its own
// timeout — that .finally() never runs, _refreshPromise stays set forever, and
// EVERY later silentRefresh() returns the same dead promise. One transient
// hang then deadlocks auth for the rest of the app session, which is why the
// spinner never recovered on its own and only a full re-login cleared it.
//
// This wrapper guarantees the promise always settles, whatever happens inside.
// It is deliberately longer than the per-call timeouts so those fire first and
// produce better diagnostics; this only catches what they miss.
const REFRESH_TOTAL_BUDGET_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export function silentRefresh(): Promise<EVUser | null> {
  // Keychain is irrecoverable — don't attempt network refresh (would replay consumed token).
  if (_keychainBroken) return Promise.resolve(null);
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = withTimeout(_doSilentRefresh(), REFRESH_TOTAL_BUDGET_MS, 'silentRefresh')
    .catch((e: unknown) => {
      // A blown budget is transient, never a revocation: keep the session and
      // let the next call retry rather than signing a healthy user out.
      console.warn('[PKCE] Refresh did not complete:', e instanceof Error ? e.message : String(e));
      return null;
    })
    .finally(() => { _refreshPromise = null; });
  return _refreshPromise;
}

async function _doSilentRefresh(): Promise<EVUser | null> {
  // Keychain reads go through the Capacitor bridge and can stall; secureGet()
  // only catches rejections, not a call that never comes back.
  const refreshToken = await withTimeout(
    secureGet(STORAGE_KEY_REFRESH),
    TOKEN_REQUEST_TIMEOUT_MS,
    'Keychain read',
  );
  if (!refreshToken) {
    noteRefresh('no refresh token in Keychain');
    return null;
  }
  try {
    const payload = {
      grant_type:    'refresh_token',
      client_id:     CLIENT_ID,
      refresh_token: refreshToken,
    };
    // Use the appropriate transport — native URLSession on iOS to survive
    // WKWebView suspension; fetch on web (no suspension risk).
    const tokens = isNative()
      ? await nativePost<TokenResponse>('/auth/token', payload)
      : await webPost<TokenResponse>('/auth/token', payload);

    // Carry forward identity from the current session — token rotation doesn't
    // change the user, and opaque tokens don't embed email/name.
    const base     = buildUser(tokens);
    const existing = getUser();
    const user: EVUser = {
      ...base,
      email: base.email || existing?.email || '',
      name:  base.name ?? existing?.name,
    };
    setUser(user);
    noteRefresh('ok');

    // Save the new refresh token.
    // The old token was consumed by the rotation exchange — it must NOT survive
    // in Keychain or it will be replayed on the next refresh attempt, triggering
    // a family revocation. Two-stage safety: try save → if that fails, remove old.
    try {
      await secureSave(STORAGE_KEY_REFRESH, tokens.refresh_token);
    } catch (saveErr) {
      console.warn(
        '[PKCE] Keychain write failed — attempting to remove consumed token.',
        saveErr instanceof Error ? saveErr.message : String(saveErr),
      );
      try {
        await secureRemove(STORAGE_KEY_REFRESH);
        console.warn('[PKCE] Consumed refresh token removed. Re-login required after access token expires (~15 min).');
      } catch (removeErr) {
        // CRITICAL: Cannot save the new token AND cannot remove the consumed one.
        // The next silentRefresh() call would replay the stale Keychain entry and
        // potentially revoke the entire rotation family. Block all future silent
        // refreshes and surface the error to the UI.
        _keychainBroken = true;
        keychainErrorStore.set(
          'Keychain inaccessible — reconnexion requise. Vos enregistrements locaux sont préservés.',
        );
        console.error(
          '[PKCE] Keychain save AND removal both failed — silent refresh disabled to prevent family revocation.',
          'save:', saveErr instanceof Error ? saveErr.message : String(saveErr),
          'remove:', removeErr instanceof Error ? removeErr.message : String(removeErr),
        );
        // Don't throw: return the fresh access token (~15 min) so the current
        // operation succeeds. The UI banner tells the user to re-login.
      }
    }
    if (tokens.rotation_family_id) {
      await secureSave(STORAGE_KEY_FAMILY, tokens.rotation_family_id).catch((e: unknown) => {
        console.warn('[PKCE] Failed to save rotation_family_id (non-fatal):', e instanceof Error ? e.message : String(e));
      });
    }
    return user;
  } catch (e: unknown) {
    const status = (e as { status?: number })?.status;
    // 401/403 → the refresh token is revoked or invalid. The session is
    // definitively dead, so clear it: leaving it in place would show a signed-in
    // UI whose every request 401s, with no way back to the login screen.
    //
    // Anything else (offline, 5xx, timeout) is transient and must NOT log the
    // user out — a flaky network would otherwise destroy a healthy session.
    if (status === 401 || status === 403) {
      console.warn(`[PKCE] Refresh rejected (HTTP ${status}) — clearing session.`);
      noteRefresh(`revoked (HTTP ${status}) — session cleared`);
      await pkceLogout();
    } else {
      noteRefresh(status ? `failed (HTTP ${status}) — session kept` : 'network failure — session kept');
    }
    return null;
  }
}

// ── Check and refresh if access token is expiring (< 60 s remaining) ─────────

export async function ensureFreshToken(): Promise<EVUser | null> {
  const user = getUser();
  if (user && user.expiresAt - Date.now() > 60_000) return user;
  return silentRefresh();
}

// ── Foreground lifecycle ──────────────────────────────────────────────────────

/**
 * Re-validate the session every time the app returns to the foreground.
 *
 * iOS suspends the WebView without re-running onMount, so a resume after more
 * than ~15 minutes lands on an expired access token that nothing renews — the
 * user appears logged out despite a perfectly valid Keychain refresh token.
 * The web/PWA path uses visibilitychange + focus for the same reason.
 *
 * Returns a cleanup function.
 */
export function startAuthLifecycle(): () => void {
  let disposed = false;
  const onForeground = () => { if (!disposed) ensureFreshToken().catch(() => {/* transient */}); };

  if (isNative()) {
    const handle = import('@capacitor/app').then(({ App }) =>
      App.addListener('appStateChange', ({ isActive }: { isActive: boolean }) => {
        if (isActive) onForeground();
      }),
    );
    return () => {
      disposed = true;
      handle.then((h) => h.remove()).catch(() => {/* never registered */});
    };
  }

  const onVisible = () => { if (document.visibilityState === 'visible') onForeground(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onForeground);
  return () => {
    disposed = true;
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', onForeground);
  };
}

// ── Logout ────────────────────────────────────────────────────────────────────

export async function pkceLogout(): Promise<void> {
  _keychainBroken = false;
  keychainErrorStore.set(null);
  const familyId = await secureGet(STORAGE_KEY_FAMILY);
  // Best-effort revoke — do not block logout on network errors
  if (familyId) {
    nativePost('/auth/oauth/revoke', { rotation_family_id: familyId }).catch(() => {/* ignore */});
  }
  await Promise.allSettled([
    secureRemove(STORAGE_KEY_REFRESH),
    secureRemove(STORAGE_KEY_FAMILY),
  ]);
  clearUser();
}

// ── Module-level guard — prevents concurrent login flows ─────────────────────
// A double-tap on iOS or a stale effect can call startPkceLogin() twice before
// the button's `disabled` attribute is painted. This flag blocks any second
// call at the JS level, independent of DOM state.

let _loginInProgress = false;

// ── Shared: persist user + refresh token after successful exchange ────────────

async function _finaliseLogin(user: EVUser): Promise<EVUser> {
  // setUser FIRST — login must not block on Keychain/storage writes.
  setUser(user);
  console.log('[PKCE] Login successful —', user.email);

  // Persist refresh token + family in background (fire-and-forget).
  // Never write an empty string: secureGet() would read it back as falsy and
  // _doSilentRefresh() would bail out, disabling silent refresh permanently.
  if (!user.refreshToken) {
    console.warn('[PKCE] Token response carried no refresh token — session will end when the access token expires.');
  }
  Promise.allSettled([
    user.refreshToken
      ? secureSave(STORAGE_KEY_REFRESH, user.refreshToken)
      : Promise.resolve(),
    user.rotationFamilyId
      ? secureSave(STORAGE_KEY_FAMILY, user.rotationFamilyId)
      : Promise.resolve(),
  ]).then(results => {
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) console.warn('[PKCE] Storage write failed (non-fatal):', failed);
    else console.log('[PKCE] Refresh token saved ✓');
  });

  return user;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Start the PKCE authorize flow. Branches on runtime context:
 *   - Native (iOS Capacitor): custom scheme deep-link flow (existing behaviour)
 *   - Web (regular browser tab): HTTPS redirect to /auth/callback (new behaviour)
 *
 * Web path: this function navigates away from the current page and NEVER resolves.
 * The `completeWebPkceLogin()` function must be called from /auth/callback
 * to finish the exchange after the redirect returns.
 *
 * Throws immediately with 'Login already in progress' if called concurrently
 * (native only — not relevant on web since the page navigates away).
 */
export async function startPkceLogin(): Promise<EVUser> {
  if (!isNative()) {
    return _startWebPkceLogin();
  }
  return _startNativePkceLogin();
}

// ── Native flow (iOS Capacitor — unchanged logic) ─────────────────────────────

async function _startNativePkceLogin(): Promise<EVUser> {
  if (_loginInProgress) {
    console.warn('[PKCE] startPkceLogin() called while already in progress — ignored');
    throw new Error('Login already in progress');
  }
  _loginInProgress = true;

  try {
    const verifier   = generateCodeVerifier();
    const challenge  = await generateCodeChallenge(verifier);
    const stateToken = generateState();

    console.log('[PKCE] native flow — new request', {
      state:     stateToken.slice(0, 8) + '…',
      challenge: challenge.slice(0, 12) + '…',
    });

    const authorizeUrl = new URL(`${getDirectApiBase()}/auth/authorize`);
    authorizeUrl.searchParams.set('response_type',         'code');
    authorizeUrl.searchParams.set('client_id',             CLIENT_ID);
    authorizeUrl.searchParams.set('redirect_uri',          NATIVE_REDIRECT_URI);
    authorizeUrl.searchParams.set('code_challenge',        challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state',                 stateToken);

    // Wait for the deep link callback — listener only captures code+state,
    // NO fetch inside the Capacitor bridge callback (WKWebView drops/suspends
    // network requests initiated during the background→foreground transition).
    type CallbackResult =
      | { ok: true;  code: string; state: string }
      | { ok: false; error: string };

    // Dynamic import before the Promise constructor — avoids an async executor
    // (async Promise executors swallow rejections) and avoids loading these
    // Capacitor modules in web/SSR bundles.
    const [{ App }, { Browser }] = await Promise.all([
      import('@capacitor/app'),
      import('@capacitor/browser'),
    ]);

    const callbackResult = await new Promise<CallbackResult>((resolve) => {
      let handled = false;
      let listenerHandle: { remove(): Promise<void> } | null = null;

      App.addListener('appUrlOpen', async ({ url }: { url: string }) => {
        console.log('[PKCE] appUrlOpen fired', {
          url,
          matchesScheme: url.startsWith(NATIVE_REDIRECT_URI),
          alreadyHandled: handled,
        });

        if (handled) return;
        if (!url.startsWith(NATIVE_REDIRECT_URI)) return;
        handled = true;

        if (listenerHandle) {
          listenerHandle.remove().catch(() => {/**/});
          listenerHandle = null;
        }

        // Close browser synchronously (non-blocking)
        Browser.close().catch(() => {/* already closed */});

        const parsed = new URL(url);
        const code   = parsed.searchParams.get('code');
        const state  = parsed.searchParams.get('state');
        const error  = parsed.searchParams.get('error');

        if (error) {
          resolve({ ok: false, error: parsed.searchParams.get('error_description') ?? error });
          return;
        }
        if (!code) {
          resolve({ ok: false, error: 'No authorization code in callback' });
          return;
        }
        if (state !== stateToken) {
          console.error('[PKCE] State mismatch', { received: state, expected: stateToken.slice(0, 8) + '…' });
          resolve({ ok: false, error: 'State mismatch — possible CSRF' });
          return;
        }

        resolve({ ok: true, code, state });

      }).then((handle: { remove(): Promise<void> }) => {
        listenerHandle = handle;
      });

      // Open system browser (Browser already imported above)
      console.log('[PKCE] Opening browser →', authorizeUrl.toString());
      Browser.open({ url: authorizeUrl.toString(), windowName: '_blank' })
        .catch((err: unknown) => resolve({ ok: false, error: String(err) }));
    });

    if (!callbackResult.ok) throw new Error(callbackResult.error);

    console.log('[PKCE] Callback received — exchanging code…');
    const user = await exchangeCode(callbackResult.code, verifier, NATIVE_REDIRECT_URI, true);
    return _finaliseLogin(user);

  } finally {
    _loginInProgress = false;
  }
}

// ── Web flow (regular browser tab) ───────────────────────────────────────────

/**
 * Web PKCE flow: stores verifier + state in sessionStorage, then navigates the
 * current tab to the authorize URL. This function NEVER resolves — the browser
 * navigates away. completeWebPkceLogin() in /auth/callback finishes the exchange.
 */
async function _startWebPkceLogin(): Promise<EVUser> {
  const verifier   = generateCodeVerifier();
  const challenge  = await generateCodeChallenge(verifier);
  const stateToken = generateState();

  const redirectUri = `${window.location.origin}/auth/callback`;
  const next = new URLSearchParams(window.location.search).get('next') ?? '/recorder';

  console.log('[PKCE] web flow — saving state, redirecting', {
    redirectUri,
    state: stateToken.slice(0, 8) + '…',
  });

  // Persist PKCE params across the page navigation
  try {
    sessionStorage.setItem(WEB_PKCE_SESSION_KEY, JSON.stringify({
      verifier,
      state:       stateToken,
      redirectUri, // must match exactly when sent to /token
      next,
    }));
  } catch (e) {
    console.error('[PKCE] sessionStorage unavailable — cannot start web flow:', e);
    throw new Error('sessionStorage unavailable. Enable cookies/storage and try again.');
  }

  const authorizeUrl = new URL(`${getDirectApiBase()}/auth/authorize`);
  authorizeUrl.searchParams.set('response_type',         'code');
  authorizeUrl.searchParams.set('client_id',             CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri',          redirectUri);
  authorizeUrl.searchParams.set('code_challenge',        challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('state',                 stateToken);

  // Navigate the current tab — this function never resolves after this line.
  window.location.href = authorizeUrl.toString();
  return new Promise<EVUser>(() => { /* navigation takes over */ });
}

// ── Web callback completion (called from /auth/callback on web) ───────────────

export interface WebPkceCallbackResult {
  user: EVUser;
  next: string;
}

/**
 * Complete the web PKCE flow after the authorize redirect returns to /auth/callback.
 * Reads verifier + state from sessionStorage, validates the state param, exchanges
 * the code for tokens, calls setUser(), and returns the logged-in user + next URL.
 *
 * Throws if session is missing, state mismatches, or token exchange fails.
 */
export async function completeWebPkceLogin(
  code:  string,
  state: string,
): Promise<WebPkceCallbackResult> {
  let pending: { verifier: string; state: string; redirectUri: string; next: string };
  try {
    const raw = sessionStorage.getItem(WEB_PKCE_SESSION_KEY);
    if (!raw) throw new Error('PKCE session not found — please try logging in again.');
    pending = JSON.parse(raw) as typeof pending;
    sessionStorage.removeItem(WEB_PKCE_SESSION_KEY); // clear immediately after read
  } catch (e) {
    throw new Error(`Cannot read PKCE session: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (state !== pending.state) {
    console.error('[PKCE] Web state mismatch', {
      received: state?.slice(0, 8),
      expected: pending.state?.slice(0, 8),
    });
    throw new Error('State mismatch — possible CSRF attack. Please try logging in again.');
  }

  console.log('[PKCE] Web callback — exchanging code for token…');
  const user = await exchangeCode(code, pending.verifier, pending.redirectUri, false);
  await _finaliseLogin(user);
  return { user, next: pending.next };
}
