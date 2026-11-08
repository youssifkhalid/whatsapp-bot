import type { Db } from './db.ts';
import { num, str, transaction } from './db.ts';
import type { EventStore, GlobalConfig, GroupConfig, ModerationEvent } from '../core/types.ts';

const json = <T>(v: unknown, fallback: T): T => {
  try {
    return JSON.parse(str(v)) as T;
  } catch {
    return fallback;
  }
};

export interface EventFilter {
  groupId?: string;
  senderId?: string;
  type?: string;
  status?: string;
  q?: string;
  from?: number;
  to?: number;
}

export interface StoredEvent extends ModerationEvent {
  id: number;
}

function rowToEvent(r: Record<string, unknown>): StoredEvent {
  return {
    id: num(r['id']),
    messageId: str(r['message_id']),
    groupId: str(r['group_id']),
    senderId: str(r['sender_id']),
    violation: {
      type: str(r['violation_type']) as 'link' | 'profanity',
      matched: str(r['matched']),
      ...(r['category'] ? { category: str(r['category']) as never } : {}),
    },
    status: str(r['status']) as ModerationEvent['status'],
    testMode: num(r['test_mode']) === 1,
    messageDeleted: num(r['message_deleted']) === 1,
    memberRemoved: num(r['member_removed']) === 1,
    noticeSent: num(r['notice_sent']) === 1,
    ...(r['detail'] ? { detail: str(r['detail']) } : {}),
    errors: json<string[]>(r['errors'], []),
    at: num(r['at']),
  };
}

/** SQLite-backed EventStore. `claim` is atomic through the primary key. */
export class SqliteEventStore implements EventStore {
  constructor(private readonly db: Db) {}

  async claim(key: string): Promise<boolean> {
    const res = this.db.prepare('INSERT OR IGNORE INTO processed_messages (key, claimed_at) VALUES (?, ?)').run(key, Date.now());
    return Number(res.changes) === 1;
  }

  async save(e: ModerationEvent): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO events (message_id, group_id, sender_id, violation_type, matched, category, status, test_mode,
          message_deleted, member_removed, notice_sent, detail, errors, at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        e.messageId, e.groupId, e.senderId, e.violation.type, e.violation.matched, e.violation.category ?? null,
        e.status, e.testMode ? 1 : 0, e.messageDeleted ? 1 : 0, e.memberRemoved ? 1 : 0, e.noticeSent ? 1 : 0,
        e.detail ?? null, JSON.stringify(e.errors), e.at,
      );
  }
}

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  private get(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return r ? str(r['value']) : undefined;
  }
  private set(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Test mode defaults to ON unless explicitly stored as "0". */
  getGlobal(): GlobalConfig {
    return {
      testMode: this.get('test_mode') !== '0',
      botId: this.get('bot_id') ?? '',
      ownerIds: json<string[]>(this.get('owner_ids'), []),
    };
  }

  updateGlobal(patch: Partial<GlobalConfig>): void {
    transaction(this.db, () => {
      if (patch.testMode !== undefined) this.set('test_mode', patch.testMode ? '1' : '0');
      if (patch.botId !== undefined) this.set('bot_id', patch.botId);
      if (patch.ownerIds !== undefined) this.set('owner_ids', JSON.stringify(patch.ownerIds));
      this.bumpVersion();
    });
  }

  version(): number {
    return Number(this.get('config_version') ?? 0);
  }
  bumpVersion(): void {
    this.set('config_version', String(this.version() + 1));
  }
}

export class GroupRepo {
  constructor(private readonly db: Db, private readonly settings: SettingsRepo) {}

  /** Register a group seen by the worker. New groups start with moderation DISABLED. */
  discover(groupId: string, name: string): void {
    this.db
      .prepare(
        `INSERT INTO groups (group_id, name, enabled, updated_at) VALUES (?, ?, 0, ?)
         ON CONFLICT(group_id) DO UPDATE SET name = excluded.name`,
      )
      .run(groupId, name, Date.now());
  }

  private excluded(groupId: string): string[] {
    return this.db.prepare('SELECT member_id FROM exclusions WHERE group_id = ? ORDER BY member_id').all(groupId).map((r) => str(r['member_id']));
  }

  private toConfig(r: Record<string, unknown>): GroupConfig & { name: string } {
    const id = str(r['group_id']);
    return {
      groupId: id,
      name: str(r['name']),
      enabled: num(r['enabled']) === 1,
      notifyGroup: num(r['notify_group']) === 1,
      links: {
        enabled: num(r['links_enabled']) === 1,
        detectBareDomains: num(r['detect_bare_domains']) === 1,
        allowedDomains: json<string[]>(r['allowed_domains'], []),
      },
      profanity: {
        enabled: num(r['profanity_enabled']) === 1,
        customWords: json<string[]>(r['custom_words'], []),
        allowWords: json<string[]>(r['allow_words'], []),
      },
      excludedMembers: this.excluded(id),
    };
  }

