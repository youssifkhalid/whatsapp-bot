/**
 * UI kit. shadcn/ui-style components (same cva + clsx + tailwind-merge recipe, same ergonomics) written by hand because the
 * shadcn CLI and Radix primitives cannot be installed offline. Dialog/Switch/Tabs implement the needed ARIA behaviour
 * directly. On a networked machine they can be swapped for `npx shadcn add ...` output without touching the pages,
 * as long as the exported names here are kept.
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './lib/utils.ts';
import { useI18n } from './lib/i18n.tsx';

// ------------------------------------------------------------------ icons
const ICONS = {
  overview: 'M4 4h7v9H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 15h7v5H4z',
  users: 'M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M6 8a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0-7 0M21 20v-1a4 4 0 0 0-3-3.9M15 4.3a3.5 3.5 0 0 1 0 6.9',
  user: 'M8 8a4 4 0 1 0 8 0 4 4 0 1 0-8 0M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1',
  shield: 'M12 3 4 6v6c0 4.5 3.2 7.8 8 9 4.8-1.2 8-4.5 8-9V6l-8-3z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0V8zM12 18v4',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  sun: 'M8 12a4 4 0 1 0 8 0 4 4 0 1 0-8 0M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  globe: 'M3 12a9 9 0 1 0 18 0 9 9 0 1 0-18 0M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z',
  logout: 'M9 21H5V3h4M16 17l5-5-5-5M21 12H9',
  menu: 'M4 6h16M4 12h16M4 18h16',
  x: 'M6 6l12 12M18 6 6 18',
  check: 'm5 12 5 5 9-10',
  alert: 'M12 3 2 20h20L12 3zM12 10v4M12 17h.01',
  info: 'M3 12a9 9 0 1 0 18 0 9 9 0 1 0-18 0M12 11v5M12 8h.01',
  download: 'M12 3v12m0 0-4-4m4 4 4-4M4 20h16',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  refresh: 'M20 11a8 8 0 0 0-14.5-3.5L4 9M4 4v5h5M4 13a8 8 0 0 0 14.5 3.5L20 15M20 20v-5h-5',
  right: 'm9 6 6 6-6 6',
  left: 'm15 6-6 6 6 6',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  search: 'M4 11a7 7 0 1 0 14 0 7 7 0 1 0-14 0M21 21l-4.3-4.3',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
} as const;
export type IconName = keyof typeof ICONS;
const FLIPS_IN_RTL = new Set<IconName>(['right', 'left', 'logout']);

export function Icon({ name, className, size = 18 }: { name: IconName; className?: string; size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true" className={cn('shrink-0', FLIPS_IN_RTL.has(name) && 'rtl:-scale-x-100', className)}
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

// ------------------------------------------------------------------ primitives
const buttonStyles = cva(
  'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-ink hover:brightness-110',
        secondary: 'border border-line-strong bg-surface text-ink hover:bg-sunken',
        ghost: 'text-ink hover:bg-sunken',
        danger: 'bg-danger text-danger-ink hover:brightness-110',
        outlineDanger: 'border border-danger/60 text-danger-text hover:bg-danger-soft',
      },
      size: { sm: 'h-8 px-3 text-sm', md: 'h-10 px-4 text-[15px]', icon: 'h-9 w-9' },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export function Button({
  variant, size, className, busy, children, type = 'button', ...rest
}: VariantProps<typeof buttonStyles> & { className?: string; busy?: boolean; children?: ReactNode; type?: string; [k: string]: any }) {
  return (
    <button type={type} className={cn(buttonStyles({ variant, size }), className)} {...rest} disabled={rest['disabled'] || busy} aria-busy={busy || undefined}>
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('h-4 w-4 animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

const fieldBase =
  'w-full rounded-md border border-line-strong bg-surface px-3 text-ink placeholder:text-muted/70 transition-colors focus-visible:border-primary disabled:opacity-60';
export const Input = ({ className, ...p }: { className?: string; [k: string]: any }) => <input className={cn(fieldBase, 'h-10', className)} {...p} />;
export const Select = ({ className, children, ...p }: { className?: string; children?: ReactNode; [k: string]: any }) => (
  <select className={cn(fieldBase, 'h-10 pe-8', className)} {...p}>{children}</select>
);
export const Textarea = ({ className, ...p }: { className?: string; [k: string]: any }) => <textarea className={cn(fieldBase, 'min-h-24 py-2', className)} {...p} />;

export function Field({ label, hint, error, children, className }: { label: string; hint?: string; error?: string | undefined; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={cn('grid gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {children(id)}
      {error ? <p role="alert" className="text-sm text-danger-text">{error}</p> : hint ? <p className="text-sm text-muted">{hint}</p> : null}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled, busy }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; busy?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled || busy} onClick={() => onChange(!checked)}
      className={cn('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50', checked ? 'border-primary bg-primary' : 'border-line-strong bg-sunken')}
    >
      <span className={cn('inline-block h-4 w-4 rounded-full bg-white shadow transition-transform', 'ms-1', checked ? 'translate-x-5 rtl:-translate-x-5' : 'translate-x-0')} />
    </button>
  );
}

type Tone = 'ok' | 'warn' | 'danger' | 'neutral' | 'info';
const toneStyles: Record<Tone, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-caution-soft text-caution-text',
  danger: 'bg-danger-soft text-danger-text',
  neutral: 'bg-sunken text-muted',
  info: 'bg-primary-soft text-primary',
};
export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children?: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-2 py-0.5 text-xs font-medium', toneStyles[tone], className)}>{children}</span>;
}

const dotTone: Record<Tone, string> = { ok: 'text-ok bg-ok', warn: 'text-caution bg-caution', danger: 'text-danger bg-danger', neutral: 'text-muted bg-muted', info: 'text-primary bg-primary' };
export function StatusDot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return <span aria-hidden="true" className={cn('inline-block h-2.5 w-2.5 rounded-full', dotTone[tone], pulse && 'pulse')} />;
}

/** Identifiers (phone ids, domains) are always left-to-right, even inside Arabic text. */
export function Ltr({ children, className }: { children?: ReactNode; className?: string }) {
  return <bdi dir="ltr" className={cn('font-mono text-[0.88em] [unicode-bidi:isolate]', className)}>{children}</bdi>;
}

