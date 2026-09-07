"""
Session lifecycle built on top of zbx_api.py.

Login/logout and per-user host/group visibility are delegated entirely
to the real Zabbix API (see zbx_api.py for why). This module just wires
that into an HTTP session: a random opaque cookie value that maps to a
row in appdb's `sessions` table, which caches the user's identity, role,
and permitted group/host ids so most requests don't need a Zabbix API
round-trip.
"""
import secrets
import time

from fastapi import HTTPException, Request
from starlette.concurrency import run_in_threadpool
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from . import appdb, zbx_api
from .config import PERMISSION_CACHE_TTL_SECONDS, SESSION_IDLE_TTL_MINUTES, SESSION_COOKIE_NAME

# Zabbix's own role.type values (role.get / user.get selectRole).
ROLE_USER = 1
ROLE_ADMIN = 2
ROLE_SUPERADMIN = 3

# Paths reachable without a session — the frontend shell, the bits it
# needs to decide whether to show the login screen, and logout (so a
# stale/expired cookie can always be cleared instead of 401ing).
_PUBLIC_PATHS = {"/api/auth/login", "/api/auth/logout", "/api/health", "/api/health/live", "/api/health/ready", "/api/config", "/metrics"}


def _is_public(path: str) -> bool:
    if path in _PUBLIC_PATHS:
        return True
    return not path.startswith("/api/")  # index.html, /static/*


def login(username: str, password: str) -> tuple[str, dict]:
    """Full login flow: authenticate against Zabbix, resolve the user's
    role and permitted groups/hosts, and open a local session.

    Returns (session_id, user_dict) or raises zbx_api.ZabbixAPIError.
    """
    if not username or not password:
        raise zbx_api.ZabbixAPIError("Username and password are required")

    token = zbx_api.login(username, password)
    user = zbx_api.get_current_user(token)
    # Always surface the identifier typed at the login form (LDAP/SSO/local)
    if username and username.strip():
        user["username"] = username.strip()
    groupids = zbx_api.get_permitted_groupids(token)
    hostids = zbx_api.get_permitted_hostids(token)
    try:
        usrgrpids = zbx_api.get_user_usrgrpids(token)
    except Exception:
        usrgrpids = set()
    user["usrgrpids"] = sorted(usrgrpids)

    session_id = secrets.token_urlsafe(32)
    now = int(time.time())
    expires_at = now + SESSION_IDLE_TTL_MINUTES * 60
    appdb.create_session(session_id, user, token, expires_at, groupids, hostids, usrgrpids)
    appdb.delete_expired_sessions()  # opportunistic housekeeping

    return session_id, _public_user(user, groupids, hostids)


def logout(session_id: str) -> None:
    sess = appdb.get_session(session_id)
    if sess:
        zbx_api.logout(sess["zbx_token"])
        appdb.delete_session(session_id)


def resolve_session(session_id: str) -> dict | None:
    """Validate a session id, refreshing the cached Zabbix permissions
    if stale. Returns a user context dict, or None if the session is
    missing/expired/no longer valid in Zabbix."""
    sess = appdb.get_session(session_id)
    if not sess:
        return None
    now = int(time.time())
    if sess["expires_at"] < now:
        appdb.delete_session(session_id)
        return None

    groupids, hostids = sess["permitted_groupids"], sess["permitted_hostids"]
    role_type = sess["role_type"]
    if now - sess["permissions_cached_at"] > PERMISSION_CACHE_TTL_SECONDS:
        try:
            groupids = zbx_api.get_permitted_groupids(sess["zbx_token"])
            hostids = zbx_api.get_permitted_hostids(sess["zbx_token"])
            appdb.update_session_permissions(session_id, groupids, hostids, now)
            # Re-resolve role (fixes sessions created under older mapping bugs)
            try:
                fresh = zbx_api.get_current_user(sess["zbx_token"])
                if fresh.get("role_type") is not None:
                    role_type = int(fresh["role_type"])
                    appdb.update_session_role(session_id, role_type)
            except Exception:
                pass
        except zbx_api.ZabbixAPIError:
            # Zabbix session likely expired/logged out server-side —
            # force re-login rather than serving stale permissions.
            appdb.delete_session(session_id)
            return None

    expires_at = now + SESSION_IDLE_TTL_MINUTES * 60
    appdb.touch_session(session_id, expires_at)

    return _public_user(
        {
            "userid": sess["userid"], "username": sess["username"],
            "name": sess["name"], "surname": sess["surname"], "role_type": role_type,
            "usrgrpids": sorted(sess.get("usrgrpids") or []),
        },
        groupids, hostids,
    )


