CREATE TABLE IF NOT EXISTS time_blocks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  local_date TEXT NOT NULL,
  start_local TEXT NOT NULL,
  end_local TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  utc_offset_minutes INTEGER NOT NULL,
  created_at_utc TEXT NOT NULL
);

-- Existing rows predate offset capture. NULL means "unknown"; inventing UTC here
-- would silently corrupt their original local-time facts.
ALTER TABLE execution_sessions ADD COLUMN utc_offset_minutes INTEGER;

UPDATE schema_version SET version = 2 WHERE singleton = 1 AND version < 2;
