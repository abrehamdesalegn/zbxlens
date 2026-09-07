"""MySQL connection pool for read-only Zabbix DB access."""
from contextlib import contextmanager

import pymysql
from dbutils.pooled_db import PooledDB

from .config import (
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
    "DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME",
    "DB_POOL_SIZE", "MAX_RAW_POINTS", "TZ_OFFSET_MINUTES",
    "get_connection", "query",
]

_pool: PooledDB | None = None


def _get_pool() -> PooledDB:
    global _pool
    if _pool is None:
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
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()
