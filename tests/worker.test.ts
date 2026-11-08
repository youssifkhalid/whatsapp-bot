import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/storage/db.ts';
import { runMigrations } from '../src/storage/migrations.ts';
import { createRepos } from '../src/storage/repositories.ts';
import { WorkerRuntime } from '../src/worker/runtime.ts';
import { startHealthServer } from '../src/worker/health.ts';
import { backoffDelay } from '../src/worker/backoff.ts';
import { createLogger, redact } from '../src/worker/logger.ts';
import type { AdapterEvents, WhatsAppAdapter } from '../src/whatsapp/types.ts';
import type { IncomingMessage, WhatsAppPort } from '../src/core/types.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(5);
  }
}

class FakeAdapter implements WhatsAppAdapter {
  events!: AdapterEvents;
  starts = 0;
  stops = 0;
  failStarts = 0;
  calls: string[] = [];
  groups = [{ id: 'g1@g.us', name: 'Group One' }];
  port: WhatsAppPort = {
    isGroupAdmin: async () => false,
    deleteMessage: async (g, id) => (this.calls.push(`del:${g}:${id}`), { ok: true }),
    removeMember: async (g, m) => (this.calls.push(`rem:${g}:${m}`), { ok: true }),
    sendGroupNotice: async () => ({ ok: true }),
  };
  async start(e: AdapterEvents) {
    this.starts++;
    this.events = e;
    if (this.failStarts > 0) {
      this.failStarts--;
      throw new Error('launch failed');
    }
  }
  async stop() {
    this.stops++;
  }
  selfId() {
    return 'bot@c.us';
  }
  async listGroups() {
    return this.groups;
  }
}

async function setup(over: Partial<ConstructorParameters<typeof WorkerRuntime>[0]> = {}) {
  const db = await openDatabase(':memory:');
  runMigrations(db);
  const repos = createRepos(db);
  const adapter = new FakeAdapter();
  const lines: string[] = [];
  const fatal: string[] = [];
  const worker = new WorkerRuntime({
    adapter, repos, logger: createLogger({ write: (l) => lines.push(l) }),
    backoffBaseMs: 5, backoffMaxMs: 20, readyTimeoutMs: 500, heartbeatMs: 20, configPollMs: 20, drainTimeoutMs: 500,
    onFatal: (r) => fatal.push(r), ...over,
  });
  return { worker, adapter, repos, lines, fatal };
}

const msg = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: 'm1', groupId: 'g1@g.us', senderId: 'u@c.us', fromMe: false, text: 'see https://evil.com', timestamp: 1, ...over,
});

test('connects, records bot id, discovers groups (disabled by default) and persists status', async () => {
  const { worker, adapter, repos } = await setup();
  await worker.start();
  adapter.events.onReady();
  await until(() => worker.getState() === 'connected');
  assert.equal(repos.settings.getGlobal().botId, 'bot@c.us');
  assert.equal(repos.groups.get('g1@g.us')?.enabled, false);
  assert.equal(repos.worker.get()?.state, 'connected');
  await worker.stop();
});

test('QR flow: awaiting_qr exposes the payload, then it is cleared once connected', async () => {
  const { worker, adapter, repos } = await setup();
  await worker.start();
  adapter.events.onQr('QR-PAYLOAD');
  assert.equal(worker.getState(), 'awaiting_qr');
  assert.equal(worker.snapshot().qr, 'QR-PAYLOAD');
  assert.equal(worker.isLive(), true, 'waiting for a scan is not unhealthy');
  adapter.events.onReady();
  await until(() => worker.getState() === 'connected');
  assert.equal(worker.snapshot().qr, undefined);
  assert.equal(JSON.stringify(repos.worker.get()).includes('QR-PAYLOAD'), false);
  await worker.stop();
});

test('moderates messages end to end when enabled and test mode is off', async () => {
  const { worker, adapter, repos } = await setup();
  await worker.start();
  adapter.events.onReady();
  await until(() => worker.getState() === 'connected');
  repos.groups.update('g1@g.us', { enabled: true });
  repos.settings.updateGlobal({ testMode: false });
  await until(() => {
    worker.refreshConfig();
    return true;
  });
  adapter.events.onMessage(msg());
  await until(() => repos.events.list({}).total === 1);
  assert.deepEqual(adapter.calls, ['del:g1@g.us:m1', 'rem:g1@g.us:u@c.us']);
  assert.equal(repos.events.list({}).rows[0]?.status, 'completed');
  await worker.stop();
});

