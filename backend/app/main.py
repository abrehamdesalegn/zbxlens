"""ZbxLens — FastAPI application entrypoint."""
from pathlib import Path
import logging
import time

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from . import auth
from .config import APP_VERSION, SESSION_COOKIE_NAME, COOKIE_SECURE, SESSION_COOKIE_MAX_AGE_DAYS
from .services import metrics as zr_metrics
from .routes import health, auth_routes, report, dashboards, problems

logger = logging.getLogger("zbxlens")
if not logging.getLogger().handlers:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )

app = FastAPI(title="ZbxLens", version=APP_VERSION)

# Resolve frontend dir: project_root/frontend (works for local + Docker)
_here = Path(__file__).resolve().parent  # .../backend/app
_candidates = [
    _here.parent.parent / "frontend",   # zbxlens/frontend
    _here.parent / "frontend",          # backend/frontend (fallback)
    Path("/app/frontend"),              # Docker absolute
]
FRONTEND_DIR = next((p for p in _candidates if (p / "index.html").exists()), _candidates[0])

# ── Middleware ──────────────────────────────────────────────────────────────
app.add_middleware(auth.SessionAuthMiddleware)


class RequestMetricsMiddleware(BaseHTTPMiddleware):
    """Record request metrics and emit a one-line access log."""

    async def dispatch(self, request: Request, call_next):
        start = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            return response
        finally:
            duration = time.perf_counter() - start
            path = request.url.path
            try:
                zr_metrics.observe_request(request.method, path, status, duration)
            except Exception:
                pass
            if path.startswith("/api/") or path == "/":
                logger.info(
                    "%s %s → %s %.1fms",
                    request.method, path, status, duration * 1000,
                )


app.add_middleware(RequestMetricsMiddleware)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        return response


app.add_middleware(SecurityHeadersMiddleware)

# ── Routers ─────────────────────────────────────────────────────────────────
app.include_router(health.router)
app.include_router(auth_routes.router)
app.include_router(report.router)
app.include_router(dashboards.router)
app.include_router(problems.router)


@app.get("/favicon.svg")
def favicon_svg():
    path = FRONTEND_DIR / "favicon.svg"
    if path.is_file():
        return FileResponse(path, media_type="image/svg+xml")
    raise HTTPException(status_code=404, detail="favicon not found")


@app.get("/favicon.ico")
def favicon_ico():
    # Prefer SVG; browsers that request .ico still get a usable icon response
    svg = FRONTEND_DIR / "favicon.svg"
    if svg.is_file():
        return FileResponse(svg, media_type="image/svg+xml")
    raise HTTPException(status_code=404, detail="favicon not found")


@app.get("/")
def index():
    return FileResponse(
        FRONTEND_DIR / "index.html",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


# Frontend assets (zero-build static files)
app.mount("/css", StaticFiles(directory=FRONTEND_DIR / "css"), name="css")
app.mount("/js", StaticFiles(directory=FRONTEND_DIR / "js"), name="js")
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")
