import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../storage/db.ts';
import { num, str, transaction } from '../storage/db.ts';
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from './password.ts';

export type Role = 'admin' | 'viewer';

export interface AuthUser {
  id: number;
  username: string;
  role: Role;
}

export interface Session {
  token: string; // returned once at login; only its hash is stored
  csrfToken: string;
  expiresAt: number;
  user: AuthUser;
}

export class AuthError extends Error {
  constructor(public readonly code: 'invalid_credentials' | 'locked' | 'weak_password' | 'exists' | 'invalid_username', message: string) {
    super(message);
  }
}

export interface AuthOptions {
  sessionTtlMs?: number;
  maxFailures?: number;
  lockoutWindowMs?: number;
  now?: () => number;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,64}$/;
// A real hash computed once so unknown-user logins cost the same as known-user ones.
let dummyHash: Promise<string> | undefined;

export class AuthService {
  private readonly ttl: number;
  private readonly maxFailures: number;
  private readonly window: number;
  private readonly now: () => number;

  constructor(private readonly db: Db, opts: AuthOptions = {}) {
    this.ttl = opts.sessionTtlMs ?? 12 * 60 * 60 * 1000;
    this.maxFailures = opts.maxFailures ?? 5;
    this.window = opts.lockoutWindowMs ?? 15 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  async createUser(username: string, password: string, role: Role): Promise<AuthUser> {
    if (!USERNAME_RE.test(username)) throw new AuthError('invalid_username', 'username must be 3-64 chars: letters, digits, . _ -');
    if (password.length < MIN_PASSWORD_LENGTH) throw new AuthError('weak_password', `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    const hash = await hashPassword(password);
    try {
      const res = this.db
        .prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,?)')
        .run(username, hash, role, this.now());
      return { id: Number(res.lastInsertRowid), username, role };
    } catch (err) {
      if (err instanceof Error && /UNIQUE/i.test(err.message)) throw new AuthError('exists', 'username already exists');
      throw err;
    }
  }

  userCount(): number {
    return num(this.db.prepare('SELECT COUNT(*) AS n FROM users').get()?.['n']);
  }

  private recentFailures(username: string): number {
    return num(
      this.db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE username = ? AND at > ?').get(username, this.now() - this.window)?.['n'],
    );
  }

  async login(username: string, password: string): Promise<Session> {
    if (this.recentFailures(username) >= this.maxFailures) {
      throw new AuthError('locked', 'too many failed attempts; try again later');
    }
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    dummyHash ??= hashPassword('dummy-password-for-timing');
    const ok = await verifyPassword(password, row ? str(row['password_hash']) : await dummyHash);
    if (!row || !ok) {
      this.db.prepare('INSERT INTO login_attempts (username, at) VALUES (?, ?)').run(username, this.now());
      throw new AuthError('invalid_credentials', 'invalid username or password');
    }
    this.db.prepare('DELETE FROM login_attempts WHERE username = ?').run(username);
    const user: AuthUser = { id: num(row['id']), username: str(row['username']), role: str(row['role']) as Role };
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(24).toString('base64url');
    const expiresAt = this.now() + this.ttl;
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(this.now());
      this.db
        .prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?,?,?,?,?)')
        .run(sha256(token), user.id, csrfToken, this.now(), expiresAt);
    });
    return { token, csrfToken, expiresAt, user };
  }

  /** Resolve a session token. Returns null if unknown or expired. */
  authenticate(token: string | undefined): { user: AuthUser; csrfToken: string } | null {
    if (!token) return null;
    const r = this.db
      .prepare(
        `SELECT s.csrf_token, s.expires_at, u.id, u.username, u.role FROM sessions s
         JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(sha256(token));
    if (!r || num(r['expires_at']) <= this.now()) return null;
    return { csrfToken: str(r['csrf_token']), user: { id: num(r['id']), username: str(r['username']), role: str(r['role']) as Role } };
  }

  /** Constant-time CSRF comparison for state-changing requests. */
  verifyCsrf(session: { csrfToken: string }, supplied: string | undefined): boolean {
    if (!supplied) return false;
    const a = Buffer.from(session.csrfToken);
    const b = Buffer.from(supplied);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  logout(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  async changePassword(userId: number, current: string, next: string): Promise<void> {
    if (next.length < MIN_PASSWORD_LENGTH) throw new AuthError('weak_password', `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    const row = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
    if (!row || !(await verifyPassword(current, str(row['password_hash'])))) throw new AuthError('invalid_credentials', 'current password is incorrect');
    const hash = await hashPassword(next);
    transaction(this.db, () => {
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId); // revoke all sessions
    });
  }
}

/** Role gate used by the API layer. Admin may do everything; viewer is read-only. */
export function can(user: AuthUser, action: 'read' | 'write'): boolean {
  return action === 'read' ? true : user.role === 'admin';
}
