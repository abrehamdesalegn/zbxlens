from .db import query


def _hostid_filter_sql(alias: str, allowed_hostids) -> tuple[str, tuple]:
    """Build an 'AND alias.hostid IN (...)' fragment for an optional
    host-permission allow-list. allowed_hostids=None means "no caller-
    supplied restriction" (used only for trusted/internal callers —
    every HTTP route always passes the current user's permitted set).
    An empty set/list means "permitted on nothing" and short-circuits
    to a clause that matches no rows, rather than accidentally matching
    everything.
    """
    if allowed_hostids is None:
        return "", ()
    allowed = [int(i) for i in allowed_hostids]
    if not allowed:
        return f" AND {alias}.hostid IN (NULL) ", ()
    placeholders = ",".join(["%s"] * len(allowed))
    return f" AND {alias}.hostid IN ({placeholders}) ", tuple(allowed)


def list_hostgroups() -> list[dict]:
    sql = """
        SELECT g.groupid, g.name,
               COUNT(DISTINCT hg.hostid) AS host_count
        FROM hstgrp g
        LEFT JOIN hosts_groups hg ON hg.groupid = g.groupid
        LEFT JOIN hosts h ON h.hostid = hg.hostid AND h.status IN (0, 1)
        GROUP BY g.groupid, g.name
        ORDER BY g.name
    """
    return query(sql)


def list_hosts_in_group(groupid: int, allowed_hostids=None) -> list[dict]:
    filt_sql, filt_params = _hostid_filter_sql("h", allowed_hostids)
    sql = f"""
        SELECT h.hostid, h.host, h.name, h.status
        FROM hosts h
        JOIN hosts_groups hg ON hg.hostid = h.hostid
        WHERE hg.groupid = %s AND h.status IN (0, 1)
          {filt_sql}
        ORDER BY h.name
    """
    return query(sql, (groupid, *filt_params))


def list_items_in_group(groupid: int, allowed_hostids=None) -> list[dict]:
    """Distinct item definitions (by key_) available on hosts in this
    group, with a count of how many hosts in the group have it.

    Includes both plain items (flags=0) and LLD-discovered items
    (flags=4). Excludes discovery rules (1) and prototypes (2).

    allowed_hostids, if given, restricts which hosts count toward
    both the item list and the host_count — items that only exist on
    hosts the caller can't see are left out entirely rather than just
    under-counted.
    """
    filt_sql, filt_params = _hostid_filter_sql("i", allowed_hostids)
    sql = f"""
        SELECT i.key_, i.name, i.value_type, i.units,
               COUNT(DISTINCT i.hostid) AS host_count
        FROM items i
        JOIN hosts_groups hg ON hg.hostid = i.hostid
        WHERE hg.groupid = %s
          AND i.status = 0
          AND i.flags IN (0, 4)
          {filt_sql}
        GROUP BY i.key_, i.name, i.value_type, i.units
        ORDER BY i.name
    """
    return query(sql, (groupid, *filt_params))


def list_all_hosts(allowed_hostids=None) -> list[dict]:
    """Every host, with the group names it belongs to shown for
    context. Powers the dashboard builder's host picker — dashboards
    are scoped to explicitly chosen hosts, not a whole group."""
    # Note: `groups` is a reserved word in MySQL — must be quoted.
    filt_sql, filt_params = _hostid_filter_sql("h", allowed_hostids)
    sql = f"""
        SELECT h.hostid, h.host, h.name, h.status,
               GROUP_CONCAT(DISTINCT g.name ORDER BY g.name SEPARATOR ', ') AS `groups`
        FROM hosts h
        LEFT JOIN hosts_groups hg ON hg.hostid = h.hostid
        LEFT JOIN hstgrp g ON g.groupid = hg.groupid
        WHERE h.status IN (0, 1)
          {filt_sql}
        GROUP BY h.hostid, h.host, h.name, h.status
        ORDER BY h.name
    """
    return query(sql, tuple(filt_params))


def list_hosts_by_ids(host_ids: list[int]) -> list[dict]:
    host_ids = [i for i in host_ids if i]
    if not host_ids:
        return []
    placeholders = ",".join(["%s"] * len(host_ids))
    sql = f"SELECT hostid, host, name FROM hosts WHERE hostid IN ({placeholders}) ORDER BY name"
    return query(sql, tuple(host_ids))


