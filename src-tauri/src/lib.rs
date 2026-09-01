pub mod backup;
pub mod database;
pub mod models;

use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use backup::{BackupInfo, BackupPreview, BackupService, RestoreOutcome};
use chrono::Local;
use database::{Database, WorkspaceSnapshot};
use models::{
    ExecutionRecord, ExecutionSession, HabitOccurrence, ProgressEvent, Project, ProjectMilestone,
    RecurringHabit, Task, TimeBlock,
};
use serde::{Deserialize, Serialize};
use tauri::{
    Emitter, Manager,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_store::StoreExt;

#[derive(Clone)]
struct AppState {
    database_path: PathBuf,
    backup_directory: PathBuf,
    settings_path: PathBuf,
    backup_error: Arc<Mutex<Option<String>>>,
    data_operation_lock: Arc<Mutex<()>>,
    pending_reminder_session: Arc<Mutex<Option<(String, Instant)>>>,
}

impl AppState {
    fn database(&self) -> Result<Database, String> {
        Database::open(&self.database_path)
    }

    fn backups(&self) -> BackupService {
        BackupService::new(&self.database_path, &self.backup_directory)
            .with_settings_path(&self.settings_path)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DataCounts {
    projects: usize,
    tasks: usize,
    execution_sessions: usize,
    execution_records: usize,
    progress_events: usize,
    time_blocks: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DataOverview {
    schema_version: i64,
    database_path: String,
    backup_directory: String,
    backup_error: Option<String>,
    counts: DataCounts,
    backups: Vec<BackupInfo>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct BilibiliPart {
    page: u32,
    title: String,
    duration_seconds: u32,
    source_key: String,
    source_url: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct BilibiliVideo {
    bvid: String,
    title: String,
    owner_name: String,
    parts: Vec<BilibiliPart>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenSessionPayload {
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionSessionChanges {
    create: Vec<ExecutionSession>,
    update: Vec<ExecutionSession>,
    delete_ids: Vec<String>,
}

#[derive(Deserialize)]
struct BilibiliEnvelope {
    code: i64,
    message: String,
    data: Option<BilibiliView>,
}
#[derive(Deserialize)]
struct BilibiliView {
    bvid: String,
    title: String,
    owner: BilibiliOwner,
    pages: Vec<BilibiliPage>,
}
#[derive(Deserialize)]
struct BilibiliOwner {
    name: String,
}
#[derive(Deserialize)]
struct BilibiliPage {
    cid: u64,
    page: u32,
    part: String,
    duration: u32,
}

#[tauri::command]
async fn get_data_overview(state: tauri::State<'_, AppState>) -> Result<DataOverview, String> {
    run_data_operation(state.inner().clone(), |state| {
        let database = state.database()?;
        let snapshot = database.snapshot()?;
        Ok(DataOverview {
            schema_version: database.schema_version()?,
            database_path: state.database_path.display().to_string(),
            backup_directory: state.backup_directory.display().to_string(),
            backup_error: state
                .backup_error
                .lock()
                .map_err(|_| "无法读取自动备份状态")?
                .clone(),
            counts: DataCounts {
                projects: snapshot.projects.len(),
                tasks: snapshot.tasks.len(),
                execution_sessions: snapshot.execution_sessions.len(),
                execution_records: snapshot.execution_records.len(),
                progress_events: snapshot.progress_events.len(),
                time_blocks: snapshot.time_blocks.len(),
            },
            backups: state.backups().list()?,
        })
    })
    .await
}

#[tauri::command]
async fn get_workspace(state: tauri::State<'_, AppState>) -> Result<WorkspaceSnapshot, String> {
    run_data_operation(state.inner().clone(), |state| state.database()?.snapshot()).await
}

#[tauri::command]
async fn create_task(
    task: Task,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| {
        database.create_task(&task)
    })
    .await
}

#[tauri::command]
async fn create_task_with_session(
    task: Task,
    session: ExecutionSession,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| {
        database.create_task_with_session(&task, &session)
    })
    .await
}

#[tauri::command]
async fn update_task(
    task: Task,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| {
        database.update_task(&task)
    })
    .await
}

#[tauri::command]
async fn create_project_with_tasks(
    project: Project,
    tasks: Vec<Task>,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| {
        database.save_project_with_tasks(&project, &tasks)
    })
    .await
}

#[tauri::command]
async fn update_project(
    project: Project,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| database.update_project(&project)).await
}

#[tauri::command]
async fn create_project_milestone(
    milestone: ProjectMilestone,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| database.create_project_milestone(&milestone)).await
}

#[tauri::command]
async fn update_project_milestone(
    milestone: ProjectMilestone,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| database.update_project_milestone(&milestone)).await
}

#[tauri::command]
async fn delete_project_milestone(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| database.delete_project_milestone(&id)).await
}

