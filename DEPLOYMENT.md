# Deployment (Ubuntu VPS, Docker Compose)

> The Dockerfile, Compose file and Nginx config are **UNVERIFIED**: Compose syntax was validated with
> `docker compose config`, but images were never built (no Docker daemon or registry access in the authoring sandbox).
> Expect to fix small things on first build.

1. Install Docker Engine + Compose plugin; open ports 80/443.
2. `git clone` the repo; `cp .env.example .env` and edit. Set a long random `SETUP_TOKEN` or plan to use the CLI.
3. Put TLS certificates in `deploy/certs/` (`fullchain.pem`, `privkey.pem`), e.g. via certbot; set your hostname in
   `deploy/nginx.conf`.
4. `docker compose up -d --build`
5. Create the admin: `docker compose exec api node --import tsx scripts/create-admin.ts admin` (or use first-run setup
   in the browser with `SETUP_TOKEN`, then remove the token and `docker compose up -d`).
6. Sign in, open **WhatsApp connection**, scan the QR with the **dedicated test number**.
7. Keep **test mode on**. Enable one disposable group and verify (checklist in `PROJECT_STATUS.md`) before anything else.

## Backups and rollback
- Dashboard: System > Backups, or `docker compose exec api scripts/backup.sh`. Copy backups off the server.
- Cron example: `0 3 * * * cd /opt/guardian && docker compose exec -T api scripts/backup.sh`.
- Restore: `docker compose stop api worker`, then `docker compose run --rm --no-deps api scripts/restore.sh /data/backups/<file>`,
  then `docker compose up -d`.
- Code rollback: `git checkout <tag>` and `docker compose up -d --build`. Migrations only move forward, so restore a
  pre-upgrade backup if a rollback crosses a schema change. Take a backup before every upgrade.

## Persistence
One named volume `guardian-data` holds the database, backups and the WhatsApp session (`/data/wa-session`), so the
session survives restarts and re-deploys. Deleting the volume forces a QR re-pair.

## Windows quick start (UNVERIFIED)
Double-click `start-windows.bat`. It checks Node and Chrome, installs dependencies, builds the dashboard, creates the admin, and starts the API and worker with test mode on.
