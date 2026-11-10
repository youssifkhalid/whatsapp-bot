import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiFailure, setCsrf, setUnauthenticatedHandler } from './lib/api.ts';
import { useI18n } from './lib/i18n.tsx';
import { useTheme } from './lib/theme.tsx';
import type { User } from './lib/types.ts';
import { Button, Field, Icon, Input, Spinner, useToast } from './ui.tsx';

interface AuthCtx { user: User; isAdmin: boolean; logout: () => Promise<void> }
const Ctx = createContext<AuthCtx | null>(null);
export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthGate');
  return v;
}

type Phase = { kind: 'loading' } | { kind: 'anon'; needsSetup: boolean; setupEnabled: boolean } | { kind: 'authed'; user: User } | { kind: 'down'; message: string };

export function AuthGate({ children }: { children: ReactNode }) {
  const { t, errorText } = useI18n();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  const boot = useCallback(async () => {
    setPhase({ kind: 'loading' });
    try {
      const me = await api.me();
      setCsrf(me.csrfToken);
      setPhase({ kind: 'authed', user: me.user });
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) {
        try {
          const s = await api.setupStatus();
          setPhase({ kind: 'anon', needsSetup: s.needsSetup, setupEnabled: s.setupEnabled });
        } catch (e2) {
          setPhase({ kind: 'down', message: errorText(e2) });
        }
      } else setPhase({ kind: 'down', message: errorText(e) });
    }
  }, [errorText]);

  useEffect(() => { void boot(); }, [boot]);

  useEffect(() => {
    setUnauthenticatedHandler(() => {
      setCsrf('');
      setPhase((p) => {
        if (p.kind === 'authed') toast('info', t('auth.sessionExpired'));
        return p.kind === 'authed' ? { kind: 'anon', needsSetup: false, setupEnabled: false } : p;
      });
    });
  }, [t, toast]);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* session may already be gone; either way we return to the login screen */ }
    setCsrf('');
    setPhase({ kind: 'anon', needsSetup: false, setupEnabled: false });
  }, []);

  const value = useMemo(
    () => (phase.kind === 'authed' ? { user: phase.user, isAdmin: phase.user.role === 'admin', logout } : null),
    [phase, logout],
  );

  if (phase.kind === 'loading') return <div className="grid min-h-dvh place-items-center text-muted"><Spinner className="h-6 w-6" /></div>;
  if (phase.kind === 'down') {
    return (
      <AuthFrame>
        <div role="alert" className="grid gap-3">
          <h1 className="text-xl font-semibold">{t('auth.apiDown')}</h1>
          <p className="text-muted">{phase.message}</p>
          <Button variant="primary" onClick={() => void boot()}><Icon name="refresh" size={16} />{t('common.retry')}</Button>
        </div>
      </AuthFrame>
    );
  }
  if (phase.kind === 'anon') return <LoginScreen needsSetup={phase.needsSetup} setupEnabled={phase.setupEnabled} onDone={boot} />;
  return <Ctx.Provider value={value as AuthCtx}>{children}</Ctx.Provider>;
}

function Brand() {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid h-9 w-9 place-items-center rounded-md bg-primary text-primary-ink"><Icon name="shield" size={20} /></span>
      <span className="text-lg font-semibold tracking-tight">{t('brand')}</span>
    </div>
  );
}
export { Brand };

export function PrefButtons() {
  const { lang, setLang, t } = useI18n();
  const { dark, setPref } = useTheme();
  return (
    <div className="flex items-center gap-1">
      <Button size="sm" variant="ghost" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')} aria-label={t('prefs.language')}>
        <Icon name="globe" size={16} />{lang === 'ar' ? 'English' : 'العربية'}
      </Button>
      <Button size="icon" variant="ghost" onClick={() => setPref(dark ? 'light' : 'dark')} aria-label={dark ? t('prefs.light') : t('prefs.dark')}>
        <Icon name={dark ? 'sun' : 'moon'} />
      </Button>
    </div>
  );
}

function AuthFrame({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <aside className="relative hidden flex-col justify-between border-e border-line bg-sunken p-10 lg:flex">
        <Brand />
        <div className="max-w-[44ch]">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">{t('auth.headline')}</h2>
          <p className="mt-4 text-muted">{t('auth.subhead')}</p>
          <div className="tape mt-8 h-3 w-40 rounded-sm" aria-hidden="true" />
          <p className="mt-3 text-sm text-muted">{t('auth.testModeNote')}</p>
        </div>
        <span className="text-sm text-muted">{t('auth.footer')}</span>
      </aside>
      <main className="flex flex-col p-5 sm:p-10">
        <div className="flex items-center justify-between lg:justify-end">
          <div className="lg:hidden"><Brand /></div>
          <PrefButtons />
        </div>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10">{children}</div>
      </main>
    </div>
  );
}

function LoginScreen({ needsSetup, setupEnabled, onDone }: { needsSetup: boolean; setupEnabled: boolean; onDone: () => Promise<void> }) {
  const { t, errorText } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setup = needsSetup && setupEnabled;

  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (setup) await api.setup({ username: username.trim(), password, setupToken: token });
      const s = await api.login({ username: username.trim(), password });
      setCsrf(s.csrfToken);
      await onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <AuthFrame>
      <h1 className="text-2xl font-semibold tracking-tight">{setup ? t('auth.setupTitle') : t('auth.loginTitle')}</h1>
      <p className="mb-6 mt-1 text-muted">{setup ? t('auth.setupText') : t('auth.loginText')}</p>
      {needsSetup && !setupEnabled ? (
        <div className="rounded-md border border-caution/60 bg-caution-soft p-4 text-sm text-caution-text" role="status">
          <p className="font-medium">{t('auth.noAdminTitle')}</p>
          <p className="mt-1">{t('auth.noAdminText')}</p>
          <code dir="ltr" className="mt-2 block rounded-sm bg-surface px-2 py-1.5 font-mono text-xs text-ink">npm run create-admin</code>
        </div>
      ) : (
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <Field label={t('auth.username')}>
            {(id) => <Input id={id} value={username} autoComplete="username" autoCapitalize="none" spellCheck={false} dir="ltr" required onChange={(e: any) => setUsername(e.target.value)} />}
          </Field>
          <Field label={t('auth.password')} hint={setup ? t('auth.passwordHint') : undefined}>
            {(id) => <Input id={id} type="password" value={password} autoComplete={setup ? 'new-password' : 'current-password'} dir="ltr" required onChange={(e: any) => setPassword(e.target.value)} />}
          </Field>
          {setup && (
            <Field label={t('auth.setupToken')} hint={t('auth.setupTokenHint')}>
              {(id) => <Input id={id} type="password" value={token} autoComplete="off" dir="ltr" required onChange={(e: any) => setToken(e.target.value)} />}
            </Field>
          )}
          {error && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{error}</p>}
          <Button type="submit" variant="primary" busy={busy} disabled={!username || !password || (setup && !token)}>
            {setup ? t('auth.createAdmin') : t('auth.signIn')}
          </Button>
        </form>
      )}
    </AuthFrame>
  );
}
