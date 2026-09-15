"""
Thin client for the Zabbix frontend/server JSON-RPC API — used ONLY for
user login and permission lookups, never for report data (bulk history
reads stay on the direct DB connection (MySQL or PostgreSQL); see report.py / dashboard.py).

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
    # application/json is accepted by Zabbix 5.x–8.x; json-rpc alone can fail on some proxies
    headers = {"Content-Type": "application/json"}

    # Auth transport differs across Zabbix versions:
    #   < 6.4  : body "auth" only (Bearer not supported / may break some setups)
    #   6.4–7.0: both work; body "auth" is safest behind Apache/nginx
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
      - Zabbix >= 5.4 / 6.x docs: "username"
    Always try both keys so Zabbix 6 and 8 both work.
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
            # Some builds wrap the token
            if isinstance(result, dict) and result.get("sessionid"):
                return str(result["sessionid"])
            raise ZabbixAPIError("Unexpected response from Zabbix API during login")
        except ZabbixAPIError as e:
            last_err = e
            msg = str(e).lower()
            # Retry alternate key on parameter-name errors OR generic auth failures
            # (some 6.x builds reject unknown params as "Not authorized")
            if any(
                s in msg
                for s in (
                    "unexpected parameter",
                    "invalid parameter",
                    "invalid params",
                    "not authorized",
                    "unknown parameter",
                )
            ):
                continue
            raise
    # Prefer a clear message for the common Zabbix 6 misconfiguration
    msg = str(last_err or "Login failed")
    low = msg.lower()
    if "not authorized" in low or "incorrect" in low or "login" in low:
        raise ZabbixAPIError(
            f"{msg}. On Zabbix 6, check: (1) username/password, "
            f"(2) User group → Frontend access = Enabled, "
            f"(3) User group → API access = Enabled (Administration → User groups)."
        )
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

    Compatible with Zabbix 6.0–8.x (username vs alias, selectRole optional).
    """
    userid = None
    me = None
    # 1) Preferred: checkAuthentication → exact session user
    #    sessionid in params is enough on most versions; also pass auth for 6.x
    for kwargs in (
        {"params": {"sessionid": token}, "auth": None},
        {"params": {"sessionid": token}, "auth": token},
    ):
        try:
            me = _rpc("user.checkAuthentication", kwargs["params"], auth=kwargs["auth"])
            if isinstance(me, dict) and me.get("userid") is not None:
                userid = int(me["userid"])
                break
        except ZabbixAPIError:
            me = None

    # 2) user.get — output fields differ by version:
    #    Zabbix 8 / 7.x: userid, username, name, surname, roleid (no alias, no type)
    #    Zabbix 6.x:     username preferred; alias may still exist on some builds
    #    Very old:       alias instead of username; type instead of role
    def _user_get(output_fields, with_role: bool):
        params = {"output": list(output_fields)}
        if with_role:
            params["selectRole"] = "extend"
        if userid is not None:
            params["userids"] = [userid]
        return _rpc("user.get", params, auth=token)

    ver = 0.0
    try:
        ver = get_api_version()
    except ZabbixAPIError:
        ver = 0.0

    # Prefer modern fields first (works on 6.4+ and required on 7.2/8)
    field_sets = [
        ["userid", "username", "name", "surname", "roleid"],
    ]
    if ver < 7.0:
        # Older 6.x may still expose alias / legacy type
        field_sets.append(["userid", "username", "alias", "name", "surname", "roleid"])
        field_sets.append(["userid", "alias", "name", "surname", "type"])
    # Always keep a minimal last-resort set
    field_sets.append(["userid", "username", "name", "surname"])
    field_sets.append(["userid", "name", "surname"])

    result = None
    last_err: ZabbixAPIError | None = None
    for fields in field_sets:
        for with_role in (True, False):
            try:
                result = _user_get(fields, with_role=with_role)
                last_err = None
                break
            except ZabbixAPIError as e:
                last_err = e
                msg = str(e).lower()
                if any(s in msg for s in (
                    "invalid parameter", "invalid params",
                    "unexpected parameter", "not authorized",
                )):
                    continue
                raise
        if result is not None:
            break
    if result is None and last_err is not None:
        raise last_err

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
    elif me and isinstance(me, dict):
        uname = str(me.get("username") or me.get("alias") or "")
        if uname:
            for u in result:
                if str(u.get("username") or u.get("alias") or "") == uname:
                    user = u
                    break

    role = _normalize_role(user.get("role"))
    # role.get fallback when selectRole is sparse / unavailable
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
    uname = (user.get("username") or user.get("alias") or "").strip()
    if not uname and me and isinstance(me, dict):
        uname = str(me.get("username") or me.get("alias") or "").strip()
    return {
        "userid": int(user["userid"]),
        "username": uname,
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
        "sortfield": "userid",
    }
    if usrgrpids is not None:
        ids = [int(x) for x in usrgrpids]
        if not ids:
            return []
        params["usrgrpids"] = ids
    try:
        result = _rpc("user.get", params, auth=token)
    except ZabbixAPIError:
        # Older servers: try alias instead of username
        params = {
            "output": ["userid", "alias", "name", "surname"],
            "sortfield": "userid",
        }
        if usrgrpids is not None:
            params["usrgrpids"] = [int(x) for x in usrgrpids]
        result = _rpc("user.get", params, auth=token)
    out = []
    for u in result or []:
        uname = u.get("username") or u.get("alias") or ""
        out.append({
            "userid": int(u["userid"]),
            "username": uname,
            "name": u.get("name") or "",
            "surname": u.get("surname") or "",
            "label": (
                ((u.get("name") or "") + " " + (u.get("surname") or "")).strip()
                or uname
                or str(u["userid"])
            )
            + " (" + uname + ")",
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
