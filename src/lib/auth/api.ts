// EigenVertex HTTP API client — auth + knowledge-session endpoints.
// Contract matches scanner-app api.ts — same EVUser, same AuthResponse shape.

import { getApiBase, getDirectApiBase } from './config';
import { getUser } from './auth';
import { isNative } from '$lib/platform';
import type { RecordableKnowledgeSession } from '$lib/recorder/types';

// ── Transport ────────────────────────────────────────────────────────────────
//
// fetch() can hang FOREVER with no error and no timeout when WKWebView's
// WebProcess is suspended (documented in pkceFlow.ts for the token exchange —
// the same risk applies to every other data call routed through fetch()).
// A request stuck in that state never resolves nor rejects, so Promise.allSettled
// callers (e.g. the session-content workspace) spin indefinitely with no way to
// recover — this is the "infinite loading spinner" failure mode.
//
// Fix: native builds route JSON requests through CapacitorHttp (iOS URLSession,
// immune to WebView suspension), and every transport gets an explicit timeout
// so a request that truly cannot complete fails with a retriable ApiError(0)
// instead of hanging forever. FormData (file uploads) stays on fetch() —
// CapacitorHttp doesn't reliably carry multipart bodies.

const REQUEST_TIMEOUT_MS = 20_000;

interface RawResponse {
  status: number;
  json(): Promise<unknown>;
}

async function timedFetch(url: string, init: RequestInit): Promise<RawResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { status: res.status, json: () => res.json() };
  } finally {
    clearTimeout(timer);
  }
}