test('test mode (default) never calls destructive operations', async () => {
  const { worker, adapter, repos } = await setup();
  await worker.start();
  adapter.events.onReady();
  await until(() => worker.getState() === 'connected');
  repos.groups.update('g1@g.us', { enabled: true }); // test mode left at its default (on)
  worker.refreshConfig();
  adapter.events.onMessage(msg());
  await until(() => repos.events.list({}).total === 1);
  assert.equal(repos.events.list({}).rows[0]?.status, 'simulated');
  assert.deepEqual(adapter.calls, []);
  await worker.stop();
});

test('configuration changes made by the API are picked up by polling', async () => {
  const { worker, adapter, repos } = await setup();
  await worker.start();
  adapter.events.onReady();
  await until(() => worker.getState() === 'connected');
  repos.groups.update('g1@g.us', { enabled: true });
  repos.settings.updateGlobal({ testMode: false });
  await sleep(60); // poll interval is 20ms
  adapter.events.onMessage(msg());
  await until(() => adapter.calls.length === 2);
  await worker.stop();
});

test('a failure while handling one message does not stop the worker', async () => {
  const { worker, adapter, repos } = await setup();
  await worker.start();
  adapter.events.onReady();
  await until(() => worker.getState() === 'connected');
  repos.groups.update('g1@g.us', { enabled: true });
  repos.settings.updateGlobal({ testMode: false });
  worker.refreshConfig();
  adapter.port.deleteMessage = async () => {
    throw new Error('socket closed');
  };
  adapter.events.onMessage(msg({ id: 'a' }));
  adapter.events.onMessage(msg({ id: 'b' }));
  await until(() => repos.events.list({}).total === 2);
  assert.equal(worker.getState(), 'connected');
  await worker.stop();
});

test('messages in one group are processed in order', async () => {
  const { worker, adapter, repos } = await setup();
  await worker.start();
  adapter.events.onReady();
  await until(() => worker.getState() === 'connected');
  repos.groups.update('g1@g.us', { enabled: true });
  repos.settings.updateGlobal({ testMode: false });
  worker.refreshConfig();
  for (const id of ['1', '2', '3']) adapter.events.onMessage(msg({ id, senderId: `u${id}@c.us` }));
  await until(() => adapter.calls.length === 6);
  assert.deepEqual(adapter.calls.filter((c) => c.startsWith('del')), ['del:g1@g.us:1', 'del:g1@g.us:2', 'del:g1@g.us:3']);
  await worker.stop();
});

test('disconnect triggers reconnect with backoff and recovers', async () => {
  const { worker, adapter } = await setup();
  await worker.start();
  adapter.events.onReady();
  await until(() => worker.getState() === 'connected');
  adapter.events.onDisconnected('NAVIGATION');
  assert.equal(worker.getState(), 'reconnecting');
  await until(() => adapter.starts === 2);
  assert.ok(adapter.stops >= 1);
  adapter.events.onReady();
  await until(() => worker.getState() === 'connected');
  assert.equal(worker.snapshot().reconnectAttempts, 0, 'budget resets after a successful connection');
  await worker.stop();
});

test('repeated disconnect events do not schedule parallel reconnects', async () => {
  const { worker, adapter } = await setup({ backoffBaseMs: 30, backoffMaxMs: 30 });
  await worker.start();
  adapter.events.onReady();
  await until(() => worker.getState() === 'connected');
  adapter.events.onDisconnected('a');
  adapter.events.onDisconnected('b');
  adapter.events.onDisconnected('c');
  await sleep(120);
  assert.equal(adapter.starts, 2);
  await worker.stop();
});

test('gives up after the retry budget instead of looping forever', async () => {
  const { worker, adapter, fatal, repos } = await setup({ maxReconnectAttempts: 3 });
  adapter.failStarts = 100;
  await worker.start();
  await until(() => fatal.length === 1, 3000);
  assert.equal(worker.getState(), 'failed');
  assert.equal(worker.isLive(), false);
  assert.equal(adapter.starts, 4, 'initial attempt + 3 retries');
  assert.match(fatal[0] ?? '', /3 attempts/);
  assert.ok(repos.worker.connectionEvents().some((e) => e.kind === 'gave_up'));
  await worker.stop();
});

