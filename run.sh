#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/backend"
if [ ! -d venv ]; then
  python3 -m venv venv
  source venv/bin/activate
  pip install -r requirements.txt
else
  source venv/bin/activate
fi
if [ ! -f .env ]; then
  echo "Copy .env.example to .env and fill in DB credentials first."
  exit 1
fi
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
