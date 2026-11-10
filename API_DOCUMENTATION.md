# API

JSON over HTTP under `/api`. Auth is a cookie session (`guardian_session`, HttpOnly, SameSite=Strict). Every non-GET
request must send `x-csrf-token` (returned by login/`/auth/me`) and a same-origin `Origin`. Errors are
`{ "error": { "code": "...", "message": "..." } }`; the dashboard maps `code` to localised text.

Roles: `read` = admin or viewer, `admin` = admin only, `public` = no session.

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | /api/health | public | Liveness |
| GET | /api/auth/setup-status | public | Whether first-run setup is open |
| POST | /api/auth/setup | public | Create first admin (needs `SETUP_TOKEN`) |
| POST | /api/auth/login | public | Login (rate limited, lockout) |
| GET | /api/auth/me | read | Current user + CSRF token |
| POST | /api/auth/logout | read | End session |
| POST | /api/auth/password | read | Change password (revokes all sessions) |
| GET | /api/overview | read | Figures, 14-day series, worker status, recent events |
| GET | /api/stats | read | Aggregated statistics |
| GET | /api/connection | read | Worker state, connection history; QR payload for admins only |
| GET | /api/groups, /api/groups/:id | read | Groups with rules and exclusions |
| PATCH | /api/groups/:id | admin | Enable, notify, link/profanity rules |
| POST | /api/groups/:id/exclusions | admin | Exclude a member |
| DELETE | /api/groups/:id/exclusions/:memberId | admin | Remove exclusion |
| GET / PATCH | /api/settings | read / admin | Test mode, owners. Disabling test mode needs `confirmDisableTestMode: true` |
| GET | /api/events, /api/events/:id | read | Paged, filterable activity log |
| GET | /api/events/export.csv | read | CSV of up to 10,000 newest matching events (formula-injection guarded) |
| GET | /api/members | read | Members with violations |
| GET | /api/audit | admin | Audit log |
| GET / POST / DELETE | /api/users[/:id] | admin | User management (last admin protected) |
| GET | /api/system | read | Health, environment flags, backups |
| POST | /api/system/backups | admin | Create a SQLite backup |

Rate limits: 600 requests/min per IP overall, 10 login attempts per 15 min per IP, plus per-username lockout.
Request bodies are validated with strict Zod schemas (unknown fields rejected). Query parameters for events:
`q, groupId, type, status, senderId, from, to, page, pageSize`.
