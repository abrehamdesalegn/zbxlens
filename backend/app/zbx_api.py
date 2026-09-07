"""
Thin client for the Zabbix frontend/server JSON-RPC API — used ONLY for
user login and permission lookups, never for report data (bulk history
reads stay on the direct MySQL connection; see report.py / dashboard.py).

Rationale: reusing Zabbix's own `user.login` means LDAP/SAML/MFA, account
lockout, and disabled users/groups all keep working exactly as they do in
Zabbix itself, and we never need to read or verify password hashes
ourselves. Reusing `hostgroup.get` / `host.get` (called with the *caller's
own* session token) means host-group and host permission filtering is
enforced by Zabbix's own, already-correct rights resolution — including
group nesting and the "explicit deny wins" rule — rather than a
reimplementation of it here.
"""
import itertools

import httpx

from .config import ZABBIX_API_URL, ZABBIX_API_TIMEOUT_SECONDS, ZABBIX_API_VERIFY_TLS

_id_counter = itertools.count(1)


class ZabbixAPIError(Exception):
    """Raised for both transport failures and JSON-RPC error responses."""


# Cached major.minor version float, e.g. 6.0, 6.4, 7.2, 8.0
_api_version: float | None = None


def get_api_version() -> float:
    """Return Zabbix API version as major.minor float (cached)."""
    global _api_version
    if _api_version is not None:
        return _api_version
    # apiinfo.version requires no authentication
    result = _rpc("apiinfo.version", {}, auth=None, _skip_version=True)
    ver_s = str(result or "0").strip()
    parts = ver_s.split(".")
    try:
        major = int(parts[0]) if parts else 0
        minor = int(parts[1]) if len(parts) > 1 else 0
        _api_version = float(f"{major}.{minor}")
    except (TypeError, ValueError):
        _api_version = 0.0
    return _api_version


def _rpc(method: str, params: dict, auth: str | None = None, _skip_version: bool = False):
    if not ZABBIX_API_URL:
        raise ZabbixAPIError(
            "ZABBIX_API_URL is not configured — set it in backend/.env to enable login."
        )
    payload = {
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
        "id": next(_id_counter),
    }
    headers = {"Content-Type": "application/json-rpc"}

    # Auth transport differs across Zabbix versions:
    #   < 6.4  : body "auth" (Bearer often ignored / stripped by proxies)
    #   6.4–7.0: both work; body "auth" is safest for Apache/nginx setups
    #   >= 7.2 : body "auth" removed — Authorization: Bearer only
    if auth:
        ver = 0.0
        if not _skip_version:
            try:
                ver = get_api_version()
            except ZabbixAPIError:
                ver = 0.0
        if ver >= 7.2:
            headers["Authorization"] = f"Bearer {auth}"
        elif ver >= 6.4:
            # Dual auth: Bearer preferred by docs; body still accepted until 7.2
            headers["Authorization"] = f"Bearer {auth}"
            payload["auth"] = auth
        else:
            # Zabbix 6.0 / 6.2 and older — body auth only
            payload["auth"] = auth

    try:
        resp = httpx.post(
            ZABBIX_API_URL,
            json=payload,
            headers=headers,
            timeout=ZABBIX_API_TIMEOUT_SECONDS,
            verify=ZABBIX_API_VERIFY_TLS,
        )
        resp.raise_for_status()
        data = resp.json()
    except httpx.HTTPError as e:
        raise ZabbixAPIError(f"Cannot reach Zabbix API at {ZABBIX_API_URL}: {e}") from e
    except ValueError as e:
        raise ZabbixAPIError("Zabbix API returned a non-JSON response") from e

    if "error" in data:
        err = data["error"]
        detail = err.get("data") or err.get("message") or "Zabbix API error"
        raise ZabbixAPIError(str(detail))
    return data.get("result")


def login(username: str, password: str) -> str:
    """Returns a Zabbix session token, or raises ZabbixAPIError.

    Parameter name changed over time:
      - Zabbix <= 5.2 / some 6.0 builds: "user"
      - Zabbix >= 6.0 (docs) / required from 6.4: "username"
    Try "username" first, fall back to "user".
    """
    # Prime version cache (best-effort) so later calls use the right auth style
    try:
        get_api_version()
    except ZabbixAPIError:
        pass

    last_err: ZabbixAPIError | None = None
    for key in ("username", "user"):
        try:
            result = _rpc("user.login", {key: username, "password": password})
            if result and isinstance(result, str):
                return result
            raise ZabbixAPIError("Unexpected response from Zabbix API during login")
        except ZabbixAPIError as e:
            last_err = e
            msg = str(e).lower()
            # Only retry alternate key on parameter-name errors
            if "unexpected parameter" in msg or "invalid parameter" in msg:
                continue
            raise
    raise last_err or ZabbixAPIError("Login failed")


