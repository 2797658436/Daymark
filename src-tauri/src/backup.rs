use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::{DateTime, Local, NaiveDate};
use rusqlite::{Connection, OpenFlags, backup::Backup};
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use crate::database::Database;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub path: PathBuf,
    pub kind: BackupKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    pub pre_restore_backup: BackupInfo,
    pub restored_preferences: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreview {
    pub source: PathBuf,
    pub modified_at: String,
    pub size_bytes: u64,
    pub projects: usize,
    pub tasks: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupKind {
    Daily,
    PreRestore,
    Manual,
}

pub struct BackupService {
    database_path: PathBuf,
    backup_directory: PathBuf,
    settings_path: Option<PathBuf>,
    retention: usize,
}

impl BackupService {
    pub fn new(database_path: impl Into<PathBuf>, backup_directory: impl Into<PathBuf>) -> Self {
        Self {
            database_path: database_path.into(),
            backup_directory: backup_directory.into(),
            settings_path: None,
            retention: 7,
        }
    }

    pub fn with_settings_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.settings_path = Some(path.into());
        self
    }

    pub fn create_daily(&self, date: NaiveDate) -> Result<BackupInfo, String> {
        fs::create_dir_all(&self.backup_directory).map_err(file_error)?;
        let destination = self
            .backup_directory
            .join(format!("daymark-{}.db", date.format("%Y-%m-%d")));
        if !destination.exists() {
            self.replace_backup_file(&destination)?;
        } else {
            validate_database(&destination)?;
        }
        self.prune_daily()?;
        Ok(BackupInfo {
            path: destination,
            kind: BackupKind::Daily,
        })
    }

    pub fn refresh_daily(&self, date: NaiveDate) -> Result<BackupInfo, String> {
        fs::create_dir_all(&self.backup_directory).map_err(file_error)?;
        let destination = self
            .backup_directory
            .join(format!("daymark-{}.db", date.format("%Y-%m-%d")));
        self.replace_backup_file(&destination)?;
        self.prune_daily()?;
        Ok(BackupInfo {
            path: destination,
            kind: BackupKind::Daily,
        })
    }

    pub fn create_manual(&self, destination: impl AsRef<Path>) -> Result<BackupInfo, String> {
        let destination = destination.as_ref();
        if destination == self.database_path {
            return Err("手动备份目标不能是正在使用的数据库".into());
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(file_error)?;
        }
        self.replace_backup_file(destination)?;
        Ok(BackupInfo {
            path: destination.to_path_buf(),
            kind: BackupKind::Manual,
        })
    }

    pub fn restore(
        &self,
        source: impl AsRef<Path>,
        now: DateTime<Local>,
    ) -> Result<RestoreOutcome, String> {
        self.restore_coordinated(source, now, |_| Ok(()))
    }

    pub fn restore_coordinated<F>(
        &self,
        source: impl AsRef<Path>,
        now: DateTime<Local>,
        apply_preferences: F,
    ) -> Result<RestoreOutcome, String>
    where
        F: FnOnce(Option<&Value>) -> Result<(), String>,
    {
        let outcome = self.restore_core(source, now)?;
        if let Err(settings_error) = apply_preferences(outcome.restored_preferences.as_ref()) {
            return match self.rollback_from_pre_restore(&outcome.pre_restore_backup.path) {
                Ok(()) => Err(format!(
                    "偏好恢复失败，核心数据已自动还原：{settings_error}"
                )),
                Err(rollback_error) => Err(format!(
                    "偏好恢复失败且核心数据无法自动还原：{settings_error}；{rollback_error}"
                )),
            };
        }
        Ok(outcome)
    }

    fn restore_core(
        &self,
        source: impl AsRef<Path>,
        now: DateTime<Local>,
    ) -> Result<RestoreOutcome, String> {
        let source = source.as_ref();
        validate_database(source)?;
        let restored_preferences = read_embedded_preferences(source)?;
        fs::create_dir_all(&self.backup_directory).map_err(file_error)?;

        let pre_restore_path = self.backup_directory.join(format!(
            "pre-restore-{}-{}.db",
            now.format("%Y-%m-%dT%H-%M-%S"),
            Uuid::new_v4().simple(),
        ));
        self.create_backup_file(&pre_restore_path)?;

        let staged_path = self
            .backup_directory
            .join(format!(".restore-{}.db", Uuid::new_v4().simple()));
        let restore_result = (|| {
            copy_database(source, &staged_path)?;
            Database::open(&staged_path)?.snapshot()?;
            validate_database(&staged_path)?;
            remove_embedded_preferences(&staged_path)?;
            copy_database(&staged_path, &self.database_path)?;
            validate_database(&self.database_path)
        })();
        let _ = fs::remove_file(&staged_path);

        if let Err(error) = restore_result {
            let rollback_result = self.rollback_from_pre_restore(&pre_restore_path);
            return match rollback_result {
                Ok(()) => Err(format!("恢复失败，原数据已还原：{error}")),
                Err(rollback_error) => Err(format!(
                    "恢复失败且无法自动还原，请使用恢复前备份：{error}；{rollback_error}"
                )),
            };
        }

        Ok(RestoreOutcome {
            pre_restore_backup: BackupInfo {
                path: pre_restore_path,
                kind: BackupKind::PreRestore,
            },
            restored_preferences,
        })
    }

    pub fn inspect(&self, source: impl AsRef<Path>) -> Result<BackupPreview, String> {
        let source = source.as_ref();
        validate_database(source)?;
        let metadata = fs::metadata(source).map_err(file_error)?;
        let modified = metadata.modified().map_err(file_error)?;
        let connection = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(database_error)?;
        let projects: i64 = connection
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
            .map_err(database_error)?;
        let tasks: i64 = connection
            .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
            .map_err(database_error)?;
        Ok(BackupPreview {
            source: source.to_path_buf(),
            modified_at: chrono::DateTime::<Local>::from(modified).to_rfc3339(),
            size_bytes: metadata.len(),
            projects: projects as usize,
            tasks: tasks as usize,
        })
    }

    pub fn list(&self) -> Result<Vec<BackupInfo>, String> {
        if !self.backup_directory.exists() {
            return Ok(Vec::new());
        }
        let mut items = fs::read_dir(&self.backup_directory)
            .map_err(file_error)?
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_type()
                    .map(|kind| kind.is_file())
                    .unwrap_or(false)
            })
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !name.ends_with(".db") || name.starts_with('.') {
                    return None;
                }
                let kind = if name.starts_with("daymark-") {
                    BackupKind::Daily
                } else if name.starts_with("pre-restore-") {
                    BackupKind::PreRestore
                } else {
                    BackupKind::Manual
                };
                Some(BackupInfo {
                    path: entry.path(),
                    kind,
                })
            })
            .collect::<Vec<_>>();
        items.sort_by(|left, right| right.path.file_name().cmp(&left.path.file_name()));
        Ok(items)
    }

    fn prune_daily(&self) -> Result<(), String> {
        let mut daily = self
            .list()?
            .into_iter()
            .filter(|item| item.kind == BackupKind::Daily)
            .collect::<Vec<_>>();
        daily.sort_by(|left, right| left.path.file_name().cmp(&right.path.file_name()));
        let remove_count = daily.len().saturating_sub(self.retention);
        for old_backup in daily.into_iter().take(remove_count) {
            fs::remove_file(old_backup.path).map_err(file_error)?;
        }
        Ok(())
    }

    fn create_backup_file(&self, destination: &Path) -> Result<(), String> {
        copy_database(&self.database_path, destination)?;
        embed_preferences(destination, self.settings_path.as_deref())?;
        validate_database(destination)
    }

    fn replace_backup_file(&self, destination: &Path) -> Result<(), String> {
        let parent = destination
            .parent()
            .ok_or_else(|| "备份目标缺少父目录".to_string())?;
        let staged = parent.join(format!(".backup-{}.db", Uuid::new_v4().simple()));
        if let Err(error) = self.create_backup_file(&staged) {
            let _ = fs::remove_file(&staged);
            return Err(error);
        }

        if !destination.exists() {
            let result = fs::rename(&staged, destination).map_err(file_error);
            if result.is_err() {
                let _ = fs::remove_file(&staged);
            }
            return result;
        }
        let result = atomic_replace(&staged, destination);
        if result.is_err() {
            let _ = fs::remove_file(&staged);
        }
        result
    }

    fn rollback_from_pre_restore(&self, source: &Path) -> Result<(), String> {
        let staged = self
            .backup_directory
            .join(format!(".rollback-{}.db", Uuid::new_v4().simple()));
        let result = (|| {
            copy_database(source, &staged)?;
            remove_embedded_preferences(&staged)?;
            Database::open(&staged)?.snapshot()?;
            copy_database(&staged, &self.database_path)?;
            validate_database(&self.database_path)
        })();
        let _ = fs::remove_file(staged);
        result
    }
}

