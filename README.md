# ZbxLens

Internal **metrics & problems** UI for Zabbix.

- **Metrics** — saved multi-column pivot dashboards and a compact quick view (hosts × metrics, aggregations, thresholds, sparklines, drill-down, CSV/PDF export)
- **Problems** — open/closed problems with severity filters, bulk ack/close, saved views, CSV/PDF export

**Data** is read from the Zabbix **MySQL/MariaDB or PostgreSQL** schema (fast bulk history/trends).  
**Login & permissions** go through the Zabbix **JSON-RPC API** (same rights as the Zabbix UI).

There is no separate user database. Everyone signs in with their Zabbix username and password.

---

## Features

### Metrics

| Area | What you get |
|------|----------------|
| **Quick view** | Multi host-group + host pickers, metric search, min/avg/max/last, date range presets, optional previous-period compare |
| **Saved dashboards** | Multi-column pivots with per-column aggregations, multiplier, unit, display mode, and thresholds |
| **Builder** | Name + share-with-users / share-with-user-groups on one row; multi host-group selection (hosts auto-load); **Preview** (last 24h) before save |
| **Thresholds** | Single threshold value with **high_bad** / **high_good** mode; ±10% auto yellow band |
| **Insight strip** | Health summary chips (healthy / warning / critical / no data) — filter the pivot by clicking a chip |
| **Export** | CSV and PDF (grouped headers, landscape layout) |

### Problems

| Area | What you get |
|------|----------------|
| **Quick view** | Host group + hosts, min severity, status (open / closed / all), compact toolbar |
| **Saved views** | Scoped problem dashboards with multi host-group selection (hosts auto-load) and **Preview** |
| **Table** | Columns: **Severity · Host · Problem · Duration · Ack** (left-aligned). Closed problems show **Closed** in Duration |
| **Actions** | Acknowledge, unacknowledge, close (manual-close triggers); bulk actions with selection bar |

### Sharing & access

- Share a dashboard or problem view with **specific Zabbix users** and/or **user groups**
- Only the owner can edit; shared users can view and run within their Zabbix host rights
- Visibility always follows Zabbix host-group permissions (including deny rules)

| Zabbix role | In this app |
|-------------|-------------|
| **User** | View/run shared dashboards & problem views within host rights |
| **Admin / Super Admin** | Create and edit saved dashboards, problem views, and presets |

---

## Requirements

| Component | Notes |
|-----------|--------|
| Zabbix | 5.x / 6.x / 7.x (MySQL/MariaDB or PostgreSQL) |
| Network | App host can reach the Zabbix database and `api_jsonrpc.php` |
| Runtime | **Docker** *or* Python **3.10+** |

---

## Installation

Follow these steps in order. Choose **Docker** (recommended) or **Python** at the run step.

### 1. Get the code

```bash
git clone https://github.com/YOUR_ORG/zbxlens.git
cd zbxlens
```

Keep `backend/` and `frontend/` **next to each other**. The API serves the UI from `../frontend`.

### 2. Create a read-only Zabbix database user

Do **not** use the Zabbix application database account. Create a SELECT-only user.

**MySQL / MariaDB** — edit password and database name in the script, then:

```bash
mysql -u root -p < sql/create_readonly_user.sql
```

Or manually:

```sql
CREATE USER 'zbx_reporter'@'%' IDENTIFIED BY 'strong-password';
GRANT SELECT ON zabbix.* TO 'zbx_reporter'@'%';
FLUSH PRIVILEGES;
```

**PostgreSQL** — use `sql/create_readonly_user_postgresql.sql` (adjust role and database name as needed).

### 3. Configure the environment

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` and set at least:

```env
# Zabbix server database (history / trends / inventory)
DB_ENGINE=mysql              # or postgresql
DB_HOST=192.168.1.10         # don't use localhost or 127.0.0.1 — use the DB host IP
DB_PORT=3306                 # 5432 for PostgreSQL
DB_USER=zbx_reporter
DB_PASSWORD=strong-password
DB_NAME=zabbix

# Zabbix frontend API (login + host permissions)
ZABBIX_API_URL=http://{zabbix url}/zabbix/api_jsonrpc.php

# Display timezone: minutes east of UTC (180 = UTC+3 / EAT). 0 = browser local TZ
TZ_OFFSET_MINUTES=180

# true when the UI is served over HTTPS; false for plain http:// on a LAN
COOKIE_SECURE=false
```

Optional settings (`DB_POOL_SIZE`, `SESSION_IDLE_TTL_MINUTES`, `ZABBIX_API_VERIFY_TLS`, …) are documented in `backend/.env.example`.

The app’s own data (sessions, saved dashboards, pins) is stored in **SQLite** under `backend/data/` and is independent of `DB_ENGINE`.

### 4. Run the application

#### Option A — Docker

```bash
mkdir -p backend/data
# On Linux, ensure the container user can write the data volume:
# sudo chown -R 10001:10001 backend/data

docker compose up -d --build
```

Open **http://<server-ip>:8000**.

#### Option B — Python (development or bare metal)

```bash
cd backend
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Ensure the data directory is writable
mkdir -p data

uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Open **http://<server-ip>:8000**.

For production (systemd, reverse proxy, TLS), see [docs/production.md](docs/production.md).

### 5. Verify

```bash
curl -sS http://127.0.0.1:8000/api/health        # liveness
curl -sS http://127.0.0.1:8000/api/health/ready  # database reachable
```

Sign in with a Zabbix username and password. Host lists and metrics are limited to that user’s Zabbix permissions.

### 6. Backup (optional)

```bash
# App DB only (dashboards, sessions, pins) — not Zabbix history
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
      main.py
      config.py
      db.py
      appdb.py
      auth.py
      zbx_api.py
      schemas/
      routes/
      services/
  frontend/
    index.html
    css/app.css
    js/
  sql/
  scripts/
  deploy/
  docs/
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| **500** / `readonly database` | `backend/data` not writable by the service user | `chown -R` the service user on `backend/data` |
| Docker: `unable to open database file` | Bind mount `backend/data` not writable by UID **10001** | `mkdir -p backend/data && sudo chown -R 10001:10001 backend/data`, then recreate the container |
| **500** on `/` | Missing `frontend/` next to `backend/` | Deploy the full tree; check that `frontend/index.html` exists |
| Login fails | Bad `ZABBIX_API_URL` or network | `curl` the API URL from the app host |
| **Not authorized** on Zabbix **6** | User group API/Frontend access off, or wrong API URL | In Zabbix 6: **Administration → User groups** → enable **Frontend access** and **API access**. Confirm `ZABBIX_API_URL` points at that server’s `api_jsonrpc.php` |
| Empty hosts / metrics | DB user or host permissions | Check read-only grants; confirm the Zabbix user can see those hosts in the Zabbix UI |
| Share pickers empty / “Could not load users/groups” | API rights or first load | Use **Retry** in the builder; confirm the signed-in user can call `user.get` / `usergroup.get` |
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
- Keep the Zabbix database account **SELECT-only**.
- Do not commit `.env` or `backend/data/` to git.

---

## License

Use and modify for your organization as needed. Not affiliated with Zabbix LLC.
