import io
from datetime import datetime, timezone
import pandas as pd


def _report_to_dataframe(report: dict) -> pd.DataFrame:
    rows = []
    for s in report["series"]:
        for p in s["points"]:
            ts = datetime.fromtimestamp(p["clock"], tz=timezone.utc)
            base = {
                "host": s["host"],
                "item": s["item_name"],
                "key": s["key_"],
                "units": s["units"],
                "timestamp_utc": ts.strftime("%Y-%m-%d %H:%M:%S"),
            }
            if "value" in p:
                base["value"] = p.get("label", p["value"])
            else:
                base["min"] = p["min"]
                base["avg"] = p["avg"]
                base["max"] = p["max"]
            rows.append(base)
    return pd.DataFrame(rows)


def report_to_csv(report: dict) -> bytes:
    df = _report_to_dataframe(report)
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    return buf.getvalue().encode("utf-8")


def report_to_xlsx(report: dict) -> bytes:
    df = _report_to_dataframe(report)
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        if df.empty:
            df = pd.DataFrame([{"note": "No data in selected range"}])
        df.to_excel(writer, index=False, sheet_name="Report")
        ws = writer.sheets["Report"]
        for col_cells in ws.columns:
            length = max(len(str(c.value)) if c.value is not None else 0 for c in col_cells)
            ws.column_dimensions[col_cells[0].column_letter].width = min(max(length + 2, 10), 40)
    return buf.getvalue()


def _dashboard_to_dataframe(dashboard: dict, result: dict) -> pd.DataFrame:
    columns = dashboard["columns"]
    col_tuples = [("Host", "")]
    for col in columns:
        for agg in col["aggregations"]:
            col_tuples.append((col["label"], agg))

    data = []
    for row in result["rows"]:
        record = [row["host"]]
        for col in columns:
            cell = row["cells"].get(col["id"])
            for agg in col["aggregations"]:
                if not cell or cell["values"].get(agg) is None:
                    record.append(None)
                else:
                    record.append(round(cell["values"][agg], col.get("decimals", 1)))
        data.append(record)

    return pd.DataFrame(data, columns=pd.MultiIndex.from_tuples(col_tuples))


def dashboard_to_csv(dashboard: dict, result: dict) -> bytes:
    df = _dashboard_to_dataframe(dashboard, result)
    buf = io.StringIO()
    df.to_csv(buf)
    return buf.getvalue().encode("utf-8")


def dashboard_to_xlsx(dashboard: dict, result: dict) -> bytes:
    df = _dashboard_to_dataframe(dashboard, result)
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="Dashboard")
        ws = writer.sheets["Dashboard"]
        for col_cells in ws.columns:
            length = max(len(str(c.value)) if c.value is not None else 0 for c in col_cells)
            ws.column_dimensions[col_cells[0].column_letter].width = min(max(length + 2, 10), 30)
    return buf.getvalue()


def _format_age(seconds) -> str:
    """Human-readable age, e.g. 3d 5h, 59d 3h, 49m."""
    try:
        s = int(seconds or 0)
    except (TypeError, ValueError):
        return ""
    if s < 0:
        s = 0
    days, rem = divmod(s, 86400)
    hours, rem = divmod(rem, 3600)
    mins, _ = divmod(rem, 60)
    parts = []
    if days:
        parts.append(f"{days}d")
    if hours or days:
        parts.append(f"{hours}h")
    if not days:
        parts.append(f"{mins}m")
    return " ".join(parts) if parts else "0m"


def _problems_to_dataframe(problems: list[dict]):
    """
    Columns (snake_case):
      host, severity, problem, status, acknowledged, since, age
    `since` is wall time in UTC+3.
    """
    from datetime import timedelta
    tz_plus3 = timezone(timedelta(hours=3))
    rows = []
    for p in problems or []:
        is_acked = int(p.get("acknowledged") or 0) == 1 or (
            str(p.get("ack_status") or "").lower().startswith("ack")
            and "unack" not in str(p.get("ack_status") or "").lower()
        )
        age_sec = p.get("age_seconds")
        problem_text = (p.get("problem_name") or p.get("trigger_name") or "").strip()
        since = ""
        if p.get("clock"):
            since = datetime.fromtimestamp(int(p["clock"]), tz=tz_plus3).strftime("%Y-%m-%d %H:%M:%S")
        rows.append({
            "host": p.get("host_name") or p.get("host") or "",
            "severity": p.get("severity_label") or p.get("severity") or "",
            "problem": problem_text,
            "status": p.get("problem_status") or ("Open" if p.get("r_eventid") is None else "Closed"),
            "acknowledged": "ACK" if is_acked else "UNACK",
            "since": since,
            "age": _format_age(age_sec),
        })
    cols = ["host", "severity", "problem", "status", "acknowledged", "since", "age"]
    return pd.DataFrame(rows, columns=cols)


def problems_to_csv(problems: list[dict]) -> bytes:
    df = _problems_to_dataframe(problems)
    buf = io.StringIO()
    if df.empty:
        df = pd.DataFrame([{"note": "No problems matched"}])
    df.to_csv(buf, index=False)
    return buf.getvalue().encode("utf-8")


def problems_to_xlsx(problems: list[dict]) -> bytes:
    df = _problems_to_dataframe(problems)
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        if df.empty:
            df = pd.DataFrame([{"note": "No problems matched"}])
        df.to_excel(writer, index=False, sheet_name="Problems")
        ws = writer.sheets["Problems"]
        for col_cells in ws.columns:
            length = max(len(str(c.value)) if c.value is not None else 0 for c in col_cells)
            ws.column_dimensions[col_cells[0].column_letter].width = min(max(length + 2, 10), 48)
    return buf.getvalue()
