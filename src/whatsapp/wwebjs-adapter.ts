import { sameMember } from '../core/moderator.ts';
import type { IncomingMessage, OpResult, WhatsAppPort } from '../core/types.ts';
import type { AdapterEvents, WhatsAppAdapter } from './types.ts';

/*
 * Structural subset of the whatsapp-web.js API this adapter relies on. Written from the library's
 * documented surface; it has NOT yet been exercised against a real WhatsApp account. Keeping it
 * structural lets the adapter logic be unit-tested with a mock and keeps the library out of the core.
 */
export interface WwebId {
  _serialized: string;
}
export interface WwebParticipant {
  id: WwebId;
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
}
export interface WwebChat {
  id: WwebId;
  name?: string;
  isGroup: boolean;
  participants?: WwebParticipant[];
  removeParticipants(ids: string[]): Promise<unknown>;
}
export interface WwebMessage {
  id: WwebId;
  from: string;
  author?: string;
  fromMe: boolean;
  body: string;
  timestamp: number;
  delete(everyone?: boolean): Promise<void>;
}
export interface WwebClient {
  on(event: string, listener: (...args: any[]) => void): unknown;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  getChatById(id: string): Promise<WwebChat>;
  getChats(): Promise<WwebChat[]>;
  sendMessage(chatId: string, text: string): Promise<unknown>;
  info?: { wid?: WwebId };
}

export interface WwebAdapterOptions {
  createClient: () => WwebClient;
  /** Max message objects kept so a violating message can be deleted shortly after it arrives. */
  messageCacheSize?: number;
  /** Delay between post-removal verification reads. */
  verifyDelayMs?: number;
  verifyAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class WwebjsAdapter implements WhatsAppAdapter {
  readonly port: WhatsAppPort;
  private client: WwebClient | undefined;
  private generation = 0;
  private readonly cache = new Map<string, WwebMessage>();
  private readonly cacheSize: number;
  private readonly verifyDelay: number;
  private readonly verifyAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: WwebAdapterOptions) {
    this.cacheSize = opts.messageCacheSize ?? 500;
    this.verifyDelay = opts.verifyDelayMs ?? 700;
    this.verifyAttempts = opts.verifyAttempts ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.port = {
      isGroupAdmin: (g, m) => this.isGroupAdmin(g, m),
      deleteMessage: (g, id) => this.deleteMessage(g, id),
      removeMember: (g, m) => this.removeMember(g, m),
      sendGroupNotice: (g, t) => this.sendGroupNotice(g, t),
    };
  }

  async start(events: AdapterEvents): Promise<void> {
    await this.stop();
    const gen = ++this.generation;
    const client = this.opts.createClient();
    this.client = client;
    // Ignore events from a client that has since been replaced.
    const live = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => {
      if (gen === this.generation) fn(...a);
    };
    client.on('qr', live((qr: string) => events.onQr(qr)));
    client.on('ready', live(() => events.onReady()));
    client.on('disconnected', live((reason: unknown) => events.onDisconnected(String(reason))));
    client.on('auth_failure', live((m: unknown) => events.onAuthFailure(String(m))));
    client.on('message', live((m: WwebMessage) => this.onMessage(m, events)));
    await client.initialize();
  }

  async stop(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    this.generation++; // invalidate handlers of the old client
    this.cache.clear();
    if (c) await c.destroy().catch(() => undefined);
  }

  selfId(): string {
    return this.client?.info?.wid?._serialized ?? '';
  }

  async listGroups(): Promise<{ id: string; name: string }[]> {
    const chats = await this.requireClient().getChats();
    return chats.filter((c) => c.isGroup).map((c) => ({ id: c.id._serialized, name: c.name ?? '' }));
  }

  private requireClient(): WwebClient {
    if (!this.client) throw new Error('whatsapp client is not running');
    return this.client;
  }

