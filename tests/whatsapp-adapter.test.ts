import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WwebjsAdapter, type WwebChat, type WwebClient, type WwebMessage, type WwebParticipant } from '../src/whatsapp/wwebjs-adapter.ts';
import type { AdapterEvents } from '../src/whatsapp/types.ts';
import type { IncomingMessage } from '../src/core/types.ts';
import { MemoryEventStore, Moderator } from '../src/core/moderator.ts';

const GROUP = 'g1@g.us';
const BOT = 'bot@c.us';

class MockClient implements WwebClient {
  handlers = new Map<string, (...a: any[]) => void>();
  info = { wid: { _serialized: BOT } };
  destroyed = 0;
  initialized = 0;
  isGroup = true;
  participants: WwebParticipant[] | undefined = [
    { id: { _serialized: BOT }, isAdmin: true, isSuperAdmin: false },
    { id: { _serialized: 'admin@c.us' }, isAdmin: true, isSuperAdmin: false },
    { id: { _serialized: 'user@c.us' }, isAdmin: false, isSuperAdmin: false },
  ];
  removeResult: unknown = undefined;
  removeThrows = false;
  /** Whether a removal request actually takes effect in the mock group. */
  removalTakesEffect = true;
  removeCalls: string[][] = [];
  sent: string[] = [];
  throwOnGetChat = false;
  on(event: string, l: (...a: any[]) => void) {
    this.handlers.set(event, l);
    return this;
  }
  async initialize() {
    this.initialized++;
  }
  async destroy() {
    this.destroyed++;
  }
  chat(): WwebChat {
    return {
      id: { _serialized: GROUP }, name: 'Group One', isGroup: this.isGroup,
      ...(this.participants ? { participants: this.participants } : {}),
      removeParticipants: async (ids: string[]) => {
        this.removeCalls.push(ids);
        if (this.removeThrows) throw new Error('not allowed');
        if (this.removalTakesEffect) this.participants = this.participants?.filter((p) => !ids.includes(p.id._serialized));
        return this.removeResult;
      },
    };
  }
  async getChatById() {
    if (this.throwOnGetChat) throw new Error('chat unavailable');
    return this.chat();
  }
  async getChats() {
    return [this.chat(), { ...this.chat(), id: { _serialized: 'x@c.us' }, isGroup: false }];
  }
  async sendMessage(_c: string, t: string) {
    this.sent.push(t);
  }
  emit(ev: string, ...a: unknown[]) {
    this.handlers.get(ev)?.(...a);
  }
}

function rawMsg(over: Partial<WwebMessage> = {}): WwebMessage & { deleted: boolean[] } {
  const deleted: boolean[] = [];
  return {
    id: { _serialized: 'm1' }, from: GROUP, author: 'user@c.us', fromMe: false, body: 'hi', timestamp: 100,
    delete: async (e?: boolean) => void deleted.push(e === true), deleted, ...over,
  };
}

async function setup() {
  const clients: MockClient[] = [];
  const adapter = new WwebjsAdapter({
    createClient: () => {
      const c = new MockClient();
      clients.push(c);
      return c;
    },
    verifyDelayMs: 0, verifyAttempts: 2, sleep: async () => undefined, messageCacheSize: 3,
  });
  const received: IncomingMessage[] = [];
  const log: string[] = [];
  const events: AdapterEvents = {
    onQr: (q) => log.push(`qr:${q}`), onReady: () => log.push('ready'), onDisconnected: (r) => log.push(`disc:${r}`),
    onAuthFailure: (m) => log.push(`auth:${m}`), onMessage: (m) => received.push(m),
  };
  await adapter.start(events);
  return { adapter, client: clients[0] as MockClient, clients, received, log, events };
}

test('forwards lifecycle events', async () => {
  const { client, log } = await setup();
  client.emit('qr', 'Q');
  client.emit('ready');
  client.emit('disconnected', 'NAVIGATION');
  client.emit('auth_failure', 'bad');
  assert.deepEqual(log, ['qr:Q', 'ready', 'disc:NAVIGATION', 'auth:bad']);
});

test('maps group messages; ignores private chats and unattributable messages', async () => {
  const { client, received } = await setup();
  client.emit('message', rawMsg({ body: 'look https://x.com', timestamp: 7 }));
  client.emit('message', rawMsg({ id: { _serialized: 'p' }, from: 'someone@c.us' }));
  client.emit('message', rawMsg({ id: { _serialized: 'n' }, author: undefined }));
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], { id: 'm1', groupId: GROUP, senderId: 'user@c.us', fromMe: false, text: 'look https://x.com', timestamp: 7000 });
});

test('selfId and group listing (groups only)', async () => {
  const { adapter } = await setup();
  assert.equal(adapter.selfId(), BOT);
  assert.deepEqual(await adapter.listGroups(), [{ id: GROUP, name: 'Group One' }]);
});

