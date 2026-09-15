"""
Computes a dashboard "pivot table": rows = explicitly chosen hosts,
columns = user-defined metrics, cells = period aggregates
(avg/min/max/last) rather than a time series.

Each column maps a *specific item per host* (col['host_items'] =
{hostid: itemid}) — the same metric (e.g. "CPU usage") is frequently a
different item key on different host templates, so the mapping is
explicit rather than inferred from a shared key or a host group.

Optional day_time_from / day_time_to restrict each day to a wall-clock
window (e.g. 08:00–18:00 business hours) inside the overall date range.
Times are interpreted in the caller's timezone via tz_offset_min
(JavaScript Date.getTimezoneOffset()).

This reuses the same raw-vs-trends resolution logic as the time-series
report (zbx.resolve_source), just aggregated down to single numbers
per host/column instead of a list of points.
"""
import time
from ..db import query
from .queries import list_hosts_by_ids, get_items_by_ids, get_valuemaps
from .zbx import resolve_source

RAW_AGG_SQL = "SELECT AVG(value) a, MIN(value) mn, MAX(value) mx FROM {table} WHERE itemid = %s AND clock BETWEEN %s AND %s{tod}"
RAW_LAST_SQL = "SELECT value v FROM {table} WHERE itemid = %s AND clock BETWEEN %s AND %s{tod} ORDER BY clock DESC LIMIT 1"

TREND_AGG_SQL = "SELECT AVG(value_avg) a, MIN(value_min) mn, MAX(value_max) mx FROM {table} WHERE itemid = %s AND clock BETWEEN %s AND %s{tod}"
TREND_LAST_SQL = "SELECT value_avg v FROM {table} WHERE itemid = %s AND clock BETWEEN %s AND %s{tod} ORDER BY clock DESC LIMIT 1"

TEXT_LAST_SQL = "SELECT value v FROM {table} WHERE itemid = %s AND clock BETWEEN %s AND %s{tod} ORDER BY clock DESC LIMIT 1"


def _parse_hhmm(s):
    """'08:00' or '8:00:00' → seconds from midnight. None if empty/invalid."""
    if not s or not str(s).strip():
        return None
    parts = str(s).strip().split(":")
    try:
        h = int(parts[0])
        m = int(parts[1]) if len(parts) > 1 else 0
        if h < 0 or h > 23 or m < 0 or m > 59:
            return None
        return h * 3600 + m * 60
    except (TypeError, ValueError):
        return None


def _tod_sql_and_params(day_time_from, day_time_to, tz_offset_min):
    """
    Build AND-clause that keeps only samples whose local time-of-day
    falls inside [from, to).

    local_tod = (clock - tz_offset_min*60) mod 86400
    (matches JavaScript: unix - getTimezoneOffset()*60)
    """
    start = _parse_hhmm(day_time_from)
    end = _parse_hhmm(day_time_to)
    if start is None or end is None or start == end:
        return "", ()

    off = int(tz_offset_min) if tz_offset_min is not None else 0
    local_expr = "MOD(clock - (%s) + 864000, 86400)"
    off_secs = off * 60

    if start < end:
        # e.g. 08:00–18:00
        clause = " AND " + local_expr + " >= %s AND " + local_expr + " < %s"
        return clause, (off_secs, start, off_secs, end)
    # Overnight window e.g. 22:00–06:00
    clause = " AND (" + local_expr + " >= %s OR " + local_expr + " < %s)"
    return clause, (off_secs, start, off_secs, end)


def _compute_cell(item, date_from, date_to, aggregations, now_ts, tod_sql="", tod_params=()):
    decision = resolve_source(
        value_type=item["value_type"],
        history_setting=item["history"],
        trends_setting=item["trends"],
        date_from_ts=date_from,
        now_ts=now_ts,
    )
    values = {}
    base_params = (item["itemid"], date_from, date_to) + tuple(tod_params)

    if not decision.numeric:
        rows = query(TEXT_LAST_SQL.format(table=decision.table, tod=tod_sql), base_params)
        last = rows[0]["v"] if rows else None
        for agg in aggregations:
            values[agg] = last if agg == "last" else None
        return values, decision.kind

    agg_sql = RAW_AGG_SQL if decision.kind == "raw" else TREND_AGG_SQL
    last_sql = RAW_LAST_SQL if decision.kind == "raw" else TREND_LAST_SQL

    if any(a in aggregations for a in ("avg", "min", "max")):
        rows = query(agg_sql.format(table=decision.table, tod=tod_sql), base_params)
        row = rows[0] if rows else {}
        if "avg" in aggregations:
            values["avg"] = float(row["a"]) if row.get("a") is not None else None
        if "min" in aggregations:
            values["min"] = float(row["mn"]) if row.get("mn") is not None else None
        if "max" in aggregations:
            values["max"] = float(row["mx"]) if row.get("mx") is not None else None

    if "last" in aggregations:
        rows = query(last_sql.format(table=decision.table, tod=tod_sql), base_params)
        values["last"] = float(rows[0]["v"]) if rows else None

    return values, decision.kind


def build_dashboard(hostids, columns, date_from, date_to,
                    day_time_from=None, day_time_to=None, tz_offset_min=None):
    now_ts = int(time.time())
    hosts = list_hosts_by_ids(hostids)
    tod_sql, tod_params = _tod_sql_and_params(day_time_from, day_time_to, tz_offset_min)

    all_item_ids = set()
    for col in columns:
        for itemid in (col.get("host_items") or {}).values():
            if itemid:
                all_item_ids.add(int(itemid))

    items = get_items_by_ids(list(all_item_ids))
    items_by_id = {it["itemid"]: it for it in items}

    rows = []
    for h in hosts:
        host_label = h["name"] or h["host"]
        row = {"host": host_label, "hostid": h["hostid"], "cells": {}}
        for col in columns:
            host_items = col.get("host_items") or {}
            itemid = host_items.get(str(h["hostid"])) or host_items.get(h["hostid"])
            item = items_by_id.get(int(itemid)) if itemid else None
            if not item:
                row["cells"][col["id"]] = None
                continue
            raw_values, kind = _compute_cell(
                item, date_from, date_to, col["aggregations"], now_ts,
                tod_sql=tod_sql, tod_params=tod_params,
            )
            mult = col.get("multiplier") or 1
            scaled = {
                agg: (v * mult if isinstance(v, (int, float)) else v)
                for agg, v in raw_values.items()
            }
            row["cells"][col["id"]] = {
                "values": scaled,
                "source": kind,
                "units": ("" if col.get("raw") else (col.get("unit") or item.get("units") or "")),
            }
        rows.append(row)

    mapped_any = any(
        (col.get("host_items") or {}) for col in columns
    )
    warnings = [] if mapped_any else ["No items are mapped yet — edit this dashboard to map an item per host."]
    if tod_sql:
        warnings.append(
            "Time-of-day filter active: %s – %s (local)." % (day_time_from or "?", day_time_to or "?")
        )
    return {"rows": rows, "warnings": warnings}
