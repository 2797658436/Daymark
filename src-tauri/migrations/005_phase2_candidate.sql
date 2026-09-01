ALTER TABLE tasks ADD COLUMN session_minutes INTEGER CHECK (session_minutes IS NULL OR session_minutes > 0);
ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high'));
ALTER TABLE tasks ADD COLUMN source_url TEXT;
ALTER TABLE tasks ADD COLUMN source_key TEXT;
ALTER TABLE tasks ADD COLUMN media_minutes INTEGER CHECK (media_minutes IS NULL OR media_minutes > 0);
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'habit'));

CREATE TABLE recurring_habits (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    pattern TEXT NOT NULL CHECK (pattern IN ('daily', 'weekdays', 'weekly')),
    weekdays_json TEXT NOT NULL DEFAULT '[]',
    start_date TEXT NOT NULL,
    session_minutes INTEGER NOT NULL CHECK (session_minutes > 0),
    preferred_start_local TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
    created_at_utc TEXT NOT NULL
);

CREATE TABLE habit_occurrences (
    id TEXT PRIMARY KEY,
    habit_id TEXT NOT NULL REFERENCES recurring_habits(id) ON DELETE CASCADE,
    local_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('scheduled', 'completed', 'skipped')),
    session_id TEXT REFERENCES execution_sessions(id) ON DELETE SET NULL,
    created_at_utc TEXT NOT NULL,
    UNIQUE (habit_id, local_date)
);

CREATE TABLE rescue_prompts (
    session_id TEXT PRIMARY KEY REFERENCES execution_sessions(id) ON DELETE CASCADE,
    shown_at_utc TEXT NOT NULL
);

UPDATE schema_version SET version = 5 WHERE singleton = 1;
