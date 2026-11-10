import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { useI18n } from '../lib/i18n.tsx';
import { useQuery } from '../lib/query.ts';
import { useAuth } from '../auth.tsx';
import { useStatus } from '../layout.tsx';
import {
  Badge, Button, ErrorState, Icon, Ltr, PageHeader, Panel, TableSkeleton, TagInput, tableClass, tdClass, thClass, trClass, useAction,
} from '../ui.tsx';
import { ConfirmDialog, groupHref } from './shared.tsx';
import { MEMBER_ID_RE } from './groups.tsx';

export function Moderation() {
  const { t } = useI18n();
  const { isAdmin } = useAuth();
  const status = useStatus();
  const settings = useQuery('settings', api.settings, { interval: 15000 });
  const groups = useQuery('groups:mod', api.groups, { interval: 15000 });
  const action = useAction();
  const owners = useAction();
  const [confirm, setConfirm] = useState(false);
  const [ownerDraft, setOwnerDraft] = useState<string[] | null>(null);
  const s = settings.data;

  useEffect(() => { if (s) setOwnerDraft((d) => d ?? s.ownerIds); }, [s]);

  const refresh = async () => { await Promise.all([settings.refetch(), status.refetch()]); };
  const setTestMode = async (on: boolean) => {
    const res = await action.run(() => api.patchSettings(on ? { testMode: true } : { testMode: false, confirmDisableTestMode: true }), on ? t('moderation.testOnToast') : t('moderation.testOffToast'));
    if (res) { setConfirm(false); await refresh(); }
  };
  const saveOwners = async () => {
    if (!ownerDraft) return;
    const res = await owners.run(() => api.patchSettings({ ownerIds: ownerDraft }), t('common.saved'));
    if (res) { setOwnerDraft(res.ownerIds); await settings.refetch(); }
  };

  const ownersDirty = !!s && !!ownerDraft && JSON.stringify([...ownerDraft].sort()) !== JSON.stringify([...s.ownerIds].sort());
  const policies: [string, string][] = [
    [t('policy.links'), t('policy.linksText')],
    [t('policy.profanity'), t('policy.profanityText')],
    [t('policy.admins'), t('policy.adminsText')],
    [t('policy.bot'), t('policy.botText')],
    [t('policy.owners'), t('policy.ownersText')],
    [t('policy.exclusions'), t('policy.exclusionsText')],
    [t('policy.confirm'), t('policy.confirmText')],
  ];

  return (
    <>
      <PageHeader title={t('moderation.title')} description={t('moderation.subtitle')} />
      {!isAdmin && <p className="mb-4 rounded-md bg-sunken px-3 py-2 text-sm text-muted">{t('common.readOnly')}</p>}
      <div className="grid gap-6">
        <Panel title={t('moderation.testTitle')} description={t('moderation.testText')}>
          {settings.error && !s ? <ErrorState message={settings.error.message} onRetry={() => void settings.refetch()} /> : !s ? <TableSkeleton rows={2} cols={2} /> : (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <span className={`grid h-10 w-10 place-items-center rounded-md ${s.testMode ? 'bg-caution-soft text-caution-text' : 'bg-danger-soft text-danger-text'}`}><Icon name={s.testMode ? 'shield' : 'alert'} /></span>
                <div>
                  <p className="font-semibold" data-testid="mode-label">{s.testMode ? t('moderation.testIsOn') : t('moderation.testIsOff')}</p>
                  <p className="text-sm text-muted">{s.testMode ? t('moderation.testOnDesc') : t('moderation.testOffDesc')}</p>
                </div>
              </div>
              {isAdmin && (s.testMode
                ? <Button variant="danger" onClick={() => setConfirm(true)}>{t('moderation.turnOffTest')}</Button>
                : <Button variant="primary" busy={action.busy} onClick={() => void setTestMode(true)}>{t('moderation.turnOnTest')}</Button>)}
            </div>
          )}
        </Panel>

        <Panel title={t('moderation.policyTitle')} description={t('moderation.policyText')}>
          <dl className="grid gap-x-8 gap-y-4 md:grid-cols-2">
            {policies.map(([k, v]) => (
              <div key={k}><dt className="font-medium">{k}</dt><dd className="mt-0.5 text-sm text-muted">{v}</dd></div>
            ))}
          </dl>
        </Panel>

        <Panel title={t('moderation.ownersTitle')} description={t('moderation.ownersText')}>
          {!s || !ownerDraft ? <TableSkeleton rows={2} cols={2} /> : (
            <div className="grid gap-4">
              <TagInput ltr values={ownerDraft} label={t('moderation.ownersTitle')} placeholder="201000000000@c.us" disabled={!isAdmin}
                validate={(v) => (MEMBER_ID_RE.test(v.toLowerCase()) ? null : t('groups.memberInvalid'))} onChange={setOwnerDraft} />
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3 text-sm">
                <span className="text-muted">{t('moderation.botId')}: {s.botId ? <Ltr>{s.botId}</Ltr> : t('moderation.botUnknown')}</span>
                {isAdmin && <Button variant="primary" disabled={!ownersDirty} busy={owners.busy} onClick={() => void saveOwners()}>{t('common.save')}</Button>}
              </div>
            </div>
          )}
        </Panel>

        <Panel title={t('moderation.groupsTitle')} description={t('moderation.groupsText')} flush>
          {groups.loading ? <TableSkeleton cols={4} /> : groups.error && !groups.data ? <ErrorState message={groups.error.message} onRetry={() => void groups.refetch()} /> : groups.data && groups.data.groups.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted">{t('groups.emptyText')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead><tr>
                  <th className={thClass}>{t('groups.group')}</th><th className={thClass}>{t('groups.moderation')}</th>
                  <th className={thClass}>{t('groups.links')}</th><th className={thClass}>{t('groups.profanity')}</th><th className={thClass}><span className="sr-only">{t('events.details')}</span></th>
                </tr></thead>
                <tbody>
                  {groups.data?.groups.map((g) => (
                    <tr key={g.groupId} className={trClass}>
                      <td className={tdClass}>{g.name || <Ltr>{g.groupId}</Ltr>}</td>
                      <td className={tdClass}><Badge tone={g.enabled ? 'ok' : 'neutral'}>{g.enabled ? t('common.on') : t('common.off')}</Badge></td>
                      <td className={tdClass}><Badge tone={g.links.enabled ? 'info' : 'neutral'}>{g.links.enabled ? t('common.on') : t('common.off')}</Badge></td>
                      <td className={tdClass}><Badge tone={g.profanity.enabled ? 'info' : 'neutral'}>{g.profanity.enabled ? t('common.on') : t('common.off')}</Badge></td>
                      <td className={`${tdClass} text-end`}><a className="text-primary hover:underline" href={groupHref(g.groupId)}>{t('moderation.editRules')}</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
      <ConfirmDialog open={confirm} danger busy={action.busy} title={t('moderation.confirmTitle')} text={t('moderation.confirmText')} confirmLabel={t('moderation.turnOffTest')} onConfirm={() => void setTestMode(false)} onClose={() => setConfirm(false)} />
    </>
  );
}
