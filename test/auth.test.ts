import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  isPublicPath, readAuthConfig, signSession, verifySession, type AuthConfig,
} from '../server/auth';
import { createAppServer } from '../server/main';
import { openStore } from '../server/store';

const TOKEN = 'test-token-123';

function config(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return { token: TOKEN, cookieSecure: 'false', sessionTtl: 2592000, ...overrides };
}

function makeStaticDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plinth-auth-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app-shell</title>');
  return dir;
}

async function withServer(auth: AuthConfig, run: (base: string) => Promise<void>): Promise<void> {
  const store = openStore(':memory:');
  const staticDirectory = makeStaticDir();
  const { server } = createAppServer({ auth, store, staticDirectory });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(staticDirectory, { recursive: true, force: true });
  }
}

// ── Pure functions ───────────────────────────────────────────────────────────

test('session HMAC round-trips and rejects tampering, wrong key, and expiry', () => {
  const now = 1_000_000;
  const session = signSession(TOKEN, now);
  assert.equal(verifySession(TOKEN, session, now + 1000, 60), true);
  assert.equal(verifySession(TOKEN, session, now + 61_000, 60), false, 'expired');
  assert.equal(verifySession(TOKEN, `${session}x`, now, 60), false, 'tampered');
  assert.equal(verifySession('other-key', session, now, 60), false, 'wrong key');
  assert.equal(verifySession(TOKEN, 'garbage', now, 60), false, 'malformed');
});

test('isPublicPath exempts only /api/health', () => {
  assert.equal(isPublicPath('/api/health'), true);
  assert.equal(isPublicPath('/'), false);
  assert.equal(isPublicPath('/index.html'), false);
  assert.equal(isPublicPath('/assets/app.js'), false);
  assert.equal(isPublicPath('/api/scenes'), false);
});

test('readAuthConfig parses the environment with safe defaults', () => {
  assert.equal(readAuthConfig({}).token, '');
  assert.equal(readAuthConfig({ PLINTH_TOKEN: '  abc  ' }).token, 'abc');
  assert.equal(readAuthConfig({ PLINTH_COOKIE_SECURE: 'true' }).cookieSecure, 'true');
  assert.equal(readAuthConfig({ PLINTH_COOKIE_SECURE: 'nonsense' }).cookieSecure, 'auto');
  assert.equal(readAuthConfig({ PLINTH_SESSION_TTL: '60' }).sessionTtl, 60);
  assert.equal(readAuthConfig({ PLINTH_SESSION_TTL: 'nope' }).sessionTtl, 2592000);
});

// ── Server behavior ──────────────────────────────────────────────────────────

test('token unset: /api/scenes is open and / serves the app shell', async () => {
  await withServer(config({ token: '' }), async (base) => {
    const scenes = await fetch(`${base}/api/scenes`);
    assert.equal(scenes.status, 200);
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /app-shell/);
  });
});

test('token set: /api/scenes 401 and / serves the login page', async () => {
  await withServer(config(), async (base) => {
    const scenes = await fetch(`${base}/api/scenes`);
    assert.equal(scenes.status, 401);
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /<form/);
  });
});

test('bearer token authorizes API requests', async () => {
  await withServer(config(), async (base) => {
    const ok = await fetch(`${base}/api/scenes`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(ok.status, 200);
    const bad = await fetch(`${base}/api/scenes`, { headers: { authorization: 'Bearer nope' } });
    assert.equal(bad.status, 401);
  });
});

test('login sets a cookie that authorizes later requests; tampered cookie rejected', async () => {
  await withServer(config(), async (base) => {
    const wrong = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'nope' }),
    });
    assert.equal(wrong.status, 401);

    const login = await fetch(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie');
    assert.ok(setCookie && setCookie.includes('plinth_session='), 'sets the session cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(';')[0];

    const authed = await fetch(`${base}/api/scenes`, { headers: { cookie } });
    assert.equal(authed.status, 200);

    const tampered = await fetch(`${base}/api/scenes`, { headers: { cookie: `${cookie}x` } });
    assert.equal(tampered.status, 401);
  });
});

test('expired session is rejected', async () => {
  await withServer(config({ sessionTtl: 1 }), async (base) => {
    const session = signSession(TOKEN, Date.now() - 5000);
    const res = await fetch(`${base}/api/scenes`, { headers: { cookie: `plinth_session=${session}` } });
    assert.equal(res.status, 401);
  });
});

test('/api/health stays public when the token is set', async () => {
  await withServer(config(), async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test('GET /api/auth/session reports authentication state', async () => {
  await withServer(config(), async (base) => {
    const anon = await fetch(`${base}/api/auth/session`);
    assert.equal(anon.status, 200);
    assert.deepEqual(await anon.json(), { authenticated: false });

    const session = signSession(TOKEN, Date.now());
    const authed = await fetch(`${base}/api/auth/session`, { headers: { cookie: `plinth_session=${session}` } });
    assert.equal(authed.status, 200);
    assert.deepEqual(await authed.json(), { authenticated: true });
  });
});

test('logout clears the session cookie', async () => {
  await withServer(config(), async (base) => {
    const res = await fetch(`${base}/api/auth/logout`, { method: 'POST' });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie && setCookie.includes('Max-Age=0'), 'expires the cookie');
  });
});
