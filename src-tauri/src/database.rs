use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::{DateTime, NaiveDate, NaiveTime, Utc};
use rusqlite::{Connection, Transaction, TransactionBehavior, params};
use serde::Serialize;

use crate::models::{
    CompletionImage, CompletionRecord, CompletionRecordSummary, ExecutionRecord, ExecutionSession,
    HabitOccurrence, MilestoneOutcome, ProgressEvent, Project, ProjectMilestone, RecurringHabit,
    Task, TimeBlock,
};

pub const CURRENT_SCHEMA_VERSION: i64 = 8;

/// 感受标签的唯一词表：写入校验、`tags` 去重与前端胶囊都以此为准。
pub const COMPLETION_TAGS: [&str; 8] = [
    "专注", "顺利", "有收获", "比预计难", "被打断", "疲惫", "卡住", "想继续",
];

/// 完成小结的字数上限（按字符数，不按字节）。
const COMPLETION_NOTE_LIMIT: usize = 280;
/// 单条完成记录最多三张图片。
const COMPLETION_IMAGE_LIMIT: usize = 3;
/// 压缩后单张图片的字节上限（2 MiB）。
const COMPLETION_IMAGE_BYTES_LIMIT: i64 = 2 * 1024 * 1024;
const COMPLETION_IMAGE_MIME_TYPES: [&str; 3] = ["image/png", "image/jpeg", "image/webp"];

