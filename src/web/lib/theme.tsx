import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { safeStorage } from './utils.ts';

export type ThemePref = 'light' | 'dark' | 'system';
interface ThemeCtx { pref: ThemePref; dark: boolean; setPref: (p: ThemePref) => void }
const Ctx = createContext<ThemeCtx | null>(null);

const systemDark = () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(() => {
    const v = safeStorage().get('guardian.theme');
    return v === 'light' || v === 'dark' ? v : 'system';
  });
  const [sys, setSys] = useState(systemDark);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSys(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const dark = pref === 'dark' || (pref === 'system' && sys);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  const setPref = useCallback((p: ThemePref) => {
    safeStorage().set('guardian.theme', p);
    setPrefState(p);
  }, []);

  const value = useMemo(() => ({ pref, dark, setPref }), [pref, dark, setPref]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme outside ThemeProvider');
  return v;
}