def logout(token: str) -> None:
    try:
        _rpc("user.logout", {}, auth=token)
    except ZabbixAPIError:
        pass  # best-effort — local session is deleted regardless


def _normalize_role(role) -> dict:
    if isinstance(role, list):
        role = role[0] if role else {}
    return role if isinstance(role, dict) else {}


def _resolve_role_type(user: dict, role: dict) -> tuple[int, str]:
    """Map Zabbix role → 1=User, 2=Admin, 3=Super Admin."""
    role = _normalize_role(role)
    role_name = str(role.get("name") or "").strip()
    raw = None
    if role.get("type") is not None and role.get("type") != "":
        raw = role.get("type")
    elif user.get("type") is not None and user.get("type") != "":
        raw = user.get("type")
    try:
        role_type = int(raw) if raw is not None else 0
    except (TypeError, ValueError):
        role_type = 0
    if role_type not in (1, 2, 3):
        role_type = 0
    # Built-in roleids: 1=User, 2=Admin, 3=Super admin (default Zabbix install)
    try:
        roleid = int(role.get("roleid") or user.get("roleid") or 0)
    except (TypeError, ValueError):
        roleid = 0
    if role_type == 0 and roleid in (1, 2, 3):
        role_type = roleid
    # Name-based rescue for custom roles
    name_l = role_name.lower()
    if role_type in (0, 1) and name_l:
        if "super" in name_l:
            role_type = 3
        elif "admin" in name_l:
            role_type = 2
    if role_type not in (1, 2, 3):
        role_type = 1
    return role_type, role_name


def get_current_user(token: str) -> dict:
    """The logged-in user's own record, including role type
    (1=User, 2=Admin, 3=Super Admin).

    Important: Admin accounts can see many users via user.get; always
    resolve *this* session's userid first so we don't pick result[0]
    from a multi-user list (which incorrectly mapped Admins as User).
    """
    userid = None
    # 1) Preferred: checkAuthentication → exact session user
    try:
        me = _rpc("user.checkAuthentication", {"sessionid": token})
        if isinstance(me, dict) and me.get("userid") is not None:
            userid = int(me["userid"])
    except ZabbixAPIError:
        me = None

    # 2) user.get for that userid (or unfiltered as last resort)
    params = {
        "output": ["userid", "username", "name", "surname", "roleid"],
        "selectRole": "extend",
    }
    if userid is not None:
        params["userids"] = [userid]
    result = _rpc("user.get", params, auth=token)
    if not result:
        raise ZabbixAPIError("Could not resolve the logged-in Zabbix user")

    user = result[0]
    if userid is not None:
        for u in result:
            try:
                if int(u.get("userid")) == userid:
                    user = u
                    break
            except (TypeError, ValueError):
                pass
    elif me and isinstance(me, dict) and me.get("username"):
        # Match by username if we only got a list
        uname = str(me.get("username") or "")
        for u in result:
            if str(u.get("username") or "") == uname:
                user = u
                break

    role = _normalize_role(user.get("role"))
    # role.get fallback when selectRole is sparse
    if not role.get("type") and not role.get("name"):
        roleid = user.get("roleid") or role.get("roleid")
        if roleid:
            try:
                roles = _rpc(
                    "role.get",
                    {"roleids": [roleid], "output": ["roleid", "name", "type"]},
                    auth=token,
                )
                if roles:
                    role = _normalize_role(roles[0])
            except ZabbixAPIError:
                pass

    role_type, role_name = _resolve_role_type(user, role)
    return {
        "userid": int(user["userid"]),
        "username": (user.get("username") or "").strip(),
        "name": user.get("name") or "",
        "surname": user.get("surname") or "",
        "role_name": role_name,
        "role_type": role_type,
    }