def list_hosts_with_items_by_ids(host_ids: list[int]) -> list[dict]:
    """Given an explicit list of hostids, return each host with its
    own full item list — powers the dashboard builder's per-host
    mapping grid once specific hosts have been chosen.

    Includes plain items (flags=0) and LLD-discovered items (flags=4).
    Discovery rules and prototypes are excluded — they have no history.
    """
    host_ids = [i for i in host_ids if i]
    if not host_ids:
        return []
    placeholders = ",".join(["%s"] * len(host_ids))
    hosts = query(
        f"SELECT hostid, host, name FROM hosts WHERE hostid IN ({placeholders}) ORDER BY name",
        tuple(host_ids),
    )
    rows = query(
        f"""
        SELECT itemid, hostid, key_, name, value_type, units, flags
        FROM items
        WHERE hostid IN ({placeholders})
          AND status = 0
          AND flags IN (0, 4)
        ORDER BY name, key_
        """,
        tuple(host_ids),
    )
    items_by_host: dict[int, list[dict]] = {}
    for r in rows:
        items_by_host.setdefault(r["hostid"], []).append(r)
    for h in hosts:
        h["items"] = items_by_host.get(h["hostid"], [])
    return hosts


def get_items_by_ids(item_ids: list[int]) -> list[dict]:
    """Fetch full item metadata (incl. retention settings, valuemap)
    for an explicit list of itemids — used when a dashboard column
    maps a specific item per host rather than a shared key."""
    item_ids = [i for i in item_ids if i]
    if not item_ids:
        return []
    placeholders = ",".join(["%s"] * len(item_ids))
    sql = f"""
        SELECT i.itemid, i.hostid, h.host, h.name AS host_name,
               i.name AS item_name, i.key_, i.value_type, i.units,
               i.history, i.trends, i.valuemapid
        FROM items i
        JOIN hosts h ON h.hostid = i.hostid
        WHERE i.itemid IN ({placeholders})
    """
    return query(sql, tuple(item_ids))


def resolve_report_items(groupid: int, item_keys: list[str], allowed_hostids=None) -> list[dict]:
    """For each selected item key, find the concrete item row (with
    itemid, hostid, retention settings, valuemap) on every host in the
    group that has it.

    Includes plain and LLD-discovered items (flags 0 and 4).
    """
    if not item_keys:
        return []
    placeholders = ",".join(["%s"] * len(item_keys))
    filt_sql, filt_params = _hostid_filter_sql("i", allowed_hostids)
    sql = f"""
        SELECT i.itemid, i.hostid, h.host, h.name AS host_name,
               i.name AS item_name, i.key_, i.value_type, i.units,
               i.history, i.trends, i.valuemapid
        FROM items i
        JOIN hosts_groups hg ON hg.hostid = i.hostid
        JOIN hosts h ON h.hostid = i.hostid
        WHERE hg.groupid = %s
          AND i.key_ IN ({placeholders})
          AND i.status = 0
          AND i.flags IN (0, 4)
          {filt_sql}
        ORDER BY i.name, h.name
    """
    return query(sql, (groupid, *item_keys, *filt_params))


def get_valuemaps(valuemapids: list[int]) -> dict[int, dict[str, str]]:
    """Return {valuemapid: {raw_value_str: mapped_label}}."""
    valuemapids = [v for v in valuemapids if v]
    if not valuemapids:
        return {}
    placeholders = ",".join(["%s"] * len(valuemapids))
    sql = f"""
        SELECT valuemapid, value, newvalue
        FROM valuemap_mapping
        WHERE valuemapid IN ({placeholders})
    """
    rows = query(sql, tuple(valuemapids))
    result: dict[int, dict[str, str]] = {}
    for row in rows:
        result.setdefault(row["valuemapid"], {})[row["value"]] = row["newvalue"]
    return result


# ── Problems ────────────────────────────────────────────────────────────────


# ── Problems ────────────────────────────────────────────────────────────────
# Open  = r_eventid IS NULL
# Closed = r_eventid IS NOT NULL
# Acknowledged = problem.acknowledged = 1

SEVERITY_LABELS = {
    0: "Not classified",
    1: "Information",
    2: "Warning",
    3: "Average",
    4: "High",
    5: "Disaster",
}


