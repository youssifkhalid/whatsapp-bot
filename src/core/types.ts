export type ViolationType = 'link' | 'profanity';

export type LinkCategory = 'whatsapp_invite' | 'telegram' | 'social' | 'shortener' | 'generic';

export interface IncomingMessage {
  id: string;
  groupId: string;
  senderId: string;
  /** True when the message was sent by the account the bot is running on. */
  fromMe: boolean;
  text: string;
  /** Media caption, if any. Scanned together with text. */
  caption?: string;
  timestamp: number;
}

export interface LinkRules {
  enabled: boolean;
  /** Hosts that are always permitted (subdomains included). */
  allowedDomains: string[];
  /** Detect "example.com" with no scheme. */
  detectBareDomains: boolean;
}

export interface ProfanityRules {
  enabled: boolean;
  customWords: string[];
  /** Words that must never be flagged, even if they match a blocked term. */
  allowWords: string[];
}

export interface GroupConfig {
  groupId: string;
  enabled: boolean;
  links: LinkRules;
  profanity: ProfanityRules;
  /** Member ids that are never moderated in this group. */
  excludedMembers: string[];
  notifyGroup: boolean;
}

export interface GlobalConfig {
  /** When true no destructive operation is ever issued; events are recorded as simulated. */
  testMode: boolean;
  /** The bot's own WhatsApp id. */
  botId: string;
  /** System owner ids. Never moderated. */
  ownerIds: string[];
}

export interface Violation {
  type: ViolationType;
  /** Matched host (links) or matched blocked term (profanity). Never the full message. */
  matched: string;
  category?: LinkCategory;
}

export interface OpResult {
  ok: boolean;
  error?: string;
}

/** Everything the moderator needs from the messaging layer. */
export interface WhatsAppPort {
  isGroupAdmin(groupId: string, memberId: string): Promise<boolean>;
  deleteMessage(groupId: string, messageId: string): Promise<OpResult>;
  removeMember(groupId: string, memberId: string): Promise<OpResult>;
  sendGroupNotice(groupId: string, text: string): Promise<OpResult>;
}

export type EventStatus =
  | 'completed' // every attempted action confirmed
  | 'partial' // at least one action confirmed, at least one failed
  | 'failed' // actions attempted, none confirmed
  | 'simulated' // test mode, nothing executed
  | 'skipped_protected' // owner, admin or excluded member
  | 'skipped_check_failed' // could not verify admin status, so nothing was done
  | 'duplicate'; // already processed

export interface ModerationEvent {
  messageId: string;
  groupId: string;
  senderId: string;
  violation: Violation;
  status: EventStatus;
  testMode: boolean;
  messageDeleted: boolean;
  memberRemoved: boolean;
  noticeSent: boolean;
  /** Human readable explanation for skips and failures. */
  detail?: string;
  errors: string[];
  at: number;
}

export interface EventStore {
  /** Atomically claim a message for processing. Returns false if already claimed. */
  claim(key: string): Promise<boolean>;
  save(event: ModerationEvent): Promise<void>;
}

export type ModerationOutcome =
  | { kind: 'ignored'; reason: 'from_bot' | 'no_group_config' | 'group_disabled' | 'no_violation' }
  | { kind: 'event'; event: ModerationEvent };
