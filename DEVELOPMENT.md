# Development

- Node >= 22.13 (uses built-in `node:sqlite`, `node:test`). Tests: `npm test` (140 at time of writing). Typecheck:
  `npm run typecheck` and `npm run typecheck:web`.
- Tests use mocks only. No test ever contacts WhatsApp or touches a real group.
- Layers: `src/core` (engine, depends only on `WhatsAppPort`/`EventStore`) -> `src/storage` -> `src/auth` -> `src/api`,
  `src/worker`, `src/whatsapp` (adapter) -> `src/web` (dashboard).
- Dashboard build: `npm run build:web` (esbuild + Tailwind 4 compile, no Vite). UI components are shadcn-style, written
  by hand; the shadcn CLI/Radix were not used.
- **First thing on a networked machine**: after `npm install`, delete `src/web/shims.d.ts` (a hand-typed React subset used
  because `@types/react` could not be installed) and fix whatever `npm run typecheck:web` reports.
- QR pairing code is rendered by an in-repo encoder (`src/web/lib/qr.ts`), verified with OpenCV in `tests/qr.test.ts`
  (skipped if OpenCV is unavailable on your machine; check test output).
- Optional: switch `openDatabase` to `better-sqlite3` (same `Db` interface). Unverified.
