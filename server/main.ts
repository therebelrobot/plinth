// plinth server: static files + a tiny JSON API for scenes, on Node built-ins
// only (node:http, node:sqlite). Bundled by esbuild into dist/server.mjs.
//
// Paths resolve from process.cwd(), not import.meta.url — esbuild flattens the
// module location, so file-relative paths would point at the wrong place.

import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { openStore } from './store';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const dataDirectory = resolve(process.env.DATA_DIR ?? join(process.cwd(), 'data'));
const staticDirectory = resolve(process.env.STATIC_DIR ?? join(process.cwd(), 'dist', 'public'));
const maxBodyBytes = 8 * 1024 * 1024;

mkdirSync(dataDirectory, { recursive: true });
const store = openStore(join(dataDirectory, 'plinth.sqlite'));

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

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).length;
    if (total > maxBodyBytes) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

/** Shape check only — the client owns the schema; the server just refuses obvious garbage. */
function validDocument(value: unknown): value is { name: string; version: 1; objects: unknown[]; settings: object } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 &&
    typeof candidate.name === 'string' && candidate.name.length <= 200 &&
    Array.isArray(candidate.objects) && candidate.objects.length <= 20000 &&
    !!candidate.settings && typeof candidate.settings === 'object';
}

function documentFrom(body: unknown) {
  const document = (body as { document?: unknown })?.document;
  if (!validDocument(document)) throw new HttpError(400, 'expected { document: SceneDocument }');
  return document;
}

async function handleApi(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const method = request.method ?? 'GET';
  if (path === '/api/health') return sendJson(response, 200, { ok: true });

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
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url.pathname);
    else serveStatic(request, response, url.pathname);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(error);
    if (!response.headersSent) sendJson(response, status, { error: (error as Error).message });
    else response.end();
  }
});

server.listen(port, host, () => {
  console.log(`plinth listening on http://${host}:${port} (data: ${dataDirectory})`);
});

const shutdown = () => { server.close(); store.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
