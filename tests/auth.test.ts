import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/storage/db.ts';
import { runMigrations } from '../src/storage/migrations.ts';
import { AuthError, AuthService, can } from '../src/auth/service.ts';
import { hashPassword, verifyPassword } from '../src/auth/password.ts';

const PW = 'correct horse battery';

async function setup(clock = { t: 1_000_000 }) {
  const db = await openDatabase(':memory:');
  runMigrations(db);
  const auth = new AuthService(db, { now: () => clock.t, sessionTtlMs: 60_000, maxFailures: 3, lockoutWindowMs: 10_000 });
  return { db, auth, clock };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof AuthError ? e.code : 'other';
  }
  return 'none';
};

test('passwords are hashed with scrypt, salted, and verify correctly', async () => {
  const a = await hashPassword(PW);
  const b = await hashPassword(PW);
  assert.notEqual(a, b);
  assert.ok(a.startsWith('scrypt$'));
  assert.ok(!a.includes(PW));
  assert.equal(await verifyPassword(PW, a), true);
  assert.equal(await verifyPassword('wrong password!!', a), false);
  assert.equal(await verifyPassword(PW, 'garbage'), false);
});

test('user creation validates username and password strength, rejects duplicates case-insensitively', async () => {
  const { auth } = await setup();
  assert.equal(await code(auth.createUser('a', PW, 'admin')), 'invalid_username');
  assert.equal(await code(auth.createUser('bad name', PW, 'admin')), 'invalid_username');
  assert.equal(await code(auth.createUser('owner', 'short', 'admin')), 'weak_password');
  await auth.createUser('owner', PW, 'admin');
  assert.equal(await code(auth.createUser('OWNER', PW, 'viewer')), 'exists');
  assert.equal(auth.userCount(), 1);
});

test('login issues a session; only the token hash is stored', async () => {
  const { auth, db } = await setup();
  await auth.createUser('owner', PW, 'admin');
  const s = await auth.login('owner', PW);
  const stored = db.prepare('SELECT token_hash FROM sessions').get()?.['token_hash'];
  assert.notEqual(stored, s.token);
  assert.equal(auth.authenticate(s.token)?.user.username, 'owner');
});

test('wrong password and unknown user give the same error', async () => {
  const { auth } = await setup();
  await auth.createUser('owner', PW, 'admin');
  assert.equal(await code(auth.login('owner', 'nope nope nope')), 'invalid_credentials');
  assert.equal(await code(auth.login('ghost', PW)), 'invalid_credentials');
});

test('lockout after repeated failures, even with the right password, then expires', async () => {
  const { auth, clock } = await setup();
  await auth.createUser('owner', PW, 'admin');
  for (let i = 0; i < 3; i++) await code(auth.login('owner', 'bad bad bad bad'));
  assert.equal(await code(auth.login('owner', PW)), 'locked');
  clock.t += 11_000;
  assert.equal(await code(auth.login('owner', PW)), 'none');
});

test('sessions expire and can be logged out', async () => {
  const { auth, clock } = await setup();
  await auth.createUser('owner', PW, 'admin');
  const s = await auth.login('owner', PW);
  clock.t += 61_000;
  assert.equal(auth.authenticate(s.token), null);
  const s2 = await auth.login('owner', PW);
  auth.logout(s2.token);
  assert.equal(auth.authenticate(s2.token), null);
  assert.equal(auth.authenticate(undefined), null);
  assert.equal(auth.authenticate('forged-token'), null);
});

test('CSRF token verification', async () => {
  const { auth } = await setup();
  await auth.createUser('owner', PW, 'admin');
  const s = await auth.login('owner', PW);
  const session = auth.authenticate(s.token)!;
  assert.equal(auth.verifyCsrf(session, s.csrfToken), true);
  assert.equal(auth.verifyCsrf(session, 'wrong'), false);
  assert.equal(auth.verifyCsrf(session, undefined), false);
});

test('role-based access: viewers cannot write', async () => {
  const { auth } = await setup();
  const admin = await auth.createUser('owner', PW, 'admin');
  const viewer = await auth.createUser('watcher', PW, 'viewer');
  assert.equal(can(admin, 'write'), true);
  assert.equal(can(viewer, 'write'), false);
  assert.equal(can(viewer, 'read'), true);
});

test('changing the password revokes all sessions', async () => {
  const { auth } = await setup();
  const u = await auth.createUser('owner', PW, 'admin');
  const s = await auth.login('owner', PW);
  assert.equal(await code(auth.changePassword(u.id, 'wrong wrong wrong', 'a brand new passphrase')), 'invalid_credentials');
  await auth.changePassword(u.id, PW, 'a brand new passphrase');
  assert.equal(auth.authenticate(s.token), null);
  assert.equal(await code(auth.login('owner', PW)), 'invalid_credentials');
  assert.equal(await code(auth.login('owner', 'a brand new passphrase')), 'none');
});
