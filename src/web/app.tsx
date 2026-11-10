import { useI18n } from './lib/i18n.tsx';
import { href, useRoute } from './lib/router.ts';
import { Connection } from './pages/connection.tsx';
import { GroupDetail, Groups } from './pages/groups.tsx';
import { Logs } from './pages/logs.tsx';
import { Members } from './pages/members.tsx';
import { Moderation } from './pages/moderation.tsx';
import { Overview } from './pages/overview.tsx';
import { System } from './pages/system.tsx';
import { Button, EmptyState } from './ui.tsx';

export function App() {
  const route = useRoute();
  const { t } = useI18n();
  const p = route.path;
  if (p === '/') return <Overview />;
  if (p === '/groups') return <Groups />;
  if (p.startsWith('/groups/')) return <GroupDetail id={decodeURIComponent(p.slice('/groups/'.length))} />;
  if (p === '/moderation') return <Moderation />;
  if (p === '/members') return <Members />;
  if (p === '/logs') return <Logs params={route.params} />;
  if (p === '/connection') return <Connection />;
  if (p === '/system') return <System />;
  return (
    <EmptyState icon="alert" title={t('notFound.title')} text={t('notFound.text')} action={<a href={href('/')}><Button variant="primary">{t('nav.overview')}</Button></a>} />
  );
}