async function nativeHttp(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<RawResponse> {
  const { CapacitorHttp } = await import('@capacitor/core');
  const res = await CapacitorHttp.request({
    url,
    method,
    headers,
    // CapacitorHttp serializes an object as JSON; a pre-stringified body must
    // be parsed back so it isn't sent as a double-encoded JSON string.
    data: body !== undefined ? JSON.parse(body) : undefined,
    connectTimeout: REQUEST_TIMEOUT_MS,
    readTimeout:    REQUEST_TIMEOUT_MS,
  });
  return { status: res.status, json: () => Promise.resolve(res.data) };
}

/** Transport-agnostic request: CapacitorHttp for JSON on native, fetch() otherwise. */
async function transportRequest(
  url: string,
  opts: RequestInit,
  headers: Record<string, string>,
  isFormData: boolean,
): Promise<RawResponse> {
  if (isNative() && !isFormData) {
    return nativeHttp(url, opts.method ?? 'GET', headers, opts.body as string | undefined);
  }
  return timedFetch(url, { ...opts, headers });
}

// Lazy imports avoid circular dep (pkceFlow → api → pkceFlow)

async function tryRefresh(): Promise<string | null> {
  try {
    const { silentRefresh } = await import('./pkceFlow');
    const user = await silentRefresh();
    return user?.token ?? null;
  } catch {
    return null;
  }
}

// Proactively refresh if the token is within 60 s of expiry.
// Non-fatal — if the refresh fails, the request proceeds with the current token
// and a 401 will trigger the reactive retry path.
async function tryEnsureFresh(): Promise<void> {
  if (!getUser()) return;
  try {
    const { ensureFreshToken } = await import('./pkceFlow');
    await ensureFreshToken();
  } catch {
    // non-fatal
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retriable = false
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(
  path: string,
  opts: RequestInit = {},
  skipAuth = false
): Promise<T> {
  if (!skipAuth) await tryEnsureFresh();

  const user       = getUser();
  const isFormData = opts.body instanceof FormData;

  const headers: Record<string, string> = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(opts.headers as Record<string, string> | undefined),
  };
  if (!skipAuth && user) headers['Authorization'] = `Bearer ${user.token}`;

  // Guard: path must NOT include /v1 — getApiBase() already provides it.
  // A path like '/v1/knowledge-sessions/...' would produce /api/v1/v1/... in dev.
  if (import.meta.env.DEV && path.startsWith('/v1/')) {
    console.error(`[EigenMeeting] request() path starts with /v1 — double prefix! Fix: remove /v1 from "${path}"`);
  }

  const url = `${getApiBase()}${path}`;
  let res: RawResponse;
  try {
    res = await transportRequest(url, opts, headers, isFormData);
  } catch (e) {
    // AbortError (our timeout) and network failures land here identically —
    // both mean "the request didn't complete," both are safe to retry.
    throw new ApiError(0, describeTransportFailure(e), true);
  }

  if (res.status < 200 || res.status >= 300) {
    // 401 with a PKCE session → try silent refresh once, then retry
    if (res.status === 401 && !skipAuth) {
      const newToken = await tryRefresh();
      if (newToken) {
        // Retry with the new token
        const retryHeaders: Record<string, string> = {
          ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
          ...(opts.headers as Record<string, string> | undefined),
          Authorization: `Bearer ${newToken}`,
        };
        let retryRes: RawResponse;
        try {
          retryRes = await transportRequest(url, opts, retryHeaders, isFormData);
        } catch (e) {
          throw new ApiError(0, describeTransportFailure(e), true);
        }
        if (retryRes.status >= 200 && retryRes.status < 300) {
          if (retryRes.status === 204) return undefined as T;
          return retryRes.json() as Promise<T>;
        }
        // Retry also failed — fall through to error handling below
        res = retryRes;
      }
    }
    const body = (await res.json().catch(() => ({ message: 'Request failed' }))) as Record<string, unknown>;
    // FastAPI returns validation errors as body.detail = [{type,loc,msg,input}, ...]
    // Serialize arrays so they produce a readable string instead of [object Object].
    const detail =
      typeof body.detail === 'string'
        ? body.detail
        : Array.isArray(body.detail)
          ? body.detail.map((e: { msg?: string; message?: string }) =>
              e.msg ?? e.message ?? JSON.stringify(e)
            ).join('; ')
          : undefined;
    throw new ApiError(
      res.status,
      (body.message as string | undefined) ?? detail ?? `HTTP ${res.status}`,
      res.status >= 500 || res.status === 429
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function describeTransportFailure(e: unknown): string {
  if (e instanceof DOMException && e.name === 'AbortError') {
    return 'Request timed out. Check your connection and try again.';
  }
  return 'Server unreachable. Check your connection and the URL in Settings.';
}

export interface AuthResponse {
  token?:         string;
  session_token?: string;
  email?:         string;
  name?:          string;
  expiresAt?:     number;
}

export async function apiMeWithToken(token: string): Promise<{ email: string; name?: string }> {
  // Runs right after the Safari→app OAuth handoff — exactly the WKWebView
  // suspension window that makes a plain fetch() hang forever (see pkceFlow.ts).
  let res: RawResponse;
  try {
    res = await transportRequest(
      `${getApiBase()}/auth/me`,
      {},
      { Authorization: `Bearer ${token}` },
      false,
    );
  } catch (e) {
    throw new ApiError(0, describeTransportFailure(e), true);
  }
  if (res.status < 200 || res.status >= 300) throw new ApiError(res.status, `HTTP ${res.status}`, res.status >= 500);
  return res.json() as Promise<{ email: string; name?: string }>;
}

export async function apiLogin(email: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>('/auth/login', {
    method: 'POST', body: JSON.stringify({ email, password })
  }, true);
}

export async function apiRegister(email: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>('/auth/register', {
    method: 'POST', body: JSON.stringify({ email, password })
  }, true);
}

export async function apiMe(): Promise<{ email: string; name?: string }> {
  return request('/auth/me');
}

export async function apiLogout(): Promise<void> {
  await request('/auth/logout', { method: 'POST' });
}

// ── Knowledge sessions ────────────────────────────────────────────────────────

type RecordableSessionsResponse =
  | RecordableKnowledgeSession[]
  | { items: RecordableKnowledgeSession[] };

export async function apiGetRecordableSessions(): Promise<RecordableKnowledgeSession[]> {
  // path must NOT include /v1 — getApiBase() already adds it
  const res = await request<RecordableSessionsResponse>('/knowledge-sessions/recordable');
  return Array.isArray(res) ? res : (res.items ?? []);
}

export interface RecordableThread {
  id: string;
  title: string;
  kind: string;
  status: string;
  workspace_id: string | null;
}

type ThreadsResponse = RecordableThread[] | { items: RecordableThread[] };

/** Active, user-visible Threads offered as explicit capture destinations. */
export async function apiGetThreads(): Promise<RecordableThread[]> {
  const res = await request<ThreadsResponse>('/threads?status=active&limit=200');
  return Array.isArray(res) ? res : (res.items ?? []);
}

export function getGoogleLoginUrl(): string {
  const redirectUri = typeof window !== 'undefined'
    ? `${window.location.origin}/auth/callback`
    : '';
  return `${getDirectApiBase()}/auth/google/login?redirect_uri=${encodeURIComponent(redirectUri)}`;
}

/** Apple Sign In — web OAuth redirect (non-native iOS, same pattern as Google). */
export function getAppleLoginUrl(): string {
  const redirectUri = typeof window !== 'undefined'
    ? `${window.location.origin}/auth/callback`
    : '';
  return `${getDirectApiBase()}/auth/apple/login?redirect_uri=${encodeURIComponent(redirectUri)}`;
}

export async function apiForgotPassword(email: string): Promise<void> {
  await request('/auth/forgot-password', {
    method: 'POST', body: JSON.stringify({ email })
  }, true);
}

export async function apiResetPassword(token: string, newPassword: string): Promise<void> {
  await request('/auth/reset-password', {
    method: 'POST', body: JSON.stringify({ token, newPassword })
  }, true);
}

// ── Apple native login (Capacitor iOS only) ──────────────────────────────────

export interface AppleNativeLoginPayload {
  identityToken:     string;
  authorizationCode: string;
  email?:            string;
  fullName?:         string;
}

export async function apiAppleNativeLogin(payload: AppleNativeLoginPayload): Promise<AuthResponse> {
  return request<AuthResponse>('/auth/apple/native', {
    method: 'POST', body: JSON.stringify(payload)
  }, true);
}
