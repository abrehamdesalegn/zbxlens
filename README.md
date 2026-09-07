# ZbxLens

Internal **metrics & problems** UI for Zabbix.

- **Metrics** — saved pivot dashboards and a quick-view builder (hosts × metrics, avg/min/max, sparklines, drill-down charts, CSV/PDF export)
- **Problems** — open/closed problems with severity filters, bulk ack/close, CSV/PDF export

**Data** is read from the Zabbix **MySQL** schema (fast bulk history/trends).  
**Login & permissions** go through the Zabbix **JSON-RPC API** (same rights as the Zabbix UI).

There is no separate user database. Everyone signs in with their Zabbix username and password.

---

## Requirements

| Component | Notes |
|-----------|--------|
| Zabbix | 5.x / 6.x / 7.x (MySQL/MariaDB) |
| Network | App host can reach Zabbix DB and `api_jsonrpc.php` |
| Runtime | **Docker** *or* Python **3.10+** |

---

## Quick start (Docker) — recommended

```bash
git clone https://github.com/YOUR_ORG/zbxlens.git
cd zbxlens

cp backend/.env.example backend/.env
# edit backend/.env — at least DB_* and ZABBIX_API_URL

docker compose up -d --build
```

Open **http://localhost:8000** (or `http://<server-ip>:8000`).

App data (dashboards, sessions) is stored under `backend/data/` and survives restarts.

---

## Quick start (without Docker)

```bash
git clone https://github.com/YOUR_ORG/zbxlens.git
cd zbxlens

# 1) Config
cp backend/.env.example backend/.env
nano backend/.env          # set DB_* and ZABBIX_API_URL

# 2) Python env
cd backend
python3 -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt

# 3) Run (development)
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Open **http://localhost:8000**.

> Keep this directory layout: `backend/` and `frontend/` must sit **next to each other**. The API serves the UI from `../frontend`.

See [docs/production.md](docs/production.md) for systemd + nginx notes.

---

## Configure `.env`

Copy `backend/.env.example` → `backend/.env` and set at least:

```env
# Zabbix MySQL (use a read-only user — see below)
DB_HOST=zabbix-db.example.com
DB_PORT=3306
DB_USER=zbx_reporter
DB_PASSWORD=strong-password
DB_NAME=zabbix

# Zabbix frontend API (login + host permissions)
ZABBIX_API_URL=http://zabbix.example.com/api_jsonrpc.php

# Display timezone: minutes east of UTC (180 = UTC+3 / EAT). 0 = browser local TZ
TZ_OFFSET_MINUTES=180

# true when the UI is served over HTTPS; false for plain http:// on a LAN
COOKIE_SECURE=false
```

Other options (`DB_POOL_SIZE`, `SESSION_IDLE_TTL_MINUTES`, `ZABBIX_API_VERIFY_TLS`, …) are documented in `.env.example`.

### Read-only MySQL user

Do **not** use the Zabbix app DB user for this tool. Create a SELECT-only account:

```bash
# Edit password / DB name in the script first, then:
mysql -u root -p < sql/create_readonly_user.sql
```

Or manually:

```sql
CREATE USER 'zbx_reporter'@'%' IDENTIFIED BY 'strong-password';
GRANT SELECT ON zabbix.* TO 'zbx_reporter'@'%';
FLUSH PRIVILEGES;
```

---

## Sign-in & permissions

| Zabbix role | In this app |
|-------------|-------------|
| **User** | View/run shared dashboards & problems within their host rights |
| **Admin / Super Admin** | Create and edit saved dashboards, problem views, presets |

Visibility always follows **your** Zabbix host-group permissions, including deny rules.

---

## Health checks

```bash
curl -sS http://127.0.0.1:8000/api/health        # liveness
curl -sS http://127.0.0.1:8000/api/health/ready  # DB reachable
```

---

## Backup

```bash
# App DB (dashboards, sessions, pins) — not Zabbix data
./scripts/backup-appdb.sh
# or:
tar -czf zr-data-$(date +%F).tgz -C backend data
```

Restore with `./scripts/restore-appdb.sh` or unpack into `backend/data/`.

---

## Project layout

```text
zbxlens/
  README.md
  LICENSE
  CHANGELOG.md
  docker-compose.yml
  Dockerfile
  run.sh
  backend/
    .env.example
    requirements.txt
    data/.gitkeep          # runtime SQLite (sessions, dashboards)
    app/
      main.py              # FastAPI entry, middleware, static mounts
      config.py            # environment settings
      db.py                # MySQL pool
      appdb.py             # local SQLite
      auth.py
      zbx_api.py
      schemas/             # Pydantic models
      routes/              # HTTP route modules
        health.py
        auth_routes.py
        report.py
        dashboards.py
        problems.py
      services/            # domain logic
        dashboard.py
        report.py
        queries.py
        export.py
        metrics.py
        zbx.py
  frontend/
    index.html
    css/app.css
    js/
      core.js
      export.js
      utils.js
      ui.js
      dashboards.js
      problems.js
  sql/
  scripts/
  deploy/
  docs/
```


## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| **500** / `readonly database` | `backend/data` not writable by service user | `chown -R` service user on `backend/data` |
| Docker: `unable to open database file` | Bind mount `backend/data` not writable by UID **10001** | `mkdir -p backend/data && sudo chown -R 10001:10001 backend/data` then recreate container |
| **500** on `/` | Missing `frontend/` next to `backend/` | Deploy full tree; check `frontend/index.html` exists |
| Login fails | Bad `ZABBIX_API_URL` or network | `curl` the API URL from the app host |
| Empty hosts / metrics | DB user or host permissions | Check read-only grants; confirm Zabbix user can see those hosts in Zabbix UI |
| Cookie / logout every refresh | `COOKIE_SECURE=true` over plain HTTP | Set `COOKIE_SECURE=false` on HTTP, `true` on HTTPS |
| Service won’t start | Wrong `WorkingDirectory` | Must be `.../backend` |

Logs (systemd):

```bash
sudo journalctl -u zbxlens -n 80 --no-pager
```

---

## Security notes

- Prefer **HTTPS** and `COOKIE_SECURE=true` in production.
- Restrict access (VPN / private network / firewall). This is an **internal** tool.
- Keep the Zabbix DB account **SELECT-only**.
- Do not commit `.env` or `backend/data/` to git.

---

## License

Use and modify for your organization as needed. Not affiliated with Zabbix LLC.
