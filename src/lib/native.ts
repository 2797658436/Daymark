import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

export interface Project { id: string; title: string; deadlineLocal: string | null }
interface ProjectMilestoneBase { id: string; projectId: string; title: string; targetLocalDate: string; sortOrder: number }
export type ProjectMilestone =
  | (ProjectMilestoneBase & { criterionKind: "orderedTask"; targetTaskId: string; targetCount: null; targetProgress: null })
  | (ProjectMilestoneBase & { criterionKind: "taskCount"; targetTaskId: null; targetCount: number; targetProgress: null })
  | (ProjectMilestoneBase & { criterionKind: "projectProgress"; targetTaskId: null; targetCount: null; targetProgress: number });
export type TaskStatus = "active" | "paused" | "completed";
export interface Task {
  id: string;
  projectId: string | null;
  title: string;
  progress: number;
  status: TaskStatus;
  deadlineLocal: string | null;
  estimatedMinutes: number | null;
  sessionMinutes?: number | null;
  priority?: "low" | "normal" | "high";
  sortOrder: number;
  sourceUrl?: string | null;
  sourceKey?: string | null;
  mediaMinutes?: number | null;
  kind?: "task" | "habit";
}
export interface ExecutionSession {
  id: string;
  taskId: string;
  localDate: string;
  endLocalDate: string;
  startLocal: string;
  endLocal: string;
  timeZone: string;
  utcOffsetMinutes: number | null;
  status: "scheduled" | "missed" | "cancelled" | "skipped";
}
export interface ExecutionSessionChanges { create: ExecutionSession[]; update: ExecutionSession[]; deleteIds: string[] }
export interface ExecutionRecord {
  id: string;
  sessionId: string | null;
  taskId: string;
  actualStartUtc: string;
  actualEndUtc: string | null;
  note: string;
}
export interface ProgressEvent {
  id: string;
  taskId: string;
  fromProgress: number;
  toProgress: number;
  occurredAtUtc: string;
}
export interface TimeBlock {
  id: string;
  title: string;
  localDate: string;
  endLocalDate: string;
  startLocal: string;
  endLocal: string;
  timeZone: string;
  utcOffsetMinutes: number;
}
export interface RecurringHabit {
  id: string;
  taskId: string;
  title: string;
  pattern: "daily" | "weekdays" | "weekly";
  weekdays: number[];
  startDate: string;
  sessionMinutes: number;
  preferredStartLocal: string | null;
  status: "active" | "paused";
}
export interface HabitOccurrence {
  id: string;
  habitId: string;
  localDate: string;
  status: "scheduled" | "completed" | "skipped";
  sessionId: string | null;
}
export interface BilibiliPart { page: number; title: string; durationSeconds: number; sourceKey: string; sourceUrl: string }
export interface BilibiliVideo { bvid: string; title: string; ownerName: string; parts: BilibiliPart[] }
export interface MilestoneOutcome {
  id: string;
  milestoneId: string;
  projectId: string;
  title: string;
  targetLocalDate: string;
  reached: boolean;
  resultText: string;
  frozenAtUtc: string;
}
export interface WorkspaceSnapshot {
  projects: Project[];
  projectMilestones: ProjectMilestone[];
  milestoneOutcomes: MilestoneOutcome[];
  tasks: Task[];
  executionSessions: ExecutionSession[];
  executionRecords: ExecutionRecord[];
  progressEvents: ProgressEvent[];
  timeBlocks: TimeBlock[];
  recurringHabits: RecurringHabit[];
  habitOccurrences: HabitOccurrence[];
  rescuePromptedSessionIds: string[];
}

export interface DataCounts {
  projects: number;
  tasks: number;
  executionSessions: number;
  executionRecords: number;
  progressEvents: number;
  timeBlocks: number;
}
export type BackupKind = "daily" | "preRestore" | "manual";
export interface BackupInfo { path: string; kind: BackupKind }
export interface RestoreOutcome { preRestoreBackup: BackupInfo; restoredPreferences: unknown | null }
export interface BackupPreview { source: string; modifiedAt: string; sizeBytes: number; projects: number; tasks: number }
export interface DataOverview {
  schemaVersion: number;
  databasePath: string;
  backupDirectory: string;
  backupError: string | null;
  counts: DataCounts;
  backups: BackupInfo[];
}

