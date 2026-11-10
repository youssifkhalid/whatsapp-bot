import { useState, type ReactNode } from 'react';
import { api } from '../lib/api.ts';
import { useI18n } from '../lib/i18n.tsx';
import type { Key } from '../i18n/en.ts';
import { useQuery } from '../lib/query.ts';
import type { UserRow } from '../lib/types.ts';
import { useAuth } from '../auth.tsx';
import { workerTone } from '../layout.tsx';
import {
  Badge, Button, EmptyState, ErrorState, Field, Icon, Input, Ltr, PageHeader, Panel, Select, StatusDot, TableSkeleton, Tabs, tableClass, tdClass, thClass, trClass, useAction,
} from '../ui.tsx';
import { ConfirmDialog } from './shared.tsx';

type Tab = 'health' | 'security' | 'backups' | 'users' | 'audit';

export function System() {
  const { t } = useI18n();
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState<Tab>('health');
  const items: { id: Tab; label: string }[] = [
    { id: 'health', label: t('system.health') }, { id: 'security', label: t('system.security') }, { id: 'backups', label: t('system.backups') },
    ...(isAdmin ? [{ id: 'users' as Tab, label: t('system.users') }, { id: 'audit' as Tab, label: t('system.audit') }] : []),
  ];
  return (
    <>
      <PageHeader title={t('system.title')} description={t('system.subtitle')} />
      <Tabs value={tab} onChange={setTab} items={items} />
      {tab === 'health' && <Health />}
      {tab === 'security' && <Security />}
      {tab === 'backups' && <Backups />}
      {tab === 'users' && isAdmin && <Users />}
      {tab === 'audit' && isAdmin && <Audit />}
    </>
  );
}

function useSystem() {
  return useQuery('system', api.system, { interval: 10000 });
}

function Health() {
  const { t, bytes, duration, number, relative, date } = useI18n();
  const q = useSystem();
  const s = q.data;
  if (q.error && !s) return <Panel><ErrorState message={q.error.message} onRetry={() => void q.refetch()} /></Panel>;
  if (!s) return <Panel flush><TableSkeleton rows={6} cols={2} /></Panel>;
  const rows: [string, ReactNode][] = [
    [t('system.api'), <span key="a" className="inline-flex items-center gap-2"><StatusDot tone="ok" />{t('system.apiOk')}</span>],
    [t('system.worker'), <span key="w" className="inline-flex items-center gap-2"><StatusDot tone={workerTone(s.worker)} />{s.worker.online ? t(`worker.${s.worker.state}` as Key) : t('worker.offline')}{s.worker.lastSeen ? <span className="text-muted" title={date(s.worker.lastSeen)}>({relative(s.worker.lastSeen)})</span> : null}</span>],
    [t('system.database'), `${bytes(s.database.sizeBytes)}, ${t('system.migrationsApplied', { n: number(s.database.migrations.length) })}`],
    [t('system.node'), <Ltr key="n">{s.node}</Ltr>],
    [t('system.apiUptime'), duration(s.uptimeSec * 1000)],
    [t('system.apiMemory'), `${bytes(s.memory.rssBytes)} (${t('system.heap')} ${bytes(s.memory.heapUsedBytes)})`],
    ...(s.worker.online ? [[t('system.workerMemory'), bytes(s.worker.info.rssBytes)] as [string, ReactNode]] : []),
  ];
  return (
    <Panel title={t('system.healthTitle')} description={t('system.healthText')}>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[14rem_1fr]">
        {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-sm text-muted">{k}</dt><dd className="text-sm">{v}</dd></div>)}
      </dl>
    </Panel>
  );
}

function Security() {
  const { t } = useI18n();
  const q = useSystem();
  const s = q.data;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const action = useAction();
  const { logout } = useAuth();
  const flag = (v: boolean, goodWhenTrue = true) => <Badge tone={v === goodWhenTrue ? 'ok' : 'warn'}>{v ? t('common.on') : t('common.off')}</Badge>;

  const change = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (next !== confirm) { setErr(t('system.passwordMismatch')); return; }
    setErr(null);
    const r = await action.run(() => api.changePassword({ current, next }), t('system.passwordChanged'));
    if (r) await logout(); // all sessions are revoked server-side
  };

  return (
    <div className="grid gap-6">
      <Panel title={t('system.envTitle')} description={t('system.envText')}>
        {!s ? <TableSkeleton rows={4} cols={2} /> : (
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[14rem_1fr]">
            <dt className="text-sm text-muted">{t('system.secureCookies')}</dt><dd>{flag(s.security.secureCookies)}</dd>
            <dt className="text-sm text-muted">{t('system.trustProxy')}</dt><dd>{flag(s.security.trustProxy, true)}</dd>
            <dt className="text-sm text-muted">{t('system.setupEnabled')}</dt><dd>{flag(s.security.setupEnabled, false)}</dd>
            <dt className="text-sm text-muted">{t('system.allowedOrigins')}</dt><dd className="text-sm tnum">{s.security.allowedOrigins === 0 ? t('system.sameOriginOnly') : s.security.allowedOrigins}</dd>
          </dl>
        )}
        {s && !s.security.secureCookies && <p className="mt-4 rounded-md bg-caution-soft px-3 py-2 text-sm text-caution-text">{t('system.insecureWarning')}</p>}
        {s && s.security.setupEnabled && <p className="mt-3 rounded-md bg-caution-soft px-3 py-2 text-sm text-caution-text">{t('system.setupWarning')}</p>}
      </Panel>
      <Panel title={t('system.passwordTitle')} description={t('system.passwordText')}>
        <form onSubmit={change} className="grid max-w-md gap-4" noValidate>
          <Field label={t('system.currentPassword')}>{(id) => <Input id={id} type="password" dir="ltr" autoComplete="current-password" value={current} onChange={(e: any) => setCurrent(e.target.value)} />}</Field>
          <Field label={t('system.newPassword')} hint={t('auth.passwordHint')}>{(id) => <Input id={id} type="password" dir="ltr" autoComplete="new-password" value={next} onChange={(e: any) => setNext(e.target.value)} />}</Field>
          <Field label={t('system.confirmPassword')} error={err ?? undefined}>{(id) => <Input id={id} type="password" dir="ltr" autoComplete="new-password" value={confirm} onChange={(e: any) => setConfirm(e.target.value)} />}</Field>
          <div><Button type="submit" variant="primary" busy={action.busy} disabled={!current || !next || !confirm}>{t('system.changePassword')}</Button></div>
        </form>
      </Panel>
    </div>
  );
}

