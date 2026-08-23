// OAuth 2.1 authorization_code + PKCE flow
// Uses @capacitor/browser (system browser) + @capacitor/app (deep link callback)

import { Browser }        from '@capacitor/browser';
import { App }            from '@capacitor/app';
import { CapacitorHttp }  from '@capacitor/core'; // native URLSession — survives WKWebView suspension
import { generateCodeVerifier, generateCodeChallenge, generateState } from './pkce';
import { getDirectApiBase }  from './config';
import { setUser, clearUser, getUser } from './auth';
import { secureGet, secureSave, secureRemove } from './secureStorage';
import type { EVUser } from './auth';

// ── Constants ─────────────────────────────────────────────────────────────────

const CLIENT_ID    = 'eigenvertex-recorder';
const REDIRECT_URI = 'eigenvertex-recorder://oauth/callback';
const STORAGE_KEY_REFRESH = 'pkce_refresh_token';
const STORAGE_KEY_FAMILY  = 'pkce_rotation_family_id';

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

// ── HTTP helper — uses CapacitorHttp (native URLSession) not fetch() ──────────
// WKWebView's WebProcess is suspended during the Safari→app transition
// (ProcessSuspension / markAllLayersVolatile). Any fetch() in that window hangs
// forever. CapacitorHttp routes through iOS URLSession which is unaffected.

async function nativePost<T>(path: string, body: Record<string, string>): Promise<T> {
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

// ── Token exchange ────────────────────────────────────────────────────────────

async function exchangeCode(code: string, verifier: string): Promise<EVUser> {
  const tokens = await nativePost<TokenResponse>('/auth/token', {
    grant_type:    'authorization_code',
    client_id:     CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri:  REDIRECT_URI,
  });
  const user = buildUser(tokens);

  // If email is empty the access token is opaque (not a JWT) — fetch user info.
  if (!user.email) {
    try {
      const me = await CapacitorHttp.get({
        url: `${getDirectApiBase()}/auth/me`,
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (me.status === 200 && me.data?.email) {
        return { ...user, email: me.data.email, name: me.data.name ?? user.name };
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
    const tokens = await nativePost<TokenResponse>('/auth/token', {
      grant_type:    'refresh_token',
      client_id:     CLIENT_ID,
      refresh_token: refreshToken,
    });
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

// ── Main flow — launch browser, wait for callback ────────────────────────────

/**
 * Start the PKCE authorize flow.
 * Returns the logged-in EVUser, or throws with a user-facing message.
 *
 * Throws immediately with 'Login already in progress' if called concurrently —
 * the caller (UI) should guard on its own `busy` flag as well.
 */
export async function startPkceLogin(): Promise<EVUser> {
  if (_loginInProgress) {
    console.warn('[PKCE] startPkceLogin() called while already in progress — ignored');
    throw new Error('Login already in progress');
  }
  _loginInProgress = true;

  try {
    // 1. Generate PKCE params
    const verifier   = generateCodeVerifier();
    const challenge  = await generateCodeChallenge(verifier);
    const stateToken = generateState();

    console.log('[PKCE] startPkceLogin() — new flow', {
      state:     stateToken.slice(0, 8) + '…',
      challenge: challenge.slice(0, 12) + '…',
    });

    // 2. Build authorize URL
    const authorizeUrl = new URL(`${getDirectApiBase()}/auth/authorize`);
    authorizeUrl.searchParams.set('response_type',         'code');
    authorizeUrl.searchParams.set('client_id',             CLIENT_ID);
    authorizeUrl.searchParams.set('redirect_uri',          REDIRECT_URI);
    authorizeUrl.searchParams.set('code_challenge',        challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state',                 stateToken);

    // 3a. Wait for the deep link callback — listener only captures code+state,
    //     NO fetch inside the Capacitor bridge callback (WKWebView drops/suspends
    //     network requests initiated during the background→foreground transition).
    type CallbackResult =
      | { ok: true;  code: string; state: string }
      | { ok: false; error: string };

    const callbackResult = await new Promise<CallbackResult>((resolve) => {
      let handled = false;
      let listenerHandle: Awaited<ReturnType<typeof App.addListener>> | null = null;

      App.addListener('appUrlOpen', async ({ url }) => {
        console.log('[PKCE] appUrlOpen fired', {
          url,
          matchesScheme: url.startsWith(REDIRECT_URI),
          alreadyHandled: handled,
        });

        if (handled) return;
        if (!url.startsWith(REDIRECT_URI)) return;
        handled = true;

        // Remove listener immediately — before any async work
        if (listenerHandle) {
          listenerHandle.remove().catch(() => {/**/});
          listenerHandle = null;
        }

        // Close browser synchronously (non-blocking — we don't await here so
        // the resolve() below can fire without waiting for the animation)
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

        // All good — hand off to main flow
        resolve({ ok: true, code, state });

      }).then(handle => {
        listenerHandle = handle;
      });

      // 4. Open system browser
      console.log('[PKCE] Opening browser →', authorizeUrl.toString());
      Browser.open({ url: authorizeUrl.toString(), windowName: '_blank' })
        .catch(err => resolve({ ok: false, error: String(err) }));
    });

    // 3b. Handle callback result — token exchange runs in normal async context,
    //     outside the Capacitor bridge, so WKWebView handles the fetch normally.
    if (!callbackResult.ok) {
      throw new Error(callbackResult.error);
    }

    console.log('[PKCE] Callback received — exchanging code for token…');
    let user: EVUser;
    try {
      user = await exchangeCode(callbackResult.code, verifier);
    } catch (e) {
      console.error('[PKCE] Token exchange failed:', e);
      throw e;
    }

    // setUser FIRST — login must not block on Keychain writes (first Keychain access
    // can be slow on iOS, causing Promise.allSettled to hang and freeze the spinner).
    setUser(user);
    console.log('[PKCE] Login successful —', user.email);

    // Persist refresh token + family to Keychain in background (fire-and-forget).
    // If it fails the user is already logged in; the next login will simply redo the exchange.
    Promise.allSettled([
      secureSave(STORAGE_KEY_REFRESH, user.refreshToken ?? ''),
      user.rotationFamilyId
        ? secureSave(STORAGE_KEY_FAMILY, user.rotationFamilyId)
        : Promise.resolve(),
    ]).then(results => {
      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length) console.warn('[PKCE] Secure storage write failed (non-fatal):', failed);
      else console.log('[PKCE] Refresh token saved to Keychain ✓');
    });

    return user;
  } finally {
    _loginInProgress = false;
  }
}
