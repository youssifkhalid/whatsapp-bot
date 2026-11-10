import { useState } from 'react';
import { api } from '../lib/api.ts';
import { useI18n } from '../lib/i18n.tsx';
import { useQuery } from '../lib/query.ts';
import { href } from '../lib/router.ts';
import type { MemberRow } from '../lib/types.ts';
import { useAuth } from '../auth.tsx';
import {
  Badge, Button, Dialog, EmptyState, ErrorState, Icon, Ltr, PageHeader, Panel, Switch, TableSkeleton, tableClass, tdClass, thClass, trClass, useAction,
} from '../ui.tsx';
import { useGroupNames } from './shared.tsx';

const PAGE_SIZE = 25;

export function Members() {
  const { t, number, relative, date } = useI18n();
  const { isAdmin } = useAuth();
  const [page, setPage] = useState(1);
  const q = useQuery(`members:${page}`, () => api.members(page, PAGE_SIZE), { interval: 20000 });
  const groups = useQuery('groups:members', api.groups);
  const names = useGroupNames();
  const [managing, setManaging] = useState<MemberRow | null>(null);
  const action = useAction();

  const members = q.data?.members ?? [];
  const hasNext = members.length === PAGE_SIZE;
  const live = managing ? (members.find((m) => m.senderId === managing.senderId) ?? managing) : null;

  const toggle = async (groupId: string, on: boolean) => {
    if (!live) return;
    await action.run(() => (on ? api.addExclusion(groupId, live.senderId) : api.removeExclusion(groupId, live.senderId)), on ? t('groups.exclusionAdded') : t('groups.exclusionRemoved'));
    await Promise.all([q.refetch(), groups.refetch()]);
  };

  return (
    <>
      <PageHeader title={t('members.title')} description={t('members.subtitle')} />
      <Panel flush>
        {q.loading ? <TableSkeleton cols={5} /> : q.error && !q.data ? <ErrorState message={q.error.message} onRetry={() => void q.refetch()} /> : members.length === 0 && page === 1 ? (
          <EmptyState icon="user" title={t('members.empty')} text={t('members.emptyText')} />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead><tr>
                  <th className={thClass}>{t('events.member')}</th><th className={thClass}>{t('members.violations')}</th><th className={thClass}>{t('members.removed')}</th>
                  <th className={thClass}>{t('members.last')}</th><th className={thClass}>{t('members.excludedIn')}</th><th className={thClass}><span className="sr-only">{t('events.details')}</span></th>
                </tr></thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.senderId} className={`${trClass} hover:bg-sunken/50`}>
                      <td className={tdClass}><Ltr>{m.senderId}</Ltr></td>
                      <td className={`${tdClass} tnum`}>{number(m.violations)}</td>
                      <td className={`${tdClass} tnum`}>{number(m.removed)}</td>
                      <td className={`${tdClass} whitespace-nowrap`}><span title={date(m.lastAt)}>{relative(m.lastAt)}</span></td>
                      <td className={tdClass}>
                        {m.excludedIn.length === 0 ? <span className="text-muted">{t('common.none')}</span> : <div className="flex flex-wrap gap-1">{m.excludedIn.map((g) => <Badge key={g} tone="info">{names.get(g) ?? g}</Badge>)}</div>}
                      </td>
                      <td className={`${tdClass} whitespace-nowrap text-end`}>
                        <a href={href('/logs', { senderId: m.senderId })} className="me-3 text-primary hover:underline">{t('members.history')}</a>
                        {isAdmin && <Button size="sm" onClick={() => setManaging(m)}><Icon name="shield" size={14} />{t('members.manage')}</Button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3 text-sm">
              <span className="text-muted tnum">{t('common.page', { page: number(page) })}</span>
              <div className="flex gap-2">
                <Button size="icon" aria-label={t('common.prev')} disabled={page <= 1} onClick={() => setPage(page - 1)}><Icon name="left" /></Button>
                <Button size="icon" aria-label={t('common.next')} disabled={!hasNext} onClick={() => setPage(page + 1)}><Icon name="right" /></Button>
              </div>
            </div>
          </>
        )}
      </Panel>

      <Dialog open={!!live} onClose={() => setManaging(null)} busy={action.busy} title={t('members.manageTitle')} description={t('members.manageText')} footer={<Button onClick={() => setManaging(null)}>{t('common.close')}</Button>}>
        {live && (
          <div className="grid gap-3">
            <Ltr>{live.senderId}</Ltr>
            {(groups.data?.groups ?? []).length === 0 ? <p className="text-sm text-muted">{t('groups.emptyText')}</p> : (
              <ul className="divide-y divide-line rounded-md border border-line">
                {groups.data?.groups.map((g) => (
                  <li key={g.groupId} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <span className="min-w-0 truncate">{g.name || g.groupId}</span>
                    <div className="flex items-center gap-2 text-sm text-muted">
                      {live.excludedIn.includes(g.groupId) ? t('members.excludedState') : t('members.moderatedState')}
                      <Switch checked={live.excludedIn.includes(g.groupId)} label={`${t('members.excludedIn')}: ${g.name || g.groupId}`} busy={action.busy} onChange={(v) => void toggle(g.groupId, v)} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