export interface NativeApi {
  getWorkspace(): Promise<WorkspaceSnapshot>;
  createTask(task: Task): Promise<WorkspaceSnapshot>;
  createTaskWithSession(task: Task, session: ExecutionSession): Promise<WorkspaceSnapshot>;
  updateTask(task: Task): Promise<WorkspaceSnapshot>;
  createProjectWithTasks(project: Project, tasks: Task[]): Promise<WorkspaceSnapshot>;
  updateProject(project: Project): Promise<WorkspaceSnapshot>;
  createProjectMilestone(milestone: ProjectMilestone): Promise<WorkspaceSnapshot>;
  updateProjectMilestone(milestone: ProjectMilestone): Promise<WorkspaceSnapshot>;
  deleteProjectMilestone(id: string): Promise<WorkspaceSnapshot>;
  createExecutionSession(session: ExecutionSession): Promise<WorkspaceSnapshot>;
  createExecutionSessions(sessions: ExecutionSession[]): Promise<WorkspaceSnapshot>;
  applyScheduleDraft(sessions: ExecutionSession[], occurrences: HabitOccurrence[]): Promise<WorkspaceSnapshot>;
  updateExecutionSession(session: ExecutionSession): Promise<WorkspaceSnapshot>;
  applyExecutionSessionChanges(changes: ExecutionSessionChanges): Promise<WorkspaceSnapshot>;
  deleteExecutionSession(id: string): Promise<WorkspaceSnapshot>;
  deleteExecutionSessions(ids: string[]): Promise<WorkspaceSnapshot>;
  createTimeBlock(block: TimeBlock): Promise<WorkspaceSnapshot>;
  deleteTimeBlock(id: string): Promise<WorkspaceSnapshot>;
  updateTimeBlock(block: TimeBlock): Promise<WorkspaceSnapshot>;
  createRecurringHabit(habit: RecurringHabit, backingTask: Task): Promise<WorkspaceSnapshot>;
  setHabitOccurrence(occurrence: HabitOccurrence): Promise<WorkspaceSnapshot>;
  scheduleHabitOccurrence(occurrence: HabitOccurrence, session: ExecutionSession): Promise<WorkspaceSnapshot>;
  markRescuePrompted(sessionId: string, shownAtUtc: string): Promise<WorkspaceSnapshot>;
  fetchBilibiliVideo(bvid: string): Promise<BilibiliVideo>;
  startExecution(record: ExecutionRecord): Promise<WorkspaceSnapshot>;
  finishExecution(recordId: string, actualEndUtc: string, note: string, progressEvent: ProgressEvent): Promise<WorkspaceSnapshot>;
  applyProgress(event: ProgressEvent): Promise<WorkspaceSnapshot>;
  showReminder(title: string, body: string, sessionId?: string): Promise<void>;
  getDataOverview(): Promise<DataOverview>;
  createDailyBackup(): Promise<BackupInfo>;
  createManualBackup(): Promise<BackupInfo | null>;
  chooseRestoreSource(): Promise<string | null>;
  inspectBackup(path: string): Promise<BackupPreview>;
  restoreBackup(path: string): Promise<RestoreOutcome>;
}

export const EMPTY_WORKSPACE: WorkspaceSnapshot = {
  projects: [], projectMilestones: [], milestoneOutcomes: [], tasks: [], executionSessions: [], executionRecords: [], progressEvents: [], timeBlocks: [], recurringHabits: [], habitOccurrences: [], rescuePromptedSessionIds: [],
};