  get(groupId: string): (GroupConfig & { name: string }) | undefined {
    const r = this.db.prepare('SELECT * FROM groups WHERE group_id = ?').get(groupId);
    return r ? this.toConfig(r) : undefined;
  }

  list(): (GroupConfig & { name: string })[] {
    return this.db.prepare('SELECT * FROM groups ORDER BY name, group_id').all().map((r) => this.toConfig(r));
  }

  update(groupId: string, patch: Partial<Omit<GroupConfig, 'groupId' | 'excludedMembers'>>): boolean {
    const cur = this.get(groupId);
    if (!cur) return false;
    const next = {
      enabled: patch.enabled ?? cur.enabled,
      notifyGroup: patch.notifyGroup ?? cur.notifyGroup,
      links: { ...cur.links, ...patch.links },
      profanity: { ...cur.profanity, ...patch.profanity },
    };
    transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE groups SET enabled=?, notify_group=?, links_enabled=?, detect_bare_domains=?, allowed_domains=?,
             profanity_enabled=?, custom_words=?, allow_words=?, updated_at=? WHERE group_id=?`,
        )
        .run(
          next.enabled ? 1 : 0, next.notifyGroup ? 1 : 0, next.links.enabled ? 1 : 0, next.links.detectBareDomains ? 1 : 0,
          JSON.stringify(next.links.allowedDomains), next.profanity.enabled ? 1 : 0,
          JSON.stringify(next.profanity.customWords), JSON.stringify(next.profanity.allowWords), Date.now(), groupId,
        );
      this.settings.bumpVersion();
    });
    return true;
  }

  addExclusion(groupId: string, memberId: string): boolean {
    if (!this.get(groupId)) return false;
    transaction(this.db, () => {
      this.db.prepare('INSERT OR IGNORE INTO exclusions (group_id, member_id, created_at) VALUES (?,?,?)').run(groupId, memberId, Date.now());
      this.settings.bumpVersion();
    });
    return true;
  }

  removeExclusion(groupId: string, memberId: string): boolean {
    return transaction(this.db, () => {
      const res = this.db.prepare('DELETE FROM exclusions WHERE group_id=? AND member_id=?').run(groupId, memberId);
      this.settings.bumpVersion();
      return Number(res.changes) > 0;
    });
  }
}

function where(f: EventFilter): { sql: string; params: unknown[] } {
  const c: string[] = [];
  const p: unknown[] = [];
  if (f.groupId) (c.push('group_id = ?'), p.push(f.groupId));
  if (f.senderId) (c.push('sender_id = ?'), p.push(f.senderId));
  if (f.type) (c.push('violation_type = ?'), p.push(f.type));
  if (f.status) (c.push('status = ?'), p.push(f.status));
  if (f.from !== undefined) (c.push('at >= ?'), p.push(f.from));
  if (f.to !== undefined) (c.push('at <= ?'), p.push(f.to));
  if (f.q) {
    c.push("(sender_id LIKE ? ESCAPE '\\' OR matched LIKE ? ESCAPE '\\' OR message_id LIKE ? ESCAPE '\\')");
    const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    p.push(like, like, like);
  }
  return { sql: c.length ? `WHERE ${c.join(' AND ')}` : '', params: p };
}

export class EventRepo {
  constructor(private readonly db: Db) {}

  list(f: EventFilter, limit = 50, offset = 0): { rows: StoredEvent[]; total: number } {
    const w = where(f);
    const total = num(this.db.prepare(`SELECT COUNT(*) AS n FROM events ${w.sql}`).get(...w.params)?.['n']);
    const rows = this.db
      .prepare(`SELECT * FROM events ${w.sql} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...w.params, Math.min(Math.max(limit, 1), 500), Math.max(offset, 0))
      .map(rowToEvent);
    return { rows, total };
  }

  get(id: number): StoredEvent | undefined {
    const r = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    return r ? rowToEvent(r) : undefined;
  }

  stats(sinceMs: number): {
    violations: number;
    deletedMessages: number;
    removedMembers: number;
    simulated: number;
    daily: { day: string; count: number }[];
  } {
    const t = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(message_deleted),0) AS d, COALESCE(SUM(member_removed),0) AS r,
           COALESCE(SUM(status='simulated'),0) AS s FROM events WHERE status != 'duplicate' AND at >= ?`,
      )
      .get(sinceMs);
    const daily = this.db
      .prepare(
        `SELECT strftime('%Y-%m-%d', at/1000, 'unixepoch') AS day, COUNT(*) AS n FROM events
         WHERE status != 'duplicate' AND at >= ? GROUP BY day ORDER BY day`,
      )
      .all(sinceMs)
      .map((r) => ({ day: str(r['day']), count: num(r['n']) }));
    return {
      violations: num(t?.['n']),
      deletedMessages: num(t?.['d']),
      removedMembers: num(t?.['r']),
      simulated: num(t?.['s']),
      daily,
    };
  }

  members(limit = 100, offset = 0): { senderId: string; violations: number; removed: number; lastAt: number }[] {
    return this.db
      .prepare(
        `SELECT sender_id, COUNT(*) AS n, COALESCE(SUM(member_removed),0) AS r, MAX(at) AS last_at
         FROM events WHERE status != 'duplicate' GROUP BY sender_id ORDER BY last_at DESC LIMIT ? OFFSET ?`,
      )
      .all(Math.min(limit, 500), offset)
      .map((r) => ({ senderId: str(r['sender_id']), violations: num(r['n']), removed: num(r['r']), lastAt: num(r['last_at']) }));
  }

  /** CSV export. Cells starting with = + - @ are prefixed to prevent spreadsheet formula injection. */
  toCsv(rows: StoredEvent[]): string {
    const cell = (v: unknown): string => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ['id', 'time', 'group', 'sender', 'type', 'matched', 'category', 'status', 'test_mode', 'deleted', 'removed', 'detail'];
    const lines = rows.map((e) =>
      [e.id, new Date(e.at).toISOString(), e.groupId, e.senderId, e.violation.type, e.violation.matched, e.violation.category ?? '',
        e.status, e.testMode, e.messageDeleted, e.memberRemoved, e.detail ?? ''].map(cell).join(','),
    );
    return [head.join(','), ...lines].join('\n');
  }
}

export class AuditRepo {
  constructor(private readonly db: Db) {}
  record(action: string, user: { id: number; username: string } | null, details: Record<string, unknown> = {}): void {
    this.db
      .prepare('INSERT INTO audit_log (user_id, username, action, details, at) VALUES (?,?,?,?,?)')
      .run(user?.id ?? null, user?.username ?? null, action, JSON.stringify(details), Date.now());
  }
  list(limit = 100): { id: number; username: string | null; action: string; details: unknown; at: number }[] {
    return this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(Math.min(limit, 500)).map((r) => ({
      id: num(r['id']), username: r['username'] ? str(r['username']) : null, action: str(r['action']),
      details: json(r['details'], {}), at: num(r['at']),
    }));
  }
}

export interface WorkerStatus {
  state: string;
  info: Record<string, unknown>;
  updatedAt: number;
}

export class WorkerStatusRepo {
  constructor(private readonly db: Db) {}
  set(state: string, info: Record<string, unknown> = {}): void {
    this.db
      .prepare(
        `INSERT INTO worker_status (id, state, info, updated_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state=excluded.state, info=excluded.info, updated_at=excluded.updated_at`,
      )
      .run(state, JSON.stringify(info), Date.now());
  }
  get(): WorkerStatus | undefined {
    const r = this.db.prepare('SELECT * FROM worker_status WHERE id = 1').get();
    return r ? { state: str(r['state']), info: json(r['info'], {}), updatedAt: num(r['updated_at']) } : undefined;
  }
  logConnection(kind: string, detail?: string): void {
    this.db.prepare('INSERT INTO connection_events (kind, detail, at) VALUES (?,?,?)').run(kind, detail ?? null, Date.now());
    this.db.prepare('DELETE FROM connection_events WHERE id NOT IN (SELECT id FROM connection_events ORDER BY id DESC LIMIT 500)').run();
  }
  connectionEvents(limit = 50): { kind: string; detail: string | null; at: number }[] {
    return this.db.prepare('SELECT * FROM connection_events ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({
      kind: str(r['kind']), detail: r['detail'] ? str(r['detail']) : null, at: num(r['at']),
    }));
  }
}

export function createRepos(db: Db) {
  const settings = new SettingsRepo(db);
  return {
    settings,
    groups: new GroupRepo(db, settings),
    events: new EventRepo(db),
    eventStore: new SqliteEventStore(db),
    audit: new AuditRepo(db),
    worker: new WorkerStatusRepo(db),
  };
}
export type Repos = ReturnType<typeof createRepos>;
