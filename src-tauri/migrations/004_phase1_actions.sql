ALTER TABLE tasks ADD COLUMN deadline_local TEXT;
ALTER TABLE tasks ADD COLUMN estimated_minutes INTEGER CHECK (estimated_minutes IS NULL OR estimated_minutes > 0);
ALTER TABLE tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

-- Existing v3 databases may already contain several unfinished records because
-- that version did not enforce the Alpha's single-execution rule.  The v4 write
-- transaction rejects every new concurrent start without rewriting those
-- historical facts during migration.

UPDATE schema_version SET version = 4 WHERE singleton = 1 AND version < 4;
