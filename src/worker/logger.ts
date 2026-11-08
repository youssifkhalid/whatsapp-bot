export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE = /pass(word)?|token|secret|cookie|authorization|session|csrf|qr|api[-_]?key/i;

/** Recursively replace values of sensitive keys. Depth-limited and cycle-safe. */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value === null || typeof value !== 'object') return value;
  if (depth > 5 || seen.has(value)) return '[truncated]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1, seen);
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(opts: { level?: Level; write?: (line: string) => void; base?: Record<string, unknown>; now?: () => number } = {}): Logger {
  const min = ORDER[opts.level ?? 'info'];
  const write = opts.write ?? ((l: string) => process.stdout.write(`${l}\n`));
  const now = opts.now ?? Date.now;
  const base = opts.base ?? {};
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    write(JSON.stringify({ time: new Date(now()).toISOString(), level, msg, ...(redact({ ...base, ...fields }) as object) }));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (f) => createLogger({ ...opts, base: { ...base, ...f } }),
  };
}
