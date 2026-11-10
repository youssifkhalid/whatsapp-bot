import { useMemo } from 'react';
import { api } from '../lib/api.ts';
import { useI18n } from '../lib/i18n.tsx';
import type { Key } from '../i18n/en.ts';
import { useQuery } from '../lib/query.ts';
import { encodeQr, qrPath } from '../lib/qr.ts';
import { useAuth } from '../auth.tsx';
import { workerTone } from '../layout.tsx';
import {
  Badge, Button, EmptyState, ErrorState, Icon, PageHeader, Panel, Skeleton, StatusDot, TableSkeleton, tableClass, tdClass, thClass, trClass,
} from '../ui.tsx';

function Qr({ payload }: { payload: string }) {
  const { t } = useI18n();
  const out = useMemo(() => {
    try {
      const m = encodeQr(payload);
      return { ...qrPath(m), ok: true as const };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  }, [payload]);
  if (!out.ok) return <p role="alert" className="text-sm text-danger-text">{t('connection.qrFailed')}</p>;
  return (
    <svg viewBox={`0 0 ${out.viewBox} ${out.viewBox}`} role="img" aria-label={t('connection.qrLabel')} className="h-auto w-full max-w-[18rem] rounded-md bg-white" shapeRendering="crispEdges" data-testid="qr">
      <path d={out.d} fill="#000" />
    </svg>
  );
}

const KNOWN_KINDS = ['qr', 'ready', 'disconnected', 'auth_failure', 'gave_up'];
const KIND_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral' | 'info'> = {
  ready: 'ok', qr: 'info', disconnected: 'warn', auth_failure: 'danger', gave_up: 'danger',
};

export function Connection() {
  const { t, date, relative, duration, number, bytes } = useI18n();
  const { isAdmin } = useAuth();
  const q = useQuery('connection', api.connection, { interval: 3000 });
  const c = q.data;
  const w = c?.worker;
  const state = w ? (w.online ? w.state : 'offline') : null;
  const authProblem = w?.online && (w.state === 'auth_failed' || w.state === 'failed');

  return (
    <>
      <PageHeader title={t('connection.title')} description={t('connection.subtitle')} actions={<Button size="sm" busy={q.fetching && !!c} onClick={() => void q.refetch()}><Icon name="refresh" size={16} />{t('common.refresh')}</Button>} />
      {q.error && !c ? <Panel><ErrorState message={q.error.message} onRetry={() => void q.refetch()} /></Panel> : (
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <Panel title={t('connection.statusTitle')}>
            {!c || !w || !state ? <div className="grid gap-3"><Skeleton className="h-6 w-48" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div> : (
              <div className="grid gap-4">
                <div className="flex items-center gap-3">
                  <StatusDot tone={workerTone(w)} pulse={state === 'connected'} />
                  <span className="text-xl font-semibold" data-testid="connection-state">{t(`worker.${state}` as Key)}</span>
                </div>
                <p className="text-muted">{t(`connection.help.${state}` as Key)}</p>
                {authProblem && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{t('connection.authProblem')}</p>}
                <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 border-t border-line pt-4 text-sm">
                  <dt className="text-muted">{t('overview.heartbeat')}</dt>
                  <dd>{w.lastSeen ? <span title={date(w.lastSeen)}>{relative(w.lastSeen)}</span> : t('overview.never')}</dd>
                  {w.online && <>
                    <dt className="text-muted">{t('overview.uptime')}</dt><dd>{duration(w.info.uptimeMs ?? 0)}</dd>
                    <dt className="text-muted">{t('connection.attempts')}</dt><dd className="tnum">{number(w.info.reconnectAttempts ?? 0)}</dd>
                    <dt className="text-muted">{t('overview.handled')}</dt><dd className="tnum">{number(w.info.messagesHandled ?? 0)}</dd>
                    <dt className="text-muted">{t('connection.lastMessage')}</dt><dd>{w.info.lastMessageAt ? relative(w.info.lastMessageAt) : t('overview.never')}</dd>
                    <dt className="text-muted">{t('overview.memory')}</dt><dd className="tnum">{bytes(w.info.rssBytes)}</dd>
                  </>}
                </dl>
              </div>
            )}
          </Panel>

          <Panel title={t('connection.pairTitle')} description={t('connection.pairText')}>
            {!c ? <Skeleton className="h-64 w-full" /> : c.qr ? (
              <div className="grid justify-items-center gap-4">
                <Qr payload={c.qr} />
                <ol className="max-w-[44ch] list-decimal space-y-1 ps-5 text-sm text-muted">
                  <li>{t('connection.step1')}</li><li>{t('connection.step2')}</li><li>{t('connection.step3')}</li>
                </ol>
                <p className="text-xs text-muted">{t('connection.qrRefresh')}</p>
              </div>
            ) : w?.state === 'awaiting_qr' && w.online && !isAdmin ? (
              <EmptyState icon="lock" title={t('connection.adminOnlyTitle')} text={t('connection.adminOnlyText')} />
            ) : (
              <EmptyState icon="plug" title={w?.online && w.state === 'connected' ? t('connection.paired') : t('connection.noQr')} text={w?.online && w.state === 'connected' ? t('connection.pairedText') : t('connection.noQrText')} />
            )}
          </Panel>

          <Panel title={t('connection.historyTitle')} description={t('connection.historyText')} flush className="lg:col-span-2">
            {!c ? <TableSkeleton cols={3} /> : c.events.length === 0 ? <EmptyState icon="list" title={t('connection.noHistory')} /> : (
              <div className="overflow-x-auto">
                <table className={tableClass}>
                  <thead><tr><th className={thClass}>{t('events.time')}</th><th className={thClass}>{t('connection.event')}</th><th className={thClass}>{t('events.details')}</th></tr></thead>
                  <tbody>
                    {c.events.map((e, i) => (
                      <tr key={`${e.at}-${i}`} className={trClass}>
                        <td className={`${tdClass} whitespace-nowrap`}><span title={date(e.at)}>{relative(e.at)}</span></td>
                        <td className={tdClass}><Badge tone={KIND_TONE[e.kind] ?? 'neutral'}>{KNOWN_KINDS.includes(e.kind) ? t(`kind.${e.kind}` as Key) : e.kind}</Badge></td>
                        <td className={`${tdClass} text-muted`}>{e.detail ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}
