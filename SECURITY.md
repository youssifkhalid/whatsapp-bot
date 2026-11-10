# Security

## Implemented and tested (API tests, real HTTP)
- scrypt password hashing; constant-ish timing for unknown users; per-username lockout and per-IP login rate limit.
- Cookie sessions: HttpOnly, SameSite=Strict, `Secure` in production; session revoked on logout and password change.
- CSRF: per-session token header on all state-changing requests, plus Origin checking.
- RBAC: `admin` vs `viewer` enforced server-side per route (viewers cannot read the QR, users or audit log).
- Strict Zod validation, body size limit, security headers and CSP (`script-src 'self'`), static path-traversal protection.
- Secret redaction in logs (`qr`, tokens, passwords). The message text is never persisted.
- Audit log for settings, group, user and backup changes. SQLite backups via `VACUUM INTO` (mode 600 via script).
- `TRUST_PROXY` must be `true` only behind Nginx; the proxy must overwrite `X-Forwarded-For`.

## Operational requirements
- Serve over HTTPS and keep `COOKIE_SECURE=true`. Remove `SETUP_TOKEN` after creating the admin.
- Never commit `.env`, `data/`, or the WhatsApp session directory (anyone with it controls the WhatsApp account).
- Use a dedicated WhatsApp number. The integration is unofficial and may violate WhatsApp's terms.

## Not verified
- The Express adapter (`src/api/express.ts`) and the Docker/Nginx files have not been run.
- No third-party security audit or dependency audit (`npm audit`) has been run (no registry access when written).
