# WhatsApp Group Guardian

Moderates WhatsApp groups: detects **links** and **profanity** (Arabic and English), deletes the offending message and
removes the sender. Group admins/owners, the bot itself and excluded members are never touched. A dashboard (English and
Arabic RTL, light/dark) manages groups, rules, exclusions, logs, statistics and CSV export.

> **Status: WhatsApp integration is NOT verified.** It uses the unofficial `whatsapp-web.js`, has been tested only against
> mocks, and must be validated with a dedicated test number and a disposable group before any real use. See
> `PROJECT_STATUS.md`. Unofficial automation can get a WhatsApp number banned: never use a personal number.

## Safety defaults

- **Test mode is ON** on every fresh install: violations are recorded as simulated; nothing is deleted or removed.
- Newly discovered groups start with moderation **disabled**.
- Admin check **fails closed**: if admin status cannot be verified, nothing is done.
- An action is recorded as done only if the WhatsApp integration confirmed it. Failures are logged with their reason.
- Message text is never stored, only the matched domain/word.

## Components

| Process | Entry | Role |
|---|---|---|
| API + dashboard | `src/api/main.ts` | REST API, sessions, serves the built dashboard |
| Worker | `src/worker/main.ts` | Holds the WhatsApp session, runs the moderation engine |
| SQLite | `data/guardian.db` | Shared state; the API and worker never call each other |

Details: `ARCHITECTURE.md`. API reference: `API_DOCUMENTATION.md`. Security: `SECURITY.md`.

## Quick start (development, needs Node >= 22.13 and npm access)

```bash
npm install
npm test && npm run typecheck
npm run build:web
GUARDIAN_PASSWORD='a long password' npm run create-admin -- admin
COOKIE_SECURE=false npm run start:api      # http://127.0.0.1:8080
npm run start:worker                       # separate terminal; scan the QR in Dashboard > WhatsApp connection
```

Production on an Ubuntu VPS: `DEPLOYMENT.md`.