test('ready timeout leads to a reconnect', async () => {
  const { worker, adapter } = await setup({ readyTimeoutMs: 30 });
  await worker.start();
  await until(() => adapter.starts >= 2, 2000);
  await worker.stop();
});

test('auth failure stops automatic retries and needs manual action', async () => {
  const { worker, adapter } = await setup();
  await worker.start();
  adapter.events.onAuthFailure('session rejected');
  assert.equal(worker.getState(), 'auth_failed');
  adapter.events.onDisconnected('LOGOUT');
  await sleep(60);
  assert.equal(adapter.starts, 1);
  assert.equal(worker.getState(), 'auth_failed');
  assert.equal(worker.isLive(), true, 'alive so the container is not restart-looped');
  await worker.stop();
});

test('graceful shutdown drains in-flight work, stops the adapter and ignores late messages', async () => {
  const { worker, adapter, repos } = await setup();
  await worker.start();
  adapter.events.onReady();
  await until(() => worker.getState() === 'connected');
  repos.groups.update('g1@g.us', { enabled: true });
  repos.settings.updateGlobal({ testMode: false });
  worker.refreshConfig();
  adapter.port.deleteMessage = async (g, id) => {
    await sleep(60);
    adapter.calls.push(`del:${g}:${id}`);
    return { ok: true };
  };
  adapter.events.onMessage(msg());
  await worker.stop();
  assert.deepEqual(adapter.calls, ['del:g1@g.us:m1', 'rem:g1@g.us:u@c.us'], 'in-flight message finished before exit');
  assert.equal(repos.events.list({}).total, 1);
  assert.equal(adapter.stops, 1);
  assert.equal(worker.getState(), 'stopped');
  adapter.events.onMessage(msg({ id: 'late' }));
  await sleep(20);
  assert.equal(repos.events.list({}).total, 1);
});

test('health endpoints: liveness vs readiness, no sensitive data', async () => {
  const { worker, adapter } = await setup();
  await worker.start();
  const server = await startHealthServer(worker, 0);
  const port = (server.address() as { port: number }).port;
  const get = async (p: string) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`);
    return { status: r.status, body: await r.text() };
  };
  adapter.events.onQr('SECRET-QR');
  assert.equal((await get('/healthz')).status, 200);
  assert.equal((await get('/readyz')).status, 503);
  assert.ok(!(await get('/readyz')).body.includes('SECRET-QR'));
  adapter.events.onReady();
  await until(() => worker.isReady());
  assert.equal((await get('/readyz')).status, 200);
  assert.equal((await get('/nope')).status, 404);
  const post = await fetch(`http://127.0.0.1:${port}/healthz`, { method: 'POST' });
  assert.equal(post.status, 405);
  await worker.stop();
  assert.equal((await get('/healthz')).status, 503);
  server.close();
});

test('backoff grows exponentially with jitter and is capped', () => {
  const o = { baseMs: 1000, maxMs: 8000, random: () => 1 };
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => backoffDelay(n, o)), [1000, 2000, 4000, 8000, 8000, 8000]);
  assert.equal(backoffDelay(3, { ...o, random: () => 0 }), 2000);
});

test('logger emits structured JSON and redacts secrets', () => {
  const lines: string[] = [];
  const log = createLogger({ write: (l) => lines.push(l), base: { svc: 'worker' }, now: () => 0 });
  log.info('hello', { password: 'hunter2', nested: { sessionToken: 'abc', ok: 1 }, err: new Error('bad') });
  log.debug('hidden');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0] as string);
  assert.equal(rec.msg, 'hello');
  assert.equal(rec.svc, 'worker');
  assert.equal(rec.password, '[redacted]');
  assert.equal(rec.nested.sessionToken, '[redacted]');
  assert.equal(rec.nested.ok, 1);
  assert.equal(rec.err.message, 'bad');
  assert.ok(!lines[0]?.includes('hunter2'));
  const cyc: Record<string, unknown> = {};
  cyc['self'] = cyc;
  assert.doesNotThrow(() => redact(cyc));
});
