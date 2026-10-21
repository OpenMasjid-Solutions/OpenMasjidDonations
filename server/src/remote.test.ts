// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the app working from OUTSIDE the masjid, through the OpenMasjidOS tunnel. There the platform
// serves us at https://<apps' hostname>/<basePath>/… WITHOUT stripping the prefix, on ONE hostname
// that every other app and the OpenMasjidOS dashboard share. Three properties:
//
//  1. THE PREFIX IS NEVER FORGOTTEN. A 429/5xx from /api/fabric/site used to be cached as "remote
//     access is off", and a box whose platform was not up yet at boot (a power cut starts every
//     container at once) knew no prefix until the next 20-second tick. Either way the page arrived
//     with `<base href="/">`, its script loaded from the DASHBOARD, and admin and donors alike got a
//     white screen.
//  2. THE ADMIN SESSION STAYS OURS. Set with Path=/, the browser sent it to every app on that shared
//     hostname — and the platform passes an app every cookie except its own — so any other app could
//     replay it here from its own server: refunds, Stripe settings, the donor list.
//  3. NOTHING ON THE PAGE ESCAPES THE PREFIX. A root-relative link leaves the app for the dashboard.
//
// The cold-cache half of (1) and all of (2) live in index.ts's wiring, so they are driven against
// the REAL server, spawned as a child process beside a fake platform.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

// fabric.ts reads `config` at import time, so the Fabric env must be set BEFORE it loads.
process.env.OPENMASJID_BASE_URL = 'https://os.test';
process.env.OPENMASJID_APP_SECRET = 'our-app-secret';
type Fabric = typeof import('./fabric');
let fabric: Fabric;

const realFetch = globalThis.fetch;

