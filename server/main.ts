// plinth server: static files + a tiny JSON API for scenes, on Node built-ins
// only (node:http, node:sqlite). Bundled by esbuild into dist/server.mjs.
//
// Paths resolve from process.cwd(), not import.meta.url — esbuild flattens the
// module location, so file-relative paths would point at the wrong place.

import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  clearSessionCookie, constantTimeEqual, hasBearerToken, hasValidSession, isAuthPath,
  isPublicPath, isSecureRequest, readAuthConfig, serveLoginPage, sessionCookie, signSession,
  type AuthConfig,
} from './auth';
import { openStore } from './store';

const maxBodyBytes = 8 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).length;
    if (total > maxBodyBytes) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const raw = await readBody(request);
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

/** Accepts either a JSON `{ token }` body or a urlencoded form field `token`. */
async function readToken(request: IncomingMessage): Promise<string> {
  const contentType = (request.headers['content-type'] ?? '').toLowerCase();
  const raw = await readBody(request);
  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw) as { token?: unknown };
      return typeof parsed?.token === 'string' ? parsed.token : '';
    } catch {
      throw new HttpError(400, 'invalid JSON');
    }
  }
  return new URLSearchParams(raw).get('token') ?? '';
}

function acceptsHtml(request: IncomingMessage): boolean {
  return (request.headers.accept ?? '').includes('text/html');
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Optional `SceneDocument.combinatorics` boundary check (Feature 3). Kept inline
 * so the server stays zero-dependency and does not import the client core. When
 * absent the field is ignored; when present the header must be a known v1 shape.
 */
function validCombinatorics(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.format === 'plinth.combinatorics' &&
    candidate.version === 1 &&
    (candidate.scheme === 'iso-4' || candidate.scheme === 'iso-8') &&
    Array.isArray(candidate.primitives);
}

/**
 * Optional `SceneDocument.palette` boundary check (Feature 7). Kept inline so
 * the server stays zero-dependency. When absent the field is ignored; when
 * present every colour must be a strict `#rrggbb`.
 */
function validPalette(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.source === 'rampart' &&
    typeof candidate.name === 'string' &&
    Array.isArray(candidate.colors) &&
    candidate.colors.every((color) => typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color));
}

/** Shape check only — the client owns the schema; the server just refuses obvious garbage. */
export function validDocument(value: unknown): value is { name: string; version: 1; objects: unknown[]; settings: object; combinatorics?: unknown; palette?: unknown } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 &&
    typeof candidate.name === 'string' && candidate.name.length <= 200 &&
    Array.isArray(candidate.objects) && candidate.objects.length <= 20000 &&
    !!candidate.settings && typeof candidate.settings === 'object' &&
    (candidate.combinatorics === undefined || validCombinatorics(candidate.combinatorics)) &&
    (candidate.palette === undefined || validPalette(candidate.palette));
}

function documentFrom(body: unknown) {
  const document = (body as { document?: unknown })?.document;
  if (!validDocument(document)) throw new HttpError(400, 'expected { document: SceneDocument }');
  return document;
}

export interface AppServerOptions {
  auth?: AuthConfig;
  store?: ReturnType<typeof openStore>;
  staticDirectory?: string;
}

export interface AppServer {
  server: Server;
  store: ReturnType<typeof openStore>;
}