test('isGroupAdmin reads participant metadata', async () => {
  const { adapter } = await setup();
  assert.equal(await adapter.port.isGroupAdmin(GROUP, 'admin@c.us'), true);
  assert.equal(await adapter.port.isGroupAdmin(GROUP, 'user@c.us'), false);
  assert.equal(await adapter.port.isGroupAdmin(GROUP, 'user:5@c.us'), false, 'device suffix is ignored');
});

test('isGroupAdmin fails closed when metadata is missing, uncertain or unavailable', async () => {
  const { adapter, client } = await setup();
  await assert.rejects(adapter.port.isGroupAdmin(GROUP, 'stranger@lid'), /not found/);
  client.participants = undefined;
  await assert.rejects(adapter.port.isGroupAdmin(GROUP, 'user@c.us'), /metadata unavailable/);
  client.participants = [];
  await assert.rejects(adapter.port.isGroupAdmin(GROUP, 'user@c.us'), /metadata unavailable/);
  client.participants = [{ id: { _serialized: 'user@c.us' } }];
  await assert.rejects(adapter.port.isGroupAdmin(GROUP, 'user@c.us'), /flag missing/);
  client.participants = [{ id: { _serialized: 'user@c.us' }, isAdmin: false }];
  client.isGroup = false;
  await assert.rejects(adapter.port.isGroupAdmin(GROUP, 'user@c.us'), /not a group/);
  client.isGroup = true;
  client.throwOnGetChat = true;
  await assert.rejects(adapter.port.isGroupAdmin(GROUP, 'user@c.us'), /chat unavailable/);
});

test('deleteMessage deletes for everyone when the bot is an admin and the message is cached', async () => {
  const { adapter, client } = await setup();
  const m = rawMsg();
  client.emit('message', m);
  assert.deepEqual(await adapter.port.deleteMessage(GROUP, 'm1'), { ok: true });
  assert.deepEqual(m.deleted, [true]);
});

test('deleteMessage reports failures instead of claiming success', async () => {
  const { adapter, client } = await setup();
  assert.match((await adapter.port.deleteMessage(GROUP, 'unknown')).error ?? '', /no longer available/);

  const m = rawMsg();
  client.emit('message', m);
  client.participants = client.participants?.map((p) => (p.id._serialized === BOT ? { ...p, isAdmin: false } : p));
  const r = await adapter.port.deleteMessage(GROUP, 'm1');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /not a group administrator/);
  assert.deepEqual(m.deleted, []);

  client.participants = client.participants?.map((p) => (p.id._serialized === BOT ? { ...p, isAdmin: true } : p));
  const boom = rawMsg({ id: { _serialized: 'm2' }, delete: async () => { throw new Error('too old to delete'); } });
  client.emit('message', boom);
  assert.deepEqual(await adapter.port.deleteMessage(GROUP, 'm2'), { ok: false, error: 'too old to delete' });
});

test('message cache is bounded', async () => {
  const { adapter, client } = await setup();
  for (let i = 0; i < 5; i++) client.emit('message', rawMsg({ id: { _serialized: `c${i}` } }));
  assert.equal((await adapter.port.deleteMessage(GROUP, 'c0')).ok, false, 'oldest evicted');
  assert.equal((await adapter.port.deleteMessage(GROUP, 'c4')).ok, true);
});

test('removeMember succeeds only after membership is re-read and the member is gone', async () => {
  const { adapter, client } = await setup();
  assert.deepEqual(await adapter.port.removeMember(GROUP, 'user@c.us'), { ok: true });
  assert.deepEqual(client.removeCalls, [['user@c.us']]);
});

test('removeMember does not claim success when the member is still present', async () => {
  const { adapter, client } = await setup();
  client.removalTakesEffect = false;
  const r = await adapter.port.removeMember(GROUP, 'user@c.us');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /still present/);
});

test('removeMember surfaces rejection codes and thrown errors', async () => {
  const { adapter, client } = await setup();
  client.removeResult = { 'user@c.us': { code: 403, message: 'forbidden' } };
  client.removalTakesEffect = false;
  assert.match((await adapter.port.removeMember(GROUP, 'user@c.us')).error ?? '', /rejected.*forbidden/);
  client.removeResult = undefined;
  client.removeThrows = true;
  assert.deepEqual(await adapter.port.removeMember(GROUP, 'user@c.us'), { ok: false, error: 'not allowed' });
});

test('removeMember refuses administrators, unknown members and non-admin bot', async () => {
  const { adapter, client } = await setup();
  assert.match((await adapter.port.removeMember(GROUP, 'admin@c.us')).error ?? '', /refusing/);
  assert.match((await adapter.port.removeMember(GROUP, 'nobody@c.us')).error ?? '', /not in the group/);
  client.participants = [{ id: { _serialized: 'user@c.us' }, isAdmin: false }]; // bot absent => not admin
  assert.match((await adapter.port.removeMember(GROUP, 'user@c.us')).error ?? '', /bot is not/);
  assert.deepEqual(client.removeCalls, []);
});

