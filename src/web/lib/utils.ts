import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export function safeStorage(): { get(k: string): string | null; set(k: string, v: string): void } {
  return {
    get: (k) => {
      try { return localStorage.getItem(k); } catch { return null; }
    },
    set: (k, v) => {
      try { localStorage.setItem(k, v); } catch { /* storage unavailable (private mode); preference just won't persist */ }
    },
  };
}

export function formatBytes(n: number | null | undefined, locale: string): string {
  if (n === null || n === undefined) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: v >= 100 || i === 0 ? 0 : 1 }).format(v)} ${units[i]}`;
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** ISO date (yyyy-mm-dd) `n` days before today, in UTC to match the API's daily buckets. */
export function utcDaysAgo(n: number, from = Date.now()): string {
  return new Date(from - n * 86_400_000).toISOString().slice(0, 10);
}

/** Fill gaps so a chart always shows `days` consecutive daily buckets. */
export function fillDaily(daily: { day: string; count: number }[], days: number, now = Date.now()): { day: string; count: number }[] {
  const map = new Map(daily.map((d) => [d.day, d.count]));
  return Array.from({ length: days }, (_, i) => {
    const day = utcDaysAgo(days - 1 - i, now);
    return { day, count: map.get(day) ?? 0 };
  });
}

/** Local calendar date boundaries -> epoch ms strings for the API's from/to filters. */
export function dayStart(date: string): string | undefined {
  const t = Date.parse(`${date}T00:00:00`);
  return Number.isFinite(t) ? String(t) : undefined;
}
export function dayEnd(date: string): string | undefined {
  const t = Date.parse(`${date}T23:59:59.999`);
  return Number.isFinite(t) ? String(t) : undefined;
}