// ------------------------------------------------------------------ layout pieces
export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-[65ch] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Panel({ title, description, actions, children, className, flush }: { title?: string; description?: string; actions?: ReactNode; children?: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={cn('rounded-lg border border-line bg-surface', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 max-w-[70ch] text-sm text-muted">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={flush ? '' : 'p-4 sm:p-5'}>{children}</div>
    </section>
  );
}

export function Figure({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'caution' }) {
  return (
    <div className="min-w-0 px-4 py-4 sm:px-5">
      <div className="text-sm text-muted">{label}</div>
      <div className={cn('figure mt-1 text-4xl font-semibold leading-none', tone === 'caution' && 'text-caution-text')}>{value}</div>
      {hint && <div className="mt-2 text-sm text-muted">{hint}</div>}
    </div>
  );
}

export function EmptyState({ icon = 'info', title, text, action }: { icon?: IconName; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <span className="grid h-11 w-11 place-items-center rounded-full bg-sunken text-muted"><Icon name={icon} size={22} /></span>
      <p className="font-medium">{title}</p>
      {text && <p className="max-w-[48ch] text-sm text-muted">{text}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <div role="alert" className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <span className="grid h-11 w-11 place-items-center rounded-full bg-danger-soft text-danger-text"><Icon name="alert" size={22} /></span>
      <p className="font-medium">{t('common.loadFailed')}</p>
      <p className="max-w-[60ch] text-sm text-muted">{message}</p>
      {onRetry && <Button size="sm" className="mt-2" onClick={onRetry}><Icon name="refresh" size={16} />{t('common.retry')}</Button>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton h-4', className)} aria-hidden="true" />;
}

export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="grid gap-3 p-5" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="grid gap-4" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {Array.from({ length: cols }, (_, j) => <Skeleton key={j} className={j === 0 ? 'h-5' : 'h-5 w-2/3'} />)}
        </div>
      ))}
    </div>
  );
}

export const tableClass = 'w-full text-start text-sm';
export const thClass = 'whitespace-nowrap border-b border-line bg-sunken/60 px-4 py-2.5 text-start text-xs font-semibold text-muted first:ps-5 last:pe-5';
export const tdClass = 'border-b border-line px-4 py-3 align-middle first:ps-5 last:pe-5';
export const trClass = 'last:[&>td]:border-b-0';

