import { Moderator } from '../core/moderator.ts';
import type { GlobalConfig, GroupConfig, IncomingMessage } from '../core/types.ts';
import type { Repos } from '../storage/repositories.ts';
import type { AdapterEvents, WhatsAppAdapter } from '../whatsapp/types.ts';
import { backoffDelay } from './backoff.ts';
import type { Logger } from './logger.ts';

export type WorkerState = 'starting' | 'awaiting_qr' | 'connected' | 'reconnecting' | 'auth_failed' | 'failed' | 'stopping' | 'stopped';

export interface WorkerOptions {
  adapter: WhatsAppAdapter;
  repos: Repos;
  logger: Logger;
  maxReconnectAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  readyTimeoutMs?: number;
  heartbeatMs?: number;
  configPollMs?: number;
  memoryWarnBytes?: number;
  drainTimeoutMs?: number;
  /** Called when the worker gives up (reconnect budget exhausted). The entrypoint exits non-zero. */
  onFatal?: (reason: string) => void;
}

export class WorkerRuntime {
  private state: WorkerState = 'stopped';
  private attempts = 0;
  private reconnecting = false;
  private stopped = false;
  private startedAt = 0;
  private lastMessageAt: number | null = null;
  private handled = 0;
  private qrAt: number | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private cachedVersion = -1;
  private global: GlobalConfig = { testMode: true, botId: '', ownerIds: [] };
  private groups = new Map<string, GroupConfig>();
  private readonly chains = new Map<string, Promise<void>>();
  private inflight = 0;
  private readonly moderator: Moderator;
  private readonly o: Required<Omit<WorkerOptions, 'adapter' | 'repos' | 'logger' | 'onFatal'>> & Pick<WorkerOptions, 'onFatal'>;
  private readonly adapter: WhatsAppAdapter;
  private readonly repos: Repos;
  private readonly log: Logger;

  constructor(opts: WorkerOptions) {
    this.adapter = opts.adapter;
    this.repos = opts.repos;
    this.log = opts.logger;
    this.o = {
      maxReconnectAttempts: opts.maxReconnectAttempts ?? 10,
      backoffBaseMs: opts.backoffBaseMs ?? 2_000,
      backoffMaxMs: opts.backoffMaxMs ?? 5 * 60_000,
      readyTimeoutMs: opts.readyTimeoutMs ?? 120_000,
      heartbeatMs: opts.heartbeatMs ?? 15_000,
      configPollMs: opts.configPollMs ?? 5_000,
      memoryWarnBytes: opts.memoryWarnBytes ?? 1024 * 1024 * 1024,
      drainTimeoutMs: opts.drainTimeoutMs ?? 10_000,
      onFatal: opts.onFatal,
    };
    this.moderator = new Moderator({
      port: this.adapter.port,
      store: this.repos.eventStore,
      global: () => this.global,
      group: (id) => this.groups.get(id),
    });
  }

  getState(): WorkerState {
    return this.state;
  }

  /** Liveness: the process is running and not in a terminal failure. Disconnection is NOT unhealthy. */
  isLive(): boolean {
    return this.state !== 'failed' && this.state !== 'stopped';
  }
  isReady(): boolean {
    return this.state === 'connected';
  }

  snapshot() {
    const mem = process.memoryUsage();
    return {
      state: this.state,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      reconnectAttempts: this.attempts,
      lastMessageAt: this.lastMessageAt,
      messagesHandled: this.handled,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      qr: this.state === 'awaiting_qr' ? this.qrPayload : undefined,
      qrAt: this.qrAt,
    };
  }
  private qrPayload: string | undefined;

  private setState(state: WorkerState, extra: Record<string, unknown> = {}): void {
    if (this.state !== state) this.log.info('state change', { from: this.state, to: state, ...extra });
    this.state = state;
    this.persist();
  }

  private persist(): void {
    try {
      this.repos.worker.set(this.state, this.snapshot());
    } catch (err) {
      this.log.error('failed to persist worker status', { err });
    }
  }

