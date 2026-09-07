#!/usr/bin/env bash
# Restore app.db from a backup file.
# Usage: ./scripts/restore-appdb.sh path/to/app-YYYYMMDD.db
# Stop the app (or docker compose stop) before restoring.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-}"
DEST="${ROOT}/backend/data/app.db"
if [[ -z "$SRC" || ! -f "$SRC" ]]; then
  echo "Usage: $0 path/to/backup.db" >&2
  exit 1
fi
mkdir -p "$(dirname "$DEST")"
if [[ -f "$DEST" ]]; then
  BAK="${DEST}.pre-restore.$(date -u +%Y%m%dT%H%M%SZ)"
  cp -a "$DEST" "$BAK"
  echo "Existing DB moved aside: $BAK"
fi
cp -a "$SRC" "$DEST"
# Drop stale WAL so SQLite opens the restored main file cleanly
rm -f "${DEST}-wal" "${DEST}-shm"
echo "Restored $SRC → $DEST"
echo "Restart the app to pick up the restored database."
