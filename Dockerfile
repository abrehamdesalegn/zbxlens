# ── build stage: install deps into a venv ────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends \
      gcc default-libmysqlclient-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt /build/requirements.txt
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/venv/bin/pip install --no-cache-dir -r /build/requirements.txt

# ── runtime stage ───────────────────────────────────────────────────────────
FROM python:3.12-slim

# Non-root user (UID 10001) — data volume should be writable by this UID
RUN groupadd --gid 10001 app \
 && useradd --uid 10001 --gid app --home /app --shell /usr/sbin/nologin app \
 && mkdir -p /app/backend/data \
 && chown -R app:app /app

COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONPATH=/app \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY --chown=app:app backend /app/backend
COPY --chown=app:app frontend /app/frontend

# Ensure data dir exists and is owned correctly even when a volume is mounted
# (compose bind-mount may override ownership — see README)
RUN mkdir -p /app/backend/data && chown -R app:app /app/backend/data

# entrypoint starts as root to chown the data volume, then drops to app (UID 10001)
COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /app/backend

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).read()"

ENTRYPOINT ["/entrypoint.sh"]
# Production defaults: no --reload; workers can be overridden via compose
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