def get_permitted_groupids(token: str) -> set[int]:
    """Host groups readable by the token's owner. Zabbix filters this
    list itself — Super Admins get every group, regular users get only
    what their user groups' rights grant them."""
    result = _rpc("hostgroup.get", {"output": ["groupid"]}, auth=token)
    return {int(g["groupid"]) for g in (result or [])}


def get_permitted_hostids(token: str) -> set[int]:
    """Hosts readable by the token's owner, per Zabbix's own permission
    resolution (accounts for a host belonging to multiple groups with
    different/conflicting rights, which a simple per-group check can't)."""
    result = _rpc("host.get", {"output": ["hostid"]}, auth=token)
    return {int(h["hostid"]) for h in (result or [])}



def get_user_usrgrpids(token: str) -> set[int]:
    """Zabbix user-group IDs the logged-in user belongs to."""
    result = _rpc(
        "user.get",
        {
            "output": ["userid"],
            "selectUsrgrps": ["usrgrpid"],
        },
        auth=token,
    )
    if not result:
        return set()
    grps = result[0].get("usrgrps") or []
    return {int(g["usrgrpid"]) for g in grps if g.get("usrgrpid") is not None}


def list_users(token: str, usrgrpids: set[int] | list[int] | None = None) -> list[dict]:
    """Zabbix users for share pickers.

    If usrgrpids is provided, only users who belong to at least one of
    those user groups are returned (used for non–Super Admin callers).
    Super Admins pass usrgrpids=None to list everyone visible to them.
    """
    params: dict = {
        "output": ["userid", "username", "name", "surname"],
        "sortfield": "username",
    }
    if usrgrpids is not None:
        ids = [int(x) for x in usrgrpids]
        if not ids:
            return []
        params["usrgrpids"] = ids
    result = _rpc("user.get", params, auth=token)
    out = []
    for u in result or []:
        out.append({
            "userid": int(u["userid"]),
            "username": u.get("username") or "",
            "name": u.get("name") or "",
            "surname": u.get("surname") or "",
            "label": (
                ((u.get("name") or "") + " " + (u.get("surname") or "")).strip()
                or u.get("username")
                or str(u["userid"])
            )
            + " (" + (u.get("username") or "") + ")",
        })
    return out


def list_usrgrps(token: str, usrgrpids: set[int] | list[int] | None = None) -> list[dict]:
    """Zabbix user groups for share pickers.

    If usrgrpids is provided, only those groups are returned (caller's
    own memberships). Super Admins pass None for the full list.
    """
    params: dict = {
        "output": ["usrgrpid", "name"],
        "sortfield": "name",
    }
    if usrgrpids is not None:
        ids = [int(x) for x in usrgrpids]
        if not ids:
            return []
        params["usrgrpids"] = ids
    result = _rpc("usergroup.get", params, auth=token)
    return [
        {"usrgrpid": int(g["usrgrpid"]), "name": g.get("name") or str(g["usrgrpid"])}
        for g in (result or [])
    ]


# event.acknowledge action bitmask (Zabbix 6.0+):
#   1  = close problem
#   2  = acknowledge event
#   4  = add message
#   8  = change severity
#   16 = unacknowledge event
#   32 = suppress
#   64 = unsuppress
ACTION_CLOSE = 1
ACTION_ACK = 2
ACTION_MESSAGE = 4
ACTION_UNACK = 16


def event_acknowledge(
    token: str,
    eventids: list[int],
    *,
    acknowledge: bool = False,
    close: bool = False,
    unacknowledge: bool = False,
    message: str = "",
) -> dict:
    """Acknowledge / close / message one or more problem events under
    the caller's Zabbix identity. Rights are enforced by Zabbix itself
    (a User without problem-update rights gets a clear API error)."""
    ids = sorted({int(e) for e in eventids if e is not None})
    if not ids:
        raise ZabbixAPIError("No eventids provided")

    action = 0
    if close:
        action |= ACTION_CLOSE
    if acknowledge:
        action |= ACTION_ACK
    if unacknowledge:
        action |= ACTION_UNACK
    if message:
        action |= ACTION_MESSAGE

    if action == 0:
        raise ZabbixAPIError("Nothing to do — pick acknowledge, close, and/or a message")

    params: dict = {
        "eventids": ids,
        "action": action,
    }
    if message:
        params["message"] = message

    result = _rpc("event.acknowledge", params, auth=token)
    return {"eventids": ids, "action": action, "result": result}
