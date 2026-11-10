// Response shapes of the Guardian REST API (see src/api/app.ts). Kept in sync by hand; the API tests pin the contract.

export type Role = 'admin' | 'viewer';
export interface User { id: number; username: string; role: Role }

export type WorkerState =
  | 'unknown' | 'starting' | 'awaiting_qr' | 'connected' | 'reconnecting' | 'auth_failed' | 'failed' | 'stopping' | 'stopped';

export interface WorkerView {
  state: WorkerState;
  online: boolean;
  lastSeen: number | null;
  info: {
    uptimeMs?: number; reconnectAttempts?: number; lastMessageAt?: number | null; messagesHandled?: number;
    rssBytes?: number; heapUsedBytes?: number;
  };
}

export interface Stats {
  violations: number; deletedMessages: number; removedMembers: number; simulated: number;
  daily: { day: string; count: number }[];
}

export type ViolationType = 'link' | 'profanity';
export type EventStatus = 'completed' | 'partial' | 'failed' | 'simulated' | 'skipped_protected' | 'skipped_check_failed' | 'duplicate';

export interface EventRow {
  id: number; messageId: string; groupId: string; senderId: string;
  violation: { type: ViolationType; matched: string; category?: string };
  status: EventStatus; testMode: boolean; messageDeleted: boolean; memberRemoved: boolean; noticeSent: boolean;
  detail?: string; errors: string[]; at: number;
}

export interface GroupConfig {
  groupId: string; name: string; enabled: boolean; notifyGroup: boolean;
  links: { enabled: boolean; detectBareDomains: boolean; allowedDomains: string[] };
  profanity: { enabled: boolean; customWords: string[]; allowWords: string[] };
  excludedMembers: string[];
}
export type GroupListItem = GroupConfig & { violations: number };

export interface Overview {
  worker: WorkerView; testMode: boolean;
  groups: { total: number; enabled: number };
  stats: { last7Days: Stats; last30Days: Stats; allTime: Stats };
  recent: EventRow[];
}

export interface Connection {
  worker: WorkerView; qr: string | null;
  events: { kind: string; detail: string | null; at: number }[];
}

export interface GlobalSettings { testMode: boolean; botId: string; ownerIds: string[] }

export interface MemberRow { senderId: string; violations: number; removed: number; lastAt: number; excludedIn: string[] }

export interface SystemInfo {
  node: string; uptimeSec: number;
  memory: { rssBytes: number; heapUsedBytes: number };
  database: { sizeBytes: number | null; migrations: { id: number; name: string }[] };
  security: { secureCookies: boolean; trustProxy: boolean; setupEnabled: boolean; allowedOrigins: number };
  worker: WorkerView;
  backups: { retention: number; items: { name: string; sizeBytes: number; modifiedAt: number }[] };
}

export interface AuditEntry { id: number; username: string | null; action: string; details: Record<string, unknown>; at: number }
export interface UserRow extends User { createdAt: number }

export interface EventFilters {
  q?: string; groupId?: string; type?: string; status?: string; senderId?: string; from?: string; to?: string;
}
