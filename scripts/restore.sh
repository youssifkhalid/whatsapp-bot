#!/usr/bin/env bash
# Restore a backup. STOP the api and worker first. Keeps the replaced database as <db>.before-restore.
# Usage: scripts/restore.sh <backup-file> [db-path]
set -euo pipefail
BACKUP="${1:?usage: restore.sh <backup-file> [db-path]}"
DB="${2:-${DATABASE_PATH:-./data/guardian.db}}"
[ -f "$BACKUP" ] || { echo "no such backup: $BACKUP" >&2; exit 1; }
node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1], { readOnly: true });
const r = db.prepare("PRAGMA integrity_check").get();
if (r.integrity_check !== "ok") { console.error("backup failed integrity check"); process.exit(1); }
' "$BACKUP"
[ -f "$DB" ] && cp "$DB" "$DB.before-restore"
rm -f "$DB-wal" "$DB-shm"
cp "$BACKUP" "$DB"
echo "restored $BACKUP -> $DB (previous kept as $DB.before-restore)"
