import time
from ..db import query, MAX_RAW_POINTS
from .queries import resolve_report_items, get_items_by_ids, get_valuemaps
from .zbx import resolve_source, value_type_label
from .dashboard import _tod_sql_and_params

# Table names below are never user-supplied — they come only from
# zbx.resolve_source(), which picks from a fixed internal map. Safe
# to interpolate into SQL.
# {tod} is an optional time-of-day filter clause (same as dashboard.py).

RAW_NUMERIC_SQL = """
    SELECT clock, value FROM {table}
    WHERE itemid = %s AND clock BETWEEN %s AND %s{tod}
    ORDER BY clock LIMIT %s
"""

RAW_TEXT_SQL = """
    SELECT clock, value FROM {table}
    WHERE itemid = %s AND clock BETWEEN %s AND %s{tod}
    ORDER BY clock LIMIT %s
"""

TREND_SQL = """
    SELECT clock, value_min, value_avg, value_max FROM {table}
    WHERE itemid = %s AND clock BETWEEN %s AND %s{tod}
    ORDER BY clock LIMIT %s
"""

DAILY_FROM_RAW_SQL = """
    SELECT FLOOR(clock/86400)*86400 AS day_clock,
           MIN(value) AS value_min, AVG(value) AS value_avg, MAX(value) AS value_max
    FROM {table}
    WHERE itemid = %s AND clock BETWEEN %s AND %s{tod}
    GROUP BY day_clock ORDER BY day_clock LIMIT %s
"""

DAILY_FROM_TREND_SQL = """
    SELECT FLOOR(clock/86400)*86400 AS day_clock,
           MIN(value_min) AS value_min, AVG(value_avg) AS value_avg, MAX(value_max) AS value_max
    FROM {table}
    WHERE itemid = %s AND clock BETWEEN %s AND %s{tod}
    GROUP BY day_clock ORDER BY day_clock LIMIT %s
"""


def _series_for_item(item: dict, date_from_ts: int, date_to_ts: int, resolution: str,
                      vmap: dict, now_ts: int, warnings: list[str],
                      tod_sql: str = "", tod_params: tuple = ()) -> dict:
    """Build one series entry (points + metadata) for a single item row.

    `item` must have the shape returned by queries.resolve_report_items() /
    queries.get_items_by_ids() — itemid, host/host_name, item_name, key_,
    units, value_type, history, trends, valuemapid.

    Shared by build_report() (items resolved via a host group + key) and
    build_series_for_items() (items resolved directly by itemid, e.g. for
    a dashboard cell drill-down chart) so both stay consistent with the
    same raw-vs-trends fallback rules.

    Optional tod_sql / tod_params restrict samples to a wall-clock window
    each day (same filter used by dashboard pivot aggregates).
    """
    decision = resolve_source(
        value_type=item["value_type"],
        history_setting=item["history"],
        trends_setting=item["trends"],
        date_from_ts=date_from_ts,
        now_ts=now_ts,
    )

    points = []
    # Params order: itemid, from, to, [tod…], limit
    base = (item["itemid"], date_from_ts, date_to_ts) + tuple(tod_params)

    if not decision.numeric:
        rows = query(
            RAW_TEXT_SQL.format(table=decision.table, tod=tod_sql),
            base + (MAX_RAW_POINTS,),
        )
        if len(rows) == MAX_RAW_POINTS:
            warnings.append(
                f"{item['host_name']} / {item['item_name']}: truncated at "
                f"{MAX_RAW_POINTS} rows — narrow the date range for full data."
            )
        for r in rows:
            points.append({"clock": r["clock"], "value": r["value"]})

    elif resolution == "daily":
        sql = DAILY_FROM_RAW_SQL if decision.kind == "raw" else DAILY_FROM_TREND_SQL
        rows = query(
            sql.format(table=decision.table, tod=tod_sql),
            base + (MAX_RAW_POINTS,),
        )
        for r in rows:
            points.append({
                "clock": int(r["day_clock"]),
                "min": float(r["value_min"]), "avg": float(r["value_avg"]), "max": float(r["value_max"]),
            })

    elif decision.kind == "raw":
        rows = query(
            RAW_NUMERIC_SQL.format(table=decision.table, tod=tod_sql),
            base + (MAX_RAW_POINTS,),
        )
        if len(rows) == MAX_RAW_POINTS:
            warnings.append(
                f"{item['host_name']} / {item['item_name']}: truncated at "
                f"{MAX_RAW_POINTS} rows — narrow the date range or use daily resolution."
            )
        for r in rows:
            points.append({"clock": r["clock"], "value": float(r["value"])})

    else:  # native hourly trend
        rows = query(
            TREND_SQL.format(table=decision.table, tod=tod_sql),
            base + (MAX_RAW_POINTS,),
        )
        for r in rows:
            points.append({
                "clock": r["clock"],
                "min": float(r["value_min"]), "avg": float(r["value_avg"]), "max": float(r["value_max"]),
            })

    if vmap:
        for p in points:
            if "value" in p and p["value"] in vmap:
                p["label"] = vmap[p["value"]]

    return {
        "itemid": item["itemid"],
        "hostid": item["hostid"],
        "host": item["host_name"] or item["host"],
        "item_name": item["item_name"],
        "key_": item["key_"],
        "units": item["units"],
        "value_type": value_type_label(item["value_type"]),
        "source": decision.kind,       # 'raw' or 'trend'
        "aggregated": resolution == "daily" or decision.kind == "trend",
        "points": points,
    }


