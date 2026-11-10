import type { ReactNode } from 'react';
import { api } from '../lib/api.ts';
import { useI18n } from '../lib/i18n.tsx';
import type { Key } from '../i18n/en.ts';
import { useQuery } from '../lib/query.ts';
import { href } from '../lib/router.ts';
import type { EventRow, EventStatus } from '../lib/types.ts';
import { Badge, Button, Dialog, Icon, Ltr, tableClass, tdClass, thClass, trClass } from '../ui.tsx';

export function useGroupNames(): Map<string, string> {
  const q = useQuery('groups:names', api.groups, { interval: 30000 });
  return new Map((q.data?.groups ?? []).map((g) => [g.groupId, g.name || g.groupId]));
}

const STATUS_TONE: Record<EventStatus, 'ok' | 'warn' | 'danger' | 'neutral' | 'info'> = {
  completed: 'ok', partial: 'warn', failed: 'danger', simulated: 'info', skipped_protected: 'neutral', skipped_check_failed: 'warn', duplicate: 'neutral',
};

export function StatusBadge({ status }: { status: EventStatus }) {
  const { t } = useI18n();
  return <Badge tone={STATUS_TONE[status]}>{t(`status.${status}` as Key)}</Badge>;
}

export function TypeLabel({ ev }: { ev: EventRow }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2">
      <span className="font-medium">{t(`type.${ev.violation.type}` as Key)}</span>
      {ev.violation.category && ev.violation.category !== 'generic' && <span className="text-xs text-muted">{t(`category.${ev.violation.category}` as Key)}</span>}
    </span>
  );
}

export function EventsTable({ events, names, onSelect }: { events: EventRow[]; names: Map<string, string>; onSelect: (e: EventRow) => void }) {
  const { t, date, relative } = useI18n();
  return (
    <div className="overflow-x-auto">
      <table className={tableClass}>
        <thead>
          <tr>
            <th className={thClass}>{t('events.time')}</th>
            <th className={thClass}>{t('events.group')}</th>
            <th className={thClass}>{t('events.member')}</th>
            <th className={thClass}>{t('events.violation')}</th>
            <th className={thClass}>{t('events.result')}</th>
            <th className={thClass}><span className="sr-only">{t('events.details')}</span></th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id} className={`${trClass} hover:bg-sunken/50`}>
              <td className={`${tdClass} whitespace-nowrap`}><span title={date(e.at)}>{relative(e.at)}</span></td>
              <td className={`${tdClass} max-w-[14rem] truncate`}>{names.get(e.groupId) ?? <Ltr>{e.groupId}</Ltr>}</td>
              <td className={tdClass}><Ltr>{e.senderId.replace(/@.*/, '')}</Ltr></td>
              <td className={tdClass}><TypeLabel ev={e} /></td>
              <td className={tdClass}><StatusBadge status={e.status} /></td>
              <td className={`${tdClass} text-end`}>
                <Button size="sm" variant="ghost" onClick={() => onSelect(e)} aria-label={`${t('events.details')} #${e.id}`}>{t('events.details')}</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Yes({ v }: { v: boolean }) {
  const { t } = useI18n();
  return v ? <Badge tone="ok"><Icon name="check" size={12} />{t('common.yes')}</Badge> : <Badge>{t('common.no')}</Badge>;
}

export function EventDetail({ event, names, onClose }: { event: EventRow | null; names: Map<string, string>; onClose: () => void }) {
  const { t, date, time } = useI18n();
  if (!event) return null;
  const e = event;
  const rows: [string, ReactNode][] = [
    [t('events.time'), `${date(e.at)} (${time(e.at)})`],
    [t('events.group'), <span key="g">{names.get(e.groupId) ?? ''} <Ltr>{e.groupId}</Ltr></span>],
    [t('events.member'), <Ltr key="m">{e.senderId}</Ltr>],
    [t('events.messageId'), <Ltr key="id" className="break-all">{e.messageId}</Ltr>],
    [t('events.violation'), <TypeLabel key="v" ev={e} />],
    [e.violation.type === 'link' ? t('events.matchedHost') : t('events.matchedTerm'), <Ltr key="x">{e.violation.matched}</Ltr>],
    [t('events.result'), <StatusBadge key="s" status={e.status} />],
    [t('events.testMode'), <Yes key="t" v={e.testMode} />],
    [t('events.messageDeleted'), <Yes key="d" v={e.messageDeleted} />],
    [t('events.memberRemoved'), <Yes key="r" v={e.memberRemoved} />],
    [t('events.noticeSent'), <Yes key="n" v={e.noticeSent} />],
  ];
  return (
    <Dialog open onClose={onClose} title={`${t('events.event')} #${e.id}`} description={t(`status.${e.status}.help` as Key)} wide footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      <dl className="grid gap-x-6 gap-y-2.5 sm:grid-cols-[11rem_1fr]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-sm text-muted">{k}</dt>
            <dd className="min-w-0 text-sm">{v}</dd>
          </div>
        ))}
      </dl>
      {(e.detail || e.errors.length > 0) && (
        <div className="mt-4 rounded-md border border-caution/50 bg-caution-soft p-3 text-sm text-caution-text">
          <p className="font-medium">{t('events.problems')}</p>
          {e.errors.length > 0 ? <ul className="mt-1 list-disc ps-5">{e.errors.map((x) => <li key={x}>{x}</li>)}</ul> : <p className="mt-1">{e.detail}</p>}
        </div>
      )}
      <p className="mt-4 text-xs text-muted">{t('events.privacy')}</p>
    </Dialog>
  );
}

export function ConfirmDialog({ open, title, text, confirmLabel, danger, busy, onConfirm, onClose }: {
  open: boolean; title: string; text: string; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      open={open} onClose={onClose} title={title} busy={busy}
      footer={<>
        <Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        <Button variant={danger ? 'danger' : 'primary'} busy={busy} onClick={onConfirm}>{confirmLabel}</Button>
      </>}
    >
      <p className="text-[15px]">{text}</p>
    </Dialog>
  );
}

export const groupHref = (id: string) => href(`/groups/${encodeURIComponent(id)}`);