  refreshConfig(force = false): void {
    try {
      const v = this.repos.settings.version();
      if (!force && v === this.cachedVersion) return;
      this.global = this.repos.settings.getGlobal();
      this.groups = new Map(this.repos.groups.list().map((g) => [g.groupId, g]));
      this.cachedVersion = v;
      this.log.info('configuration loaded', { version: v, groups: this.groups.size, testMode: this.global.testMode });
    } catch (err) {
      // Keep running on the last good configuration.
      this.log.error('configuration refresh failed; keeping previous configuration', { err });
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.startedAt = Date.now();
    this.refreshConfig(true);
    this.setState('starting');
    this.heartbeat = setInterval(() => this.beat(), this.o.heartbeatMs);
    this.poll = setInterval(() => this.refreshConfig(), this.o.configPollMs);
    await this.connect();
  }

  private beat(): void {
    const mem = process.memoryUsage();
    if (mem.rss > this.o.memoryWarnBytes) this.log.warn('high memory usage', { rssBytes: mem.rss });
    this.persist();
  }

  private events(): AdapterEvents {
    return {
      onQr: (qr) => {
        this.clearReadyTimer();
        this.qrPayload = qr;
        this.qrAt = Date.now();
        this.repos.worker.logConnection('qr', 'pairing QR generated');
        this.setState('awaiting_qr');
      },
      onReady: () => void this.handleReady(),
      onDisconnected: (reason) => {
        this.log.warn('whatsapp disconnected', { reason });
        this.repos.worker.logConnection('disconnected', reason);
        this.scheduleReconnect(reason);
      },
      onAuthFailure: (message) => {
        this.clearReadyTimer();
        this.log.error('whatsapp authentication failed; manual action required', { message });
        this.repos.worker.logConnection('auth_failure', message);
        this.setState('auth_failed');
      },
      onMessage: (msg) => this.enqueue(msg),
    };
  }

  private async handleReady(): Promise<void> {
    this.clearReadyTimer();
    this.attempts = 0;
    this.qrPayload = undefined;
    this.qrAt = null;
    try {
      const botId = this.adapter.selfId();
      if (botId && botId !== this.global.botId) this.repos.settings.updateGlobal({ botId });
      for (const g of await this.adapter.listGroups()) this.repos.groups.discover(g.id, g.name);
      this.refreshConfig(true);
    } catch (err) {
      this.log.error('post-connect sync failed', { err });
    }
    this.repos.worker.logConnection('ready');
    this.setState('connected');
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
  }

  private async connect(): Promise<void> {
    try {
      await this.adapter.start(this.events());
      this.clearReadyTimer();
      this.readyTimer = setTimeout(() => {
        if (this.state === 'starting' || this.state === 'reconnecting') {
          this.log.warn('timed out waiting for whatsapp to become ready');
          this.scheduleReconnect('ready timeout');
        }
      }, this.o.readyTimeoutMs);
    } catch (err) {
      this.log.error('adapter start failed', { err });
      this.scheduleReconnect(err instanceof Error ? err.message : String(err));
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnecting || this.state === 'auth_failed') return;
    this.reconnecting = true;
    this.clearReadyTimer();
    this.attempts += 1;
    if (this.attempts > this.o.maxReconnectAttempts) {
      this.reconnecting = false;
      this.setState('failed', { reason });
      this.log.error('reconnect budget exhausted; giving up', { attempts: this.attempts - 1, reason });
      this.repos.worker.logConnection('gave_up', reason);
      this.o.onFatal?.(`reconnect failed after ${this.attempts - 1} attempts: ${reason}`);
      return;
    }
    const delay = backoffDelay(this.attempts, { baseMs: this.o.backoffBaseMs, maxMs: this.o.backoffMaxMs });
    this.setState('reconnecting', { attempt: this.attempts, delayMs: delay });
    const t = setTimeout(async () => {
      this.timers = this.timers.filter((x) => x !== t);
      if (this.stopped) return;
      try {
        await this.adapter.stop();
      } catch (err) {
        this.log.warn('adapter stop during reconnect failed', { err });
      }
      this.reconnecting = false;
      if (!this.stopped) await this.connect();
    }, delay);
    this.timers.push(t);
  }

  private enqueue(msg: IncomingMessage): void {
    if (this.stopped || this.state === 'stopping') return;
    this.lastMessageAt = Date.now();
    this.inflight++;
    const prev = this.chains.get(msg.groupId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        try {
          const out = await this.moderator.handle(msg);
          this.handled++;
          if (out.kind === 'event') {
            this.log.info('moderation event', {
              group: msg.groupId, status: out.event.status, type: out.event.violation.type,
              deleted: out.event.messageDeleted, removed: out.event.memberRemoved, testMode: out.event.testMode,
            });
          }
        } catch (err) {
          // One bad message must never take the worker down.
          this.log.error('moderation failed', { group: msg.groupId, err });
        }
      })
      .finally(() => {
        this.inflight--;
        if (this.chains.get(msg.groupId) === next) this.chains.delete(msg.groupId);
      });
    this.chains.set(msg.groupId, next);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.setState('stopping');
    this.clearReadyTimer();
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.poll) clearInterval(this.poll);

    const deadline = Date.now() + this.o.drainTimeoutMs;
    while (this.inflight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    if (this.inflight > 0) this.log.warn('shutdown with messages still in flight', { inflight: this.inflight });

    try {
      await this.adapter.stop();
    } catch (err) {
      this.log.warn('adapter stop failed during shutdown', { err });
    }
    this.setState('stopped');
  }
}
