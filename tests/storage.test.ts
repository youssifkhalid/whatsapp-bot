import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction, type Db } from '../src/storage/db.ts';
import { MIGRATIONS, runMigrations } from '../src/storage/migrations.ts';
import { createRepos } from '../src/storage/repositories.ts';
import { Moderator } from '../src/core/moderator.ts';
import type { ModerationEvent, WhatsAppPort } from '../src/core/types.ts';

async function memDb(): Promise<Db> {
  const db = await openDatabase(':memory:');
  runMigrations(db);
  return db;
}

const ev = (over: Partial<ModerationEvent> = {}): ModerationEvent => ({
  messageId: 'm1', groupId: 'g1@g.us', senderId: 'u1@c.us',
  violation: { type: 'link', matched: 'evil.com', category: 'generic' },
  status: 'completed', testMode: false, messageDeleted: true, memberRemoved: true, noticeSent: false,
  errors: [], at: 1_700_000_000_000, ...over,
});

test('migrations apply once and are idempotent', async () => {
  const db = await openDatabase(':memory:');
  assert.deepEqual(runMigrations(db), MIGRATIONS.map((m) => m.id));
  assert.deepEqual(runMigrations(db), []);
});

test('a failing migration rolls back completely', async () => {
  const db = await openDatabase(':memory:');
  assert.throws(() =>
    runMigrations(db, [{ id: 1, name: 'bad', sql: 'CREATE TABLE a (x INT); CREATE TABLE a (x INT);' }]),
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='a'").get()?.['n'], 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.['n'], 0);
});

test('transaction rolls back on error and nested calls join', async () => {
  const db = await memDb();
  assert.throws(() =>
    transaction(db, () => {
      db.prepare("INSERT INTO settings (key,value) VALUES ('a','1')").run();
      transaction(db, () => db.prepare("INSERT INTO settings (key,value) VALUES ('b','2')").run());
      throw new Error('boom');
    }),
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settings').get()?.['n'], 0);
});

test('event store claim is atomic: second claim of same key fails', async () => {
  const { eventStore } = createRepos(await memDb());
  assert.equal(await eventStore.claim('g:1'), true);
  assert.equal(await eventStore.claim('g:1'), false);
  assert.equal(await eventStore.claim('g2:1'), true);
});

test('events persist across reopening the database file', async () => {
  const dir = mkdtempSync(join(process.env['TEST_TMPDIR'] ?? tmpdir(), 'guardian-'));
  try {
    const path = join(dir, 'g.db');
    const db1 = await openDatabase(path);
    runMigrations(db1);
    const r1 = createRepos(db1);
    await r1.eventStore.claim('g1@g.us:m1');
    await r1.eventStore.save(ev());
    r1.settings.updateGlobal({ testMode: false, botId: 'bot@c.us' });
    db1.close();

    const db2 = await openDatabase(path);
    runMigrations(db2);
    const r2 = createRepos(db2);
    assert.equal(r2.events.list({}).total, 1);
    assert.equal(await r2.eventStore.claim('g1@g.us:m1'), false, 'idempotency survives restart');
    assert.equal(r2.settings.getGlobal().testMode, false);
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('test mode defaults to enabled and bumps config version when changed', async () => {
  const { settings } = createRepos(await memDb());
  assert.equal(settings.getGlobal().testMode, true);
  const v = settings.version();
  settings.updateGlobal({ testMode: false });
  assert.equal(settings.getGlobal().testMode, false);
  assert.equal(settings.version(), v + 1);
});

test('discovered groups start disabled and rediscovery keeps settings', async () => {
  const { groups } = createRepos(await memDb());
  groups.discover('g1@g.us', 'Class A');
  assert.equal(groups.get('g1@g.us')?.enabled, false);
  groups.update('g1@g.us', { enabled: true, links: { enabled: true, detectBareDomains: false, allowedDomains: ['school.edu'] } });
  groups.discover('g1@g.us', 'Class A renamed');
  const g = groups.get('g1@g.us')!;
  assert.equal(g.enabled, true);
  assert.equal(g.name, 'Class A renamed');
  assert.deepEqual(g.links.allowedDomains, ['school.edu']);
  assert.equal(g.links.detectBareDomains, false);
});

test('exclusions are per group and bump the config version', async () => {
  const { groups, settings } = createRepos(await memDb());
  groups.discover('g1@g.us', 'A');
  groups.discover('g2@g.us', 'B');
  const v = settings.version();
  assert.equal(groups.addExclusion('g1@g.us', 'vip@c.us'), true);
  assert.equal(groups.addExclusion('nope@g.us', 'vip@c.us'), false);
  assert.deepEqual(groups.get('g1@g.us')?.excludedMembers, ['vip@c.us']);
  assert.deepEqual(groups.get('g2@g.us')?.excludedMembers, []);
  assert.ok(settings.version() > v);
  assert.equal(groups.removeExclusion('g1@g.us', 'vip@c.us'), true);
  assert.equal(groups.removeExclusion('g1@g.us', 'vip@c.us'), false);
});

test('event listing: filters, search with wildcards escaped, pagination, stats, members', async () => {
  const r = createRepos(await memDb());
  for (let i = 0; i < 5; i++) await r.eventStore.save(ev({ messageId: `m${i}`, at: 1_700_000_000_000 + i * 1000 }));
  await r.eventStore.save(ev({ messageId: 'x', senderId: 'other@c.us', groupId: 'g2@g.us',
    violation: { type: 'profanity', matched: 'fuck' }, status: 'simulated', testMode: true, messageDeleted: false, memberRemoved: false }));
  await r.eventStore.save(ev({ messageId: 'dup', status: 'duplicate' }));

  assert.equal(r.events.list({}).total, 7);
  assert.equal(r.events.list({ groupId: 'g2@g.us' }).total, 1);
  assert.equal(r.events.list({ type: 'profanity' }).rows[0]?.violation.matched, 'fuck');
  assert.equal(r.events.list({ q: 'evil' }).total, 6);
  assert.equal(r.events.list({ q: '%' }).total, 0, 'LIKE wildcard must be escaped');
  const page = r.events.list({}, 3, 3);
  assert.equal(page.rows.length, 3);
  assert.equal(page.total, 7);

  const s = r.events.stats(0);
  assert.equal(s.violations, 6, 'duplicates are not violations');
  assert.equal(s.deletedMessages, 5);
  assert.equal(s.removedMembers, 5);
  assert.equal(s.simulated, 1);
  assert.ok(s.daily.length >= 1);

  const m = r.events.members();
  assert.equal(m.find((x) => x.senderId === 'u1@c.us')?.violations, 5);
});

test('SQL injection strings are treated as data', async () => {
  const r = createRepos(await memDb());
  await r.eventStore.save(ev({ senderId: "x'; DROP TABLE events;--" }));
  assert.equal(r.events.list({ q: "'; DROP" }).total, 1);
  assert.equal(r.events.list({}).total, 1);
});

test('CSV export neutralises formula injection and quotes properly', async () => {
  const r = createRepos(await memDb());
  await r.eventStore.save(ev({ senderId: '=HYPERLINK("x")', detail: 'a,b\n"c"' }));
  const csv = r.events.toCsv(r.events.list({}).rows);
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv.includes('"a,b\n""c"""'));
});

test('worker status and connection log round-trip', async () => {
  const { worker } = createRepos(await memDb());
  assert.equal(worker.get(), undefined);
  worker.set('connected', { uptime: 5 });
  worker.logConnection('qr', 'generated');
  assert.equal(worker.get()?.state, 'connected');
  assert.equal(worker.connectionEvents()[0]?.kind, 'qr');
});

test('end to end: Moderator + SQLite store + repos persist an event once', async () => {
  const r = createRepos(await memDb());
  r.groups.discover('g1@g.us', 'A');
  r.groups.update('g1@g.us', { enabled: true });
  r.settings.updateGlobal({ testMode: false, botId: 'bot@c.us' });
  const calls: string[] = [];
  const port: WhatsAppPort = {
    isGroupAdmin: async () => false,
    deleteMessage: async () => (calls.push('del'), { ok: true }),
    removeMember: async () => (calls.push('rem'), { ok: true }),
    sendGroupNotice: async () => ({ ok: true }),
  };
  const mod = new Moderator({ port, store: r.eventStore, global: () => r.settings.getGlobal(), group: (id) => r.groups.get(id) });
  const m = { id: 'm1', groupId: 'g1@g.us', senderId: 'u@c.us', fromMe: false, text: 'https://evil.com', timestamp: 1 };
  await mod.handle(m);
  await mod.handle(m);
  assert.deepEqual(calls, ['del', 'rem']);
  const rows = r.events.list({}).rows;
  assert.deepEqual(rows.map((e) => e.status).sort(), ['completed', 'duplicate']);
});
