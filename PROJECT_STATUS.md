# PROJECT_STATUS

Last updated: 2026-11-08 (after phases 2a-2c and 3)

## Environment constraint (still in force)

The build sandbox has no access to the npm registry. Everything below marked **VERIFIED** was typechecked
(`tsc --noEmit`, strict) and tested here with Node 22 built-ins. Anything marked **UNVERIFIED** needs a machine with
npm access and, for WhatsApp, a dedicated test number.

## Verified: 99 tests passing, typecheck clean, ~98% line coverage

| Area | Files | Tests |
|---|---|---|
| Moderation engine (unchanged since phase 1) | `src/core/*` | 41 |
| SQLite store, migrations, repositories | `src/storage/*` | 13 |
| Authentication | `src/auth/*` | 9 |
| Worker runtime, health, logger, backoff | `src/worker/*` | 16 |
| whatsapp-web.js adapter (against a mock client) | `src/whatsapp/wwebjs-adapter.ts` | 20 |

- Storage uses a thin `Db` interface. `openDatabase` currently wraps `node:sqlite`; `better-sqlite3` exposes the same
  `prepare().run/get/all` and `exec()` shape, so switching the driver is a change in `openDatabase` only (UNVERIFIED).
- New groups are discovered with moderation **disabled**; test mode defaults to **on**.
- Admin verification reads participant metadata and **fails closed** (throws -> `skipped_check_failed`) when metadata is
  missing, the sender is not found (e.g. `@lid` vs `@c.us`), or the admin flag is absent. The adapter additionally refuses
  to remove any administrator or member of unknown role, and only the bot being an admin allows delete/remove.
- Member removal is reported successful only after membership is re-read and the member is gone.
- Worker: reconnect with exponential backoff and jitter, retry budget (default 10) then exit non-zero, no retry after auth
  failure, ordered per-group processing, graceful drain on shutdown, `/healthz` (liveness) and `/readyz` (connected).

## NOT done

1. **Express REST API** (Zod validation, cookie sessions, CSRF, rate limiting, helmet-style headers, RBAC routes). The
   service layer it will call (`AuthService`, repositories) is done and tested; the HTTP layer is not written.
2. **React + Tailwind + shadcn/ui dashboard** (RTL/EN, dark/light). Not started.
3. **Production**: Dockerfile, Compose, Nginx, `.env.example`, backup/restore scripts, DEPLOYMENT.md. Not started.
4. Docs: README, API_DOCUMENTATION, SECURITY, DEPLOYMENT, DEVELOPMENT, TROUBLESHOOTING. Only ARCHITECTURE.md exists.
5. Switch `openDatabase` to `better-sqlite3` and run the suite against it.

## WhatsApp integration status: NOT COMPLETE

- `wwebjs-adapter.ts` logic is mock-tested only. `wwebjs-factory.ts` and `worker/main.ts` have **never been run** because
  `whatsapp-web.js` is not installed here.
- Assumptions taken from memory of the library, to be confirmed on a real account:
  - `chat.participants[].isAdmin/isSuperAdmin` are populated for groups and use the same id format as `message.author`.
  - `message.delete(true)` revokes for everyone and resolves on success. It returns no receipt, so "deleted" currently
    means "the call resolved". Revocation is **not independently confirmed**.
  - `chat.removeParticipants` result shape (map of id to `{code,message}`) varies by version; membership re-read is the
    authoritative check, and a stale re-read would be reported as a failure (conservative).
  - `message.author` is the sender in groups; media captions arrive in `message.body`.
- Required before calling this complete: run against a dedicated number and a disposable group, with test mode on first,
  then off for one throwaway account, covering: admin skip, link delete+remove, profanity, reconnect after network drop,
  session survives restart, QR re-pair.

## Known limitations

- Masked words (`f*ck`), spaced-dot obfuscation, glued Arabic slurs are not detected (see ARCHITECTURE.md).
- The pairing QR payload is held in `worker_status` while awaiting a scan. The API must expose it only to authenticated
  admins and never log it (the logger redacts `qr`).
- `login_attempts` throttling is per username; the API layer still needs per-IP rate limiting.

## Next execution steps (on a machine with npm)

1. `npm i express zod better-sqlite3 whatsapp-web.js` plus dev types; swap the SQLite driver; rerun all 99 tests.
2. Build `src/api/` (Express) over the existing services, with supertest integration tests.
3. Dashboard, Docker/Compose/Nginx, backups, docs.
4. WhatsApp test-number validation as described above.