export function Pagination({ page, pages, total, onPage, label }: { page: number; pages: number; total: number; onPage: (p: number) => void; label: string }) {
  const { t, number } = useI18n();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm sm:px-5">
      <span className="text-muted">{label.replace('{n}', number(total))}</span>
      <div className="flex items-center gap-2">
        <span className="tnum text-muted">{t('common.pageOf', { page: number(page), pages: number(pages) })}</span>
        <Button size="icon" aria-label={t('common.prev')} disabled={page <= 1} onClick={() => onPage(page - 1)}><Icon name="left" /></Button>
        <Button size="icon" aria-label={t('common.next')} disabled={page >= pages} onClick={() => onPage(page + 1)}><Icon name="right" /></Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ dialog
export function Dialog({ open, onClose, title, description, children, footer, busy, wide }: {
  open: boolean; onClose: () => void; title: string; description?: string; children?: ReactNode; footer?: ReactNode; busy?: boolean; wide?: boolean;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
      if (e.key === 'Tab' && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        const list = Array.from(f).filter((el) => !el.hasAttribute('disabled'));
        const first = list[0];
        const last = list[list.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === ref.current) { e.preventDefault(); last.focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', key);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [open, busy, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-ink/50 backdrop-blur-[1px]" onClick={() => !busy && onClose()} aria-hidden="true" />
      <div
        ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className={cn('dialog-in relative z-10 max-h-[90dvh] w-full overflow-y-auto rounded-lg border border-line bg-surface shadow-2xl outline-none', wide ? 'max-w-2xl' : 'max-w-md')}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
            {description && <p className="mt-1 text-sm text-muted">{description}</p>}
          </div>
          <Button size="icon" variant="ghost" aria-label={t('common.close')} onClick={onClose} disabled={busy}><Icon name="x" /></Button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ toasts
interface ToastItem { id: number; tone: 'ok' | 'danger' | 'info'; text: string }
const ToastCtx = createContext<{ toast: (tone: ToastItem['tone'], text: string) => void } | null>(null);

export function ToastProvider({ children }: { children?: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const toast = useCallback((tone: ToastItem['tone'], text: string) => {
    const id = next.current++;
    setItems((l) => [...l.slice(-3), { id, tone, text }]);
    setTimeout(() => setItems((l) => l.filter((x) => x.id !== id)), tone === 'danger' ? 7000 : 4000);
  }, []);
  const value = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4" role="status" aria-live="polite">
        {items.map((i) => (
          <div key={i.id} className={cn('dialog-in pointer-events-auto flex max-w-lg items-start gap-2 rounded-md border px-4 py-2.5 text-sm shadow-lg', i.tone === 'danger' ? 'border-danger/50 bg-danger-soft text-danger-text' : i.tone === 'ok' ? 'border-ok/40 bg-ok-soft text-ok' : 'border-line bg-surface')}>
            <Icon name={i.tone === 'danger' ? 'alert' : i.tone === 'ok' ? 'check' : 'info'} size={16} className="mt-0.5" />
            <span>{i.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export function useToast() {
  const v = useContext(ToastCtx);
  if (!v) throw new Error('useToast outside ToastProvider');
  return v.toast;
}

/** Runs an async action with a busy flag, success toast and localised error toast. */
export function useAction() {
  const toast = useToast();
  const { errorText } = useI18n();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (success) toast('ok', success);
      return r;
    } catch (e) {
      toast('danger', errorText(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast, errorText]);
  return { run, busy };
}

// ------------------------------------------------------------------ tabs, tags
export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: string }[] }) {
  return (
    <div role="tablist" className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
      {items.map((it) => (
        <button
          key={it.id} role="tab" aria-selected={value === it.id} type="button" onClick={() => onChange(it.id)}
          className={cn('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors', value === it.id ? 'border-primary text-ink' : 'border-transparent text-muted hover:text-ink')}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function TagInput({ values, onChange, placeholder, label, ltr, disabled, validate }: {
  values: string[]; onChange: (v: string[]) => void; placeholder: string; label: string; ltr?: boolean; disabled?: boolean; validate?: (v: string) => string | null;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const add = () => {
    const parts = draft.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return;
    for (const p of parts) {
      const problem = validate?.(p) ?? null;
      if (problem) { setErr(problem); return; }
    }
    setErr(null);
    onChange([...values, ...parts.filter((p) => !values.includes(p))]);
    setDraft('');
  };
  return (
    <div className="grid gap-2">
      <div className="flex gap-2">
        <Input
          aria-label={label} value={draft} placeholder={placeholder} disabled={disabled} dir={ltr ? 'ltr' : undefined} className={cn(ltr && 'font-mono text-sm')}
          onChange={(e: any) => { setDraft(e.target.value); setErr(null); }}
          onKeyDown={(e: any) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }}
        />
        <Button onClick={add} disabled={disabled || !draft.trim()}><Icon name="plus" size={16} />{t('common.add')}</Button>
      </div>
      {err && <p role="alert" className="text-sm text-danger-text">{err}</p>}
      {values.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {values.map((v) => (
            <li key={v} className="inline-flex items-center gap-1 rounded-sm border border-line-strong bg-sunken ps-2 pe-0.5 text-sm">
              {ltr ? <Ltr>{v}</Ltr> : <span>{v}</span>}
              <button type="button" disabled={disabled} aria-label={`${t('common.remove')} ${v}`} onClick={() => onChange(values.filter((x) => x !== v))} className="grid h-6 w-6 place-items-center rounded-sm text-muted hover:bg-line hover:text-ink disabled:opacity-50"><Icon name="x" size={14} /></button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{t('common.none')}</p>
      )}
    </div>
  );
}
