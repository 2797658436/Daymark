ALTER TABLE projects ADD COLUMN deadline_local TEXT;

CREATE TABLE project_milestones (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    target_local_date TEXT NOT NULL,
    criterion_kind TEXT NOT NULL CHECK (criterion_kind IN ('orderedTask', 'taskCount', 'projectProgress')),
    target_task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
    target_count INTEGER CHECK (target_count IS NULL OR target_count > 0),
    target_progress INTEGER CHECK (target_progress IS NULL OR target_progress BETWEEN 1 AND 100),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL,
    CHECK (
        (criterion_kind = 'orderedTask' AND target_task_id IS NOT NULL AND target_count IS NULL AND target_progress IS NULL)
        OR (criterion_kind = 'taskCount' AND target_task_id IS NULL AND target_count IS NOT NULL AND target_progress IS NULL)
        OR (criterion_kind = 'projectProgress' AND target_task_id IS NULL AND target_count IS NULL AND target_progress IS NOT NULL)
    )
);

CREATE INDEX project_milestones_project_date_idx
ON project_milestones (project_id, target_local_date, sort_order);

UPDATE schema_version SET version = 6 WHERE singleton = 1;