def build_report(groupid: int, item_keys: list[str], date_from_ts: int,
                  date_to_ts: int, resolution: str = "auto", allowed_hostids=None) -> dict:
    """resolution: 'auto' (raw or native hourly trend, whichever the
    retention window dictates), or 'daily' (force day-level min/avg/max).

    allowed_hostids restricts results to hosts the calling user is
    permitted to see in Zabbix (None = no restriction, for internal use).
    """
    items = resolve_report_items(groupid, item_keys, allowed_hostids=allowed_hostids)
    if not items:
        return {"series": [], "warnings": ["No matching items found on hosts in this group (or none are visible to your account)."]}

    valuemaps = get_valuemaps([i["valuemapid"] for i in items])
    now_ts = int(time.time())
    warnings: list[str] = []

    series = [
        _series_for_item(
            item, date_from_ts, date_to_ts, resolution,
            valuemaps.get(item["valuemapid"], {}) if item["valuemapid"] else {},
            now_ts, warnings,
        )
        for item in items
    ]

    if not any(s["points"] for s in series):
        warnings.append("No data points found in the selected date range for any item.")

    return {"series": series, "warnings": warnings}


def build_series_for_items(item_ids: list[int], date_from_ts: int, date_to_ts: int,
                            resolution: str = "auto", allowed_hostids=None,
                            day_time_from=None, day_time_to=None, tz_offset_min=None) -> dict:
    """Time series for an explicit list of itemids, regardless of host
    group membership — powers the dashboard pivot-cell drill-down chart,
    where a cell's item was chosen directly in the mapping grid rather
    than resolved from a shared key across a group.

    allowed_hostids, if given, drops any item on a host outside that set
    — callers (main.py) always pass the current user's permitted hostids,
    since get_items_by_ids() itself has no permission awareness (it's
    also used internally by dashboard.py after hostids are already
    filtered upstream; this function is reachable directly from an
    itemid supplied by the client, so it must filter itself).

    day_time_from / day_time_to (e.g. '08:00'–'18:00') restrict points to
    that wall-clock window each day, matching dashboard pivot aggregates.
    """
    items = get_items_by_ids(item_ids)
    if allowed_hostids is not None:
        allowed = set(int(h) for h in allowed_hostids)
        items = [it for it in items if int(it["hostid"]) in allowed]
    if not items:
        return {"series": [], "warnings": ["No matching items found (or none are visible to your account)."]}

    # Preserve the caller's requested order (chart tooltips read better
    # when a single-item request comes back as series[0]).
    by_id = {it["itemid"]: it for it in items}
    ordered = [by_id[i] for i in item_ids if i in by_id]

    valuemaps = get_valuemaps([i["valuemapid"] for i in ordered])
    now_ts = int(time.time())
    warnings: list[str] = []
    tod_sql, tod_params = _tod_sql_and_params(day_time_from, day_time_to, tz_offset_min)

    series = [
        _series_for_item(
            item, date_from_ts, date_to_ts, resolution,
            valuemaps.get(item["valuemapid"], {}) if item["valuemapid"] else {},
            now_ts, warnings,
            tod_sql=tod_sql, tod_params=tod_params,
        )
        for item in ordered
    ]

    if not any(s["points"] for s in series):
        warnings.append("No data points found in the selected date range.")
    if tod_sql:
        warnings.append(
            "Time-of-day filter active: %s – %s (local)." % (day_time_from or "?", day_time_to or "?")
        )

    return {"series": series, "warnings": warnings}
