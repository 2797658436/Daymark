CREATE TABLE completion_records (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    progress_event_id TEXT NOT NULL UNIQUE REFERENCES progress_events(id) ON DELETE CASCADE,
    completed_at_utc TEXT NOT NULL,
    progress_before INTEGER NOT NULL CHECK (progress_before BETWEEN 0 AND 99),
    progress_after INTEGER NOT NULL DEFAULT 100 CHECK (progress_after = 100),
    fit TEXT CHECK (fit IS NULL OR fit IN ('light', 'fit', 'hard')),
    note TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    reverted_at_utc TEXT,
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL
);

CREATE TABLE completion_images (
    id TEXT PRIMARY KEY,
    completion_id TEXT NOT NULL REFERENCES completion_records(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL CHECK (sort_order BETWEEN 0 AND 2),
    mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    data BLOB NOT NULL,
    thumb BLOB NOT NULL,
    created_at_utc TEXT NOT NULL
);

CREATE INDEX idx_completion_records_task
ON completion_records (task_id, completed_at_utc);

CREATE INDEX idx_completion_images_completion
ON completion_images (completion_id, sort_order);

UPDATE schema_version SET version = 8 WHERE singleton = 1;
