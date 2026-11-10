import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiFailure } from './lib/api.ts';
import { useI18n } from './lib/i18n.tsx';
import { useQuery, type QueryResult } from './lib/query.ts';
import { href, useRoute } from './lib/router.ts';
import type { Overview, WorkerState } from './lib/types.ts';
import { cn } from './lib/utils.ts';
import { Brand, PrefButtons, useAuth } from './auth.tsx';
import { Badge, Button, Icon, StatusDot, type IconName } from './ui.tsx';

/** Overview data is polled once here and shared, so the safety band, sidebar chip and Overview page never disagree. */
const StatusCtx = createContext<QueryResult<Overview> | null>(null);
export function useStatus(): QueryResult<Overview> {
  const v = useContext(StatusCtx);
  if (!v) throw new Error('useStatus outside Layout');
  return v;
}

export const WORKER_TONE: Record<WorkerState | 'offline', 'ok' | 'warn' | 'danger' | 'neutral'> = {
  connected: 'ok', awaiting_qr: 'warn', starting: 'warn', reconnecting: 'warn', auth_failed: 'danger', failed: 'danger',
  stopping: 'neutral', stopped: 'danger', unknown: 'neutral', offline: 'danger',
};

export function workerTone(w: Overview['worker'] | undefined) {
  if (!w) return 'neutral' as const;
  return w.online ? WORKER_TONE[w.state] : WORKER_TONE.offline;
}

const NAV: { path: string; icon: IconName; label: Parameters<ReturnType<typeof useI18n>['t']>[0] }[] = [
  { path: '/', icon: 'overview', label: 'nav.overview' },
  { path: '/groups', icon: 'users', label: 'nav.groups' },
  { path: '/moderation', icon: 'shield', label: 'nav.moderation' },
  { path: '/members', icon: 'user', label: 'nav.members' },
  { path: '/logs', icon: 'list', label: 'nav.logs' },
  { path: '/connection', icon: 'plug', label: 'nav.connection' },
  { path: '/system', icon: 'server', label: 'nav.system' },
];

export function SafetyBand() {
  const { t } = useI18n();
  const { data, error } = useStatus();
  if (!data) {
    return error ? (
      <div role="alert" className="bg-danger px-4 py-1.5 text-center text-sm font-medium text-danger-ink">{t('band.unreachable')}</div>
    ) : null;
  }
  if (data.testMode) {
    return (
      <div className="tape" role="status" data-testid="safety-band" data-mode="test">
        <div className="flex justify-center py-1">
          <span className="rounded-sm bg-caution px-3 py-0.5 text-center text-sm font-semibold text-caution-ink">{t('band.test')}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="bg-danger px-4 py-1.5 text-center text-sm font-semibold text-danger-ink" role="status" data-testid="safety-band" data-mode="live">
      {t('band.live')}
    </div>
  );
}

function WorkerChip() {
  const { t } = useI18n();
  const { data } = useStatus();
  const tone = workerTone(data?.worker);
  const label = !data ? t('common.loading') : data.worker.online ? t(`worker.${data.worker.state}` as never) : t('worker.offline');
  return (
    <a href={href('/connection')} className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm hover:bg-sunken" title={t('nav.connection')}>
      <StatusDot tone={tone} pulse={tone === 'ok'} />
      <span className="min-w-0 truncate"><span className="text-muted">{t('worker.label')}: </span>{label}</span>
    </a>
  );
}

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  const { user, logout } = useAuth();
  const route = useRoute();
  const active = (p: string) => (p === '/' ? route.path === '/' : route.path === p || route.path.startsWith(`${p}/`));
  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="px-1 py-1"><Brand /></div>
      <nav aria-label={t('nav.label')} className="grid gap-0.5">
        {NAV.map((n) => (
          <a
            key={n.path} href={href(n.path)} onClick={onNavigate} aria-current={active(n.path) ? 'page' : undefined}
            className={cn('flex items-center gap-3 rounded-md px-3 py-2 text-[15px] transition-colors', active(n.path) ? 'bg-primary-soft font-medium text-primary' : 'text-ink hover:bg-sunken')}
          >
            <Icon name={n.icon} />{t(n.label)}
          </a>
        ))}
      </nav>
      <div className="mt-auto grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
        <WorkerChip />
        <PrefButtons />
        <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium" dir="ltr">{user.username}</div>
            <Badge tone={user.role === 'admin' ? 'info' : 'neutral'}>{t(user.role === 'admin' ? 'role.admin' : 'role.viewer')}</Badge>
          </div>
          <Button size="icon" variant="ghost" aria-label={t('auth.signOut')} title={t('auth.signOut')} onClick={() => void logout()}><Icon name="logout" /></Button>
        </div>
      </div>
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { t, dir } = useI18n();
  const status = useQuery<Overview>('overview', api.overview, { interval: 5000 });
  const [open, setOpen] = useState(false);
  const route = useRoute();
  useEffect(() => setOpen(false), [route.path]);
  useEffect(() => {
    if (!open) return undefined;
    const on = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, [open]);

  return (
    <StatusCtx.Provider value={status}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:start-2 focus:top-2 focus:z-[70] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-ink">{t('common.skip')}</a>
      <div className="sticky top-0 z-30"><SafetyBand /></div>
      <div className="mx-auto flex min-h-[calc(100dvh-28px)] max-w-[1500px]">
        <aside className="sticky top-7 hidden h-[calc(100dvh-28px)] w-64 shrink-0 overflow-y-auto border-e border-line lg:block"><SidebarBody /></aside>
        <div className="min-w-0 flex-1">
          <div className="sticky top-7 z-20 flex items-center justify-between border-b border-line bg-canvas/95 px-4 py-2 backdrop-blur lg:hidden">
            <Brand />
            <Button size="icon" variant="ghost" aria-label={t('nav.open')} aria-expanded={open} onClick={() => setOpen(true)}><Icon name="menu" /></Button>
          </div>
          <main id="main" tabIndex={-1} className="px-4 py-6 outline-none sm:px-8 sm:py-8">{children}</main>
        </div>
      </div>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-ink/50" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="drawer-in absolute inset-y-0 start-0 w-72 max-w-[85vw] overflow-y-auto border-e border-line bg-canvas shadow-2xl" style={{ ['--dir' as never]: dir === 'rtl' ? -1 : 1 }}>
            <div className="flex justify-end px-2 pt-2"><Button size="icon" variant="ghost" aria-label={t('common.close')} onClick={() => setOpen(false)}><Icon name="x" /></Button></div>
            <SidebarBody onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}
    </StatusCtx.Provider>
  );
}
export { ApiFailure };
