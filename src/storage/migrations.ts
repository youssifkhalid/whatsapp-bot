import type { Db } from './db.ts';
import { transaction } from './db.ts';

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','viewer')),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX idx_sessions_expires ON sessions(expires_at);
      CREATE TABLE login_attempts (
        username TEXT NOT NULL COLLATE NOCASE,
        at INTEGER NOT NULL
      );
      CREATE INDEX idx_login_attempts ON login_attempts(username, at);
      CREATE TABLE groups (
        group_id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 0,
        notify_group INTEGER NOT NULL DEFAULT 0,
        links_enabled INTEGER NOT NULL DEFAULT 1,
        detect_bare_domains INTEGER NOT NULL DEFAULT 1,
        allowed_domains TEXT NOT NULL DEFAULT '[]',
        profanity_enabled INTEGER NOT NULL DEFAULT 1,
        custom_words TEXT NOT NULL DEFAULT '[]',
        allow_words TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE exclusions (
        group_id TEXT NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
        member_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, member_id)
      );
      CREATE TABLE processed_messages (
        key TEXT PRIMARY KEY,
        claimed_at INTEGER NOT NULL
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        violation_type TEXT NOT NULL,
        matched TEXT NOT NULL,
        category TEXT,
        status TEXT NOT NULL,
        test_mode INTEGER NOT NULL,
        message_deleted INTEGER NOT NULL,
        member_removed INTEGER NOT NULL,
        notice_sent INTEGER NOT NULL,
        detail TEXT,
        errors TEXT NOT NULL DEFAULT '[]',
        at INTEGER NOT NULL
      );
      CREATE INDEX idx_events_at ON events(at DESC);
      CREATE INDEX idx_events_group ON events(group_id, at DESC);
      CREATE INDEX idx_events_sender ON events(sender_id, at DESC);
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        username TEXT,
        action TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '{}',
        at INTEGER NOT NULL
      );
      CREATE TABLE worker_status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT NOT NULL,
        info TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE connection_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        detail TEXT,
        at INTEGER NOT NULL
      );
    `,
  },
];

export function runMigrations(db: Db, migrations: Migration[] = MIGRATIONS): number[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => Number(r['id'])));
  const ran: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
    if (applied.has(m.id)) continue;
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, Date.now());
    });
    ran.push(m.id);
  }
  return ran;
}