function Backups() {
  const { t, bytes, date, relative, number } = useI18n();
  const { isAdmin } = useAuth();
  const q = useSystem();
  const action = useAction();
  const s = q.data;
  const create = async () => {
    const r = await action.run(() => api.createBackup(), t('system.backupCreated'));
    if (r) await q.refetch();
  };
  return (
    <Panel title={t('system.backupsTitle')} description={t('system.backupsText', { n: s ? number(s.backups.retention) : '' })} flush actions={isAdmin ? <Button variant="primary" busy={action.busy} onClick={() => void create()}><Icon name="database" size={16} />{t('system.backupNow')}</Button> : undefined}>
      {q.error && !s ? <ErrorState message={q.error.message} onRetry={() => void q.refetch()} /> : !s ? <TableSkeleton cols={3} /> : s.backups.items.length === 0 ? (
        <EmptyState icon="database" title={t('system.noBackups')} text={t('system.noBackupsText')} />
      ) : (
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead><tr><th className={thClass}>{t('system.backupFile')}</th><th className={thClass}>{t('system.backupSize')}</th><th className={thClass}>{t('events.time')}</th></tr></thead>
            <tbody>{s.backups.items.map((b) => (
              <tr key={b.name} className={trClass}><td className={tdClass}><Ltr>{b.name}</Ltr></td><td className={`${tdClass} tnum`}>{bytes(b.sizeBytes)}</td><td className={tdClass}><span title={date(b.modifiedAt)}>{relative(b.modifiedAt)}</span></td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <p className="border-t border-line px-5 py-3 text-sm text-muted">{t('system.restoreNote')}</p>
    </Panel>
  );
}

function Users() {
  const { t, date } = useI18n();
  const { user: me } = useAuth();
  const q = useQuery('users', api.users);
  const create = useAction();
  const del = useAction();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('viewer');
  const [target, setTarget] = useState<UserRow | null>(null);

  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    const r = await create.run(() => api.createUser({ username: username.trim(), password, role }), t('system.userCreated'));
    if (r) { setUsername(''); setPassword(''); await q.refetch(); }
  };
  const remove = async () => {
    if (!target) return;
    const r = await del.run(() => api.deleteUser(target.id), t('system.userDeleted'));
    if (r) { setTarget(null); await q.refetch(); }
  };

  return (
    <div className="grid gap-6">
      <Panel title={t('system.addUser')} description={t('system.addUserText')}>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-[1fr_1fr_10rem_auto] sm:items-end" noValidate>
          <Field label={t('auth.username')}>{(id) => <Input id={id} dir="ltr" autoComplete="off" value={username} onChange={(e: any) => setUsername(e.target.value)} />}</Field>
          <Field label={t('auth.password')}>{(id) => <Input id={id} type="password" dir="ltr" autoComplete="new-password" value={password} onChange={(e: any) => setPassword(e.target.value)} />}</Field>
          <Field label={t('system.role')}>{(id) => <Select id={id} value={role} onChange={(e: any) => setRole(e.target.value)}><option value="viewer">{t('role.viewer')}</option><option value="admin">{t('role.admin')}</option></Select>}</Field>
          <Button type="submit" variant="primary" busy={create.busy} disabled={!username || !password}><Icon name="plus" size={16} />{t('common.add')}</Button>
        </form>
      </Panel>
      <Panel title={t('system.users')} flush>
        {q.loading ? <TableSkeleton cols={4} /> : q.error && !q.data ? <ErrorState message={q.error.message} onRetry={() => void q.refetch()} /> : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead><tr><th className={thClass}>{t('auth.username')}</th><th className={thClass}>{t('system.role')}</th><th className={thClass}>{t('system.created')}</th><th className={thClass}><span className="sr-only">{t('common.remove')}</span></th></tr></thead>
              <tbody>{q.data?.users.map((u) => (
                <tr key={u.id} className={trClass}>
                  <td className={tdClass}><Ltr>{u.username}</Ltr>{u.id === me.id && <Badge tone="info" className="ms-2">{t('system.you')}</Badge>}</td>
                  <td className={tdClass}><Badge tone={u.role === 'admin' ? 'info' : 'neutral'}>{t(u.role === 'admin' ? 'role.admin' : 'role.viewer')}</Badge></td>
                  <td className={tdClass}>{date(u.createdAt)}</td>
                  <td className={`${tdClass} text-end`}>{u.id !== me.id && <Button size="sm" variant="outlineDanger" onClick={() => setTarget(u)} aria-label={`${t('common.remove')} ${u.username}`}><Icon name="trash" size={14} />{t('common.remove')}</Button>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Panel>
      <ConfirmDialog open={!!target} danger busy={del.busy} title={t('system.deleteUserTitle')} text={t('system.deleteUserText', { name: target?.username ?? '' })} confirmLabel={t('common.remove')} onConfirm={() => void remove()} onClose={() => setTarget(null)} />
    </div>
  );
}

function Audit() {
  const { t, date } = useI18n();
  const q = useQuery('audit', api.audit, { interval: 15000 });
  return (
    <Panel title={t('system.auditTitle')} description={t('system.auditText')} flush>
      {q.loading ? <TableSkeleton cols={4} /> : q.error && !q.data ? <ErrorState message={q.error.message} onRetry={() => void q.refetch()} /> : (
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead><tr><th className={thClass}>{t('events.time')}</th><th className={thClass}>{t('auth.username')}</th><th className={thClass}>{t('system.action')}</th><th className={thClass}>{t('events.details')}</th></tr></thead>
            <tbody>{q.data?.entries.map((e) => {
              const { ip, ...rest } = e.details as Record<string, unknown>;
              return (
                <tr key={e.id} className={trClass}>
                  <td className={`${tdClass} whitespace-nowrap`}>{date(e.at)}</td>
                  <td className={tdClass}>{e.username ? <Ltr>{e.username}</Ltr> : <span className="text-muted">-</span>}</td>
                  <td className={tdClass}><Ltr>{e.action}</Ltr></td>
                  <td className={`${tdClass} text-muted`}><Ltr className="break-all">{[ip ? `ip=${String(ip)}` : '', ...Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)].filter(Boolean).join(' ')}</Ltr></td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
