#!/usr/bin/env bash
# Consistent SQLite snapshot (VACUUM INTO) of the live database, safe while the API and worker run.
# Usage: scripts/backup.sh [db-path] [backup-dir]
set -euo pipefail
DB="${1:-${DATABASE_PATH:-./data/guardian.db}}"
DIR="${2:-${BACKUP_DIR:-./data/backups}}"
KEEP="${BACKUP_RETENTION:-14}"
mkdir -p "$DIR"
OUT="$DIR/guardian-$(date -u +%Y%m%dT%H%M%SZ).db"
node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const [src, out] = process.argv.slice(1);
const db = new DatabaseSync(src);
db.exec(`VACUUM INTO '"'"'${out.replace(/'"'"'/g, "")}'"'"'`);
db.close();
' "$DB" "$OUT"
chmod 600 "$OUT"
echo "backup written: $OUT"
ls -1t "$DIR"/guardian-*.db | tail -n +"$((KEEP + 1))" | xargs -r rm -f
