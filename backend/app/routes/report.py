"""Report, host groups, items series, and presets routes."""
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

@router.get("/api/hostgroups")
def api_hostgroups(request: Request):
    user = auth.current_user(request)
    try:
        groups = queries.list_hostgroups()
    except pymysql.err.OperationalError as e:
        raise HTTPException(status_code=503, detail=f"Database unreachable: {e}")
    return [g for g in groups if g["groupid"] in user["permitted_groupids"]]


def _require_group_permission(groupid: int, user: dict) -> None:
    if groupid not in user["permitted_groupids"]:
        raise HTTPException(status_code=403, detail="You don't have access to this host group in Zabbix.")


@router.get("/api/hostgroups/{groupid}/hosts")
def api_group_hosts(groupid: int, request: Request):
    user = auth.current_user(request)
    _require_group_permission(groupid, user)
    return queries.list_hosts_in_group(groupid, allowed_hostids=user["permitted_hostids"])


@router.get("/api/hostgroups/{groupid}/items")
def api_group_items(groupid: int, request: Request):
    user = auth.current_user(request)
    _require_group_permission(groupid, user)
    return queries.list_items_in_group(groupid, allowed_hostids=user["permitted_hostids"])



@router.post("/api/report")
def api_report(req: ReportRequest, request: Request):
    return _run(req, auth.current_user(request))


@router.post("/api/report/export.csv")
def api_report_export_csv(req: ReportRequest, request: Request):
    report = _run(req, auth.current_user(request))
    csv_bytes = report_to_csv(report)
    return Response(
        content=csv_bytes,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=zabbix_report.csv"},
    )


@router.post("/api/report/export.xlsx")
def api_report_export_xlsx(req: ReportRequest, request: Request):
    report = _run(req, auth.current_user(request))
    xlsx_bytes = report_to_xlsx(report)
    return Response(
        content=xlsx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=zabbix_report.xlsx"},
    )


class ItemSeriesRequest(BaseModel):
    itemids: list[int] = Field(min_length=1, max_length=40)
    date_from: int
    date_to: int
    resolution: Literal["auto", "daily"] = "auto"
    # Optional wall-clock window each day (matches dashboard pivot HOURS filter)
    day_time_from: str | None = None
    day_time_to: str | None = None
    tz_offset_min: int | None = None


@router.post("/api/items/series")
def api_items_series(req: ItemSeriesRequest, request: Request):
    """Time series for one or more itemids picked directly (not via a
    host group + key). Powers the dashboard pivot-cell drill-down chart:
    a cell maps a specific item on a specific host, so it's looked up by
    itemid rather than resolved from a shared key across a group.

    Every returned item is checked against the caller's own permitted
    hostids — get_items_by_ids() has no permission awareness by itself,
    so this endpoint is the enforcement point for that (unlike the
    dashboard-run endpoints, which only ever iterate hosts already
    filtered upstream, this one takes an itemid straight from the
    client and must not trust it).

    day_time_from / day_time_to restrict points to that local time window
    each day (same semantics as the dashboard HOURS preset).
    """
    user = auth.current_user(request)
    if req.date_to <= req.date_from:
        raise HTTPException(status_code=400, detail="date_to must be after date_from")
    try:
        return build_series_for_items(
            req.itemids, req.date_from, req.date_to, req.resolution,
            allowed_hostids=user["permitted_hostids"],
            day_time_from=req.day_time_from,
            day_time_to=req.day_time_to,
            tz_offset_min=req.tz_offset_min,
        )
    except pymysql.err.OperationalError as e:
        raise HTTPException(status_code=503, detail=f"Database unreachable: {e}")


# ── Saved-item visibility helpers ────────────────────────────────────────────
# Presets, dashboards, and problem dashboards share the same rule set:
#   - only Zabbix Admin/Super Admin accounts may create/edit/delete them
#   - an item is visible if you own it, it's marked shared, or you're a
#     Super Admin (who can see and manage everything, same as in Zabbix)
#   - editing/deleting still requires being the owner (or Super Admin) —
#     being an Admin grants the *capability*, not blanket access to
#     everyone else's private items
#   - *running* a visible item is open to any logged-in user regardless
#     of role; results are still filtered to the runner's own permitted
#     hosts, never the saved item's creator's


@router.get("/api/presets")
def list_presets(request: Request):
    user = auth.current_user(request)
    return _visible_list(appdb.list_presets(), user)


@router.get("/api/presets/{preset_id}")
def get_preset(preset_id: str, request: Request):
    return _load_visible_or_404(appdb.get_preset, preset_id, auth.current_user(request), "Preset")


@router.post("/api/presets")
def create_preset(p: PresetDef, request: Request):
    user = auth.current_user(request)
    auth.require_admin(user)
    payload = p.model_dump()
    payload["owner_userid"] = user["userid"]
    payload["owner_username"] = user["username"]
    return _annotate(appdb.create_preset(payload), user)


@router.put("/api/presets/{preset_id}")
def update_preset(preset_id: str, p: PresetDef, request: Request):
    user = auth.current_user(request)
    existing = appdb.get_preset(preset_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Preset not found")
    if not auth.can_edit(existing, user):
        raise HTTPException(status_code=403, detail="Only the owner (or a Super Admin) can edit this preset.")
    updated = appdb.update_preset(preset_id, p.model_dump())
    return _annotate(updated, user)


@router.delete("/api/presets/{preset_id}")
def delete_preset(preset_id: str, request: Request):
    user = auth.current_user(request)
    existing = appdb.get_preset(preset_id)
    if existing and not auth.can_edit(existing, user):
        raise HTTPException(status_code=403, detail="Only the owner (or a Super Admin) can delete this preset.")
    appdb.delete_preset(preset_id)
    return {"ok": True}



