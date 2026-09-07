"""
Local storage for dashboard definitions and report presets.
Intentionally a separate SQLite file — the Zabbix DB user is read-only.
"""
import json
import sqlite3
import time
import uuid
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "app.db"


def _ensure_data_dir() -> None:
    """Create backend/data and verify it is writable.

    In Docker this path is often a bind mount. If the host directory is owned
    by root (or another UID) while the container runs as UID 10001, SQLite
    fails with 'unable to open database file'.
    """
    data_dir = DB_PATH.parent
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise RuntimeError(
            f"Cannot create app data directory {data_dir}: {e}. "
            "On the host run: mkdir -p backend/data && chmod 777 backend/data "
            "(or chown to UID 10001 for Docker)."
        ) from e
    probe = data_dir / ".write_test"
    try:
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
    except OSError as e:
        raise RuntimeError(
            f"App data directory is not writable: {data_dir} ({e}). "
            "Docker bind-mount fix on the host:\n"
            "  mkdir -p backend/data && sudo chown -R 10001:10001 backend/data\n"
            "Then: docker compose up -d --force-recreate"
        ) from e


def _conn():
    _ensure_data_dir()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init():
    with _conn() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS dashboards (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                hostids_json TEXT NOT NULL,
                columns_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS report_presets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                groupid INTEGER NOT NULL,
                item_keys_json TEXT NOT NULL,
                resolution TEXT NOT NULL DEFAULT 'auto',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS problem_dashboards (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                hostids_json TEXT NOT NULL,
                groupid INTEGER,
                min_severity INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'open',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                userid INTEGER NOT NULL,
                username TEXT NOT NULL,
                name TEXT NOT NULL DEFAULT '',
                surname TEXT NOT NULL DEFAULT '',
                role_type INTEGER NOT NULL DEFAULT 1,
                zbx_token TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                permitted_groupids_json TEXT NOT NULL DEFAULT '[]',
                permitted_hostids_json TEXT NOT NULL DEFAULT '[]',
                permissions_cached_at INTEGER NOT NULL DEFAULT 0
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at)")
        c.execute("""
            CREATE TABLE IF NOT EXISTS pins (
                userid INTEGER NOT NULL,
                item_type TEXT NOT NULL,
                item_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (userid, item_type, item_id)
            )
        """)


init()


def _ensure_columns(table: str, columns: dict[str, str]) -> None:
    """Add any missing columns to `table` (id -> 'TYPE DEFAULT ...' DDL
    fragment). Lets older SQLite files upgrade in place, same pattern as
    the pre-existing problem_dashboards migration below."""
    with _conn() as c:
        existing = {r[1] for r in c.execute(f"PRAGMA table_info({table})").fetchall()}
        for name, ddl in columns.items():
            if name not in existing:
                c.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")


_OWNERSHIP_COLUMNS = {
    "owner_userid": "INTEGER NOT NULL DEFAULT 0",
    "owner_username": "TEXT NOT NULL DEFAULT ''",
    "is_shared": "INTEGER NOT NULL DEFAULT 0",
    "shared_userids_json": "TEXT NOT NULL DEFAULT '[]'",
    "shared_usrgrpids_json": "TEXT NOT NULL DEFAULT '[]'",
}
for _table in ("dashboards", "report_presets", "problem_dashboards"):
    _ensure_columns(_table, _OWNERSHIP_COLUMNS)

_ensure_columns("sessions", {
    "usrgrpids_json": "TEXT NOT NULL DEFAULT '[]'",
})

def _ensure_problem_dashboards():
    with _conn() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS problem_dashboards (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                hostids_json TEXT NOT NULL,
                groupid INTEGER,
                min_severity INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'open',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
        """)
        # migrate older DBs
        cols = [r[1] for r in c.execute("PRAGMA table_info(problem_dashboards)").fetchall()]
        if "status" not in cols:
            c.execute("ALTER TABLE problem_dashboards ADD COLUMN status TEXT NOT NULL DEFAULT 'open'")
        if "ack" not in cols:
            # Referenced by create/update below but was missing from the
            # original CREATE TABLE / migration — added here so saving a
            # problem dashboard doesn't fail with "no such column: ack".
            c.execute("ALTER TABLE problem_dashboards ADD COLUMN ack TEXT NOT NULL DEFAULT 'all'")

_ensure_problem_dashboards()


def _share_vals(d: dict) -> tuple[int, str, str]:
    """is_shared, shared_userids_json, shared_usrgrpids_json from payload."""
    is_shared = int(bool(d.get("is_shared")))
    su = d.get("shared_userids") or []
    sg = d.get("shared_usrgrpids") or []
    su = [int(x) for x in su]
    sg = [int(x) for x in sg]
    return is_shared, json.dumps(su), json.dumps(sg)


# ── Dashboards ──────────────────────────────────────────────────────────────

def _row_to_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "hostids": json.loads(row["hostids_json"]),
        "columns": json.loads(row["columns_json"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "owner_userid": row["owner_userid"],
        "owner_username": row["owner_username"],
        "is_shared": bool(row["is_shared"]) if "is_shared" in row.keys() else False,
        "shared_userids": json.loads(row["shared_userids_json"]) if "shared_userids_json" in row.keys() and row["shared_userids_json"] else [],
        "shared_usrgrpids": json.loads(row["shared_usrgrpids_json"]) if "shared_usrgrpids_json" in row.keys() and row["shared_usrgrpids_json"] else [],
    }


def list_dashboards() -> list[dict]:
    with _conn() as c:
        rows = c.execute("SELECT * FROM dashboards ORDER BY updated_at DESC").fetchall()
        return [_row_to_dict(r) for r in rows]


def get_dashboard(dash_id: str) -> dict | None:
    with _conn() as c:
        row = c.execute("SELECT * FROM dashboards WHERE id = ?", (dash_id,)).fetchone()
        return _row_to_dict(row) if row else None


def create_dashboard(d: dict) -> dict:
    dash_id = uuid.uuid4().hex[:12]
    now = int(time.time())
    with _conn() as c:
        c.execute(
            "INSERT INTO dashboards (id, name, hostids_json, columns_json, created_at, updated_at, "
            "owner_userid, owner_username, is_shared, shared_userids_json, shared_usrgrpids_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                dash_id, d["name"], json.dumps(d["hostids"]), json.dumps(d["columns"]), now, now,
                int(d.get("owner_userid") or 0), d.get("owner_username") or "",
            ) + _share_vals(d),
        )
    return get_dashboard(dash_id)


def update_dashboard(dash_id: str, d: dict) -> dict | None:
    if not get_dashboard(dash_id):
        return None
    now = int(time.time())
    with _conn() as c:
        c.execute(
            "UPDATE dashboards SET name = ?, hostids_json = ?, columns_json = ?, updated_at = ?, "
            "is_shared = ?, shared_userids_json = ?, shared_usrgrpids_json = ? WHERE id = ?",
            (
                d["name"], json.dumps(d["hostids"]), json.dumps(d["columns"]), now,
            ) + _share_vals(d) + (dash_id,),
        )
    return get_dashboard(dash_id)


def delete_dashboard(dash_id: str) -> None:
    with _conn() as c:
        c.execute("DELETE FROM dashboards WHERE id = ?", (dash_id,))


# ── Report presets ──────────────────────────────────────────────────────────

def _preset_to_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "groupid": row["groupid"],
        "item_keys": json.loads(row["item_keys_json"]),
        "resolution": row["resolution"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "owner_userid": row["owner_userid"],
        "owner_username": row["owner_username"],
        "is_shared": bool(row["is_shared"]) if "is_shared" in row.keys() else False,
        "shared_userids": json.loads(row["shared_userids_json"]) if "shared_userids_json" in row.keys() and row["shared_userids_json"] else [],
        "shared_usrgrpids": json.loads(row["shared_usrgrpids_json"]) if "shared_usrgrpids_json" in row.keys() and row["shared_usrgrpids_json"] else [],
    }


def list_presets() -> list[dict]:
    with _conn() as c:
        rows = c.execute("SELECT * FROM report_presets ORDER BY updated_at DESC").fetchall()
        return [_preset_to_dict(r) for r in rows]


def get_preset(preset_id: str) -> dict | None:
    with _conn() as c:
        row = c.execute("SELECT * FROM report_presets WHERE id = ?", (preset_id,)).fetchone()
        return _preset_to_dict(row) if row else None


def create_preset(d: dict) -> dict:
    preset_id = uuid.uuid4().hex[:12]
    now = int(time.time())
    with _conn() as c:
        c.execute(
            "INSERT INTO report_presets (id, name, groupid, item_keys_json, resolution, created_at, updated_at, "
            "owner_userid, owner_username, is_shared) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                preset_id,
                d["name"],
                d["groupid"],
                json.dumps(d["item_keys"]),
                d.get("resolution", "auto"),
                now,
                now,
                int(d.get("owner_userid") or 0),
                d.get("owner_username") or "",
                int(bool(d.get("is_shared"))),
            ),
        )
    return get_preset(preset_id)


def update_preset(preset_id: str, d: dict) -> dict | None:
    if not get_preset(preset_id):
        return None
    now = int(time.time())
    with _conn() as c:
        c.execute(
            "UPDATE report_presets SET name = ?, groupid = ?, item_keys_json = ?, resolution = ?, "
            "updated_at = ?, is_shared = ? WHERE id = ?",
            (
                d["name"],
                d["groupid"],
                json.dumps(d["item_keys"]),
                d.get("resolution", "auto"),
                now,
                int(bool(d.get("is_shared"))),
                preset_id,
            ),
        )
    return get_preset(preset_id)


def delete_preset(preset_id: str) -> None:
    with _conn() as c:
        c.execute("DELETE FROM report_presets WHERE id = ?", (preset_id,))



# ── Problem dashboards ──────────────────────────────────────────────────────

def _pdash_to_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "hostids": json.loads(row["hostids_json"]),
        "groupid": row["groupid"],
        "min_severity": row["min_severity"],
        "status": row["status"] if "status" in row.keys() else "open",
        "ack": row["ack"] if "ack" in row.keys() else "all",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "owner_userid": row["owner_userid"],
        "owner_username": row["owner_username"],
        "is_shared": bool(row["is_shared"]) if "is_shared" in row.keys() else False,
        "shared_userids": json.loads(row["shared_userids_json"]) if "shared_userids_json" in row.keys() and row["shared_userids_json"] else [],
        "shared_usrgrpids": json.loads(row["shared_usrgrpids_json"]) if "shared_usrgrpids_json" in row.keys() and row["shared_usrgrpids_json"] else [],
    }


def list_problem_dashboards() -> list[dict]:
    with _conn() as c:
        rows = c.execute("SELECT * FROM problem_dashboards ORDER BY updated_at DESC").fetchall()
        return [_pdash_to_dict(r) for r in rows]


def get_problem_dashboard(dash_id: str) -> dict | None:
    with _conn() as c:
        row = c.execute("SELECT * FROM problem_dashboards WHERE id = ?", (dash_id,)).fetchone()
        return _pdash_to_dict(row) if row else None


def create_problem_dashboard(d: dict) -> dict:
    dash_id = uuid.uuid4().hex[:12]
    now = int(time.time())
    with _conn() as c:
        c.execute(
            "INSERT INTO problem_dashboards (id, name, hostids_json, groupid, min_severity, status, ack, "
            "created_at, updated_at, owner_userid, owner_username, is_shared, shared_userids_json, shared_usrgrpids_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                dash_id,
                d["name"],
                json.dumps(d.get("hostids") or []),
                d.get("groupid"),
                int(d.get("min_severity") or 0),
                d.get("status") or "open",
                d.get("ack") or "all",
                now,
                now,
                int(d.get("owner_userid") or 0),
                d.get("owner_username") or "",
            ) + _share_vals(d),
        )
    return get_problem_dashboard(dash_id)


def update_problem_dashboard(dash_id: str, d: dict) -> dict | None:
    if not get_problem_dashboard(dash_id):
        return None
    now = int(time.time())
    with _conn() as c:
        c.execute(
            "UPDATE problem_dashboards SET name = ?, hostids_json = ?, groupid = ?, min_severity = ?, "
            "status = ?, ack = ?, updated_at = ?, is_shared = ?, shared_userids_json = ?, shared_usrgrpids_json = ? WHERE id = ?",
            (
                d["name"],
                json.dumps(d.get("hostids") or []),
                d.get("groupid"),
                int(d.get("min_severity") or 0),
                d.get("status") or "open",
                d.get("ack") or "all",
                now,
            ) + _share_vals(d) + (dash_id,),
        )
    return get_problem_dashboard(dash_id)


def delete_problem_dashboard(dash_id: str) -> None:
    with _conn() as c:
        c.execute("DELETE FROM problem_dashboards WHERE id = ?", (dash_id,))


# ── Sessions (Zabbix-login-backed) ───────────────────────────────────────────
# Server-side session store. The cookie only ever carries the random id
# below; everything about who the user is and what they can see lives
# here (and is re-validated on every request).

def create_session(session_id: str, user: dict, zbx_token: str, expires_at: int,
                    permitted_groupids: set[int], permitted_hostids: set[int],
                    usrgrpids: set[int] | None = None) -> None:
    _ensure_columns("sessions", {
        "usrgrpids_json": "TEXT NOT NULL DEFAULT '[]'",
    })
    now = int(time.time())
    ug = usrgrpids if usrgrpids is not None else set(user.get("usrgrpids") or [])
    with _conn() as c:
        c.execute(
            "INSERT INTO sessions (id, userid, username, name, surname, role_type, zbx_token, "
            "created_at, expires_at, permitted_groupids_json, permitted_hostids_json, permissions_cached_at, "
            "usrgrpids_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                session_id, user["userid"], user["username"], user.get("name", ""), user.get("surname", ""),
                user["role_type"], zbx_token, now, expires_at,
                json.dumps(sorted(permitted_groupids)), json.dumps(sorted(permitted_hostids)), now,
                json.dumps(sorted(int(x) for x in ug)),
            ),
        )


def get_session(session_id: str) -> dict | None:
    with _conn() as c:
        row = c.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "userid": row["userid"],
            "username": row["username"],
            "name": row["name"],
            "surname": row["surname"],
            "role_type": row["role_type"],
            "zbx_token": row["zbx_token"],
            "created_at": row["created_at"],
            "expires_at": row["expires_at"],
            "permitted_groupids": set(json.loads(row["permitted_groupids_json"])),
            "permitted_hostids": set(json.loads(row["permitted_hostids_json"])),
            "usrgrpids": set(json.loads(row["usrgrpids_json"])) if "usrgrpids_json" in row.keys() and row["usrgrpids_json"] else set(),
            "permissions_cached_at": row["permissions_cached_at"],
        }


def update_session_role(session_id: str, role_type: int) -> None:
    with _conn() as c:
        c.execute("UPDATE sessions SET role_type = ? WHERE id = ?", (int(role_type), session_id))


def touch_session(session_id: str, expires_at: int) -> None:
    """Sliding idle timeout: extend expiry on each authenticated request."""
    with _conn() as c:
        c.execute("UPDATE sessions SET expires_at = ? WHERE id = ?", (expires_at, session_id))


def update_session_permissions(session_id: str, permitted_groupids: set[int],
                                permitted_hostids: set[int], cached_at: int) -> None:
    with _conn() as c:
        c.execute(
            "UPDATE sessions SET permitted_groupids_json = ?, permitted_hostids_json = ?, "
            "permissions_cached_at = ? WHERE id = ?",
            (json.dumps(sorted(permitted_groupids)), json.dumps(sorted(permitted_hostids)), cached_at, session_id),
        )


def delete_session(session_id: str) -> None:
    with _conn() as c:
        c.execute("DELETE FROM sessions WHERE id = ?", (session_id,))


def delete_expired_sessions() -> None:
    with _conn() as c:
        c.execute("DELETE FROM sessions WHERE expires_at < ?", (int(time.time()),))


# ── Pins (per-user; dashboards/problem dashboards can be shared across
#    users, so "pinned" can't be a single flag on the item itself — it's
#    scoped to (userid, item_type, item_id) instead) ─────────────────────────

_VALID_PIN_TYPES = {"dashboard", "problem_dashboard"}


def list_pinned_ids(userid: int) -> dict[str, list[str]]:
    with _conn() as c:
        rows = c.execute(
            "SELECT item_type, item_id FROM pins WHERE userid = ?", (int(userid),)
        ).fetchall()
    out: dict[str, list[str]] = {t: [] for t in _VALID_PIN_TYPES}
    for r in rows:
        out.setdefault(r["item_type"], []).append(r["item_id"])
    return out


def set_pin(userid: int, item_type: str, item_id: str, pinned: bool) -> None:
    if item_type not in _VALID_PIN_TYPES:
        raise ValueError(f"Unknown pin item_type: {item_type}")
    with _conn() as c:
        if pinned:
            c.execute(
                "INSERT OR IGNORE INTO pins (userid, item_type, item_id, created_at) VALUES (?, ?, ?, ?)",
                (int(userid), item_type, str(item_id), int(time.time())),
            )
        else:
            c.execute(
                "DELETE FROM pins WHERE userid = ? AND item_type = ? AND item_id = ?",
                (int(userid), item_type, str(item_id)),
            )
