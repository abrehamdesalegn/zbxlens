# Changelog

## 5.0.1

### Fixed
- **Zabbix 6.x login / “Not authorized”**: API auth is now version-aware.
  - Zabbix **&lt; 6.4**: session token sent in JSON-RPC `auth` body field (Bearer alone often fails behind Apache/nginx).
  - Zabbix **6.4–7.0**: both Bearer header and body `auth`.
  - Zabbix **≥ 7.2**: Bearer only (body `auth` was removed).
- Login parameter fallback: tries `username` then legacy `user` for older servers.


## 5.0.0

- Renamed product to **ZbxLens**
- Version bump to 5.0.0
- Project layout: routes / services / schemas; export.js split

## 4.7.12

- Metrics pivot: threshold-coloured charts (split at threshold crossings), sticky headers, CSV/PDF export with filters meta
- Previous-period comparison for avg/min/max/last
- Drill-down maximize, zoom, hour filter, UTC offset display
- README and project layout restructure (routes / services / schemas)

## 4.7.x

- Problems bulk actions, share pickers, dashboards, Zabbix API auth