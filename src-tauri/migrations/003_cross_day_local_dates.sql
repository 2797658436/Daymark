ALTER TABLE execution_sessions ADD COLUMN end_local_date TEXT NOT NULL DEFAULT '';
UPDATE execution_sessions SET end_local_date = local_date WHERE end_local_date = '';

ALTER TABLE time_blocks ADD COLUMN end_local_date TEXT NOT NULL DEFAULT '';
UPDATE time_blocks SET end_local_date = local_date WHERE end_local_date = '';

UPDATE schema_version SET version = 3 WHERE singleton = 1 AND version < 3;
