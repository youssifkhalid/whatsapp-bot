import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { AuthError, AuthService } from '../src/auth/service.ts';
import { openDatabase } from '../src/storage/db.ts';
import { runMigrations } from '../src/storage/migrations.ts';
import { createRepos } from '../src/storage/repositories.ts';
import { createApi, DEFAULT_RATE, type ApiConfig } from '../src/api/app.ts';
import { createHttpServer } from '../src/api/server.ts';
import type { ModerationEvent } from '../src/core/types.ts';

const PW = 'correct horse battery';
const tmpRoot = () => mkdtempSync(join(process.env['TEST_TMPDIR'] ?? tmpdir(), 'guardian-api-'));

interface Res {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: any;
}

async function makeApp(over: Partial<ApiConfig> = {}, dbPath = ':memory:') {
  const db = await openDatabase(dbPath);
  runMigrations(db);
  const repos = createRepos(db);
  const clock = { offset: 0 };
  const now = () => Date.now() + clock.offset;
  const auth = new AuthService(db, { now, maxFailures: 5, sessionTtlMs: 3_600_000 });
  const errors: unknown[] = [];
  const config: ApiConfig = {
    secureCookies: false, trustProxy: false, allowedOrigins: [], backupDir: join(tmpdir(), 'unused-backups'), dbPath,
    sessionTtlMs: 3_600_000, workerStaleMs: 60_000, rate: DEFAULT_RATE, backupRetention: 14, ...over,
  };
  const api = createApi({ db, repos, auth, config, now, onUnexpectedError: (e) => errors.push(e) });

  async function call(
    method: string, path: string,
    o: { body?: unknown; cookie?: string; csrf?: string; headers?: Record<string, string>; query?: Record<string, string>; ip?: string } = {},
  ): Promise<Res> {
    const headers: Record<string, string | undefined> = { host: 'dash.example', ...o.headers };
    if (o.cookie) headers['cookie'] = o.cookie;
    if (o.csrf) headers['x-csrf-token'] = o.csrf;
    const r = await api.handle({ method, path, query: o.query ?? {}, headers, body: o.body, remoteAddress: o.ip ?? '10.0.0.1' });
    const text = typeof r.body === 'string' ? r.body : Buffer.from(r.body).toString('utf8');
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { status: r.status, headers: r.headers, text, json: parsed };
  }

  async function session(username: string, role: 'admin' | 'viewer') {
    await auth.createUser(username, PW, role);
    const r = await call('POST', '/api/auth/login', { body: { username, password: PW }, ip: `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
    assert.equal(r.status, 200, r.text);
    const cookie = (r.headers['set-cookie'] as string).split(';')[0] as string;
    return { cookie, csrf: r.json.csrfToken as string, user: r.json.user };
  }

  const w = (s: { cookie: string; csrf: string }, method: string, path: string, body?: unknown, o: { headers?: Record<string, string> } = {}) =>
    call(method, path, { body, cookie: s.cookie, csrf: s.csrf, ...o });
  const r = (s: { cookie: string }, path: string, query?: Record<string, string>) => call('GET', path, { cookie: s.cookie, ...(query ? { query } : {}) });

  return { api, db, repos, auth, call, session, w, r, clock, errors, config };
}

const ev = (over: Partial<ModerationEvent> = {}): ModerationEvent => ({
  messageId: 'm1', groupId: 'g1@g.us', senderId: 'u1@c.us', violation: { type: 'link', matched: 'evil.com', category: 'generic' },
  status: 'completed', testMode: false, messageDeleted: true, memberRemoved: true, noticeSent: false, errors: [], at: Date.now(), ...over,
});

// ------------------------------------------------------------------ public + setup

test('health is public, no-store, and carries security headers', async () => {
  const { call } = await makeApp();
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.match(r.headers['content-security-policy'] ?? '', /default-src 'self'/);
  assert.match(r.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/);
  assert.equal(r.headers['strict-transport-security'], undefined, 'HSTS only when secure cookies are on');
  const secure = await makeApp({ secureCookies: true });
  assert.match((await secure.call('GET', '/api/health')).headers['strict-transport-security'] ?? '', /max-age/);
});

test('first-run setup: disabled without a token, token-gated, one-shot', async () => {
  const off = await makeApp();
  assert.deepEqual((await off.call('GET', '/api/auth/setup-status')).json, { needsSetup: true, setupEnabled: false });
  const body = { username: 'owner', password: PW, setupToken: 'x' };
  assert.equal((await off.call('POST', '/api/auth/setup', { body })).status, 404);

  const on = await makeApp({ setupToken: 'right-token' });
  assert.equal((await on.call('POST', '/api/auth/setup', { body: { ...body, setupToken: 'wrong' } })).status, 403);
  assert.equal(on.auth.userCount(), 0);
  const ok = await on.call('POST', '/api/auth/setup', { body: { ...body, setupToken: 'right-token' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.user.role, 'admin');
  assert.equal(ok.text.includes('password'), false);
  assert.equal((await on.call('POST', '/api/auth/setup', { body: { ...body, username: 'second', setupToken: 'right-token' } })).status, 409);
  assert.equal((await on.call('GET', '/api/auth/setup-status')).json.needsSetup, false);
});

test('setup is rate limited per IP', async () => {
  const { call } = await makeApp({ setupToken: 't', rate: { ...DEFAULT_RATE, login: { limit: 3, windowMs: 60_000 } } });
  const body = { username: 'owner', password: PW, setupToken: 'bad' };
  for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/api/auth/setup', { body })).status, 403);
  const blocked = await call('POST', '/api/auth/setup', { body });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['retry-after']) >= 1);
});

// ------------------------------------------------------------------ authentication

test('login sets an HttpOnly SameSite=Strict cookie and never returns the session token', async () => {
  const t = await makeApp({ secureCookies: true });
  await t.auth.createUser('owner', PW, 'admin');
  const r = await t.call('POST', '/api/auth/login', { body: { username: 'owner', password: PW } });
  assert.equal(r.status, 200);
  const cookie = r.headers['set-cookie'] as string;
  assert.match(cookie, /^guardian_session=/);
  for (const attr of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/', 'Max-Age=']) assert.ok(cookie.includes(attr), attr);
  const token = decodeURIComponent((cookie.split(';')[0] as string).split('=')[1] as string);
  assert.equal(r.text.includes(token), false);
  assert.equal(r.json.user.username, 'owner');
  assert.equal(r.json.user.password_hash, undefined);
  assert.ok(r.json.csrfToken);
});

test('bad credentials: generic 401, audited, lockout returns 429', async () => {
  const t = await makeApp();
  await t.auth.createUser('owner', PW, 'admin');
  const a = await t.call('POST', '/api/auth/login', { body: { username: 'owner', password: 'wrong wrong wrong' } });
  const b = await t.call('POST', '/api/auth/login', { body: { username: 'ghost', password: 'wrong wrong wrong' } });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.json.message, b.json.message);
  for (let i = 0; i < 5; i++) await t.call('POST', '/api/auth/login', { body: { username: 'owner', password: 'wrong wrong wrong' }, ip: `10.1.1.${i}` });
  const locked = await t.call('POST', '/api/auth/login', { body: { username: 'owner', password: PW }, ip: '10.2.2.2' });
  assert.equal(locked.status, 429);
  assert.equal(locked.json.error, 'locked');
  const entries = t.repos.audit.list(50).filter((e) => e.action === 'login_failed');
  assert.ok(entries.length >= 2);
  assert.ok(!JSON.stringify(entries).includes('wrong wrong'), 'attempted passwords are never logged');
});

test('login is rate limited per IP independent of username', async () => {
  const { call } = await makeApp({ rate: { ...DEFAULT_RATE, login: { limit: 4, windowMs: 60_000 } } });
  for (let i = 0; i < 4; i++) assert.equal((await call('POST', '/api/auth/login', { body: { username: `u${i}`, password: 'x' } })).status, 401);
  const r = await call('POST', '/api/auth/login', { body: { username: 'u9', password: 'x' } });
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'rate_limited');
});

test('global rate limit applies to all requests and is per client IP', async () => {
  const { call } = await makeApp({ rate: { ...DEFAULT_RATE, global: { limit: 5, windowMs: 60_000 } } });
  for (let i = 0; i < 5; i++) assert.equal((await call('GET', '/api/health')).status, 200);
  assert.equal((await call('GET', '/api/health')).status, 429);
  assert.equal((await call('GET', '/api/health', { ip: '10.7.7.7' })).status, 200);
});

test('forwarded headers are ignored unless the proxy is trusted', async () => {
  const spoof = { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '1.2.3.4' };
  const direct = await makeApp({ rate: { ...DEFAULT_RATE, global: { limit: 2, windowMs: 60_000 } } });
  await direct.call('GET', '/api/health', { headers: { ...spoof } });
  await direct.call('GET', '/api/health', { headers: { 'x-forwarded-for': '5.5.5.5' } });
  assert.equal((await direct.call('GET', '/api/health', { headers: { 'x-forwarded-for': '6.6.6.6' } })).status, 429, 'spoofing does not evade the limit');

  const proxied = await makeApp({ trustProxy: true, rate: { ...DEFAULT_RATE, global: { limit: 1, windowMs: 60_000 } } });
  assert.equal((await proxied.call('GET', '/api/health', { headers: { 'x-real-ip': '8.8.8.8' } })).status, 200);
  assert.equal((await proxied.call('GET', '/api/health', { headers: { 'x-real-ip': '9.9.9.9' } })).status, 200);
  assert.equal((await proxied.call('GET', '/api/health', { headers: { 'x-real-ip': '8.8.8.8' } })).status, 429);
});

test('every protected endpoint rejects unauthenticated and forged-cookie requests', async () => {
  const { call } = await makeApp();
  const endpoints: [string, string][] = [
    ['GET', '/api/auth/me'], ['POST', '/api/auth/logout'], ['POST', '/api/auth/password'], ['GET', '/api/overview'], ['GET', '/api/stats'],
    ['GET', '/api/connection'], ['GET', '/api/groups'], ['GET', '/api/groups/g1@g.us'], ['PATCH', '/api/groups/g1@g.us'],
    ['POST', '/api/groups/g1@g.us/exclusions'], ['DELETE', '/api/groups/g1@g.us/exclusions/u@c.us'], ['GET', '/api/settings'],
    ['PATCH', '/api/settings'], ['GET', '/api/events'], ['GET', '/api/events/1'], ['GET', '/api/events/export.csv'], ['GET', '/api/members'],
    ['GET', '/api/audit'], ['GET', '/api/users'], ['POST', '/api/users'], ['DELETE', '/api/users/2'], ['GET', '/api/system'],
    ['POST', '/api/system/backups'],
  ];
  for (const [m, p] of endpoints) {
    const a = await call(m, p);
    assert.equal(a.status, 401, `${m} ${p}`);
    const b = await call(m, p, { cookie: 'guardian_session=forged', csrf: 'x' });
    assert.equal(b.status, 401, `${m} ${p} forged`);
  }
});

test('logout revokes the session and clears the cookie; /me reflects the session', async () => {
  const t = await makeApp();
  const s = await t.session('owner', 'admin');
  assert.equal((await t.r(s, '/api/auth/me')).json.user.username, 'owner');
  const out = await t.w(s, 'POST', '/api/auth/logout');
  assert.equal(out.status, 200);
  assert.match(out.headers['set-cookie'] ?? '', /Max-Age=0/);
  assert.equal((await t.r(s, '/api/auth/me')).status, 401);
});

test('sessions expire', async () => {
  const t = await makeApp();
  const s = await t.session('owner', 'admin');
  t.clock.offset = 2 * 3_600_000;
  assert.equal((await t.r(s, '/api/overview')).status, 401);
});

test('password change requires the current password, revokes sessions and validates strength', async () => {
  const t = await makeApp();
  const s = await t.session('owner', 'admin');
  assert.equal((await t.w(s, 'POST', '/api/auth/password', { current: 'nope nope nope', next: 'a brand new passphrase' })).status, 401);
  assert.equal((await t.w(s, 'POST', '/api/auth/password', { current: PW, next: 'short' })).status, 400);
  const ok = await t.w(s, 'POST', '/api/auth/password', { current: PW, next: 'a brand new passphrase' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers['set-cookie'] ?? '', /Max-Age=0/);
  assert.equal((await t.r(s, '/api/auth/me')).status, 401);
  assert.ok(t.repos.audit.list().some((e) => e.action === 'password_changed'));
});

// ------------------------------------------------------------------ CSRF, origin, validation transport

test('CSRF: state-changing requests need the per-session token; reads do not', async () => {
  const t = await makeApp();
  const s = await t.session('owner', 'admin');
  t.repos.groups.discover('g1@g.us', 'A');
  const noToken = await t.call('PATCH', '/api/groups/g1@g.us', { body: { enabled: true }, cookie: s.cookie });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.json.error, 'csrf_failed');
  assert.equal((await t.call('PATCH', '/api/groups/g1@g.us', { body: { enabled: true }, cookie: s.cookie, csrf: 'wrong' })).status, 403);
  assert.equal(t.repos.groups.get('g1@g.us')?.enabled, false, 'rejected request had no effect');
  assert.equal((await t.w(s, 'PATCH', '/api/groups/g1@g.us', { enabled: true })).status, 200);
  assert.equal((await t.call('GET', '/api/groups', { cookie: s.cookie })).status, 200);
  const other = await t.session('other', 'admin');
  assert.equal((await t.call('PATCH', '/api/groups/g1@g.us', { body: { enabled: false }, cookie: s.cookie, csrf: other.csrf })).status, 403, "another session's token is not valid");
});

test('cross-origin state-changing requests are rejected even with valid cookie and token', async () => {
  const t = await makeApp();
  const s = await t.session('owner', 'admin');
  t.repos.groups.discover('g1@g.us', 'A');
  const evil = await t.w(s, 'PATCH', '/api/groups/g1@g.us', { enabled: true }, { headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  assert.equal(evil.json.error, 'bad_origin');
  assert.equal((await t.w(s, 'PATCH', '/api/groups/g1@g.us', { enabled: true }, { headers: { origin: 'http://dash.example' } })).status, 200);
  const pinned = await makeApp({ allowedOrigins: ['https://guardian.example.com'] });
  const ps = await pinned.session('owner', 'admin');
  pinned.repos.groups.discover('g1@g.us', 'A');
  assert.equal((await pinned.w(ps, 'PATCH', '/api/groups/g1@g.us', { enabled: true }, { headers: { origin: 'http://dash.example' } })).status, 403);
  assert.equal((await pinned.w(ps, 'PATCH', '/api/groups/g1@g.us', { enabled: true }, { headers: { origin: 'https://guardian.example.com' } })).status, 200);
});

test('unknown routes 404, wrong methods 405 with Allow, malformed encoding 400, API 404s are JSON not index.html', async () => {
  const t = await makeApp();
  assert.equal((await t.call('GET', '/api/nope')).status, 404);
  const m = await t.call('DELETE', '/api/health');
  assert.equal(m.status, 405);
  assert.match(m.headers['allow'] ?? '', /GET/);
  assert.equal((await t.call('GET', '/api/groups/%E0%A4%A')).status, 400);
});

test('validation: bad input yields 400 with field issues; unknown fields are rejected', async () => {
  const t = await makeApp();
  const s = await t.session('owner', 'admin');
  t.repos.groups.discover('g1@g.us', 'A');
  const bad = await t.w(s, 'PATCH', '/api/groups/g1@g.us', { links: { allowedDomains: ['not a domain!'] }, enabled: 'yes' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'validation_error');
  assert.ok(bad.json.issues.length >= 2);
  assert.equal((await t.w(s, 'PATCH', '/api/groups/g1@g.us', { enabled: true, isAdmin: true })).status, 400, 'strict schema, no mass assignment');
  assert.equal((await t.w(s, 'PATCH', '/api/groups/not-a-group', { enabled: true })).status, 400);
  assert.equal((await t.w(s, 'PATCH', '/api/groups/g1@g.us', { profanity: { customWords: Array(501).fill('x') } })).status, 400);
  assert.equal((await t.call('POST', '/api/auth/login', { body: { username: 'a', password: 'b', extra: 1 } })).status, 400);
  assert.equal((await t.call('POST', '/api/auth/login', { body: undefined })).status, 400);
  assert.equal((await t.call('POST', '/api/auth/login', { body: { username: { $ne: '' }, password: { $ne: '' } } })).status, 400);
});

// ------------------------------------------------------------------ RBAC

test('viewer is read-only: cannot write, cannot see admin-only resources or the pairing QR', async () => {
  const t = await makeApp();
  await t.session('owner', 'admin');
  const v = await t.session('watcher', 'viewer');
  t.repos.groups.discover('g1@g.us', 'A');
  t.repos.worker.set('awaiting_qr', { qr: 'SECRET-QR-PAYLOAD' });
  for (const [m, p, b] of [
    ['PATCH', '/api/groups/g1@g.us', { enabled: true }], ['POST', '/api/groups/g1@g.us/exclusions', { memberId: 'a@c.us' }],
    ['DELETE', '/api/groups/g1@g.us/exclusions/a@c.us', undefined], ['PATCH', '/api/settings', { testMode: true }],
    ['POST', '/api/users', { username: 'x1x', password: PW, role: 'admin' }], ['DELETE', '/api/users/1', undefined],
    ['POST', '/api/system/backups', undefined], ['GET', '/api/audit', undefined], ['GET', '/api/users', undefined],
  ] as [string, string, unknown][]) {
    const r = await t.w(v, m, p, b);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.json.error, 'forbidden');
  }
  assert.equal(t.repos.groups.get('g1@g.us')?.enabled, false);
  assert.equal((await t.r(v, '/api/overview')).status, 200);
  const c = await t.r(v, '/api/connection');
  assert.equal(c.json.qr, null);
  assert.ok(!c.text.includes('SECRET-QR-PAYLOAD'));
});

// ------------------------------------------------------------------ groups, exclusions, settings

test('groups: list/get/patch persist to SQLite and bump the worker config version', async () => {
  const t = await makeApp();
  const s = await t.session('owner', 'admin');
  t.repos.groups.discover('g1@g.us', 'Class A');
  await t.repos.eventStore.save(ev());
  const list = await t.r(s, '/api/groups');
  assert.equal(list.json.groups.length, 1);
  assert.equal(list.json.groups[0].violations, 1);
  assert.equal(list.json.groups[0].enabled, false);
  assert.equal((await t.r(s, '/api/groups/g1@g.us')).json.group.name, 'Class A');
  assert.equal((await t.r(s, '/api/groups/zzz@g.us')).status, 404);

  const v = t.repos.settings.version();
  const r = await t.w(s, 'PATCH', '/api/groups/g1@g.us', {
    enabled: true, notifyGroup: true,
    links: { allowedDomains: [' *.School.edu ', 'docs.example.org'], detectBareDomains: false },
    profanity: { customWords: ['badword'], allowWords: ['okword'] },
  });
  assert.equal(r.status, 200);
  const stored = t.repos.groups.get('g1@g.us')!;
  assert.equal(stored.enabled, true);
  assert.equal(stored.notifyGroup, true);
  assert.deepEqual(stored.links.allowedDomains, ['school.edu', 'docs.example.org'], 'domains normalised');
  assert.equal(stored.links.detectBareDomains, false);
  assert.deepEqual(stored.profanity.customWords, ['badword']);
  assert.ok(t.repos.settings.version() > v, 'worker will reload');
  assert.equal((await t.w(s, 'PATCH', '/api/groups/zzz@g.us', { enabled: true })).status, 404);
  assert.ok(t.repos.audit.list().some((e) => e.action === 'group_updated'));
});

test('exclusions: add, normalise, list, remove, 404s, per-group isolation', async () => {
  const t = await makeApp();
  const s = await t.session('owner', 'admin');
  t.repos.groups.discover('g1@g.us', 'A');
  t.repos.groups.discover('g2@g.us', 'B');
  const add = await t.w(s, 'POST', '/api/groups/g1@g.us/exclusions', { memberId: ' VIP@c.us ' });
  assert.equal(add.status, 201);
  assert.deepEqual(add.json.group.excludedMembers, ['vip@c.us']);
  assert.deepEqual(t.repos.groups.get('g2@g.us')?.excludedMembers, []);
  assert.equal((await t.w(s, 'POST', '/api/groups/g1@g.us/exclusions', { memberId: 'not an id' })).status, 400);
  assert.equal((await t.w(s, 'POST', '/api/groups/zzz@g.us/exclusions', { memberId: 'a@c.us' })).status, 404);
  const del = await t.w(s, 'DELETE', `/api/groups/g1@g.us/exclusions/${encodeURIComponent('vip@c.us')}`);
  assert.equal(del.status, 200);
  assert.deepEqual(del.json.group.excludedMembers, []);
  assert.equal((await t.w(s, 'DELETE', '/api/groups/g1@g.us/exclusions/vip@c.us')).status, 404);
});

test('settings: test mode defaults ON; turning it off needs explicit confirmation and is audited', async () => {
  const t = await makeApp();
  const s = await t.session('owner', 'admin');
  assert.equal((await t.r(s, '/api/settings')).json.testMode, true);
  const noConfirm = await t.w(s, 'PATCH', '/api/settings', { testMode: false });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.json.error, 'confirmation_required');
  assert.equal(t.repos.settings.getGlobal().testMode, true);
  assert.equal((await t.w(s, 'PATCH', '/api/settings', { testMode: false, confirmDisableTestMode: false })).status, 400);
  const ok = await t.w(s, 'PATCH', '/api/settings', { testMode: false, confirmDisableTestMode: true });
  assert.equal(ok.status, 200);
  assert.equal(t.repos.settings.getGlobal().testMode, false);
  assert.equal((await t.w(s, 'PATCH', '/api/settings', { testMode: true })).json.testMode, true, 're-enabling needs no confirmation');
  assert.equal((await t.w(s, 'PATCH', '/api/settings', { ownerIds: ['Owner@c.us'] })).json.ownerIds[0], 'owner@c.us');
  assert.equal((await t.w(s, 'PATCH', '/api/settings', { ownerIds: ['bad id'] })).status, 400);
  assert.equal((await t.w(s, 'PATCH', '/api/settings', { botId: 'spoof@c.us' })).status, 400, 'bot id is set by the worker only');
  const a = t.repos.audit.list().filter((e) => e.action === 'settings_updated');
  assert.ok(a.some((e) => (e.details as any).testMode === false));
});

// ------------------------------------------------------------------ events, members, stats

test('events: pagination, filters, search, detail, validation', async () => {
  const t = await makeApp();
  const s = await t.session('owner', 'admin');
  const base = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 30; i++) await t.repos.eventStore.save(ev({ messageId: `m${i}`, at: base + i * 1000 }));
  await t.repos.eventStore.save(ev({ messageId: 'p', groupId: 'g2@g.us', senderId: 'bad@c.us', violation: { type: 'profanity', matched: 'fuck' }, status: 'simulated', at: base + 99_000 }));

  const p1 = await t.r(s, '/api/events', { pageSize: '10' });
  assert.equal(p1.json.total, 31);
  assert.equal(p1.json.events.length, 10);
  assert.equal(p1.json.events[0].violation.matched, 'fuck', 'newest first');
  const p4 = await t.r(s, '/api/events', { pageSize: '10', page: '4' });
  assert.equal(p4.json.events.length, 1);
  assert.equal((await t.r(s, '/api/events', { type: 'profanity' })).json.total, 1);
  assert.equal((await t.r(s, '/api/events', { status: 'simulated' })).json.total, 1);
  assert.equal((await t.r(s, '/api/events', { groupId: 'g2@g.us' })).json.total, 1);
  assert.equal((await t.r(s, '/api/events', { q: 'bad@' })).json.total, 1);
  assert.equal((await t.r(s, '/api/events', { from: String(base + 98_000) })).json.total, 1);
  assert.equal((await t.r(s, '/api/events', { to: new Date(base + 4000).toISOString() })).json.total, 5);
  assert.equal((await t.r(s, '/api/events', { q: "' OR 1=1 --" })).json.total, 0);

  const id = p1.json.events[0].id;
  assert.equal((await t.r(s, `/api/events/${id}`)).json.event.id, id);
  assert.equal((await t.r(s, '/api/events/999999')).status, 404);
  assert.equal((await t.r(s, '/api/events/abc')).status, 400);
  for (const q of <Record<string, string>[]>[{ page: '0' },{ pageSize: '1000' }, { type: 'nope' }, { status: 'x' }, { from: 'garbage' }, { bogus: '1' }, { groupId: 'x' }]) {
    assert.equal((await t.r(s, '/api/events', q)).status, 400, JSON.stringify(q));
  }
});

test('events never expose message text (none is stored)', async () => {
  const t = await makeApp();
  const s = await t.session('owner', 'admin');
  await t.repos.eventStore.save(ev());
  const r = await t.r(s, '/api/events');
  assert.deepEqual(Object.keys(r.json.events[0]).sort(), ['at', 'detail', 'errors', 'groupId', 'id', 'memberRemoved', 'messageDeleted', 'messageId', 'noticeSent', 'senderId', 'status', 'testMode', 'violation'].filter((k) => k !== 'detail').sort());
});

test('CSV export: headers, BOM, filters, formula-injection guard, audited, rejects page params', async () => {
  const t = await makeApp();
  const s = await t.session('owner', 'admin');
  await t.repos.eventStore.save(ev({ senderId: '=cmd|calc@c.us', messageId: 'a' }));
  await t.repos.eventStore.save(ev({ messageId: 'b', groupId: 'g2@g.us' }));
  const r = await t.r(s, '/api/events/export.csv');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'] ?? '', /text\/csv/);
  assert.match(r.headers['content-disposition'] ?? '', /attachment/);
  assert.ok(r.text.startsWith('﻿id,time,group'));
  assert.equal(r.text.trim().split('\n').length, 3);
  assert.ok(r.text.includes("'=cmd|calc@c.us"));
  assert.equal((await t.r(s, '/api/events/export.csv', { groupId: 'g2@g.us' })).text.trim().split('\n').length, 2);
  assert.equal((await t.r(s, '/api/events/export.csv', { page: '2' })).status, 400);
  assert.ok(t.repos.audit.list().some((e) => e.action === 'events_exported'));
  assert.equal((await t.call('GET', '/api/events/export.csv')).status, 401);
});

test('members aggregate real events and mark exclusions', async () => {
  const t = await makeApp();
  const s = await t.session('owner', 'admin');
  t.repos.groups.discover('g1@g.us', 'A');
  t.repos.groups.addExclusion('g1@g.us', 'u1@c.us');
  await t.repos.eventStore.save(ev({ messageId: 'a' }));
  await t.repos.eventStore.save(ev({ messageId: 'b', memberRemoved: false }));
  await t.repos.eventStore.save(ev({ messageId: 'c', senderId: 'u2@c.us' }));
  await t.repos.eventStore.save(ev({ messageId: 'd', status: 'duplicate' }));
  const r = await t.r(s, '/api/members');
  const u1 = r.json.members.find((m: any) => m.senderId === 'u1@c.us');
  assert.equal(u1.violations, 2);
  assert.equal(u1.removed, 1);
  assert.deepEqual(u1.excludedIn, ['g1@g.us']);
  assert.deepEqual(r.json.members.find((m: any) => m.senderId === 'u2@c.us').excludedIn, []);
});

test('overview and stats come from the database, not constants', async () => {
  const t = await makeApp();
  const s = await t.session('owner', 'admin');
  const empty = (await t.r(s, '/api/overview')).json;
  assert.equal(empty.stats.allTime.violations, 0);
  assert.equal(empty.groups.total, 0);
  assert.equal(empty.worker.online, false);
  assert.equal(empty.worker.state, 'unknown');
  assert.equal(empty.testMode, true);

  t.repos.groups.discover('g1@g.us', 'A');
  t.repos.groups.update('g1@g.us', { enabled: true });
  t.repos.groups.discover('g2@g.us', 'B');
  const now = Date.now();
  await t.repos.eventStore.save(ev({ messageId: 'a', at: now }));
  await t.repos.eventStore.save(ev({ messageId: 'b', at: now, messageDeleted: true, memberRemoved: false }));
  await t.repos.eventStore.save(ev({ messageId: 'old', at: now - 20 * 86_400_000 }));
  t.repos.worker.set('connected', { uptimeMs: 5 });
  const o = (await t.r(s, '/api/overview')).json;
  assert.deepEqual(o.groups, { total: 2, enabled: 1 });
  assert.equal(o.stats.last7Days.violations, 2);
  assert.equal(o.stats.last30Days.violations, 3);
  assert.equal(o.stats.allTime.deletedMessages, 3);
  assert.equal(o.stats.allTime.removedMembers, 2);
  assert.equal(o.worker.online, true);
  assert.equal(o.recent.length, 3);
  assert.equal((await t.r(s, '/api/stats', { days: '1' })).json.violations, 2);
  assert.equal((await t.r(s, '/api/stats', { days: '0' })).status, 400);
});

// ------------------------------------------------------------------ connection / worker

test('connection: worker online/offline by heartbeat; QR only for admins, only while awaiting a scan, never in other fields', async () => {
  const t = await makeApp();
  const admin = await t.session('owner', 'admin');
  assert.equal((await t.r(admin, '/api/connection')).json.worker.online, false);

  t.repos.worker.set('connected', { qr: 'LEAK-1' });
  let c = await t.r(admin, '/api/connection');
  assert.equal(c.json.worker.online, true);
  assert.equal(c.json.qr, null, 'no QR unless awaiting_qr');
  assert.ok(!c.text.includes('LEAK-1'));

  t.repos.worker.set('awaiting_qr', { qr: 'PAIR-ME' });
  c = await t.r(admin, '/api/connection');
  assert.equal(c.json.qr, 'PAIR-ME');
  assert.equal(c.json.worker.info.qr, undefined, 'qr only in the dedicated field');
  assert.equal((await t.r(admin, '/api/overview')).text.includes('PAIR-ME'), false);
  assert.equal((await t.r(admin, '/api/system')).text.includes('PAIR-ME'), false);

  t.clock.offset = 5 * 60_000; // heartbeat now stale
  c = await t.r(admin, '/api/connection');
  assert.equal(c.json.worker.online, false);
  assert.equal(c.json.qr, null, 'stale QR is never shown');

  t.clock.offset = 0;
  t.repos.worker.set('failed', {});
  assert.equal((await t.r(admin, '/api/connection')).json.worker.online, false);
  t.repos.worker.logConnection('disconnected', 'NAVIGATION');
  assert.equal((await t.r(admin, '/api/connection')).json.events[0].kind, 'disconnected');
});

// ------------------------------------------------------------------ users

test('user management: create, validate, duplicates, delete, self-delete and last-admin protection', async () => {
  const t = await makeApp();
  const s = await t.session('owner', 'admin');
  const created = await t.w(s, 'POST', '/api/users', { username: 'helper', password: PW, role: 'viewer' });
  assert.equal(created.status, 201);
  assert.ok(!created.text.includes('hash'));
  assert.equal((await t.w(s, 'POST', '/api/users', { username: 'HELPER', password: PW, role: 'viewer' })).status, 409);
  assert.equal((await t.w(s, 'POST', '/api/users', { username: 'weak1', password: 'short', role: 'viewer' })).status, 400);
  assert.equal((await t.w(s, 'POST', '/api/users', { username: 'rolex', password: PW, role: 'root' })).status, 400);
  const list = (await t.r(s, '/api/users')).json.users;
  assert.deepEqual(list.map((u: any) => u.username), ['owner', 'helper']);
  assert.ok(list.every((u: any) => u.password_hash === undefined && u.passwordHash === undefined));

  assert.equal((await t.w(s, 'DELETE', `/api/users/${s.user.id}`)).json.error, 'cannot_delete_self');
  assert.equal((await t.w(s, 'DELETE', '/api/users/999')).status, 404);
  assert.equal((await t.w(s, 'DELETE', '/api/users/abc')).status, 400);
  const helperId = created.json.user.id;
  assert.equal((await t.w(s, 'DELETE', `/api/users/${helperId}`)).status, 200);
  assert.equal(t.auth.listUsers().length, 1);
});

test('the last administrator can never be deleted (service level)', async () => {
  const t = await makeApp();
  const a = await t.auth.createUser('owner', PW, 'admin');
  await t.auth.createUser('watcher', PW, 'viewer');
  assert.throws(() => t.auth.deleteUser(a.id), (e: unknown) => e instanceof AuthError && e.code === 'last_admin');
  assert.equal(t.auth.listUsers().length, 2);
});

test('deleting a user revokes that user\'s sessions', async () => {
  const t = await makeApp();
  const admin = await t.session('owner', 'admin');
  const v = await t.session('watcher', 'viewer');
  assert.equal((await t.r(v, '/api/overview')).status, 200);
  await t.w(admin, 'DELETE', `/api/users/${v.user.id}`);
  assert.equal((await t.r(v, '/api/overview')).status, 401);
});

test('audit log records admin actions and is admin-only', async () => {
  const t = await makeApp();
  const s = await t.session('owner', 'admin');
  t.repos.groups.discover('g1@g.us', 'A');
  await t.w(s, 'PATCH', '/api/groups/g1@g.us', { enabled: true });
  const r = await t.r(s, '/api/audit');
  assert.equal(r.status, 200);
  const actions = r.json.entries.map((e: any) => e.action);
  assert.ok(actions.includes('login') && actions.includes('group_updated'));
  const entry = r.json.entries.find((e: any) => e.action === 'group_updated');
  assert.equal(entry.username, 'owner');
  assert.ok(entry.details.ip);
});

// ------------------------------------------------------------------ system + backups

test('system info is real; backups create consistent SQLite snapshots and prune to the retention limit', async () => {
  const root = tmpRoot();
  try {
    const dbPath = join(root, 'guardian.db');
    const backupDir = join(root, 'backups');
    const t = await makeApp({ dbPath, backupDir, backupRetention: 2 }, dbPath);
    const s = await t.session('owner', 'admin');
    await t.repos.eventStore.save(ev());

    const sys = (await t.r(s, '/api/system')).json;
    assert.equal(sys.node, process.version);
    assert.ok(sys.database.sizeBytes > 0);
    assert.equal(sys.database.migrations[0].name, 'initial_schema');
    assert.deepEqual(sys.backups.items, []);
    assert.equal(sys.security.secureCookies, false);

    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      t.clock.offset = i * 2000;
      const b = await t.w(s, 'POST', '/api/system/backups');
      assert.equal(b.status, 201, b.text);
      assert.match(b.json.name, /^guardian-\d{8}-\d{6}\.db$/);
      names.push(b.json.name);
    }
    const files = readdirSync(backupDir).sort();
    assert.equal(files.length, 2, 'retention prunes the oldest');
    assert.ok(!files.includes(names[0] as string));
    // The snapshot is a valid database containing the data.
    const snap = await openDatabase(join(backupDir, files[1] as string));
    assert.equal(snap.prepare('SELECT COUNT(*) AS n FROM events').get()?.['n'], 1);
    snap.close();
    assert.equal((await t.r(s, '/api/system')).json.backups.items.length, 2);
    assert.ok(t.repos.audit.list().some((e) => e.action === 'backup_created'));
    // Same-second duplicate is refused rather than overwritten.
    t.clock.offset = 2 * 2000;
    assert.equal((await t.w(s, 'POST', '/api/system/backups')).status, 409);
    t.db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ errors, static files

test('unexpected failures return a generic 500 and never leak internals', async () => {
  const t = await makeApp();
  const s = await t.session('owner', 'admin');
  t.db.close();
  const r = await t.r(s, '/api/overview');
  assert.equal(r.status, 500);
  assert.deepEqual(Object.keys(r.json).sort(), ['error', 'message']);
  assert.equal(r.json.error, 'internal_error');
  assert.ok(!/sqlite|database|stack|at /i.test(r.text));
  assert.equal(t.errors.length, 1, 'reported to the logger hook');
  assert.equal(r.headers['x-content-type-options'], 'nosniff', 'headers still applied on errors');
});

test('static dashboard: SPA fallback, traversal blocked, only known file types, API 404s stay JSON', async () => {
  const root = tmpRoot();
  try {
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Guardian</title>');
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(dist, 'secret.env'), 'TOKEN=1');
    writeFileSync(join(root, 'outside.txt'), 'outside');
    const t = await makeApp({ staticDir: dist });

    const idx = await t.call('GET', '/');
    assert.equal(idx.status, 200);
    assert.match(idx.headers['content-type'] ?? '', /text\/html/);
    assert.equal(idx.headers['cache-control'], 'no-cache');
    assert.match(idx.headers['content-security-policy'] ?? '', /script-src 'self'/);
    assert.equal((await t.call('GET', '/groups')).text, idx.text, 'client-side routes fall back to index.html');
    const js = await t.call('GET', '/assets/app.js');
    assert.match(js.headers['content-type'] ?? '', /javascript/);
    assert.match(js.headers['cache-control'] ?? '', /max-age/);
    for (const p of ['/../outside.txt', '/%2e%2e/outside.txt', '/assets/%2e%2e/%2e%2e/outside.txt', '/..%2foutside.txt', '/secret.env', '/assets/%00.js', '/%E0%A4%A']) {
      const r = await t.call('GET', p);
      assert.ok(!r.text.includes('outside') && !r.text.includes('TOKEN='), p);
    }
    assert.equal((await t.call('GET', '/secret.env')).status, 404);
    assert.equal((await t.call('GET', '/api/missing')).headers['content-type']?.startsWith('application/json'), true);
    assert.equal((await t.call('POST', '/')).status, 404, 'static is GET/HEAD only');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('API-only mode (no static dir) returns 404 for non-API paths', async () => {
  const t = await makeApp();
  assert.equal((await t.call('GET', '/')).status, 404);
});

// ------------------------------------------------------------------ real HTTP

test('over real HTTP: cookie round trip, CSRF, content-type, JSON errors and body limits', async () => {
  const t = await makeApp();
  await t.auth.createUser('owner', PW, 'admin');
  t.repos.groups.discover('g1@g.us', 'A');
  const server = createHttpServer(t.api);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PW }),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get('set-cookie') as string).split(';')[0] as string;
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    assert.equal(login.headers.get('x-frame-options'), 'DENY');

    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    assert.equal(me.status, 200);

    const patch = (body: string, headers: Record<string, string>) =>
      fetch(`${base}/api/groups/g1@g.us`, { method: 'PATCH', headers: { cookie, ...headers }, body });
    const jsonH = { 'content-type': 'application/json', 'x-csrf-token': csrfToken };
    assert.equal((await patch('{"enabled":true}', { 'content-type': 'application/json' })).status, 403, 'CSRF enforced over HTTP');
    assert.equal((await patch('{"enabled":true}', { 'content-type': 'text/plain', 'x-csrf-token': csrfToken })).status, 415);
    const badJson = await patch('{nope', jsonH);
    assert.equal(badJson.status, 400);
    assert.equal(((await badJson.json()) as { error: string }).error, 'invalid_json');
    assert.equal((await patch(JSON.stringify({ enabled: true, pad: 'x'.repeat(300_000) }), jsonH).catch(() => ({ status: 413 }))).status, 413);
    assert.equal((await patch('{"enabled":true}', jsonH)).status, 200);
    assert.equal(t.repos.groups.get('g1@g.us')?.enabled, true);

    const csv = await fetch(`${base}/api/events/export.csv`, { headers: { cookie } });
    assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal((await fetch(`${base}/api/groups`)).status, 401);
    assert.equal((await fetch(`${base}/api/groups`, { method: 'PUT', headers: { cookie } })).status, 405);
  } finally {
    await new Promise((res) => server.close(res));
  }
});

test('hygiene: tmp artifacts of these tests are cleaned', () => {
  assert.equal(existsSync(join(tmpdir(), 'unused-backups')), false, 'no backup dir is created unless a backup is requested');
});
