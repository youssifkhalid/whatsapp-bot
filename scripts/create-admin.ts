import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { AuthService } from '../src/auth/service.ts';
import { openDatabase } from '../src/storage/db.ts';
import { runMigrations } from '../src/storage/migrations.ts';

/**
 * Creates a dashboard user from the server shell.
 *   npm run create-admin -- <username> [admin|viewer]
 * The password is read from GUARDIAN_PASSWORD if set (for scripted use), otherwise prompted
 * (note: the prompt echoes input; prefer the env var over a shell history entry for real use).
 */
async function main(): Promise<void> {
  const [username, roleArg = 'admin'] = process.argv.slice(2);
  if (!username || (roleArg !== 'admin' && roleArg !== 'viewer')) {
    process.stderr.write('usage: create-admin <username> [admin|viewer]\n');
    process.exit(2);
  }
  let password = process.env['GUARDIAN_PASSWORD'];
  if (!password) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question('Password (12+ characters): ');
    rl.close();
  }
  const dbPath = process.env['DATABASE_PATH'] ?? './data/guardian.db';
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = await openDatabase(dbPath);
  runMigrations(db);
  try {
    const user = await new AuthService(db, {}).createUser(username, password, roleArg);
    process.stdout.write(`created ${user.role} "${user.username}"\n`);
  } catch (e) {
    process.stderr.write(`failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
void main();
