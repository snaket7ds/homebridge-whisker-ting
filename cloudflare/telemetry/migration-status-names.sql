-- 2026-11-20: Whisker's EFH/UFH status names (plugin 1.2.0+), latest per install.
-- Run once on an existing database:
--   npx wrangler d1 execute whisker_ting_telemetry --remote --file migration-status-names.sql
ALTER TABLE installs ADD COLUMN efh_status TEXT NOT NULL DEFAULT '';
ALTER TABLE installs ADD COLUMN ufh_status TEXT NOT NULL DEFAULT '';
