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

import { generateCodeVerifier, generateCodeChallenge, generateState } from './pkce';
import { getDirectApiBase }  from './config';
import { setUser, clearUser, getUser } from './auth';
import { secureGet, secureSave, secureRemove } from './secureStorage';
import { isNative } from '$lib/platform';
import type { EVUser } from './auth';

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
  // Decode JWT payload for email / name (access_token is a JWT)
  let email = '';
  let name: string | undefined;
  let expiresAt = Date.now() + (res.expires_in ?? 3600) * 1000;
  try {
    const [, payload] = res.access_token.split('.');
    const claims = JSON.parse(atob(payload!.replace(/-/g, '+').replace(/_/g, '/')));
    email     = String(claims['email'] ?? claims['sub'] ?? '');
    name      = typeof claims['name'] === 'string' ? claims['name'] : undefined;
    if (typeof claims['exp'] === 'number') expiresAt = claims['exp'] * 1000;
  } catch { /* keep defaults */ }
  return {
    token:             res.access_token,
    email,
    name,
    expiresAt,
    refreshToken:      res.refresh_token,
    rotationFamilyId:  res.rotation_family_id,
  };
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

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
  });
  if (res.status < 200 || res.status >= 300) {
    const detail =
      typeof res.data?.detail === 'string' ? res.data.detail :
      typeof res.data?.message === 'string' ? res.data.message :
      `HTTP ${res.status}`;
    throw new Error(detail);
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
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    const detail =
      typeof data?.detail  === 'string' ? data.detail  :
      typeof data?.message === 'string' ? data.message :
      `HTTP ${res.status}`;
    throw new Error(detail as string);
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
        });
        if (me.status === 200 && me.data?.email) {
          return { ...user, email: me.data.email, name: me.data.name ?? user.name };
        }
      } else {
        const res = await fetch(`${getDirectApiBase()}/auth/me`, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
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

// ── Silent refresh ────────────────────────────────────────────────────────────

export async function silentRefresh(): Promise<EVUser | null> {
  const refreshToken = await secureGet(STORAGE_KEY_REFRESH);
  if (!refreshToken) return null;
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
    const user = buildUser(tokens);
    setUser(user);
    await secureSave(STORAGE_KEY_REFRESH, tokens.refresh_token);
    if (tokens.rotation_family_id) {
      await secureSave(STORAGE_KEY_FAMILY, tokens.rotation_family_id);
    }
    return user;
  } catch (e: unknown) {
    // 401 = refresh revoked → force logout; other errors are transient
    const status = (e as { status?: number })?.status;
    if (status === 401) await pkceLogout();
    return null;
  }
}

// ── Check and refresh if access token is expiring (< 60 s remaining) ─────────

export async function ensureFreshToken(): Promise<EVUser | null> {
  const user = getUser();
  if (user && user.expiresAt - Date.now() > 60_000) return user;
  return silentRefresh();
}

// ── Logout ────────────────────────────────────────────────────────────────────

export async function pkceLogout(): Promise<void> {
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
  Promise.allSettled([
    secureSave(STORAGE_KEY_REFRESH, user.refreshToken ?? ''),
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
