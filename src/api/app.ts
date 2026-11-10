import { timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ZodType } from 'zod';
import { AuthError, type AuthService, type AuthUser } from '../auth/service.ts';
import type { Db } from '../storage/db.ts';
import { num } from '../storage/db.ts';
import type { EventFilter, Repos } from '../storage/repositories.ts';
import { ApiError, errorResponse, json, type ApiRequest, type ApiResponse } from './http.ts';
import {
  createUserBody, eventsQuery, exclusionBody, groupIdSchema, groupPatch, loginBody, pageQuery, passwordBody,
  setupBody, settingsPatch, statsQuery,
} from './schemas.ts';
import { clearSessionCookie, clientIp, originAllowed, parseCookies, RateLimiter, securityHeaders, SESSION_COOKIE, sessionCookie } from './security.ts';
import { serveStatic } from './static.ts';

export interface ApiConfig {
  secureCookies: boolean;
  trustProxy: boolean;
  allowedOrigins: string[];
  /** Enables POST /api/auth/setup while no user exists. Unset = setup endpoint disabled (use the CLI). */
  setupToken?: string;
  backupDir: string;
  dbPath: string;
  sessionTtlMs: number;
  /** Worker is reported offline if its heartbeat is older than this. */
  workerStaleMs: number;
  rate: { global: { limit: number; windowMs: number }; login: { limit: number; windowMs: number } };
  /** Directory with the built dashboard. Omit to serve the API only. */
  staticDir?: string;
  backupRetention: number;
}

export const DEFAULT_RATE = {
  global: { limit: 600, windowMs: 60_000 },
  login: { limit: 10, windowMs: 15 * 60_000 },
};

export interface ApiDeps {
  db: Db;
  repos: Repos;
  auth: AuthService;
  config: ApiConfig;
  now?: () => number;
  onUnexpectedError?: (err: unknown) => void;
}

type Access = 'public' | 'read' | 'admin';
interface Ctx {
  req: ApiRequest;
  ip: string;
  params: Record<string, string>;
  session: { user: AuthUser; csrfToken: string } | null;
  token: string | undefined;
}
type Handler = (c: Ctx) => ApiResponse | Promise<ApiResponse>;
interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  access: Access;
  handler: Handler;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function compile(pattern: string): { re: RegExp; keys: string[] } {
  const keys: string[] = [];
  const src = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { re: new RegExp(`^${src}$`), keys };
}