  private onMessage(m: WwebMessage, events: AdapterEvents): void {
    if (!m.from?.endsWith('@g.us')) return; // only group messages are moderated
    const sender = m.author;
    if (!sender) return; // cannot attribute the message; never guess
    this.cache.set(m.id._serialized, m);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    const msg: IncomingMessage = {
      id: m.id._serialized,
      groupId: m.from,
      senderId: sender,
      fromMe: m.fromMe,
      text: m.body ?? '', // for media messages the caption arrives in body
      timestamp: m.timestamp * 1000,
    };
    events.onMessage(msg);
  }

  private async groupChat(groupId: string): Promise<WwebChat> {
    const chat = await this.requireClient().getChatById(groupId);
    if (!chat?.isGroup) throw new Error('chat is not a group');
    return chat;
  }

  private static find(chat: WwebChat, memberId: string): WwebParticipant | undefined {
    return chat.participants?.find((p) => sameMember(p.id._serialized, memberId));
  }

  /**
   * Fail closed: throws unless admin status can be determined from participant metadata with
   * certainty. The moderator treats a throw as "do nothing".
   */
  private async isGroupAdmin(groupId: string, memberId: string): Promise<boolean> {
    const chat = await this.groupChat(groupId);
    if (!Array.isArray(chat.participants) || chat.participants.length === 0) {
      throw new Error('participant metadata unavailable');
    }
    const p = WwebjsAdapter.find(chat, memberId);
    if (!p) throw new Error('sender not found in participant metadata (possible id format mismatch)');
    if (typeof p.isAdmin !== 'boolean' && typeof p.isSuperAdmin !== 'boolean') {
      throw new Error('administrator flag missing from participant metadata');
    }
    return p.isAdmin === true || p.isSuperAdmin === true;
  }

  private async botIsAdmin(chat: WwebChat): Promise<boolean> {
    const me = this.selfId();
    if (!me) return false;
    const p = WwebjsAdapter.find(chat, me);
    return p?.isAdmin === true || p?.isSuperAdmin === true;
  }

  private async deleteMessage(groupId: string, messageId: string): Promise<OpResult> {
    try {
      const m = this.cache.get(messageId);
      if (!m) return { ok: false, error: 'message is no longer available to delete' };
      const chat = await this.groupChat(groupId);
      if (!(await this.botIsAdmin(chat))) return { ok: false, error: 'bot is not a group administrator' };
      await m.delete(true);
      // The library reports success by resolving; it does not return a revocation receipt.
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  }

  private async removeMember(groupId: string, memberId: string): Promise<OpResult> {
    try {
      const chat = await this.groupChat(groupId);
      if (!(await this.botIsAdmin(chat))) return { ok: false, error: 'bot is not a group administrator' };
      // Defence in depth: never remove an administrator, even if the caller already checked.
      const target = WwebjsAdapter.find(chat, memberId);
      if (!target) return { ok: false, error: 'member is not in the group' };
      if (target.isAdmin !== false || target.isSuperAdmin === true) {
        return { ok: false, error: 'refusing to remove an administrator or a member of unknown role' };
      }

      const result = await chat.removeParticipants([target.id._serialized]);
      if (result && typeof result === 'object') {
        for (const [id, r] of Object.entries(result as Record<string, { code?: number; message?: string }>)) {
          if (r && typeof r.code === 'number' && r.code >= 400) {
            return { ok: false, error: `removal rejected for ${id}: ${r.message ?? r.code}` };
          }
        }
      }

      // Confirm by re-reading membership; success is claimed only if the member is gone.
      for (let i = 0; i < this.verifyAttempts; i++) {
        await this.sleep(this.verifyDelay);
        const fresh = await this.groupChat(groupId);
        if (!Array.isArray(fresh.participants) || fresh.participants.length === 0) {
          return { ok: false, error: 'could not verify removal: participant metadata unavailable' };
        }
        if (!WwebjsAdapter.find(fresh, memberId)) return { ok: true };
      }
      return { ok: false, error: 'member still present after removal was requested' };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  }

  private async sendGroupNotice(groupId: string, text: string): Promise<OpResult> {
    try {
      await this.requireClient().sendMessage(groupId, text);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  }
}
