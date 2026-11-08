import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AuthService } from '../auth/service.ts';
import { openDatabase } from '../storage/db.ts';
import { runMigrations } from '../storage/migrations.ts';
import { createRepos } from '../storage/repositories.ts';
import { createLogger, type Level } from '../worker/logger.ts';
import { createApi, DEFAULT_RATE } from './app.ts';
import { createHttpServer } from './server.ts';

/**
 * API composition root. Uses the dependency-free node:http adapter (the tested path).
 * UNVERIFIED alternative: src/api/express.ts mounts the same `Api` on Express.
 * Run with: node --import tsx src/api/main.ts
 */
async function main(): Promise<void> {
  const env = process.env;
  const log = createLogger({ level: (env['LOG_LEVEL'] as Level | undefined) ?? 'info', base: { svc: 'api' } });
  const dbPath = env['DATABASE_PATH'] ?? './data/guardian.db';
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = await openDatabase(dbPath);
  runMigrations(db);
  const repos = createRepos(db);
  const sessionTtlMs = Number(env['SESSION_TTL_HOURS'] ?? 12) * 3_600_000;
  const auth = new AuthService(db, { sessionTtlMs });

  const api = createApi({
    db, repos, auth,
    onUnexpectedError: (err) => log.error('unhandled api error', { err }),
    config: {
      secureCookies: env['COOKIE_SECURE'] !== 'false',
      trustProxy: env['TRUST_PROXY'] === 'true',
      allowedOrigins: (env['ALLOWED_ORIGINS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      ...(env['SETUP_TOKEN'] ? { setupToken: env['SETUP_TOKEN'] } : {}),
      backupDir: env['BACKUP_DIR'] ?? './data/backups',
      dbPath,
      sessionTtlMs,
      workerStaleMs: 60_000,
      rate: DEFAULT_RATE,
      staticDir: env['STATIC_DIR'] ?? './dist/web',
      backupRetention: Number(env['BACKUP_RETENTION'] ?? 14),
    },
  });

  const server = createHttpServer(api);
  const port = Number(env['API_PORT'] ?? 8080);
  const host = env['API_HOST'] ?? '127.0.0.1';
  server.listen(port, host, () => log.info('api listening', { host, port }));

  const stop = (why: string) => {
    log.info('shutting down', { why });
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