#[derive(Debug)]
pub struct Database {
    path: PathBuf,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub projects: Vec<Project>,
    pub project_milestones: Vec<ProjectMilestone>,
    pub milestone_outcomes: Vec<MilestoneOutcome>,
    pub tasks: Vec<Task>,
    pub execution_sessions: Vec<ExecutionSession>,
    pub execution_records: Vec<ExecutionRecord>,
    pub progress_events: Vec<ProgressEvent>,
    pub time_blocks: Vec<TimeBlock>,
    pub recurring_habits: Vec<RecurringHabit>,
    pub habit_occurrences: Vec<HabitOccurrence>,
    pub rescue_prompted_session_ids: Vec<String>,
    pub completion_records: Vec<CompletionRecordSummary>,
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建数据目录：{error}"))?;
        }

        let mut connection = open_connection(&path)?;
        migrate(&mut connection)?;
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn schema_version(&self) -> Result<i64, String> {
        let connection = open_connection(&self.path)?;
        read_schema_version(&connection)
    }

    pub fn snapshot(&self) -> Result<WorkspaceSnapshot, String> {
        let connection = open_connection(&self.path)?;
        Ok(WorkspaceSnapshot {
            projects: query_projects(&connection)?,
            project_milestones: query_project_milestones(&connection)?,
            milestone_outcomes: query_milestone_outcomes(&connection)?,
            tasks: query_tasks(&connection)?,
            execution_sessions: query_sessions(&connection)?,
            execution_records: query_records(&connection)?,
            progress_events: query_progress_events(&connection)?,
            time_blocks: query_time_blocks(&connection)?,
            recurring_habits: query_recurring_habits(&connection)?,
            habit_occurrences: query_habit_occurrences(&connection)?,
            rescue_prompted_session_ids: query_rescue_prompted_session_ids(&connection)?,
            completion_records: query_completion_records(&connection)?,
        })
    }

    /// Freeze one-time outcome snapshots using the caller's local natural date.
    /// Returns whether the database changed so callers can refresh the daily backup.
    pub fn freeze_expired_outcomes(&self, today: NaiveDate) -> Result<bool, String> {
        let mut connection = open_connection(&self.path)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        let milestones = query_project_milestones(&transaction)?;
        let tasks = query_tasks(&transaction)?;
        let mut changed = false;
        for milestone in milestones {
            let target = NaiveDate::parse_from_str(&milestone.target_local_date, "%Y-%m-%d")
                .map_err(|error| format!("里程碑日期无效：{error}"))?;
            if target >= today {
                continue;
            }
            let already_frozen: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM milestone_outcomes WHERE milestone_id = ?1)",
                [&milestone.id],
                |row| row.get(0),
            ).map_err(database_error)?;
            if already_frozen {
                continue;
            }
            let reached = milestone_reached(&milestone, &tasks);
            if reached {
                // 已达成的里程碑无需历史快照；实时状态直接显示勾号。
                continue;
            }
            let result_text = outcome_text(&milestone, &tasks, reached);
            transaction.execute(
                "INSERT INTO milestone_outcomes (id, milestone_id, project_id, title, target_local_date, criterion_kind, target_task_id, target_count, target_progress, reached, result_text, frozen_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    format!("outcome:{}", milestone.id),
                    milestone.id,
                    milestone.project_id,
                    milestone.title,
                    milestone.target_local_date,
                    milestone.criterion_kind,
                    milestone.target_task_id,
                    milestone.target_count.map(|value| value as i64),
                    milestone.target_progress.map(|value| value as i64),
                    reached as i64,
                    result_text,
                    Utc::now().to_rfc3339(),
                ],
            ).map_err(database_error)?;
            changed = true;
        }
        transaction.commit().map_err(database_error)?;
        Ok(changed)
    }

    pub fn save_project_with_tasks(&self, project: &Project, tasks: &[Task]) -> Result<(), String> {
        validate_project(project)?;
        for task in tasks {
            validate_title("任务", &task.title)?;
            if task.progress > 100 {
                return Err("任务完成度必须在 0 到 100 之间".into());
            }
            validate_task_fields(task)?;
            if task.project_id.as_deref() != Some(project.id.as_str()) {
                return Err("批量保存的任务必须属于同一项目".into());
            }
        }

        let mut connection = open_connection(&self.path)?;
        let transaction = connection.transaction().map_err(database_error)?;
        let now = Utc::now().to_rfc3339();
        transaction.execute(
            "INSERT INTO projects (id, title, deadline_local, created_at_utc, updated_at_utc) VALUES (?1, ?2, ?3, ?4, ?4)",
            params![project.id, project.title, project.deadline_local, now],
        ).map_err(database_error)?;
        for task in tasks {
            transaction.execute(
                "INSERT INTO tasks (id, project_id, title, progress, status, deadline_local, estimated_minutes, session_minutes, priority, sort_order, source_url, source_key, media_minutes, kind, created_at_utc, updated_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)",
                params![task.id, task.project_id, task.title, task.progress, task.status, task.deadline_local, task.estimated_minutes, task.session_minutes, task.priority, task.sort_order, task.source_url, task.source_key, task.media_minutes, task.kind, now],
            ).map_err(database_error)?;
        }
        transaction.commit().map_err(database_error)
    }

    pub fn update_project(&self, project: &Project) -> Result<(), String> {
        validate_project(project)?;
        let connection = open_connection(&self.path)?;
        let changed = connection.execute(
            "UPDATE projects SET title = ?1, deadline_local = ?2, updated_at_utc = ?3 WHERE id = ?4",
            params![project.title, project.deadline_local, Utc::now().to_rfc3339(), project.id],
        ).map_err(database_error)?;
        if changed == 1 { Ok(()) } else { Err("找不到要更新的项目".into()) }
    }

    pub fn create_project_milestone(&self, milestone: &ProjectMilestone) -> Result<(), String> {
        validate_project_milestone(milestone)?;
        let connection = open_connection(&self.path)?;
        validate_milestone_relations(&connection, milestone)?;
        let now = Utc::now().to_rfc3339();
        connection.execute(
            "INSERT INTO project_milestones (id, project_id, title, target_local_date, criterion_kind, target_task_id, target_count, target_progress, sort_order, created_at_utc, updated_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![milestone.id, milestone.project_id, milestone.title, milestone.target_local_date, milestone.criterion_kind, milestone.target_task_id, milestone.target_count, milestone.target_progress, milestone.sort_order, now],
        ).map(|_| ()).map_err(database_error)
    }

    pub fn update_project_milestone(&self, milestone: &ProjectMilestone) -> Result<(), String> {
        validate_project_milestone(milestone)?;
        let connection = open_connection(&self.path)?;
        if milestone_has_outcome(&connection, &milestone.id)? {
            return Err("已到期里程碑属于历史记录，不能修改".into());
        }
        validate_milestone_relations(&connection, milestone)?;
        let changed = connection.execute(
            "UPDATE project_milestones SET project_id = ?1, title = ?2, target_local_date = ?3, criterion_kind = ?4, target_task_id = ?5, target_count = ?6, target_progress = ?7, sort_order = ?8, updated_at_utc = ?9 WHERE id = ?10",
            params![milestone.project_id, milestone.title, milestone.target_local_date, milestone.criterion_kind, milestone.target_task_id, milestone.target_count, milestone.target_progress, milestone.sort_order, Utc::now().to_rfc3339(), milestone.id],
        ).map_err(database_error)?;
        if changed == 1 { Ok(()) } else { Err("找不到要更新的项目里程碑".into()) }
    }

    pub fn delete_project_milestone(&self, id: &str) -> Result<(), String> {
        let connection = open_connection(&self.path)?;
        if milestone_has_outcome(&connection, id)? {
            return Err("已到期里程碑属于历史记录，不能删除".into());
        }
        let changed = connection.execute("DELETE FROM project_milestones WHERE id = ?1", [id]).map_err(database_error)?;
        if changed == 1 { Ok(()) } else { Err("找不到要删除的项目里程碑".into()) }
    }

    pub fn create_task(&self, task: &Task) -> Result<(), String> {
        validate_task_fields(task)?;
        let connection = open_connection(&self.path)?;
        let now = Utc::now().to_rfc3339();
        connection
            .execute(
                "INSERT INTO tasks (id, project_id, title, progress, status, deadline_local, estimated_minutes, session_minutes, priority, sort_order, source_url, source_key, media_minutes, kind, created_at_utc, updated_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)",
                params![task.id, task.project_id, task.title, task.progress, task.status, task.deadline_local, task.estimated_minutes, task.session_minutes, task.priority, task.sort_order, task.source_url, task.source_key, task.media_minutes, task.kind, now],
            )
            .map(|_| ())
            .map_err(database_error)
    }

    pub fn create_task_with_session(
        &self,
        task: &Task,
        session: &ExecutionSession,
    ) -> Result<(), String> {
        validate_task_fields(task)?;
        validate_session(session)?;
        if session.task_id != task.id {
            return Err("计划时段必须属于同时创建的任务".into());
        }
        let mut connection = open_connection(&self.path)?;
        let transaction = connection.transaction().map_err(database_error)?;
        let now = Utc::now().to_rfc3339();
        transaction.execute(
            "INSERT INTO tasks (id, project_id, title, progress, status, deadline_local, estimated_minutes, session_minutes, priority, sort_order, source_url, source_key, media_minutes, kind, created_at_utc, updated_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)",
            params![task.id, task.project_id, task.title, task.progress, task.status, task.deadline_local, task.estimated_minutes, task.session_minutes, task.priority, task.sort_order, task.source_url, task.source_key, task.media_minutes, task.kind, now],
        ).map_err(database_error)?;
        transaction.execute(
            "INSERT INTO execution_sessions (id, task_id, local_date, end_local_date, start_local, end_local, time_zone, utc_offset_minutes, status, created_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![session.id, session.task_id, session.local_date, session.end_local_date, session.start_local, session.end_local, session.time_zone, session.utc_offset_minutes, session.status, now],
        ).map_err(database_error)?;
        transaction.commit().map_err(database_error)
    }

    pub fn update_task(&self, task: &Task) -> Result<(), String> {
        validate_task_fields(task)?;
        let connection = open_connection(&self.path)?;
        let changed = connection
            .execute(
                "UPDATE tasks SET project_id = ?1, title = ?2, status = ?3, deadline_local = ?4, estimated_minutes = ?5, session_minutes = ?6, priority = ?7, sort_order = ?8, source_url = ?9, source_key = ?10, media_minutes = ?11, kind = ?12, updated_at_utc = ?13 WHERE id = ?14",
                params![task.project_id, task.title, task.status, task.deadline_local, task.estimated_minutes, task.session_minutes, task.priority, task.sort_order, task.source_url, task.source_key, task.media_minutes, task.kind, Utc::now().to_rfc3339(), task.id],
            )
            .map_err(database_error)?;
        if changed == 1 {
            Ok(())
        } else {
            Err("找不到要更新的任务".into())
        }
    }

    pub fn create_session(&self, session: &ExecutionSession) -> Result<(), String> {
        self.create_sessions(std::slice::from_ref(session))
    }

    pub fn create_sessions(&self, sessions: &[ExecutionSession]) -> Result<(), String> {
        self.apply_schedule_draft(sessions, &[])
    }

    pub fn apply_schedule_draft(
        &self,
        sessions: &[ExecutionSession],
        occurrences: &[HabitOccurrence],
    ) -> Result<(), String> {
        for session in sessions {
            validate_session(session)?;
        }
        for occurrence in occurrences {
            if occurrence.status != "scheduled"
                || occurrence.session_id.as_ref().is_none_or(|id| {
                    !sessions.iter().any(|session| {
                        &session.id == id && session.local_date == occurrence.local_date
                    })
                })
            {
                return Err("习惯发生项与排程草案不匹配".into());
            }
        }
        let mut connection = open_connection(&self.path)?;
        let transaction = connection.transaction().map_err(database_error)?;
        for session in sessions {
            transaction.execute(
                "INSERT INTO execution_sessions (id, task_id, local_date, end_local_date, start_local, end_local, time_zone, utc_offset_minutes, status, created_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![session.id, session.task_id, session.local_date, session.end_local_date, session.start_local, session.end_local, session.time_zone, session.utc_offset_minutes, session.status, Utc::now().to_rfc3339()],
            ).map_err(database_error)?;
        }
        for occurrence in occurrences {
            transaction.execute(
                "INSERT INTO habit_occurrences (id, habit_id, local_date, status, session_id, created_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(habit_id, local_date) DO UPDATE SET status = excluded.status, session_id = excluded.session_id",
                params![occurrence.id, occurrence.habit_id, occurrence.local_date, occurrence.status, occurrence.session_id, Utc::now().to_rfc3339()],
            ).map_err(database_error)?;
        }
        transaction.commit().map_err(database_error)
    }

    pub fn delete_sessions(&self, ids: &[String]) -> Result<(), String> {
        let mut connection = open_connection(&self.path)?;
        let transaction = connection.transaction().map_err(database_error)?;
        for id in ids {
            transaction
                .execute("DELETE FROM habit_occurrences WHERE session_id = ?1", [id])
                .map_err(database_error)?;
            let changed = transaction.execute(
                "DELETE FROM execution_sessions WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM execution_records WHERE session_id = ?1)",
                [id],
            ).map_err(database_error)?;
            if changed != 1 {
                return Err("找不到可取消的计划时段，或本次已产生执行记录".into());
            }
        }
        transaction.commit().map_err(database_error)
    }

    pub fn create_recurring_habit(
        &self,
        habit: &RecurringHabit,
        backing_task: &Task,
    ) -> Result<(), String> {
        validate_recurring_habit(habit)?;
        validate_task_fields(backing_task)?;
        if backing_task.kind != "habit"
            || backing_task.id != habit.task_id
            || backing_task.title.trim() != habit.title.trim()
        {
            return Err("重复习惯必须使用匹配的内部关联任务".into());
        }
        let weekdays = serde_json::to_string(&habit.weekdays)
            .map_err(|error| format!("无法保存重复日期：{error}"))?;
        let mut connection = open_connection(&self.path)?;
        let transaction = connection.transaction().map_err(database_error)?;
        let now = Utc::now().to_rfc3339();
        transaction.execute(
            "INSERT INTO tasks (id, project_id, title, progress, status, deadline_local, estimated_minutes, session_minutes, priority, sort_order, source_url, source_key, media_minutes, kind, created_at_utc, updated_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)",
            params![backing_task.id, backing_task.project_id, backing_task.title, backing_task.progress, backing_task.status, backing_task.deadline_local, backing_task.estimated_minutes, backing_task.session_minutes, backing_task.priority, backing_task.sort_order, backing_task.source_url, backing_task.source_key, backing_task.media_minutes, backing_task.kind, now],
        ).map_err(database_error)?;
        transaction.execute(
            "INSERT INTO recurring_habits (id, task_id, title, pattern, weekdays_json, start_date, session_minutes, preferred_start_local, status, created_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![habit.id, habit.task_id, habit.title, habit.pattern, weekdays, habit.start_date, habit.session_minutes, habit.preferred_start_local, habit.status, now],
        ).map_err(database_error)?;
        transaction.commit().map_err(database_error)
    }

    pub fn set_habit_occurrence(&self, occurrence: &HabitOccurrence) -> Result<(), String> {
        NaiveDate::parse_from_str(&occurrence.local_date, "%Y-%m-%d")
            .map_err(|_| "习惯发生日期必须使用 YYYY-MM-DD 格式")?;
        if !matches!(
            occurrence.status.as_str(),
            "scheduled" | "completed" | "skipped"
        ) {
            return Err("习惯发生状态无效".into());
        }
        let connection = open_connection(&self.path)?;
        connection.execute(
            "INSERT INTO habit_occurrences (id, habit_id, local_date, status, session_id, created_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(habit_id, local_date) DO UPDATE SET status = excluded.status, session_id = excluded.session_id",
            params![occurrence.id, occurrence.habit_id, occurrence.local_date, occurrence.status, occurrence.session_id, Utc::now().to_rfc3339()],
        ).map(|_| ()).map_err(database_error)
    }

    pub fn schedule_habit_occurrence(
        &self,
        occurrence: &HabitOccurrence,
        session: &ExecutionSession,
    ) -> Result<(), String> {
        if occurrence.status != "scheduled"
            || occurrence.session_id.as_deref() != Some(session.id.as_str())
            || occurrence.local_date != session.local_date
        {
            return Err("习惯发生项与计划时段不匹配".into());
        }
        validate_session(session)?;
        let mut connection = open_connection(&self.path)?;
        let transaction = connection.transaction().map_err(database_error)?;
        transaction.execute(
            "INSERT INTO execution_sessions (id, task_id, local_date, end_local_date, start_local, end_local, time_zone, utc_offset_minutes, status, created_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![session.id, session.task_id, session.local_date, session.end_local_date, session.start_local, session.end_local, session.time_zone, session.utc_offset_minutes, session.status, Utc::now().to_rfc3339()],
        ).map_err(database_error)?;
        transaction.execute(
            "INSERT INTO habit_occurrences (id, habit_id, local_date, status, session_id, created_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(habit_id, local_date) DO UPDATE SET status = excluded.status, session_id = excluded.session_id",
            params![occurrence.id, occurrence.habit_id, occurrence.local_date, occurrence.status, occurrence.session_id, Utc::now().to_rfc3339()],
        ).map_err(database_error)?;
        transaction.commit().map_err(database_error)
    }

    pub fn mark_rescue_prompted(&self, session_id: &str, shown_at_utc: &str) -> Result<(), String> {
        parse_utc_fact("挽救提示时间", shown_at_utc)?;
        let connection = open_connection(&self.path)?;
        connection
            .execute(
                "INSERT OR IGNORE INTO rescue_prompts (session_id, shown_at_utc) VALUES (?1, ?2)",
                params![session_id, shown_at_utc],
            )
            .map(|_| ())
            .map_err(database_error)
    }

    pub fn update_session(&self, session: &ExecutionSession) -> Result<(), String> {
        validate_session(session)?;
        let offset = session
            .utc_offset_minutes
            .expect("validated session offset");
        let mut connection = open_connection(&self.path)?;
        let transaction = connection.transaction().map_err(database_error)?;
        let changed = transaction.execute(
            "UPDATE execution_sessions SET task_id = ?1, local_date = ?2, end_local_date = ?3, start_local = ?4, end_local = ?5, time_zone = ?6, utc_offset_minutes = ?7, status = ?8 WHERE id = ?9 AND NOT EXISTS (SELECT 1 FROM execution_records WHERE session_id = ?9)",
            params![session.task_id, session.local_date, session.end_local_date, session.start_local, session.end_local, session.time_zone, offset, session.status, session.id],
        ).map_err(database_error)?;
        if changed == 1 {
            if session.status == "cancelled" {
                transaction.execute(
                    "UPDATE habit_occurrences SET status = 'skipped' WHERE session_id = ?1 AND status = 'scheduled'",
                    [&session.id],
                ).map_err(database_error)?;
            } else if session.status == "scheduled" {
                transaction.execute(
                    "UPDATE habit_occurrences SET status = 'scheduled' WHERE session_id = ?1 AND status = 'skipped'",
                    [&session.id],
                ).map_err(database_error)?;
            }
            transaction.commit().map_err(database_error)
        } else {
            Err("找不到可移动的计划时段，或本次已产生执行记录".into())
        }
    }

    pub fn apply_session_changes(
        &self,
        create: &[ExecutionSession],
        update: &[ExecutionSession],
        delete_ids: &[String],
    ) -> Result<(), String> {
        for session in create.iter().chain(update.iter()) {
            validate_session(session)?;
        }
        let mut connection = open_connection(&self.path)?;
        let transaction = connection.transaction().map_err(database_error)?;
        for id in delete_ids {
            transaction
                .execute("DELETE FROM habit_occurrences WHERE session_id = ?1", [id])
                .map_err(database_error)?;
            let changed = transaction.execute(
                "DELETE FROM execution_sessions WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM execution_records WHERE session_id = ?1)",
                [id],
            ).map_err(database_error)?;
            if changed != 1 {
                return Err("找不到可取消的计划时段，或本次已产生执行记录".into());
            }
        }
        for session in update {
            let changed = transaction.execute(
                "UPDATE execution_sessions SET task_id = ?1, local_date = ?2, end_local_date = ?3, start_local = ?4, end_local = ?5, time_zone = ?6, utc_offset_minutes = ?7, status = ?8 WHERE id = ?9 AND NOT EXISTS (SELECT 1 FROM execution_records WHERE session_id = ?9)",
                params![session.task_id, session.local_date, session.end_local_date, session.start_local, session.end_local, session.time_zone, session.utc_offset_minutes, session.status, session.id],
            ).map_err(database_error)?;
            if changed != 1 {
                return Err("找不到可移动的计划时段，或本次已产生执行记录".into());
            }
            if session.status == "cancelled" {
                transaction.execute("UPDATE habit_occurrences SET status = 'skipped' WHERE session_id = ?1 AND status = 'scheduled'", [&session.id]).map_err(database_error)?;
            } else if session.status == "scheduled" {
                transaction.execute("UPDATE habit_occurrences SET status = 'scheduled' WHERE session_id = ?1 AND status = 'skipped'", [&session.id]).map_err(database_error)?;
            }
        }
        for session in create {
            transaction.execute(
                "INSERT INTO execution_sessions (id, task_id, local_date, end_local_date, start_local, end_local, time_zone, utc_offset_minutes, status, created_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![session.id, session.task_id, session.local_date, session.end_local_date, session.start_local, session.end_local, session.time_zone, session.utc_offset_minutes, session.status, Utc::now().to_rfc3339()],
            ).map_err(database_error)?;
        }
        transaction.commit().map_err(database_error)
    }

    pub fn delete_session(&self, id: &str) -> Result<(), String> {
        let connection = open_connection(&self.path)?;
        let changed = connection.execute(
            "DELETE FROM execution_sessions WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM execution_records WHERE session_id = ?1)",
            [id],
        ).map_err(database_error)?;
        if changed == 1 {
            Ok(())
        } else {
            Err("找不到可取消的计划时段，或本次已产生执行记录".into())
        }
    }

    pub fn create_execution_record(&self, record: &ExecutionRecord) -> Result<(), String> {
        let start = parse_utc_fact("实际开始时间", &record.actual_start_utc)?;
        if let Some(end_value) = &record.actual_end_utc {
            let end = parse_utc_fact("实际结束时间", end_value)?;
            if end <= start {
                return Err("实际结束时间必须晚于实际开始时间".into());
            }
        }
        let mut connection = open_connection(&self.path)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        if record.actual_end_utc.is_none() {
            let active: i64 = transaction
                .query_row(
                    "SELECT COUNT(*) FROM execution_records WHERE actual_end_utc IS NULL",
                    [],
                    |row| row.get(0),
                )
                .map_err(database_error)?;
            if active > 0 {
                return Err("已有正在进行的本次执行，请先结束后再开始下一项".into());
            }
        }
        transaction.execute(
            "INSERT INTO execution_records (id, session_id, task_id, actual_start_utc, actual_end_utc, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![record.id, record.session_id, record.task_id, record.actual_start_utc, record.actual_end_utc, record.note],
        ).map_err(database_error)?;
        transaction.commit().map_err(database_error)
    }

    pub fn finish_execution(
        &self,
        record_id: &str,
        actual_end_utc: &str,
        note: &str,
        event: &ProgressEvent,
    ) -> Result<(), String> {
        let end = parse_utc_fact("实际结束时间", actual_end_utc)?;
        let mut connection = open_connection(&self.path)?;
        let transaction = connection.transaction().map_err(database_error)?;
        let (start_value, task_id, session_id): (String, String, Option<String>) = transaction.query_row(
            "SELECT actual_start_utc, task_id, session_id FROM execution_records WHERE id = ?1 AND actual_end_utc IS NULL",
            [record_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).map_err(|_| "找不到仍在进行的本次执行".to_string())?;
        let start = parse_utc_fact("实际开始时间", &start_value)?;
        if end <= start {
            return Err("实际结束时间必须晚于实际开始时间".into());
        }
        if event.task_id != task_id {
            return Err("进度事件必须属于正在结束的任务".into());
        }
        insert_progress_event(&transaction, event)?;
        let changed = update_task_progress(&transaction, event)?;
        if changed != 1 {
            return Err("任务当前完成度与进度事件起点不一致".into());
        }
        transaction.execute(
            "UPDATE execution_records SET actual_end_utc = ?1, note = ?2 WHERE id = ?3 AND actual_end_utc IS NULL",
            params![actual_end_utc, note, record_id],
        ).map_err(database_error)?;
        if let Some(session_id) = session_id {
            transaction
                .execute(
                    "UPDATE habit_occurrences SET status = 'completed' WHERE session_id = ?1",
                    [session_id],
                )
                .map_err(database_error)?;
        }
        transaction.commit().map_err(database_error)
    }

    pub fn apply_progress(&self, event: &ProgressEvent) -> Result<(), String> {
        let mut connection = open_connection(&self.path)?;
        let transaction = connection.transaction().map_err(database_error)?;
        insert_progress_event(&transaction, event)?;
        let changed = update_task_progress(&transaction, event)?;
        if changed != 1 {
            return Err("任务当前完成度与进度事件起点不一致".into());
        }
        transaction.commit().map_err(database_error)
    }

    /// 为一次「进度到 100」写入完成记录与图片，全部落在同一个事务里。
    ///
    /// 记录只**引用**进度事件：既不新建进度事实，也不改写已有事实。
    pub fn record_completion(
        &self,
        record: &CompletionRecord,
        images: &[CompletionImage],
    ) -> Result<(), String> {
        let stored = validate_completion_write(record, images)?;
        let mut connection = open_connection(&self.path)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        verify_completion_event(&transaction, record)?;
        let already_recorded: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM completion_records WHERE progress_event_id = ?1)",
                [&record.progress_event_id],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        if already_recorded {
            return Err("这次完成已经记录过了".into());
        }
        let now = Utc::now().to_rfc3339();
        transaction.execute(
            "INSERT INTO completion_records (id, task_id, progress_event_id, completed_at_utc, progress_before, progress_after, fit, note, tags, reverted_at_utc, created_at_utc, updated_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, 100, ?6, ?7, ?8, NULL, ?9, ?9)",
            params![
                record.id,
                record.task_id,
                record.progress_event_id,
                record.completed_at_utc,
                stored.progress_before,
                record.fit,
                stored.note,
                stored.tags_json,
                now,
            ],
        ).map_err(database_error)?;
        insert_completion_images(&transaction, &record.id, &stored.images, &now)?;
        transaction.commit().map_err(database_error)
    }

    /// 修改一条未撤回的完成记录；图片集按**整体替换**落库，不留孤儿行。
    pub fn update_completion(
        &self,
        record: &CompletionRecord,
        images: &[CompletionImage],
    ) -> Result<(), String> {
        let stored = validate_completion_write(record, images)?;
        let mut connection = open_connection(&self.path)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        let existing = read_completion_record(&transaction, &record.id)?;
        if existing.reverted_at_utc.is_some() {
            return Err("已撤回的完成记录只保留历史，不能修改".into());
        }
        // 完成时间、任务与它引用的进度事件是这条记录的身份，不是可编辑字段。
        if existing.task_id != record.task_id
            || existing.progress_event_id != record.progress_event_id
            || existing.completed_at_utc != record.completed_at_utc
            || existing.progress_before != record.progress_before
        {
            return Err("完成记录引用的进度事实不能改写".into());
        }
        verify_completion_event(&transaction, record)?;
        let now = Utc::now().to_rfc3339();
        transaction.execute(
            "UPDATE completion_records SET fit = ?1, note = ?2, tags = ?3, updated_at_utc = ?4 WHERE id = ?5 AND reverted_at_utc IS NULL",
            params![record.fit, stored.note, stored.tags_json, now, record.id],
        ).map_err(database_error)?;
        transaction
            .execute("DELETE FROM completion_images WHERE completion_id = ?1", [&record.id])
            .map_err(database_error)?;
        insert_completion_images(&transaction, &record.id, &stored.images, &now)?;
        transaction.commit().map_err(database_error)
    }

    /// 撤回完成：原子地写一次回退进度事件并把记录标记为已撤回。
    ///
    /// 文字、标签与图片全部保留 —— 撤回的是「完成」这个事实，不是用户记下的内容。
    pub fn revert_completion(&self, record_id: &str, event: &ProgressEvent) -> Result<(), String> {
        let mut connection = open_connection(&self.path)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(database_error)?;
        let record = read_completion_record(&transaction, record_id)?;
        if record.reverted_at_utc.is_some() {
            return Err("这条完成记录已经撤回".into());
        }
        if event.task_id != record.task_id {
            return Err("回退事件必须属于这条记录的任务".into());
        }
        if event.from_progress != 100 || event.to_progress != record.progress_before {
            return Err(format!(
                "回退事件必须从 100 回到 {}%",
                record.progress_before
            ));
        }
        let current_progress: i64 = transaction
            .query_row(
                "SELECT progress FROM tasks WHERE id = ?1",
                [&record.task_id],
                |row| row.get(0),
            )
            .map_err(|_| "找不到这条完成记录的任务".to_string())?;
        if current_progress != 100 {
            return Err("任务进度已经变化，请先刷新后重试".into());
        }
        parse_utc_fact("进度发生时间", &event.occurred_at_utc)?;
        insert_progress_event(&transaction, event)?;
        let changed = update_task_progress(&transaction, event)?;
        if changed != 1 {
            return Err("任务当前完成度与进度事件起点不一致".into());
        }
        transaction.execute(
            "UPDATE completion_records SET reverted_at_utc = ?1, updated_at_utc = ?1 WHERE id = ?2 AND reverted_at_utc IS NULL",
            params![Utc::now().to_rfc3339(), record_id],
        ).map_err(database_error)?;
        transaction.commit().map_err(database_error)
    }

    /// 按需取某条记录的图片字节；快照不带图片，列表只读 `imageCount`。
    pub fn completion_images(&self, record_id: &str) -> Result<Vec<CompletionImage>, String> {
        use base64::Engine as _;
        let connection = open_connection(&self.path)?;
        let mut statement = connection
            .prepare(
                "SELECT id, sort_order, mime, width, height, size_bytes, data, thumb FROM completion_images WHERE completion_id = ?1 ORDER BY sort_order, id",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map([record_id], |row| {
                Ok(CompletionImage {
                    id: row.get(0)?,
                    sort_order: row.get(1)?,
                    mime: row.get(2)?,
                    width: row.get(3)?,
                    height: row.get(4)?,
                    size_bytes: row.get(5)?,
                    data_base64: base64::engine::general_purpose::STANDARD.encode(row.get::<_, Vec<u8>>(6)?),
                    thumb_base64: base64::engine::general_purpose::STANDARD.encode(row.get::<_, Vec<u8>>(7)?),
                })
            })
            .map_err(database_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(database_error)?;
        Ok(rows)
    }

    pub fn create_time_block(&self, block: &TimeBlock) -> Result<(), String> {
        validate_title("时间块", &block.title)?;
        validate_local_interval(
            &block.local_date,
            &block.end_local_date,
            &block.start_local,
            &block.end_local,
            &block.time_zone,
        )?;
        let connection = open_connection(&self.path)?;
        connection.execute(
            "INSERT INTO time_blocks (id, title, local_date, end_local_date, start_local, end_local, time_zone, utc_offset_minutes, created_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![block.id, block.title, block.local_date, block.end_local_date, block.start_local, block.end_local, block.time_zone, block.utc_offset_minutes, Utc::now().to_rfc3339()],
        ).map(|_| ()).map_err(database_error)
    }

    pub fn update_time_block(&self, block: &TimeBlock) -> Result<(), String> {
        validate_title("时间块", &block.title)?;
        validate_local_interval(
            &block.local_date,
            &block.end_local_date,
            &block.start_local,
            &block.end_local,
            &block.time_zone,
        )?;
        let connection = open_connection(&self.path)?;
        let changed = connection
            .execute(
                "UPDATE time_blocks SET title = ?1, local_date = ?2, end_local_date = ?3, start_local = ?4, end_local = ?5, time_zone = ?6, utc_offset_minutes = ?7 WHERE id = ?8",
                params![block.title, block.local_date, block.end_local_date, block.start_local, block.end_local, block.time_zone, block.utc_offset_minutes, block.id],
            )
            .map_err(database_error)?;
        if changed == 1 {
            Ok(())
        } else {
            Err(format!("未找到要更新的时间块：{}", block.id))
        }
    }

    pub fn delete_time_block(&self, id: &str) -> Result<(), String> {
        let connection = open_connection(&self.path)?;
        let changed = connection
            .execute("DELETE FROM time_blocks WHERE id = ?1", [id])
            .map_err(database_error)?;
        if changed == 1 {
            Ok(())
        } else {
            Err("找不到要删除的时间块".into())
        }
    }
}

fn parse_utc_fact(kind: &str, value: &str) -> Result<DateTime<chrono::FixedOffset>, String> {
    let parsed = DateTime::parse_from_rfc3339(value)
        .map_err(|_| format!("{kind}必须使用 RFC 3339 UTC 格式"))?;
    if parsed.offset().local_minus_utc() != 0 {
        return Err(format!("{kind}必须使用 UTC 偏移 Z 或 +00:00"));
    }
    Ok(parsed)
}

fn open_connection(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(database_error)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(database_error)?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
        .map_err(database_error)?;
    Ok(connection)
}

fn migrate(connection: &mut Connection) -> Result<(), String> {
    let mut version = read_schema_version_if_present(connection)?;
    if version > CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "数据库版本 {version} 高于当前支持的版本 {CURRENT_SCHEMA_VERSION}"
        ));
    }

    let migrations = [
        (1_i64, include_str!("../migrations/001_initial.sql")),
        (2_i64, include_str!("../migrations/002_time_blocks.sql")),
        (
            3_i64,
            include_str!("../migrations/003_cross_day_local_dates.sql"),
        ),
        (4_i64, include_str!("../migrations/004_phase1_actions.sql")),
        (
            5_i64,
            include_str!("../migrations/005_phase2_candidate.sql"),
        ),
        (
            6_i64,
            include_str!("../migrations/006_project_constraints.sql"),
        ),
        (
            7_i64,
            include_str!("../migrations/007_milestone_outcomes.sql"),
        ),
        (
            8_i64,
            include_str!("../migrations/008_completion_records.sql"),
        ),
    ];
    for (target_version, sql) in migrations {
        if version >= target_version {
            continue;
        }
        let transaction = connection.transaction().map_err(database_error)?;
        transaction.execute_batch(sql).map_err(database_error)?;
        verify_migration_version(&transaction, target_version)?;
        transaction.commit().map_err(database_error)?;
        version = target_version;
    }
    Ok(())
}

