-- Run this against your Zabbix MySQL server as an admin user.
-- Creates a dedicated, read-only account for the reporting app.
-- It can only SELECT from the tables the app actually needs —
-- it has no access to config tables (users, actions, scripts, etc.)
-- and no INSERT/UPDATE/DELETE anywhere.

CREATE USER IF NOT EXISTS 'zbx_reporter'@'%' IDENTIFIED BY 'CHANGE_ME_STRONG_PASSWORD';

-- Adjust `zabbix` below if your database has a different name.
GRANT SELECT ON zabbix.hosts          TO 'zbx_reporter'@'%';
GRANT SELECT ON zabbix.hstgrp         TO 'zbx_reporter'@'%';
GRANT SELECT ON zabbix.hosts_groups   TO 'zbx_reporter'@'%';
GRANT SELECT ON zabbix.items          TO 'zbx_reporter'@'%';
GRANT SELECT ON zabbix.valuemap       TO 'zbx_reporter'@'%';
GRANT SELECT ON zabbix.valuemap_mapping TO 'zbx_reporter'@'%';
GRANT SELECT ON zabbix.history        TO 'zbx_reporter'@'%';
GRANT SELECT ON zabbix.history_uint   TO 'zbx_reporter'@'%';
GRANT SELECT ON zabbix.history_str    TO 'zbx_reporter'@'%';
GRANT SELECT ON zabbix.history_text   TO 'zbx_reporter'@'%';
GRANT SELECT ON zabbix.history_log    TO 'zbx_reporter'@'%';
GRANT SELECT ON zabbix.trends         TO 'zbx_reporter'@'%';
GRANT SELECT ON zabbix.trends_uint    TO 'zbx_reporter'@'%';
GRANT SELECT ON zabbix.problem        TO 'zbx_reporter'@'%';
GRANT SELECT ON zabbix.triggers       TO 'zbx_reporter'@'%';
GRANT SELECT ON zabbix.functions      TO 'zbx_reporter'@'%';

FLUSH PRIVILEGES;

-- Tighten '%' to your app server's specific IP once you know it, e.g.:
-- CREATE USER 'zbx_reporter'@'10.0.0.15' IDENTIFIED BY '...';

-- Note on user login & permissions (added when per-user Zabbix login was
-- introduced): none of that needs extra grants here. Authentication and
-- host-group/host permission checks go through the Zabbix frontend/
-- server's own JSON-RPC API (see backend/.env's ZABBIX_API_URL), not
-- this DB connection — so this user still never touches `users`,
-- `usrgrp`, or any permission/rights table, and stays exactly as
-- read-only and narrowly scoped as before.
