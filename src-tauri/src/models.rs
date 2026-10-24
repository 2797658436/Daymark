use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub title: String,
    pub deadline_local: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMilestone {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub target_local_date: String,
    pub criterion_kind: String,
    pub target_task_id: Option<String>,
    pub target_count: Option<u32>,
    pub target_progress: Option<u8>,
    pub sort_order: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneOutcome {
    pub id: String,
    pub milestone_id: String,
    pub project_id: String,
    pub title: String,
    pub target_local_date: String,
    pub reached: bool,
    pub result_text: String,
    pub frozen_at_utc: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub progress: u8,
    pub status: String,
    pub deadline_local: Option<String>,
    pub estimated_minutes: Option<u32>,
    pub session_minutes: Option<u32>,
    pub priority: String,
    pub sort_order: i64,
    pub source_url: Option<String>,
    pub source_key: Option<String>,
    pub media_minutes: Option<u32>,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionSession {
    pub id: String,
    pub task_id: String,
    pub local_date: String,
    pub end_local_date: String,
    pub start_local: String,
    pub end_local: String,
    pub time_zone: String,
    pub utc_offset_minutes: Option<i32>,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionRecord {
    pub id: String,
    pub session_id: Option<String>,
    pub task_id: String,
    pub actual_start_utc: String,
    pub actual_end_utc: Option<String>,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub id: String,
    pub task_id: String,
    pub from_progress: u8,
    pub to_progress: u8,
    pub occurred_at_utc: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeBlock {
    pub id: String,
    pub title: String,
    pub local_date: String,
    pub end_local_date: String,
    pub start_local: String,
    pub end_local: String,
    pub time_zone: String,
    pub utc_offset_minutes: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringHabit {
    pub id: String,
    pub task_id: String,
    pub title: String,
    pub pattern: String,
    pub weekdays: Vec<u8>,
    pub start_date: String,
    pub session_minutes: u32,
    pub preferred_start_local: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HabitOccurrence {
    pub id: String,
    pub habit_id: String,
    pub local_date: String,
    pub status: String,
    pub session_id: Option<String>,
}

/// 一次「进度到 100」的主观记录。
///
/// 它只**引用**进度事件（`progress_event_id`），不改写进度事实；`created_at_utc`
/// 与 `updated_at_utc` 由写入方生成，因此不进入序列化边界。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionRecord {
    pub id: String,
    pub task_id: String,
    pub progress_event_id: String,
    pub completed_at_utc: String,
    pub progress_before: u8,
    pub fit: Option<String>,
    pub note: String,
    pub tags: Vec<String>,
    pub reverted_at_utc: Option<String>,
}

/// 快照里的记录：文本字段加一个 join 出来的图片张数，**不含图片字节**。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionRecordSummary {
    #[serde(flatten)]
    pub record: CompletionRecord,
    pub image_count: i64,
}

/// 完成记录的取证图片。字节以 base64 跨过命令边界，入库为 BLOB；
/// 由 `record_completion`／`update_completion` 整体替换。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionImage {
    pub id: String,
    pub sort_order: i64,
    pub mime: String,
    pub width: i64,
    pub height: i64,
    pub size_bytes: i64,
    pub data_base64: String,
    pub thumb_base64: String,
}