fn read_schema_version_if_present(connection: &Connection) -> Result<i64, String> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version')",
        [],
        |row| row.get(0),
    ).map_err(database_error)?;
    if !exists {
        return Ok(0);
    }
    read_schema_version(connection)
}

fn read_schema_version(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT version FROM schema_version WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(database_error)
}

fn verify_migration_version(transaction: &Transaction<'_>, expected: i64) -> Result<(), String> {
    let actual: i64 = transaction
        .query_row(
            "SELECT version FROM schema_version WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(database_error)?;
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "迁移结束后的 schema_version 为 {actual}，预期为 {expected}"
        ))
    }
}

fn validate_title(kind: &str, title: &str) -> Result<(), String> {
    if title.trim().is_empty() {
        Err(format!("{kind}标题不能为空"))
    } else {
        Ok(())
    }
}

fn validate_project(project: &Project) -> Result<(), String> {
    validate_title("项目", &project.title)?;
    if let Some(deadline) = &project.deadline_local {
        NaiveDate::parse_from_str(deadline, "%Y-%m-%d")
            .map_err(|_| "项目截止日期必须使用 YYYY-MM-DD 格式")?;
    }
    Ok(())
}

fn validate_project_milestone(milestone: &ProjectMilestone) -> Result<(), String> {
    validate_title("项目里程碑", &milestone.title)?;
    NaiveDate::parse_from_str(&milestone.target_local_date, "%Y-%m-%d")
        .map_err(|_| "项目里程碑日期必须使用 YYYY-MM-DD 格式")?;
    let valid = match milestone.criterion_kind.as_str() {
        "orderedTask" => milestone.target_task_id.is_some() && milestone.target_count.is_none() && milestone.target_progress.is_none(),
        "taskCount" => milestone.target_task_id.is_none() && milestone.target_count.is_some_and(|value| value > 0) && milestone.target_progress.is_none(),
        "projectProgress" => milestone.target_task_id.is_none() && milestone.target_count.is_none() && milestone.target_progress.is_some_and(|value| (1..=100).contains(&value)),
        _ => false,
    };
    if valid { Ok(()) } else { Err("项目里程碑必须且只能设置一种有效达成条件".into()) }
}

fn validate_milestone_relations(connection: &Connection, milestone: &ProjectMilestone) -> Result<(), String> {
    let project_exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
        [&milestone.project_id],
        |row| row.get(0),
    ).map_err(database_error)?;
    if !project_exists { return Err("项目里程碑必须属于已有项目".into()); }
    if let Some(task_id) = &milestone.target_task_id {
        let task_matches: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE id = ?1 AND project_id = ?2)",
            params![task_id, milestone.project_id],
            |row| row.get(0),
        ).map_err(database_error)?;
        if !task_matches { return Err("有序任务里程碑的目标任务必须属于同一项目".into()); }
    }
    Ok(())
}

fn validate_task_fields(task: &Task) -> Result<(), String> {
    validate_title("任务", &task.title)?;
    if task.progress > 100 {
        return Err("任务完成度必须在 0 到 100 之间".into());
    }
    if !matches!(task.status.as_str(), "active" | "paused" | "completed") {
        return Err("任务状态无效".into());
    }
    if let Some(deadline) = &task.deadline_local {
        NaiveDate::parse_from_str(deadline, "%Y-%m-%d")
            .map_err(|_| "截止日期必须使用 YYYY-MM-DD 格式")?;
    }
    if matches!(task.estimated_minutes, Some(0)) {
        return Err("预计耗时必须大于 0".into());
    }
    if matches!(task.session_minutes, Some(0)) {
        return Err("单次投入时长必须大于 0".into());
    }
    if matches!(task.media_minutes, Some(0)) {
        return Err("媒体时长必须大于 0".into());
    }
    if !matches!(task.priority.as_str(), "low" | "normal" | "high") {
        return Err("任务优先级无效".into());
    }
    if !matches!(task.kind.as_str(), "task" | "habit") {
        return Err("任务类型无效".into());
    }
    Ok(())
}

fn validate_session(session: &ExecutionSession) -> Result<(), String> {
    validate_local_interval(
        &session.local_date,
        &session.end_local_date,
        &session.start_local,
        &session.end_local,
        &session.time_zone,
    )?;
    let offset = session
        .utc_offset_minutes
        .ok_or_else(|| "新建计划时段必须记录 UTC 偏移".to_string())?;
    if !(-14 * 60..=14 * 60).contains(&offset) {
        return Err("UTC 偏移必须位于 -14:00 到 +14:00 之间".into());
    }
    if !matches!(
        session.status.as_str(),
        "scheduled" | "missed" | "cancelled" | "skipped"
    ) {
        return Err("计划时段状态无效".into());
    }
    Ok(())
}

