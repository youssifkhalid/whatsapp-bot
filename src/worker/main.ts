import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabase } from '../storage/db.ts';
import { runMigrations } from '../storage/migrations.ts';
import { createRepos } from '../storage/repositories.ts';
import { WwebjsAdapter } from '../whatsapp/wwebjs-adapter.ts';
import { createWwebjsClientFactory } from '../whatsapp/wwebjs-factory.ts';
import { startHealthServer } from './health.ts';
import { createLogger, type Level } from './logger.ts';
import { WorkerRuntime } from './runtime.ts';

/** Composition root for the worker process. Run with: node --import tsx src/worker/main.ts */
async function main(): Promise<void> {
  const env = process.env;
  const dbPath = env['DATABASE_PATH'] ?? './data/guardian.db';
  const sessionDir = env['WA_SESSION_DIR'] ?? './data/wa-session';
  const healthPort = Number(env['WORKER_HEALTH_PORT'] ?? 8081);
  const log = createLogger({ level: (env['LOG_LEVEL'] as Level | undefined) ?? 'info', base: { svc: 'worker' } });

  mkdirSync(dirname(dbPath), { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const db = await openDatabase(dbPath);
  runMigrations(db);
  const repos = createRepos(db);

  const createClient = await createWwebjsClientFactory({
    sessionDir,
    ...(env['CHROMIUM_PATH'] ? { chromiumPath: env['CHROMIUM_PATH'] } : {}),
  });
  const adapter = new WwebjsAdapter({ createClient });

  let shuttingDown = false;
  const shutdown = async (code: number, why: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { why });
    const force = setTimeout(() => process.exit(code || 1), 30_000);
    force.unref();
    await worker.stop().catch((err) => log.error('error during shutdown', { err }));
    health.close();
    db.close();
    process.exit(code);
  };

  const worker = new WorkerRuntime({
    adapter, repos, logger: log,
    onFatal: (reason) => void shutdown(1, reason),
  });
  const health = await startHealthServer(worker, healthPort, env['WORKER_HEALTH_HOST'] ?? '127.0.0.1');

  process.on('SIGTERM', () => void shutdown(0, 'SIGTERM'));
  process.on('SIGINT', () => void shutdown(0, 'SIGINT'));
  process.on('unhandledRejection', (err) => log.error('unhandled rejection', { err }));
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { err });
    void shutdown(1, 'uncaughtException');
  });

  log.info('worker starting', { dbPath, healthPort });
  await worker.start();
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
