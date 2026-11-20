CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  install_id TEXT NOT NULL,
  plugin_version TEXT NOT NULL,
  node_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  homebridge_version TEXT NOT NULL,
  hazard_status TEXT NOT NULL DEFAULT '',
  fire_hazard INTEGER NOT NULL DEFAULT 0,
  electrical_fire_hazard INTEGER NOT NULL DEFAULT 0,
  utility_fire_hazard INTEGER NOT NULL DEFAULT 0,
  power_quality_hazard INTEGER NOT NULL DEFAULT 0,
  learning_mode INTEGER NOT NULL DEFAULT 0,
  efh_level INTEGER,
  ufh_level INTEGER
);

CREATE INDEX IF NOT EXISTS idx_events_received_at ON events(received_at);
CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_install_id ON events(install_id);
CREATE INDEX IF NOT EXISTS idx_events_plugin_version ON events(plugin_version);

-- Rollup tables (2026-09): ingest upserts these instead of appending a row per
-- heartbeat, so dashboard summaries read O(#installs + #days) instead of the
-- full heartbeat log. The old `events` table is kept as the historical source
-- for backfill (see migration-rollup.sql); nothing new writes to it (the 30-day
-- ping purge cron still cleans up legacy rows).
CREATE TABLE IF NOT EXISTS installs (
  install_id TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  last_start TEXT,
  plugin_version TEXT NOT NULL,
  node_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  homebridge_version TEXT NOT NULL,
  starts INTEGER NOT NULL DEFAULT 0,
  pings INTEGER NOT NULL DEFAULT 0,
  status_updates INTEGER NOT NULL DEFAULT 0,
  hazard_status TEXT NOT NULL DEFAULT '',
  fire_hazard INTEGER NOT NULL DEFAULT 0,
  electrical_fire_hazard INTEGER NOT NULL DEFAULT 0,
  utility_fire_hazard INTEGER NOT NULL DEFAULT 0,
  power_quality_hazard INTEGER NOT NULL DEFAULT 0,
  learning_mode INTEGER NOT NULL DEFAULT 0,
  efh_level INTEGER,
  ufh_level INTEGER,
  last_status_at TEXT,
  efh_status TEXT NOT NULL DEFAULT '',
  ufh_status TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_installs_last_seen ON installs(last_seen);
CREATE INDEX IF NOT EXISTS idx_installs_last_start ON installs(last_start);

CREATE TABLE IF NOT EXISTS presence_days (
  install_id TEXT NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (install_id, day)
);
CREATE INDEX IF NOT EXISTS idx_presence_days_day ON presence_days(day);

CREATE TABLE IF NOT EXISTS status_days (
  install_id TEXT NOT NULL,
  day TEXT NOT NULL,
  hazard_status TEXT NOT NULL DEFAULT '',
  fire_hazard INTEGER NOT NULL DEFAULT 0,
  electrical_fire_hazard INTEGER NOT NULL DEFAULT 0,
  utility_fire_hazard INTEGER NOT NULL DEFAULT 0,
  power_quality_hazard INTEGER NOT NULL DEFAULT 0,
  learning_mode INTEGER NOT NULL DEFAULT 0,
  efh_level INTEGER,
  ufh_level INTEGER,
  reports INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (install_id, day, hazard_status)
);
CREATE INDEX IF NOT EXISTS idx_status_days_day ON status_days(day);
