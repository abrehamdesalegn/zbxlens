# Production deployment (without Docker)

Full steps also live in the root [README.md](../README.md). This page is the operator checklist.

## Checklist

1. Install under `/opt/zbxlens` with `backend/` and `frontend/` side by side.
2. Create system user `zr` and a venv in `backend/venv`.
3. Copy `backend/.env.example` → `backend/.env` and set `DB_*`, `ZABBIX_API_URL`, `TZ_OFFSET_MINUTES`, `COOKIE_SECURE`.
4. Ensure **`backend/data/` is writable** by `zr` (SQLite sessions/dashboards).
5. Run uvicorn via systemd, bound to `127.0.0.1:8000`.
6. Terminate TLS with nginx/Caddy; set `COOKIE_SECURE=true`.
7. Do **not** use `./run.sh` in production (`--reload` is for development only).

## systemd unit

`/etc/systemd/system/zbxlens.service`:

```ini
[Unit]
Description=ZbxLens
After=network.target

[Service]
Type=simple
User=zr
Group=zr
WorkingDirectory=/opt/zbxlens/backend
Environment=PATH=/opt/zbxlens/backend/venv/bin
EnvironmentFile=/opt/zbxlens/backend/.env
ExecStart=/opt/zbxlens/backend/venv/bin/uvicorn app.main:app \
  --host 127.0.0.1 \
  --port 8000 \
  --proxy-headers \
  --forwarded-allow-ips=* \
  --workers 2
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now zbxlens
sudo journalctl -u zbxlens -f
```

## Common failure

`sqlite3.OperationalError: attempt to write a readonly database`

```bash
sudo chown -R zr:zr /opt/zbxlens/backend/data
sudo systemctl restart zbxlens
```
