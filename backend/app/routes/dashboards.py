"""Hosts, dashboards, pins, and related routes."""
from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Literal

import pymysql
from fastapi import APIRouter, HTTPException, Request, Query, Response
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response as FastResponse
from pydantic import BaseModel, Field

from .. import appdb, auth, zbx_api
from ..config import (
    APP_VERSION, TZ_OFFSET_MINUTES, MAX_RAW_POINTS,
    SESSION_COOKIE_NAME, COOKIE_SECURE, SESSION_COOKIE_MAX_AGE_DAYS,
)
from ..services import queries
from ..services.report import build_report, build_series_for_items
from ..services.dashboard import build_dashboard
from ..services.export import (
    report_to_csv, report_to_xlsx,
    dashboard_to_csv, dashboard_to_xlsx,
    problems_to_csv, problems_to_xlsx,
)
from ..services import metrics as zr_metrics
from ..schemas.models import *
from . import common
from .common import (
    _cookie_kwargs, _user_out, _session_token,
    _require_group_permission, _run, _annotate, _visible_list,
    _load_visible_or_404, _load_dashboard_or_404, _filter_to_permitted,
    _run_problems,
)

logger = logging.getLogger("zbxlens")
router = APIRouter()

@router.get("/api/hosts")
def api_all_hosts(request: Request):
    """Every host the caller can see (with its group names for
    context) — powers the dashboard builder's host picker."""
    user = auth.current_user(request)
    return queries.list_all_hosts(allowed_hostids=user["permitted_hostids"])


class HostsItemsRequest(BaseModel):
    hostids: list[int] = Field(min_length=1)


@router.post("/api/hosts-items")
def api_hosts_items(req: HostsItemsRequest, request: Request):
    """Given explicitly chosen hostids, return each host with its own
    full item list — powers the dashboard builder's per-host mapping
    grid. Hostids the caller isn't permitted to see are silently
    dropped rather than erroring, since the picker itself only ever
    offered permitted hosts."""
    user = auth.current_user(request)
    hostids = [h for h in req.hostids if h in user["permitted_hostids"]]
    return queries.list_hosts_with_items_by_ids(hostids)


class ItemsMetaRequest(BaseModel):
    itemids: list[int] = Field(min_length=1, max_length=500)


@router.post("/api/items/meta")
def api_items_meta(req: ItemsMetaRequest, request: Request):
    """Lightweight item labels for the dashboard builder (cross-host
    mapping). Only returns items whose host the caller can see."""
    user = auth.current_user(request)
    items = queries.get_items_by_ids(req.itemids)
    allowed = user["permitted_hostids"]
    out = []
    for it in items:
        if it.get("hostid") not in allowed:
            continue
        out.append({
            "itemid": it["itemid"],
            "hostid": it["hostid"],
            "host_name": it.get("host_name") or it.get("host") or "",
            "host": it.get("host") or "",
            "name": it.get("item_name") or it.get("name") or "",
            "key_": it.get("key_") or "",
            "units": it.get("units") or "",
        })
    return out



@router.get("/api/dashboards")
def list_dashboards(request: Request):
    user = auth.current_user(request)
    return _visible_list(appdb.list_dashboards(), user)


@router.get("/api/dashboards/{dash_id}")
def get_dashboard(dash_id: str, request: Request):
    return _load_visible_or_404(appdb.get_dashboard, dash_id, auth.current_user(request), "Dashboard")


@router.post("/api/dashboards")
def create_dashboard(d: DashboardDef, request: Request):
    user = auth.current_user(request)
    auth.require_admin(user)
    payload = d.model_dump()
    payload["owner_userid"] = user["userid"]
    payload["owner_username"] = user["username"]
    return _annotate(appdb.create_dashboard(payload), user)


