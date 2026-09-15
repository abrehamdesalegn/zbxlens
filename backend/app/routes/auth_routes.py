"""Auth and Zabbix directory routes."""
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

@router.post("/api/auth/login")
def api_login(req: LoginRequest, response: Response):
    try:
        session_id, user = auth.login(req.username.strip(), req.password)
    except zbx_api.ZabbixAPIError as e:
        raise HTTPException(status_code=401, detail=str(e))
    response.set_cookie(
        value=session_id,
        max_age=SESSION_COOKIE_MAX_AGE_DAYS * 86400,
        **_cookie_kwargs(),
    )
    # Also return session id in body so the UI can send X-Session-Token
    # when Secure cookies are unavailable (plain HTTP).
    return {"user": _user_out(user), "session": session_id}


@router.post("/api/auth/logout")
def api_logout(request: Request, response: Response):
    session_id = request.cookies.get(SESSION_COOKIE_NAME)
    if session_id:
        auth.logout(session_id)
    response.delete_cookie(key=SESSION_COOKIE_NAME, path="/")
    return {"ok": True}





@router.get("/api/zbx/users")
def api_zbx_users(request: Request):
    """Zabbix users for the share picker.

    Super Admins see all users. Everyone else only sees users who share
    at least one Zabbix user group with them.
    """
    user = auth.current_user(request)
    sess = _session_token(request)
    if not sess:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        if user.get("is_superadmin"):
            return zbx_api.list_users(sess)
        return zbx_api.list_users(sess, usrgrpids=user.get("usrgrpids") or [])
    except zbx_api.ZabbixAPIError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/api/zbx/usrgrps")
def api_zbx_usrgrps(request: Request):
    """Zabbix user groups for the share picker.

    Super Admins see all groups. Everyone else only sees groups they
    belong to.
    """
    user = auth.current_user(request)
    sess = _session_token(request)
    if not sess:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        if user.get("is_superadmin"):
            return zbx_api.list_usrgrps(sess)
        return zbx_api.list_usrgrps(sess, usrgrpids=user.get("usrgrpids") or [])
    except zbx_api.ZabbixAPIError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/api/auth/me")
def api_me(request: Request):
    user = auth.current_user(request)
    return {"user": _user_out(user)}


# ── Host groups / hosts / items (all scoped to the caller's Zabbix rights) ──

