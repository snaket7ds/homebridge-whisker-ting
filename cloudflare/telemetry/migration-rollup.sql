-- One-time backfill (2026-09): populate the rollup tables from the legacy
-- `events` log so historical dashboards stay identical after the Phase 2
-- worker ships. Run AFTER schema.sql has created the new tables:
--   wrangler d1 execute whisker_ting_telemetry --remote --file=schema.sql
--   wrangler d1 execute whisker_ting_telemetry --remote --file=migration-rollup.sql
-- Safe to re-run (INSERT OR IGNORE / additive upserts).

-- Per-install state + lifetime counters and latest status snapshot.
INSERT OR IGNORE INTO installs (
  install_id, first_seen, last_seen, last_start,
  plugin_version, node_version, platform, arch, homebridge_version,
  starts, pings, status_updates,
  hazard_status, fire_hazard, electrical_fire_hazard, utility_fire_hazard,
  power_quality_hazard, learning_mode, efh_level, ufh_level, last_status_at
)
SELECT
  e.install_id,
  MIN(e.received_at),
  MAX(e.received_at),
  MAX(CASE WHEN e.event_type = 'plugin_start' THEN e.received_at END),
  (SELECT e2.plugin_version FROM events e2 WHERE e2.install_id = e.install_id ORDER BY e2.received_at DESC LIMIT 1),
  (SELECT e2.node_version FROM events e2 WHERE e2.install_id = e.install_id ORDER BY e2.received_at DESC LIMIT 1),
  (SELECT e2.platform FROM events e2 WHERE e2.install_id = e.install_id ORDER BY e2.received_at DESC LIMIT 1),
  (SELECT e2.arch FROM events e2 WHERE e2.install_id = e.install_id ORDER BY e2.received_at DESC LIMIT 1),
  (SELECT e2.homebridge_version FROM events e2 WHERE e2.install_id = e.install_id ORDER BY e2.received_at DESC LIMIT 1),
  SUM(CASE WHEN e.event_type = 'plugin_start' THEN 1 ELSE 0 END),
  SUM(CASE WHEN e.event_type = 'plugin_ping' THEN 1 ELSE 0 END),
  SUM(CASE WHEN e.event_type = 'status_update' THEN 1 ELSE 0 END),
  (SELECT s.hazard_status FROM events s WHERE s.install_id = e.install_id AND s.event_type = 'status_update' ORDER BY s.received_at DESC LIMIT 1),
  (SELECT s.fire_hazard FROM events s WHERE s.install_id = e.install_id AND s.event_type = 'status_update' ORDER BY s.received_at DESC LIMIT 1),
  (SELECT s.electrical_fire_hazard FROM events s WHERE s.install_id = e.install_id AND s.event_type = 'status_update' ORDER BY s.received_at DESC LIMIT 1),
  (SELECT s.utility_fire_hazard FROM events s WHERE s.install_id = e.install_id AND s.event_type = 'status_update' ORDER BY s.received_at DESC LIMIT 1),
  (SELECT s.power_quality_hazard FROM events s WHERE s.install_id = e.install_id AND s.event_type = 'status_update' ORDER BY s.received_at DESC LIMIT 1),
  (SELECT s.learning_mode FROM events s WHERE s.install_id = e.install_id AND s.event_type = 'status_update' ORDER BY s.received_at DESC LIMIT 1),
  (SELECT s.efh_level FROM events s WHERE s.install_id = e.install_id AND s.event_type = 'status_update' ORDER BY s.received_at DESC LIMIT 1),
  (SELECT s.ufh_level FROM events s WHERE s.install_id = e.install_id AND s.event_type = 'status_update' ORDER BY s.received_at DESC LIMIT 1),
  (SELECT s.received_at FROM events s WHERE s.install_id = e.install_id AND s.event_type = 'status_update' ORDER BY s.received_at DESC LIMIT 1)
FROM events e
WHERE e.install_id != 'probe' AND length(e.install_id) >= 8
GROUP BY e.install_id;

-- Daily presence (one row per install per UTC day it was seen).
INSERT OR IGNORE INTO presence_days (install_id, day)
SELECT DISTINCT install_id, substr(received_at, 1, 10)
FROM events
WHERE event_type IN ('plugin_install', 'plugin_start', 'plugin_ping', 'status_update')
  AND install_id != 'probe' AND length(install_id) >= 8;

-- Per-day status reports (grouped by label so 30d status/hazard charts stay exact).
INSERT OR IGNORE INTO status_days (
  install_id, day, hazard_status,
  fire_hazard, electrical_fire_hazard, utility_fire_hazard,
  power_quality_hazard, learning_mode, efh_level, ufh_level, reports
)
SELECT
  install_id,
  substr(received_at, 1, 10),
  hazard_status,
  COALESCE(MAX(fire_hazard), 0),
  COALESCE(MAX(electrical_fire_hazard), 0),
  COALESCE(MAX(utility_fire_hazard), 0),
  COALESCE(MAX(power_quality_hazard), 0),
  COALESCE(MAX(learning_mode), 0),
  MAX(efh_level),
  MAX(ufh_level),
  COUNT(*)
FROM events
WHERE event_type = 'status_update'
  AND install_id != 'probe' AND length(install_id) >= 8
GROUP BY install_id, substr(received_at, 1, 10), hazard_status;