def _public_user(user: dict, groupids: set[int], hostids: set[int]) -> dict:
    role_type = int(user["role_type"])
    return {
        "userid": user["userid"],
        "username": user["username"],
        "name": user.get("name") or "",
        "surname": user.get("surname") or "",
        "role_type": role_type,
        "role_label": {1: "User", 2: "Admin", 3: "Super Admin"}.get(role_type, "User"),
        "is_admin": role_type >= ROLE_ADMIN,
        "is_superadmin": role_type >= ROLE_SUPERADMIN,
        "usrgrpids": [int(x) for x in (user.get("usrgrpids") or [])],
        "permitted_groupids": groupids,
        "permitted_hostids": hostids,
    }


# ── FastAPI wiring ───────────────────────────────────────────────────────────

class SessionAuthMiddleware(BaseHTTPMiddleware):
    """Populates request.state.user from the session cookie. Blocking
    work (SQLite + occasional Zabbix API call) is pushed to a thread so
    it doesn't stall the event loop for other requests."""

    async def dispatch(self, request: Request, call_next):
        request.state.user = None
        path = request.url.path
        session_id = request.cookies.get(SESSION_COOKIE_NAME) or ""
        if not session_id:
            session_id = request.headers.get("X-Session-Token") or ""
        if not session_id:
            auth_h = request.headers.get("Authorization") or ""
            if auth_h.lower().startswith("bearer "):
                session_id = auth_h[7:].strip()

        request.state.session_id = session_id or None
        if session_id:
            user = await run_in_threadpool(resolve_session, session_id)
            request.state.user = user

        if not _is_public(path) and not request.state.user:
            return JSONResponse(status_code=401, content={"detail": "Not authenticated"})

        return await call_next(request)


def current_user(request: Request) -> dict:
    """FastAPI dependency for routes that need the logged-in user. The
    middleware already enforces auth on /api/* routes, so this mainly
    gives handlers a typed, convenient accessor."""
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def get_zbx_token(request: Request) -> str:
    """Return the Zabbix API session token for the current request.
    Used for write actions (acknowledge, close) that must go through
    the real Zabbix API under the caller's identity."""
    session_id = getattr(request.state, "session_id", None) or ""
    if not session_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    sess = appdb.get_session(session_id)
    if not sess or not sess.get("zbx_token"):
        raise HTTPException(status_code=401, detail="Session expired — please sign in again")
    return sess["zbx_token"]


def require_admin(user: dict) -> None:
    if not user.get("is_admin"):
        raise HTTPException(
            status_code=403,
            detail="Only Zabbix Admin or Super Admin accounts can create or manage saved items.",
        )


def can_view(item: dict, user: dict) -> bool:
    if user.get("is_superadmin"):
        return True
    if item.get("owner_userid") == user.get("userid"):
        return True
    # Share with everyone (legacy flag)
    if item.get("is_shared"):
        return True
    # Specific Zabbix users
    shared_users = set(int(x) for x in (item.get("shared_userids") or []))
    if user.get("userid") in shared_users:
        return True
    # Specific Zabbix user groups
    shared_grps = set(int(x) for x in (item.get("shared_usrgrpids") or []))
    my_grps = set(int(x) for x in (user.get("usrgrpids") or []))
    if shared_grps and my_grps and (shared_grps & my_grps):
        return True
    return False


def can_edit(item: dict, user: dict) -> bool:
    if not user.get("is_admin"):
        return False
    return item.get("owner_userid") == user["userid"] or user["is_superadmin"]