export function createAppServer(options: AppServerOptions = {}): AppServer {
  const auth = options.auth ?? readAuthConfig(process.env);
  const staticDirectory = options.staticDirectory ?? resolve(process.env.STATIC_DIR ?? join(process.cwd(), 'dist', 'public'));
  const store = options.store ?? (() => {
    const dataDirectory = resolve(process.env.DATA_DIR ?? join(process.cwd(), 'data'));
    mkdirSync(dataDirectory, { recursive: true });
    return openStore(join(dataDirectory, 'plinth.sqlite'));
  })();

  async function handleLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = await readToken(request);
    const wantsHtml = acceptsHtml(request);
    if (!auth.token || !constantTimeEqual(token, auth.token)) {
      await delay(250); // slow guessing
      if (wantsHtml) return serveLoginPage(response, 401, 'Incorrect token. Try again.');
      return sendJson(response, 401, { error: 'unauthorized' });
    }
    const session = signSession(auth.token, Date.now());
    response.setHeader('set-cookie', sessionCookie(session, auth, isSecureRequest(request, auth)));
    if (wantsHtml) { response.writeHead(303, { location: '/' }); response.end(); return; }
    return sendJson(response, 200, { ok: true });
  }

  function handleLogout(request: IncomingMessage, response: ServerResponse): void {
    response.setHeader('set-cookie', clearSessionCookie(isSecureRequest(request, auth)));
    if (acceptsHtml(request)) { response.writeHead(303, { location: '/' }); response.end(); return; }
    return sendJson(response, 200, { ok: true });
  }

  async function handleApi(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    const method = request.method ?? 'GET';
    if (path === '/api/health') return sendJson(response, 200, { ok: true });

    if (path === '/api/auth/session') {
      if (method === 'GET') return sendJson(response, 200, { authenticated: hasValidSession(request, auth) });
      if (method === 'POST') return handleLogin(request, response);
      throw new HttpError(405, 'method not allowed');
    }
    if (path === '/api/auth/logout') {
      if (method === 'POST') return handleLogout(request, response);
      throw new HttpError(405, 'method not allowed');
    }

    if (path === '/api/scenes') {
      if (method === 'GET') return sendJson(response, 200, store.list());
      if (method === 'POST') {
        const document = documentFrom(await readJson(request));
        const id = randomBytes(9).toString('base64url');
        store.put(id, document.name, JSON.stringify(document));
        return sendJson(response, 201, { id });
      }
      throw new HttpError(405, 'method not allowed');
    }

    const match = path.match(/^\/api\/scenes\/([\w-]{1,64})$/);
    if (match) {
      const id = match[1];
      if (method === 'GET') {
        const row = store.get(id);
        if (!row) throw new HttpError(404, 'not found');
        return sendJson(response, 200, { id, document: JSON.parse(row.document), updatedAt: row.updatedAt });
      }
      if (method === 'PUT') {
        const document = documentFrom(await readJson(request));
        const updatedAt = store.put(id, document.name, JSON.stringify(document));
        return sendJson(response, 200, { id, updatedAt });
      }
      if (method === 'DELETE') {
        store.remove(id);
        return sendJson(response, 200, { ok: true });
      }
      throw new HttpError(405, 'method not allowed');
    }
    throw new HttpError(404, 'not found');
  }

  function serveStatic(request: IncomingMessage, response: ServerResponse, path: string): void {
    let decoded: string;
    try { decoded = decodeURIComponent(path); } catch { throw new HttpError(400, 'bad path'); }
    const candidate = normalize(join(staticDirectory, decoded));
    // Unknown paths (and directory traversal attempts) get the SPA shell.
    const file = candidate.startsWith(staticDirectory + sep) && existsSync(candidate) && statSync(candidate).isFile()
      ? candidate
      : join(staticDirectory, 'index.html');
    if (!existsSync(file)) {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('Client not built. Run `npm run build`.');
      return;
    }
    const isHashedAsset = file.startsWith(join(staticDirectory, 'assets') + sep);
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(file).pipe(response);
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    try {
      // Gate everything (API *and* static) when a token is configured. The auth
      // endpoints and the healthcheck stay reachable pre-auth.
      if (auth.token && !isPublicPath(url.pathname) && !isAuthPath(url.pathname)) {
        const authorized = hasValidSession(request, auth) || hasBearerToken(request, auth.token);
        if (!authorized) {
          if (url.pathname.startsWith('/api/')) return sendJson(response, 401, { error: 'unauthorized' });
          return serveLoginPage(response);
        }
      }
      if (url.pathname.startsWith('/api/')) await handleApi(request, response, url.pathname);
      else serveStatic(request, response, url.pathname);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      if (!response.headersSent) sendJson(response, status, { error: (error as Error).message });
      else response.end();
    }
  });

  return { server, store };
}

// ── Entry point ──────────────────────────────────────────────────────────────
// Only listen when this module is the process entry (not when imported by tests).
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (entry && import.meta.url === entry) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';
  const auth = readAuthConfig(process.env);
  if (!auth.token) console.warn('plinth: PLINTH_TOKEN is not set — the app is UNPROTECTED');
  const { server, store } = createAppServer({ auth });
  server.listen(port, host, () => {
    console.log(`plinth listening on http://${host}:${port}`);
  });
  const shutdown = () => { server.close(); store.close(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
