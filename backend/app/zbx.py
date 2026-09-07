"""
Zabbix-schema-specific logic.

Zabbix splits item values across several tables depending on
`items.value_type`, and only keeps raw values for a limited window
(`items.history`) before rolling numeric items into hourly `trends`
tables and expiring the raw rows entirely. This module centralizes
that knowledge so the rest of the app doesn't have to know about it.
"""
import re
import time
from dataclasses import dataclass

# Zabbix value_type -> (raw history table, trends table or None, is_numeric)
VALUE_TYPE_MAP = {
    0: {"label": "float", "history": "history", "trends": "trends", "numeric": True},
    1: {"label": "character", "history": "history_str", "trends": None, "numeric": False},
    2: {"label": "log", "history": "history_log", "trends": None, "numeric": False},
    3: {"label": "unsigned int", "history": "history_uint", "trends": "trends_uint", "numeric": True},
    4: {"label": "text", "history": "history_text", "trends": None, "numeric": False},
}

_DURATION_RE = re.compile(r"^(\d+)([smhdw]?)$")
_UNIT_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}


def parse_duration(value: str) -> int:
    """Parse a Zabbix duration string ('31d', '24h', '0', '3600') into seconds.

    Returns 0 if the value is '0', empty, or unparseable (treated as
    "no raw retention configured" -> caller should fall back to trends).
    """
    if value is None:
        return 0
    value = str(value).strip()
    if not value:
        return 0
    match = _DURATION_RE.match(value)
    if not match:
        return 0
    number, unit = match.groups()
    number = int(number)
    if unit:
        return number * _UNIT_SECONDS[unit]
    return number  # bare number = seconds


@dataclass
class SourceDecision:
    table: str          # table to query
    kind: str           # "raw" or "trend"
    numeric: bool


def resolve_source(value_type: int, history_setting: str, trends_setting: str,
                    date_from_ts: int, now_ts: int | None = None) -> SourceDecision:
    """Decide which table to read an item's values from for a report.

    Non-numeric items (string/log/text) only ever have raw history —
    Zabbix does not compute trends for them.

    Numeric items (float/uint) fall back to hourly trends whenever the
    requested start date is older than the item's configured raw
    history retention, since Zabbix will have already purged those
    raw rows.
    """
    meta = VALUE_TYPE_MAP.get(value_type, VALUE_TYPE_MAP[0])
    if now_ts is None:
        now_ts = int(time.time())

    if not meta["numeric"]:
        return SourceDecision(table=meta["history"], kind="raw", numeric=False)

    history_seconds = parse_duration(history_setting)
    cutoff = now_ts - history_seconds if history_seconds > 0 else now_ts

    if history_seconds > 0 and date_from_ts >= cutoff:
        return SourceDecision(table=meta["history"], kind="raw", numeric=True)

    trends_table = meta["trends"]
    if trends_table is None:
        # Shouldn't happen for numeric types, but guard anyway.
        return SourceDecision(table=meta["history"], kind="raw", numeric=True)
    return SourceDecision(table=trends_table, kind="trend", numeric=True)


def value_type_label(value_type: int) -> str:
    return VALUE_TYPE_MAP.get(value_type, {}).get("label", "unknown")