fn validate_recurring_habit(habit: &RecurringHabit) -> Result<(), String> {
    validate_title("重复习惯", &habit.title)?;
    NaiveDate::parse_from_str(&habit.start_date, "%Y-%m-%d")
        .map_err(|_| "习惯开始日期必须使用 YYYY-MM-DD 格式")?;
    if !matches!(habit.pattern.as_str(), "daily" | "weekdays" | "weekly")
        || !matches!(habit.status.as_str(), "active" | "paused")
    {
        return Err("重复习惯规则或状态无效".into());
    }
    if habit.session_minutes == 0 || habit.weekdays.iter().any(|day| *day > 6) {
        return Err("重复习惯时长或星期无效".into());
    }
    if habit.pattern == "weekly" && habit.weekdays.is_empty() {
        return Err("每周习惯至少选择一天".into());
    }
    if let Some(start) = &habit.preferred_start_local {
        NaiveTime::parse_from_str(start, "%H:%M")
            .map_err(|_| "习惯固定开始时间必须使用 HH:MM 格式")?;
    }
    Ok(())
}

/// 校验通过、可以落库的完成记录内容；`note` 已去首尾空白，图片字节已解码。
struct ValidatedCompletionWrite {
    progress_before: i64,
    note: String,
    tags_json: String,
    images: Vec<StoredCompletionImage>,
}

struct StoredCompletionImage {
    id: String,
    sort_order: i64,
    mime: String,
    width: i64,
    height: i64,
    size_bytes: i64,
    data: Vec<u8>,
    thumb: Vec<u8>,
}

fn validate_completion_write(
    record: &CompletionRecord,
    images: &[CompletionImage],
) -> Result<ValidatedCompletionWrite, String> {
    if record.id.trim().is_empty() {
        return Err("完成记录缺少标识".into());
    }
    parse_utc_fact("完成时间", &record.completed_at_utc)?;
    if record.progress_before > 99 {
        return Err("完成前的进度必须小于 100".into());
    }
    if let Some(fit) = record.fit.as_deref() {
        if !matches!(fit, "light" | "fit" | "hard") {
            return Err("适应程度只能是轻松、合适或吃力".into());
        }
    }
    let note = record.note.trim();
    if note.chars().count() > COMPLETION_NOTE_LIMIT {
        return Err(format!("完成小结不能超过 {COMPLETION_NOTE_LIMIT} 字").into());
    }
    let mut tags: Vec<&str> = Vec::with_capacity(record.tags.len());
    for tag in &record.tags {
        if !COMPLETION_TAGS.contains(&tag.as_str()) {
            return Err("感受标签只能出自默认词表".into());
        }
        if !tags.contains(&tag.as_str()) {
            tags.push(tag.as_str());
        }
    }
    if tags.len() > COMPLETION_TAGS.len() {
        return Err("感受标签最多选择 8 个".into());
    }
    if images.len() > COMPLETION_IMAGE_LIMIT {
        return Err(format!("完成图片最多 {} 张", COMPLETION_IMAGE_LIMIT).into());
    }
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let mut stored_images = Vec::with_capacity(images.len());
    for (index, image) in images.iter().enumerate() {
        if image.id.trim().is_empty() {
            return Err("完成图片缺少标识".into());
        }
        if !COMPLETION_IMAGE_MIME_TYPES.contains(&image.mime.as_str()) {
            return Err("完成图片只能是 PNG、JPEG 或 WebP".into());
        }
        if image.width <= 0 || image.height <= 0 {
            return Err("完成图片必须记录有效尺寸".into());
        }
        let data = STANDARD
            .decode(image.data_base64.as_bytes())
            .map_err(|_| "完成图片的数据无法解码".to_string())?;
        let thumb = STANDARD
            .decode(image.thumb_base64.as_bytes())
            .map_err(|_| "完成图片的缩略图无法解码".to_string())?;
        if data.is_empty() || thumb.is_empty() {
            return Err("完成图片内容为空".into());
        }
        if data.len() as i64 > COMPLETION_IMAGE_BYTES_LIMIT {
            return Err("单张完成图片压缩后不能超过 2 MB".into());
        }
        // 张数与排序由数组本身决定：整体替换时不留空洞，也不会出现重复位次。
        stored_images.push(StoredCompletionImage {
            id: image.id.clone(),
            sort_order: index as i64,
            mime: image.mime.clone(),
            width: image.width,
            height: image.height,
            size_bytes: data.len() as i64,
            data,
            thumb,
        });
    }
    let tags_json = serde_json::to_string(&tags)
        .map_err(|error| format!("无法保存感受标签：{error}"))?;
    Ok(ValidatedCompletionWrite {
        progress_before: i64::from(record.progress_before),
        note: note.to_owned(),
        tags_json,
        images: stored_images,
    })
}

/// 完成记录引用的进度事实：事件必须真实存在、到 100、属于这个任务，且任务现在仍是 100。
fn verify_completion_event(
    transaction: &Transaction<'_>,
    record: &CompletionRecord,
) -> Result<(), String> {
    let event: (String, i64, i64, String) = transaction
        .query_row(
            "SELECT task_id, from_progress, to_progress, occurred_at_utc FROM progress_events WHERE id = ?1",
            [&record.progress_event_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|_| "找不到这次完成对应的进度事件".to_string())?;
    if event.2 != 100 {
        return Err("完成记录只能引用进度到达 100 的事件".into());
    }
    if event.0 != record.task_id {
        return Err("完成记录必须引用同一任务的进度事件".into());
    }
    if event.1 != i64::from(record.progress_before) {
        return Err("完成前的进度与进度事件不一致".into());
    }
    if event.3 != record.completed_at_utc {
        return Err("完成时间必须与对应的进度事件一致".into());
    }
    let task: (String, i64) = transaction
        .query_row(
            "SELECT kind, progress FROM tasks WHERE id = ?1",
            [&record.task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "找不到这条完成记录的任务".to_string())?;
    if task.0 == "habit" {
        return Err("重复习惯的发生项不记录完成反馈".into());
    }
    if task.1 != 100 {
        return Err("任务当前完成度不是 100，无法记录这次完成".into());
    }
    Ok(())
}

fn read_completion_record(
    transaction: &Transaction<'_>,
    record_id: &str,
) -> Result<CompletionRecord, String> {
    let row = transaction
        .query_row(
            "SELECT id, task_id, progress_event_id, completed_at_utc, progress_before, fit, note, tags, reverted_at_utc FROM completion_records WHERE id = ?1",
            [record_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ))
            },
        )
        .map_err(|_| "找不到这条完成记录".to_string())?;
    Ok(CompletionRecord {
        id: row.0,
        task_id: row.1,
        progress_event_id: row.2,
        completed_at_utc: row.3,
        progress_before: row.4 as u8,
        fit: row.5,
        note: row.6,
        tags: parse_completion_tags(&row.7)?,
        reverted_at_utc: row.8,
    })
}

fn insert_completion_images(
    transaction: &Transaction<'_>,
    record_id: &str,
    images: &[StoredCompletionImage],
    now: &str,
) -> Result<(), String> {
    for image in images {
        transaction.execute(
            "INSERT INTO completion_images (id, completion_id, sort_order, mime, width, height, size_bytes, data, thumb, created_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                image.id,
                record_id,
                image.sort_order,
                image.mime,
                image.width,
                image.height,
                image.size_bytes,
                image.data,
                image.thumb,
                now,
            ],
        ).map_err(database_error)?;
    }
    Ok(())
}

fn parse_completion_tags(raw: &str) -> Result<Vec<String>, String> {
    serde_json::from_str(raw).map_err(|error| format!("无法读取感受标签：{error}"))
}

fn insert_progress_event(
    transaction: &Transaction<'_>,
    event: &ProgressEvent,
) -> Result<(), String> {
    parse_utc_fact("进度发生时间", &event.occurred_at_utc)?;
    transaction.execute(
        "INSERT INTO progress_events (id, task_id, from_progress, to_progress, occurred_at_utc) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![event.id, event.task_id, event.from_progress, event.to_progress, event.occurred_at_utc],
    ).map(|_| ()).map_err(database_error)
}

fn update_task_progress(
    transaction: &Transaction<'_>,
    event: &ProgressEvent,
) -> Result<usize, String> {
    transaction.execute(
        "UPDATE tasks SET progress = ?1, status = CASE WHEN ?1 = 100 THEN 'completed' WHEN status = 'completed' THEN 'active' ELSE status END, updated_at_utc = ?2 WHERE id = ?3 AND progress = ?4",
        params![event.to_progress, event.occurred_at_utc, event.task_id, event.from_progress],
    ).map_err(database_error)
}

fn validate_local_interval(
    start_date: &str,
    end_date: &str,
    start: &str,
    end: &str,
    time_zone: &str,
) -> Result<(), String> {
    if time_zone.trim().is_empty() {
        return Err("计划时间必须保留本地日期、起止时间和时区".into());
    }
    let start_date = NaiveDate::parse_from_str(start_date, "%Y-%m-%d")
        .map_err(|_| "计划开始日期必须使用 YYYY-MM-DD 格式")?;
    let end_date = NaiveDate::parse_from_str(end_date, "%Y-%m-%d")
        .map_err(|_| "计划结束日期必须使用 YYYY-MM-DD 格式")?;
    let start =
        NaiveTime::parse_from_str(start, "%H:%M").map_err(|_| "计划开始时间必须使用 HH:MM 格式")?;
    let end =
        NaiveTime::parse_from_str(end, "%H:%M").map_err(|_| "计划结束时间必须使用 HH:MM 格式")?;
    if end_date < start_date || (end_date == start_date && end <= start) {
        return Err("结束时间必须晚于开始时间".into());
    }
    Ok(())
}

fn database_error(error: rusqlite::Error) -> String {
    format!("SQLite 操作失败：{error}")
}

fn query_projects(connection: &Connection) -> Result<Vec<Project>, String> {
    query_rows(
        connection,
        "SELECT id, title, deadline_local FROM projects ORDER BY id",
        |row| {
            Ok(Project {
                id: row.get(0)?,
                title: row.get(1)?,
                deadline_local: row.get(2)?,
            })
        },
    )
}

fn query_project_milestones(connection: &Connection) -> Result<Vec<ProjectMilestone>, String> {
    query_rows(
        connection,
        "SELECT id, project_id, title, target_local_date, criterion_kind, target_task_id, target_count, target_progress, sort_order FROM project_milestones ORDER BY target_local_date, sort_order, id",
        |row| {
            Ok(ProjectMilestone {
                id: row.get(0)?,
                project_id: row.get(1)?,
                title: row.get(2)?,
                target_local_date: row.get(3)?,
                criterion_kind: row.get(4)?,
                target_task_id: row.get(5)?,
                target_count: row.get::<_, Option<i64>>(6)?.map(|value| value as u32),
                target_progress: row.get::<_, Option<i64>>(7)?.map(|value| value as u8),
                sort_order: row.get(8)?,
            })
        },
    )
}

fn query_milestone_outcomes(connection: &Connection) -> Result<Vec<MilestoneOutcome>, String> {
    query_rows(
        connection,
        "SELECT id, milestone_id, project_id, title, target_local_date, reached, result_text, frozen_at_utc FROM milestone_outcomes ORDER BY target_local_date, id",
        |row| {
            Ok(MilestoneOutcome {
                id: row.get(0)?,
                milestone_id: row.get(1)?,
                project_id: row.get(2)?,
                title: row.get(3)?,
                target_local_date: row.get(4)?,
                reached: row.get::<_, i64>(5)? != 0,
                result_text: row.get(6)?,
                frozen_at_utc: row.get(7)?,
            })
        },
    )
}

fn milestone_reached(milestone: &ProjectMilestone, tasks: &[Task]) -> bool {
    let completed = |task: &Task| task.status == "completed" || task.progress >= 100;
    match milestone.criterion_kind.as_str() {
        "orderedTask" => ordered_milestone_tasks(milestone, tasks)
            .is_some_and(|ordered| ordered.iter().all(|task| completed(task))),
        "taskCount" => {
            let project_tasks = tasks.iter().filter(|task| task.project_id.as_deref() == Some(milestone.project_id.as_str()));
            project_tasks.filter(|task| completed(task)).count() as u32 >= milestone.target_count.unwrap_or(0)
        }
        "projectProgress" => {
            let target = milestone.target_progress.unwrap_or(0) as u32;
            let weighted: u32 = tasks.iter()
                .filter(|task| task.project_id.as_deref() == Some(milestone.project_id.as_str()))
                .map(|task| task.progress as u32 * task.estimated_minutes.unwrap_or(60))
                .sum();
            let total: u32 = tasks.iter()
                .filter(|task| task.project_id.as_deref() == Some(milestone.project_id.as_str()))
                .map(|task| task.estimated_minutes.unwrap_or(60))
                .sum();
            if total == 0 { return false; }
            let progress = (weighted as f64 / total as f64).round() as u32;
            progress >= target
        }
        _ => false,
    }
}

fn outcome_text(milestone: &ProjectMilestone, tasks: &[Task], reached: bool) -> String {
    let completed = |task: &Task| task.status == "completed" || task.progress >= 100;
    let actual = match milestone.criterion_kind.as_str() {
        "orderedTask" => {
            let title = milestone.target_task_id.as_ref()
                .and_then(|id| tasks.iter().find(|task| &task.id == id))
                .map(|task| task.title.as_str())
                .unwrap_or("目标任务");
            let ordered = ordered_milestone_tasks(milestone, tasks).unwrap_or_default();
            let done = ordered.iter().filter(|task| completed(task)).count();
            format!("完成至「{title}」{done}/{}", ordered.len())
        }
        "taskCount" => {
            let done = tasks.iter()
                .filter(|task| task.project_id.as_deref() == Some(milestone.project_id.as_str()))
                .filter(|task| completed(task)).count();
            format!("完成 {done}/{}", milestone.target_count.unwrap_or(0))
        }
        "projectProgress" => {
            let target = milestone.target_progress.unwrap_or(0) as u32;
            let weighted: u32 = tasks.iter()
                .filter(|task| task.project_id.as_deref() == Some(milestone.project_id.as_str()))
                .map(|task| task.progress as u32 * task.estimated_minutes.unwrap_or(60))
                .sum();
            let total: u32 = tasks.iter()
                .filter(|task| task.project_id.as_deref() == Some(milestone.project_id.as_str()))
                .map(|task| task.estimated_minutes.unwrap_or(60))
                .sum();
            let progress = if total == 0 { 0 } else { (weighted as f64 / total as f64).round() as u32 };
            format!("进度 {progress}/{target}%")
        }
        _ => String::new(),
    };
    if reached {
        format!("{actual}，已达成")
    } else {
        format!("{actual}，未达成")
    }
}

