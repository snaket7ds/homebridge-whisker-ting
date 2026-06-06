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
