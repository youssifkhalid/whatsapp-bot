import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { useI18n } from '../lib/i18n.tsx';
import type { Key } from '../i18n/en.ts';
import { useQuery } from '../lib/query.ts';
import { dayEnd, dayStart, pageCount } from '../lib/utils.ts';
import type { EventFilters, EventRow } from '../lib/types.ts';
import { Button, EmptyState, ErrorState, Icon, Input, Ltr, PageHeader, Panel, Pagination, Select, TableSkeleton } from '../ui.tsx';
import { EventDetail, EventsTable, useGroupNames } from './shared.tsx';

const PAGE_SIZE = 25;
const STATUSES = ['completed', 'partial', 'failed', 'simulated', 'skipped_protected', 'skipped_check_failed', 'duplicate'] as const;

export function Logs({ params }: { params: Record<string, string> }) {
  const { t, number } = useI18n();
  const names = useGroupNames();
  const groups = useQuery('groups:logs', api.groups);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [groupId, setGroupId] = useState(params['groupId'] ?? '');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [senderId, setSenderId] = useState(params['senderId'] ?? '');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<EventRow | null>(null);

  useEffect(() => { setSenderId(params['senderId'] ?? ''); setGroupId(params['groupId'] ?? ''); setPage(1); }, [params['senderId'], params['groupId']]);
  useEffect(() => {
    const h = setTimeout(() => { setDebounced(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(h);
  }, [search]);

  const filters: EventFilters = {
    ...(debounced ? { q: debounced } : {}), ...(groupId ? { groupId } : {}), ...(type ? { type } : {}), ...(status ? { status } : {}), ...(senderId ? { senderId } : {}),
    ...(from && dayStart(from) ? { from: dayStart(from) as string } : {}), ...(to && dayEnd(to) ? { to: dayEnd(to) as string } : {}),
  };
  const key = JSON.stringify([filters, page]);
  const q = useQuery(`events:${key}`, () => api.events(filters, page, PAGE_SIZE), { interval: 10000 });
  const pages = pageCount(q.data?.total ?? 0, PAGE_SIZE);
  const active = Object.keys(filters).length > 0;
  const reset = () => { setSearch(''); setDebounced(''); setGroupId(''); setType(''); setStatus(''); setFrom(''); setTo(''); setSenderId(''); setPage(1); };
  const onFilter = <T,>(set: (v: T) => void) => (e: any) => { set(e.target.value as T); setPage(1); };

  return (
    <>
      <PageHeader title={t('logs.title')} description={t('logs.subtitle')} actions={
        <a href={api.exportUrl(filters)} download className="inline-flex h-10 items-center gap-2 rounded-md border border-line-strong bg-surface px-4 text-[15px] font-medium hover:bg-sunken" data-testid="export-csv">
          <Icon name="download" size={16} />{t('logs.export')}
        </a>
      } />
      <Panel flush>
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-6">
          <div className="relative sm:col-span-2">
            <Icon name="search" size={16} className="pointer-events-none absolute start-3 top-3 text-muted" />
            <Input aria-label={t('logs.search')} placeholder={t('logs.searchPlaceholder')} className="ps-9" value={search} onChange={(e: any) => setSearch(e.target.value)} />
          </div>
          <Select aria-label={t('events.group')} value={groupId} onChange={onFilter(setGroupId)}>
            <option value="">{t('logs.allGroups')}</option>
            {(groups.data?.groups ?? []).map((g) => <option key={g.groupId} value={g.groupId}>{g.name || g.groupId}</option>)}
          </Select>
          <Select aria-label={t('events.violation')} value={type} onChange={onFilter(setType)}>
            <option value="">{t('logs.allTypes')}</option>
            <option value="link">{t('type.link')}</option>
            <option value="profanity">{t('type.profanity')}</option>
          </Select>
          <Select aria-label={t('events.result')} value={status} onChange={onFilter(setStatus)}>
            <option value="">{t('logs.allStatuses')}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}` as Key)}</option>)}
          </Select>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
            <label className="grid flex-1 gap-1 text-xs text-muted">{t('logs.from')}<Input type="date" value={from} onChange={onFilter(setFrom)} /></label>
            <label className="grid flex-1 gap-1 text-xs text-muted">{t('logs.to')}<Input type="date" value={to} onChange={onFilter(setTo)} /></label>
          </div>
          <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-3">
            {senderId && <span className="inline-flex h-10 items-center gap-2 rounded-md bg-primary-soft px-3 text-sm text-primary">{t('events.member')}: <Ltr>{senderId}</Ltr></span>}
            {active && <Button onClick={reset}>{t('logs.clear')}</Button>}
          </div>
        </div>

        {q.loading ? <TableSkeleton cols={5} rows={8} /> : q.error && !q.data ? <ErrorState message={q.error.message} onRetry={() => void q.refetch()} /> : q.data && q.data.events.length === 0 ? (
          <EmptyState icon="list" title={active ? t('logs.noMatches') : t('logs.empty')} text={active ? t('logs.noMatchesText') : t('logs.emptyText')} action={active ? <Button onClick={reset}>{t('logs.clear')}</Button> : undefined} />
        ) : q.data ? (
          <>
            <EventsTable events={q.data.events} names={names} onSelect={setSelected} />
            <Pagination page={page} pages={pages} total={q.data.total} onPage={setPage} label={t('logs.total', { n: '{n}' })} />
          </>
        ) : null}
      </Panel>
      <p className="mt-3 text-sm text-muted">{t('logs.exportNote', { n: number(500) })}</p>
      <EventDetail event={selected} names={names} onClose={() => setSelected(null)} />
    </>
  );
}