fn milestone_has_outcome(connection: &Connection, milestone_id: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM milestone_outcomes WHERE milestone_id = ?1)",
            [milestone_id],
            |row| row.get(0),
        )
        .map_err(database_error)
}

fn ordered_milestone_tasks<'a>(
    milestone: &ProjectMilestone,
    tasks: &'a [Task],
) -> Option<Vec<&'a Task>> {
    let target_id = milestone.target_task_id.as_ref()?;
    let mut project_tasks = tasks
        .iter()
        .filter(|task| task.project_id.as_deref() == Some(milestone.project_id.as_str()))
        .collect::<Vec<_>>();
    project_tasks.sort_by(|left, right| {
        left.sort_order
            .cmp(&right.sort_order)
            .then_with(|| left.id.cmp(&right.id))
    });
    let target_index = project_tasks.iter().position(|task| &task.id == target_id)?;
    project_tasks.truncate(target_index + 1);
    Some(project_tasks)
}

fn query_tasks(connection: &Connection) -> Result<Vec<Task>, String> {
    query_rows(
        connection,
        "SELECT id, project_id, title, progress, status, deadline_local, estimated_minutes, session_minutes, priority, sort_order, source_url, source_key, media_minutes, kind FROM tasks ORDER BY sort_order, created_at_utc, id",
        |row| {
            Ok(Task {
                id: row.get(0)?,
                project_id: row.get(1)?,
                title: row.get(2)?,
                progress: row.get::<_, i64>(3)? as u8,
                status: row.get(4)?,
                deadline_local: row.get(5)?,
                estimated_minutes: row.get::<_, Option<i64>>(6)?.map(|value| value as u32),
                session_minutes: row.get::<_, Option<i64>>(7)?.map(|value| value as u32),
                priority: row.get(8)?,
                sort_order: row.get(9)?,
                source_url: row.get(10)?,
                source_key: row.get(11)?,
                media_minutes: row.get::<_, Option<i64>>(12)?.map(|value| value as u32),
                kind: row.get(13)?,
            })
        },
    )
}

fn query_sessions(connection: &Connection) -> Result<Vec<ExecutionSession>, String> {
    query_rows(
        connection,
        "SELECT id, task_id, local_date, end_local_date, start_local, end_local, time_zone, utc_offset_minutes, status FROM execution_sessions ORDER BY local_date, start_local, id",
        |row| {
            Ok(ExecutionSession {
                id: row.get(0)?,
                task_id: row.get(1)?,
                local_date: row.get(2)?,
                end_local_date: row.get(3)?,
                start_local: row.get(4)?,
                end_local: row.get(5)?,
                time_zone: row.get(6)?,
                utc_offset_minutes: row.get(7)?,
                status: row.get(8)?,
            })
        },
    )
}

fn query_records(connection: &Connection) -> Result<Vec<ExecutionRecord>, String> {
    query_rows(
        connection,
        "SELECT id, session_id, task_id, actual_start_utc, actual_end_utc, note FROM execution_records ORDER BY actual_start_utc, id",
        |row| {
            Ok(ExecutionRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                task_id: row.get(2)?,
                actual_start_utc: row.get(3)?,
                actual_end_utc: row.get(4)?,
                note: row.get(5)?,
            })
        },
    )
}

fn query_progress_events(connection: &Connection) -> Result<Vec<ProgressEvent>, String> {
    query_rows(
        connection,
        "SELECT id, task_id, from_progress, to_progress, occurred_at_utc FROM progress_events ORDER BY id",
        |row| {
            Ok(ProgressEvent {
                id: row.get(0)?,
                task_id: row.get(1)?,
                from_progress: row.get::<_, i64>(2)? as u8,
                to_progress: row.get::<_, i64>(3)? as u8,
                occurred_at_utc: row.get(4)?,
            })
        },
    )
}

fn query_time_blocks(connection: &Connection) -> Result<Vec<TimeBlock>, String> {
    query_rows(
        connection,
        "SELECT id, title, local_date, end_local_date, start_local, end_local, time_zone, utc_offset_minutes FROM time_blocks ORDER BY id",
        |row| {
            Ok(TimeBlock {
                id: row.get(0)?,
                title: row.get(1)?,
                local_date: row.get(2)?,
                end_local_date: row.get(3)?,
                start_local: row.get(4)?,
                end_local: row.get(5)?,
                time_zone: row.get(6)?,
                utc_offset_minutes: row.get(7)?,
            })
        },
    )
}

fn query_recurring_habits(connection: &Connection) -> Result<Vec<RecurringHabit>, String> {
    let rows = query_rows(
        connection,
        "SELECT id, task_id, title, pattern, weekdays_json, start_date, session_minutes, preferred_start_local, status FROM recurring_habits ORDER BY created_at_utc, id",
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, String>(8)?,
            ))
        },
    )?;
    rows.into_iter()
        .map(
            |(
                id,
                task_id,
                title,
                pattern,
                weekdays,
                start_date,
                session_minutes,
                preferred_start_local,
                status,
            )| {
                let weekdays = serde_json::from_str::<Vec<u8>>(&weekdays)
                    .map_err(|error| format!("无法读取重复日期：{error}"))?;
                Ok(RecurringHabit {
                    id,
                    task_id,
                    title,
                    pattern,
                    weekdays,
                    start_date,
                    session_minutes: session_minutes as u32,
                    preferred_start_local,
                    status,
                })
            },
        )
        .collect()
}

fn query_habit_occurrences(connection: &Connection) -> Result<Vec<HabitOccurrence>, String> {
    query_rows(
        connection,
        "SELECT id, habit_id, local_date, status, session_id FROM habit_occurrences ORDER BY local_date, id",
        |row| {
            Ok(HabitOccurrence {
                id: row.get(0)?,
                habit_id: row.get(1)?,
                local_date: row.get(2)?,
                status: row.get(3)?,
                session_id: row.get(4)?,
            })
        },
    )
}

fn query_rescue_prompted_session_ids(connection: &Connection) -> Result<Vec<String>, String> {
    query_rows(
        connection,
        "SELECT session_id FROM rescue_prompts ORDER BY session_id",
        |row| row.get(0),
    )
}

/// 快照里的完成记录：文本字段加 join 出来的张数，**不取图片字节**。
fn query_completion_records(connection: &Connection) -> Result<Vec<CompletionRecordSummary>, String> {
    let rows = query_rows(
        connection,
        "SELECT id, task_id, progress_event_id, completed_at_utc, progress_before, fit, note, tags, reverted_at_utc, \
         (SELECT COUNT(*) FROM completion_images WHERE completion_id = completion_records.id) \
         FROM completion_records ORDER BY completed_at_utc, id",
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, i64>(9)?,
            ))
        },
    )?;
    rows.into_iter()
        .map(|(id, task_id, progress_event_id, completed_at_utc, progress_before, fit, note, tags, reverted_at_utc, image_count)| {
            Ok(CompletionRecordSummary {
                image_count,
                record: CompletionRecord {
                    id,
                    task_id,
                    progress_event_id,
                    completed_at_utc,
                    progress_before: progress_before as u8,
                    fit,
                    note,
                    tags: parse_completion_tags(&tags)?,
                    reverted_at_utc,
                },
            })
        })
        .collect()
}

