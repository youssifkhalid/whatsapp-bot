import type {
  AuditEntry, Connection, EventFilters, EventRow, GlobalSettings, GroupConfig, GroupListItem, MemberRow, Overview, Stats,
  SystemInfo, User, UserRow,
} from './types.ts';

export class ApiFailure extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly issues: { path: string; message: string }[] = []) {
    super(message);
  }
}

let csrf = '';
let onUnauthenticated: () => void = () => undefined;
export const setCsrf = (t: string) => void (csrf = t);
export const setUnauthenticatedHandler = (fn: () => void) => void (onUnauthenticated = fn);

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' && csrf ? { 'x-csrf-token': csrf } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiFailure(0, 'network', 'network error');
  }
  let data: any;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const code = data?.error ?? 'http_error';
    // A 401 from login itself is a wrong password, not an expired session.
    if (res.status === 401 && code === 'unauthenticated') onUnauthenticated();
    throw new ApiFailure(res.status, code, data?.message ?? res.statusText, data?.issues ?? []);
  }
  return data as T;
}

const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  setupStatus: () => request<{ needsSetup: boolean; setupEnabled: boolean }>('GET', '/api/auth/setup-status'),
  setup: (b: { username: string; password: string; setupToken: string }) => request<{ user: User }>('POST', '/api/auth/setup', b),
  login: (b: { username: string; password: string }) => request<{ user: User; csrfToken: string }>('POST', '/api/auth/login', b),
  me: () => request<{ user: User; csrfToken: string }>('GET', '/api/auth/me'),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
  changePassword: (b: { current: string; next: string }) => request<{ ok: true }>('POST', '/api/auth/password', b),

  overview: () => request<Overview>('GET', '/api/overview'),
  stats: (days: number) => request<Stats>('GET', `/api/stats${qs({ days })}`),
  connection: () => request<Connection>('GET', '/api/connection'),

  groups: () => request<{ groups: GroupListItem[] }>('GET', '/api/groups'),
  group: (id: string) => request<{ group: GroupConfig }>('GET', `/api/groups/${encodeURIComponent(id)}`),
  patchGroup: (id: string, patch: unknown) => request<{ group: GroupConfig }>('PATCH', `/api/groups/${encodeURIComponent(id)}`, patch),
  addExclusion: (id: string, memberId: string) => request<{ group: GroupConfig }>('POST', `/api/groups/${encodeURIComponent(id)}/exclusions`, { memberId }),
  removeExclusion: (id: string, memberId: string) =>
    request<{ group: GroupConfig }>('DELETE', `/api/groups/${encodeURIComponent(id)}/exclusions/${encodeURIComponent(memberId)}`),

  settings: () => request<GlobalSettings>('GET', '/api/settings'),
  patchSettings: (patch: { testMode?: boolean; ownerIds?: string[]; confirmDisableTestMode?: true }) => request<GlobalSettings>('PATCH', '/api/settings', patch),

  events: (f: EventFilters, page: number, pageSize: number) =>
    request<{ events: EventRow[]; total: number; page: number; pageSize: number }>('GET', `/api/events${qs({ ...f, page, pageSize })}`),
  /** The export endpoint rejects page/pageSize, so they are never included here. */
  exportUrl: (f: EventFilters) => `/api/events/export.csv${qs({ ...f })}`,
  members: (page: number, pageSize: number) => request<{ members: MemberRow[]; page: number; pageSize: number }>('GET', `/api/members${qs({ page, pageSize })}`),

  system: () => request<SystemInfo>('GET', '/api/system'),
  createBackup: () => request<{ name: string; sizeBytes: number }>('POST', '/api/system/backups'),
  audit: () => request<{ entries: AuditEntry[] }>('GET', '/api/audit'),
  users: () => request<{ users: UserRow[] }>('GET', '/api/users'),
  createUser: (b: { username: string; password: string; role: string }) => request<{ user: User }>('POST', '/api/users', b),
  deleteUser: (id: number) => request<{ ok: true }>('DELETE', `/api/users/${id}`),
};
