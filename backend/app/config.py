"""Application configuration from environment / .env."""
import os
from dotenv import load_dotenv

load_dotenv()

APP_VERSION = os.environ.get("APP_VERSION", "5.0.0")

DB_HOST = os.environ.get("DB_HOST", "127.0.0.1")
DB_PORT = int(os.environ.get("DB_PORT", "3306"))
DB_USER = os.environ.get("DB_USER", "zbx_reporter")
DB_PASSWORD = os.environ.get("DB_PASSWORD", "")
DB_NAME = os.environ.get("DB_NAME", "zabbix")
MAX_RAW_POINTS = int(os.environ.get("MAX_RAW_POINTS", "20000"))
DB_POOL_SIZE = int(os.environ.get("DB_POOL_SIZE", "5"))

# Minutes east of UTC for date pickers, HOURS filter, chart labels.
# 0 = frontend falls back to browser local timezone.
TZ_OFFSET_MINUTES = int(os.environ.get("TZ_OFFSET_MINUTES", "0"))

ZABBIX_API_URL = os.environ.get("ZABBIX_API_URL", "").strip()
ZABBIX_API_TIMEOUT_SECONDS = float(os.environ.get("ZABBIX_API_TIMEOUT_SECONDS", "10"))
ZABBIX_API_VERIFY_TLS = os.environ.get("ZABBIX_API_VERIFY_TLS", "true").strip().lower() not in ("0", "false", "no")

SESSION_IDLE_TTL_MINUTES = int(os.environ.get("SESSION_IDLE_TTL_MINUTES", "480"))
SESSION_COOKIE_MAX_AGE_DAYS = int(os.environ.get("SESSION_COOKIE_MAX_AGE_DAYS", "30"))
SESSION_COOKIE_NAME = os.environ.get("SESSION_COOKIE_NAME", "zr_session")
PERMISSION_CACHE_TTL_SECONDS = int(os.environ.get("PERMISSION_CACHE_TTL_SECONDS", "300"))
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "false").strip().lower() in ("1", "true", "yes")
