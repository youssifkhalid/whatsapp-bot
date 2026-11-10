import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api.ts';
import { useI18n } from '../lib/i18n.tsx';
import { useQuery } from '../lib/query.ts';
import { href } from '../lib/router.ts';
import type { GroupConfig } from '../lib/types.ts';
import { useAuth } from '../auth.tsx';
import {
  Badge, Button, EmptyState, ErrorState, Field, Icon, Input, Ltr, PageHeader, Panel, Switch, TableSkeleton, TagInput, tableClass, tdClass, thClass, trClass, useAction,
} from '../ui.tsx';
import { groupHref } from './shared.tsx';

export const DOMAIN_RE = /^(\*\.)?[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i;
export const MEMBER_ID_RE = /^[\w.:+-]{1,64}@[\w.]{1,32}$/;

export function Groups() {
  const { t, number } = useI18n();
  const { isAdmin } = useAuth();
  const q = useQuery('groups', api.groups, { interval: 15000 });
  const { run } = useAction();
  const [pending, setPending] = useState<string | null>(null);

  const toggle = async (id: string, enabled: boolean) => {
    setPending(id);
    await run(() => api.patchGroup(id, { enabled }), enabled ? t('groups.enabledToast') : t('groups.disabledToast'));
    await q.refetch();
    setPending(null);
  };

  return (
    <>
      <PageHeader title={t('groups.title')} description={t('groups.subtitle')} />
      {!isAdmin && <p className="mb-4 rounded-md bg-sunken px-3 py-2 text-sm text-muted">{t('common.readOnly')}</p>}
      <Panel flush>
        {q.loading ? <TableSkeleton cols={5} /> : q.error && !q.data ? <ErrorState message={q.error.message} onRetry={() => void q.refetch()} /> : q.data && q.data.groups.length === 0 ? (
          <EmptyState icon="users" title={t('groups.empty')} text={t('groups.emptyText')} action={<a href={href('/connection')}><Button variant="primary">{t('nav.connection')}</Button></a>} />
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead><tr>
                <th className={thClass}>{t('groups.group')}</th>
                <th className={thClass}>{t('groups.moderation')}</th>
                <th className={thClass}>{t('groups.rules')}</th>
                <th className={thClass}>{t('groups.excluded')}</th>
                <th className={thClass}>{t('groups.violations')}</th>
              </tr></thead>
              <tbody>
                {q.data?.groups.map((g) => (
                  <tr key={g.groupId} className={`${trClass} hover:bg-sunken/50`}>
                    <td className={tdClass}>
                      <a href={groupHref(g.groupId)} className="font-medium text-primary hover:underline">{g.name || t('groups.unnamed')}</a>
                      <div className="mt-0.5"><Ltr className="text-muted">{g.groupId}</Ltr></div>
                    </td>
                    <td className={tdClass}>
                      <div className="flex items-center gap-2">
                        <Switch checked={g.enabled} label={`${t('groups.moderation')}: ${g.name || g.groupId}`} disabled={!isAdmin} busy={pending === g.groupId} onChange={(v) => void toggle(g.groupId, v)} />
                        <span className="text-muted">{g.enabled ? t('common.on') : t('common.off')}</span>
                      </div>
                    </td>
                    <td className={tdClass}>
                      <div className="flex flex-wrap gap-1.5">
                        <Badge tone={g.links.enabled ? 'info' : 'neutral'}>{t('groups.links')}</Badge>
                        <Badge tone={g.profanity.enabled ? 'info' : 'neutral'}>{t('groups.profanity')}</Badge>
                      </div>
                    </td>
                    <td className={`${tdClass} tnum`}>{number(g.excludedMembers.length)}</td>
                    <td className={`${tdClass} tnum`}>{number(g.violations)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

function Row({ title, text, control }: { title: string; text?: string; control: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line py-3 first:pt-0 last:border-b-0 last:pb-0">
      <div className="min-w-0"><p className="font-medium">{title}</p>{text && <p className="mt-0.5 max-w-[60ch] text-sm text-muted">{text}</p>}</div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  );
}

type Draft = Pick<GroupConfig, 'enabled' | 'notifyGroup' | 'links' | 'profanity'>;
const pick = (g: GroupConfig): Draft => ({ enabled: g.enabled, notifyGroup: g.notifyGroup, links: g.links, profanity: g.profanity });

export function GroupDetail({ id }: { id: string }) {
  const { t, errorText } = useI18n();
  const { isAdmin } = useAuth();
  const q = useQuery(`group:${id}`, () => api.group(id));
  const save = useAction();
  const exclusions = useAction();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newMember, setNewMember] = useState('');
  const [memberError, setMemberError] = useState<string | null>(null);
  const server = q.data?.group;

  useEffect(() => { if (server) setDraft((d) => d ?? pick(server)); }, [server]);
  useEffect(() => { setDraft(null); }, [id]);

  if (q.error && !server) {
    return (
      <>
        <BackLink />
        <Panel>{q.error.status === 404 ? <EmptyState icon="alert" title={t('groups.notFound')} /> : <ErrorState message={errorText(q.error)} onRetry={() => void q.refetch()} />}</Panel>
      </>
    );
  }
  if (!server || !draft) return <><BackLink /><Panel flush><TableSkeleton rows={6} cols={2} /></Panel></>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(pick(server));
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const ro = !isAdmin;

  const onSave = async () => {
    const res = await save.run(() => api.patchGroup(id, draft), t('common.saved'));
    if (res) { setDraft(pick(res.group)); await q.refetch(); }
  };

  const addMember = async () => {
    const v = newMember.trim().toLowerCase();
    if (!MEMBER_ID_RE.test(v)) { setMemberError(t('groups.memberInvalid')); return; }
    setMemberError(null);
    const res = await exclusions.run(() => api.addExclusion(id, v), t('groups.exclusionAdded'));
    if (res) { setNewMember(''); await q.refetch(); }
  };
  const removeMember = async (m: string) => {
    const res = await exclusions.run(() => api.removeExclusion(id, m), t('groups.exclusionRemoved'));
    if (res) await q.refetch();
  };

  return (
    <>
      <BackLink />
      <PageHeader title={server.name || t('groups.unnamed')} description={undefined} actions={<Ltr className="text-muted">{server.groupId}</Ltr>} />
      {ro && <p className="mb-4 rounded-md bg-sunken px-3 py-2 text-sm text-muted">{t('common.readOnly')}</p>}
      <div className="grid gap-6">
        <Panel title={t('groupDetail.general')}>
          <Row title={t('groupDetail.enabled')} text={t('groupDetail.enabledText')} control={<Switch checked={draft.enabled} label={t('groupDetail.enabled')} disabled={ro} onChange={(v) => set({ enabled: v })} />} />
          <Row title={t('groupDetail.notify')} text={t('groupDetail.notifyText')} control={<Switch checked={draft.notifyGroup} label={t('groupDetail.notify')} disabled={ro} onChange={(v) => set({ notifyGroup: v })} />} />
        </Panel>

        <Panel title={t('groupDetail.linksTitle')} description={t('groupDetail.linksText')}>
          <Row title={t('groupDetail.linksOn')} control={<Switch checked={draft.links.enabled} label={t('groupDetail.linksOn')} disabled={ro} onChange={(v) => set({ links: { ...draft.links, enabled: v } })} />} />
          <Row title={t('groupDetail.bare')} text={t('groupDetail.bareText')} control={<Switch checked={draft.links.detectBareDomains} label={t('groupDetail.bare')} disabled={ro} onChange={(v) => set({ links: { ...draft.links, detectBareDomains: v } })} />} />
          <div className="mt-4">
            <Field label={t('groupDetail.allowed')} hint={t('groupDetail.allowedHint')}>
              {() => <TagInput ltr values={draft.links.allowedDomains} label={t('groupDetail.allowed')} placeholder="school.edu" disabled={ro}
                validate={(v) => (DOMAIN_RE.test(v) ? null : t('groupDetail.domainInvalid'))} onChange={(v) => set({ links: { ...draft.links, allowedDomains: v } })} />}
            </Field>
          </div>
        </Panel>

        <Panel title={t('groupDetail.profanityTitle')} description={t('groupDetail.profanityText')}>
          <Row title={t('groupDetail.profanityOn')} control={<Switch checked={draft.profanity.enabled} label={t('groupDetail.profanityOn')} disabled={ro} onChange={(v) => set({ profanity: { ...draft.profanity, enabled: v } })} />} />
          <div className="mt-4 grid gap-5 lg:grid-cols-2">
            <Field label={t('groupDetail.custom')} hint={t('groupDetail.customHint')}>
              {() => <TagInput values={draft.profanity.customWords} label={t('groupDetail.custom')} placeholder={t('groupDetail.wordPlaceholder')} disabled={ro}
                validate={(v) => (v.length <= 64 ? null : t('groupDetail.wordInvalid'))} onChange={(v) => set({ profanity: { ...draft.profanity, customWords: v } })} />}
            </Field>
            <Field label={t('groupDetail.safe')} hint={t('groupDetail.safeHint')}>
              {() => <TagInput values={draft.profanity.allowWords} label={t('groupDetail.safe')} placeholder={t('groupDetail.wordPlaceholder')} disabled={ro}
                validate={(v) => (v.length <= 64 ? null : t('groupDetail.wordInvalid'))} onChange={(v) => set({ profanity: { ...draft.profanity, allowWords: v } })} />}
            </Field>
          </div>
        </Panel>

        <Panel title={t('groupDetail.exclusionsTitle')} description={t('groupDetail.exclusionsText')}>
          {!ro && (
            <form className="mb-4 flex flex-wrap items-start gap-2" onSubmit={(e: any) => { e.preventDefault(); void addMember(); }}>
              <div className="min-w-[16rem] flex-1">
                <Input aria-label={t('groupDetail.memberId')} dir="ltr" className="font-mono text-sm" placeholder="201000000000@c.us" value={newMember} onChange={(e: any) => { setNewMember(e.target.value); setMemberError(null); }} />
                {memberError && <p role="alert" className="mt-1.5 text-sm text-danger-text">{memberError}</p>}
              </div>
              <Button type="submit" busy={exclusions.busy} disabled={!newMember.trim()}><Icon name="plus" size={16} />{t('groupDetail.exclude')}</Button>
            </form>
          )}
          {server.excludedMembers.length === 0 ? <p className="text-sm text-muted">{t('groupDetail.noExclusions')}</p> : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {server.excludedMembers.map((m) => (
                <li key={m} className="flex items-center justify-between gap-3 px-3 py-2">
                  <Ltr>{m}</Ltr>
                  {!ro && <Button size="sm" variant="outlineDanger" disabled={exclusions.busy} onClick={() => void removeMember(m)} aria-label={`${t('common.remove')} ${m}`}><Icon name="trash" size={14} />{t('common.remove')}</Button>}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {!ro && (
        <div className={`sticky bottom-0 -mx-4 mt-6 flex items-center justify-between gap-3 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur transition-opacity sm:-mx-8 sm:px-8 ${dirty ? 'opacity-100' : 'pointer-events-none opacity-0'}`} aria-hidden={!dirty}>
          <span className="text-sm text-muted">{t('groupDetail.unsaved')}</span>
          <div className="flex gap-2">
            <Button onClick={() => setDraft(pick(server))} disabled={save.busy}>{t('common.discard')}</Button>
            <Button variant="primary" busy={save.busy} onClick={() => void onSave()}>{t('common.save')}</Button>
          </div>
        </div>
      )}
    </>
  );
}

function BackLink() {
  const { t } = useI18n();
  return <a href={href('/groups')} className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink"><Icon name="left" size={16} />{t('groupDetail.back')}</a>;
}
