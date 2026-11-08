export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  random?: () => number;
}

/** Exponential backoff with jitter (50-100% of the computed delay). attempt starts at 1. */
export function backoffDelay(attempt: number, o: BackoffOptions): number {
  const raw = Math.min(o.maxMs, o.baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = 0.5 + (o.random ?? Math.random)() * 0.5;
  return Math.round(raw * jitter);
}