def list_problems(
    host_ids: list[int] | None = None,
    groupid: int | None = None,
    min_severity: int = 0,
    status: str = "open",          # open | closed | all
    ack: str = "all",              # all | acked | unacked
    severities: list[int] | None = None,  # if set, exact severity match (OR)
    include_suppressed: bool = True,
    limit: int = 2000,
) -> list[dict]:
    """Problems for hosts and/or a host group with status/ack filters.

    status: open (r_eventid IS NULL), closed (r_eventid IS NOT NULL), all
    ack:    all, acked (acknowledged=1), unacked (acknowledged<>1)
    """
    host_ids = [int(i) for i in (host_ids or []) if i]
    if not groupid and not host_ids:
        return []

    # status may be: open | closed | all | open_unack | open_ack
    # ack may be: all | acked | unacked (merged with status when combined modes used)
    status = (status or "open").lower()
    ack = (ack or "all").lower()

    if status == "open_unack":
        status, ack = "open", "unacked"
    elif status == "open_ack":
        status, ack = "open", "acked"

    if status not in ("open", "closed", "all"):
        status = "open"
    if ack not in ("all", "acked", "unacked"):
        ack = "all"

    params: list = [int(min_severity)]
    host_filter_sql = ""

    if host_ids:
        placeholders = ",".join(["%s"] * len(host_ids))
        host_filter_sql = f" AND h.hostid IN ({placeholders}) "
        params.extend(host_ids)
    elif groupid:
        host_filter_sql = (
            " AND h.hostid IN (SELECT hg.hostid FROM hosts_groups hg WHERE hg.groupid = %s) "
        )
        params.append(int(groupid))

    if status == "open":
        status_sql = " AND p.r_eventid IS NULL "
    elif status == "closed":
        status_sql = " AND p.r_eventid IS NOT NULL "
    else:
        status_sql = ""

    if ack == "acked":
        ack_sql = " AND p.acknowledged = 1 "
    elif ack == "unacked":
        ack_sql = " AND (p.acknowledged = 0 OR p.acknowledged IS NULL) "
    else:
        ack_sql = ""

    sev_sql = ""
    if severities:
        sev_list = sorted({int(s) for s in severities if 0 <= int(s) <= 5})
        if sev_list:
            sev_sql = " AND p.severity IN (" + ",".join(str(s) for s in sev_list) + ") "
            # min_severity still applied below; relax it when exact list given
            # by setting min filter to 0 via params[0]
            params[0] = 0

    # Suppressed events (Zabbix 5.4+ event_suppress). If table missing, ignore.
    suppress_sql = ""
    if not include_suppressed:
        suppress_sql = (
            " AND p.eventid NOT IN (SELECT es.eventid FROM event_suppress es) "
        )

    limit = max(1, min(int(limit or 2000), 5000))

    sql = f"""
        SELECT
            h.hostid,
            h.host,
            h.name AS host_name,
            p.eventid,
            p.clock,
            p.severity,
            p.name AS problem_name,
            p.acknowledged,
            p.r_eventid,
            t.triggerid,
            t.priority AS trigger_priority,
            t.description AS trigger_name
        FROM problem p
        JOIN triggers t ON p.objectid = t.triggerid
        JOIN functions f ON t.triggerid = f.triggerid
        JOIN items i ON f.itemid = i.itemid
        JOIN hosts h ON i.hostid = h.hostid
        WHERE p.source = 0
          AND p.object = 0
          AND p.severity >= %s
          {status_sql}
          {ack_sql}
          {sev_sql}
          {suppress_sql}
          {host_filter_sql}
        GROUP BY p.eventid, h.hostid
        ORDER BY p.clock DESC
        LIMIT {limit}
    """
    try:
        rows = query(sql, tuple(params))
    except Exception:
        sql2 = f"""
            SELECT DISTINCT
                h.hostid,
                h.host,
                h.name AS host_name,
                p.eventid,
                p.clock,
                p.severity,
                p.name AS problem_name,
                p.acknowledged,
                p.r_eventid,
                t.triggerid,
                t.priority AS trigger_priority,
                t.description AS trigger_name
            FROM problem p
            JOIN triggers t ON p.objectid = t.triggerid
            JOIN functions f ON t.triggerid = f.triggerid
            JOIN items i ON f.itemid = i.itemid
            JOIN hosts h ON i.hostid = h.hostid
            WHERE p.source = 0
              AND p.object = 0
              AND p.severity >= %s
              {status_sql}
              {ack_sql}
              {sev_sql}
              {suppress_sql}
              {host_filter_sql}
            ORDER BY p.clock DESC
            LIMIT {limit}
        """
        rows = query(sql2, tuple(params))

    seen = set()
    out = []
    for r in rows:
        key = (r.get("eventid"), r.get("hostid"))
        if key in seen:
            continue
        seen.add(key)
        sev = int(r.get("severity") or 0)
        r["severity_label"] = SEVERITY_LABELS.get(sev, str(sev))
        if not r.get("problem_name"):
            r["problem_name"] = r.get("trigger_name") or "—"
        is_open = r.get("r_eventid") is None
        r["problem_status"] = "Open" if is_open else "Closed"
        r["ack_status"] = "Acknowledged" if int(r.get("acknowledged") or 0) == 1 else "Unacknowledged"
        out.append(r)
    return out


