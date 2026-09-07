"""Shared helpers used by multiple route modules."""
from __future__ import annotations

import time

from fastapi import HTTPException, Request

from .. import appdb, auth
from ..config import SESSION_COOKIE_NAME, COOKIE_SECURE
from ..services.report import build_report
from ..services import queries
from ..schemas.models import ReportRequest


def _cookie_kwargs() -> dict:
    return dict(
        key=SESSION_COOKIE_NAME,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


def _user_out(user: dict) -> dict:
    """Trim the internal user context down to what the frontend needs —
    never include the Zabbix session token or raw permission id sets."""
    return {
        "userid": user["userid"],
        "username": user["username"],
        "name": user["name"],
        "surname": user["surname"],
        "role_type": user["role_type"],
        "role_label": user["role_label"],
        "is_admin": user["is_admin"],
        "is_superadmin": user["is_superadmin"],
        "permitted_group_count": len(user["permitted_groupids"]),
        "permitted_host_count": len(user["permitted_hostids"]),
    }


def _session_token(request: Request) -> str | None:
    """Zabbix API token for the current reporter session (for share pickers)."""
    sid = request.cookies.get(SESSION_COOKIE_NAME) or request.headers.get("X-Session-Token") or ""
    if not sid:
        auth_h = request.headers.get("Authorization") or ""
        if auth_h.lower().startswith("bearer "):
            sid = auth_h[7:].strip()
    if not sid:
        return None
    sess = appdb.get_session(sid)
    return sess["zbx_token"] if sess else None


def _require_group_permission(groupid: int, user: dict) -> None:
    if groupid not in user["permitted_groupids"]:
        raise HTTPException(status_code=403, detail="You don't have access to this host group in Zabbix.")


def _run(req: ReportRequest, user: dict) -> dict:
    if req.date_to <= req.date_from:
        raise HTTPException(status_code=400, detail="date_to must be after date_from")
    _require_group_permission(req.groupid, user)
    return build_report(
        req.groupid, req.item_keys, req.date_from, req.date_to, req.resolution,
        allowed_hostids=user["permitted_hostids"],
    )


def _annotate(item: dict, user: dict) -> dict:
    item = dict(item)
    item["mine"] = item.get("owner_userid") == user["userid"]
    item["can_edit"] = auth.can_edit(item, user)
    return item


def _visible_list(items: list[dict], user: dict) -> list[dict]:
    return [_annotate(i, user) for i in items if auth.can_view(i, user)]


def _load_visible_or_404(getter, item_id: str, user: dict, label: str) -> dict:
    item = getter(item_id)
    if not item or not auth.can_view(item, user):
        raise HTTPException(status_code=404, detail=f"{label} not found")
    return _annotate(item, user)


def _load_dashboard_or_404(dash_id: str, user: dict) -> dict:
    return _load_visible_or_404(appdb.get_dashboard, dash_id, user, "Dashboard")


def _filter_to_permitted(hostids: list[int], user: dict) -> tuple[list[int], list[str]]:
    """Intersect requested hostids with the caller's Zabbix permissions."""
    permitted_set = set(user["permitted_hostids"])
    requested = [int(h) for h in hostids]
    permitted = [h for h in requested if h in permitted_set]
    warnings: list[str] = []
    if len(permitted) < len(requested):
        warnings.append(
            f"{len(requested) - len(permitted)} host(s) were left out — not visible to your Zabbix account."
        )
    return permitted, warnings


def _run_problems(
    hostids: list[int],
    groupid: int | None,
    min_severity: int,
    user: dict,
    status: str = "open",
    ack: str = "all",
    severities: list[int] | None = None,
    include_suppressed: bool = True,
) -> dict:
    if not hostids and not groupid:
        raise HTTPException(status_code=400, detail="Provide hostids and/or groupid")
    if min_severity < 0 or min_severity > 5:
        raise HTTPException(status_code=400, detail="min_severity must be 0..5")
    status = (status or "open").lower()
    ack = (ack or "all").lower()
    allowed_status = {"open", "closed", "all", "open_unack", "open_ack"}
    allowed_ack = {"all", "acked", "unacked"}
    if status not in allowed_status:
        raise HTTPException(status_code=400, detail=f"status must be one of {sorted(allowed_status)}")
    if ack not in allowed_ack:
        raise HTTPException(status_code=400, detail=f"ack must be one of {sorted(allowed_ack)}")

    warnings: list[str] = []
    if groupid is not None:
        _require_group_permission(groupid, user)
    if hostids:
        hostids, warnings = _filter_to_permitted(hostids, user)
        if not hostids and not groupid:
            return {"problems": [], "count": 0, "status": status, "ack": ack, "warnings": warnings}

    rows = queries.list_problems(
        host_ids=hostids or None,
        groupid=groupid,
        min_severity=min_severity,
        status=status,
        ack=ack,
        severities=severities,
        include_suppressed=include_suppressed,
    )
    permitted = user["permitted_hostids"]
    rows = [r for r in rows if r.get("hostid") in permitted]
    now = int(time.time())
    for r in rows:
        clock = int(r.get("clock") or 0)
        r["age_seconds"] = max(0, now - clock) if clock else None
    return {"problems": rows, "count": len(rows), "status": status, "ack": ack, "warnings": warnings}