class TauriNativeApi implements NativeApi {
  getWorkspace() { return invoke<WorkspaceSnapshot>("get_workspace"); }
  createTask(task: Task) { return invoke<WorkspaceSnapshot>("create_task", { task }); }
  createTaskWithSession(task: Task, session: ExecutionSession) { return invoke<WorkspaceSnapshot>("create_task_with_session", { task, session }); }
  updateTask(task: Task) { return invoke<WorkspaceSnapshot>("update_task", { task }); }
  createProjectWithTasks(project: Project, tasks: Task[]) { return invoke<WorkspaceSnapshot>("create_project_with_tasks", { project, tasks }); }
  updateProject(project: Project) { return invoke<WorkspaceSnapshot>("update_project", { project }); }
  createProjectMilestone(milestone: ProjectMilestone) { return invoke<WorkspaceSnapshot>("create_project_milestone", { milestone }); }
  updateProjectMilestone(milestone: ProjectMilestone) { return invoke<WorkspaceSnapshot>("update_project_milestone", { milestone }); }
  deleteProjectMilestone(id: string) { return invoke<WorkspaceSnapshot>("delete_project_milestone", { id }); }
  createExecutionSession(session: ExecutionSession) { return invoke<WorkspaceSnapshot>("create_execution_session", { session }); }
  createExecutionSessions(sessions: ExecutionSession[]) { return invoke<WorkspaceSnapshot>("create_execution_sessions", { sessions }); }
  applyScheduleDraft(sessions: ExecutionSession[], occurrences: HabitOccurrence[]) { return invoke<WorkspaceSnapshot>("apply_schedule_draft", { sessions, occurrences }); }
  updateExecutionSession(session: ExecutionSession) { return invoke<WorkspaceSnapshot>("update_execution_session", { session }); }
  applyExecutionSessionChanges(changes: ExecutionSessionChanges) { return invoke<WorkspaceSnapshot>("apply_execution_session_changes", { changes }); }
  deleteExecutionSession(id: string) { return invoke<WorkspaceSnapshot>("delete_execution_session", { id }); }
  deleteExecutionSessions(ids: string[]) { return invoke<WorkspaceSnapshot>("delete_execution_sessions", { ids }); }
  createTimeBlock(block: TimeBlock) { return invoke<WorkspaceSnapshot>("create_time_block", { block }); }
  deleteTimeBlock(id: string) { return invoke<WorkspaceSnapshot>("delete_time_block", { id }); }
  updateTimeBlock(block: TimeBlock) { return invoke<WorkspaceSnapshot>("update_time_block", { block }); }
  createRecurringHabit(habit: RecurringHabit, backingTask: Task) { return invoke<WorkspaceSnapshot>("create_recurring_habit", { habit, backingTask }); }
  setHabitOccurrence(occurrence: HabitOccurrence) { return invoke<WorkspaceSnapshot>("set_habit_occurrence", { occurrence }); }
  scheduleHabitOccurrence(occurrence: HabitOccurrence, session: ExecutionSession) { return invoke<WorkspaceSnapshot>("schedule_habit_occurrence", { occurrence, session }); }
  markRescuePrompted(sessionId: string, shownAtUtc: string) { return invoke<WorkspaceSnapshot>("mark_rescue_prompted", { sessionId, shownAtUtc }); }
  fetchBilibiliVideo(bvid: string) { return invoke<BilibiliVideo>("fetch_bilibili_video", { bvid }); }
  startExecution(record: ExecutionRecord) { return invoke<WorkspaceSnapshot>("start_execution", { record }); }
  finishExecution(recordId: string, actualEndUtc: string, note: string, progressEvent: ProgressEvent) {
    return invoke<WorkspaceSnapshot>("finish_execution", { recordId, actualEndUtc, note, progressEvent });
  }
  applyProgress(event: ProgressEvent) { return invoke<WorkspaceSnapshot>("apply_progress", { event }); }
  showReminder(title: string, body: string, sessionId?: string) { return invoke<void>("show_reminder", { title, body, sessionId }); }
  getDataOverview() { return invoke<DataOverview>("get_data_overview"); }
  createDailyBackup() { return invoke<BackupInfo>("create_daily_backup"); }
  async createManualBackup() {
    const destination = await save({
      title: "保存 Daymark 备份", defaultPath: "daymark-backup.db",
      filters: [{ name: "Daymark SQLite 备份", extensions: ["db"] }],
    });
    return destination ? invoke<BackupInfo>("create_manual_backup", { destination }) : null;
  }
  chooseRestoreSource() {
    return open({ title: "选择 Daymark 备份", multiple: false, directory: false, filters: [{ name: "Daymark SQLite 备份", extensions: ["db"] }] });
  }
  inspectBackup(path: string) { return invoke<BackupPreview>("inspect_backup", { source: path }); }
  restoreBackup(path: string) { return invoke<RestoreOutcome>("restore_backup", { source: path }); }
}