fn query_rows<T, F>(connection: &Connection, sql: &str, mapper: F) -> Result<Vec<T>, String>
where
    F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
{
    let mut statement = connection.prepare(sql).map_err(database_error)?;
    let values = statement
        .query_map([], mapper)
        .map_err(database_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(database_error)?;
    Ok(values)
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use tempfile::tempdir;

    use super::*;

    fn project(id: &str) -> Project {
        Project {
            id: id.into(),
            title: "学习 Rust".into(),
            deadline_local: None,
        }
    }

    fn task(id: &str, project_id: Option<&str>) -> Task {
        Task {
            id: id.into(),
            project_id: project_id.map(str::to_owned),
            title: "完成第一章".into(),
            progress: 20,
            status: "active".into(),
            deadline_local: None,
            estimated_minutes: Some(60),
            session_minutes: None,
            priority: "normal".into(),
            sort_order: 0,
            source_url: None,
            source_key: None,
            media_minutes: None,
            kind: "task".into(),
        }
    }

    fn milestone(id: &str, project_id: &str, criterion_kind: &str) -> ProjectMilestone {
        ProjectMilestone {
            id: id.into(),
            project_id: project_id.into(),
            title: "完成基础阶段".into(),
            target_local_date: "2026-09-15".into(),
            criterion_kind: criterion_kind.into(),
            target_task_id: (criterion_kind == "orderedTask").then(|| "task-1".into()),
            target_count: (criterion_kind == "taskCount").then_some(2),
            target_progress: (criterion_kind == "projectProgress").then_some(60),
            sort_order: 0,
        }
    }

    #[test]
    fn first_open_creates_the_current_schema() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();

        assert_eq!(database.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        assert_eq!(database.snapshot().unwrap(), WorkspaceSnapshot::default());
    }

    #[test]
    fn an_old_schema_is_upgraded_without_losing_existing_tasks() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("daymark.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(include_str!("../migrations/001_initial.sql"))
            .unwrap();
        connection.execute(
            "INSERT INTO projects (id, title, created_at_utc, updated_at_utc) VALUES (?1, ?2, ?3, ?3)",
            ("project-legacy", "旧项目", "2026-07-01T00:00:00Z"),
        ).unwrap();
        connection.execute(
            "INSERT INTO tasks (id, project_id, title, progress, status, created_at_utc, updated_at_utc) VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?5)",
            ("task-legacy", "project-legacy", "旧任务", 35, "2026-07-01T00:00:00Z"),
        ).unwrap();
        connection.execute(
            "INSERT INTO execution_sessions (id, task_id, local_date, start_local, end_local, time_zone, status, created_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'scheduled', ?7)",
            ("session-legacy", "task-legacy", "2026-07-02", "20:00", "21:00", "Asia/Shanghai", "2026-07-01T00:00:00Z"),
        ).unwrap();
        drop(connection);

        let database = Database::open(&path).unwrap();
        assert_eq!(database.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        let snapshot = database.snapshot().unwrap();
        assert_eq!(snapshot.tasks[0].title, "旧任务");
        assert_eq!(snapshot.execution_sessions[0].end_local_date, "2026-07-02");
        assert_eq!(snapshot.execution_sessions[0].utc_offset_minutes, None);

        database
            .create_time_block(&TimeBlock {
                id: "block-1".into(),
                title: "通勤".into(),
                local_date: "2026-07-29".into(),
                end_local_date: "2026-07-29".into(),
                start_local: "08:00".into(),
                end_local: "08:30".into(),
                time_zone: "Asia/Shanghai".into(),
                utc_offset_minutes: 480,
            })
            .unwrap();
        assert_eq!(database.snapshot().unwrap().time_blocks.len(), 1);
    }

    #[test]
    fn v5_upgrade_adds_empty_project_constraints_without_losing_projects() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("daymark.db");
        let connection = Connection::open(&path).unwrap();
        for migration in [
            include_str!("../migrations/001_initial.sql"),
            include_str!("../migrations/002_time_blocks.sql"),
            include_str!("../migrations/003_cross_day_local_dates.sql"),
            include_str!("../migrations/004_phase1_actions.sql"),
            include_str!("../migrations/005_phase2_candidate.sql"),
        ] { connection.execute_batch(migration).unwrap(); }
        connection.execute(
            "INSERT INTO projects (id, title, created_at_utc, updated_at_utc) VALUES ('legacy-project', '旧项目', ?1, ?1)",
            ["2026-08-01T00:00:00Z"],
        ).unwrap();
        drop(connection);

        let database = Database::open(&path).unwrap();
        let snapshot = database.snapshot().unwrap();
        assert_eq!(database.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        assert_eq!(snapshot.projects[0].deadline_local, None);
        assert!(snapshot.project_milestones.is_empty());
        assert!(snapshot.milestone_outcomes.is_empty());
    }

    #[test]
    fn v3_upgrade_preserves_preexisting_unfinished_records_without_allowing_more() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("daymark.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(include_str!("../migrations/001_initial.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../migrations/002_time_blocks.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("../migrations/003_cross_day_local_dates.sql"))
            .unwrap();
        connection.execute(
            "INSERT INTO tasks (id, title, progress, status, created_at_utc, updated_at_utc) VALUES ('task-legacy', '旧任务', 0, 'active', ?1, ?1)",
            ["2026-07-01T00:00:00Z"],
        ).unwrap();
        for (id, start) in [
            ("record-a", "2026-07-01T01:00:00Z"),
            ("record-b", "2026-07-01T02:00:00Z"),
        ] {
            connection.execute(
                "INSERT INTO execution_records (id, task_id, actual_start_utc, note) VALUES (?1, 'task-legacy', ?2, '')",
                (id, start),
            ).unwrap();
        }
        drop(connection);

        let database = Database::open(&path).unwrap();
        assert_eq!(database.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        assert_eq!(database.snapshot().unwrap().execution_records.len(), 2);
        assert!(
            database
                .create_execution_record(&ExecutionRecord {
                    id: "record-c".into(),
                    session_id: None,
                    task_id: "task-legacy".into(),
                    actual_start_utc: "2026-07-01T03:00:00Z".into(),
                    actual_end_utc: None,
                    note: String::new(),
                })
                .is_err()
        );
        assert_eq!(database.snapshot().unwrap().execution_records.len(), 2);
    }

    #[test]
    fn project_and_tasks_are_saved_as_one_transaction() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        let duplicate_tasks = vec![
            task("same-id", Some("project-1")),
            task("same-id", Some("project-1")),
        ];

        assert!(
            database
                .save_project_with_tasks(&project("project-1"), &duplicate_tasks)
                .is_err()
        );
        assert_eq!(database.snapshot().unwrap(), WorkspaceSnapshot::default());
    }

    #[test]
    fn project_deadline_and_typed_milestones_round_trip_with_relation_validation() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        database.save_project_with_tasks(&project("project-1"), &[task("task-1", Some("project-1"))]).unwrap();
        database.save_project_with_tasks(&project("project-2"), &[task("task-2", Some("project-2"))]).unwrap();

        let mut updated_project = project("project-1");
        updated_project.deadline_local = Some("2026-09-30".into());
        database.update_project(&updated_project).unwrap();
        for (index, kind) in ["orderedTask", "taskCount", "projectProgress"].into_iter().enumerate() {
            let mut value = milestone(&format!("milestone-{index}"), "project-1", kind);
            value.sort_order = index as i64;
            database.create_project_milestone(&value).unwrap();
        }

        let snapshot = database.snapshot().unwrap();
        assert_eq!(snapshot.projects[0].deadline_local.as_deref(), Some("2026-09-30"));
        assert_eq!(snapshot.project_milestones.len(), 3);
        assert_eq!(snapshot.project_milestones[0].target_task_id.as_deref(), Some("task-1"));
        assert_eq!(snapshot.project_milestones[1].target_count, Some(2));
        assert_eq!(snapshot.project_milestones[2].target_progress, Some(60));

        let mut changed = snapshot.project_milestones[2].clone();
        changed.title = "达到可交付状态".into();
        changed.target_progress = Some(80);
        database.update_project_milestone(&changed).unwrap();
        assert_eq!(database.snapshot().unwrap().project_milestones[2].target_progress, Some(80));

        let mut cross_project = milestone("bad-relation", "project-2", "orderedTask");
        cross_project.target_task_id = Some("task-1".into());
        assert!(database.create_project_milestone(&cross_project).unwrap_err().contains("同一项目"));
        let mut mixed = milestone("bad-shape", "project-1", "taskCount");
        mixed.target_progress = Some(50);
        assert!(database.create_project_milestone(&mixed).unwrap_err().contains("只能设置一种"));

        database.delete_project_milestone("milestone-1").unwrap();
        assert_eq!(database.snapshot().unwrap().project_milestones.len(), 2);
    }

    #[test]
    fn ordered_task_milestone_requires_every_task_through_the_target() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        let mut previous = task("task-1", Some("project-1"));
        previous.sort_order = 0;
        let mut target = task("task-2", Some("project-1"));
        target.sort_order = 1;
        target.progress = 100;
        target.status = "completed".into();
        database
            .save_project_with_tasks(&project("project-1"), &[previous, target])
            .unwrap();
        let mut value = milestone("ordered", "project-1", "orderedTask");
        value.target_task_id = Some("task-2".into());
        value.target_local_date = "2026-08-01".into();
        database.create_project_milestone(&value).unwrap();

        assert!(database
            .freeze_expired_outcomes(NaiveDate::from_ymd_opt(2026, 8, 2).unwrap())
            .unwrap());
        let outcome = &database.snapshot().unwrap().milestone_outcomes[0];
        assert!(!outcome.reached);
        assert!(outcome.result_text.contains("1/2"));
    }

    #[test]
    fn project_progress_milestone_uses_the_existing_percentage_scale() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        let mut in_progress = task("task-1", Some("project-1"));
        in_progress.progress = 20;
        in_progress.estimated_minutes = Some(60);
        database
            .save_project_with_tasks(&project("project-1"), &[in_progress])
            .unwrap();
        let mut value = milestone("progress", "project-1", "projectProgress");
        value.target_progress = Some(50);
        value.target_local_date = "2026-08-01".into();
        database.create_project_milestone(&value).unwrap();

        assert!(database
            .freeze_expired_outcomes(NaiveDate::from_ymd_opt(2026, 8, 2).unwrap())
            .unwrap());
        let outcome = &database.snapshot().unwrap().milestone_outcomes[0];
        assert!(!outcome.reached);
        assert!(outcome.result_text.contains("20/50%"));
    }

    #[test]
    fn an_expired_unreached_milestone_is_frozen_into_an_outcome_snapshot_once() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        database.save_project_with_tasks(&project("project-1"), &[task("task-1", Some("project-1"))]).unwrap();
        let mut past = milestone("milestone-past", "project-1", "taskCount");
        past.target_local_date = "2026-08-01".into();
        database.create_project_milestone(&past).unwrap();

        assert!(!database
            .freeze_expired_outcomes(NaiveDate::from_ymd_opt(2026, 8, 1).unwrap())
            .unwrap());
        assert!(database
            .freeze_expired_outcomes(NaiveDate::from_ymd_opt(2026, 8, 2).unwrap())
            .unwrap());
        let first = database.snapshot().unwrap();
        assert_eq!(first.milestone_outcomes.len(), 1);
        let outcome = &first.milestone_outcomes[0];
        assert_eq!(outcome.milestone_id, "milestone-past");
        assert!(!outcome.reached);
        assert!(outcome.result_text.contains("未达成"));
        assert!(outcome.result_text.contains("0/2"));

        // 第二次读取不会重复冻结
        assert!(!database
            .freeze_expired_outcomes(NaiveDate::from_ymd_opt(2026, 8, 2).unwrap())
            .unwrap());
        let second = database.snapshot().unwrap();
        assert_eq!(second.milestone_outcomes.len(), 1);
    }

    #[test]
    fn reached_milestones_do_not_freeze_outcomes() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        let mut done = task("task-1", Some("project-1"));
        done.progress = 100;
        done.status = "completed".into();
        database.save_project_with_tasks(&project("project-1"), &[done]).unwrap();
        let mut past = milestone("milestone-past", "project-1", "orderedTask");
        past.target_local_date = "2026-08-01".into();
        database.create_project_milestone(&past).unwrap();

        assert!(!database
            .freeze_expired_outcomes(NaiveDate::from_ymd_opt(2026, 8, 2).unwrap())
            .unwrap());
        let snapshot = database.snapshot().unwrap();
        assert!(snapshot.milestone_outcomes.is_empty());
    }

    #[test]
    fn a_frozen_milestone_cannot_be_changed_or_deleted() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        database.save_project_with_tasks(&project("project-1"), &[task("task-1", Some("project-1"))]).unwrap();
        let mut past = milestone("milestone-past", "project-1", "taskCount");
        past.target_local_date = "2026-08-01".into();
        database.create_project_milestone(&past).unwrap();
        assert!(database
            .freeze_expired_outcomes(NaiveDate::from_ymd_opt(2026, 8, 2).unwrap())
            .unwrap());
        assert_eq!(database.snapshot().unwrap().milestone_outcomes.len(), 1);

        let mut changed = past.clone();
        changed.title = "重写历史".into();
        assert!(database.update_project_milestone(&changed).unwrap_err().contains("历史记录"));
        assert!(database.delete_project_milestone("milestone-past").unwrap_err().contains("历史记录"));
        let snapshot = database.snapshot().unwrap();
        assert_eq!(snapshot.milestone_outcomes.len(), 1);
        assert_eq!(snapshot.project_milestones.len(), 1);
        assert_eq!(snapshot.project_milestones[0].title, past.title);
    }

    #[test]
    fn planned_actual_and_progress_facts_remain_separate() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        database
            .save_project_with_tasks(&project("project-1"), &[task("task-1", Some("project-1"))])
            .unwrap();
        database
            .create_session(&ExecutionSession {
                id: "session-1".into(),
                task_id: "task-1".into(),
                local_date: "2026-07-29".into(),
                end_local_date: "2026-07-29".into(),
                start_local: "20:00".into(),
                end_local: "21:00".into(),
                time_zone: "Asia/Shanghai".into(),
                utc_offset_minutes: Some(480),
                status: "scheduled".into(),
            })
            .unwrap();

        let scheduled = database.snapshot().unwrap();
        assert_eq!(scheduled.execution_sessions.len(), 1);
        assert!(scheduled.execution_records.is_empty());
        assert_eq!(scheduled.tasks[0].progress, 20);

        database
            .create_execution_record(&ExecutionRecord {
                id: "record-1".into(),
                session_id: Some("session-1".into()),
                task_id: "task-1".into(),
                actual_start_utc: "2026-07-29T12:03:00Z".into(),
                actual_end_utc: Some("2026-07-29T12:48:00Z".into()),
                note: String::new(),
            })
            .unwrap();
        assert_eq!(database.snapshot().unwrap().tasks[0].progress, 20);

        database
            .apply_progress(&ProgressEvent {
                id: "progress-1".into(),
                task_id: "task-1".into(),
                from_progress: 20,
                to_progress: 45,
                occurred_at_utc: "2026-07-29T12:50:00Z".into(),
            })
            .unwrap();
        let final_state = database.snapshot().unwrap();
        assert_eq!(final_state.tasks[0].progress, 45);
        assert_eq!(final_state.progress_events.len(), 1);
        assert_eq!(final_state.execution_records.len(), 1);
    }

    #[test]
    fn a_planned_session_can_cross_midnight_without_rewriting_local_facts() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        database
            .save_project_with_tasks(&project("project-1"), &[task("task-1", Some("project-1"))])
            .unwrap();
        database
            .create_session(&ExecutionSession {
                id: "session-overnight".into(),
                task_id: "task-1".into(),
                local_date: "2026-07-29".into(),
                end_local_date: "2026-07-30".into(),
                start_local: "23:30".into(),
                end_local: "00:30".into(),
                time_zone: "Asia/Shanghai".into(),
                utc_offset_minutes: Some(480),
                status: "scheduled".into(),
            })
            .unwrap();

        let session = &database.snapshot().unwrap().execution_sessions[0];
        assert_eq!(session.local_date, "2026-07-29");
        assert_eq!(session.end_local_date, "2026-07-30");
        assert_eq!(session.start_local, "23:30");
        assert_eq!(session.end_local, "00:30");
    }

    #[test]
    fn execution_records_reject_invalid_or_reversed_utc_intervals() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        database
            .save_project_with_tasks(&project("project-1"), &[task("task-1", Some("project-1"))])
            .unwrap();

        let invalid = ExecutionRecord {
            id: "record-invalid".into(),
            session_id: None,
            task_id: "task-1".into(),
            actual_start_utc: "not-a-time".into(),
            actual_end_utc: None,
            note: String::new(),
        };
        assert!(database.create_execution_record(&invalid).is_err());

        let reversed = ExecutionRecord {
            id: "record-reversed".into(),
            session_id: None,
            task_id: "task-1".into(),
            actual_start_utc: "2026-07-29T12:00:00Z".into(),
            actual_end_utc: Some("2026-07-29T11:59:59Z".into()),
            note: String::new(),
        };
        assert!(database.create_execution_record(&reversed).is_err());
        assert!(database.snapshot().unwrap().execution_records.is_empty());
    }

    #[test]
    fn a_new_planned_session_cannot_omit_its_utc_offset() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        database
            .save_project_with_tasks(&project("project-1"), &[task("task-1", Some("project-1"))])
            .unwrap();
        let session = ExecutionSession {
            id: "session-no-offset".into(),
            task_id: "task-1".into(),
            local_date: "2026-07-29".into(),
            end_local_date: "2026-07-29".into(),
            start_local: "12:00".into(),
            end_local: "13:00".into(),
            time_zone: "Asia/Shanghai".into(),
            utc_offset_minutes: None,
            status: "scheduled".into(),
        };
        assert!(database.create_session(&session).is_err());
        assert!(database.snapshot().unwrap().execution_sessions.is_empty());
    }

    #[test]
    fn only_one_execution_can_be_active_at_a_time() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        database
            .save_project_with_tasks(&project("project-1"), &[task("task-1", Some("project-1"))])
            .unwrap();

        database
            .create_execution_record(&ExecutionRecord {
                id: "record-1".into(),
                session_id: None,
                task_id: "task-1".into(),
                actual_start_utc: "2026-07-29T12:00:00Z".into(),
                actual_end_utc: None,
                note: String::new(),
            })
            .unwrap();
        assert!(
            database
                .create_execution_record(&ExecutionRecord {
                    id: "record-2".into(),
                    session_id: None,
                    task_id: "task-1".into(),
                    actual_start_utc: "2026-07-29T12:01:00Z".into(),
                    actual_end_utc: None,
                    note: String::new(),
                })
                .is_err()
        );
        assert_eq!(database.snapshot().unwrap().execution_records.len(), 1);
    }

    #[test]
    fn a_session_can_be_moved_and_cancelled_without_copying_its_task() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        database
            .save_project_with_tasks(&project("project-1"), &[task("task-1", Some("project-1"))])
            .unwrap();
        let mut session = ExecutionSession {
            id: "session-1".into(),
            task_id: "task-1".into(),
            local_date: "2026-07-29".into(),
            end_local_date: "2026-07-29".into(),
            start_local: "20:00".into(),
            end_local: "21:00".into(),
            time_zone: "Asia/Shanghai".into(),
            utc_offset_minutes: Some(480),
            status: "scheduled".into(),
        };
        database.create_session(&session).unwrap();
        session.local_date = "2026-07-30".into();
        session.end_local_date = "2026-07-30".into();
        session.start_local = "09:15".into();
        session.end_local = "10:15".into();

        database.update_session(&session).unwrap();
        let moved = database.snapshot().unwrap();
        assert_eq!(moved.tasks.len(), 1);
        assert_eq!(moved.execution_sessions[0].local_date, "2026-07-30");
        assert_eq!(moved.execution_sessions[0].start_local, "09:15");

        database.delete_session("session-1").unwrap();
        let cancelled = database.snapshot().unwrap();
        assert_eq!(cancelled.tasks.len(), 1);
        assert!(cancelled.execution_sessions.is_empty());
    }

    #[test]
    fn calendar_session_changes_roll_back_as_one_transaction() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        database
            .save_project_with_tasks(&project("project-1"), &[task("task-1", Some("project-1"))])
            .unwrap();
        let original = ExecutionSession {
            id: "session-1".into(),
            task_id: "task-1".into(),
            local_date: "2026-07-29".into(),
            end_local_date: "2026-07-29".into(),
            start_local: "10:00".into(),
            end_local: "11:00".into(),
            time_zone: "Asia/Shanghai".into(),
            utc_offset_minutes: Some(480),
            status: "scheduled".into(),
        };
        database.create_session(&original).unwrap();
        let mut moved = original.clone();
        moved.start_local = "11:00".into();
        moved.end_local = "12:00".into();
        let mut missing = moved.clone();
        missing.id = "missing".into();
        assert!(
            database
                .apply_session_changes(&[], &[moved, missing], &[])
                .is_err()
        );
        let snapshot = database.snapshot().unwrap();
        assert_eq!(snapshot.execution_sessions[0].start_local, "10:00");
    }

    #[test]
    fn task_and_initial_calendar_session_are_created_atomically() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        database.create_task(&task("task-1", None)).unwrap();
        let existing = ExecutionSession {
            id: "session-shared".into(),
            task_id: "task-1".into(),
            local_date: "2026-07-29".into(),
            end_local_date: "2026-07-29".into(),
            start_local: "10:00".into(),
            end_local: "11:00".into(),
            time_zone: "Asia/Shanghai".into(),
            utc_offset_minutes: Some(480),
            status: "scheduled".into(),
        };
        database.create_session(&existing).unwrap();
        let new_task = task("task-2", None);
        let conflicting = ExecutionSession {
            task_id: new_task.id.clone(),
            ..existing
        };
        assert!(
            database
                .create_task_with_session(&new_task, &conflicting)
                .is_err()
        );
        let snapshot = database.snapshot().unwrap();
        assert!(!snapshot.tasks.iter().any(|item| item.id == "task-2"));
    }

    #[test]
    fn ending_an_execution_and_updating_progress_is_atomic() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        database
            .save_project_with_tasks(&project("project-1"), &[task("task-1", Some("project-1"))])
            .unwrap();
        database
            .create_execution_record(&ExecutionRecord {
                id: "record-1".into(),
                session_id: None,
                task_id: "task-1".into(),
                actual_start_utc: "2026-07-29T12:00:00Z".into(),
                actual_end_utc: None,
                note: String::new(),
            })
            .unwrap();

        database
            .finish_execution(
                "record-1",
                "2026-07-29T12:30:00Z",
                "推进顺利",
                &ProgressEvent {
                    id: "progress-1".into(),
                    task_id: "task-1".into(),
                    from_progress: 20,
                    to_progress: 45,
                    occurred_at_utc: "2026-07-29T12:30:00Z".into(),
                },
            )
            .unwrap();
        let snapshot = database.snapshot().unwrap();
        assert_eq!(
            snapshot.execution_records[0].actual_end_utc.as_deref(),
            Some("2026-07-29T12:30:00Z")
        );
        assert_eq!(snapshot.tasks[0].progress, 45);

        assert!(
            database
                .finish_execution(
                    "record-1",
                    "2026-07-29T12:40:00Z",
                    "重复结束",
                    &ProgressEvent {
                        id: "progress-2".into(),
                        task_id: "task-1".into(),
                        from_progress: 45,
                        to_progress: 60,
                        occurred_at_utc: "2026-07-29T12:40:00Z".into(),
                    },
                )
                .is_err()
        );
        let unchanged = database.snapshot().unwrap();
        assert_eq!(unchanged.tasks[0].progress, 45);
        assert_eq!(unchanged.progress_events.len(), 1);
    }

    #[test]
    fn phase_2_batch_scheduling_is_atomic_and_time_blocks_can_be_removed() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        database.create_task(&task("task-1", None)).unwrap();
        let session = ExecutionSession {
            id: "session-1".into(),
            task_id: "task-1".into(),
            local_date: "2026-08-03".into(),
            end_local_date: "2026-08-03".into(),
            start_local: "19:00".into(),
            end_local: "20:00".into(),
            time_zone: "Asia/Shanghai".into(),
            utc_offset_minutes: Some(480),
            status: "scheduled".into(),
        };
        assert!(
            database
                .create_sessions(&[session.clone(), session])
                .is_err()
        );
        assert!(database.snapshot().unwrap().execution_sessions.is_empty());

        let block = TimeBlock {
            id: "block-1".into(),
            title: "通勤".into(),
            local_date: "2026-08-03".into(),
            end_local_date: "2026-08-03".into(),
            start_local: "18:00".into(),
            end_local: "18:30".into(),
            time_zone: "Asia/Shanghai".into(),
            utc_offset_minutes: 480,
        };
        database.create_time_block(&block).unwrap();
        database.delete_time_block("block-1").unwrap();
        assert!(database.snapshot().unwrap().time_blocks.is_empty());
    }

    #[test]
    fn time_blocks_can_be_updated_and_invalid_updates_are_rejected() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        let block = TimeBlock {
            id: "block-1".into(),
            title: "通勤".into(),
            local_date: "2026-08-03".into(),
            end_local_date: "2026-08-03".into(),
            start_local: "18:00".into(),
            end_local: "18:30".into(),
            time_zone: "Asia/Shanghai".into(),
            utc_offset_minutes: 480,
        };
        database.create_time_block(&block).unwrap();

        let mut updated = block.clone();
        updated.title = "晚间通勤".into();
        updated.start_local = "18:15".into();
        updated.end_local = "19:00".into();
        database.update_time_block(&updated).unwrap();
        let snapshot = database.snapshot().unwrap();
        let stored = snapshot.time_blocks.iter().find(|item| item.id == "block-1").unwrap();
        assert_eq!(stored.title, "晚间通勤");
        assert_eq!(stored.start_local, "18:15");
        assert_eq!(stored.end_local, "19:00");

        // 跨日的更新时间块也能落库
        let mut overnight = updated.clone();
        overnight.start_local = "23:30".into();
        overnight.end_local = "00:30".into();
        overnight.end_local_date = "2026-08-04".into();
        database.update_time_block(&overnight).unwrap();
        let overnight_stored = database.snapshot().unwrap().time_blocks.iter().find(|item| item.id == "block-1").unwrap().clone();
        assert_eq!(overnight_stored.start_local, "23:30");
        assert_eq!(overnight_stored.end_local, "00:30");
        assert_eq!(overnight_stored.end_local_date, "2026-08-04");

        // 空标题必须拒绝
        let mut empty_title = updated.clone();
        empty_title.title = "  ".into();
        assert!(database.update_time_block(&empty_title).is_err());
        // 区间非法（同日内 start >= end）必须拒绝
        let mut invalid_range = updated.clone();
        invalid_range.start_local = "20:00".into();
        invalid_range.end_local = "19:30".into();
        invalid_range.end_local_date = "2026-08-03".into();
        assert!(database.update_time_block(&invalid_range).is_err());
        // 不存在的 id 必须拒绝
        let mut unknown = updated.clone();
        unknown.id = "ghost".into();
        assert!(database.update_time_block(&unknown).is_err());

        // 错误路径不能写入快照
        let snapshot = database.snapshot().unwrap();
        let stored = snapshot.time_blocks.iter().find(|item| item.id == "block-1").unwrap();
        assert_eq!(stored.title, "晚间通勤");
        assert_eq!(stored.start_local, "23:30");
        assert_eq!(stored.end_local, "00:30");
    }

    #[test]
    fn recurring_habit_and_occurrence_state_are_persisted_without_a_normal_pool_task() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        let mut backing = task("habit-task-1", None);
        backing.title = "拉伸".into();
        backing.kind = "habit".into();
        let habit = RecurringHabit {
            id: "habit-1".into(),
            task_id: backing.id.clone(),
            title: "拉伸".into(),
            pattern: "weekdays".into(),
            weekdays: vec![],
            start_date: "2026-08-01".into(),
            session_minutes: 20,
            preferred_start_local: None,
            status: "active".into(),
        };
        database.create_recurring_habit(&habit, &backing).unwrap();
        database
            .set_habit_occurrence(&HabitOccurrence {
                id: "occurrence-1".into(),
                habit_id: habit.id.clone(),
                local_date: "2026-08-03".into(),
                status: "skipped".into(),
                session_id: None,
            })
            .unwrap();

        let snapshot = database.snapshot().unwrap();
        assert_eq!(snapshot.recurring_habits, vec![habit]);
        assert_eq!(snapshot.habit_occurrences[0].status, "skipped");
        assert_eq!(snapshot.tasks[0].kind, "habit");
    }

    #[test]
    fn skipping_a_scheduled_habit_session_updates_its_occurrence_atomically() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        let mut backing = task("habit-task-1", None);
        backing.kind = "habit".into();
        backing.title = "Stretch".into();
        let habit = RecurringHabit {
            id: "habit-1".into(),
            task_id: backing.id.clone(),
            title: "Stretch".into(),
            pattern: "daily".into(),
            weekdays: vec![],
            start_date: "2026-08-01".into(),
            session_minutes: 20,
            preferred_start_local: None,
            status: "active".into(),
        };
        database.create_recurring_habit(&habit, &backing).unwrap();
        let mut session = ExecutionSession {
            id: "session-1".into(),
            task_id: backing.id.clone(),
            local_date: "2026-08-03".into(),
            end_local_date: "2026-08-03".into(),
            start_local: "19:00".into(),
            end_local: "19:20".into(),
            time_zone: "Asia/Shanghai".into(),
            utc_offset_minutes: Some(480),
            status: "scheduled".into(),
        };
        database
            .schedule_habit_occurrence(
                &HabitOccurrence {
                    id: "occurrence-1".into(),
                    habit_id: habit.id,
                    local_date: "2026-08-03".into(),
                    status: "scheduled".into(),
                    session_id: Some(session.id.clone()),
                },
                &session,
            )
            .unwrap();
        session.status = "cancelled".into();
        database.update_session(&session).unwrap();

        let snapshot = database.snapshot().unwrap();
        assert_eq!(snapshot.habit_occurrences[0].status, "skipped");
        assert_eq!(snapshot.execution_sessions[0].status, "cancelled");

        session.status = "scheduled".into();
        database.update_session(&session).unwrap();
        let restored = database.snapshot().unwrap();
        assert_eq!(restored.habit_occurrences[0].status, "scheduled");
        assert_eq!(restored.execution_sessions[0].status, "scheduled");
    }

    #[test]
    fn rescue_prompt_is_recorded_once_per_session() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        database.create_task(&task("task-1", None)).unwrap();
        database
            .create_session(&ExecutionSession {
                id: "session-1".into(),
                task_id: "task-1".into(),
                local_date: "2026-08-03".into(),
                end_local_date: "2026-08-03".into(),
                start_local: "19:00".into(),
                end_local: "20:00".into(),
                time_zone: "Asia/Shanghai".into(),
                utc_offset_minutes: Some(480),
                status: "scheduled".into(),
            })
            .unwrap();
        database
            .mark_rescue_prompted("session-1", "2026-08-03T11:06:00Z")
            .unwrap();
        database
            .mark_rescue_prompted("session-1", "2026-08-03T11:07:00Z")
            .unwrap();
        assert_eq!(
            database.snapshot().unwrap().rescue_prompted_session_ids,
            vec!["session-1"]
        );
    }

    #[test]
    fn schedule_draft_rejects_mismatched_occurrences_and_rolls_back_everything() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        database.create_task(&task("task-1", None)).unwrap();
        database.create_task(&task("task-2", None)).unwrap();
        let session = ExecutionSession {
            id: "session-1".into(),
            task_id: "task-1".into(),
            local_date: "2026-08-03".into(),
            end_local_date: "2026-08-03".into(),
            start_local: "19:00".into(),
            end_local: "20:00".into(),
            time_zone: "Asia/Shanghai".into(),
            utc_offset_minutes: Some(480),
            status: "scheduled".into(),
        };
        let session_two = ExecutionSession {
            id: "session-2".into(),
            task_id: "task-2".into(),
            local_date: "2026-08-04".into(),
            end_local_date: "2026-08-04".into(),
            start_local: "19:00".into(),
            end_local: "20:00".into(),
            time_zone: "Asia/Shanghai".into(),
            utc_offset_minutes: Some(480),
            status: "scheduled".into(),
        };
        let orphan = HabitOccurrence {
            id: "occurrence-orphan".into(),
            habit_id: "habit-unknown".into(),
            local_date: "2026-08-03".into(),
            status: "scheduled".into(),
            session_id: Some("session-1".into()),
        };

        let result = database.apply_schedule_draft(&[session, session_two], &[orphan]);
        assert!(result.is_err());
        let snapshot = database.snapshot().unwrap();
        assert!(
            snapshot.execution_sessions.is_empty(),
            "no session may survive a failed draft"
        );
        assert!(
            snapshot.habit_occurrences.is_empty(),
            "no occurrence may survive a failed draft"
        );
    }

    /// 把任务从 `from_progress` 推到 100，返回那次进度事件；完成记录只能引用它。
    fn complete_task(database: &Database, task_id: &str, from_progress: u8, event_id: &str) {
        database
            .apply_progress(&ProgressEvent {
                id: event_id.into(),
                task_id: task_id.into(),
                from_progress,
                to_progress: 100,
                occurred_at_utc: "2026-08-03T06:00:00Z".into(),
            })
            .unwrap();
    }

    fn completion_record(event_id: &str) -> CompletionRecord {
        CompletionRecord {
            id: "completion-1".into(),
            task_id: "task-1".into(),
            progress_event_id: event_id.into(),
            completed_at_utc: "2026-08-03T06:00:00Z".into(),
            progress_before: 75,
            fit: Some("fit".into()),
            note: "  先跑测试再整理笔记  ".into(),
            tags: vec!["专注".into(), "有收获".into(), "专注".into()],
            reverted_at_utc: None,
        }
    }

    fn completion_image(index: usize, bytes: Vec<u8>) -> CompletionImage {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        CompletionImage {
            id: format!("image-{index}"),
            sort_order: index as i64,
            mime: "image/webp".into(),
            width: 1600,
            height: 900,
            size_bytes: bytes.len() as i64,
            data_base64: STANDARD.encode(&bytes),
            thumb_base64: STANDARD.encode(format!("thumb-{index}")),
        }
    }

    #[test]
    fn v7_upgrade_adds_empty_completion_tables_without_losing_facts() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("daymark.db");
        let connection = Connection::open(&path).unwrap();
        for migration in [
            include_str!("../migrations/001_initial.sql"),
            include_str!("../migrations/002_time_blocks.sql"),
            include_str!("../migrations/003_cross_day_local_dates.sql"),
            include_str!("../migrations/004_phase1_actions.sql"),
            include_str!("../migrations/005_phase2_candidate.sql"),
            include_str!("../migrations/006_project_constraints.sql"),
            include_str!("../migrations/007_milestone_outcomes.sql"),
        ] {
            connection.execute_batch(migration).unwrap();
        }
        connection.execute(
            "INSERT INTO tasks (id, title, progress, status, created_at_utc, updated_at_utc) VALUES ('task-legacy', '旧任务', 100, 'completed', ?1, ?1)",
            ["2026-08-01T00:00:00Z"],
        ).unwrap();
        connection.execute(
            "INSERT INTO progress_events (id, task_id, from_progress, to_progress, occurred_at_utc) VALUES ('progress-legacy', 'task-legacy', 75, 100, '2026-08-01T00:00:00Z')",
            [],
        ).unwrap();
        drop(connection);

        let database = Database::open(&path).unwrap();
        assert_eq!(database.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        let snapshot = database.snapshot().unwrap();
        assert!(snapshot.completion_records.is_empty());
        // 旧事实一个不动：既不丢，也不给旧完成补一条凭空记录。
        assert_eq!(snapshot.tasks[0].title, "旧任务");
        assert_eq!(snapshot.progress_events.len(), 1);
    }

    #[test]
    fn a_completion_record_and_its_images_round_trip() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        let mut task = task("task-1", None);
        task.progress = 75;
        database.create_task(&task).unwrap();
        complete_task(&database, "task-1", 75, "progress-1");

        database
            .record_completion(&completion_record("progress-1"), &[
                completion_image(0, b"first".to_vec()),
                completion_image(1, b"second".to_vec()),
            ])
            .unwrap();

        let snapshot = database.snapshot().unwrap();
        assert_eq!(snapshot.completion_records.len(), 1);
        let record = &snapshot.completion_records[0];
        assert_eq!(record.record.fit.as_deref(), Some("fit"));
        // 小结去首尾空白后落库；标签按词表去重。
        assert_eq!(record.record.note, "先跑测试再整理笔记");
        assert_eq!(record.record.tags, vec!["专注".to_string(), "有收获".to_string()]);
        assert_eq!(record.record.progress_before, 75);
        assert_eq!(record.image_count, 2);
        assert!(record.record.reverted_at_utc.is_none());

        let images = database.completion_images("completion-1").unwrap();
        assert_eq!(images.len(), 2);
        assert_eq!(images[0].sort_order, 0);
        assert_eq!(images[1].mime, "image/webp");
        assert_eq!(images[1].size_bytes, 6);
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        assert_eq!(STANDARD.decode(&images[0].data_base64).unwrap(), b"first");
        assert_eq!(STANDARD.decode(&images[1].thumb_base64).unwrap(), b"thumb-1");
    }

    #[test]
    fn a_completion_record_rejects_invalid_feedback_and_unsupported_facts() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        let mut subject = task("task-1", None);
        subject.progress = 75;
        database.create_task(&subject).unwrap();
        complete_task(&database, "task-1", 75, "progress-1");
        // 到 45 的事件不是完成事实，不能挂完成记录。
        database.create_task(&task("task-2", None)).unwrap();
        database
            .apply_progress(&ProgressEvent {
                id: "progress-half".into(),
                task_id: "task-2".into(),
                from_progress: 20,
                to_progress: 45,
                occurred_at_utc: "2026-08-03T07:00:00Z".into(),
            })
            .unwrap();

        let mut bad_fit = completion_record("progress-1");
        bad_fit.fit = Some("amazing".into());
        assert!(database.record_completion(&bad_fit, &[]).unwrap_err().contains("适应程度"));

        let mut long_note = completion_record("progress-1");
        long_note.note = "字".repeat(281);
        assert!(database.record_completion(&long_note, &[]).unwrap_err().contains("280"));

        let mut bad_tag = completion_record("progress-1");
        bad_tag.tags = vec!["摸鱼".into()];
        assert!(database.record_completion(&bad_tag, &[]).unwrap_err().contains("词表"));

        let mut too_many_tags = completion_record("progress-1");
        too_many_tags.tags = (0..9).map(|index| format!("标签{index}")).collect();
        assert!(database.record_completion(&too_many_tags, &[]).unwrap_err().contains("词表"));

        assert!(database
            .record_completion(&completion_record("progress-1"), &(0..4).map(|index| completion_image(index, b"x".to_vec())).collect::<Vec<_>>())
            .unwrap_err()
            .contains("最多"));

        let oversized = completion_image(0, vec![7u8; 2 * 1024 * 1024 + 1]);
        assert!(database
            .record_completion(&completion_record("progress-1"), &[oversized])
            .unwrap_err()
            .contains("2 MB"));

        let mut wrong_mime = completion_record("progress-1");
        wrong_mime.fit = None;
        let mut gif = completion_image(0, b"x".to_vec());
        gif.mime = "image/gif".into();
        assert!(database.record_completion(&wrong_mime, &[gif]).unwrap_err().contains("WebP"));

        // 引用不存在的事件、未到 100 的事件、以及改时间都不允许落库。
        assert!(database.record_completion(&completion_record("progress-ghost"), &[]).unwrap_err().contains("进度事件"));
        let mut partial = completion_record("progress-half");
        partial.progress_event_id = "progress-half".into();
        partial.completed_at_utc = "2026-08-03T07:00:00Z".into();
        assert!(database.record_completion(&partial, &[]).unwrap_err().contains("100"));
        let mut shifted_time = completion_record("progress-1");
        shifted_time.completed_at_utc = "2026-08-03T09:00:00Z".into();
        assert!(database.record_completion(&shifted_time, &[]).unwrap_err().contains("一致"));

        assert!(database.snapshot().unwrap().completion_records.is_empty());
        assert_eq!(database.completion_images("completion-1").unwrap().len(), 0);

        // 重复提交同一个完成事件：明确错误，供前端转成编辑态。
        database.record_completion(&completion_record("progress-1"), &[completion_image(0, b"x".to_vec())]).unwrap();
        let mut second = completion_record("progress-1");
        second.id = "completion-2".into();
        assert!(database.record_completion(&second, &[]).unwrap_err().contains("已经记录过了"));
        assert_eq!(database.snapshot().unwrap().completion_records.len(), 1);
    }

    #[test]
    fn habit_backing_tasks_do_not_get_completion_records() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        let mut backing = task("habit-task-1", None);
        backing.kind = "habit".into();
        backing.title = "拉伸".into();
        backing.progress = 75;
        database
            .create_recurring_habit(&RecurringHabit {
                id: "habit-1".into(),
                task_id: backing.id.clone(),
                title: "拉伸".into(),
                pattern: "daily".into(),
                weekdays: vec![],
                start_date: "2026-08-01".into(),
                session_minutes: 20,
                preferred_start_local: None,
                status: "active".into(),
            }, &backing)
            .unwrap();
        complete_task(&database, "habit-task-1", 75, "progress-habit");
        let record = CompletionRecord {
            id: "completion-habit".into(),
            task_id: "habit-task-1".into(),
            progress_event_id: "progress-habit".into(),
            completed_at_utc: "2026-08-03T06:00:00Z".into(),
            progress_before: 75,
            fit: None,
            note: String::new(),
            tags: vec![],
            reverted_at_utc: None,
        };
        assert!(database.record_completion(&record, &[]).unwrap_err().contains("习惯"));
        assert!(database.snapshot().unwrap().completion_records.is_empty());
    }

    #[test]
    fn updating_a_completion_replaces_its_images_without_orphans() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        let mut task = task("task-1", None);
        task.progress = 75;
        database.create_task(&task).unwrap();
        complete_task(&database, "task-1", 75, "progress-1");
        database
            .record_completion(&completion_record("progress-1"), &[
                completion_image(0, b"first".to_vec()),
                completion_image(1, b"second".to_vec()),
            ])
            .unwrap();

        let mut edited = completion_record("progress-1");
        edited.fit = Some("hard".into());
        edited.note = "被打断了两次".into();
        edited.tags = vec!["被打断".into()];
        database.update_completion(&edited, &[completion_image(0, b"only".to_vec())]).unwrap();

        let snapshot = database.snapshot().unwrap();
        assert_eq!(snapshot.completion_records[0].image_count, 1);
        assert_eq!(snapshot.completion_records[0].record.fit.as_deref(), Some("hard"));
        assert_eq!(snapshot.completion_records[0].record.note, "被打断了两次");
        let images = database.completion_images("completion-1").unwrap();
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].id, "image-0");

        // 记录引用的进度事实不可改写。
        let mut rewritten = edited.clone();
        rewritten.progress_event_id = "progress-half".into();
        assert!(database.update_completion(&rewritten, &[]).unwrap_err().contains("不能改写"));
        // 不存在的记录不能更新。
        let mut ghost = edited.clone();
        ghost.id = "completion-ghost".into();
        assert!(database.update_completion(&ghost, &[]).unwrap_err().contains("找不到"));
    }

    #[test]
    fn reverting_a_completion_rolls_back_progress_and_keeps_the_record() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        let mut task = task("task-1", None);
        task.progress = 75;
        database.create_task(&task).unwrap();
        complete_task(&database, "task-1", 75, "progress-1");
        database
            .record_completion(&completion_record("progress-1"), &[completion_image(0, b"first".to_vec())])
            .unwrap();

        database
            .revert_completion("completion-1", &ProgressEvent {
                id: "progress-revert".into(),
                task_id: "task-1".into(),
                from_progress: 100,
                to_progress: 75,
                occurred_at_utc: "2026-08-03T08:00:00Z".into(),
            })
            .unwrap();

        let snapshot = database.snapshot().unwrap();
        let reverted_task = &snapshot.tasks[0];
        assert_eq!(reverted_task.progress, 75);
        assert_eq!(reverted_task.status, "active");
        assert_eq!(snapshot.progress_events.len(), 2);
        // 撤回不动用户内容：文字、标签与图片都留在历史里。
        assert_eq!(snapshot.completion_records.len(), 1);
        let record = &snapshot.completion_records[0];
        assert!(record.record.reverted_at_utc.is_some());
        assert_eq!(record.image_count, 1);
        assert_eq!(database.completion_images("completion-1").unwrap().len(), 1);

        // 已撤回的记录不能再次撤回，也不能再编辑。
        assert!(database
            .revert_completion("completion-1", &ProgressEvent {
                id: "progress-revert-again".into(),
                task_id: "task-1".into(),
                from_progress: 100,
                to_progress: 75,
                occurred_at_utc: "2026-08-03T09:00:00Z".into(),
            })
            .unwrap_err()
            .contains("已经撤回"));
        assert!(database.update_completion(&completion_record("progress-1"), &[]).unwrap_err().contains("不能修改"));
    }

    #[test]
    fn a_revert_must_match_the_record_and_the_current_progress() {
        let dir = tempdir().unwrap();
        let database = Database::open(dir.path().join("daymark.db")).unwrap();
        let mut task = task("task-1", None);
        task.progress = 75;
        database.create_task(&task).unwrap();
        complete_task(&database, "task-1", 75, "progress-1");
        database.record_completion(&completion_record("progress-1"), &[]).unwrap();

        // 回退目标必须是记录里的完成前进度。
        assert!(database
            .revert_completion("completion-1", &ProgressEvent {
                id: "progress-wrong".into(),
                task_id: "task-1".into(),
                from_progress: 100,
                to_progress: 50,
                occurred_at_utc: "2026-08-03T08:00:00Z".into(),
            })
            .unwrap_err()
            .contains("回到 75%"));
        // 别的任务不能借用这条记录撤回。
        assert!(database
            .revert_completion("completion-1", &ProgressEvent {
                id: "progress-other-task".into(),
                task_id: "task-2".into(),
                from_progress: 100,
                to_progress: 75,
                occurred_at_utc: "2026-08-03T08:00:00Z".into(),
            })
            .unwrap_err()
            .contains("属于这条记录"));

        // 任务已被别的入口下调，撤回要求刷新。
        database
            .apply_progress(&ProgressEvent {
                id: "progress-down".into(),
                task_id: "task-1".into(),
                from_progress: 100,
                to_progress: 90,
                occurred_at_utc: "2026-08-03T08:30:00Z".into(),
            })
            .unwrap();
        assert!(database
            .revert_completion("completion-1", &ProgressEvent {
                id: "progress-revert".into(),
                task_id: "task-1".into(),
                from_progress: 100,
                to_progress: 75,
                occurred_at_utc: "2026-08-03T09:00:00Z".into(),
            })
            .unwrap_err()
            .contains("已经变化"));
        // 失败路径不写任何事件，也不标记记录。
        let snapshot = database.snapshot().unwrap();
        assert_eq!(snapshot.progress_events.len(), 2);
        assert!(snapshot.completion_records[0].record.reverted_at_utc.is_none());
    }
}
