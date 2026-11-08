import { detectLink } from './links.ts';
import { ProfanityDetector } from './profanity.ts';
import type {
  EventStatus,
  EventStore,
  GlobalConfig,
  GroupConfig,
  IncomingMessage,
  ModerationEvent,
  ModerationOutcome,
  OpResult,
  Violation,
  WhatsAppPort,
} from './types.ts';

export interface ModeratorDeps {
  port: WhatsAppPort;
  store: EventStore;
  global: () => GlobalConfig;
  group: (groupId: string) => GroupConfig | undefined;
  now?: () => number;
  /** Test hook; production code uses the real detector cache. */
  detectorFor?: (cfg: GroupConfig) => ProfanityDetector;
}

/** Compare ids ignoring the device/server suffix ("1203@c.us" == "1203@lid" is NOT assumed; only ":device" parts are dropped). */
export function sameMember(a: string, b: string): boolean {
  const strip = (s: string) => s.replace(/:\d+(?=@)/, '').toLowerCase();
  return strip(a) === strip(b);
}

async function safely(fn: () => Promise<OpResult>): Promise<OpResult> {
  try {
    return await fn();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export class Moderator {
  private readonly detectors = new Map<string, { sig: string; det: ProfanityDetector }>();

  constructor(private readonly deps: ModeratorDeps) {}

  private detectorFor(cfg: GroupConfig): ProfanityDetector {
    if (this.deps.detectorFor) return this.deps.detectorFor(cfg);
    const sig = JSON.stringify(cfg.profanity);
    const cached = this.detectors.get(cfg.groupId);
    if (cached && cached.sig === sig) return cached.det;
    const det = new ProfanityDetector(cfg.profanity);
    this.detectors.set(cfg.groupId, { sig, det });
    return det;
  }

  private detect(msg: IncomingMessage, cfg: GroupConfig): Violation | null {
    const text = [msg.text, msg.caption].filter(Boolean).join('\n');
    return detectLink(text, cfg.links) ?? this.detectorFor(cfg).detect(text);
  }

  async handle(msg: IncomingMessage): Promise<ModerationOutcome> {
    const g = this.deps.global();
    const now = this.deps.now ?? Date.now;

    if (msg.fromMe || sameMember(msg.senderId, g.botId)) return { kind: 'ignored', reason: 'from_bot' };

    const cfg = this.deps.group(msg.groupId);
    if (!cfg) return { kind: 'ignored', reason: 'no_group_config' };
    if (!cfg.enabled) return { kind: 'ignored', reason: 'group_disabled' };

    const violation = this.detect(msg, cfg);
    if (!violation) return { kind: 'ignored', reason: 'no_violation' };

    const base = {
      messageId: msg.id,
      groupId: msg.groupId,
      senderId: msg.senderId,
      violation,
      testMode: g.testMode,
      messageDeleted: false,
      memberRemoved: false,
      noticeSent: false,
      errors: [] as string[],
      at: now(),
    };
    const finish = async (status: EventStatus, extra: Partial<ModerationEvent> = {}): Promise<ModerationOutcome> => {
      const event: ModerationEvent = { ...base, status, ...extra };
      await this.deps.store.save(event);
      return { kind: 'event', event };
    };

    // Protection: owner and per-group exclusions.
    if (g.ownerIds.some((o) => sameMember(o, msg.senderId))) {
      return finish('skipped_protected', { detail: 'sender is the system owner' });
    }
    if (cfg.excludedMembers.some((m) => sameMember(m, msg.senderId))) {
      return finish('skipped_protected', { detail: 'sender is on the exclusion list' });
    }

    // Protection: group administrators. If we cannot verify, we do nothing.
    let isAdmin: boolean;
    try {
      isAdmin = await this.deps.port.isGroupAdmin(msg.groupId, msg.senderId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return finish('skipped_check_failed', {
        detail: 'could not verify administrator status; no action taken',
        errors: [reason],
      });
    }
    if (isAdmin) return finish('skipped_protected', { detail: 'sender is a group administrator' });

    // Idempotency.
    const claimed = await this.deps.store.claim(`${msg.groupId}:${msg.id}`);
    if (!claimed) return finish('duplicate', { detail: 'message already processed' });

    // Test mode: record only.
    if (g.testMode) {
      return finish('simulated', { detail: 'test mode: no destructive action was executed' });
    }

    // Execute. Delete and removal are independent so one failure does not block the other.
    const errors: string[] = [];
    const del = await safely(() => this.deps.port.deleteMessage(msg.groupId, msg.id));
    if (!del.ok) errors.push(`delete failed: ${del.error ?? 'unknown error'}`);
    const rem = await safely(() => this.deps.port.removeMember(msg.groupId, msg.senderId));
    if (!rem.ok) errors.push(`remove failed: ${rem.error ?? 'unknown error'}`);

    let noticeSent = false;
    if (cfg.notifyGroup && (del.ok || rem.ok)) {
      const what = rem.ok ? 'A member was removed' : 'A message was deleted';
      const why = violation.type === 'link' ? 'posting a link' : 'inappropriate language';
      const notice = await safely(() => this.deps.port.sendGroupNotice(msg.groupId, `${what} for ${why}.`));
      noticeSent = notice.ok;
      if (!notice.ok) errors.push(`notice failed: ${notice.error ?? 'unknown error'}`);
    }

    const status: EventStatus = del.ok && rem.ok ? 'completed' : del.ok || rem.ok ? 'partial' : 'failed';
    return finish(status, {
      messageDeleted: del.ok,
      memberRemoved: rem.ok,
      noticeSent,
      errors,
      ...(errors.length ? { detail: errors.join('; ') } : {}),
    });
  }
}

/** In-memory store, used by tests and as the reference implementation of the contract. */
export class MemoryEventStore implements EventStore {
  readonly events: ModerationEvent[] = [];
  private readonly claimed = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }

  async save(event: ModerationEvent): Promise<void> {
    this.events.push(event);
  }
}