#[tauri::command]
async fn create_execution_session(
    session: ExecutionSession,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| {
        database.create_session(&session)
    })
    .await
}

#[tauri::command]
async fn create_execution_sessions(
    sessions: Vec<ExecutionSession>,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| {
        database.create_sessions(&sessions)
    })
    .await
}

#[tauri::command]
async fn apply_schedule_draft(
    sessions: Vec<ExecutionSession>,
    occurrences: Vec<HabitOccurrence>,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| {
        database.apply_schedule_draft(&sessions, &occurrences)
    })
    .await
}

#[tauri::command]
async fn update_execution_session(
    session: ExecutionSession,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| {
        database.update_session(&session)
    })
    .await
}

#[tauri::command]
async fn apply_execution_session_changes(
    changes: ExecutionSessionChanges,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| {
        database.apply_session_changes(&changes.create, &changes.update, &changes.delete_ids)
    })
    .await
}

#[tauri::command]
async fn delete_execution_session(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| {
        database.delete_session(&id)
    })
    .await
}

#[tauri::command]
async fn delete_execution_sessions(
    ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| {
        database.delete_sessions(&ids)
    })
    .await
}

#[tauri::command]
async fn create_time_block(
    block: TimeBlock,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| {
        database.create_time_block(&block)
    })
    .await
}

#[tauri::command]
async fn delete_time_block(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| {
        database.delete_time_block(&id)
    })
    .await
}

#[tauri::command]
async fn update_time_block(
    block: TimeBlock,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| {
        database.update_time_block(&block)
    })
    .await
}

#[tauri::command]
async fn create_recurring_habit(
    habit: RecurringHabit,
    backing_task: Task,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| {
        database.create_recurring_habit(&habit, &backing_task)
    })
    .await
}

#[tauri::command]
async fn set_habit_occurrence(
    occurrence: HabitOccurrence,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| {
        database.set_habit_occurrence(&occurrence)
    })
    .await
}

#[tauri::command]
async fn schedule_habit_occurrence(
    occurrence: HabitOccurrence,
    session: ExecutionSession,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| {
        database.schedule_habit_occurrence(&occurrence, &session)
    })
    .await
}

#[tauri::command]
async fn mark_rescue_prompted(
    session_id: String,
    shown_at_utc: String,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| {
        database.mark_rescue_prompted(&session_id, &shown_at_utc)
    })
    .await
}

#[tauri::command]
async fn start_execution(
    record: ExecutionRecord,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| {
        database.create_execution_record(&record)
    })
    .await
}

#[tauri::command]
async fn finish_execution(
    record_id: String,
    actual_end_utc: String,
    note: String,
    progress_event: ProgressEvent,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| {
        database.finish_execution(&record_id, &actual_end_utc, &note, &progress_event)
    })
    .await
}