@router.put("/api/dashboards/{dash_id}")
def update_dashboard(dash_id: str, d: DashboardDef, request: Request):
    user = auth.current_user(request)
    existing = appdb.get_dashboard(dash_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    if not auth.can_edit(existing, user):
        raise HTTPException(status_code=403, detail="Only the owner (or a Super Admin) can edit this dashboard.")
    updated = appdb.update_dashboard(dash_id, d.model_dump())
    return _annotate(updated, user)


@router.delete("/api/dashboards/{dash_id}")
def delete_dashboard(dash_id: str, request: Request):
    user = auth.current_user(request)
    existing = appdb.get_dashboard(dash_id)
    if existing and not auth.can_edit(existing, user):
        raise HTTPException(status_code=403, detail="Only the owner (or a Super Admin) can delete this dashboard.")
    appdb.delete_dashboard(dash_id)
    return {"ok": True}


# ── Pins ─────────────────────────────────────────────────────────────────────
# Personal to each signed-in user — a shared dashboard can be pinned by
# one viewer without affecting anyone else's list order, so this can't
# live as a flag on the dashboard/problem-dashboard row itself.

class PinRequest(BaseModel):
    item_type: Literal["dashboard", "problem_dashboard"]
    item_id: str
    pinned: bool


@router.get("/api/pins")
def api_list_pins(request: Request):
    user = auth.current_user(request)
    return appdb.list_pinned_ids(user["userid"])


@router.post("/api/pins")
def api_set_pin(req: PinRequest, request: Request):
    user = auth.current_user(request)
    appdb.set_pin(user["userid"], req.item_type, req.item_id, req.pinned)
    return {"ok": True}


def _load_dashboard_or_404(dash_id: str, user: dict) -> dict:
    return _load_visible_or_404(appdb.get_dashboard, dash_id, user, "Dashboard")


class AdhocDashboardRun(BaseModel):
    name: str = "adhoc"
    hostids: list[int] = Field(min_length=1)
    columns: list[DashboardColumn] = Field(min_length=1)
    date_from: int
    date_to: int
    day_time_from: str | None = None
    day_time_to: str | None = None
    tz_offset_min: int | None = None


def _filter_to_permitted(hostids: list[int], user: dict) -> tuple[list[int], list[str]]:
    permitted = [h for h in hostids if h in user["permitted_hostids"]]
    warnings = []
    dropped = len(hostids) - len(permitted)
    if dropped:
        warnings.append(f"{dropped} host(s) were left out — not visible to your Zabbix account.")
    return permitted, warnings


@router.post("/api/dashboards/run-adhoc")
def run_adhoc_dashboard(req: AdhocDashboardRun, request: Request):
    """Run a metric pivot without saving a dashboard definition."""
    user = auth.current_user(request)
    if req.date_to <= req.date_from:
        raise HTTPException(status_code=400, detail="date_to must be after date_from")
    hostids, warnings = _filter_to_permitted(req.hostids, user)
    if not hostids:
        return {"rows": [], "warnings": warnings or ["No permitted hosts in this selection."]}
    result = build_dashboard(hostids, [c.model_dump() for c in req.columns], req.date_from, req.date_to,
                            day_time_from=getattr(req, "day_time_from", None),
                            day_time_to=getattr(req, "day_time_to", None),
                            tz_offset_min=getattr(req, "tz_offset_min", None))
    result["warnings"] = warnings + result.get("warnings", [])
    return result


@router.post("/api/dashboards/{dash_id}/run")
def run_dashboard(dash_id: str, req: DashboardRunRequest, request: Request):
    user = auth.current_user(request)
    d = _load_dashboard_or_404(dash_id, user)
    if req.date_to <= req.date_from:
        raise HTTPException(status_code=400, detail="date_to must be after date_from")
    hostids, warnings = _filter_to_permitted(d["hostids"], user)
    if not hostids:
        return {"rows": [], "warnings": warnings or ["No permitted hosts in this dashboard."]}
    result = build_dashboard(hostids, d["columns"], req.date_from, req.date_to,
                            day_time_from=getattr(req, "day_time_from", None),
                            day_time_to=getattr(req, "day_time_to", None),
                            tz_offset_min=getattr(req, "tz_offset_min", None))
    result["warnings"] = warnings + result.get("warnings", [])
    return result


@router.post("/api/dashboards/{dash_id}/export.csv")
def export_dashboard_csv(dash_id: str, req: DashboardRunRequest, request: Request):
    user = auth.current_user(request)
    d = _load_dashboard_or_404(dash_id, user)
    hostids, _ = _filter_to_permitted(d["hostids"], user)
    result = build_dashboard(hostids, d["columns"], req.date_from, req.date_to,
                            day_time_from=getattr(req, "day_time_from", None),
                            day_time_to=getattr(req, "day_time_to", None),
                            tz_offset_min=getattr(req, "tz_offset_min", None))
    csv_bytes = dashboard_to_csv(d, result)
    return Response(
        content=csv_bytes,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=dashboard.csv"},
    )


@router.post("/api/dashboards/{dash_id}/export.xlsx")
def export_dashboard_xlsx(dash_id: str, req: DashboardRunRequest, request: Request):
    user = auth.current_user(request)
    d = _load_dashboard_or_404(dash_id, user)
    hostids, _ = _filter_to_permitted(d["hostids"], user)
    result = build_dashboard(hostids, d["columns"], req.date_from, req.date_to,
                            day_time_from=getattr(req, "day_time_from", None),
                            day_time_to=getattr(req, "day_time_to", None),
                            tz_offset_min=getattr(req, "tz_offset_min", None))
    xlsx_bytes = dashboard_to_xlsx(d, result)
    return Response(
        content=xlsx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=dashboard.xlsx"},
    )


# ── Problem dashboards ──────────────────────────────────────────────────────


