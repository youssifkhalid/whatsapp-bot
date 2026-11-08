import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryEventStore, Moderator } from '../src/core/moderator.ts';
import type { GlobalConfig, GroupConfig, IncomingMessage, OpResult, WhatsAppPort } from '../src/core/types.ts';

class MockPort implements WhatsAppPort {
  calls: string[] = [];
  admins = new Set<string>();
  adminLookupThrows = false;
  deleteResult: OpResult = { ok: true };
  removeResult: OpResult = { ok: true };
  noticeResult: OpResult = { ok: true };

  async isGroupAdmin(_g: string, m: string) {
    if (this.adminLookupThrows) throw new Error('metadata unavailable');
    return this.admins.has(m);
  }
  async deleteMessage(g: string, id: string) {
    this.calls.push(`delete:${g}:${id}`);
    return this.deleteResult;
  }
  async removeMember(g: string, m: string) {
    this.calls.push(`remove:${g}:${m}`);
    return this.removeResult;
  }
  async sendGroupNotice(g: string) {
    this.calls.push(`notice:${g}`);
    return this.noticeResult;
  }
}

const groupCfg = (id: string, over: Partial<GroupConfig> = {}): GroupConfig => ({
  groupId: id,
  enabled: true,
  links: { enabled: true, allowedDomains: [], detectBareDomains: true },
  profanity: { enabled: true, customWords: [], allowWords: [] },
  excludedMembers: [],
  notifyGroup: false,
  ...over,
});

function setup(opts: { testMode?: boolean; groups?: GroupConfig[] } = {}) {
  const port = new MockPort();
  const store = new MemoryEventStore();
  const global: GlobalConfig = { testMode: opts.testMode ?? false, botId: 'bot@c.us', ownerIds: ['owner@c.us'] };
  const groups = new Map((opts.groups ?? [groupCfg('g1@g.us')]).map((g) => [g.groupId, g]));
  const mod = new Moderator({ port, store, global: () => global, group: (id) => groups.get(id) });
  return { port, store, mod, global, groups };
}

const msg = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: 'm1',
  groupId: 'g1@g.us',
  senderId: 'user@c.us',
  fromMe: false,
  text: 'join https://evil.com',
  timestamp: 1,
  ...over,
});

test('link violation deletes the message and removes the sender, confirmed', async () => {
  const { port, mod, store } = setup();
  const out = await mod.handle(msg());
  assert.equal(out.kind, 'event');
  assert.deepEqual(port.calls, ['delete:g1@g.us:m1', 'remove:g1@g.us:user@c.us']);
  const e = store.events[0]!;
  assert.equal(e.status, 'completed');
  assert.ok(e.messageDeleted && e.memberRemoved);
  assert.equal(e.violation.type, 'link');
});

test('profanity violation is actioned and stores only the matched term', async () => {
  const { mod, store } = setup();
  await mod.handle(msg({ text: 'you are a fuuuuck' }));
  const e = store.events[0]!;
  assert.equal(e.violation.type, 'profanity');
  assert.equal(e.violation.matched, 'fuck');
  assert.ok(!JSON.stringify(e).includes('you are a'), 'message text must not be stored');
});

test('captions are scanned', async () => {
  const { mod, store } = setup();
  await mod.handle(msg({ text: '', caption: 'promo: t.me/spamchannel' }));
  assert.equal(store.events[0]?.violation.category, 'telegram');
});

test('bot self-messages are ignored', async () => {
  const { port, mod, store } = setup();
  const a = await mod.handle(msg({ fromMe: true }));
  const b = await mod.handle(msg({ id: 'm2', senderId: 'bot@c.us' }));
  assert.deepEqual([a, b].map((o) => o.kind), ['ignored', 'ignored']);
  assert.equal(port.calls.length, 0);
  assert.equal(store.events.length, 0);
});

test('administrators are protected', async () => {
  const { port, mod, store } = setup();
  port.admins.add('admin@c.us');
  await mod.handle(msg({ senderId: 'admin@c.us' }));
  assert.equal(store.events[0]?.status, 'skipped_protected');
  assert.equal(port.calls.length, 0);
});

test('the system owner is protected without needing an admin lookup', async () => {
  const { port, mod, store } = setup();
  port.adminLookupThrows = true;
  await mod.handle(msg({ senderId: 'owner@c.us' }));
  assert.equal(store.events[0]?.status, 'skipped_protected');
  assert.equal(port.calls.length, 0);
});

test('owner id with a device suffix is still recognised', async () => {
  const { port, mod, store } = setup();
  await mod.handle(msg({ senderId: 'owner:12@c.us' }));
  assert.equal(store.events[0]?.status, 'skipped_protected');
  assert.equal(port.calls.length, 0);
});

test('excluded members are protected, per group', async () => {
  const { port, mod, store } = setup({
    groups: [groupCfg('g1@g.us', { excludedMembers: ['vip@c.us'] }), groupCfg('g2@g.us')],
  });
  await mod.handle(msg({ senderId: 'vip@c.us' }));
  assert.equal(store.events[0]?.status, 'skipped_protected');
  assert.equal(port.calls.length, 0);
  // Same member is not excluded in another group.
  await mod.handle(msg({ id: 'm9', groupId: 'g2@g.us', senderId: 'vip@c.us' }));
  assert.equal(store.events[1]?.status, 'completed');
});

