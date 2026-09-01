CREATE TABLE milestone_outcomes (
    id TEXT PRIMARY KEY,
    milestone_id TEXT NOT NULL UNIQUE REFERENCES project_milestones(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    target_local_date TEXT NOT NULL,
    criterion_kind TEXT NOT NULL,
    target_task_id TEXT,
    target_count INTEGER,
    target_progress INTEGER,
    reached INTEGER NOT NULL CHECK (reached IN (0, 1)),
    result_text TEXT NOT NULL,
    frozen_at_utc TEXT NOT NULL
);

CREATE INDEX milestone_outcomes_project_date_idx
ON milestone_outcomes (project_id, target_local_date);

UPDATE schema_version SET version = 7 WHERE singleton = 1;
