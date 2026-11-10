import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { en, type Key } from '../i18n/en.ts';
import { ar } from '../i18n/ar.ts';
import { ApiFailure } from './api.ts';
import { formatBytes, safeStorage } from './utils.ts';

export type Lang = 'en' | 'ar';
const dictionaries: Record<Lang, Record<Key, string>> = { en, ar };

export interface I18n {
  lang: Lang;
  dir: 'ltr' | 'rtl';
  setLang: (l: Lang) => void;
  t: (key: Key, vars?: Record<string, string | number>) => string;
  number: (n: number) => string;
  date: (ms: number) => string;
  time: (ms: number) => string;
  relative: (ms: number) => string;
  bytes: (n: number | null | undefined) => string;
  duration: (ms: number) => string;
  /** Localised message for an API failure, by error code when we have a translation. */
  errorText: (e: unknown) => string;
}

const Ctx = createContext<I18n | null>(null);

function initialLang(): Lang {
  const l = document.documentElement.lang;
  return l === 'ar' ? 'ar' : 'en';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const locale = lang === 'ar' ? 'ar-u-nu-latn' : 'en';

  const setLang = useCallback((l: Lang) => {
    document.documentElement.lang = l;
    document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
    safeStorage().set('guardian.lang', l);
    setLangState(l);
  }, []);

  const value = useMemo<I18n>(() => {
    const dict = dictionaries[lang];
    const t: I18n['t'] = (key, vars) => {
      let s = dict[key] ?? en[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
      return s;
    };
    const nf = new Intl.NumberFormat(locale);
    const df = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
    const tf = new Intl.DateTimeFormat(locale, { timeStyle: 'medium' });
    const rf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    const relative = (ms: number) => {
      const diff = (ms - Date.now()) / 1000;
      const abs = Math.abs(diff);
      if (abs < 45) return rf.format(Math.round(diff), 'second');
      if (abs < 45 * 60) return rf.format(Math.round(diff / 60), 'minute');
      if (abs < 22 * 3600) return rf.format(Math.round(diff / 3600), 'hour');
      return rf.format(Math.round(diff / 86400), 'day');
    };
    const duration = (ms: number) => {
      const s = Math.floor(ms / 1000);
      const d = Math.floor(s / 86400);
      const h = Math.floor((s % 86400) / 3600);
      const m = Math.floor((s % 3600) / 60);
      if (d > 0) return t('time.dh', { d, h });
      if (h > 0) return t('time.hm', { h, m });
      return t('time.ms', { m, s: s % 60 });
    };
    const errorText = (e: unknown) => {
      if (e instanceof ApiFailure) {
        const k = `err.${e.code}` as Key;
        if (k in en) return t(k);
        if (e.code === 'validation_error' && e.issues.length > 0) return `${t('err.validation_error')} ${e.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`;
        return e.message;
      }
      return e instanceof Error ? e.message : String(e);
    };
    return {
      lang, dir: lang === 'ar' ? 'rtl' : 'ltr', setLang, t, number: (n) => nf.format(n), date: (ms) => df.format(ms), time: (ms) => tf.format(ms),
      relative, bytes: (n) => formatBytes(n, locale), duration, errorText,
    };
  }, [lang, locale, setLang]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n outside I18nProvider');
  return v;
}
