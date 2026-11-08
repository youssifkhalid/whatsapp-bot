/**
 * Minimal synchronous SQLite surface shared by `node:sqlite` (used here and in tests) and
 * `better-sqlite3` (intended production driver). Both expose prepare().run/get/all and exec().
 * Repositories depend only on this interface.
 */
export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

/** Run `fn` in a transaction; rolls back on throw. Nested calls join the outer transaction. */
const depth = new WeakMap<Db, number>();
export function transaction<T>(db: Db, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  if (d > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth.set(db, 0);
  }
}

export async function openDatabase(path: string): Promise<Db> {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  return raw as unknown as Db;
}

export const num = (v: unknown): number => Number(v ?? 0);
export const str = (v: unknown): string => (v == null ? '' : String(v));
