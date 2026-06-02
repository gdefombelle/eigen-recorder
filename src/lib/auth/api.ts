// EigenVertex HTTP API client — auth endpoints only.
// Recorder-specific endpoints (session upload) will be added when the backend is ready.
// Contract matches scanner-app api.ts — same EVUser, same AuthResponse shape.

import { getApiBase, getDirectApiBase } from './config';
import { getUser } from './auth';

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
  const user       = getUser();
  const isFormData = opts.body instanceof FormData;

  const headers: Record<string, string> = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(opts.headers as Record<string, string> | undefined),
  };
  if (!skipAuth && user) headers['Authorization'] = `Bearer ${user.token}`;

  let res: Response;
  try {
    res = await fetch(`${getApiBase()}${path}`, { ...opts, headers });
  } catch {
    throw new ApiError(0, 'Server unreachable. Check your connection and the URL in Settings.', true);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new ApiError(
      res.status,
      body.message ?? body.detail ?? res.statusText,
      res.status >= 500 || res.status === 429
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface AuthResponse {
  token?:         string;
  session_token?: string;
  email?:         string;
  name?:          string;
  expiresAt?:     number;
}

export async function apiMeWithToken(token: string): Promise<{ email: string; name?: string }> {
  let res: Response;
  try {
    res = await fetch(`${getApiBase()}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new ApiError(0, 'Server unreachable.', true);
  }
  if (!res.ok) throw new ApiError(res.status, res.statusText, res.status >= 500);
  return res.json();
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