const PREVIEW_WORKSPACE_KEY = "daymark.phase1.workspace";

class BrowserPreviewApi implements NativeApi {
  private backups: BackupInfo[] = [];
  private read(): WorkspaceSnapshot {
    const raw = localStorage.getItem(PREVIEW_WORKSPACE_KEY);
    if (!raw) return structuredClone(EMPTY_WORKSPACE);
    try {
      const parsed = JSON.parse(raw) as Partial<WorkspaceSnapshot>;
      return {
        ...structuredClone(EMPTY_WORKSPACE),
        ...parsed,
        projects: (parsed.projects ?? []).map((project) => ({ ...project, deadlineLocal: project.deadlineLocal ?? null })),
        projectMilestones: parsed.projectMilestones ?? [],
        tasks: (parsed.tasks ?? []).map((task) => ({ priority: "normal", sessionMinutes: null, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task", ...task })),
        recurringHabits: parsed.recurringHabits ?? [],
        habitOccurrences: parsed.habitOccurrences ?? [],
        rescuePromptedSessionIds: parsed.rescuePromptedSessionIds ?? [],
      } as WorkspaceSnapshot;
    }
    catch { return structuredClone(EMPTY_WORKSPACE); }
  }
  private write(next: WorkspaceSnapshot) {
    localStorage.setItem(PREVIEW_WORKSPACE_KEY, JSON.stringify(next));
    return Promise.resolve(structuredClone(next));
  }
  getWorkspace() { return Promise.resolve(this.read()); }
  createTask(task: Task) {
    const state = this.read();
    if (!task.title.trim()) return Promise.reject(new Error("任务标题不能为空"));
    if (state.tasks.some((item) => item.id === task.id)) return Promise.reject(new Error("任务已存在"));
    return this.write({ ...state, tasks: [...state.tasks, task] });
  }
  createTaskWithSession(task: Task, session: ExecutionSession) {
    const state = this.read();
    if (!task.title.trim() || session.taskId !== task.id || state.tasks.some((item) => item.id === task.id) || state.executionSessions.some((item) => item.id === session.id)) return Promise.reject(new Error("任务与计划时段无法一起创建"));
    return this.write({ ...state, tasks: [...state.tasks, task], executionSessions: [...state.executionSessions, session] });
  }
  updateTask(task: Task) {
    const state = this.read();
    if (!state.tasks.some((item) => item.id === task.id)) return Promise.reject(new Error("找不到要更新的任务"));
    return this.write({ ...state, tasks: state.tasks.map((item) => item.id === task.id ? task : item) });
  }
  createProjectWithTasks(project: Project, tasks: Task[]) {
    const state = this.read();
    const ids = new Set(tasks.map((task) => task.id));
    if (!project.title.trim() || ids.size !== tasks.length || state.projects.some((item) => item.id === project.id)) {
      return Promise.reject(new Error("项目或课程任务包含重复数据"));
    }
    return this.write({ ...state, projects: [...state.projects, project], tasks: [...state.tasks, ...tasks] });
  }
  updateProject(project: Project) {
    const state = this.read();
    if (!project.title.trim() || (project.deadlineLocal !== null && !isLocalDate(project.deadlineLocal)) || !state.projects.some((item) => item.id === project.id)) return Promise.reject(new Error("项目数据无效或项目不存在"));
    return this.write({ ...state, projects: state.projects.map((item) => item.id === project.id ? project : item) });
  }
  createProjectMilestone(milestone: ProjectMilestone) {
    const state = this.read(); const error = validatePreviewMilestone(state, milestone);
    if (error || state.projectMilestones.some((item) => item.id === milestone.id)) return Promise.reject(new Error(error ?? "项目里程碑已存在"));
    return this.write({ ...state, projectMilestones: [...state.projectMilestones, milestone] });
  }
  updateProjectMilestone(milestone: ProjectMilestone) {
    const state = this.read(); const error = validatePreviewMilestone(state, milestone);
    if (error || !state.projectMilestones.some((item) => item.id === milestone.id)) return Promise.reject(new Error(error ?? "找不到要更新的项目里程碑"));
    return this.write({ ...state, projectMilestones: state.projectMilestones.map((item) => item.id === milestone.id ? milestone : item) });
  }
  deleteProjectMilestone(id: string) {
    const state = this.read();
    if (!state.projectMilestones.some((item) => item.id === id)) return Promise.reject(new Error("找不到要删除的项目里程碑"));
    return this.write({ ...state, projectMilestones: state.projectMilestones.filter((item) => item.id !== id) });
  }
  createExecutionSession(session: ExecutionSession) {
    const state = this.read();
    if (state.executionSessions.some((item) => item.id === session.id)) return Promise.reject(new Error("计划时段已存在"));
    return this.write({ ...state, executionSessions: [...state.executionSessions, session] });
  }
  createExecutionSessions(sessions: ExecutionSession[]) {
    const state = this.read();
    const ids = new Set(sessions.map((session) => session.id));
    if (ids.size !== sessions.length || sessions.some((session) => state.executionSessions.some((item) => item.id === session.id))) return Promise.reject(new Error("排程草案包含重复时段"));
    return this.write({ ...state, executionSessions: [...state.executionSessions, ...sessions] });
  }
  applyScheduleDraft(sessions: ExecutionSession[], occurrences: HabitOccurrence[]) {
    const state = this.read();
    const ids = new Set(sessions.map((session) => session.id));
    if (ids.size !== sessions.length || sessions.some((session) => state.executionSessions.some((item) => item.id === session.id))) return Promise.reject(new Error("排程草案包含重复时段"));
    const affected = new Set(occurrences.map((item) => `${item.habitId}:${item.localDate}`));
    return this.write({ ...state, executionSessions: [...state.executionSessions, ...sessions], habitOccurrences: [...state.habitOccurrences.filter((item) => !affected.has(`${item.habitId}:${item.localDate}`)), ...occurrences] });
  }
  updateExecutionSession(session: ExecutionSession) {
    const state = this.read();
    if (state.executionRecords.some((item) => item.sessionId === session.id)) return Promise.reject(new Error("本次已产生执行记录"));
    const habitOccurrences = state.habitOccurrences.map((item) => item.sessionId !== session.id ? item
      : session.status === "cancelled" || session.status === "skipped" ? { ...item, status: "skipped" as const }
        : session.status === "scheduled" ? { ...item, status: "scheduled" as const } : item);
    return this.write({ ...state, executionSessions: state.executionSessions.map((item) => item.id === session.id ? session : item), habitOccurrences });
  }
  applyExecutionSessionChanges(changes: ExecutionSessionChanges) {
    const state = this.read();
    if (changes.deleteIds.some((id) => state.executionRecords.some((item) => item.sessionId === id)) || changes.update.some((session) => state.executionRecords.some((item) => item.sessionId === session.id))) return Promise.reject(new Error("部分时段已产生执行记录"));
    const existingAfterDelete = state.executionSessions.filter((item) => !changes.deleteIds.includes(item.id));
    if (changes.create.some((session) => existingAfterDelete.some((item) => item.id === session.id))) return Promise.reject(new Error("计划时段已存在"));
    const updateIds = new Set(changes.update.map((session) => session.id));
    if (changes.update.some((session) => !existingAfterDelete.some((item) => item.id === session.id))) return Promise.reject(new Error("找不到可移动的计划时段"));
    const executionSessions = [...existingAfterDelete.map((item) => updateIds.has(item.id) ? changes.update.find((session) => session.id === item.id)! : item), ...changes.create];
    return this.write({ ...state, executionSessions, habitOccurrences: state.habitOccurrences.filter((item) => !item.sessionId || !changes.deleteIds.includes(item.sessionId)) });
  }
  deleteExecutionSession(id: string) {
    const state = this.read();
    if (state.executionRecords.some((item) => item.sessionId === id)) return Promise.reject(new Error("本次已产生执行记录"));
    return this.write({ ...state, executionSessions: state.executionSessions.filter((item) => item.id !== id) });
  }
  deleteExecutionSessions(ids: string[]) {
    const state = this.read();
    if (ids.some((id) => state.executionRecords.some((item) => item.sessionId === id))) return Promise.reject(new Error("部分时段已产生执行记录"));
    return this.write({ ...state, executionSessions: state.executionSessions.filter((item) => !ids.includes(item.id)), habitOccurrences: state.habitOccurrences.filter((item) => !item.sessionId || !ids.includes(item.sessionId)) });
  }
  createTimeBlock(block: TimeBlock) {
    const state = this.read();
    if (!block.title.trim() || state.timeBlocks.some((item) => item.id === block.id)) return Promise.reject(new Error("时间块标题为空或已经存在"));
    return this.write({ ...state, timeBlocks: [...state.timeBlocks, block] });
  }
  deleteTimeBlock(id: string) { const state = this.read(); return this.write({ ...state, timeBlocks: state.timeBlocks.filter((item) => item.id !== id) }); }
  updateTimeBlock(block: TimeBlock) {
    const state = this.read();
    if (!block.title.trim()) return Promise.reject(new Error("时间块标题为空"));
    if (!state.timeBlocks.some((item) => item.id === block.id)) return Promise.reject(new Error("未找到要更新的时间块"));
    return this.write({ ...state, timeBlocks: state.timeBlocks.map((item) => item.id === block.id ? block : item) });
  }
  createRecurringHabit(habit: RecurringHabit, backingTask: Task) {
    const state = this.read();
    if (!habit.title.trim() || habit.taskId !== backingTask.id || state.recurringHabits.some((item) => item.id === habit.id)) return Promise.reject(new Error("重复习惯数据无效"));
    return this.write({ ...state, recurringHabits: [...state.recurringHabits, habit], tasks: [...state.tasks, backingTask] });
  }
  setHabitOccurrence(occurrence: HabitOccurrence) {
    const state = this.read();
    const existing = state.habitOccurrences.find((item) => item.habitId === occurrence.habitId && item.localDate === occurrence.localDate);
    return this.write({ ...state, habitOccurrences: existing ? state.habitOccurrences.map((item) => item === existing ? occurrence : item) : [...state.habitOccurrences, occurrence] });
  }
  scheduleHabitOccurrence(occurrence: HabitOccurrence, session: ExecutionSession) {
    const state = this.read();
    if (state.executionSessions.some((item) => item.id === session.id)) return Promise.reject(new Error("习惯时段已经存在"));
    const remaining = state.habitOccurrences.filter((item) => item.habitId !== occurrence.habitId || item.localDate !== occurrence.localDate);
    return this.write({ ...state, executionSessions: [...state.executionSessions, session], habitOccurrences: [...remaining, occurrence] });
  }
  markRescuePrompted(sessionId: string, _shownAtUtc: string) {
    const state = this.read();
    return this.write({ ...state, rescuePromptedSessionIds: state.rescuePromptedSessionIds.includes(sessionId) ? state.rescuePromptedSessionIds : [...state.rescuePromptedSessionIds, sessionId] });
  }
  async fetchBilibiliVideo(_bvid: string): Promise<BilibiliVideo> { throw new Error("B 站链接读取仅在 Daymark 桌面版可用"); }
  startExecution(record: ExecutionRecord) {
    const state = this.read();
    if (state.executionRecords.some((item) => !item.actualEndUtc)) return Promise.reject(new Error("已有正在进行的本次执行"));
    return this.write({ ...state, executionRecords: [...state.executionRecords, record] });
  }
  finishExecution(recordId: string, actualEndUtc: string, note: string, event: ProgressEvent) {
    const state = this.read();
    const record = state.executionRecords.find((item) => item.id === recordId && !item.actualEndUtc);
    const task = state.tasks.find((item) => item.id === event.taskId);
    if (!record || !task || task.progress !== event.fromProgress || record.taskId !== event.taskId) {
      return Promise.reject(new Error("执行或进度状态已经变化，请刷新后重试"));
    }
    const tasks = state.tasks.map((item) => item.id === task.id ? { ...item, progress: event.toProgress, status: event.toProgress === 100 ? "completed" as const : item.status === "completed" ? "active" as const : item.status } : item);
    const executionRecords = state.executionRecords.map((item) => item.id === recordId ? { ...item, actualEndUtc, note } : item);
    const habitOccurrences = state.habitOccurrences.map((item) => item.sessionId === record.sessionId ? { ...item, status: "completed" as const } : item);
    return this.write({ ...state, tasks, executionRecords, habitOccurrences, progressEvents: [...state.progressEvents, event] });
  }
  applyProgress(event: ProgressEvent) {
    const state = this.read();
    const task = state.tasks.find((item) => item.id === event.taskId);
    if (!task || task.progress !== event.fromProgress) return Promise.reject(new Error("任务进度已经变化，请刷新后重试"));
    const tasks = state.tasks.map((item) => item.id === task.id ? { ...item, progress: event.toProgress, status: event.toProgress === 100 ? "completed" as const : item.status === "completed" ? "active" as const : item.status } : item);
    return this.write({ ...state, tasks, progressEvents: [...state.progressEvents, event] });
  }
  async showReminder(title: string, body: string, _sessionId?: string) {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission === "granted") new Notification(title, { body });
  }
  async getDataOverview(): Promise<DataOverview> {
    const state = this.read();
    return {
      schemaVersion: 6, databasePath: "浏览器预览使用 localStorage", backupDirectory: "仅桌面版写入磁盘", backupError: null,
      counts: { projects: state.projects.length, tasks: state.tasks.length, executionSessions: state.executionSessions.length, executionRecords: state.executionRecords.length, progressEvents: state.progressEvents.length, timeBlocks: state.timeBlocks.length },
      backups: this.backups,
    };
  }
  async createDailyBackup() { const backup: BackupInfo = { path: "浏览器预览不写入磁盘", kind: "daily" }; this.backups = [backup]; return backup; }
  async createManualBackup() { return null; }
  async chooseRestoreSource() { return null; }
  async inspectBackup(path: string): Promise<BackupPreview> { return { source: path, modifiedAt: new Date().toISOString(), sizeBytes: 0, projects: this.read().projects.length, tasks: this.read().tasks.length }; }
  async restoreBackup(_path: string): Promise<RestoreOutcome> { throw new Error("请在 Daymark 桌面应用中恢复备份"); }
}

export function createNativeApi(): NativeApi {
  return "__TAURI_INTERNALS__" in window ? new TauriNativeApi() : new BrowserPreviewApi();
}

function isLocalDate(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T12:00:00`).getTime()); }

function validatePreviewMilestone(state: WorkspaceSnapshot, milestone: ProjectMilestone) {
  if (!milestone.title.trim() || !isLocalDate(milestone.targetLocalDate)) return "项目里程碑标题或日期无效";
  if (!state.projects.some((project) => project.id === milestone.projectId)) return "项目里程碑必须属于已有项目";
  if (milestone.criterionKind === "orderedTask" && !state.tasks.some((task) => task.id === milestone.targetTaskId && task.projectId === milestone.projectId)) return "有序任务里程碑的目标任务必须属于同一项目";
  if (milestone.criterionKind === "taskCount" && milestone.targetCount <= 0) return "任务数量必须大于 0";
  if (milestone.criterionKind === "projectProgress" && (milestone.targetProgress < 1 || milestone.targetProgress > 100)) return "项目进度必须位于 1 到 100 之间";
  return null;
}
