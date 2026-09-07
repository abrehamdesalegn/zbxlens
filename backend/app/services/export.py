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


def _problems_to_dataframe(problems: list[dict]):
    rows = []
    for p in problems or []:
        rows.append({
            "severity": p.get("severity_label") or p.get("severity"),
            "severity_code": p.get("severity"),
            "status": p.get("problem_status") or ("Open" if p.get("r_eventid") is None else "Closed"),
            "acknowledged": p.get("ack_status") or ("Acknowledged" if int(p.get("acknowledged") or 0) == 1 else "Unacknowledged"),
            "host": p.get("host_name") or p.get("host") or "",
            "problem": p.get("problem_name") or p.get("trigger_name") or "",
            "trigger": p.get("trigger_name") or "",
            "eventid": p.get("eventid"),
            "triggerid": p.get("triggerid"),
            "since_utc": (
                datetime.fromtimestamp(int(p["clock"]), tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
                if p.get("clock") else ""
            ),
            "age_seconds": p.get("age_seconds"),
        })
    return pd.DataFrame(rows)


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