#[cfg(windows)]
fn atomic_replace(staged: &Path, destination: &Path) -> Result<(), String> {
    use std::{iter, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::Storage::FileSystem::{REPLACEFILE_WRITE_THROUGH, ReplaceFileW};

    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let staged_wide = staged
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let replaced = unsafe {
        ReplaceFileW(
            destination_wide.as_ptr(),
            staged_wide.as_ptr(),
            ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            ptr::null(),
            ptr::null(),
        )
    };
    if replaced == 0 {
        Err(file_error(std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace(staged: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(staged, destination).map_err(file_error)
}

fn copy_database(source: &Path, destination: &Path) -> Result<(), String> {
    if source == destination {
        return Err("源数据库与目标数据库不能相同".into());
    }
    let source_connection = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(database_error)?;
    let mut destination_connection = Connection::open(destination).map_err(database_error)?;
    let backup =
        Backup::new(&source_connection, &mut destination_connection).map_err(database_error)?;
    backup
        .run_to_completion(32, Duration::from_millis(5), None)
        .map_err(database_error)?;
    drop(backup);
    drop(destination_connection);
    validate_database(destination)
}

fn embed_preferences(database_path: &Path, settings_path: Option<&Path>) -> Result<(), String> {
    let Some(settings_path) = settings_path.filter(|path| path.exists()) else {
        return Ok(());
    };
    let raw = fs::read_to_string(settings_path).map_err(file_error)?;
    let settings: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("无法读取应用设置以创建备份：{error}"))?;
    let Some(preferences) = settings.get("preferences") else {
        return Ok(());
    };
    let connection = Connection::open(database_path).map_err(database_error)?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS backup_preferences (\
               singleton INTEGER PRIMARY KEY CHECK (singleton = 1),\
               preferences_json TEXT NOT NULL\
             );",
        )
        .map_err(database_error)?;
    connection
        .execute(
            "INSERT OR REPLACE INTO backup_preferences (singleton, preferences_json) VALUES (1, ?1)",
            [preferences.to_string()],
        )
        .map_err(database_error)?;
    Ok(())
}

fn read_embedded_preferences(database_path: &Path) -> Result<Option<Value>, String> {
    let connection = Connection::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(database_error)?;
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'backup_preferences')",
            [],
            |row| row.get(0),
        )
        .map_err(database_error)?;
    if !exists {
        return Ok(None);
    }
    let raw: String = connection
        .query_row(
            "SELECT preferences_json FROM backup_preferences WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(database_error)?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|error| format!("备份中的应用设置无效：{error}"))
}

fn remove_embedded_preferences(database_path: &Path) -> Result<(), String> {
    Connection::open(database_path)
        .map_err(database_error)?
        .execute("DROP TABLE IF EXISTS backup_preferences", [])
        .map(|_| ())
        .map_err(database_error)
}

fn validate_database(path: &Path) -> Result<(), String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(database_error)?;
    let integrity: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(database_error)?;
    if integrity != "ok" {
        return Err(format!("备份完整性检查失败：{integrity}"));
    }
    let version: i64 = connection
        .query_row(
            "SELECT version FROM schema_version WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("备份缺少有效的 schema_version：{error}"))?;
    if !(1..=crate::database::CURRENT_SCHEMA_VERSION).contains(&version) {
        return Err(format!("备份 schema_version {version} 不受支持"));
    }
    let mut required_tables = vec![
        "projects",
        "tasks",
        "execution_sessions",
        "execution_records",
        "progress_events",
    ];
    if version >= 6 {
        required_tables.push("project_milestones");
    }
    if version >= 7 {
        required_tables.push("milestone_outcomes");
    }
    for table in required_tables {
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                [table],
                |row| row.get(0),
            )
            .map_err(database_error)?;
        if !exists {
            return Err(format!("备份缺少必需的数据表：{table}"));
        }
    }
    Ok(())
}

fn database_error(error: rusqlite::Error) -> String {
    format!("SQLite 备份操作失败：{error}")
}

fn file_error(error: std::io::Error) -> String {
    format!("备份文件操作失败：{error}")
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;
    use tempfile::tempdir;

    use super::*;
    use crate::models::{Project, Task};

    fn save_named_task(database: &Database, suffix: &str) {
        database
            .save_project_with_tasks(
                &Project {
                    id: format!("project-{suffix}"),
                    title: format!("项目 {suffix}"),
                    deadline_local: None,
                },
                &[Task {
                    id: format!("task-{suffix}"),
                    project_id: Some(format!("project-{suffix}")),
                    title: format!("任务 {suffix}"),
                    progress: 0,
                    status: "active".into(),
                    deadline_local: None,
                    estimated_minutes: None,
                    session_minutes: None,
                    priority: "normal".into(),
                    sort_order: 0,
                    source_url: None,
                    source_key: None,
                    media_minutes: None,
                    kind: "task".into(),
                }],
            )
            .unwrap();
    }

    #[test]
    fn daily_backups_are_deduplicated_and_keep_the_latest_seven() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("daymark.db");
        Database::open(&db_path).unwrap();
        let service = BackupService::new(&db_path, dir.path().join("backups"));

        for day in 1..=8 {
            service
                .create_daily(NaiveDate::from_ymd_opt(2026, 7, day).unwrap())
                .unwrap();
        }
        service
            .create_daily(NaiveDate::from_ymd_opt(2026, 7, 8).unwrap())
            .unwrap();

        let daily: Vec<_> = service
            .list()
            .unwrap()
            .into_iter()
            .filter(|item| item.kind == BackupKind::Daily)
            .collect();
        assert_eq!(daily.len(), 7);
        assert!(
            daily
                .iter()
                .all(|item| !item.path.to_string_lossy().contains("2026-07-01"))
        );
    }

    #[test]
    fn refreshing_a_daily_backup_captures_changes_made_later_that_day() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("daymark.db");
        let database = Database::open(&db_path).unwrap();
        save_named_task(&database, "morning");
        let service = BackupService::new(&db_path, dir.path().join("backups"));
        let date = NaiveDate::from_ymd_opt(2026, 7, 29).unwrap();
        service.create_daily(date).unwrap();

        save_named_task(&database, "afternoon");
        let refreshed = service.refresh_daily(date).unwrap();

        let snapshot = Database::open(refreshed.path).unwrap().snapshot().unwrap();
        assert_eq!(snapshot.tasks.len(), 2);
    }

    #[test]
    fn a_migratable_backup_carries_tauri_store_preferences() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("daymark.db");
        Database::open(&db_path).unwrap();
        let settings_path = dir.path().join("settings.json");
        std::fs::write(
            &settings_path,
            r#"{"preferences":{"appearance":"dark","motion":"reduce","scale":150,"lastPage":"data"}}"#,
        )
        .unwrap();
        let service = BackupService::new(&db_path, dir.path().join("backups"))
            .with_settings_path(&settings_path);
        let backup = service
            .create_daily(NaiveDate::from_ymd_opt(2026, 7, 29).unwrap())
            .unwrap();

        let outcome = service
            .restore(
                backup.path,
                Local.with_ymd_and_hms(2026, 7, 29, 21, 0, 0).unwrap(),
            )
            .unwrap();
        assert_eq!(outcome.restored_preferences.unwrap()["appearance"], "dark");
    }

    #[test]
    fn preference_failure_rolls_back_the_database_restore() {
        let dir = tempdir().unwrap();
        let live_path = dir.path().join("live.db");
        let live = Database::open(&live_path).unwrap();
        save_named_task(&live, "live");

        let source_path = dir.path().join("source.db");
        let source = Database::open(&source_path).unwrap();
        save_named_task(&source, "source");
        let source_backup = BackupService::new(&source_path, dir.path().join("source-backups"))
            .create_daily(NaiveDate::from_ymd_opt(2026, 7, 29).unwrap())
            .unwrap();

        let service = BackupService::new(&live_path, dir.path().join("live-backups"));
        assert!(
            service
                .restore_coordinated(
                    source_backup.path,
                    Local.with_ymd_and_hms(2026, 7, 29, 22, 0, 0).unwrap(),
                    |_| Err("settings disk full".into()),
                )
                .is_err()
        );
        assert_eq!(
            Database::open(&live_path)
                .unwrap()
                .snapshot()
                .unwrap()
                .tasks[0]
                .title,
            "任务 live"
        );
    }

    #[test]
    fn a_backup_restores_into_a_clean_install() {
        let dir = tempdir().unwrap();
        let source_path = dir.path().join("source.db");
        let source = Database::open(&source_path).unwrap();
        save_named_task(&source, "source");
        let source_service = BackupService::new(&source_path, dir.path().join("source-backups"));
        let backup = source_service
            .create_daily(NaiveDate::from_ymd_opt(2026, 7, 29).unwrap())
            .unwrap();

        let clean_path = dir.path().join("clean.db");
        Database::open(&clean_path).unwrap();
        let clean_service = BackupService::new(&clean_path, dir.path().join("clean-backups"));
        clean_service
            .restore(
                &backup.path,
                Local.with_ymd_and_hms(2026, 7, 29, 18, 30, 0).unwrap(),
            )
            .unwrap();

        let restored = Database::open(&clean_path).unwrap().snapshot().unwrap();
        assert_eq!(restored.tasks.len(), 1);
        assert_eq!(restored.tasks[0].title, "任务 source");
    }

    #[test]
    fn restore_creates_a_pre_restore_backup_and_rejects_invalid_input() {
        let dir = tempdir().unwrap();
        let live_path = dir.path().join("live.db");
        let live = Database::open(&live_path).unwrap();
        save_named_task(&live, "live");

        let source_path = dir.path().join("source.db");
        let source = Database::open(&source_path).unwrap();
        save_named_task(&source, "source");
        let source_backup = BackupService::new(&source_path, dir.path().join("source-backups"))
            .create_daily(NaiveDate::from_ymd_opt(2026, 7, 29).unwrap())
            .unwrap();

        let service = BackupService::new(&live_path, dir.path().join("live-backups"));
        let pre_restore = service
            .restore(
                &source_backup.path,
                Local.with_ymd_and_hms(2026, 7, 29, 19, 0, 0).unwrap(),
            )
            .unwrap();
        assert_eq!(pre_restore.pre_restore_backup.kind, BackupKind::PreRestore);

        let pre_restore_database = Database::open(&pre_restore.pre_restore_backup.path).unwrap();
        assert_eq!(
            pre_restore_database.snapshot().unwrap().tasks[0].title,
            "任务 live"
        );
        assert_eq!(
            Database::open(&live_path)
                .unwrap()
                .snapshot()
                .unwrap()
                .tasks[0]
                .title,
            "任务 source"
        );

        let invalid = dir.path().join("not-a-database.db");
        std::fs::write(&invalid, b"not sqlite").unwrap();
        assert!(
            service
                .restore(
                    &invalid,
                    Local.with_ymd_and_hms(2026, 7, 29, 20, 0, 0).unwrap()
                )
                .is_err()
        );
        assert_eq!(
            Database::open(&live_path)
                .unwrap()
                .snapshot()
                .unwrap()
                .tasks[0]
                .title,
            "任务 source"
        );
    }

    #[test]
    fn restore_rejects_a_sqlite_file_that_is_missing_required_domain_tables() {
        let dir = tempdir().unwrap();
        let live_path = dir.path().join("live.db");
        let live = Database::open(&live_path).unwrap();
        save_named_task(&live, "live");

        let incomplete_path = dir.path().join("incomplete.db");
        let incomplete = Connection::open(&incomplete_path).unwrap();
        incomplete
            .execute_batch(
                "CREATE TABLE schema_version (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL);\
                 INSERT INTO schema_version VALUES (1, 3);",
            )
            .unwrap();
        drop(incomplete);

        let service = BackupService::new(&live_path, dir.path().join("backups"));
        assert!(
            service
                .restore(
                    &incomplete_path,
                    Local.with_ymd_and_hms(2026, 7, 29, 20, 0, 0).unwrap(),
                )
                .is_err()
        );
        assert_eq!(
            Database::open(&live_path)
                .unwrap()
                .snapshot()
                .unwrap()
                .tasks[0]
                .title,
            "任务 live"
        );
    }

    #[test]
    fn restore_rejects_a_v6_backup_that_is_missing_project_milestones() {
        let dir = tempdir().unwrap();
        let live_path = dir.path().join("live.db");
        let live = Database::open(&live_path).unwrap();
        save_named_task(&live, "live");

        let fake_v6_path = dir.path().join("fake-v6.db");
        let fake = Connection::open(&fake_v6_path).unwrap();
        fake.execute_batch(
            "CREATE TABLE schema_version (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL);\
             INSERT INTO schema_version VALUES (1, 6);\
             CREATE TABLE projects (id TEXT PRIMARY KEY);\
             CREATE TABLE tasks (id TEXT PRIMARY KEY);\
             CREATE TABLE execution_sessions (id TEXT PRIMARY KEY);\
             CREATE TABLE execution_records (id TEXT PRIMARY KEY);\
             CREATE TABLE progress_events (id TEXT PRIMARY KEY);",
        )
        .unwrap();
        drop(fake);

        let service = BackupService::new(&live_path, dir.path().join("backups"));
        assert!(
            service
                .restore(
                    &fake_v6_path,
                    Local.with_ymd_and_hms(2026, 9, 1, 17, 0, 0).unwrap(),
                )
                .is_err()
        );
        assert_eq!(
            Database::open(&live_path)
                .unwrap()
                .snapshot()
                .unwrap()
                .tasks[0]
                .title,
            "任务 live"
        );
    }

    #[test]
    fn restore_rejects_a_v7_backup_that_is_missing_milestone_outcomes() {
        let dir = tempdir().unwrap();
        let live_path = dir.path().join("live.db");
        let live = Database::open(&live_path).unwrap();
        save_named_task(&live, "live");

        let fake_v7_path = dir.path().join("fake-v7.db");
        let fake = Connection::open(&fake_v7_path).unwrap();
        fake.execute_batch(
            "CREATE TABLE schema_version (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL);\
             INSERT INTO schema_version VALUES (1, 7);\
             CREATE TABLE projects (id TEXT PRIMARY KEY);\
             CREATE TABLE tasks (id TEXT PRIMARY KEY);\
             CREATE TABLE execution_sessions (id TEXT PRIMARY KEY);\
             CREATE TABLE execution_records (id TEXT PRIMARY KEY);\
             CREATE TABLE progress_events (id TEXT PRIMARY KEY);\
             CREATE TABLE project_milestones (id TEXT PRIMARY KEY);",
        )
        .unwrap();
        drop(fake);

        let service = BackupService::new(&live_path, dir.path().join("backups"));
        assert!(
            service
                .restore(
                    &fake_v7_path,
                    Local.with_ymd_and_hms(2026, 9, 1, 17, 0, 0).unwrap(),
                )
                .is_err()
        );
        assert_eq!(
            Database::open(&live_path)
                .unwrap()
                .snapshot()
                .unwrap()
                .tasks[0]
                .title,
            "任务 live"
        );
    }
}
