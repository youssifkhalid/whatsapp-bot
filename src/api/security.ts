export const SESSION_COOKIE = 'guardian_session';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

export function sessionCookie(token: string, maxAgeSec: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export const clearSessionCookie = (secure: boolean): string => sessionCookie('', 0, secure);

export function securityHeaders(secure: boolean): Record<string, string> {
  return {
    'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
      "font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    ...(secure ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

/** Client IP. Forwarded headers are honoured only when a trusted reverse proxy is configured. */
export function clientIp(headers: Record<string, string | undefined>, remote: string, trustProxy: boolean): string {
  if (trustProxy) {
    const real = headers['x-real-ip']?.trim();
    if (real) return real;
    const xff = headers['x-forwarded-for'];
    if (xff) {
      const last = xff.split(',').map((s) => s.trim()).filter(Boolean).pop();
      if (last) return last;
    }
  }
  return remote;
}

/**
 * Browsers always send Origin on cross-site unsafe requests. If present it must match the
 * configured origins, or (when none are configured) the Host header. Absent Origin = non-browser client.
 */
export function originAllowed(headers: Record<string, string | undefined>, allowed: string[]): boolean {
  const origin = headers['origin'];
  if (!origin) return true;
  if (allowed.length > 0) return allowed.includes(origin);
  try {
    return new URL(origin).host === headers['host'];
  } catch {
    return false;
  }
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Records a hit and reports whether it is within `limit` per `windowMs`. */
  hit(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterSec: number } {
    const t = this.now();
    const fresh = (this.hits.get(key) ?? []).filter((x) => x > t - windowMs);
    if (fresh.length >= limit) {
      this.hits.set(key, fresh);
      const oldest = fresh[0] ?? t;
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - t) / 1000)) };
    }
    fresh.push(t);
    this.hits.set(key, fresh);
    if (this.hits.size > 10_000) this.sweep(windowMs);
    return { allowed: true, retryAfterSec: 0 };
  }

  private sweep(windowMs: number): void {
    const cutoff = this.now() - windowMs;
    for (const [k, v] of this.hits) if (!v.some((x) => x > cutoff)) this.hits.delete(k);
  }
}
