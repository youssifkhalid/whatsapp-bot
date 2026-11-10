# Architecture

## Processes

```
 Dashboard (React)  --HTTPS-->  Nginx  -->  API (Node, REST)  --->  SQLite/PostgreSQL
                                                                         ^
                                              WhatsApp Worker -----------+
                                              (separate process)
```

- **Worker** owns the WhatsApp session and the `Moderator`. It reads settings from the database and writes
  events to it. It does not depend on the API being up, so a dashboard or API failure cannot stop moderation.
- **API** serves the dashboard, manages settings and users, and reads events. It never touches WhatsApp credentials.
- Settings changes reach the worker through the database (polling / change counter), not through a live link.

## Core engine (implemented)

`src/core/` has no runtime dependencies and no knowledge of WhatsApp. Everything external goes through two
interfaces in `types.ts`:

- `WhatsAppPort`: `isGroupAdmin`, `deleteMessage`, `removeMember`, `sendGroupNotice`. Each destructive call
  returns `{ ok, error }`; the moderator only records success when the port reports it.
- `EventStore`: `claim(key)` (atomic idempotency) and `save(event)`.

### Decision order in `Moderator.handle`

1. Ignore bot's own messages.
2. Ignore unknown or disabled groups.
3. Detect violation (links, then profanity) on text plus caption. No violation: no event.
4. Owner or excluded member: record `skipped_protected`.
5. Admin check; if it cannot be verified, record `skipped_check_failed` and do nothing.
6. Idempotency claim on `groupId:messageId`.
7. Test mode: record `simulated`, execute nothing.
8. Delete message and remove member independently; status is `completed`, `partial` or `failed` from confirmed results.
9. Optional group notice; its failure never changes the action status.

Events store the matched host or list term only, never the message text.

## Decisions

- **Ports and adapters** so the whole pipeline is tested with a mock and no real destructive call is possible in tests.
- **Fail safe**: unverifiable admin status means no action. Test mode is on by default.
- **Conservative detection**: whole-token matching, curated TLD list, exact-only handling for ambiguous short Arabic roots,
  because the default action (removal) is costly when wrong.
- **node:sqlite** for the first storage layer: no native build step; PostgreSQL via the same repository interface later.

## WhatsApp integration risk

There is no official WhatsApp API for moderating ordinary groups. Libraries such as whatsapp-web.js automate
WhatsApp Web, are unofficial, can break on WhatsApp updates, and automated accounts can be banned. The adapter
is isolated behind `WhatsAppPort` so it can be replaced. Use a dedicated number, and keep test mode on until verified.

## API and dashboard (added)

- `src/api/app.ts` is a framework-independent `handle(ApiRequest) -> ApiResponse`. `server.ts` adapts it to `node:http`
  (the tested path used by `main.ts`); `express.ts` mounts the same handler on Express (UNVERIFIED, excluded from tsc).
  Express is therefore optional: the security logic lives in the shared handler, not in middleware.
- The dashboard (`src/web`) is a React SPA served by the API from `dist/web`. It talks only to `/api`.
- The API and worker communicate only through SQLite (`worker_status`, `connection_events`, `events`, `settings`).
  Settings changes bump a version the worker re-reads.