test('removeMember refuses a member whose role is unknown', async () => {
  const { adapter, client } = await setup();
  client.participants = [
    { id: { _serialized: BOT }, isAdmin: true },
    { id: { _serialized: 'user@c.us' } }, // no flags
  ];
  assert.match((await adapter.port.removeMember(GROUP, 'user@c.us')).error ?? '', /unknown role/);
  assert.deepEqual(client.removeCalls, []);
});

test('removeMember reports unverifiable removal when metadata disappears afterwards', async () => {
  const { adapter, client } = await setup();
  const original = client.chat.bind(client);
  let calls = 0;
  client.chat = () => {
    const c = original();
    calls++;
    return calls > 1 ? { ...c, participants: [] } : c; // first read ok, later reads empty
  };
  const r = await adapter.port.removeMember(GROUP, 'user@c.us');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /could not verify/);
});

test('notices are sent and failures reported', async () => {
  const { adapter, client } = await setup();
  assert.deepEqual(await adapter.port.sendGroupNotice(GROUP, 'hello'), { ok: true });
  assert.deepEqual(client.sent, ['hello']);
  client.sendMessage = async () => {
    throw new Error('rate limited');
  };
  assert.deepEqual(await adapter.port.sendGroupNotice(GROUP, 'x'), { ok: false, error: 'rate limited' });
});

test('restarting replaces the client and ignores events from the old one', async () => {
  const { adapter, clients, events, received } = await setup();
  await adapter.start(events);
  assert.equal(clients.length, 2);
  assert.equal(clients[0]?.destroyed, 1);
  clients[0]?.emit('message', rawMsg());
  assert.equal(received.length, 0, 'stale client events are dropped');
  clients[1]?.emit('message', rawMsg());
  assert.equal(received.length, 1);
});

test('operations after stop fail cleanly', async () => {
  const { adapter } = await setup();
  await adapter.stop();
  assert.equal(adapter.selfId(), '');
  assert.match((await adapter.port.sendGroupNotice(GROUP, 'x')).error ?? '', /not running/);
  await assert.rejects(adapter.listGroups(), /not running/);
});

test('with the Moderator: an id-format mismatch fails closed and nothing destructive is attempted', async () => {
  const { adapter, client } = await setup();
  const m = rawMsg({ author: '1234@lid' }); // participants list uses @c.us ids only
  client.emit('message', m);
  const store = new MemoryEventStore();
  const mod = new Moderator({
    port: adapter.port, store,
    global: () => ({ testMode: false, botId: BOT, ownerIds: [] }),
    group: () => ({ groupId: GROUP, enabled: true, links: { enabled: true, allowedDomains: [], detectBareDomains: true },
      profanity: { enabled: true, customWords: [], allowWords: [] }, excludedMembers: [], notifyGroup: false }),
  });
  await mod.handle({ id: 'm1', groupId: GROUP, senderId: '1234@lid', fromMe: false, text: 'https://evil.com', timestamp: 1 });
  assert.equal(store.events[0]?.status, 'skipped_check_failed');
  assert.deepEqual(client.removeCalls, []);
  assert.deepEqual(m.deleted, []);
});

test('with the Moderator: a real violation by a regular member is deleted and removed (mocked)', async () => {
  const { adapter, client } = await setup();
  const m = rawMsg({ body: 'join https://evil.com' });
  client.emit('message', m);
  const store = new MemoryEventStore();
  const mod = new Moderator({
    port: adapter.port, store,
    global: () => ({ testMode: false, botId: BOT, ownerIds: [] }),
    group: () => ({ groupId: GROUP, enabled: true, links: { enabled: true, allowedDomains: [], detectBareDomains: true },
      profanity: { enabled: true, customWords: [], allowWords: [] }, excludedMembers: [], notifyGroup: false }),
  });
  await mod.handle({ id: 'm1', groupId: GROUP, senderId: 'user@c.us', fromMe: false, text: 'join https://evil.com', timestamp: 1 });
  assert.equal(store.events[0]?.status, 'completed');
  assert.deepEqual(m.deleted, [true]);
  assert.deepEqual(client.removeCalls, [['user@c.us']]);
});

test('with the Moderator: administrators are never touched', async () => {
  const { adapter, client } = await setup();
  const m = rawMsg({ author: 'admin@c.us' });
  client.emit('message', m);
  const store = new MemoryEventStore();
  const mod = new Moderator({
    port: adapter.port, store,
    global: () => ({ testMode: false, botId: BOT, ownerIds: [] }),
    group: () => ({ groupId: GROUP, enabled: true, links: { enabled: true, allowedDomains: [], detectBareDomains: true },
      profanity: { enabled: true, customWords: [], allowWords: [] }, excludedMembers: [], notifyGroup: false }),
  });
  await mod.handle({ id: 'm1', groupId: GROUP, senderId: 'admin@c.us', fromMe: false, text: 'https://evil.com', timestamp: 1 });
  assert.equal(store.events[0]?.status, 'skipped_protected');
  assert.deepEqual(client.removeCalls, []);
  assert.deepEqual(m.deleted, []);
});