#[tauri::command]
async fn apply_progress(
    event: ProgressEvent,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceSnapshot, String> {
    mutate_workspace(state.inner().clone(), move |database| {
        database.apply_progress(&event)
    })
    .await
}

#[tauri::command]
async fn fetch_bilibili_video(bvid: String) -> Result<BilibiliVideo, String> {
    if bvid.len() != 12
        || !bvid.starts_with("BV")
        || !bvid.chars().all(|value| value.is_ascii_alphanumeric())
    {
        return Err("B 站链接中的 BV 号无效".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Daymark/0.1 course-import-beta")
        .build()
        .map_err(|error| format!("无法准备 B 站链接读取：{error}"))?;
    let body = client
        .get("https://api.bilibili.com/x/web-interface/view")
        .query(&[("bvid", bvid.as_str())])
        .send()
        .await
        .map_err(|error| format!("无法读取 B 站公开视频信息：{error}"))?
        .error_for_status()
        .map_err(|error| format!("B 站公开视频请求失败：{error}"))?
        .text()
        .await
        .map_err(|error| format!("无法读取 B 站响应：{error}"))?;
    parse_bilibili_response(&body)
}

fn parse_bilibili_response(body: &str) -> Result<BilibiliVideo, String> {
    let envelope: BilibiliEnvelope =
        serde_json::from_str(body).map_err(|error| format!("B 站返回了无法识别的数据：{error}"))?;
    if envelope.code != 0 {
        return Err(format!("B 站无法读取该视频：{}", envelope.message));
    }
    let data = envelope
        .data
        .ok_or_else(|| "B 站没有返回视频信息".to_string())?;
    let parts = data
        .pages
        .into_iter()
        .map(|part| BilibiliPart {
            page: part.page,
            title: part.part,
            duration_seconds: part.duration,
            source_key: format!("{}:{}", data.bvid, part.cid),
            source_url: format!(
                "https://www.bilibili.com/video/{}?p={}",
                data.bvid, part.page
            ),
        })
        .collect();
    Ok(BilibiliVideo {
        bvid: data.bvid,
        title: data.title,
        owner_name: data.owner.name,
        parts,
    })
}

#[tauri::command]
fn show_reminder(
    title: String,
    body: String,
    session_id: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| format!("无法发送执行提醒：{error}"))?;
    if let Some(session_id) = session_id {
        *state
            .pending_reminder_session
            .lock()
            .map_err(|_| "无法记录提醒目标".to_owned())? = Some((session_id, Instant::now()));
    }
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    let reminder_target = app
        .state::<AppState>()
        .pending_reminder_session
        .lock()
        .ok()
        .and_then(|mut pending| pending.take())
        .filter(|(_, shown_at)| shown_at.elapsed() <= Duration::from_secs(30 * 60));
    if let Some((session_id, _)) = reminder_target {
        let _ = app.emit("daymark-open-session", OpenSessionPayload { session_id });
    } else {
        let _ = app.emit("daymark-open-today", ());
    }
}

#[tauri::command]
async fn create_daily_backup(state: tauri::State<'_, AppState>) -> Result<BackupInfo, String> {
    run_data_operation(state.inner().clone(), |state| {
        let result = state.backups().refresh_daily(Local::now().date_naive());
        let mut backup_error = state
            .backup_error
            .lock()
            .map_err(|_| "无法更新自动备份状态")?;
        match &result {
            Ok(_) => *backup_error = None,
            Err(error) => *backup_error = Some(error.clone()),
        }
        result
    })
    .await
}

#[tauri::command]
async fn create_manual_backup(
    destination: String,
    state: tauri::State<'_, AppState>,
) -> Result<BackupInfo, String> {
    run_data_operation(state.inner().clone(), move |state| {
        state.backups().create_manual(destination)
    })
    .await
}

#[tauri::command]
async fn restore_backup(
    source: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<RestoreOutcome, String> {
    let settings = app
        .store("settings.json")
        .map_err(|error| format!("无法打开应用设置：{error}"))?;
    let previous_preferences = settings.get("preferences");
    run_data_operation(state.inner().clone(), move |state| {
        state
            .backups()
            .restore_coordinated(source, Local::now(), move |restored| {
                let Some(restored) = restored else {
                    return Ok(());
                };
                settings.set("preferences", restored.clone());
                if let Err(error) = settings.save() {
                    match previous_preferences {
                        Some(previous) => settings.set("preferences", previous),
                        None => {
                            settings.delete("preferences");
                        }
                    }
                    let rollback_error = settings.save().err();
                    return Err(match rollback_error {
                        Some(rollback) => {
                            format!("无法保存恢复的偏好：{error}；原偏好也无法重新写入：{rollback}")
                        }
                        None => format!("无法保存恢复的偏好：{error}"),
                    });
                }
                Ok(())
            })
    })
    .await
}

#[tauri::command]
async fn inspect_backup(
    source: String,
    state: tauri::State<'_, AppState>,
) -> Result<BackupPreview, String> {
    run_data_operation(state.inner().clone(), move |state| {
        state.backups().inspect(source)
    })
    .await
}

async fn run_data_operation<T, F>(state: AppState, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&AppState) -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state
            .data_operation_lock
            .lock()
            .map_err(|_| "本地数据操作锁不可用")?;
        operation(&state)
    })
    .await
    .map_err(|error| format!("本地数据后台任务失败：{error}"))?
}

