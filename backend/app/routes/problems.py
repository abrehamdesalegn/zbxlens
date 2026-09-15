"""Problems and problem-dashboard routes."""
from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Literal

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
from ..db import db_operational_errors, DbError
from .common import (
    _cookie_kwargs, _user_out, _session_token,
    _require_group_permission, _run, _annotate, _visible_list,
    _load_visible_or_404, _load_dashboard_or_404, _filter_to_permitted,
    _run_problems,
)

logger = logging.getLogger("zbxlens")
router = APIRouter()

@router.get("/api/problems/debug")
def api_problems_debug_get(request: Request, groupid: int | None = None, min_severity: int = 0):
    """Easy diagnostic: open in browser or curl without a JSON body."""
    user = auth.current_user(request)
    if groupid is not None:
        _require_group_permission(groupid, user)
    try:
        return queries.problems_debug_counts(host_ids=None, groupid=groupid)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Debug query failed: {e}")


@router.post("/api/problems/debug")
def api_problems_debug(req: ProblemsRequest, request: Request):
    """Diagnostic counts — use this when the problems list is empty."""
    user = auth.current_user(request)
    if req.groupid is not None:
        _require_group_permission(req.groupid, user)
    hostids, _ = _filter_to_permitted(req.hostids, user) if req.hostids else ([], [])
    try:
        return queries.problems_debug_counts(
            host_ids=hostids or None,
            groupid=req.groupid,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Debug query failed: {e}")


@router.post("/api/problems")
def api_problems(req: ProblemsRequest, request: Request):
    """Ad-hoc run: current open problems for hosts/group."""
    user = auth.current_user(request)
    try:
        return _run_problems(
            req.hostids, req.groupid, req.min_severity, user,
            status=req.status,
            ack=getattr(req, "ack", "all") or "all",
            severities=getattr(req, "severities", None),
            include_suppressed=getattr(req, "include_suppressed", True),
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Problems query failed: {e}")


@router.get("/api/problem-dashboards")
def list_problem_dashboards(request: Request):
    user = auth.current_user(request)
    return _visible_list(appdb.list_problem_dashboards(), user)


@router.get("/api/problem-dashboards/{dash_id}")
def get_problem_dashboard(dash_id: str, request: Request):
    return _load_visible_or_404(appdb.get_problem_dashboard, dash_id, auth.current_user(request), "Problem dashboard")


@router.post("/api/problem-dashboards")
def create_problem_dashboard(d: ProblemDashDef, request: Request):
    user = auth.current_user(request)
    auth.require_admin(user)
    if not d.hostids and not d.groupid:
        raise HTTPException(status_code=400, detail="Select hosts or a host group")
    payload = d.model_dump()
    payload["owner_userid"] = user["userid"]
    payload["owner_username"] = user["username"]
    return _annotate(appdb.create_problem_dashboard(payload), user)


@router.put("/api/problem-dashboards/{dash_id}")
def update_problem_dashboard(dash_id: str, d: ProblemDashDef, request: Request):
    user = auth.current_user(request)
    existing = appdb.get_problem_dashboard(dash_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Problem dashboard not found")
    if not auth.can_edit(existing, user):
        raise HTTPException(status_code=403, detail="Only the owner (or a Super Admin) can edit this problem dashboard.")
    if not d.hostids and not d.groupid:
        raise HTTPException(status_code=400, detail="Select hosts or a host group")
    updated = appdb.update_problem_dashboard(dash_id, d.model_dump())
    return _annotate(updated, user)


@router.delete("/api/problem-dashboards/{dash_id}")
def delete_problem_dashboard(dash_id: str, request: Request):
    user = auth.current_user(request)
    existing = appdb.get_problem_dashboard(dash_id)
    if existing and not auth.can_edit(existing, user):
        raise HTTPException(status_code=403, detail="Only the owner (or a Super Admin) can delete this problem dashboard.")
    appdb.delete_problem_dashboard(dash_id)
    return {"ok": True}


@router.post("/api/problem-dashboards/{dash_id}/run")
def run_problem_dashboard(dash_id: str, request: Request):
    user = auth.current_user(request)
    d = _load_visible_or_404(appdb.get_problem_dashboard, dash_id, user, "Problem dashboard")
    try:
        return _run_problems(
            d.get("hostids") or [],
            d.get("groupid"),
            int(d.get("min_severity") or 0),
            user,
            status=d.get("status") or "open",
            ack=d.get("ack") or "all",
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Problems query failed: {e}")



class ProblemActionRequest(BaseModel):
    eventids: list[int] = Field(min_length=1)
    acknowledge: bool = False
    close: bool = False
    unacknowledge: bool = False
    message: str = ""


@router.post("/api/problems/acknowledge")
def api_problems_acknowledge(req: ProblemActionRequest, request: Request):
    """Acknowledge, unacknowledge, and/or close problem events via the
    Zabbix API under the caller's own identity. Zabbix enforces rights
    (a User without problem-update permission gets a clear error)."""
    user = auth.current_user(request)
    token = auth.get_zbx_token(request)
    if not (req.acknowledge or req.close or req.unacknowledge or req.message.strip()):
        raise HTTPException(status_code=400, detail="Pick acknowledge, close, unacknowledge, and/or a message")
    try:
        result = zbx_api.event_acknowledge(
            token,
            req.eventids,
            acknowledge=req.acknowledge,
            close=req.close,
            unacknowledge=req.unacknowledge,
            message=(req.message or "").strip(),
        )
        return {"ok": True, "user": user["username"], **result}
    except zbx_api.ZabbixAPIError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/api/problems/export.csv")
def api_problems_export_csv(req: ProblemsRequest, request: Request):
    user = auth.current_user(request)
    data = _run_problems(
        req.hostids, req.groupid, req.min_severity, user,
        status=req.status, ack=getattr(req, "ack", "all") or "all",
        severities=getattr(req, "severities", None),
        include_suppressed=getattr(req, "include_suppressed", True),
    )
    body = problems_to_csv(data.get("problems") or [])
    return Response(
        content=body,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="problems.csv"'},
    )


@router.post("/api/problems/export.xlsx")
def api_problems_export_xlsx(req: ProblemsRequest, request: Request):
    user = auth.current_user(request)
    data = _run_problems(
        req.hostids, req.groupid, req.min_severity, user,
        status=req.status, ack=getattr(req, "ack", "all") or "all",
        severities=getattr(req, "severities", None),
        include_suppressed=getattr(req, "include_suppressed", True),
    )
    body = problems_to_xlsx(data.get("problems") or [])
    return Response(
        content=body,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="problems.xlsx"'},
    )