# Back-compat alias
def list_active_problems(host_ids=None, groupid=None, min_severity=0):
    return list_problems(host_ids=host_ids, groupid=groupid, min_severity=min_severity, status="open", ack="all")


def problems_debug_counts(host_ids: list[int] | None = None, groupid: int | None = None) -> dict:
    host_ids = [int(i) for i in (host_ids or []) if i]
    info: dict = {}
    try:
        info["problem_table_total_rows"] = query("SELECT COUNT(*) AS c FROM problem")[0]["c"]
    except Exception as e:
        info["problem_table_total_rows"] = f"ERROR: {e}"
        return info
    info["open"] = query(
        "SELECT COUNT(*) AS c FROM problem WHERE source=0 AND object=0 AND r_eventid IS NULL"
    )[0]["c"]
    info["closed"] = query(
        "SELECT COUNT(*) AS c FROM problem WHERE source=0 AND object=0 AND r_eventid IS NOT NULL"
    )[0]["c"]
    info["acked"] = query(
        "SELECT COUNT(*) AS c FROM problem WHERE source=0 AND object=0 AND acknowledged=1"
    )[0]["c"]
    if host_ids:
        ph = ",".join(["%s"] * len(host_ids))
        info["open_for_hosts"] = query(
            f"""
            SELECT COUNT(DISTINCT p.eventid) AS c
            FROM problem p
            JOIN triggers t ON p.objectid = t.triggerid
            JOIN functions f ON t.triggerid = f.triggerid
            JOIN items i ON f.itemid = i.itemid
            JOIN hosts h ON i.hostid = h.hostid
            WHERE p.source=0 AND p.object=0 AND p.r_eventid IS NULL
              AND h.hostid IN ({ph})
            """,
            tuple(host_ids),
        )[0]["c"]
    if groupid:
        info["open_for_group"] = query(
            """
            SELECT COUNT(DISTINCT p.eventid) AS c
            FROM problem p
            JOIN triggers t ON p.objectid = t.triggerid
            JOIN functions f ON t.triggerid = f.triggerid
            JOIN items i ON f.itemid = i.itemid
            JOIN hosts h ON i.hostid = h.hostid
            JOIN hosts_groups hg ON hg.hostid = h.hostid
            WHERE p.source=0 AND p.object=0 AND p.r_eventid IS NULL
              AND hg.groupid = %s
            """,
            (int(groupid),),
        )[0]["c"]
    return info



def health_details() -> dict:
    """Lightweight counts for the status bar / health endpoint."""
    out = {"db": "reachable"}
    try:
        out["problem_open"] = query(
            "SELECT COUNT(*) AS c FROM problem WHERE source=0 AND object=0 AND r_eventid IS NULL"
        )[0]["c"]
        out["problem_total"] = query("SELECT COUNT(*) AS c FROM problem")[0]["c"]
    except Exception as e:
        out["problem_error"] = str(e)
    try:
        out["hosts_monitored"] = query(
            "SELECT COUNT(*) AS c FROM hosts WHERE status=0 AND flags IN (0,4)"
        )[0]["c"]
    except Exception:
        pass
    return out
