#!/bin/sh
# Fix permissions on the bind-mounted data dir, then drop to the app user.
set -e

DATA_DIR="${ZR_DATA_DIR:-/app/backend/data}"
mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  # Host bind mounts are often root-owned; container app runs as UID 10001.
  chown -R app:app "$DATA_DIR" 2>/dev/null || chmod -R a+rwX "$DATA_DIR" || true
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid=app --regid=app --init-groups -- "$@"
  fi
  if command -v runuser >/dev/null 2>&1; then
    exec runuser -u app -- "$@"
  fi
  echo "warn: could not drop privileges; running as root" >&2
fi

exec "$@"
