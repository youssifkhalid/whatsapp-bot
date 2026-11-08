import type { IncomingMessage, WhatsAppPort } from '../core/types.ts';

export interface AdapterEvents {
  /** A pairing QR payload; the user must scan it with the dedicated phone. */
  onQr(qr: string): void;
  onReady(): void;
  onDisconnected(reason: string): void;
  /** The stored session was rejected. Retrying automatically would not help. */
  onAuthFailure(message: string): void;
  onMessage(msg: IncomingMessage): void;
}

/**
 * Everything the worker needs from a WhatsApp integration. The moderation engine only ever sees
 * `port`; replacing whatsapp-web.js means writing another implementation of this interface.
 */
export interface WhatsAppAdapter {
  readonly port: WhatsAppPort;
  start(events: AdapterEvents): Promise<void>;
  stop(): Promise<void>;
  /** The bot's own id. Only valid after onReady. */
  selfId(): string;
  listGroups(): Promise<{ id: string; name: string }[]>;
}
