// PKCE helpers — OAuth 2.1 / RFC 7636
// All crypto via Web Crypto API (available in WKWebView iOS 11+)

const VERIFIER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/** Generate a code_verifier: 64 random URL-safe chars (RFC 7636 §4.1) */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(b => VERIFIER_CHARS[b % VERIFIER_CHARS.length])
    .join('');
}

/** Compute code_challenge = BASE64URL(SHA256(verifier)) */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier);
  const digest  = await crypto.subtle.digest('SHA-256', encoded);
  return base64urlEncode(new Uint8Array(digest));
}

/** Generate a random state parameter (32 random bytes → base64url) */
export function generateState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

function base64urlEncode(buffer: Uint8Array): string {
  let bin = '';
  for (const b of buffer) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