function parse<T>(schema: ZodType<T, any, any>, data: unknown): T {
  return schema.parse(data ?? {});
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createApi(deps: ApiDeps) {
  const { db, repos, auth, config } = deps;
  const now = deps.now ?? Date.now;
  const limiter = new RateLimiter(now);
  const routes: Route[] = [];
  const baseHeaders = securityHeaders(config.secureCookies);

  const route = (method: string, pattern: string, access: Access, handler: Handler) => {
    const { re, keys } = compile(pattern);
    routes.push({ method, re, keys, access, handler });
  };

  const audit = (c: Ctx, action: string, details: Record<string, unknown> = {}) =>
    repos.audit.record(action, c.session?.user ?? null, { ip: c.ip, ...details });

  function workerView() {
    const w = repos.worker.get();
    if (!w) return { state: 'unknown', online: false, lastSeen: null as number | null, info: {} as Record<string, unknown> };
    const { qr: _qr, ...info } = w.info as Record<string, unknown>;
    const online = now() - w.updatedAt < config.workerStaleMs && w.state !== 'stopped' && w.state !== 'failed';
    return { state: w.state, online, lastSeen: w.updatedAt, info };
  }

  function listBackups(): { name: string; sizeBytes: number; modifiedAt: number }[] {
    if (!existsSync(config.backupDir)) return [];
    return readdirSync(config.backupDir)
      .filter((f) => /^guardian-\d{8}-\d{6}\.db$/.test(f))
      .map((name) => {
        const st = statSync(join(config.backupDir, name));
        return { name, sizeBytes: st.size, modifiedAt: st.mtimeMs };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt || b.name.localeCompare(a.name));
  }

  function toFilter(q: ReturnType<typeof eventsQuery.parse>): EventFilter {
    const f: EventFilter = {};
    if (q.groupId) f.groupId = q.groupId;
    if (q.senderId) f.senderId = q.senderId;
    if (q.type) f.type = q.type;
    if (q.status) f.status = q.status;
    if (q.q) f.q = q.q;
    if (q.from !== undefined) f.from = q.from;
    if (q.to !== undefined) f.to = q.to;
    return f;
  }

  const groupIdParam = (c: Ctx) => groupIdSchema.parse(c.params['id']);
  const intParam = (c: Ctx, name: string) => {
    const n = Number(c.params[name]);
    if (!Number.isInteger(n) || n < 1) throw new ApiError(400, 'validation_error', `invalid ${name}`);
    return n;
  };

  // ---------------------------------------------------------------- public
  route('GET', '/api/health', 'public', () => {
    db.prepare('SELECT 1').get();
    return json(200, { ok: true, time: now() });
  });

  route('GET', '/api/auth/setup-status', 'public', () =>
    json(200, { needsSetup: auth.userCount() === 0, setupEnabled: Boolean(config.setupToken) }),
  );

  route('POST', '/api/auth/setup', 'public', async (c) => {
    const body = parse(setupBody, c.req.body);
    const rl = limiter.hit(`login:${c.ip}`, config.rate.login.limit, config.rate.login.windowMs);
    if (!rl.allowed) throw new ApiError(429, 'rate_limited', 'too many attempts', { 'retry-after': String(rl.retryAfterSec) });
    if (!config.setupToken) throw new ApiError(404, 'setup_disabled', 'initial setup is disabled; create the first user with the CLI');
    if (auth.userCount() > 0) throw new ApiError(409, 'already_configured', 'an administrator already exists');
    if (!safeEqual(body.setupToken, config.setupToken)) throw new ApiError(403, 'invalid_setup_token', 'invalid setup token');
    try {
      const user = await auth.createUser(body.username, body.password, 'admin');
      repos.audit.record('setup_admin_created', user, { ip: c.ip });
      return json(201, { user });
    } catch (e) {
      throw mapAuthError(e);
    }
  });

  route('POST', '/api/auth/login', 'public', async (c) => {
    const body = parse(loginBody, c.req.body);
    const rl = limiter.hit(`login:${c.ip}`, config.rate.login.limit, config.rate.login.windowMs);
    if (!rl.allowed) throw new ApiError(429, 'rate_limited', 'too many login attempts', { 'retry-after': String(rl.retryAfterSec) });
    try {
      const s = await auth.login(body.username, body.password);
      repos.audit.record('login', s.user, { ip: c.ip });
      return json(
        200,
        { user: s.user, csrfToken: s.csrfToken },
        { 'set-cookie': sessionCookie(s.token, (s.expiresAt - now()) / 1000, config.secureCookies) },
      );
    } catch (e) {
      if (e instanceof AuthError && (e.code === 'invalid_credentials' || e.code === 'locked')) {
        repos.audit.record('login_failed', null, { ip: c.ip, username: body.username.slice(0, 64), reason: e.code });
      }
      throw mapAuthError(e);
    }
  });

  // ---------------------------------------------------------------- authenticated
  route('GET', '/api/auth/me', 'read', (c) => json(200, { user: c.session!.user, csrfToken: c.session!.csrfToken }));

  route('POST', '/api/auth/logout', 'read', (c) => {
    if (c.token) auth.logout(c.token);
    audit(c, 'logout');
    return json(200, { ok: true }, { 'set-cookie': clearSessionCookie(config.secureCookies) });
  });

  route('POST', '/api/auth/password', 'read', async (c) => {
    const body = parse(passwordBody, c.req.body);
    try {
      await auth.changePassword(c.session!.user.id, body.current, body.next);
    } catch (e) {
      throw mapAuthError(e);
    }
    audit(c, 'password_changed');
    return json(200, { ok: true }, { 'set-cookie': clearSessionCookie(config.secureCookies) });
  });

  route('GET', '/api/overview', 'read', () => {
    const day = 24 * 60 * 60 * 1000;
    const groups = repos.groups.list();
    return json(200, {
      worker: workerView(),
      testMode: repos.settings.getGlobal().testMode,
      groups: { total: groups.length, enabled: groups.filter((g) => g.enabled).length },
      stats: { last7Days: repos.events.stats(now() - 7 * day), last30Days: repos.events.stats(now() - 30 * day), allTime: repos.events.stats(0) },
      recent: repos.events.list({}, 10, 0).rows,
    });
  });

  route('GET', '/api/stats', 'read', (c) => {
    const q = parse(statsQuery, c.req.query);
    return json(200, repos.events.stats(now() - q.days * 24 * 60 * 60 * 1000));
  });

  route('GET', '/api/connection', 'read', (c) => {
    const w = workerView();
    const raw = repos.worker.get();
    const isAdmin = c.session!.user.role === 'admin';
    // The pairing QR is only ever shown to administrators, and only while the worker is waiting for a scan.
    const qr = isAdmin && w.online && w.state === 'awaiting_qr' ? ((raw?.info as { qr?: string } | undefined)?.qr ?? null) : null;
    return json(200, { worker: w, qr, events: repos.worker.connectionEvents(50) });
  });

  route('GET', '/api/groups', 'read', () => {
    const groups = repos.groups.list().map((g) => ({ ...g, violations: repos.events.list({ groupId: g.groupId }, 1, 0).total }));
    return json(200, { groups });
  });

  route('GET', '/api/groups/:id', 'read', (c) => {
    const g = repos.groups.get(groupIdParam(c));
    if (!g) throw new ApiError(404, 'not_found', 'group not found');
    return json(200, { group: g });
  });

  route('PATCH', '/api/groups/:id', 'admin', (c) => {
    const id = groupIdParam(c);
    const patch = parse(groupPatch, c.req.body);
    if (!repos.groups.update(id, patch)) throw new ApiError(404, 'not_found', 'group not found');
    audit(c, 'group_updated', { groupId: id, fields: Object.keys(patch) });
    return json(200, { group: repos.groups.get(id) });
  });

  route('POST', '/api/groups/:id/exclusions', 'admin', (c) => {
    const id = groupIdParam(c);
    const { memberId } = parse(exclusionBody, c.req.body);
    if (!repos.groups.addExclusion(id, memberId)) throw new ApiError(404, 'not_found', 'group not found');
    audit(c, 'exclusion_added', { groupId: id, memberId });
    return json(201, { group: repos.groups.get(id) });
  });

  route('DELETE', '/api/groups/:id/exclusions/:memberId', 'admin', (c) => {
    const id = groupIdParam(c);
    const memberId = parse(exclusionBody, { memberId: c.params['memberId'] }).memberId;
    if (!repos.groups.removeExclusion(id, memberId)) throw new ApiError(404, 'not_found', 'exclusion not found');
    audit(c, 'exclusion_removed', { groupId: id, memberId });
    return json(200, { group: repos.groups.get(id) });
  });

  route('GET', '/api/settings', 'read', () => {
    const g = repos.settings.getGlobal();
    return json(200, { testMode: g.testMode, botId: g.botId, ownerIds: g.ownerIds });
  });

  route('PATCH', '/api/settings', 'admin', (c) => {
    const body = parse(settingsPatch, c.req.body);
    if (body.testMode === false && body.confirmDisableTestMode !== true) {
      throw new ApiError(400, 'confirmation_required', 'disabling test mode enables real deletions and removals; confirmDisableTestMode must be true');
    }
    const patch: { testMode?: boolean; ownerIds?: string[] } = {};
    if (body.testMode !== undefined) patch.testMode = body.testMode;
    if (body.ownerIds !== undefined) patch.ownerIds = body.ownerIds;
    repos.settings.updateGlobal(patch);
    audit(c, 'settings_updated', { fields: Object.keys(patch), testMode: patch.testMode });
    const g = repos.settings.getGlobal();
    return json(200, { testMode: g.testMode, botId: g.botId, ownerIds: g.ownerIds });
  });

  route('GET', '/api/events/export.csv', 'read', (c) => {
    const q = parse(eventsQuery.omit({ page: true, pageSize: true }), c.req.query);
    const filter = toFilter({ ...q, page: 1, pageSize: 1 });
    const rows = [];
    const MAX = 10_000;
    for (let off = 0; off < MAX; off += 500) {
      const page = repos.events.list(filter, 500, off).rows;
      rows.push(...page);
      if (page.length < 500) break;
    }
    audit(c, 'events_exported', { rows: rows.length });
    return {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="guardian-events.csv"',
      },
      body: `﻿${repos.events.toCsv(rows)}`,
    };
  });

  route('GET', '/api/events/:id', 'read', (c) => {
    const e = repos.events.get(intParam(c, 'id'));
    if (!e) throw new ApiError(404, 'not_found', 'event not found');
    return json(200, { event: e });
  });

  route('GET', '/api/events', 'read', (c) => {
    const q = parse(eventsQuery, c.req.query);
    const { rows, total } = repos.events.list(toFilter(q), q.pageSize, (q.page - 1) * q.pageSize);
    return json(200, { events: rows, total, page: q.page, pageSize: q.pageSize });
  });

  route('GET', '/api/members', 'read', (c) => {
    const q = parse(pageQuery, c.req.query);
    const exclusions = db.prepare('SELECT group_id, member_id FROM exclusions').all();
    const excluded = new Map<string, string[]>();
    for (const r of exclusions) {
      const m = String(r['member_id']);
      excluded.set(m, [...(excluded.get(m) ?? []), String(r['group_id'])]);
    }
    const members = repos.events.members(q.pageSize, (q.page - 1) * q.pageSize).map((m) => ({ ...m, excludedIn: excluded.get(m.senderId) ?? [] }));
    return json(200, { members, page: q.page, pageSize: q.pageSize });
  });

  route('GET', '/api/audit', 'admin', () => json(200, { entries: repos.audit.list(200) }));

  route('GET', '/api/users', 'admin', () => json(200, { users: auth.listUsers() }));

  route('POST', '/api/users', 'admin', async (c) => {
    const body = parse(createUserBody, c.req.body);
    try {
      const user = await auth.createUser(body.username, body.password, body.role);
      audit(c, 'user_created', { username: user.username, role: user.role });
      return json(201, { user });
    } catch (e) {
      throw mapAuthError(e);
    }
  });

  route('DELETE', '/api/users/:id', 'admin', (c) => {
    const id = intParam(c, 'id');
    if (id === c.session!.user.id) throw new ApiError(400, 'cannot_delete_self', 'you cannot delete your own account');
    try {
      if (!auth.deleteUser(id)) throw new ApiError(404, 'not_found', 'user not found');
    } catch (e) {
      throw mapAuthError(e);
    }
    audit(c, 'user_deleted', { userId: id });
    return json(200, { ok: true });
  });

  route('GET', '/api/system', 'read', () => {
    let sizeBytes: number | null = null;
    try {
      sizeBytes = statSync(config.dbPath).size;
    } catch {
      sizeBytes = null;
    }
    const mem = process.memoryUsage();
    return json(200, {
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      memory: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed },
      database: { sizeBytes, migrations: db.prepare('SELECT id, name FROM schema_migrations ORDER BY id').all().map((r) => ({ id: num(r['id']), name: String(r['name']) })) },
      security: { secureCookies: config.secureCookies, trustProxy: config.trustProxy, setupEnabled: Boolean(config.setupToken), allowedOrigins: config.allowedOrigins.length },
      worker: workerView(),
      backups: { retention: config.backupRetention, items: listBackups() },
    });
  });

  route('POST', '/api/system/backups', 'admin', (c) => {
    mkdirSync(config.backupDir, { recursive: true });
    const d = new Date(now());
    const p = (n: number) => String(n).padStart(2, '0');
    const name = `guardian-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.db`;
    const target = join(config.backupDir, name);
    if (existsSync(target)) throw new ApiError(409, 'backup_exists', 'a backup was already created this second');
    db.prepare('VACUUM INTO ?').run(target); // consistent snapshot; the name is generated, never user supplied
    const all = listBackups();
    for (const old of all.slice(config.backupRetention)) unlinkSync(join(config.backupDir, old.name));
    audit(c, 'backup_created', { name });
    return json(201, { name, sizeBytes: statSync(target).size });
  });

  // ---------------------------------------------------------------- dispatcher
  function mapAuthError(e: unknown): unknown {
    if (!(e instanceof AuthError)) return e;
    switch (e.code) {
      case 'invalid_credentials': return new ApiError(401, 'invalid_credentials', e.message);
      case 'locked': return new ApiError(429, 'locked', e.message, { 'retry-after': '900' });
      case 'exists': return new ApiError(409, 'exists', e.message);
      case 'last_admin': return new ApiError(409, 'last_admin', e.message);
      default: return new ApiError(400, e.code, e.message);
    }
  }

  async function dispatch(req: ApiRequest, ip: string): Promise<ApiResponse> {
    const matches = routes
      .map((r) => ({ r, m: r.re.exec(req.path) }))
      .filter((x): x is { r: Route; m: RegExpExecArray } => x.m !== null);
    if (matches.length === 0) throw new ApiError(404, 'not_found', 'no such endpoint');
    const hit = matches.find((x) => x.r.method === req.method);
    if (!hit) {
      throw new ApiError(405, 'method_not_allowed', 'method not allowed', { allow: [...new Set(matches.map((x) => x.r.method))].join(', ') });
    }
    const params: Record<string, string> = {};
    try {
      hit.r.keys.forEach((k, i) => (params[k] = decodeURIComponent(hit.m[i + 1] as string)));
    } catch {
      throw new ApiError(400, 'bad_request', 'malformed URL encoding');
    }

    if (UNSAFE.has(req.method) && !originAllowed(req.headers, config.allowedOrigins)) {
      throw new ApiError(403, 'bad_origin', 'cross-origin request rejected');
    }

    const token = parseCookies(req.headers['cookie'])[SESSION_COOKIE];
    const session = auth.authenticate(token);
    if (hit.r.access !== 'public') {
      if (!session) throw new ApiError(401, 'unauthenticated', 'authentication required');
      if (hit.r.access === 'admin' && session.user.role !== 'admin') throw new ApiError(403, 'forbidden', 'administrator role required');
      if (UNSAFE.has(req.method) && !auth.verifyCsrf(session, req.headers['x-csrf-token'])) {
        throw new ApiError(403, 'csrf_failed', 'missing or invalid CSRF token');
      }
    }
    return hit.r.handler({ req, ip, params, session, token });
  }

  async function handle(req: ApiRequest): Promise<ApiResponse> {
    const ip = clientIp(req.headers, req.remoteAddress, config.trustProxy);
    let res: ApiResponse;
    try {
      const rl = limiter.hit(`global:${ip}`, config.rate.global.limit, config.rate.global.windowMs);
      if (!rl.allowed) throw new ApiError(429, 'rate_limited', 'too many requests', { 'retry-after': String(rl.retryAfterSec) });
      if (req.path.startsWith('/api/') || req.path === '/api') {
        res = await dispatch(req, ip);
        res.headers = { 'cache-control': 'no-store', ...res.headers };
      } else if ((req.method === 'GET' || req.method === 'HEAD') && config.staticDir) {
        res = serveStatic(config.staticDir, req.path) ?? json(404, { error: 'not_found', message: 'not found' });
      } else {
        res = json(404, { error: 'not_found', message: 'not found' });
      }
    } catch (err) {
      res = errorResponse(err, deps.onUnexpectedError);
      res.headers = { 'cache-control': 'no-store', ...res.headers };
    }
    res.headers = { ...baseHeaders, ...res.headers };
    return res;
  }

  return { handle };
}

export type Api = ReturnType<typeof createApi>;
