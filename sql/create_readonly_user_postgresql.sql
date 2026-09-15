-- Read-only role for ZbxLens against a Zabbix PostgreSQL database.
-- Run as a superuser (e.g. postgres) on the Zabbix DB host.

-- 1) Create role (login user)
CREATE ROLE zbx_reporter WITH LOGIN PASSWORD 'CHANGE_ME_STRONG_PASSWORD';

-- 2) Allow connect to the Zabbix database
GRANT CONNECT ON DATABASE zabbix TO zbx_reporter;

-- 3) Schema usage (Zabbix uses the public schema by default)
\c zabbix
GRANT USAGE ON SCHEMA public TO zbx_reporter;

-- 4) SELECT on all existing tables + sequences (read-only)
GRANT SELECT ON ALL TABLES IN SCHEMA public TO zbx_reporter;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO zbx_reporter;

-- 5) Future tables (so new Zabbix partitions/history tables stay readable)
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO zbx_reporter;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO zbx_reporter;

-- Optional: restrict by host in pg_hba.conf, e.g.:
-- host  zabbix  zbx_reporter  10.0.0.15/32  scram-sha-256

-- Note: user login & host permissions in ZbxLens go through the Zabbix
-- JSON-RPC API (ZABBIX_API_URL), not this DB role. Keep this role
-- SELECT-only and never grant INSERT/UPDATE/DELETE.