test('group isolation: unknown and disabled groups are ignored, rules do not leak', async () => {
  const { port, mod, store } = setup({
    groups: [
      groupCfg('g1@g.us', { links: { enabled: false, allowedDomains: [], detectBareDomains: true } }),
      groupCfg('g2@g.us', { enabled: false }),
    ],
  });
  const none = await mod.handle(msg({ groupId: 'zzz@g.us' }));
  const off = await mod.handle(msg({ id: 'a', groupId: 'g2@g.us' }));
  const noLinkRule = await mod.handle(msg({ id: 'b', groupId: 'g1@g.us' }));
  assert.deepEqual(
    [none, off, noLinkRule].map((o) => (o.kind === 'ignored' ? o.reason : 'event')),
    ['no_group_config', 'group_disabled', 'no_violation'],
  );
  assert.equal(port.calls.length, 0);
  assert.equal(store.events.length, 0);
});

test('duplicate events are not actioned twice', async () => {
  const { port, mod, store } = setup();
  await mod.handle(msg());
  const second = await mod.handle(msg());
  assert.equal(second.kind === 'event' && second.event.status, 'duplicate');
  assert.equal(port.calls.length, 2);
  assert.equal(store.events.length, 2);
});

test('same message id in different groups is not a duplicate', async () => {
  const { mod, store } = setup({ groups: [groupCfg('g1@g.us'), groupCfg('g2@g.us')] });
  await mod.handle(msg());
  await mod.handle(msg({ groupId: 'g2@g.us' }));
  assert.deepEqual(store.events.map((e) => e.status), ['completed', 'completed']);
});

test('test mode records a simulation and executes nothing', async () => {
  const { port, mod, store } = setup({ testMode: true });
  await mod.handle(msg());
  const e = store.events[0]!;
  assert.equal(e.status, 'simulated');
  assert.equal(e.testMode, true);
  assert.ok(!e.messageDeleted && !e.memberRemoved);
  assert.equal(port.calls.length, 0);
});

test('failed deletion is recorded honestly and removal still proceeds', async () => {
  const { port, mod, store } = setup();
  port.deleteResult = { ok: false, error: 'not an admin in this group' };
  await mod.handle(msg());
  const e = store.events[0]!;
  assert.equal(e.status, 'partial');
  assert.equal(e.messageDeleted, false);
  assert.equal(e.memberRemoved, true);
  assert.match(e.detail ?? '', /delete failed: not an admin/);
});

test('failed removal is recorded honestly', async () => {
  const { port, mod, store } = setup();
  port.removeResult = { ok: false, error: 'participant not found' };
  await mod.handle(msg());
  const e = store.events[0]!;
  assert.equal(e.status, 'partial');
  assert.equal(e.messageDeleted, true);
  assert.equal(e.memberRemoved, false);
});

test('both operations failing yields status failed, never completed', async () => {
  const { port, mod, store } = setup();
  port.deleteResult = { ok: false, error: 'x' };
  port.removeResult = { ok: false, error: 'y' };
  await mod.handle(msg());
  const e = store.events[0]!;
  assert.equal(e.status, 'failed');
  assert.equal(e.errors.length, 2);
});

test('a thrown port error is captured as a failure', async () => {
  const { port, mod, store } = setup();
  port.deleteMessage = async () => {
    throw new Error('socket closed');
  };
  await mod.handle(msg());
  assert.match(store.events[0]?.detail ?? '', /socket closed/);
  assert.equal(store.events[0]?.messageDeleted, false);
});

test('if admin status cannot be verified nothing destructive happens', async () => {
  const { port, mod, store } = setup();
  port.adminLookupThrows = true;
  await mod.handle(msg());
  assert.equal(store.events[0]?.status, 'skipped_check_failed');
  assert.equal(port.calls.length, 0);
});

test('group notice is sent only when configured and an action succeeded', async () => {
  const on = setup({ groups: [groupCfg('g1@g.us', { notifyGroup: true })] });
  await on.mod.handle(msg());
  assert.ok(on.port.calls.includes('notice:g1@g.us'));
  assert.equal(on.store.events[0]?.noticeSent, true);

  const failed = setup({ groups: [groupCfg('g1@g.us', { notifyGroup: true })] });
  failed.port.deleteResult = { ok: false, error: 'x' };
  failed.port.removeResult = { ok: false, error: 'y' };
  await failed.mod.handle(msg());
  assert.ok(!failed.port.calls.includes('notice:g1@g.us'));

  const off = setup();
  await off.mod.handle(msg());
  assert.ok(!off.port.calls.includes('notice:g1@g.us'));
});

test('a failing notice does not turn a completed action into a failure', async () => {
  const { port, mod, store } = setup({ groups: [groupCfg('g1@g.us', { notifyGroup: true })] });
  port.noticeResult = { ok: false, error: 'rate limited' };
  await mod.handle(msg());
  const e = store.events[0]!;
  assert.equal(e.status, 'completed');
  assert.equal(e.noticeSent, false);
  assert.match(e.detail ?? '', /notice failed/);
});

test('clean messages produce no event and no calls', async () => {
  const { port, mod, store } = setup();
  const out = await mod.handle(msg({ text: 'good morning everyone' }));
  assert.deepEqual(out, { kind: 'ignored', reason: 'no_violation' });
  assert.equal(port.calls.length, 0);
  assert.equal(store.events.length, 0);
});
