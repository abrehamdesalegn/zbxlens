"""Health, config, and docs routes."""
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

@router.get("/api/health/live")
def health_live():
    """Liveness: process is up (no dependency checks)."""
    return {"status": "live", "version": APP_VERSION}


@router.get("/api/health/ready")
def health_ready():
    """Readiness: Zabbix MySQL is reachable."""
    try:
        queries.query("SELECT 1")
        return {"status": "ready", "db": "reachable", "version": APP_VERSION}
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Database unreachable: {e}")


@router.get("/api/health")
def health(request: Request):
    """Basic DB reachability for everyone; connection details only for Super Admins."""
    from .. import db as dbmod
    import time as _time

    # Optional session — health stays public; connection details are Super Admin only
    user = getattr(request.state, "user", None)
    is_superadmin = bool(user and user.get("is_superadmin"))

    conn_info = {
        "host": dbmod.DB_HOST,
        "port": dbmod.DB_PORT,
        "database": dbmod.DB_NAME,
        "user": dbmod.DB_USER,
    }
    try:
        t0 = _time.perf_counter()
        if is_superadmin:
            row = queries.query(
                "SELECT 1 AS ok, DATABASE() AS db_name, @@version AS server_version"
            )
        else:
            row = queries.query("SELECT 1 AS ok")
        latency_ms = round((_time.perf_counter() - t0) * 1000, 1)
        out = {
            "status": "ok",
            "db": "reachable",
            "version": APP_VERSION,
            "latency_ms": latency_ms,
        }
        if is_superadmin:
            detail = {}
            try:
                detail = queries.health_details()
            except Exception:
                pass
            server_version = (row[0].get("server_version") if row else None) or None
            db_name = (row[0].get("db_name") if row else None) or dbmod.DB_NAME
            out["connection"] = {**conn_info, "database": db_name}
            out["server_version"] = server_version
            out.update(detail)
        return out
    except pymysql.err.OperationalError as e:
        detail = {"message": f"Database unreachable: {e}"}
        if is_superadmin:
            detail["connection"] = conn_info
        raise HTTPException(status_code=503, detail=detail)
    except Exception as e:
        detail = {"message": f"Database unreachable: {e}"}
        if is_superadmin:
            detail["connection"] = conn_info
        raise HTTPException(status_code=503, detail=detail)


@router.get("/metrics")
def prometheus_metrics():
    """Prometheus text exposition format (no auth — restrict via network policy)."""
    import sqlite3
    from pathlib import Path as _Path
    gauges: dict[str, float] = {}
    try:
        path = _Path(appdb.DB_PATH)
        if path.exists():
            gauges["zr_appdb_bytes"] = float(path.stat().st_size)
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)
            try:
                cur = con.cursor()
                for table, gname in (
                    ("sessions", "zr_sessions"),
                    ("dashboards", "zr_dashboards"),
                    ("problem_dashboards", "zr_problem_dashboards"),
                    ("presets", "zr_presets"),
                ):
                    try:
                        cur.execute(f"SELECT COUNT(*) FROM {table}")
                        gauges[gname] = float(cur.fetchone()[0])
                    except Exception:
                        pass
            finally:
                con.close()
    except Exception:
        pass
    body = zr_metrics.render_prometheus(gauges)
    return PlainTextResponse(body, media_type="text/plain; version=0.0.4; charset=utf-8")


@router.get("/api/config")
def api_config():
    """Public config the frontend needs before a user has logged in."""
    return {
        "version": APP_VERSION,
        "tz_offset_minutes": TZ_OFFSET_MINUTES,
        "max_raw_points": MAX_RAW_POINTS,
    }


# ── Auth (Zabbix login) ──────────────────────────────────────────────────────

