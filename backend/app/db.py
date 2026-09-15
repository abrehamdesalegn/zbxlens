"""Zabbix database connection pool — MySQL or PostgreSQL (read-only)."""
from __future__ import annotations

from contextlib import contextmanager

from dbutils.pooled_db import PooledDB

from .config import (
    DB_ENGINE,
    DB_HOST,
    DB_PORT,
    DB_USER,
    DB_PASSWORD,
    DB_NAME,
    DB_POOL_SIZE,
    MAX_RAW_POINTS,
    TZ_OFFSET_MINUTES,
)

# Re-export commonly imported settings (compat for older imports)
__all__ = [
    "DB_ENGINE", "DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME",
    "DB_POOL_SIZE", "MAX_RAW_POINTS", "TZ_OFFSET_MINUTES",
    "is_postgresql", "is_mysql",
    "sql_group_concat", "sql_quote_ident",
    "get_connection", "query",
    "DbError", "db_operational_errors",
]

_pool: PooledDB | None = None


def is_postgresql() -> bool:
    return DB_ENGINE == "postgresql"


def is_mysql() -> bool:
    return DB_ENGINE == "mysql"


class DbError(Exception):
    """Unified operational / connectivity error for MySQL and PostgreSQL."""

    def __init__(self, message: str, original: BaseException | None = None):
        super().__init__(message)
        self.original = original


def db_operational_errors() -> tuple:
    """Exception types that mean the Zabbix DB is unreachable / failed a query."""
    errs: list[type] = [DbError]
    try:
        import pymysql
        errs.append(pymysql.err.OperationalError)
        errs.append(pymysql.err.InterfaceError)
        errs.append(pymysql.MySQLError)
    except Exception:
        pass
    try:
        import psycopg2
        errs.append(psycopg2.OperationalError)
        errs.append(psycopg2.InterfaceError)
        errs.append(psycopg2.DatabaseError)
    except Exception:
        pass
    return tuple(errs)


def _normalize_value(v):
    """Convert driver-specific types (Decimal, etc.) to plain Python numbers/strings."""
    if v is None:
        return None
    # psycopg2 returns Decimal for NUMERIC columns (history_uint / trends_uint)
    try:
        from decimal import Decimal
        if isinstance(v, Decimal):
            if v == v.to_integral_value():
                try:
                    return int(v)
                except Exception:
                    return float(v)
            return float(v)
    except Exception:
        pass
    # memoryview / bytes from some drivers
    if isinstance(v, memoryview):
        return bytes(v)
    return v


def _normalize_row(row) -> dict:
    d = dict(row)
    return {k: _normalize_value(v) for k, v in d.items()}


def sql_quote_ident(name: str) -> str:
    """Quote an identifier for the active SQL dialect."""
    if is_postgresql():
        return '"' + name.replace('"', '""') + '"'
    return "`" + name.replace("`", "``") + "`"


def sql_group_concat(column_expr: str, alias: str = "groups",
                      order_expr: str | None = None, separator: str = ", ") -> str:
    """Dialect-aware string aggregation (GROUP_CONCAT / string_agg)."""
    order = order_expr or column_expr
    if is_postgresql():
        # string_agg(DISTINCT ...) is widely supported; order is not critical for group names
        return (
            f"string_agg(DISTINCT {column_expr}::text, '{separator}') "
            f"AS {sql_quote_ident(alias)}"
        )
    return (
        f"GROUP_CONCAT(DISTINCT {column_expr} ORDER BY {order} SEPARATOR '{separator}') "
        f"AS {sql_quote_ident(alias)}"
    )


def _pg_connect():
    import psycopg2
    from psycopg2.extras import RealDictCursor

    conn = psycopg2.connect(
        host=DB_HOST,
        port=DB_PORT,
        user=DB_USER,
        password=DB_PASSWORD,
        dbname=DB_NAME,
        connect_timeout=10,
        cursor_factory=RealDictCursor,
    )
    conn.autocommit = True
    return conn


def _get_pool() -> PooledDB:
    global _pool
    if _pool is not None:
        return _pool

    if is_postgresql():
        _pool = PooledDB(
            creator=_pg_connect,
            maxconnections=DB_POOL_SIZE,
            mincached=1,
            maxcached=DB_POOL_SIZE,
            blocking=True,
        )
    else:
        import pymysql

        _pool = PooledDB(
            creator=pymysql,
            maxconnections=DB_POOL_SIZE,
            mincached=1,
            maxcached=DB_POOL_SIZE,
            blocking=True,
            host=DB_HOST,
            port=DB_PORT,
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME,
            cursorclass=pymysql.cursors.DictCursor,
            connect_timeout=10,
            read_timeout=120,
            charset="utf8mb4",
            autocommit=True,
        )
    return _pool


@contextmanager
def get_connection():
    """Borrowed connection from the pool. Returned automatically on exit."""
    pool = _get_pool()
    conn = pool.connection()
    try:
        yield conn
    finally:
        conn.close()  # returns the connection to the pool


def query(sql: str, params: tuple = ()) -> list[dict]:
    """Run a read-only SQL query. Placeholders are %s for both MySQL and PostgreSQL."""
    try:
        with get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params or ())
                rows = cur.fetchall()
                # RealDictCursor / DictCursor already return dict-like rows;
                # normalize driver types (Decimal, etc.) to plain Python values.
                return [_normalize_row(r) for r in rows] if rows else []
    except Exception as e:
        # Re-raise unified connectivity errors; leave programming errors intact.
        if isinstance(e, db_operational_errors()):
            raise DbError(str(e), original=e) from e
        # Also wrap raw OperationalError-like messages from either driver
        name = type(e).__module__ + "." + type(e).__name__
        if "OperationalError" in name or "InterfaceError" in name:
            raise DbError(str(e), original=e) from e
        raise