/** Answer the next Fabric calls with these statuses/bodies, in order. */
function platformSays(...replies: { status: number; body?: unknown }[]): void {
  globalThis.fetch = (async () => {
    const r = replies.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

const GOOD_SITE = { enabled: true, domain: 'apps.test', publicUrl: 'https://apps.test/donations', basePath: '/donations' };

// ── 1. The prefix, as a pure rule ───────────────────────────────────────────

test('underBase: takes our prefix off, and only ours', async () => {
  fabric ??= await import('./fabric');
  const { underBase } = fabric;
  assert.equal(underBase('/donations', '/donations'), '/');
  assert.equal(underBase('/donations/', '/donations'), '/');
  assert.equal(underBase('/donations/admin', '/donations'), '/admin');
  assert.equal(underBase('/donations/api/x?y=1', '/donations'), '/api/x?y=1');
  assert.equal(underBase('/donations?y=1', '/donations'), '/?y=1');
  assert.equal(underBase('/donationsX/admin', '/donations'), null, 'a longer segment is not our prefix');
  assert.equal(underBase('/students/admin', '/donations'), null);
  assert.equal(underBase('/admin', ''), null, 'no prefix known: nothing is under it');
});

test('site: a 429 or 5xx from the platform keeps the prefix — only 403/404 are answers', async () => {
  fabric ??= await import('./fabric');
  try {
    platformSays({ status: 200, body: GOOD_SITE });
    await fabric.fetchFabricSite(true);
    assert.equal(fabric.cachedFabricSite().basePath, '/donations');

    for (const status of [429, 500, 502, 503]) {
      platformSays({ status, body: { error: 'Too many requests.' } });
      await fabric.fetchFabricSite(true);
      assert.equal(fabric.cachedFabricSite().basePath, '/donations', `HTTP ${status} is no information and must not forget the prefix`);
    }

    // A real "no": this app has no `domain` grant (403) or the platform predates the endpoint (404).
    platformSays({ status: 403, body: { error: 'This app is not allowed to read site info.' } });
    await fabric.fetchFabricSite(true);
    assert.equal(fabric.cachedFabricSite().basePath, '');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('site: a prefix that is not a plain path is refused, not half-used', async () => {
  fabric ??= await import('./fabric');
  try {
    // It goes into routing, a <base href>, a cookie Path and a redirect's Location.
    for (const [raw, want] of [
      ['/donations', '/donations'],
      ['donations', '/donations'],
      ['/donations/', '/donations'],
      ['/give/zakat', '/give/zakat'],
      ['/don;ations', ''],
      ['//evil.example', ''],
      ['/a/../b', ''],
      ['/a b', ''],
      ['/"><script>', ''],
    ] as const) {
      platformSays({ status: 200, body: { ...GOOD_SITE, basePath: raw } });
      await fabric.fetchFabricSite(true);
      assert.equal(fabric.cachedFabricSite().basePath, want, JSON.stringify(raw));
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── 3. Nothing on the page escapes the prefix ───────────────────────────────

test('web: no root-relative link, image, fetch or navigation — each would land on the dashboard', () => {
  // Through the tunnel "/" is the OpenMasjidOS dashboard. Every in-app URL goes through withBase().
  const dir = path.join(__dirname, '..', '..', 'web', 'src');
  const offenders: string[] = [];
  for (const f of fs.readdirSync(dir).filter((n) => /\.tsx?$/.test(n))) {
    fs.readFileSync(path.join(dir, f), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (
          /\b(?:href|src|action)=["']\/(?!\/)/.test(line) ||
          /\bfetch\(\s*["'`]\/(?!\/)/.test(line) ||
          /\blocation(?:\.href)?\s*=\s*["'`]\/(?!\/)/.test(line) ||
          /\blocation\.(?:assign|replace)\(\s*["'`]\/(?!\/)/.test(line)
        ) {
          offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      });
  }
  assert.deepEqual(offenders, []);
});

// ── 1 + 2 against the REAL server ───────────────────────────────────────────

const SECRET = 'fake-app-secret';
/** The access token the platform's /_omos/open hands the admin's browser for THIS app. */
const ACCESS_TOKEN = 'a1.' + 'h'.repeat(22) + '.' + 'm'.repeat(43);
const TUNNEL = { 'cf-ray': '8f00aa11bb22cc33-LHR', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'apps.test' };

let site: { status: number; body?: unknown } = { status: 503 };
let siteCalls = 0;
/** The platform's public appearance endpoint drops the connection — what the app reads as
 *  "OpenMasjidOS is unreachable", the one state in which it offers password recovery. */
let platformLooksDown = false;
let platform: http.Server;
let child: ChildProcess;
let base = '';
let output = '';
const tmp: string[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

/** A request to the spawned server; redirects are NOT followed, so a 307 is visible. */
function call(p: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return realFetch(base + p, { ...init, redirect: 'manual' });
}

const cookieValue = (setCookie: string): string => setCookie.split(';')[0].split('=').slice(1).join('=');

before(async () => {
  platform = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/public/appearance') return platformLooksDown ? void req.socket.destroy() : send(200, {});
    if (req.headers['x-openmasjid-app-secret'] !== SECRET) return send(403, { error: 'Unknown app.' });
    if (req.url === '/api/fabric/site') {
      siteCalls += 1;
      return send(site.status, site.body ?? { error: 'Starting up.' });
    }
    if (req.url === '/api/auth/session') {
      // The platform's ingress puts this app's own access token FIRST in the Cookie header.
      const first = /(?:^|;\s*)omos_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      return send(200, first === ACCESS_TOKEN ? { authenticated: true, username: 'hasan' } : { authenticated: false });
    }
    send(404, { error: 'Not found.' });
  });
  await new Promise<void>((r) => platform.listen(0, '127.0.0.1', r));
  const platformPort = (platform.address() as AddressInfo).port;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-remote-data-'));
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omd-remote-web-'));
  tmp.push(dataDir, publicDir);
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>');

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, 'index.ts')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      PUBLIC_DIR: publicDir,
      OPENMASJID_BASE_URL: `http://127.0.0.1:${platformPort}`,
      OPENMASJID_APP_SECRET: SECRET,
      OPENMASJID_APP_ID: 'donations',
      CLOUDFLARED_BIN: path.join(dataDir, 'no-cloudflared'),
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const keep = (b: Buffer) => { output = (output + b.toString()).slice(-4000); };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);

  for (let i = 0; i < 150; i++) {
    try {
      if ((await realFetch(base + '/healthz')).ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the server did not start:\n' + output);
});

after(() => {
  child?.kill('SIGKILL');
  platform?.close();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

test('server: on the LAN a page load never waits on (or spends) a platform lookup', { timeout: 30_000 }, async () => {
  // Every client-side route (/admin, /<appeal>) is a "miss" that serves index.html. Runs first, while
  // no lookup has been made since boot, so a lookup here could not hide inside the 10s throttle.
  const before = siteCalls;
  const r = await call('/admin', { headers: { accept: 'text/html' } });
  assert.equal(r.status, 200);
  assert.equal(siteCalls, before);
});

test('server: a first visit from outside, before the prefix is known, is sent back to itself — not served a page that loads the dashboard', { timeout: 30_000 }, async () => {
  // We booted while the platform answered 503, so no prefix is known. Now it is up.
  site = { status: 200, body: GOOD_SITE };
  const first = await call('/donations/admin', { headers: { ...TUNNEL, accept: 'text/html' } });
  assert.equal(first.status, 307, 'the old code served index.html with <base href="/"> here:\n' + output);
  assert.equal(first.headers.get('location'), '/donations/admin', 'back to the very same address');

  const again = await call('/donations/admin', { headers: { ...TUNNEL, accept: 'text/html' } });
  assert.equal(again.status, 200);
  const html = await again.text();
  assert.match(html, /<base href="\/donations\/">/);
  assert.match(html, /window\.__OMOS_BASE__="\/donations"/);
});

test('server: a miss that is not ours is never redirected, and a flood of misses costs the platform one lookup', { timeout: 30_000 }, async () => {
  const before = siteCalls;
  for (let i = 0; i < 20; i++) {
    const r = await call(`/elsewhere/missing-${i}.js`, { headers: TUNNEL });
    assert.equal(r.status, 404);
  }
  assert.ok(siteCalls - before <= 2, `20 misses made ${siteCalls - before} platform lookups`); // ≤1 + a watcher tick
  const under = await call('/donations/missing.js', { headers: TUNNEL });
  assert.equal(under.status, 404, 'a genuine 404 under our prefix is a 404, not a loop');
  const odd = await call('//evil.example/x', { headers: TUNNEL });
  assert.ok(odd.status < 300 || odd.status >= 400, 'never a redirect off-site');
});

test('server: opened from the remote dashboard, SSO signs the admin in with a session scoped to our prefix', { timeout: 30_000 }, async () => {
  const r = await call('/donations/api/session', { headers: { ...TUNNEL, cookie: `omos_session=${ACCESS_TOKEN}; theme=dark` } });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { data: { authed: boolean; sso: { username?: string } } };
  assert.equal(body.data.authed, true, 'no password asked for');
  assert.equal(body.data.sso.username, 'hasan');

  const set = r.headers.getSetCookie().find((c) => c.startsWith('omdon_session='));
  assert.ok(set, 'a session was minted');
  assert.match(set, /;\s*Path=\/donations(?:;|$)/i, `scoped to our prefix, not the shared hostname: ${set}`);
  assert.match(set, /;\s*Secure/i);
  assert.match(set, /;\s*HttpOnly/i);
  assert.ok(!/^omos_session=/i.test(set), 'never the platform cookie name');

  // …and that session reaches the admin API under the prefix.
  const settings = await call('/donations/api/settings', { headers: { ...TUNNEL, cookie: `omdon_session=${cookieValue(set)}` } });
  assert.equal(settings.status, 200);
});

test('server: on the LAN the session cookie is exactly as before — Path=/, no Secure on plain HTTP', { timeout: 30_000 }, async () => {
  // The LAN page also calls the prefixed API once remote access is on, and plain /api too.
  for (const p of ['/donations/api/session', '/api/session']) {
    const r = await call(p, { headers: { cookie: `omos_session=${ACCESS_TOKEN}` } });
    const set = r.headers.getSetCookie().find((c) => c.startsWith('omdon_session='));
    assert.ok(set, p);
    assert.match(set, /;\s*Path=\/(?:;|$)/i, `${p}: ${set}`);
    assert.ok(!/;\s*Secure/i.test(set), `${p}: ${set}`);
  }
});

test('server: signing out from outside clears the session under our prefix, and an old one at /', { timeout: 30_000 }, async () => {
  const r = await call('/donations/api/logout', { method: 'POST', headers: TUNNEL });
  assert.equal(r.status, 200);
  const paths = r.headers
    .getSetCookie()
    .filter((c) => c.startsWith('omdon_session='))
    .map((c) => /;\s*Path=([^;]*)/i.exec(c)?.[1])
    .sort();
  assert.deepEqual(paths, ['/', '/donations']);
});

// ── 4. From outside, the password is never the way in ───────────────────────
// Under OpenMasjidOS the admin from the internet is the platform's two-step sign-in or nobody. The
// local password must not be guessable from there — and its limiter keys on the TCP peer, which
// through the tunnel is the platform's proxy, so every remote visitor shares one bucket anyway.

const PASSWORD = 'correct horse battery';
const post = (p: string, headers: Record<string, string>, body: unknown) =>
  call(p, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const sessionCookie = (r: Response) => r.headers.getSetCookie().find((c) => c.startsWith('omdon_session='));
/** A POST whose path goes on the wire exactly as written — fetch would resolve a dot segment first. */
function rawPost(p: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; setCookie: string[] }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const data = JSON.stringify(body);
    const req = http.request({ host: u.hostname, port: u.port, path: p, method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, setCookie: ([] as string[]).concat(res.headers['set-cookie'] ?? []) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('server: from outside, nobody can claim the password — not even while OpenMasjidOS looks unreachable', { timeout: 30_000 }, async () => {
  // The recovery opens exactly when the platform cannot be reached. Before this, that moment let
  // anyone on the internet choose the admin password of a shared app.
  platformLooksDown = true;
  try {
    for (const p of ['/donations/api/setup', '/donations/api/%73etup']) {
      const r = await post(p, TUNNEL, { password: PASSWORD });
      assert.equal(r.status, 403, `${p}: the old code answered 200 and set the admin password`);
      assert.match(((await r.json()) as { error: string }).error, /OpenMasjidOS dashboard/);
      assert.equal(sessionCookie(r), undefined);
    }
  } finally {
    platformLooksDown = false;
  }
});

test('server: on the LAN, recovery and the password work exactly as before', { timeout: 30_000 }, async () => {
  platformLooksDown = true;
  try {
    const setup = await post('/api/setup', {}, { password: PASSWORD });
    assert.equal(setup.status, 200, 'recovery while the platform is down is the LAN way back in');
    assert.ok(sessionCookie(setup));
  } finally {
    platformLooksDown = false;
  }
  // `/api/%6Cogin` too: the router decodes it to /api/login, which is why the guard lives in the
  // route rather than in a match on the URL.
  for (const p of ['/api/login', '/api/%6Cogin', '/donations/api/login']) {
    const r = await post(p, {}, { password: PASSWORD });
    assert.equal(r.status, 200, p);
    assert.match(sessionCookie(r) ?? '', /;\s*Path=\/(?:;|$)/i, p);
  }
  const wrong = await post('/api/login', {}, { password: 'not it' });
  assert.equal(wrong.status, 401);
});

test('server: from outside, the password never signs anyone in — in any spelling the router resolves', { timeout: 30_000 }, async () => {
  for (const p of ['/donations/api/login', '/donations/api/%6Cogin', '/donations/api/%6c%6F%67%69%6E']) {
    const r = await post(p, TUNNEL, { password: PASSWORD });
    assert.equal(r.status, 403, `${p}: the old code signed in with the right password`);
    assert.match(((await r.json()) as { error: string }).error, /OpenMasjidOS dashboard/);
    assert.equal(sessionCookie(r), undefined, p);
  }
  // A dot segment is not resolved by the router, so it never reaches the login route at all.
  for (const p of ['/donations/api/x/../login', '/donations/api/./login', '/donations/api/%2e/login']) {
    const dot = await rawPost(p, TUNNEL, { password: PASSWORD });
    assert.ok(dot.status !== 200 && dot.status !== 401, `${p}: ${dot.status}`);
    assert.ok(!dot.setCookie.some((c) => c.startsWith('omdon_session=')), p);
  }
  // Ten refused attempts from outside never lock the admin out at the masjid.
  for (let i = 0; i < 10; i++) await post('/donations/api/login', TUNNEL, { password: 'guess ' + i });
  assert.equal((await post('/api/login', {}, { password: PASSWORD })).status, 200);
});

test('server: from outside the panel is told there is no password box; SSO, the admin API, logout and donors are untouched', { timeout: 30_000 }, async () => {
  const anon = (await (await call('/donations/api/session', { headers: TUNNEL })).json()) as { data: { authed: boolean; passwordClosed?: boolean } };
  assert.deepEqual([anon.data.authed, anon.data.passwordClosed], [false, true]);
  const lan = (await (await call('/api/session')).json()) as { data: { passwordClosed?: boolean } };
  assert.equal(lan.data.passwordClosed, false);

  const sso = await call('/donations/api/session', { headers: { ...TUNNEL, cookie: `omos_session=${ACCESS_TOKEN}` } });
  const set = sessionCookie(sso);
  assert.ok(set, 'SSO still signs the admin in from outside');
  const admin = await call('/donations/api/admin/metrics', { headers: { ...TUNNEL, cookie: `omdon_session=${cookieValue(set)}` } });
  assert.equal(admin.status, 200);
  assert.equal((await call('/donations/api/logout', { method: 'POST', headers: TUNNEL })).status, 200);
  assert.equal((await call('/donations/api/app', { headers: TUNNEL })).status, 200, 'the public bootstrap a donor page reads');
});
