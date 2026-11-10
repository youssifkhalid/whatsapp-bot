import { useState } from 'react';
import { api } from '../lib/api.ts';
import { useI18n } from '../lib/i18n.tsx';
import { useQuery } from '../lib/query.ts';
import { href } from '../lib/router.ts';
import type { Key } from '../i18n/en.ts';
import { fillDaily } from '../lib/utils.ts';
import { workerTone, useStatus } from '../layout.tsx';
import { Badge, Button, EmptyState, ErrorState, Figure, Icon, PageHeader, Panel, Skeleton, StatusDot, TableSkeleton } from '../ui.tsx';
import { EventDetail, EventsTable, useGroupNames } from './shared.tsx';
import type { EventRow } from '../lib/types.ts';

function BarChart({ data }: { data: { day: string; count: number }[] }) {
  const { t, number } = useI18n();
  const max = Math.max(1, ...data.map((d) => d.count));
  const W = 560, H = 150, pad = 4;
  const bw = (W - pad * 2) / data.length;
  const total = data.reduce((a, d) => a + d.count, 0);
  const fmt = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H + 22}`} className="h-auto w-full" role="img" aria-label={t('overview.chartLabel', { n: number(total), days: number(data.length) })}>
        {[0.5, 1].map((f) => <line key={f} x1="0" x2={W} y1={H - H * f * 0.92} y2={H - H * f * 0.92} className="stroke-line" strokeWidth="1" strokeDasharray={f === 1 ? '0' : '3 4'} />)}
        {data.map((d, i) => {
          const h = d.count === 0 ? 2 : Math.max(4, (d.count / max) * H * 0.92);
          return (
            <g key={d.day}>
              <rect x={pad + i * bw + bw * 0.16} y={H - h} width={bw * 0.68} height={h} rx="2" className={d.count === 0 ? 'fill-line' : 'fill-primary'}>
                <title>{`${fmt(d.day)}: ${number(d.count)}`}</title>
              </rect>
            </g>
          );
        })}
        {[0, Math.floor((data.length - 1) / 2), data.length - 1].map((i) => (
          <text key={i} x={pad + i * bw + bw / 2} y={H + 16} textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'} className="fill-muted text-[11px]">{fmt((data[i] as { day: string }).day)}</text>
        ))}
        <text x={W} y="11" textAnchor="end" className="fill-muted text-[11px]">{number(max)}</text>
      </svg>
      {total === 0 && <p className="mt-1 text-center text-sm text-muted">{t('overview.chartEmpty')}</p>}
    </div>
  );
}

export function Overview() {
  const { t, number, relative, duration, bytes, date } = useI18n();
  const status = useStatus();
  const stats = useQuery('stats:14', () => api.stats(14), { interval: 30000 });
  const names = useGroupNames();
  const [selected, setSelected] = useState<EventRow | null>(null);
  const o = status.data;

  return (
    <>
      <PageHeader title={t('overview.title')} description={t('overview.subtitle')} actions={
        <Button size="sm" onClick={() => { void status.refetch(); void stats.refetch(); }} busy={status.fetching && !!o} aria-label={t('common.refresh')}><Icon name="refresh" size={16} />{t('common.refresh')}</Button>
      } />
      {status.error && !o ? (
        <Panel><ErrorState message={status.error.message} onRetry={() => void status.refetch()} /></Panel>
      ) : (
        <div className="grid gap-6">
          <Panel flush>
            <div className="grid grid-cols-2 divide-line max-lg:[&>*:nth-child(n+3)]:border-t max-lg:[&>*:nth-child(even)]:border-s lg:grid-cols-4 lg:divide-x">
              {!o ? Array.from({ length: 4 }, (_, i) => <div key={i} className="px-5 py-4"><Skeleton className="h-3 w-24" /><Skeleton className="mt-3 h-9 w-16" /></div>) : (<>
                <Figure label={t('overview.violations7')} value={number(o.stats.last7Days.violations)} hint={o.stats.allTime.simulated > 0 ? t('overview.simulatedHint', { n: number(o.stats.allTime.simulated) }) : t('overview.allTimeHint', { n: number(o.stats.allTime.violations) })} />
                <Figure label={t('overview.deleted7')} value={number(o.stats.last7Days.deletedMessages)} hint={o.testMode ? t('overview.testHint') : undefined} />
                <Figure label={t('overview.removed7')} value={number(o.stats.last7Days.removedMembers)} hint={o.testMode ? t('overview.testHint') : undefined} />
                <Figure label={t('overview.groups')} value={`${number(o.groups.enabled)} / ${number(o.groups.total)}`} hint={o.groups.total === 0 ? t('overview.noGroupsHint') : t('overview.groupsHint')} tone={o.groups.total > 0 && o.groups.enabled === 0 ? 'caution' : undefined} />
              </>)}
            </div>
          </Panel>

          <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
            <Panel title={t('overview.chartTitle')} description={t('overview.chartDesc')}>
              {stats.error && !stats.data ? <ErrorState message={stats.error.message} onRetry={() => void stats.refetch()} /> : !stats.data ? <Skeleton className="h-40 w-full" /> : <BarChart data={fillDaily(stats.data.daily, 14)} />}
            </Panel>

            <Panel title={t('overview.workerTitle')} actions={<a href={href('/connection')} className="text-sm text-primary hover:underline">{t('overview.openConnection')}</a>}>
              {!o ? <div className="grid gap-3"><Skeleton className="h-5 w-40" /><Skeleton className="h-5 w-56" /><Skeleton className="h-5 w-32" /></div> : (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-sm">
                  <dt className="text-muted">{t('worker.label')}</dt>
                  <dd className="flex items-center gap-2"><StatusDot tone={workerTone(o.worker)} pulse={o.worker.online && o.worker.state === 'connected'} />{o.worker.online ? t(`worker.${o.worker.state}` as Key) : t('worker.offline')}</dd>
                  <dt className="text-muted">{t('overview.heartbeat')}</dt>
                  <dd>{o.worker.lastSeen ? <span title={date(o.worker.lastSeen)}>{relative(o.worker.lastSeen)}</span> : t('overview.never')}</dd>
                  {o.worker.online && <>
                    <dt className="text-muted">{t('overview.uptime')}</dt><dd>{duration(o.worker.info.uptimeMs ?? 0)}</dd>
                    <dt className="text-muted">{t('overview.handled')}</dt><dd className="tnum">{number(o.worker.info.messagesHandled ?? 0)}</dd>
                    <dt className="text-muted">{t('overview.memory')}</dt><dd className="tnum">{bytes(o.worker.info.rssBytes)}</dd>
                  </>}
                  <dt className="text-muted">{t('overview.mode')}</dt>
                  <dd><Badge tone={o.testMode ? 'warn' : 'danger'}>{o.testMode ? t('mode.test') : t('mode.live')}</Badge></dd>
                </dl>
              )}
              {o && !o.worker.online && <p className="mt-4 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{t('overview.workerOffline')}</p>}
            </Panel>
          </div>

          <Panel title={t('overview.recent')} flush actions={<a href={href('/logs')} className="text-sm text-primary hover:underline">{t('overview.viewAll')}</a>}>
            {!o ? <TableSkeleton cols={5} /> : o.recent.length === 0 ? (
              <EmptyState icon="shield" title={t('overview.noEvents')} text={t('overview.noEventsText')} />
            ) : <EventsTable events={o.recent} names={names} onSelect={setSelected} />}
          </Panel>
        </div>
      )}
      <EventDetail event={selected} names={names} onClose={() => setSelected(null)} />
    </>
  );
}
