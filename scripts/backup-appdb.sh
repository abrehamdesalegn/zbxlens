#!/usr/bin/env bash
# Backup the app SQLite DB (sessions, dashboards, presets, pins).
# Usage: ./scripts/backup-appdb.sh [dest-dir]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${ROOT}/backend/data/app.db"
DEST_DIR="${1:-${ROOT}/backend/data/backups}"
mkdir -p "$DEST_DIR"
if [[ ! -f "$SRC" ]]; then
  echo "No app.db at $SRC — nothing to back up yet."
  exit 0
fi
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${DEST_DIR}/app-${STAMP}.db"
# Prefer sqlite3 online backup when available; else consistent file copy
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$SRC" ".backup '${DEST}'"
else
  cp -a "$SRC" "$DEST"
  # Also copy WAL/SHM if present (app may be mid-write)
  [[ -f "${SRC}-wal" ]] && cp -a "${SRC}-wal" "${DEST}-wal" || true
  [[ -f "${SRC}-shm" ]] && cp -a "${SRC}-shm" "${DEST}-shm" || true
fi
echo "Backup written: $DEST"
# Keep last 14 backups
ls -1t "$DEST_DIR"/app-*.db 2>/dev/null | tail -n +15 | xargs -r rm -f
