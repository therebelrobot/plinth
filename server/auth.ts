// Authentication for plinth: a single environment-variable token gates the whole
// app (the static bundle included) and every API. Sessions are HMAC-signed
// cookies with no server-side store, so the server stays zero-dependency
// (node:crypto only).
//
// Session format: base64url(hmacSHA256(token, issuedAtMs)) + '.' + issuedAtMs

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const SESSION_COOKIE = 'plinth_session';
const DEFAULT_SESSION_TTL = 2592000; // 30 days, in seconds

export interface AuthConfig {
  /** The shared secret. Empty string means auth is disabled (open). */
  token: string;
  /** `Secure` cookie attribute policy. `auto` infers from x-forwarded-proto. */
  cookieSecure: 'auto' | 'true' | 'false';
  /** Session lifetime in seconds. */
  sessionTtl: number;
}

export interface SessionPayload {
  issuedAt: number;
}

/** Read the auth configuration from the environment once, at startup. */
export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const token = (env.PLINTH_TOKEN ?? '').trim();
  const secureRaw = (env.PLINTH_COOKIE_SECURE ?? 'auto').trim().toLowerCase();
  const cookieSecure = secureRaw === 'true' || secureRaw === 'false' ? secureRaw : 'auto';
  const ttlRaw = Number(env.PLINTH_SESSION_TTL ?? DEFAULT_SESSION_TTL);
  const sessionTtl = Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : DEFAULT_SESSION_TTL;
  return { token, cookieSecure, sessionTtl };
}

/** Constant-time string comparison; a length mismatch short-circuits (HMACs are fixed length). */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function signSession(token: string, issuedAt: number): string {
  const mac = createHmac('sha256', token).update(String(issuedAt)).digest('base64url');
  return `${mac}.${issuedAt}`;
}

export function verifySession(token: string, session: string, now: number, ttlSeconds: number): boolean {
  const dot = session.lastIndexOf('.');
  if (dot <= 0) return false;
  const mac = session.slice(0, dot);
  const issuedAt = Number(session.slice(dot + 1));
  if (!Number.isFinite(issuedAt)) return false;
  const expected = createHmac('sha256', token).update(String(issuedAt)).digest('base64url');
  if (!constantTimeEqual(mac, expected)) return false;
  const age = now - issuedAt;
  return age >= 0 && age <= ttlSeconds * 1000;
}

function readCookie(request: IncomingMessage, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      try { return decodeURIComponent(value); } catch { return value; }
    }
  }
  return null;
}

/** True when the request carries a valid session cookie (or auth is disabled). */
export function hasValidSession(request: IncomingMessage, config: AuthConfig, now: number = Date.now()): boolean {
  if (!config.token) return true;
  const session = readCookie(request, SESSION_COOKIE);
  if (!session) return false;
  return verifySession(config.token, session, now, config.sessionTtl);
}

/** True when the request carries `Authorization: Bearer <token>` matching the secret. */
export function hasBearerToken(request: IncomingMessage, token: string): boolean {
  if (!token) return false;
  const header = request.headers.authorization;
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return constantTimeEqual(match[1].trim(), token);
}

/** Only the healthcheck is public; everything else (including the SPA) is gated. */
export function isPublicPath(pathname: string): boolean {
  return pathname === '/api/health';
}

/** Auth endpoints must be reachable before a session exists. */
export function isAuthPath(pathname: string): boolean {
  return pathname === '/api/auth/session' || pathname === '/api/auth/logout';
}

/** Resolve whether the `Secure` cookie attribute should be set for this request. */
export function isSecureRequest(request: IncomingMessage, config: AuthConfig): boolean {
  if (config.cookieSecure === 'true') return true;
  if (config.cookieSecure === 'false') return false;
  const forwarded = request.headers['x-forwarded-proto'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (value ?? '').split(',')[0].trim().toLowerCase() === 'https';
}

export function sessionCookie(session: string, config: AuthConfig, secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=${session}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${config.sessionTtl}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// HTML-escape via unicode escapes so the source never contains a literal entity
// sequence (which some editors/tools would decode).
function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    '\u0026': '\u0026amp;',
    '\u003c': '\u0026lt;',
    '\u003e': '\u0026gt;',
    '\u0022': '\u0026quot;',
    '\u0027': '\u0026#39;',
  };
  return value.replace(/[\u0026\u003c\u003e\u0022\u0027]/g, (character) => entities[character]);
}

/**
 * Self-contained login document. The SPA bundle is itself gated, so the login UI
 * must be server-rendered. The form posts urlencoded to /api/auth/session; the
 * server redirects back to `/` on success.
 */
export function loginPageHtml(error?: string): string {
  const message = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>plinth — sign in</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #1c1c1c; color: #ececec; font: 16px/1.5 ui-sans-serif, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  main { width: min(360px, 90vw); padding: 28px; background: #242424; border: 1px solid #3a3a3a; border-radius: 10px; }
  h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: 0.02em; }
  p { margin: 0 0 18px; color: #a8a8a8; font-size: 14px; }
  label { display: block; margin-bottom: 6px; font-size: 13px; color: #c8c8c8; }
  input { width: 100%; padding: 10px 12px; font: inherit; color: inherit; background: #1c1c1c; border: 1px solid #3a3a3a; border-radius: 7px; }
  input:focus-visible { outline: 2px solid #78c8ff; outline-offset: 1px; }
  button { width: 100%; margin-top: 14px; padding: 10px 12px; font: inherit; font-weight: 600; color: #1c1c1c; background: #ff7a3d; border: 0; border-radius: 7px; cursor: pointer; }
  button:hover { background: #ff8f5c; }
  .error { margin: 0 0 14px; color: #ff5c6c; font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>plinth</h1>
  <p>Enter the access token to continue.</p>
  ${message}
  <form method="post" action="/api/auth/session">
    <label for="token">Access token</label>
    <input id="token" name="token" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">Sign in</button>
  </form>
</main>
</body>
</html>
`;
}

export function serveLoginPage(response: ServerResponse, status = 200, error?: string): void {
  const html = loginPageHtml(error);
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(html);
}