async fn mutate_workspace<F>(state: AppState, operation: F) -> Result<WorkspaceSnapshot, String>
where
    F: FnOnce(&Database) -> Result<(), String> + Send + 'static,
{
    run_data_operation(state, move |state| {
        let database = state.database()?;
        operation(&database)?;
        let snapshot = database.snapshot()?;
        let backup_result = state.backups().refresh_daily(Local::now().date_naive());
        if let Ok(mut backup_error) = state.backup_error.lock() {
            *backup_error = backup_result.err();
        }
        Ok(snapshot)
    })
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let app_data_directory = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data_directory)?;
            let state = AppState {
                database_path: app_data_directory.join("daymark.db"),
                backup_directory: app_data_directory.join("backups"),
                settings_path: app_data_directory.join("settings.json"),
                backup_error: Arc::new(Mutex::new(None)),
                data_operation_lock: Arc::new(Mutex::new(())),
                pending_reminder_session: Arc::new(Mutex::new(None)),
            };
            state.database().map_err(std::io::Error::other)?;
            if let Err(error) = state.backups().create_daily(Local::now().date_naive()) {
                eprintln!("Daymark daily backup was not created: {error}");
                *state
                    .backup_error
                    .lock()
                    .map_err(|_| std::io::Error::other("无法记录自动备份失败状态"))? = Some(error);
            }
            app.manage(state);
            let show = MenuItem::with_id(app, "show", "显示 Daymark", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::new().menu(&menu).tooltip("Daymark");
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|app, event| match event.id.as_ref() {
                "show" => show_main_window(app),
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    show_main_window(tray.app_handle());
                }
            })
            .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_data_overview,
            get_workspace,
            create_task,
            create_task_with_session,
            update_task,
            create_project_with_tasks,
            update_project,
            create_project_milestone,
            update_project_milestone,
            delete_project_milestone,
            create_execution_session,
            create_execution_sessions,
            apply_schedule_draft,
            update_execution_session,
            apply_execution_session_changes,
            delete_execution_session,
            delete_execution_sessions,
            create_time_block,
            delete_time_block,
            update_time_block,
            create_recurring_habit,
            set_habit_occurrence,
            schedule_habit_occurrence,
            mark_rescue_prompted,
            fetch_bilibili_video,
            start_execution,
            finish_execution,
            apply_progress,
            show_reminder,
            create_daily_backup,
            create_manual_backup,
            restore_backup,
            inspect_backup,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Daymark");
}

#[cfg(test)]
mod phase2_tests {
    use super::*;

    #[test]
    fn bilibili_public_metadata_is_mapped_without_treating_media_as_progress() {
        let video = parse_bilibili_response(r#"{"code":0,"message":"0","data":{"bvid":"BV1xx411c7mD","title":"公开课程","owner":{"name":"UP 主"},"pages":[{"cid":42,"page":1,"part":"第一讲","duration":601}]}}"#).unwrap();
        assert_eq!(video.title, "公开课程");
        assert_eq!(
            video.parts,
            vec![BilibiliPart {
                page: 1,
                title: "第一讲".into(),
                duration_seconds: 601,
                source_key: "BV1xx411c7mD:42".into(),
                source_url: "https://www.bilibili.com/video/BV1xx411c7mD?p=1".into()
            }]
        );
    }
}
