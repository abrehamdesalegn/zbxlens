"""Lightweight in-process Prometheus-style metrics (no extra dependency)."""
from __future__ import annotations

import threading
import time
from collections import defaultdict

_lock = threading.Lock()
_started = time.time()
_requests_total: dict[tuple[str, str, str], int] = defaultdict(int)
_request_seconds: dict[tuple[str, str], float] = defaultdict(float)
_request_count_for_latency: dict[tuple[str, str], int] = defaultdict(int)
_errors_total: dict[str, int] = defaultdict(int)


def observe_request(method: str, path: str, status: int, duration_s: float) -> None:
    # Collapse dynamic path segments for cardinality control
    route = _normalize_path(path)
    key = (method.upper(), route, str(status))
    lat_key = (method.upper(), route)
    with _lock:
        _requests_total[key] += 1
        _request_seconds[lat_key] += duration_s
        _request_count_for_latency[lat_key] += 1
        if status >= 500:
            _errors_total["5xx"] += 1
        elif status >= 400:
            _errors_total["4xx"] += 1


def _normalize_path(path: str) -> str:
    if not path.startswith("/api/"):
        return path if path == "/" else "/static"
    parts = path.split("/")
    out = []
    for p in parts:
        if not p:
            continue
        # UUIDs / numeric ids
        if p.isdigit() or (len(p) >= 16 and all(c in "0123456789abcdef-" for c in p.lower())):
            out.append(":id")
        else:
            out.append(p)
    return "/" + "/".join(out)


def render_prometheus(extra_gauges: dict[str, float] | None = None) -> str:
    lines: list[str] = []
    lines.append("# HELP zr_up 1 if the process is running")
    lines.append("# TYPE zr_up gauge")
    lines.append("zr_up 1")
    lines.append("# HELP zr_process_uptime_seconds Process uptime")
    lines.append("# TYPE zr_process_uptime_seconds gauge")
    lines.append(f"zr_process_uptime_seconds {time.time() - _started:.1f}")

    lines.append("# HELP zr_http_requests_total HTTP requests")
    lines.append("# TYPE zr_http_requests_total counter")
    with _lock:
        for (method, route, status), count in sorted(_requests_total.items()):
            lines.append(
                f'zr_http_requests_total{{method="{method}",path="{route}",status="{status}"}} {count}'
            )
        lines.append("# HELP zr_http_request_duration_seconds_sum Cumulative request duration")
        lines.append("# TYPE zr_http_request_duration_seconds_sum counter")
        for (method, route), total in sorted(_request_seconds.items()):
            lines.append(
                f'zr_http_request_duration_seconds_sum{{method="{method}",path="{route}"}} {total:.6f}'
            )
        lines.append("# HELP zr_http_request_duration_seconds_count Request count for latency avg")
        lines.append("# TYPE zr_http_request_duration_seconds_count counter")
        for (method, route), count in sorted(_request_count_for_latency.items()):
            lines.append(
                f'zr_http_request_duration_seconds_count{{method="{method}",path="{route}"}} {count}'
            )
        lines.append("# HELP zr_http_errors_total HTTP client/server errors")
        lines.append("# TYPE zr_http_errors_total counter")
        for kind, count in sorted(_errors_total.items()):
            lines.append(f'zr_http_errors_total{{class="{kind}"}} {count}')

    if extra_gauges:
        for name, value in sorted(extra_gauges.items()):
            safe = name.replace("-", "_")
            lines.append(f"# HELP {safe} application gauge")
            lines.append(f"# TYPE {safe} gauge")
            lines.append(f"{safe} {value}")

    lines.append("")
    return "\n".join(lines)
