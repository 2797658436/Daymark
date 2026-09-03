import {
  ArchiveRestore, ArrowDown, ArrowUp, Bell, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsUpDown, CircleAlert,
  Clock3, Database, Diamond, FolderKanban, Home, Inbox, Magnet, Moon, Palette, Pencil, Play, Plus, RotateCcw,
  Settings2, Square, Sun, Upload, X, ChartNoAxesColumnIncreasing, Sparkles, Repeat2, Ban, Flag,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode, type RefObject, type WheelEvent as ReactWheelEvent } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";

import { Button } from "./components/ui/button";
import { parseCourseText, type CourseTaskDraft } from "./lib/courseImport";
import { extractBvid } from "./lib/bilibili";
import { habitDatesBetween, habitOccursOn } from "./lib/recurrence";
import { buildSevenDayReview } from "./lib/review";
import { buildSchedulePlan, type ScheduleAllocation, type ScheduleItem } from "./lib/scheduling";
import { createCalendarTimeline, defaultSlotSlicesForWeekday, timelineRangeFromKey, type CalendarTimeline } from "./lib/calendarTimeline";
import { concurrentLayouts, insertionChanges, type CalendarDropMode } from "./lib/calendarPlacement";
import { calendarDayMarkers, calendarDaySummary, deadlineUrgency, deadlineUrgencyLabel } from "./lib/calendarSummary";
import {
  createNativeApi, EMPTY_WORKSPACE, type BackupInfo, type BackupPreview, type BilibiliVideo, type ExecutionRecord, type ExecutionSession,
  type HabitOccurrence, type NativeApi, type ProgressEvent, type Project, type ProjectMilestone, type RecurringHabit, type Task, type TimeBlock, type WorkspaceSnapshot,
} from "./lib/native";
import {
  calendarScaleForZoom, createSettingsRepository, DEFAULT_SETTINGS, type AppSettings, type DefaultTimeSlot, type PageId, type SettingsRepository,
} from "./lib/settings";

type SaveState = "saved" | "saving" | "unsaved";
type UndoOperation = { label: string; run: () => Promise<WorkspaceSnapshot> };
interface AppProps { settings?: SettingsRepository; native?: NativeApi }
interface CalendarDropIntent { date: string; startMinute: number; taskId: string; sessionId: string; mode: CalendarDropMode; targetSessionId: string }

const pages: Array<{ id: PageId; label: string; icon: typeof Home }> = [
  { id: "today", label: "今日", icon: Home },
  { id: "calendar", label: "日历", icon: CalendarDays },
  { id: "projects", label: "项目", icon: FolderKanban },
  { id: "review", label: "7 天回顾", icon: ChartNoAxesColumnIncreasing },
  { id: "data", label: "数据", icon: Database },
  { id: "appearance", label: "设置", icon: Settings2 },
];

export default function App({ settings: injectedSettings, native: injectedNative }: AppProps) {
  const [settingsRepository] = useState(() => injectedSettings ?? createSettingsRepository());
  const [native] = useState(() => injectedNative ?? createNativeApi());
  const [preferences, setPreferences] = useState(DEFAULT_SETTINGS);
  const [page, setPage] = useState<PageId>(DEFAULT_SETTINGS.lastPage);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(EMPTY_WORKSPACE);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<UndoOperation[]>([]);
  const [finishing, setFinishing] = useState<ExecutionRecord | null>(null);
  const [taskPoolOpen, setTaskPoolOpen] = useState(true);
  const [schedulingOpen, setSchedulingOpen] = useState(false);
  const [calendarFocusSessionId, setCalendarFocusSessionId] = useState<string | null>(null);
  const workspaceRef = useRef(workspace); const preferencesRef = useRef(preferences);
  workspaceRef.current = workspace; preferencesRef.current = preferences;
  const saveRevision = useRef(0);
  const remindedSessions = useRef(new Set<string>());
  const startupSummaryShown = useRef(false);
  const retryAction = useRef<null | (() => Promise<void>)>(null);
  const markingRescue = useRef(new Set<string>());

  const reload = useCallback(async () => {
    try { setLoadError(null); setWorkspace(await native.getWorkspace()); }
    catch (error) { setLoadError(readError(error)); }
  }, [native]);

  useEffect(() => {
    let alive = true;
    Promise.all([settingsRepository.load(), native.getWorkspace()])
      .then(([savedPreferences, data]) => {
        if (!alive) return;
        setPreferences(savedPreferences); setPage(savedPreferences.lastPage); setWorkspace(data);
      })
      .catch((error) => alive && setLoadError(readError(error)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [native, settingsRepository]);

  useEffect(() => {
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => applyDisplayPreferences(preferences, colorScheme.matches, reducedMotion.matches);
    apply(); colorScheme.addEventListener("change", apply); reducedMotion.addEventListener("change", apply);
    return () => { colorScheme.removeEventListener("change", apply); reducedMotion.removeEventListener("change", apply); };
  }, [preferences]);

  useEffect(() => {
    if (!preferences.remindersEnabled) return;
    const check = () => {
      const now = Date.now();
      const today = toLocalDate(new Date());
      for (const session of workspace.executionSessions) {
        if (session.status !== "scheduled" || session.localDate !== today || remindedSessions.current.has(session.id)) continue;
        const startsAt = new Date(`${session.localDate}T${session.startLocal}:00`).getTime();
        const until = startsAt - now;
        if (until >= 0 && until <= preferences.reminderLeadMinutes * 60_000) {
          remindedSessions.current.add(session.id);
          void native.showReminder(`即将开始：${taskTitle(workspace, session.taskId)}`, `${session.startLocal}–${session.endLocal}，点击托盘图标回到 Daymark。`, session.id)
            .catch(() => remindedSessions.current.delete(session.id));
        }
      }
    };
    check(); const timer = window.setInterval(check, 30_000); return () => window.clearInterval(timer);
  }, [native, preferences.reminderLeadMinutes, preferences.remindersEnabled, workspace]);

  const persist = useCallback(async (next: AppSettings) => {
    const revision = ++saveRevision.current;
    setSaveState("saving"); setSaveError(null);
    try { await settingsRepository.save(next); if (revision === saveRevision.current) { setSaveState("saved"); retryAction.current = null; } }
    catch (error) { if (revision === saveRevision.current) { retryAction.current = () => persist(next); setSaveState("unsaved"); setSaveError(readError(error)); } }
  }, [settingsRepository]);

  const updatePreferences = useCallback((patch: Partial<AppSettings>) => {
    setPreferences((current) => { const next = { ...current, ...patch }; void persist(next); return next; });
    if (patch.lastPage) setPage(patch.lastPage);
  }, [persist]);

  const openCalendarSession = useCallback((sessionId: string) => {
    const session = workspaceRef.current.executionSessions.find((item) => item.id === sessionId);
    if (!session) return false;
    setCalendarFocusSessionId(session.id);
    updatePreferences({ lastPage: "calendar", calendarView: "day", calendarAnchors: { ...preferencesRef.current.calendarAnchors, day: session.localDate } });
    return true;
  }, [updatePreferences]);

  useEffect(() => {
    const today = toLocalDate(new Date());
    if (startupSummaryShown.current || preferences.startupSummary === "never" || workspace.tasks.length === 0) return;
    if (preferences.startupSummary === "daily" && preferences.lastStartupSummaryLocalDate === today) return;
    startupSummaryShown.current = true;
    const due = workspace.tasks.filter((task) => task.status === "active" && task.deadlineLocal && daysBetween(today, task.deadlineLocal) <= 7).length;
    const planned = workspace.executionSessions.filter((session) => session.status === "scheduled" && session.localDate === today).length;
    void native.showReminder("Daymark 今日摘要", `今天有 ${planned} 个执行时段，${due} 个临近期任务。`)
      .then(() => updatePreferences({ lastStartupSummaryLocalDate: today }))
      .catch(() => { startupSummaryShown.current = false; });
  }, [native, preferences.lastStartupSummaryLocalDate, preferences.startupSummary, updatePreferences, workspace]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let active = true; const disposers: Array<() => void> = [];
    const register = (promise: Promise<() => void>) => void promise.then((dispose) => { if (active) disposers.push(dispose); else dispose(); });
    register(listen("daymark-open-today", () => { setCalendarFocusSessionId(null); updatePreferences({ lastPage: "today" }); }));
    register(listen<string | { sessionId: string }>("daymark-open-session", (event) => {
      const sessionId = typeof event.payload === "string" ? event.payload : event.payload.sessionId;
      if (!sessionId || !openCalendarSession(sessionId)) { setCalendarFocusSessionId(null); updatePreferences({ lastPage: "today" }); }
    }));
    return () => { active = false; disposers.forEach((dispose) => dispose()); };
  }, [openCalendarSession, updatePreferences]);

  const commit = useCallback(async (action: () => Promise<WorkspaceSnapshot>) => {
    setSaveState("saving"); setSaveError(null);
    try { const next = await action(); setWorkspace(next); retryAction.current = null; setSaveState("saved"); return next; }
    catch (error) { retryAction.current = async () => { await commit(action); }; setSaveState("unsaved"); setSaveError(readError(error)); throw error; }
  }, []);

  useEffect(() => {
    if (!preferences.checkInEnabled || !preferences.rescuePromptsEnabled) return;
    const now = new Date();
    const today = toLocalDate(now);
    const candidate = workspace.executionSessions.find((session) => (session.status === "scheduled" || session.status === "missed")
      && session.localDate === today
      && !workspace.rescuePromptedSessionIds.includes(session.id)
      && !markingRescue.current.has(session.id)
      && !workspace.executionRecords.some((record) => record.sessionId === session.id)
      && timeMinutes(session.startLocal) + preferences.checkInGraceMinutes < now.getHours() * 60 + now.getMinutes());
    if (!candidate) return;
    markingRescue.current.add(candidate.id);
    void commit(() => native.markRescuePrompted(candidate.id, now.toISOString())).finally(() => markingRescue.current.delete(candidate.id));
  }, [commit, native, preferences.checkInEnabled, preferences.checkInGraceMinutes, preferences.rescuePromptsEnabled, workspace]);

  const pushUndo = useCallback((operation: UndoOperation) => setUndoStack((items) => [...items.slice(-9), operation]), []);
  const undo = useCallback(async () => {
    const operation = undoStack.at(-1); if (!operation) return;
    try { await commit(operation.run); setUndoStack((items) => items.slice(0, -1)); }
    catch { /* persistent banner owns the retry story */ }
  }, [commit, undoStack]);

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !isEditable(event.target)) {
        event.preventDefault(); void undo();
      }
    };
    window.addEventListener("keydown", handle); return () => window.removeEventListener("keydown", handle);
  }, [undo]);

  useEffect(() => {
    if (!taskPoolOpen) return;
    const closeOverlay = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector('[role="dialog"]') && window.matchMedia("(max-width: 1199px)").matches) {
        setTaskPoolOpen(false);
      }
    };
    window.addEventListener("keydown", closeOverlay);
    return () => window.removeEventListener("keydown", closeOverlay);
  }, [taskPoolOpen]);

  const createTask = async (title: string, extras: Partial<Task> = {}) => {
    const task: Task = {
      id: crypto.randomUUID(), projectId: null, title: title.trim(), progress: 0, status: "active",
      deadlineLocal: null, estimatedMinutes: null, sessionMinutes: null, priority: "normal", sortOrder: workspace.tasks.length,
      sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task", ...extras,
    };
    await commit(() => native.createTask(task));
    return task;
  };

  const updateProgress = async (task: Task, toProgress: number) => {
    if (task.progress === toProgress) return;
    const event = progressEvent(task, toProgress);
    await commit(() => native.applyProgress(event));
  };

  const scheduleTask = async (task: Task, localDate: string, startLocal: string) => {
    const session = makeSession(task, localDate, startLocal);
    await commit(() => native.createExecutionSession(session));
    pushUndo({ label: "撤销安排", run: () => native.deleteExecutionSession(session.id) });
  };

  const createTaskAt = async (title: string, localDate: string, startLocal: string, duration: number) => {
    const task: Task = { id: crypto.randomUUID(), projectId: null, title: title.trim(), progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: duration, sessionMinutes: duration, priority: "normal", sortOrder: workspace.tasks.length, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task" };
    const session = makeSession(task, localDate, startLocal, duration);
    await commit(() => native.createTaskWithSession(task, session));
    pushUndo({ label: "撤销新任务安排", run: () => native.deleteExecutionSession(session.id) });
  };

  const moveSession = async (session: ExecutionSession, localDate: string, startLocal: string, duration = sessionDuration(session)) => {
    const previous = session;
    const next = moveSessionTo(session, localDate, startLocal, duration);
    await commit(() => native.updateExecutionSession(next));
    pushUndo({ label: "撤销时间修改", run: () => native.updateExecutionSession(previous) });
  };

  const placeCalendarItem = async (intent: CalendarDropIntent) => {
    const task = workspace.tasks.find((item) => item.id === intent.taskId);
    const source = workspace.executionSessions.find((item) => item.id === intent.sessionId);
    if (!task && !source) return;
    const duration = source ? sessionDuration(source) : Math.max(5, task?.sessionMinutes ?? task?.estimatedMinutes ?? 60);
    const target = workspace.executionSessions.find((item) => item.id === intent.targetSessionId);
    const startMinute = intent.mode === "overlap" && target ? timeMinutes(target.startLocal) : intent.startMinute;
    const shifted = intent.mode === "insert-before" || intent.mode === "insert-after"
      ? insertionChanges(workspace.executionSessions.filter((item) => item.localDate === intent.date && (item.status === "scheduled" || item.status === "missed")), source?.id ?? "", intent.targetSessionId, intent.mode === "insert-before" ? "before" : "after", duration)
      : [];
    const at = placementDateTime(intent.date, startMinute);
    const placed = source ? moveSessionTo(source, at.date, at.time, duration) : makeSession(task!, at.date, at.time, duration);
    const updates = shifted.map((change) => { const nextAt = placementDateTime(intent.date, change.startMinute); return moveSessionTo(change.session, nextAt.date, nextAt.time, sessionDuration(change.session)); });
    if (source) updates.unshift(placed);
    const previous = [source, ...shifted.map((change) => change.session)].filter((item): item is ExecutionSession => Boolean(item));
    await commit(() => native.applyExecutionSessionChanges({ create: source ? [] : [placed], update: updates, deleteIds: [] }));
    pushUndo({ label: intent.mode.startsWith("insert") ? "撤销插入排程" : intent.mode === "overlap" ? "撤销同时安排" : source ? "撤销时间修改" : "撤销安排", run: () => native.applyExecutionSessionChanges({ create: [], update: previous, deleteIds: source ? [] : [placed.id] }) });
  };

  const cancelSession = async (session: ExecutionSession) => {
    await commit(() => native.deleteExecutionSession(session.id));
    pushUndo({ label: "恢复本次安排", run: () => native.createExecutionSession(session) });
  };

  const startSession = async (session: ExecutionSession) => {
    const record: ExecutionRecord = {
      id: crypto.randomUUID(), sessionId: session.id, taskId: session.taskId,
      actualStartUtc: new Date().toISOString(), actualEndUtc: null, note: "",
    };
    await commit(() => native.startExecution(record));
  };

  const createHabit = async (draft: Omit<RecurringHabit, "id" | "taskId" | "status">) => {
    const id = crypto.randomUUID(); const taskId = crypto.randomUUID();
    const habit: RecurringHabit = { ...draft, id, taskId, status: "active" };
    const backingTask: Task = { id: taskId, projectId: null, title: habit.title, progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sessionMinutes: habit.sessionMinutes, priority: "normal", sortOrder: workspace.tasks.length, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "habit" };
    await commit(() => native.createRecurringHabit(habit, backingTask));
  };

  const scheduleHabit = async (habit: RecurringHabit, date: string) => {
    const task = workspace.tasks.find((item) => item.id === habit.taskId); if (!task) return;
    const start = habit.preferredStartLocal ?? preferences.defaultTimeSlots.find((slot) => slot.weekdays.includes(new Date(`${date}T12:00:00`).getDay()))?.start ?? "19:00";
    const session = makeSession(task, date, start, habit.sessionMinutes);
    const occurrence: HabitOccurrence = { id: crypto.randomUUID(), habitId: habit.id, localDate: date, status: "scheduled", sessionId: session.id };
    await commit(() => native.scheduleHabitOccurrence(occurrence, session));
    pushUndo({ label: "撤销习惯安排", run: () => native.deleteExecutionSessions([session.id]) });
  };

  const skipHabit = async (habit: RecurringHabit, date: string) => {
    const occurrence: HabitOccurrence = { id: crypto.randomUUID(), habitId: habit.id, localDate: date, status: "skipped", sessionId: null };
    await commit(() => native.setHabitOccurrence(occurrence));
  };

  if (loading) return <main className="loading-screen" aria-busy="true"><span className="spinner" aria-hidden="true" />正在恢复本地计划…</main>;

  const activeTasks = workspace.tasks.filter((task) => task.status === "active" && task.kind !== "habit");
  const running = workspace.executionRecords.find((record) => !record.actualEndUtc) ?? null;
  const hasTaskPool = page === "today" || page === "calendar" || page === "projects";
  const showTaskPool = hasTaskPool && taskPoolOpen;

  return (
    <div className={`app-shell ${showTaskPool ? "with-task-pool" : "without-task-pool"}`}>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <aside className="sidebar">
        <div className="brand" aria-label="Daymark"><span className="brand-mark">D</span><strong>Daymark</strong></div>
        <nav aria-label="主导航">
          {pages.map(({ id, label, icon: Icon }) => (
            <button key={id} className={page === id ? "nav-item active" : "nav-item"} aria-current={page === id ? "page" : undefined}
              onClick={() => updatePreferences({ lastPage: id })}><Icon aria-hidden="true" size={20} /><span>{label}</span></button>
          ))}
        </nav>
        <div className="sidebar-foot"><span className={`save-dot ${saveState}`} />{saveState === "saved" ? "已保存到本机" : saveState === "saving" ? "正在保存" : "未保存"}</div>
      </aside>

      <main id="main-content" className={`workspace-main ${page === "calendar" ? "calendar-workspace" : ""}`}>
        {saveError && <div className="error-banner" role="alert"><CircleAlert size={18} />未保存：{saveError}<Button variant="secondary" onClick={() => void retryAction.current?.()}>重试保存</Button></div>}
        {loadError && <div className="error-banner" role="alert"><CircleAlert size={18} />读取失败：{loadError}<Button variant="secondary" onClick={() => void reload()}>重试</Button></div>}
        {undoStack.length > 0 && <button className="undo-toast" onClick={() => void undo()}><RotateCcw size={16} />{undoStack.at(-1)?.label}（Ctrl+Z）</button>}

        {page === "today" && <TodayPage workspace={workspace} preferences={preferences} running={running} onStart={startSession} onFinish={setFinishing} onProgress={updateProgress} onGoCalendar={(session) => { if (session) openCalendarSession(session.id); else { setCalendarFocusSessionId(null); updatePreferences({ lastPage: "calendar" }); } }} onDelay={async (session) => { const now = new Date(); await moveSession(session, session.localDate, minutesTime(now.getHours() * 60 + now.getMinutes() + 10)); }} onSkip={async (session) => { const previous = session; await commit(() => native.updateExecutionSession({ ...session, status: "cancelled" })); pushUndo({ label: "恢复本次安排", run: () => native.updateExecutionSession(previous) }); }} />}
        {page === "calendar" && <CalendarPage workspace={workspace} preferences={preferences} focusSessionId={calendarFocusSessionId} onPreferences={updatePreferences} onSchedule={scheduleTask} onCreateTaskAt={createTaskAt} onMove={moveSession} onPlace={placeCalendarItem} onProgress={updateProgress} onSkipReview={async (session) => { const previous = session; await commit(() => native.updateExecutionSession({ ...session, status: "missed" })); pushUndo({ label: "恢复待回顾时段", run: () => native.updateExecutionSession(previous) }); }} onCreateBlock={async (block) => { await commit(() => native.createTimeBlock(block)); }} onUpdateBlock={async (previous, next) => { await commit(() => native.updateTimeBlock(next)); pushUndo({ label: "恢复时间块", run: () => native.updateTimeBlock(previous) }); }} onDeleteBlock={async (id) => { await commit(() => native.deleteTimeBlock(id)); }} />}
        {page === "projects" && <ProjectsPage workspace={workspace} onCreate={async (project, tasks) => { await commit(() => native.createProjectWithTasks(project, tasks)); }}
          onUpdateProject={async (project) => { await commit(() => native.updateProject(project)); }}
          onCreateMilestone={async (milestone) => { await commit(() => native.createProjectMilestone(milestone)); }}
          onUpdateMilestone={async (milestone) => { await commit(() => native.updateProjectMilestone(milestone)); }}
          onDeleteMilestone={async (milestone) => { await commit(() => native.deleteProjectMilestone(milestone.id)); pushUndo({ label: "恢复项目里程碑", run: () => native.createProjectMilestone(milestone) }); }}
          onProgress={updateProgress} onFetchBilibili={(bvid) => native.fetchBilibiliVideo(bvid)} />}
        {page === "review" && <ReviewPage workspace={workspace} onGoToday={() => updatePreferences({ lastPage: "today" })} />}
        {page === "data" && <DataPage native={native} />}
        {page === "appearance" && <SettingsPage preferences={preferences} onChange={updatePreferences} />}
        {hasTaskPool && !showTaskPool && <button className="task-pool-toggle" aria-label="打开任务池" onClick={() => setTaskPoolOpen(true)}><Inbox size={18} /><span>任务池</span></button>}
      </main>

      {showTaskPool && (
        <>
        <button className="task-pool-scrim" aria-label="关闭任务池浮层" onClick={() => setTaskPoolOpen(false)} />
        <TaskPool tasks={activeTasks} sessions={workspace.executionSessions} projects={workspace.projects} habits={workspace.recurringHabits} occurrences={workspace.habitOccurrences} autoScheduleAssist={preferences.autoScheduleAssist}
          onCreate={createTask} onUpdate={async (task) => { await commit(() => native.updateTask(task)); }} onProgress={updateProgress} onCancelSession={cancelSession} onClose={() => setTaskPoolOpen(false)} onAutoSchedule={() => setSchedulingOpen(true)} onCreateHabit={createHabit} onScheduleHabit={scheduleHabit} onSkipHabit={skipHabit} />
        </>
      )}

      {finishing && <FinishDialog record={finishing} task={workspace.tasks.find((task) => task.id === finishing.taskId)!}
        onClose={() => setFinishing(null)} onSubmit={async (progress, note, actualEndUtc) => {
          const task = workspace.tasks.find((item) => item.id === finishing.taskId)!;
          await commit(() => native.finishExecution(finishing.id, actualEndUtc, note, progressEvent(task, progress)));
          setFinishing(null);
        }} />}
      {schedulingOpen && <AutoScheduleDialog workspace={workspace} preferences={preferences} onClose={() => setSchedulingOpen(false)} onApply={async (sessions, occurrences) => { await commit(() => native.applyScheduleDraft(sessions, occurrences)); pushUndo({ label: "撤销本次自动排程", run: () => native.deleteExecutionSessions(sessions.map((session) => session.id)) }); setSchedulingOpen(false); }} />}
    </div>
  );
}

function PageHeader({ eyebrow, title, actions }: { eyebrow: string; title: string; actions?: ReactNode }) {
  return <header className="page-header"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1></div><div className="header-actions">{actions}</div></header>;
}

function TodayPage({ workspace, preferences, running, onStart, onFinish, onProgress, onGoCalendar, onDelay, onSkip }: {
  workspace: WorkspaceSnapshot; preferences: AppSettings; running: ExecutionRecord | null;
  onStart: (session: ExecutionSession) => Promise<void>; onFinish: (record: ExecutionRecord) => void;
  onProgress: (task: Task, value: number) => Promise<void>; onGoCalendar: (session?: ExecutionSession) => void;
  onDelay: (session: ExecutionSession) => Promise<void>; onSkip: (session: ExecutionSession) => Promise<void>;
}) {
  const today = toLocalDate(new Date());
  const sessions = workspace.executionSessions.filter((item) => item.localDate === today && item.status === "scheduled").sort(compareSessions);
  const missed = workspace.executionSessions.filter((item) => item.localDate === today && item.status === "missed").sort(compareSessions);
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
  const current = sessions.find((session) => timeMinutes(session.startLocal) <= nowMinutes && timeMinutes(session.endLocal) > nowMinutes)
    ?? sessions.find((session) => timeMinutes(session.startLocal) > nowMinutes);
  const rescue = preferences.checkInEnabled && preferences.rescuePromptsEnabled && !running
    ? workspace.executionSessions.find((session) => (session.status === "scheduled" || session.status === "missed") && session.localDate === today && workspace.rescuePromptedSessionIds.includes(session.id) && !workspace.executionRecords.some((record) => record.sessionId === session.id) && timeMinutes(session.startLocal) + preferences.checkInGraceMinutes < nowMinutes)
    : undefined;
  const due = workspace.tasks.filter((task) => task.status === "active" && task.deadlineLocal && daysBetween(today, task.deadlineLocal) <= 7);
  const todayEvents = workspace.progressEvents.filter((event) => toLocalDate(new Date(event.occurredAtUtc)) === today);
  const progressed = new Set(todayEvents.map((event) => event.taskId)).size;
  const delta = todayEvents.reduce((sum, event) => sum + event.toProgress - event.fromProgress, 0);
  return <section className="page-stack" aria-labelledby="today-title">
    <PageHeader eyebrow={formatLongDate(today)} title="今天从下一步开始" actions={<div className="summary-pills"><span>{due.length} 项临期</span><span>推进 {progressed} 项 · +{delta}%</span></div>} />
    {rescue && <section className="rescue-card" aria-labelledby="rescue-title"><div><span className="eyebrow">重新安排一下</span><h2 id="rescue-title">{taskTitle(workspace, rescue.taskId)}</h2><p>原定 {rescue.startLocal} 开始。选择一个现在容易做到的下一步。</p></div><div className="rescue-actions"><Button variant="primary" onClick={() => void onStart(rescue)}><Play size={16} />现在开始</Button><Button onClick={() => void onDelay(rescue)}>延后 10 分钟</Button><Button onClick={() => onGoCalendar()}>重新选择时间</Button><Button onClick={() => void onSkip(rescue)}><Ban size={16} />本次跳过</Button></div></section>}
    <section className="now-card" aria-labelledby="now-title">
      <div><span className="eyebrow">现在</span><h2 id="now-title">{running ? taskTitle(workspace, running.taskId) : current ? taskTitle(workspace, current.taskId) : "暂时没有安排"}</h2>
        <p>{running ? `已于 ${formatClock(running.actualStartUtc)} 开始，结束本次不会自动完成任务。` : current ? `${current.startLocal}–${current.endLocal} · 手动开始后才记录实际投入` : "从右侧任务池拖到日历，为今天留出一个真实时段。"}</p></div>
      {running ? <Button variant="primary" onClick={() => onFinish(running)}><Square size={16} />结束本次</Button>
        : current && preferences.checkInEnabled ? <Button variant="primary" onClick={() => void onStart(current)}><Play size={16} />开始本次</Button>
        : current ? <span className="muted-chip">开始／结束记录未开启</span>
        : <Button variant="primary" onClick={() => onGoCalendar()}>去安排</Button>}
    </section>
    <div className="today-grid">
      <section className="surface-card"><div className="section-heading"><h2>今日时间线</h2><span>{sessions.length} 个执行时段</span></div>
        {sessions.length ? <div className="timeline-list">{sessions.map((session) => {
          const task = workspace.tasks.find((item) => item.id === session.taskId); if (!task) return null;
          return <article key={session.id} className={running?.sessionId === session.id ? "timeline-item current" : "timeline-item"}>
            <time>{session.startLocal}<small>{session.endLocal}</small></time><div><strong>{task.title}</strong><ProgressControl task={task} onCommit={onProgress} /></div>
            <button className="icon-action" aria-label={`在日历中查看 ${task.title}`} onClick={() => onGoCalendar(session)}><CalendarDays size={16} /></button>{preferences.checkInEnabled && !running && <button className="icon-action" aria-label={`开始 ${task.title}`} onClick={() => void onStart(session)}><Play size={16} /></button>}
          </article>;
        })}</div> : <EmptyState icon={<Clock3 />} title="今天还没有安排" text="任务不会因此消失。打开日历拖入一个时段即可。" action={<Button onClick={() => onGoCalendar()}>打开日历</Button>} />}
      </section>
      <section className="surface-card"><div className="section-heading"><h2>待回顾与临期</h2><span>{missed.length} 个未执行时段</span></div>
        {(missed.length > 0 || due.length > 0) ? <div className="attention-list">{missed.map((session) => <div key={session.id}><div><strong>{taskTitle(workspace, session.taskId)}</strong><span>未执行 · {session.startLocal}–{session.endLocal}</span></div></div>)}{due.sort(compareDeadlines).map((task) => <div key={task.id}><div><strong>{task.title}</strong><span>{deadlineLabel(today, task.deadlineLocal!)}</span></div><ProgressControl task={task} onCommit={onProgress} /></div>)}</div>
          : <EmptyState icon={<Check />} title="没有待回顾或临近期任务" text="这里保持安静；任务池仍保存全部活动任务。" />}
      </section>
    </div>
  </section>;
}

function TaskPool({ tasks, sessions, projects, habits, occurrences, autoScheduleAssist, onCreate, onUpdate, onProgress, onCancelSession, onClose, onAutoSchedule, onCreateHabit, onScheduleHabit, onSkipHabit }: {
  tasks: Task[]; sessions: ExecutionSession[]; projects: Project[]; habits: RecurringHabit[]; occurrences: HabitOccurrence[]; autoScheduleAssist: boolean;
  onCreate: (title: string) => Promise<Task>; onUpdate: (task: Task) => Promise<void>; onProgress: (task: Task, value: number) => Promise<void>;
  onCancelSession: (session: ExecutionSession) => Promise<void>; onClose: () => void; onAutoSchedule: () => void;
  onCreateHabit: (habit: Omit<RecurringHabit, "id" | "taskId" | "status">) => Promise<void>;
  onScheduleHabit: (habit: RecurringHabit, date: string) => Promise<void>; onSkipHabit: (habit: RecurringHabit, date: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [filter, setFilter] = useState<"all" | "unscheduled" | "scheduled">("all");
  const [attentionOpen, setAttentionOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [habitForm, setHabitForm] = useState(false); const [habitTitle, setHabitTitle] = useState("");
  const [habitPattern, setHabitPattern] = useState<RecurringHabit["pattern"]>("daily"); const [habitDays, setHabitDays] = useState<number[]>([1]);
  const [habitMinutes, setHabitMinutes] = useState(30); const [habitStart, setHabitStart] = useState("");
  const today = toLocalDate(new Date());
  const attention = tasks.filter((task) => task.deadlineLocal && daysBetween(today, task.deadlineLocal) <= 7).sort(compareDeadlines);
  const visible = tasks.filter((task) => !attention.includes(task) && (filter === "all" || (sessions.some((item) => item.taskId === task.id && item.status === "scheduled") ? filter === "scheduled" : filter === "unscheduled")));
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const [collapsedByUser, setCollapsedByUser] = useState<Set<string>>(() => new Set());
  const toggleProject = (key: string) => {
    const isExpanded = expandedProjects.has(key);
    if (isExpanded) {
      // 展开 → 收起：完全折叠成一行（用户手动收起）
      setExpandedProjects((current) => { const next = new Set(current); next.delete(key); return next; });
      setCollapsedByUser((current) => { const next = new Set(current); next.add(key); return next; });
    } else {
      // 折叠 → 展开
      setExpandedProjects((current) => { const next = new Set(current); next.add(key); return next; });
      setCollapsedByUser((current) => { const next = new Set(current); next.delete(key); return next; });
    }
  };
  const [editing, setEditing] = useState<{ taskId: string; pos: { top: number; left: number } | null } | null>(null);
  const editingTask = editing ? tasks.find((task) => task.id === editing.taskId) ?? null : null;
  const eatNextClickRef = useRef(false);
  useEffect(() => {
    if (!editing) return;
    // 外点关闭：在 capture 阶段拦下这次 click，避免它继续触发底层按钮/折叠。
    // React 的事件委托在 #root 冒泡阶段处理，window capture 先于它执行。
    const isOutside = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      return !el?.closest(".task-editor-popover") && !el?.closest(".task-editor-button");
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!isOutside(event.target)) return;
      // 记录这次外点发生在 pointerdown；真正拦截在 click capture（pointerdown 拦不住独立派发的 click）
      eatNextClickRef.current = true;
    };
    const onClickCapture = (event: MouseEvent) => {
      if (!eatNextClickRef.current) return;
      eatNextClickRef.current = false;
      if (!isOutside(event.target)) return;
      event.stopPropagation();
      setEditing(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setEditing(null); };
    const reposition = () => {
      const anchor = document.querySelector<HTMLElement>(`[data-editor-anchor="${editing.taskId}"]`);
      const rect = anchor?.getBoundingClientRect();
      if (rect) setEditing((current) => current && { ...current, pos: { top: Math.min(rect.bottom + 6, window.innerHeight - 320), left: Math.max(8, Math.min(window.innerWidth - 258, rect.right - 250)) } });
    };
    window.addEventListener("pointerdown", onPointerDown, true); window.addEventListener("click", onClickCapture, true); window.addEventListener("keydown", escape); window.addEventListener("scroll", reposition, true);
    return () => { window.removeEventListener("pointerdown", onPointerDown, true); window.removeEventListener("click", onClickCapture, true); window.removeEventListener("keydown", escape); window.removeEventListener("scroll", reposition, true); };
  }, [editing]);
  const toggleEditor = (task: Task, anchor: HTMLElement) => {
    if (editing?.taskId === task.id) { setEditing(null); return; }
    const rect = anchor.getBoundingClientRect();
    const width = 250;
    setEditing({ taskId: task.id, pos: { top: Math.min(rect.bottom + 6, window.innerHeight - 320), left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width)) } });
  };
  const groups: { key: string; project: Project | null; tasks: Task[] }[] = [];
  {
    const byProject = new Map<string, Task[]>();
    for (const task of visible) {
      const key = task.projectId ?? "__independent__";
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key)!.push(task);
    }
    for (const [key, groupTasks] of byProject) groups.push({ key, project: projects.find((item) => item.id === key) ?? null, tasks: groupTasks });
  }
  const assistCount = tasks.filter((task) => !sessions.some((session) => session.taskId === task.id && session.status === "scheduled")).length
    + habits.filter((habit) => habitOccursOn(habit, today) && !occurrences.some((occurrence) => occurrence.habitId === habit.id && occurrence.localDate === today)).length;
  const submit = async () => { if (!title.trim() || busy) return; setBusy(true); try { await onCreate(title); setTitle(""); } finally { setBusy(false); } };
  return <aside id="task-pool" className="task-pool" aria-labelledby="task-pool-title" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => {
    const id = event.dataTransfer.getData("application/x-daymark-session"); const session = sessions.find((item) => item.id === id); if (session) void onCancelSession(session);
  }}>
    <div className="panel-heading"><div><span className="eyebrow">始终只有一份任务</span><h2 id="task-pool-title">任务池</h2></div><button className="icon-action task-pool-close" aria-label="收起任务池" onClick={onClose}><X size={18} /></button></div>
    <div className="pool-actions"><Button variant="primary" onClick={onAutoSchedule}><Sparkles size={16} />自动排程</Button><Button onClick={() => setHabitForm((value) => !value)}><Repeat2 size={16} />新建重复习惯</Button></div>
    {autoScheduleAssist && assistCount > 0 && <button className="schedule-assist" onClick={onAutoSchedule}><Sparkles size={15} /><span><strong>{assistCount} 项还没有下一次安排</strong><small>可以生成未来 7 天草案，确认后才会应用</small></span></button>}
    {habitForm && <div className="habit-form"><label>习惯名称<input value={habitTitle} onChange={(event) => setHabitTitle(event.target.value)} /></label><label>重复规则<select value={habitPattern} onChange={(event) => setHabitPattern(event.target.value as RecurringHabit["pattern"])}><option value="daily">每天</option><option value="weekdays">工作日</option><option value="weekly">每周选择</option></select></label>{habitPattern === "weekly" && <fieldset><legend>选择星期</legend><div className="weekday-checks">{[1, 2, 3, 4, 5, 6, 0].map((day) => <label key={day}><input type="checkbox" checked={habitDays.includes(day)} onChange={(event) => setHabitDays((days) => event.target.checked ? [...days, day] : days.filter((value) => value !== day))} />{["日", "一", "二", "三", "四", "五", "六"][day]}</label>)}</div></fieldset>}<label>单次投入（分钟）<input type="number" min="5" max="240" value={habitMinutes} onChange={(event) => setHabitMinutes(Number(event.target.value))} /></label><label>固定开始（可选）<input type="time" value={habitStart} onChange={(event) => setHabitStart(event.target.value)} /></label><div className="form-actions"><Button onClick={() => setHabitForm(false)}>取消</Button><Button variant="primary" disabled={!habitTitle.trim() || habitMinutes < 5 || (habitPattern === "weekly" && habitDays.length === 0)} onClick={async () => { await onCreateHabit({ title: habitTitle.trim(), pattern: habitPattern, weekdays: habitPattern === "weekly" ? habitDays : [], startDate: toLocalDate(new Date()), sessionMinutes: habitMinutes, preferredStartLocal: habitStart || null }); setHabitTitle(""); setHabitForm(false); }}>创建习惯</Button></div></div>}
    <div className="quick-create"><input aria-label="任务标题" placeholder="只写标题，按 Enter 创建" value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void submit()} /><Button variant="primary" aria-label="创建任务" disabled={!title.trim() || busy} onClick={() => void submit()}><Plus size={17} /></Button></div>
    {attention.length > 0 && <details className="attention-pool" open={attentionOpen} onToggle={(event) => setAttentionOpen((event.currentTarget as HTMLDetailsElement).open)}><summary><CircleAlert size={15} aria-hidden="true" /><strong>需要关注</strong><span>{attention.length} 项临期</span></summary><div className="task-list attention-list">{attention.map((task) => <article key={task.id} className="task-card" tabIndex={0}><div className="task-card-top" draggable title="拖动安排" onDragStart={(event) => { event.dataTransfer.effectAllowed = "copy"; event.dataTransfer.setData("application/x-daymark-task", task.id); }}><strong>{task.title}</strong>{task.deadlineLocal && <span className="deadline-chip">{deadlineLabel(today, task.deadlineLocal)}</span>}</div><div className="task-meta">{projects.find((project) => project.id === task.projectId)?.title ?? "独立任务"}{task.estimatedMinutes ? ` · 约 ${task.estimatedMinutes} 分钟` : ""}</div><ProgressControl task={task} onCommit={onProgress} /></article>)}</div></details>}
    <div className="segmented compact" aria-label="任务池筛选">{(["all", "unscheduled", "scheduled"] as const).map((value) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{value === "all" ? "全部" : value === "unscheduled" ? "未安排" : "已安排"}</button>)}</div>
    <div className="task-list project-groups">{groups.map(({ key, project, tasks: groupTasks }) => {
      const isExpanded = expandedProjects.has(key);
      const fullyCollapsed = !isExpanded && collapsedByUser.has(key);
      const current = groupTasks.find((task) => task.progress < 100);
      const shown = isExpanded ? groupTasks : fullyCollapsed ? [] : current ? [current] : [];
      const done = groupTasks.filter((task) => task.progress === 100).length;
      const avg = groupTasks.length ? Math.round(groupTasks.reduce((sum, task) => sum + task.progress, 0) / groupTasks.length) : 0;
      return <section key={key} className="project-group">
        <button className="project-group-header" aria-expanded={isExpanded} onClick={() => toggleProject(key)}>
          <strong>{project?.title ?? "独立任务"}</strong>
          <span>{groupTasks.length} 项 · 完成 {done} · 平均 {avg}%</span>
          {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        <div className={isExpanded ? "project-group-body expanded" : "project-group-body"}>
          {shown.map((task) => <TaskPoolCard key={task.id} task={task} projects={projects} sessions={sessions} onUpdate={onUpdate} onProgress={onProgress} onEdit={toggleEditor} />)}
          {fullyCollapsed && <p className="empty-inline group-collapsed-hint">已收起，点击展开查看全部任务。</p>}
          {!isExpanded && !fullyCollapsed && !current && <p className="empty-inline">该项目下所有任务都已完成。</p>}
        </div>
      </section>;
    })}{visible.length === 0 && <p className="empty-inline">当前筛选没有任务。</p>}</div>
    {habits.length > 0 && <section className="habit-list" aria-labelledby="habit-list-title"><div className="section-heading"><h3 id="habit-list-title">重复习惯</h3><span>今天</span></div>{habits.filter((habit) => habitOccursOn(habit, toLocalDate(new Date()))).map((habit) => { const date = toLocalDate(new Date()); const occurrence = occurrences.find((item) => item.habitId === habit.id && item.localDate === date); return <article key={habit.id}><div><strong>{habit.title}</strong><span>{habit.pattern === "daily" ? "每天" : habit.pattern === "weekdays" ? "工作日" : "每周选日"} · {habit.sessionMinutes} 分钟</span></div>{occurrence ? <span className="muted-chip">{occurrence.status === "scheduled" ? "已安排" : occurrence.status === "skipped" ? "本次已跳过" : "已完成"}</span> : <div><Button onClick={() => void onScheduleHabit(habit, date)}>安排今天</Button><Button onClick={() => void onSkipHabit(habit, date)}>跳过本次</Button></div>}</article>; })}</section>}

    <p className="drop-hint">把日历时段拖回这里，可取消本次安排并保留任务。</p>
    {editing && editingTask && createPortal(
      <div className="task-editor-popover" role="dialog" aria-label={`编辑任务 ${editingTask.title}`} style={{ top: `${editing.pos?.top ?? 0}px`, left: `${editing.pos?.left ?? 0}px` }}>
        <TaskEditorFields task={editingTask} projects={projects} onUpdate={onUpdate} />
      </div>, document.body)}
  </aside>;
}

function TaskPoolCard({ task, projects, sessions, onUpdate, onProgress, onEdit }: { task: Task; projects: Project[]; sessions: ExecutionSession[]; onUpdate: (task: Task) => Promise<void>; onProgress: (task: Task, value: number) => Promise<void>; onEdit: (task: Task, anchor: HTMLElement) => void }) {
  const upcoming = sessions.filter((item) => item.taskId === task.id && item.status === "scheduled").sort(compareSessions);
  const project = projects.find((item) => item.id === task.projectId);
  return <article className="task-card task-row" tabIndex={0}>
    <div className="task-row-top" draggable title="拖动安排" onDragStart={(event) => { event.dataTransfer.effectAllowed = "copy"; event.dataTransfer.setData("application/x-daymark-task", task.id); }}>
      <strong>{task.title}</strong>
      {task.deadlineLocal && <span className="deadline-chip">{deadlineLabel(toLocalDate(new Date()), task.deadlineLocal)}</span>}
      <span className="task-project-chip">{project?.title ?? "独立任务"}{task.estimatedMinutes ? ` · ${task.estimatedMinutes}分` : ""}</span>
      <button data-editor-anchor={task.id} type="button" className="icon-action task-editor-button" aria-label={`编辑任务 ${task.title}`} onClick={(event) => onEdit(task, event.currentTarget)}><Pencil size={13} /></button>
    </div>
    <ProgressControl task={task} onCommit={onProgress} />
    {upcoming.length > 0 && <small className="task-upcoming">下次：{upcoming[0].localDate} {upcoming[0].startLocal} · 共 {upcoming.length} 次</small>}
  </article>;
}

function CalendarPage({ workspace, preferences, focusSessionId, onPreferences, onSchedule, onCreateTaskAt, onMove, onPlace, onProgress, onSkipReview, onCreateBlock, onUpdateBlock, onDeleteBlock }: {
  workspace: WorkspaceSnapshot; preferences: AppSettings; focusSessionId: string | null; onPreferences: (patch: Partial<AppSettings>) => void;
  onSchedule: (task: Task, date: string, start: string) => Promise<void>;
  onCreateTaskAt: (title: string, date: string, start: string, duration: number) => Promise<void>;
  onMove: (session: ExecutionSession, date: string, start: string, duration?: number) => Promise<void>;
  onPlace: (intent: CalendarDropIntent) => Promise<void>;
  onProgress: (task: Task, value: number) => Promise<void>; onSkipReview: (session: ExecutionSession) => Promise<void>;
  onCreateBlock: (block: TimeBlock) => Promise<void>; onUpdateBlock: (previous: TimeBlock, next: TimeBlock) => Promise<void>; onDeleteBlock: (id: string) => Promise<void>;
}) {
  const anchor = preferences.calendarAnchors[preferences.calendarView] ?? toLocalDate(new Date());
  const setAnchor = (date: string) => onPreferences({ calendarAnchors: { ...preferences.calendarAnchors, [preferences.calendarView]: date } });
  const [editingSession, setEditingSession] = useState<ExecutionSession | null>(null);
  const [continuingSession, setContinuingSession] = useState<ExecutionSession | null>(null);
  const [selectedCalendarDate, setSelectedCalendarDate] = useState<string | null>(null); const [detailTaskId, setDetailTaskId] = useState<string | null>(null); const [detailProjectId, setDetailProjectId] = useState<string | null>(null);
  const [monthFocusDate, setMonthFocusDate] = useState<string | null>(null);
  const [weekKeyboardFocus, setWeekKeyboardFocus] = useState<{ kind: "header" | "grid"; date: string; minute: number }>(() => ({ kind: "header", date: anchor, minute: 540 }));
  const [blockForm, setBlockForm] = useState(false); const [blockTitle, setBlockTitle] = useState(""); const [blockStart, setBlockStart] = useState("12:00"); const [blockEnd, setBlockEnd] = useState("13:00");
  const calendarRef = useRef<HTMLElement>(null); const weekFocusRequested = useRef(false); const [nowDirection, setNowDirection] = useState<"up" | "down" | null>(null);
  const zoomAnchorRef = useRef<null | { scroller: HTMLElement; date: string | null; anchorRatio: number | null; anchorMinute: number | null; clientY: number; pointerOffset: number; contentRatio: number | null }>(null);
  const now = useCurrentTime();
  const dates = weekDates(anchor);
  const zoom = preferences.calendarZoom[preferences.calendarView];
  const scale = preferences.calendarScale[preferences.calendarView];
  const setZoom = (value: AppSettings["calendarZoom"]["day"]) => onPreferences({
    calendarZoom: { ...preferences.calendarZoom, [preferences.calendarView]: value },
    calendarScale: { ...preferences.calendarScale, [preferences.calendarView]: calendarScaleForZoom(preferences.calendarView, value) },
  });
  const shift = (amount: number) => {
    const next = preferences.calendarView === "month" ? addMonths(anchor, amount) : addDays(anchor, amount * (preferences.calendarView === "day" ? 1 : 7));
    if (preferences.calendarView === "month") setMonthFocusDate(next);
    if (preferences.calendarView === "week") setWeekKeyboardFocus((current) => ({ ...current, date: addDays(current.date, amount * 7) }));
    setAnchor(next);
  };
  const moveWeekFocus = (kind: "header" | "grid", date: string, minute = weekKeyboardFocus.minute) => {
    weekFocusRequested.current = true; setWeekKeyboardFocus({ kind, date, minute }); if (!dates.includes(date)) setAnchor(date);
  };
  useEffect(() => {
    if (preferences.calendarView !== "week" || !weekFocusRequested.current) return;
    const frame = requestAnimationFrame(() => { calendarRef.current?.querySelector<HTMLElement>(weekKeyboardFocus.kind === "header" ? `[data-week-header="${weekKeyboardFocus.date}"]` : `.calendar-day[data-day-date="${weekKeyboardFocus.date}"] .day-track`)?.focus(); weekFocusRequested.current = false; });
    return () => cancelAnimationFrame(frame);
  }, [anchor, preferences.calendarView, weekKeyboardFocus]);
  useEffect(() => {
    const root = calendarRef.current; if (!root || preferences.calendarView === "month") { setNowDirection(null); return; }
    const scroller = root.querySelector<HTMLElement>(preferences.calendarView === "day" ? ".continuous-day-axis" : ".calendar-viewport");
    const measure = () => {
      const marker = root.querySelector<HTMLElement>("[data-now-marker]");
      if (!scroller || !marker) { setNowDirection(null); return; }
      const viewport = scroller.getBoundingClientRect(); const line = marker.getBoundingClientRect();
      setNowDirection(line.top < viewport.top ? "up" : line.bottom > viewport.bottom ? "down" : null);
    };
    const frame = requestAnimationFrame(measure); scroller?.addEventListener("scroll", measure, { passive: true });
    return () => { cancelAnimationFrame(frame); scroller?.removeEventListener("scroll", measure); };
  }, [anchor, now, preferences.calendarView, scale, zoom]);
  const returnToNow = () => {
    calendarRef.current?.querySelector<HTMLElement>("[data-now-marker]")?.scrollIntoView({ behavior: "smooth", block: "center" });
    setNowDirection(null);
  };
  const didAutoScrollToNow = useRef(false);
  useLayoutEffect(() => {
    if (didAutoScrollToNow.current || preferences.calendarView === "month") return;
    didAutoScrollToNow.current = true;
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => {
      const marker = calendarRef.current?.querySelector<HTMLElement>("[data-now-marker]");
      if (!marker) return;
      marker.scrollIntoView?.({ behavior: "auto", block: "center" });
      const scroller = calendarRef.current?.querySelector<HTMLElement>(preferences.calendarView === "day" ? ".continuous-day-axis" : ".calendar-viewport");
      if (scroller) scroller.scrollLeft = 0;
    }));
    return () => cancelAnimationFrame(frame);
  }, [preferences.calendarView]);
  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current; if (!anchor) return;
    zoomAnchorRef.current = null;
    const nextTrack = anchor.date ? calendarRef.current?.querySelector<HTMLElement>(`.calendar-day[data-day-date="${anchor.date}"] .day-track`) : null;
    if (nextTrack && anchor.anchorMinute !== null) {
      const nextSegment = Array.from(nextTrack.querySelectorAll<HTMLElement>(".timeline-map-segment")).find((segment) => {
        const start = Number(segment.dataset.startMinute); const end = Number(segment.dataset.endMinute);
        return anchor.anchorMinute! >= start && anchor.anchorMinute! <= end;
      });
      if (nextSegment) {
        const start = Number(nextSegment.dataset.startMinute); const end = Number(nextSegment.dataset.endMinute);
        const rect = nextSegment.getBoundingClientRect();
        const ratio = (anchor.anchorMinute - start) / Math.max(1, end - start);
        anchor.scroller.scrollTop += rect.top + ratio * rect.height - anchor.clientY;
      }
    } else if (nextTrack && anchor.anchorRatio !== null) {
      const nextRect = nextTrack.getBoundingClientRect();
      anchor.scroller.scrollTop += nextRect.top + anchor.anchorRatio * nextRect.height - anchor.clientY;
    } else if (anchor.contentRatio !== null) {
      anchor.scroller.scrollTop = anchor.contentRatio * anchor.scroller.scrollHeight - anchor.pointerOffset;
    }
  }, [scale]);
  const zoomWithWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey || preferences.calendarView === "month" || event.deltaY === 0) return;
    event.preventDefault();
    const nextScale = Math.max(28, Math.min(96, scale + (event.deltaY < 0 ? 4 : -4)));
    if (nextScale === scale) return;
    const clientY = event.clientY;
    const target = event.target instanceof Element ? event.target : null;
    const tracks = Array.from(calendarRef.current?.querySelectorAll<HTMLElement>(".day-track") ?? []);
    const pointedTrack = tracks.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return event.clientX >= rect.left && event.clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    });
    const verticallyPointedTrack = tracks.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return clientY >= rect.top && clientY <= rect.bottom;
    });
    const track = target?.closest<HTMLElement>(".day-track") ?? pointedTrack ?? verticallyPointedTrack ?? null;
    const date = track?.closest<HTMLElement>(".calendar-day")?.dataset.dayDate ?? null;
    const trackRect = track?.getBoundingClientRect();
    const anchorRatio = trackRect?.height ? Math.max(0, Math.min(1, (clientY - trackRect.top) / trackRect.height)) : null;
    const pointedSegment = Array.from(track?.querySelectorAll<HTMLElement>(".timeline-map-segment") ?? []).find((segment) => {
      const rect = segment.getBoundingClientRect();
      return clientY >= rect.top && clientY <= rect.bottom;
    });
    const segmentRect = pointedSegment?.getBoundingClientRect();
    const segmentStart = Number(pointedSegment?.dataset.startMinute); const segmentEnd = Number(pointedSegment?.dataset.endMinute);
    const anchorMinute = pointedSegment && segmentRect?.height
      ? segmentStart + Math.max(0, Math.min(1, (clientY - segmentRect.top) / segmentRect.height)) * (segmentEnd - segmentStart)
      : null;
    const scroller = preferences.calendarView === "day" ? calendarRef.current?.querySelector<HTMLElement>(".continuous-day-axis") : event.currentTarget;
    const scrollerRect = scroller?.getBoundingClientRect();
    const pointerOffset = scrollerRect ? clientY - scrollerRect.top : 0;
    const contentRatio = scroller?.scrollHeight ? (scroller.scrollTop + pointerOffset) / scroller.scrollHeight : null;
    if (scroller) zoomAnchorRef.current = { scroller, date, anchorRatio, anchorMinute, clientY, pointerOffset, contentRatio };
    onPreferences({
      calendarZoom: { ...preferences.calendarZoom, [preferences.calendarView]: closestZoom(preferences.calendarView, nextScale) },
      calendarScale: { ...preferences.calendarScale, [preferences.calendarView]: nextScale },
    });
  };
  const calendarStyle = { "--calendar-hour-height": `${scale}px`, "--calendar-month-row-height": `${scale}px` } as CSSProperties;
  return <section ref={calendarRef} className="calendar-page" aria-labelledby="calendar-title" data-calendar-zoom={zoom} data-calendar-scale={scale} style={calendarStyle}>
    <PageHeader eyebrow="手动排程" title="日历" actions={<><div className="segmented"><button aria-pressed={preferences.calendarView === "day"} className={preferences.calendarView === "day" ? "active" : ""} onClick={() => onPreferences({ calendarView: "day" })}>日</button><button aria-pressed={preferences.calendarView === "week"} className={preferences.calendarView === "week" ? "active" : ""} onClick={() => onPreferences({ calendarView: "week" })}>周</button><button aria-pressed={preferences.calendarView === "month"} className={preferences.calendarView === "month" ? "active" : ""} onClick={() => onPreferences({ calendarView: "month" })}>月</button></div><button className="icon-action" aria-label="上一段日期" onClick={() => shift(-1)}><ChevronLeft /></button><button className="today-button" onClick={() => setAnchor(toLocalDate(new Date()))}>{preferences.calendarView === "day" ? "回到今天" : preferences.calendarView === "week" ? "本周" : "本月"}</button><button className="icon-action" aria-label="下一段日期" onClick={() => shift(1)}><ChevronRight /></button></>} />
    <div className="calendar-toolbar"><span aria-label="当前日历日期" aria-live="polite">{preferences.calendarView === "day" ? formatLongDate(anchor) : preferences.calendarView === "week" ? `${formatShortDate(dates[0])} — ${formatShortDate(dates[6])}` : formatMonth(anchor)}</span><div>{preferences.calendarView === "day" && <div className="segmented day-display-mode" role="group" aria-label="日视图显示模式">{([['defaultSlots', '默认时段'], ['fullDay', '全天']] as const).map(([value, label]) => <button key={value} aria-pressed={preferences.calendarDayMode === value} className={preferences.calendarDayMode === value ? "active" : ""} onClick={() => onPreferences({ calendarDayMode: value })}>{label}</button>)}</div>}<div className="segmented calendar-zoom" role="group" aria-label="日历缩放">{preferences.calendarView !== "month" && <span className="calendar-zoom-pill" aria-hidden="true"><ChevronsUpDown size={11} />{zoom === "compact" ? "紧凑" : zoom === "detailed" ? "详细" : "标准"}</span>}{([['compact', '紧凑'], ['standard', '标准'], ['detailed', '详细']] as const).map(([value, label]) => <button key={value} aria-pressed={zoom === value} className={zoom === value ? "active" : ""} onClick={() => setZoom(value)}>{label}</button>)}{preferences.calendarView !== "month" && <span className="calendar-zoom-hint" title="按住 Ctrl 滚动滚轮也可以缩放时间轴"><kbd>Ctrl</kbd> + 滚轮</span>}</div>{preferences.calendarView !== "month" && <>{preferences.showActualRecordsControl && <label className="actual-record-toggle"><input type="checkbox" checked={preferences.showActualRecords} onChange={(event) => onPreferences({ showActualRecords: event.target.checked })} />显示实际记录</label>}<Button onClick={() => setBlockForm((value) => !value)}><Clock3 size={16} />时间块</Button><button className={`magnet-control ${preferences.snapMinutes === "off" ? "" : "active"}`} aria-label={preferences.snapMinutes === "off" ? "吸附已关闭" : `吸附 ${preferences.snapMinutes} 分钟`} aria-pressed={preferences.snapMinutes !== "off"} title="拖拽时按 Alt 临时反转吸附" onClick={() => onPreferences({ snapMinutes: preferences.snapMinutes === "off" ? 15 : "off" })}><Magnet size={16} />{preferences.snapMinutes === "off" ? "自由放置" : `吸附 ${preferences.snapMinutes} 分钟`}</button></>}</div></div>
    <div className="time-block-form-slot">{blockForm && <section className="surface-card time-block-form"><label>标题<input autoFocus value={blockTitle} onChange={(event) => setBlockTitle(event.target.value)} placeholder="会议、通勤或休息" /></label><label>日期<input type="date" value={anchor} onChange={(event) => setAnchor(event.target.value)} /></label><label>开始<input type="time" value={blockStart} onChange={(event) => setBlockStart(event.target.value)} /></label><label>结束<input type="time" value={blockEnd} onChange={(event) => setBlockEnd(event.target.value)} /></label><div className="form-actions"><Button onClick={() => setBlockForm(false)}>取消</Button><Button variant="primary" disabled={!blockTitle.trim() || timeMinutes(blockEnd) <= timeMinutes(blockStart)} onClick={async () => { await onCreateBlock({ id: crypto.randomUUID(), title: blockTitle.trim(), localDate: anchor, endLocalDate: anchor, startLocal: blockStart, endLocal: blockEnd, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local", utcOffsetMinutes: -new Date().getTimezoneOffset() }); setBlockTitle(""); setBlockForm(false); }}>创建时间块</Button></div></section>}</div>
    <div className={`calendar-viewport ${preferences.calendarView}-viewport`} role="region" aria-label="日历时间网格" onWheel={zoomWithWheel}>
      {preferences.calendarView === "month" ? <div className={`month-calendar-layout ${selectedCalendarDate ? "with-detail" : ""}`}><MonthCalendar anchor={anchor} workspace={workspace} selectedDate={selectedCalendarDate} focusDate={monthFocusDate ?? anchor} onFocusDate={setMonthFocusDate} onNavigateDate={(date) => { setMonthFocusDate(date); if (!monthDates(anchor).includes(date)) setAnchor(date); }} onSelectDate={(date) => { setSelectedCalendarDate(date); setDetailTaskId(null); setDetailProjectId(null); }} onOpenTask={(date, taskId) => { setSelectedCalendarDate(date); setDetailTaskId(taskId); setDetailProjectId(null); }} onOpenProject={(date, projectId) => { setSelectedCalendarDate(date); setDetailProjectId(projectId); setDetailTaskId(null); }} />{selectedCalendarDate && <CalendarDateDetails date={selectedCalendarDate} workspace={workspace} taskId={detailTaskId} projectId={detailProjectId} onOpenDay={() => onPreferences({ calendarView: "day", calendarAnchors: { ...preferences.calendarAnchors, day: selectedCalendarDate } })} />}</div> : preferences.calendarView === "day" ? <ContinuousDayView anchor={anchor} workspace={workspace} preferences={preferences} now={now} focusSessionId={focusSessionId} onAnchorChange={setAnchor} onSchedule={onSchedule} onCreateTaskAt={onCreateTaskAt} onMove={onMove} onPlace={onPlace} onProgress={onProgress} onSkipReview={onSkipReview} onContinue={setContinuingSession} onCreateBlock={onCreateBlock} onUpdateBlock={onUpdateBlock} onDeleteBlock={onDeleteBlock} onEditSession={setEditingSession} /> : <div className={`week-calendar-layout ${selectedCalendarDate ? "with-detail" : ""}`}><div className="week-calendar-main"><div className="week-sticky-header"><WeekDateHeaders dates={dates} today={toLocalDate(now)} focusDate={weekKeyboardFocus.kind === "header" ? weekKeyboardFocus.date : null} onFocusDate={(date) => setWeekKeyboardFocus((current) => ({ ...current, kind: "header", date }))} onMoveDate={(date) => moveWeekFocus("header", date)} onOpenDate={(date) => onPreferences({ calendarView: "day", calendarAnchors: { ...preferences.calendarAnchors, day: date } })} /><WeekAllDayArea dates={dates} workspace={workspace} onOpenTask={(date, taskId) => { setSelectedCalendarDate(date); setDetailTaskId(taskId); setDetailProjectId(null); }} onOpenProject={(date, projectId) => { setSelectedCalendarDate(date); setDetailProjectId(projectId); setDetailTaskId(null); }} /></div><div className="calendar-grid week week-body">
        <CalendarTimeAxis showHeader={false} />
        {dates.map((date) => <CalendarDay key={date} date={date} workspace={workspace} preferences={preferences} now={now} hideHeader selected={selectedCalendarDate === date} weekGridTabIndex={weekKeyboardFocus.kind === "grid" && weekKeyboardFocus.date === date ? 0 : -1} weekGridMinute={weekKeyboardFocus.minute} onWeekGridFocus={() => setWeekKeyboardFocus((current) => ({ ...current, kind: "grid", date }))} onWeekGridNavigate={(event) => { const snap = preferences.snapMinutes === "off" ? 1 : preferences.snapMinutes; let nextDate = date; let nextMinute = weekKeyboardFocus.minute; if (event.key === "ArrowLeft") nextDate = addDays(date, -1); else if (event.key === "ArrowRight") nextDate = addDays(date, 1); else if (event.key === "ArrowUp") nextMinute = Math.max(0, nextMinute - snap); else if (event.key === "ArrowDown") nextMinute = Math.min(1439, nextMinute + snap); else if (event.key === "PageUp") nextDate = addDays(date, -7); else if (event.key === "PageDown") nextDate = addDays(date, 7); else return; event.preventDefault(); moveWeekFocus("grid", nextDate, nextMinute); calendarRef.current?.querySelector<HTMLElement>(`.calendar-day[data-day-date="${nextDate}"] .day-track`)?.focus(); }} onSchedule={onSchedule} onCreateTaskAt={onCreateTaskAt} onMove={onMove} onPlace={onPlace} onProgress={onProgress} onSkipReview={onSkipReview} onContinue={setContinuingSession} onCreateBlock={onCreateBlock} onUpdateBlock={onUpdateBlock} onDeleteBlock={onDeleteBlock} onEditSession={setEditingSession} />)}
      </div></div>{selectedCalendarDate && <CalendarDateDetails date={selectedCalendarDate} workspace={workspace} taskId={detailTaskId} projectId={detailProjectId} onOpenDay={() => onPreferences({ calendarView: "day", calendarAnchors: { ...preferences.calendarAnchors, day: selectedCalendarDate } })} />}</div>}
    </div>
    {nowDirection && <button className="back-to-now" onClick={returnToNow}>{nowDirection === "up" ? <ArrowUp size={16} /> : <ArrowDown size={16} />}回到现在</button>}
    {editingSession && (() => { const task = workspace.tasks.find((item) => item.id === editingSession.taskId); return task ? <SessionEditDialog session={editingSession} task={task} onClose={() => setEditingSession(null)} onSave={async (date, start, duration) => { await onMove(editingSession, date, start, duration); setEditingSession(null); }} /> : null; })()}
    {continuingSession && (() => { const task = workspace.tasks.find((item) => item.id === continuingSession.taskId); return task ? <ContinueScheduleDialog session={continuingSession} task={task} snapMinutes={preferences.snapMinutes} onClose={() => setContinuingSession(null)} onSave={async (date, start) => { await onSchedule(task, date, start); setContinuingSession(null); }} /> : null; })()}
  </section>;
}

function ContinuousDayView({ anchor, workspace, preferences, now, focusSessionId, onAnchorChange, onSchedule, onCreateTaskAt, onMove, onPlace, onProgress, onSkipReview, onContinue, onCreateBlock, onUpdateBlock, onDeleteBlock, onEditSession }: {
  anchor: string; workspace: WorkspaceSnapshot; preferences: AppSettings; now: Date; focusSessionId: string | null; onAnchorChange: (date: string) => void;
  onSchedule: (task: Task, date: string, start: string) => Promise<void>;
  onCreateTaskAt: (title: string, date: string, start: string, duration: number) => Promise<void>;
  onMove: (session: ExecutionSession, date: string, start: string, duration?: number) => Promise<void>;
  onPlace: (intent: CalendarDropIntent) => Promise<void>;
  onProgress: (task: Task, value: number) => Promise<void>; onSkipReview: (session: ExecutionSession) => Promise<void>; onContinue: (session: ExecutionSession) => void;
  onCreateBlock: (block: TimeBlock) => Promise<void>; onUpdateBlock: (previous: TimeBlock, next: TimeBlock) => Promise<void>; onDeleteBlock: (id: string) => Promise<void>; onEditSession: (session: ExecutionSession) => void;
}) {
  const axisRef = useRef<HTMLDivElement>(null); const pendingScrollOffset = useRef<number | null>(null); const shifting = useRef(false);
  useEffect(() => {
    const axis = axisRef.current; if (!axis) return;
    const panels = Array.from(axis.querySelectorAll<HTMLElement>(".continuous-day-panel"));
    const fallback = axis.scrollHeight / 3;
    const starts = continuousPanelStarts(axis, panels, fallback);
    const middleStart = starts[1];
    axis.scrollTop = middleStart + (pendingScrollOffset.current ?? 0);
    pendingScrollOffset.current = null; shifting.current = false;
  }, [anchor]);
  const onScroll = () => {
    const axis = axisRef.current; if (!axis || shifting.current) return;
    const panels = Array.from(axis.querySelectorAll<HTMLElement>(".continuous-day-panel"));
    const fallback = axis.scrollHeight / 3; if (!fallback) return;
    const [firstStart, middleStart, nextStart] = continuousPanelStarts(axis, panels, fallback);
    if (axis.scrollTop < middleStart) { shifting.current = true; pendingScrollOffset.current = axis.scrollTop - firstStart; onAnchorChange(addDays(anchor, -1)); }
    else if (axis.scrollTop >= nextStart) { shifting.current = true; pendingScrollOffset.current = axis.scrollTop - nextStart; onAnchorChange(addDays(anchor, 1)); }
  };
  return <div ref={axisRef} className="continuous-day-axis" role="region" aria-label="连续日时间轴" onScroll={onScroll}>
    {[addDays(anchor, -1), anchor, addDays(anchor, 1)].map((date) => <section key={date} className="continuous-day-panel" data-calendar-date={date} aria-label={formatLongDate(date)}>
      <div className="continuous-day-separator"><span>{formatLongDate(date)}</span></div>
      <DayCalendarGrid date={date} workspace={workspace} preferences={preferences} now={now} focusSessionId={focusSessionId} onSchedule={onSchedule} onCreateTaskAt={onCreateTaskAt} onMove={onMove} onPlace={onPlace} onProgress={onProgress} onSkipReview={onSkipReview} onContinue={onContinue} onCreateBlock={onCreateBlock} onUpdateBlock={onUpdateBlock} onDeleteBlock={onDeleteBlock} onEditSession={onEditSession} />
    </section>)}
  </div>;
}

function continuousPanelStarts(axis: HTMLElement, panels: HTMLElement[], fallback: number): [number, number, number] {
  const axisTop = axis.getBoundingClientRect().top;
  const measured = panels.map((panel) => panel.getBoundingClientRect().top - axisTop + axis.scrollTop);
  return measured.length === 3 && measured[1] > measured[0] && measured[2] > measured[1]
    ? measured as [number, number, number]
    : [0, fallback, fallback * 2];
}

function DayCalendarGrid({ date, workspace, preferences, now, focusSessionId, onSchedule, onCreateTaskAt, onMove, onPlace, onProgress, onSkipReview, onContinue, onCreateBlock, onUpdateBlock, onDeleteBlock, onEditSession }: {
  date: string; workspace: WorkspaceSnapshot; preferences: AppSettings; now: Date; focusSessionId: string | null;
  onSchedule: (task: Task, date: string, start: string) => Promise<void>;
  onCreateTaskAt: (title: string, date: string, start: string, duration: number) => Promise<void>;
  onMove: (session: ExecutionSession, date: string, start: string, duration?: number) => Promise<void>;
  onPlace: (intent: CalendarDropIntent) => Promise<void>;
  onProgress: (task: Task, value: number) => Promise<void>; onSkipReview: (session: ExecutionSession) => Promise<void>; onContinue: (session: ExecutionSession) => void;
  onCreateBlock: (block: TimeBlock) => Promise<void>; onUpdateBlock: (previous: TimeBlock, next: TimeBlock) => Promise<void>; onDeleteBlock: (id: string) => Promise<void>; onEditSession: (session: ExecutionSession) => void;
}) {
  const [expandedGapKeys, setExpandedGapKeys] = useState<Set<string>>(() => new Set());
  const [dragExpandedGapKey, setDragExpandedGapKey] = useState<string | null>(null);
  const dragHoverTimer = useRef<number | null>(null);
  const weekdayNumber = new Date(`${date}T12:00:00`).getDay();
  const slots = useMemo(() => defaultSlotSlicesForWeekday(preferences.defaultTimeSlots, weekdayNumber), [preferences.defaultTimeSlots, weekdayNumber]);
  const isToday = date === toLocalDate(now);
  const focusedSession = workspace.executionSessions.find((session) => session.id === focusSessionId && session.localDate === date);
  const visibleGapKeys = useMemo(() => { const keys = new Set(expandedGapKeys); if (dragExpandedGapKey) keys.add(dragExpandedGapKey); return keys; }, [dragExpandedGapKey, expandedGapKeys]);
  const currentSessionRanges = useMemo(() => isToday ? workspace.executionSessions
    .filter((session) => session.localDate === date && sessionContains(session, now))
    .map((session) => { const start = timeMinutes(session.startLocal); const end = timeMinutes(session.endLocal); return { start, end: end <= start ? 1440 : end }; }) : [], [date, isToday, now, workspace.executionSessions]);
  const focusedSessionRanges = useMemo(() => focusedSession ? (() => { const start = timeMinutes(focusedSession.startLocal); const end = timeMinutes(focusedSession.endLocal); return [{ start, end: end <= start ? 1440 : end }]; })() : [], [focusedSession]);
  const timeline = useMemo(() => createCalendarTimeline({
    mode: preferences.calendarDayMode,
    slots,
    expandedGapKeys: visibleGapKeys,
    currentMinute: preferences.calendarDayMode === "defaultSlots" && isToday ? now.getHours() * 60 + now.getMinutes() : null,
    revealedRanges: [...currentSessionRanges, ...focusedSessionRanges],
    pixelsPerHour: preferences.calendarScale.day,
  }), [currentSessionRanges, focusedSessionRanges, isToday, now, preferences.calendarDayMode, preferences.calendarScale.day, slots, visibleGapKeys]);
  const activeTimeline = preferences.calendarDayMode === "defaultSlots" ? timeline : undefined;
  const toggleGap = (key: string) => setExpandedGapKeys((current) => {
    const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next;
  });
  const cancelDragHoverTimer = useCallback(() => { if (dragHoverTimer.current !== null) window.clearTimeout(dragHoverTimer.current); dragHoverTimer.current = null; }, []);
  const clearDragExpansion = useCallback(() => { cancelDragHoverTimer(); setDragExpandedGapKey(null); }, [cancelDragHoverTimer]);
  useEffect(() => { window.addEventListener("dragend", clearDragExpansion); return () => { window.removeEventListener("dragend", clearDragExpansion); cancelDragHoverTimer(); }; }, [cancelDragHoverTimer, clearDragExpansion]);
  const beginGapHover = (key: string) => { if (dragHoverTimer.current !== null || dragExpandedGapKey === key) return; dragHoverTimer.current = window.setTimeout(() => { dragHoverTimer.current = null; setDragExpandedGapKey(key); }, 500); };
  const leaveGapHover = () => { if (dragHoverTimer.current !== null) { window.clearTimeout(dragHoverTimer.current); dragHoverTimer.current = null; } };
  const retainDragExpansion = () => { if (!dragExpandedGapKey) return; setExpandedGapKeys((current) => new Set(current).add(dragExpandedGapKey)); setDragExpandedGapKey(null); };
  useEffect(() => { if (!focusedSession) return; const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>(`.calendar-session[data-session-id="${focusedSession.id}"]`)?.scrollIntoView?.({ behavior: "smooth", block: "center" })); return () => cancelAnimationFrame(frame); }, [focusedSession]);
  return <div className="calendar-grid day" style={activeTimeline ? { height: `${52 + activeTimeline.totalHeight}px` } : undefined}><CalendarTimeAxis timeline={activeTimeline} /><CalendarDay date={date} workspace={workspace} preferences={preferences} now={now} timeline={activeTimeline} expandedGapKeys={expandedGapKeys} dragExpandedGapKey={dragExpandedGapKey} focusSessionId={focusSessionId} onToggleGap={toggleGap} onGapDragEnter={beginGapHover} onGapDragLeave={leaveGapHover} onClearDragExpansion={clearDragExpansion} onRetainDragExpansion={retainDragExpansion} onSchedule={onSchedule} onCreateTaskAt={onCreateTaskAt} onMove={onMove} onPlace={onPlace} onProgress={onProgress} onSkipReview={onSkipReview} onContinue={onContinue} onCreateBlock={onCreateBlock} onUpdateBlock={onUpdateBlock} onDeleteBlock={onDeleteBlock} onEditSession={onEditSession} /></div>;
}

function CalendarTimeAxis({ timeline, showHeader = true }: { timeline?: CalendarTimeline; showHeader?: boolean }) {
  return <div className={`time-axis ${showHeader ? "" : "without-header"}`.trim()}>{showHeader && <div className="day-head-spacer" />}<div className="time-axis-track" style={timeline ? { height: `${timeline.totalHeight}px` } : undefined}>{Array.from({ length: 24 }, (_, hour) => {
    const minute = hour * 60; const segment = timeline?.segments.find((item) => minute >= item.start && minute < item.end);
    if (segment?.collapsed) return null;
    return <span key={hour} style={{ top: timeline ? `${timeline.offsetAtMinute(minute)}px` : `${hour / 24 * 100}%` }}>{String(hour).padStart(2, "0")}:00</span>;
  })}</div></div>;
}

function MonthCalendar({ anchor, workspace, selectedDate, focusDate, onFocusDate, onNavigateDate, onSelectDate, onOpenTask, onOpenProject }: { anchor: string; workspace: WorkspaceSnapshot; selectedDate: string | null; focusDate: string; onFocusDate: (date: string) => void; onNavigateDate: (date: string) => void; onSelectDate: (date: string) => void; onOpenTask: (date: string, taskId: string) => void; onOpenProject: (date: string, projectId: string) => void }) {
  const dates = monthDates(anchor); const month = anchor.slice(0, 7); const today = toLocalDate(new Date());
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const frame = requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-month-date="${focusDate}"]`)?.focus()); return () => cancelAnimationFrame(frame); }, [anchor, focusDate]);
  const keyDown = (event: React.KeyboardEvent<HTMLElement>, date: string) => {
    let next: string | null = null;
    if (event.key === "ArrowLeft") next = addDays(date, -1);
    else if (event.key === "ArrowRight") next = addDays(date, 1);
    else if (event.key === "ArrowUp") next = addDays(date, -7);
    else if (event.key === "ArrowDown") next = addDays(date, 7);
    else if (event.key === "Home") next = addDays(date, -(new Date(`${date}T12:00:00`).getDay() + 6) % 7);
    else if (event.key === "End") next = addDays(date, 6 - (new Date(`${date}T12:00:00`).getDay() + 6) % 7);
    else if (event.key === "PageUp") next = addMonths(date, -1);
    else if (event.key === "PageDown") next = addMonths(date, 1);
    else if (event.key === "Enter") { event.preventDefault(); onSelectDate(date); return; }
    if (!next) return; event.preventDefault(); onNavigateDate(next);
    gridRef.current?.querySelector<HTMLElement>(`[data-month-date="${next}"]`)?.focus();
  };
  return <div ref={gridRef} className="month-calendar" role="grid" aria-label="月历">
    {(["一", "二", "三", "四", "五", "六", "日"] as const).map((day) => <div key={day} role="columnheader" aria-label={`周${day}`}>周{day}</div>)}
    {dates.map((date) => { const summary = calendarDaySummary(workspace, date, today); return <div key={date} role="gridcell" data-month-date={date} tabIndex={date === focusDate ? 0 : -1} className={`${date.startsWith(month) ? "" : "adjacent-month"} ${date === today ? "today" : ""} ${date === selectedDate ? "selected" : ""}`.trim()} aria-label={`${date} ${formatLongDate(date)}`} aria-selected={date === selectedDate} onFocus={() => onFocusDate(date)} onKeyDown={(event) => keyDown(event, date)} onClick={() => onSelectDate(date)}><header><span>{Number(date.slice(-2))}</span>{date === today && <small>今天</small>}</header><div className="month-cell-summary">{summary.visible.map((item) => item.taskId ? <button key={item.id} className={`month-summary-item ${item.kind} urgency-${item.urgency}`} aria-label={`${deadlineUrgencyLabel(item.urgency!)}：${item.label}`} onClick={(event) => { event.stopPropagation(); onOpenTask(date, item.taskId!); }}><Flag size={11} aria-hidden="true" /><span>{item.urgency !== "later" && `${deadlineUrgencyLabel(item.urgency!)} · `}{item.label}</span></button> : item.projectId ? <button key={item.id} className={`month-summary-item ${item.kind} ${item.kind === "milestone" ? "milestone-marker" : ""}`} aria-label={item.kind === "milestone" ? `里程碑：${item.label}` : `${deadlineUrgencyLabel(item.urgency!)}：项目截止 ${item.label}`} onClick={(event) => { event.stopPropagation(); onOpenProject(date, item.projectId!); }}>{item.kind === "milestone" ? <Diamond size={11} aria-hidden="true" /> : <Flag size={11} aria-hidden="true" />}<span>{item.label}</span></button> : <span key={item.id} className={`month-summary-item ${item.kind}`}>{item.label}</span>)}{summary.overflowCount > 0 && <button className="month-summary-overflow" onClick={(event) => { event.stopPropagation(); onSelectDate(date); }}>另外 {summary.overflowCount} 项</button>}</div></div>; })}
  </div>;
}

function WeekDateHeaders({ dates, today, focusDate, onFocusDate, onMoveDate, onOpenDate }: { dates: string[]; today: string; focusDate: string | null; onFocusDate: (date: string) => void; onMoveDate: (date: string) => void; onOpenDate: (date: string) => void }) {
  const keyDown = (event: React.KeyboardEvent<HTMLButtonElement>, date: string) => {
    if (event.key === "Enter") { event.preventDefault(); onOpenDate(date); return; }
    const next = event.key === "ArrowLeft" ? addDays(date, -1) : event.key === "ArrowRight" ? addDays(date, 1) : event.key === "PageUp" ? addDays(date, -7) : event.key === "PageDown" ? addDays(date, 7) : null;
    if (!next) return;
    event.preventDefault(); onMoveDate(next);
    event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-week-header="${next}"]`)?.focus();
  };
  return <div className="week-date-headers" aria-label="周日期头"><div className="week-date-spacer" aria-hidden="true" />{dates.map((date) => <button key={date} data-week-header={date} tabIndex={date === focusDate ? 0 : -1} aria-label={`打开 ${date} ${formatLongDate(date)} 日视图`} onFocus={() => onFocusDate(date)} onKeyDown={(event) => keyDown(event, date)} onClick={() => onOpenDate(date)}><strong>{date === today ? "今天" : weekday(date)}</strong><span className={date === today ? "today-number" : ""}>{Number(date.slice(-2))}</span></button>)}</div>;
}

function WeekAllDayArea({ dates, workspace, onOpenTask, onOpenProject }: { dates: string[]; workspace: WorkspaceSnapshot; onOpenTask: (date: string, taskId: string) => void; onOpenProject: (date: string, projectId: string) => void }) {
  const [open, setOpen] = useState(true); const [expandedDates, setExpandedDates] = useState<Set<string>>(() => new Set());
  const today = toLocalDate(new Date());
  return <section className={`week-all-day ${open ? "open" : "collapsed"}`} aria-label="全天标记"><div className="week-all-day-label"><span>全天</span><button aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? "收起" : "展开"}</button></div>{open && dates.map((date) => { const markers = calendarDayMarkers(workspace, date, today); const visible = expandedDates.has(date) ? markers : markers.slice(0, 2); return <div key={date} className="week-all-day-cell" data-all-day-date={date}>{visible.map((marker) => { const urgency = marker.urgency; return <button key={marker.id} className={`urgency-${urgency} ${marker.kind === "milestone" ? "milestone-marker" : marker.kind === "projectDeadline" ? "project-deadline-marker" : ""}`} data-all-day-marker data-marker-kind={marker.kind} aria-label={marker.kind === "milestone" ? `里程碑：${marker.label}` : marker.kind === "projectDeadline" ? `${deadlineUrgencyLabel(urgency)}：项目截止 ${marker.label}` : `${deadlineUrgencyLabel(urgency)}：${marker.label}`} onClick={() => { if (marker.kind === "milestone" && marker.projectId) onOpenProject(date, marker.projectId); else if (marker.kind === "projectDeadline" && marker.projectId) onOpenProject(date, marker.projectId); else if (marker.taskId) onOpenTask(date, marker.taskId); }}>{marker.kind === "milestone" ? <Diamond size={11} aria-hidden="true" /> : <Flag size={11} aria-hidden="true" />}<span>{marker.kind === "milestone" ? marker.label : marker.kind === "projectDeadline" ? `项目截止 · ${marker.label}` : `${urgency !== "later" && `${deadlineUrgencyLabel(urgency)} · `}${marker.label}`}</span></button>; })}{markers.length > 2 && <button className="week-all-day-overflow" aria-expanded={expandedDates.has(date)} onClick={() => setExpandedDates((current) => { const next = new Set(current); if (next.has(date)) next.delete(date); else next.add(date); return next; })}>{expandedDates.has(date) ? "收起" : `另外 ${markers.length - 2} 项`}</button>}</div>; })}</section>;
}

function CalendarDateDetails({ date, workspace, taskId, projectId, onOpenDay }: { date: string; workspace: WorkspaceSnapshot; taskId: string | null; projectId: string | null; onOpenDay: () => void }) {
  const summary = calendarDaySummary(workspace, date); const task = taskId ? workspace.tasks.find((item) => item.id === taskId) ?? null : null;
  const project = projectId ? workspace.projects.find((item) => item.id === projectId) ?? null : null;
  const sessions = workspace.executionSessions.filter((session) => session.localDate === date && session.status !== "cancelled").sort(compareSessions);
  const blocks = workspace.timeBlocks.filter((block) => block.localDate === date).sort((left, right) => left.startLocal.localeCompare(right.startLocal));
  return <aside className="calendar-date-details" aria-label={`${date} ${formatLongDate(date)}详情`}><header><div><span className="eyebrow">已选日期</span><h2>{formatLongDate(date)}</h2></div><Button onClick={onOpenDay}>打开日视图</Button></header>{task ? <section className="calendar-task-detail"><span className="eyebrow">截止任务</span><h3>{task.title}</h3><p>{workspace.projects.find((project) => project.id === task.projectId)?.title ?? "独立任务"} · 当前进度 {task.progress}%</p><span className="deadline-chip">截止 {date}</span></section> : project ? <section className="calendar-project-detail"><span className="eyebrow">项目</span><h3>{project.title}</h3>{project.deadlineLocal ? <ProjectDeadlineChip deadline={project.deadlineLocal} today={date} /> : <p>没有设置项目截止日期。</p>}<div className="calendar-project-milestones">{workspace.projectMilestones.filter((milestone) => milestone.projectId === project.id).sort((a, b) => a.targetLocalDate.localeCompare(b.targetLocalDate) || a.sortOrder - b.sortOrder).map((milestone) => <article key={milestone.id} className={milestone.targetLocalDate === date ? "on-date" : ""}><Diamond size={14} aria-hidden="true" /><div><strong>{milestone.title}</strong><span>{milestone.targetLocalDate === date ? "今天到期" : `${formatShortDate(milestone.targetLocalDate)} 到期`} · {milestoneSummary(milestone, workspace.tasks.filter((item) => item.projectId === project.id))}</span></div></article>)}{workspace.projectMilestones.some((milestone) => milestone.projectId === project.id) || <p className="empty-inline">该项目还没有里程碑。</p>}</div></section> : <><section><h3>重要事实</h3>{summary.deadlines.map((item) => <article key={item.id}><Flag size={14} /><div><strong>{item.title}</strong><span>任务截止 · {item.progress}%</span></div></article>)}{summary.projectDeadlines.map((item) => <article key={`project-${item.id}`}><Flag size={14} /><div><strong>{item.title}</strong><span>项目截止</span></div></article>)}{summary.milestones.map((item) => <article key={`milestone-${item.id}`}><Diamond size={14} /><div><strong>{item.title}</strong><span>里程碑到期</span></div></article>)}{summary.completedTasks.map((item) => <article key={`done-${item.id}`}><Check size={14} /><div><strong>{item.title}</strong><span>当天完成</span></div></article>)}{summary.progressedTasks.map((item) => <article key={`progress-${item.id}`}><ArrowUp size={14} /><div><strong>{item.title}</strong><span>当天推进</span></div></article>)}{summary.missedTasks.map((item) => <article key={`missed-${item.id}`}><Ban size={14} /><div><strong>{item.title}</strong><span>本次未推进</span></div></article>)}{summary.deadlines.length + summary.projectDeadlines.length + summary.milestones.length + summary.completedTasks.length + summary.progressedTasks.length + summary.missedTasks.length === 0 && <p className="empty-inline">当天没有截止、完成或推进事实。</p>}</section><section><h3>当天安排</h3>{sessions.map((session) => <article key={session.id}><Clock3 size={14} /><div><strong>{taskTitle(workspace, session.taskId)}</strong><span>{session.startLocal}–{session.endLocal}</span></div></article>)}{blocks.map((block) => <article key={block.id}><Clock3 size={14} /><div><strong>{block.title}</strong><span>{block.startLocal}–{block.endLocal} · 时间块</span></div></article>)}{sessions.length + blocks.length === 0 && <p className="empty-inline">当天没有执行时段或时间块。</p>}</section></>}</aside>;
}

function CalendarDay({ date, workspace, preferences, now, timeline, expandedGapKeys, dragExpandedGapKey, focusSessionId, onToggleGap, onGapDragEnter, onGapDragLeave, onClearDragExpansion, onRetainDragExpansion, hideHeader = false, selected = false, weekGridTabIndex, weekGridMinute, onWeekGridFocus, onWeekGridNavigate, onSchedule, onCreateTaskAt, onMove, onPlace, onProgress, onSkipReview, onContinue, onCreateBlock, onUpdateBlock, onDeleteBlock, onEditSession }: {
  date: string; workspace: WorkspaceSnapshot; preferences: AppSettings; now: Date;
  timeline?: CalendarTimeline; expandedGapKeys?: ReadonlySet<string>; dragExpandedGapKey?: string | null; focusSessionId?: string | null; onToggleGap?: (key: string) => void; onGapDragEnter?: (key: string) => void; onGapDragLeave?: () => void; onClearDragExpansion?: () => void; onRetainDragExpansion?: () => void;
  hideHeader?: boolean; selected?: boolean; weekGridTabIndex?: number; weekGridMinute?: number; onWeekGridFocus?: () => void; onWeekGridNavigate?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onSchedule: (task: Task, date: string, start: string) => Promise<void>;
  onCreateTaskAt: (title: string, date: string, start: string, duration: number) => Promise<void>;
  onMove: (session: ExecutionSession, date: string, start: string, duration?: number) => Promise<void>;
  onPlace: (intent: CalendarDropIntent) => Promise<void>;
  onProgress: (task: Task, value: number) => Promise<void>; onSkipReview: (session: ExecutionSession) => Promise<void>; onContinue: (session: ExecutionSession) => void;
  onCreateBlock: (block: TimeBlock) => Promise<void>; onUpdateBlock: (previous: TimeBlock, next: TimeBlock) => Promise<void>; onDeleteBlock: (id: string) => Promise<void>;
  onEditSession: (session: ExecutionSession) => void;
}) {
  const [dragPreview, setDragPreview] = useState<null | { taskId: string; sessionId: string; startMinute: number; duration: number; title: string; mode: CalendarDropMode; targetSessionId: string; pointerOffsetPx: number }>(null);
  const overlapTimer = useRef<number | null>(null); const overlapTarget = useRef("");
  const [expandedConcurrency, setExpandedConcurrency] = useState<string | null>(null);
  const [blankHoverMinute, setBlankHoverMinute] = useState<number | null>(null);
  const [blankRange, setBlankRange] = useState<{ start: number; end: number } | null>(null);
  const [blankAction, setBlankAction] = useState<"menu" | "new" | "pool" | "block" | null>(null);
  const [blankTitle, setBlankTitle] = useState(""); const blankSelectionStart = useRef<number | null>(null); const blankBubbleRef = useRef<HTMLElement>(null);
  const sessions = workspace.executionSessions.filter((item) => item.localDate === date && (item.status === "scheduled" || item.status === "missed"));
  const concurrency = concurrentLayouts(sessions);
  const blocks = workspace.timeBlocks.filter((item) => item.localDate === date);
  const defaultSlots = defaultSlotSlicesForWeekday(preferences.defaultTimeSlots, new Date(`${date}T12:00:00`).getDay());
  const isToday = date === toLocalDate(now); const nowMinute = now.getHours() * 60 + now.getMinutes();
  const actualRecords = preferences.showActualRecords ? workspace.executionRecords.flatMap((record) => {
    const slice = actualRecordSlice(record, date, now); return slice ? [{ record, ...slice }] : [];
  }) : [];
  useEffect(() => {
    const clear = () => { setDragPreview(null); if (overlapTimer.current !== null) window.clearTimeout(overlapTimer.current); overlapTimer.current = null; overlapTarget.current = ""; };
    window.addEventListener("dragend", clear);
    return () => { window.removeEventListener("dragend", clear); clear(); };
  }, []);
  useEffect(() => {
    if (!blankAction) return;
    const close = (event: PointerEvent) => { if (!blankBubbleRef.current?.contains(event.target as Node)) { setBlankAction(null); setBlankRange(null); } };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setBlankAction(null); setBlankRange(null); } };
    window.addEventListener("pointerdown", close); window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape); };
  }, [blankAction]);
  const minuteAtPointer = (clientY: number, track: HTMLDivElement) => {
    const rect = track.getBoundingClientRect(); if (!rect.height) return 0;
    const raw = timeline ? timeline.minuteAtOffset(clientY - rect.top) : ((clientY - rect.top) / rect.height) * 1440;
    const snap = preferences.snapMinutes === "off" ? 1 : preferences.snapMinutes;
    return Math.max(0, Math.min(1439, Math.round(raw / snap) * snap));
  };
  const pointsAtBlankTrack = (target: EventTarget | null) => !(target as HTMLElement | null)?.closest("button, input, .calendar-session, .calendar-time-block, .calendar-actual-record, .blank-action-bubble, .resize-handle, .session-edit-button");
  const previewFromDrag = (event: DragEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.height) return null;
    const pointerOffsetPx = Math.max(0, event.clientY - rect.top);
    const raw = timeline ? timeline.minuteAtOffset(pointerOffsetPx) : (pointerOffsetPx / rect.height) * 1440;
    const configuredSnap = preferences.snapMinutes === "off" ? 1 : preferences.snapMinutes;
    const snap = event.altKey ? (preferences.snapMinutes === "off" ? 15 : 1) : configuredSnap;
    const taskId = event.dataTransfer.getData("application/x-daymark-task");
    const sessionId = event.dataTransfer.getData("application/x-daymark-session");
    const task = workspace.tasks.find((item) => item.id === taskId);
    const session = workspace.executionSessions.find((item) => item.id === sessionId);
    if (!task && !session) return null;
    const sourceTask = task ?? workspace.tasks.find((item) => item.id === session?.taskId);
    const duration = session ? sessionDuration(session) : Math.max(5, task?.sessionMinutes ?? task?.estimatedMinutes ?? 60);
    let startMinute = Math.max(0, Math.min(1439, Math.round(raw / snap) * snap));
    let mode: CalendarDropMode = "place"; let targetSessionId = "";
    const targetCard = (event.target as HTMLElement | null)?.closest<HTMLElement>(".calendar-session:not(.calendar-drag-preview)");
    const target = sessions.find((item) => item.id === targetCard?.dataset.sessionId && item.id !== sessionId);
    if (target && targetCard) {
      targetSessionId = target.id;
      const targetRect = targetCard.getBoundingClientRect(); const ratio = targetRect.height ? (event.clientY - targetRect.top) / targetRect.height : .5;
      if (ratio < .25) { mode = "insert-before"; startMinute = timeMinutes(target.startLocal); }
      else if (ratio > .75) { mode = "insert-after"; startMinute = timeMinutes(target.startLocal) + sessionDuration(target); }
      else if (dragPreview?.mode === "overlap" && dragPreview.targetSessionId === target.id) { mode = "overlap"; startMinute = timeMinutes(target.startLocal); }
      if (ratio >= .25 && ratio <= .75 && overlapTarget.current !== target.id) {
        if (overlapTimer.current !== null) window.clearTimeout(overlapTimer.current);
        overlapTarget.current = target.id;
        overlapTimer.current = window.setTimeout(() => { setDragPreview((current) => current && current.targetSessionId === target.id ? { ...current, mode: "overlap", startMinute: timeMinutes(target.startLocal) } : current); overlapTimer.current = null; }, 500);
      } else if (ratio < .25 || ratio > .75) {
        if (overlapTimer.current !== null) window.clearTimeout(overlapTimer.current); overlapTimer.current = null; overlapTarget.current = "";
      }
    } else if (overlapTimer.current !== null) {
      window.clearTimeout(overlapTimer.current); overlapTimer.current = null; overlapTarget.current = "";
    }
    return { taskId, sessionId, startMinute, duration, title: sourceTask?.title ?? "未命名任务", mode, targetSessionId, pointerOffsetPx };
  };
  const heading = <><strong>{isToday ? "今天" : weekday(date)}</strong><span className={isToday ? "today-number" : ""}>{Number(date.slice(-2))}</span></>;
  const dayClasses = ["calendar-day", isToday ? "today" : "", hideHeader ? "without-header" : "", selected ? "selected" : ""].filter(Boolean).join(" ");
  return <div className={dayClasses} data-day-date={date}>{!hideHeader && <header>{heading}</header>}
    <div className={timeline ? "day-track folded-timeline" : "day-track"} role={onWeekGridNavigate ? "gridcell" : undefined} tabIndex={weekGridTabIndex} aria-label={onWeekGridNavigate ? `${date} ${minutesTime(weekGridMinute ?? 540)} 空白时间` : undefined} aria-selected={onWeekGridNavigate ? selected : undefined} onFocus={(event) => { if (event.target === event.currentTarget) onWeekGridFocus?.(); }} onKeyDown={(event) => { if (event.target !== event.currentTarget || !onWeekGridNavigate) return; if (event.key === "Enter") { event.preventDefault(); const start = weekGridMinute ?? 540; setBlankRange({ start, end: Math.min(1440, start + 30) }); setBlankAction("menu"); return; } onWeekGridNavigate(event); }} style={timeline ? { height: `${timeline.totalHeight}px` } : undefined}
      onPointerDown={(event) => { if (event.button !== 0 || !pointsAtBlankTrack(event.target)) return; const minute = minuteAtPointer(event.clientY, event.currentTarget); blankSelectionStart.current = minute; setBlankRange({ start: minute, end: minute + 5 }); setBlankAction(null); try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* synthetic pointers need no capture */ } }}
      onPointerMove={(event) => { if (event.buttons !== 0) { if (blankSelectionStart.current === null) { setBlankHoverMinute(null); } return; } if (!pointsAtBlankTrack(event.target)) { if (blankSelectionStart.current === null) setBlankHoverMinute(null); return; } const minute = minuteAtPointer(event.clientY, event.currentTarget); if (blankSelectionStart.current === null) setBlankHoverMinute(minute); else { const start = Math.min(blankSelectionStart.current, minute); const end = Math.max(blankSelectionStart.current, minute, start + 5); setBlankRange({ start, end }); } }}
      onPointerUp={(event) => { if (blankSelectionStart.current === null) return; const origin = blankSelectionStart.current; const minute = minuteAtPointer(event.clientY, event.currentTarget); const start = Math.min(origin, minute); const end = minute === origin ? origin + 30 : Math.max(origin, minute, start + 5); blankSelectionStart.current = null; setBlankRange({ start, end: Math.min(1440, end) }); setBlankAction("menu"); try { if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ } }}
      onPointerLeave={() => { if (blankSelectionStart.current === null) setBlankHoverMinute(null); }}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = Array.from(event.dataTransfer.types ?? []).includes("application/x-daymark-session") ? "move" : "copy"; setDragPreview(previewFromDrag(event)); const scroller = event.currentTarget.closest<HTMLElement>(".continuous-day-axis, .calendar-viewport"); const rect = scroller?.getBoundingClientRect(); if (scroller && rect) { const edge = 56; if (event.clientY < rect.top + edge) scroller.scrollTop -= Math.ceil((rect.top + edge - event.clientY) / 4); else if (event.clientY > rect.bottom - edge) scroller.scrollTop += Math.ceil((event.clientY - (rect.bottom - edge)) / 4); } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setDragPreview(null); if (overlapTimer.current !== null) window.clearTimeout(overlapTimer.current); overlapTimer.current = null; overlapTarget.current = ""; } }} onDrop={(event) => {
      event.preventDefault();
      const preview = previewFromDrag(event) ?? dragPreview;
      if (!preview) { onClearDragExpansion?.(); return; }
      if (preview.mode === "place" && preview.targetSessionId) { setDragPreview(null); onClearDragExpansion?.(); return; }
      setDragPreview(null);
      void onPlace({ date, startMinute: preview.startMinute, taskId: preview.taskId, sessionId: preview.sessionId, mode: preview.mode, targetSessionId: preview.targetSessionId }).then(() => onRetainDragExpansion?.()).catch(() => onClearDragExpansion?.());
    }}>
      {timeline?.segments.map((segment) => <i key={`map-${segment.start}-${segment.end}`} aria-hidden="true" className="timeline-map-segment" data-start-minute={segment.start} data-end-minute={segment.end} style={{ top: `${segment.top}px`, height: `${segment.height}px` }} />)}
      {Array.from({ length: 24 }, (_, hour) => { const minute = hour * 60; const segment = timeline?.segments.find((item) => minute >= item.start && minute < item.end); return segment?.collapsed ? null : <div key={hour} className="hour-line" style={{ top: timeline ? `${timeline.offsetAtMinute(minute)}px` : `${hour / 24 * 100}%` }} />; })}
      {timeline?.segments.filter((segment) => segment.collapsed).map((segment) => { const count = [...sessions, ...blocks].filter((item) => rangeOverlaps(item.startLocal, item.endLocal, segment.start, segment.end)).length; return <button key={`${segment.start}-${segment.end}`} className="collapsed-time-gap" aria-label={`${boundaryTime(segment.start)}–${boundaryTime(segment.end)} · ${count} 项安排`} style={{ top: `${segment.top}px`, height: `${segment.height}px` }} onClick={() => segment.gapKey && onToggleGap?.(segment.gapKey)} onDragEnter={() => segment.gapKey && onGapDragEnter?.(segment.gapKey)} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onGapDragLeave?.(); }} onDragOver={(event) => event.preventDefault()}>{boundaryTime(segment.start)}–{boundaryTime(segment.end)}<span>{count} 项安排</span></button>; })}
      {dragExpandedGapKey && timeline && (() => { const gap = timelineRangeFromKey(dragExpandedGapKey); return gap ? <div aria-hidden="true" className="drag-expanded-region" style={{ top: `${timeline.offsetAtMinute(gap.start)}px`, height: `${timeline.offsetAtMinute(gap.end) - timeline.offsetAtMinute(gap.start)}px` }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onClearDragExpansion?.(); }} /> : null; })()}
      {[...(expandedGapKeys ?? [])].map((key) => { const gap = timelineRangeFromKey(key); return gap && timeline ? <button key={key} className="expanded-gap-toggle" aria-label={`收起 ${boundaryTime(gap.start)}–${boundaryTime(gap.end)}`} style={{ top: `${timeline.offsetAtMinute(gap.start)}px` }} onClick={() => onToggleGap?.(key)}>收起非默认时段</button> : null; })}
      {isToday && <><div className="calendar-past-region" aria-hidden="true" style={timeline ? { height: `${timeline.offsetAtMinute(nowMinute)}px` } : { height: `${nowMinute / 1440 * 100}%` }} /><div className="calendar-now-line" data-now-marker style={timeline ? { top: `${timeline.offsetAtMinute(nowMinute)}px` } : { top: `${nowMinute / 1440 * 100}%` }}><time>{formatLocalClock(now)}</time></div></>}
      {defaultSlots.map((slot) => { const style = timeline ? timeline.positionForRange(slot.start, slot.end) : positionStyle(slot.start, slot.end); return style ? <div key={slot.id} className="default-slot" style={style}><span>{slot.label}</span></div> : null; })}
      {blankHoverMinute !== null && !blankRange && !dragPreview && <div className="blank-hover-cue" aria-hidden="true" style={{ top: timeline ? `${timeline.offsetAtMinute(blankHoverMinute)}px` : `${blankHoverMinute / 1440 * 100}%` }}><Plus size={14} /><time>{minutesTime(blankHoverMinute)}</time></div>}
      {blankRange && <div className="blank-range-preview" aria-label={`已选择 ${minutesTime(blankRange.start)} 至 ${minutesTime(blankRange.end % 1440)}`} style={timeline ? { top: `${timeline.offsetAtMinute(blankRange.start)}px`, height: `${Math.max(6, timeline.offsetAtMinute(blankRange.end) - timeline.offsetAtMinute(blankRange.start))}px` } : { top: `${blankRange.start / 1440 * 100}%`, height: `${(blankRange.end - blankRange.start) / 1440 * 100}%` }} />}
      {blankRange && blankAction && <section ref={blankBubbleRef} className="blank-action-bubble" role="dialog" aria-label="空白时段操作" style={{ top: timeline ? `${timeline.offsetAtMinute(blankRange.start)}px` : `${blankRange.start / 1440 * 100}%` }} onPointerDown={(event) => event.stopPropagation()}>
        <header><strong>{minutesTime(blankRange.start)}–{minutesTime(blankRange.end % 1440)}</strong><button aria-label="关闭空白时段操作" onClick={() => { setBlankAction(null); setBlankRange(null); }}><X size={13} /></button></header>
        {blankAction === "menu" && <div className="blank-action-menu"><button className="is-primary" onClick={() => setBlankAction("new")}><Plus size={14} aria-hidden="true" /><span>新建任务</span></button><button onClick={() => setBlankAction("pool")}><Inbox size={14} aria-hidden="true" /><span>从任务池安排</span></button><button onClick={() => setBlankAction("block")}><Clock3 size={14} aria-hidden="true" /><span>时间块</span></button></div>}
        {(blankAction === "new" || blankAction === "block") && <div className="blank-inline-form"><label>{blankAction === "new" ? "任务标题" : "时间块标题"}<input autoFocus value={blankTitle} onChange={(event) => setBlankTitle(event.target.value)} /></label><div><button className="button-quiet" onClick={() => setBlankAction("menu")}>返回</button><button className="button-primary" disabled={!blankTitle.trim()} onClick={() => { const title = blankTitle.trim(); const start = minutesTime(blankRange.start); const duration = blankRange.end - blankRange.start; const action = blankAction === "new" ? onCreateTaskAt(title, date, start, duration) : onCreateBlock({ id: crypto.randomUUID(), title, localDate: date, endLocalDate: placementDateTime(date, blankRange.end).date, startLocal: start, endLocal: minutesTime(blankRange.end % 1440), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local", utcOffsetMinutes: -new Date().getTimezoneOffset() }); void action.then(() => { setBlankTitle(""); setBlankAction(null); setBlankRange(null); }); }}>创建</button></div></div>}
        {blankAction === "pool" && <div className="blank-task-picker">{workspace.tasks.filter((task) => task.status === "active" && task.kind !== "habit").map((task) => <button key={task.id} onClick={() => { void onSchedule(task, date, minutesTime(blankRange.start)).then(() => { setBlankAction(null); setBlankRange(null); }); }}><span className="blank-task-icon" aria-hidden="true"><Inbox size={14} /></span><span className="blank-task-text"><strong>{task.title}</strong><small>{task.sessionMinutes ?? task.estimatedMinutes ?? 60} 分钟</small></span></button>)}{!workspace.tasks.some((task) => task.status === "active" && task.kind !== "habit") && <span className="empty-inline">任务池暂无可安排任务</span>}</div>}
      </section>}
      {dragPreview && (() => {
        const start = minutesTime(dragPreview.startMinute % 1440); const end = minutesTime((dragPreview.startMinute + dragPreview.duration) % 1440);
        const pixelsPerMinute = timeline ? timeline.totalHeight / 1440 : null;
        // place / overlap 模式：drag preview 顶部 = 鼠标精确像素 offset（保证落点对齐手感）
        // insert-before / insert-after 模式：精确锚到目标 session 边界
        const placeHeightPx = dragPreview.duration * (pixelsPerMinute ?? 0);
        const previewTopPx = (dragPreview.mode === "insert-before" || dragPreview.mode === "insert-after")
          ? (timeline ? timeline.offsetAtMinute(dragPreview.startMinute) : dragPreview.startMinute / 1440 * 100)
          : dragPreview.pointerOffsetPx;
        const style = (dragPreview.mode === "insert-before" || dragPreview.mode === "insert-after")
          ? (timeline ? timeline.positionForRange(start, end) : positionStyle(start, end))
          : (timeline
              ? { top: `${previewTopPx}px`, height: `${placeHeightPx}px` }
              : { top: `${previewTopPx}%`, height: `${dragPreview.duration / 1440 * 100}%` });
        const label = dragPreview.mode === "insert-before" || dragPreview.mode === "insert-after" ? "插入并后移" : dragPreview.mode === "overlap" ? "同时安排" : dragPreview.targetSessionId ? "悬停 0.5 秒以同时安排" : "松开放置";
        const shifted = dragPreview.mode === "insert-before" || dragPreview.mode === "insert-after" ? insertionChanges(sessions, dragPreview.sessionId, dragPreview.targetSessionId, dragPreview.mode === "insert-before" ? "before" : "after", dragPreview.duration) : [];
        return <>{style && <article className={`calendar-drag-preview ${dragPreview.mode}`} role="status" aria-label="拖拽排程预览" style={style}><span>{label}</span></article>}{(dragPreview.mode === "insert-before" || dragPreview.mode === "insert-after") && <div className="calendar-insert-line" aria-label="插入位置" style={{ top: timeline ? `${timeline.offsetAtMinute(dragPreview.startMinute)}px` : `${dragPreview.startMinute / 1440 * 100}%` }}><span>插入并后移</span></div>}{shifted.map((change) => { const shiftedStart = minutesTime(change.startMinute % 1440); const shiftedEnd = minutesTime((change.startMinute + sessionDuration(change.session)) % 1440); const shiftedStyle = timeline ? timeline.positionForRange(shiftedStart, shiftedEnd) : positionStyle(shiftedStart, shiftedEnd); return shiftedStyle ? <article key={`shift-${change.session.id}`} className="calendar-shift-preview" style={shiftedStyle}><strong>{taskTitle(workspace, change.session.taskId)}</strong><time>{shiftedStart}–{shiftedEnd}</time></article> : null; })}</>;
      })()}
      {blocks.map((block) => {
        const baseStyle = timeline ? timeline.positionForRange(block.startLocal, block.endLocal) : positionStyle(block.startLocal, block.endLocal);
        if (!baseStyle) return null;
        const position = (startLocal: string, endLocal: string) => timeline ? timeline.positionForRange(startLocal, endLocal) : positionStyle(startLocal, endLocal);
        return <CalendarTimeBlock key={block.id} block={block} baseStyle={baseStyle} position={position} hourHeight={preferences.calendarScale[preferences.calendarView]} snapMinutes={preferences.snapMinutes} onResizeStart={() => { setBlankHoverMinute(null); setBlankRange(null); setBlankAction(null); }} onUpdate={(next) => onUpdateBlock(block, next)} onDelete={() => void onDeleteBlock(block.id)} />;
      })}
      {sessions.map((session) => {
        const task = workspace.tasks.find((item) => item.id === session.taskId); const baseStyle = timeline ? timeline.positionForRange(session.startLocal, session.endLocal) : positionStyle(session.startLocal, session.endLocal); const layout = concurrency.get(session.id);
        if (!task || !baseStyle || layout?.hidden) return null;
        const style = layout ? { ...baseStyle, left: `calc(${layout.left}% + 4px)`, right: "auto", width: `calc(${layout.width}% - 8px)` } : baseStyle;
        return <CalendarSession key={session.id} style={style} targeted={session.id === focusSessionId} overlapTargeted={dragPreview?.mode === "overlap" && dragPreview.targetSessionId === session.id} draggingSource={dragPreview != null && dragPreview.sessionId === session.id && dragPreview.mode !== "overlap"} session={session} task={task} projectTitle={workspace.projects.find((project) => project.id === task.projectId)?.title ?? null} hourHeight={preferences.calendarScale[preferences.calendarView]} now={now} records={workspace.executionRecords} showActualRecords={preferences.showActualRecords} snapMinutes={preferences.snapMinutes} onResize={(duration) => onMove(session, session.localDate, session.startLocal, duration)} onResizeStart={() => { setBlankHoverMinute(null); setBlankRange(null); setBlankAction(null); }} onEdit={() => onEditSession(session)} onProgress={onProgress} onSkipReview={() => onSkipReview(session)} onContinue={() => onContinue(session)} overlay={layout?.hiddenCount ? <button className="concurrent-summary" aria-expanded={expandedConcurrency === layout.groupId} onClick={(event) => { event.stopPropagation(); setExpandedConcurrency((current) => current === layout.groupId ? null : layout.groupId); }}>另外 {layout.hiddenCount} 项</button> : layout?.showCount ? <span className="simultaneous-count">同时 {layout.totalCount} 项</span> : null} />;
      })}
      {expandedConcurrency && (() => {
        const groupSessions = sessions.filter((session) => concurrency.get(session.id)?.groupId === expandedConcurrency);
        if (groupSessions.length < 4) return null;
        const first = groupSessions.reduce((earliest, session) => timeMinutes(session.startLocal) < timeMinutes(earliest.startLocal) ? session : earliest);
        const top = timeline ? timeline.offsetAtMinute(timeMinutes(first.startLocal)) : timeMinutes(first.startLocal) / 1440 * 100;
        return <section className="concurrent-expanded-list" aria-label="同时安排的全部任务" style={timeline ? { top: `${top}px` } : { top: `${top}%` }}>{groupSessions.map((session) => <button key={session.id} onClick={() => onEditSession(session)}><strong>{taskTitle(workspace, session.taskId)}</strong><time>{session.startLocal}–{session.endLocal}</time></button>)}</section>;
      })()}
      {actualRecords.map(({ record, start, end, style: recordStyle }) => { const task = workspace.tasks.find((item) => item.id === record.taskId); const style = timeline ? timeline.positionForRange(start, end) : recordStyle; if (!task || !style) return null; return <article key={`${record.id}:${date}`} className={`calendar-actual-record ${record.actualEndUtc ? "ended" : "running"}`} style={style} aria-label={`实际记录：${task.title}，${start}–${end}`}><span>实际</span><strong>{task.title}</strong><time>{start}–{end}</time></article>; })}
    </div>
  </div>;
}

function CalendarTimeBlock({ block, baseStyle, position, hourHeight, snapMinutes, onResizeStart, onUpdate, onDelete }: {
  block: TimeBlock;
  baseStyle: CSSProperties;
  position: (startLocal: string, endLocal: string) => CSSProperties | null;
  hourHeight: number;
  snapMinutes: AppSettings["snapMinutes"];
  onResizeStart?: () => void;
  onUpdate: (next: TimeBlock) => Promise<void>;
  onDelete: () => void;
}) {
  const [resize, setResize] = useState<null | { edge: "move" | "top" | "bottom"; startMinute: number; endMinute: number; clientX: number; clientY: number; originX: number }>(null);
  const initialStart = timeMinutes(block.startLocal);
  const initialEnd = timeMinutes(block.endLocal);
  const initialDuration = (initialEnd - initialStart + 1440) % 1440 || 1440;

  const startEdgeResize = (event: React.PointerEvent<HTMLElement>, edge: "move" | "top" | "bottom") => {
    event.preventDefault(); event.stopPropagation();
    onResizeStart?.();
    const originY = event.clientY;
    const originX = event.clientX;
    const pixelsPerMinute = hourHeight / 60;
    const compute = (next: PointerEvent) => {
      const snap = next.altKey ? (snapMinutes === "off" ? 15 : 1) : snapMinutes === "off" ? 1 : snapMinutes;
      const delta = (next.clientY - originY) / pixelsPerMinute;
      const roundedDelta = Math.round(delta / snap) * snap;
      if (edge === "move") {
        const newStart = Math.max(0, Math.min(1440 - initialDuration, initialStart + roundedDelta));
        return { startMinute: newStart, endMinute: newStart + initialDuration };
      }
      if (edge === "top") {
        const newStart = Math.max(0, Math.min(initialEnd, initialStart + roundedDelta));
        return { startMinute: newStart, endMinute: initialEnd };
      }
      const newEnd = Math.max(initialStart, Math.min(1440, initialEnd + roundedDelta));
      return { startMinute: initialStart, endMinute: newEnd };
    };
    const move = (next: PointerEvent) => { const next1 = compute(next); setResize({ edge, ...next1, clientX: next.clientX, clientY: next.clientY, originX }); };
    const up = (next: PointerEvent) => {
      const final = compute(next);
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      setResize(null);
      const startLocal = minutesTime(final.startMinute % 1440);
      const endLocal = minutesTime(final.endMinute % 1440);
      const baseTime = new Date(`${block.localDate}T00:00:00`).getTime();
      let localDate = toLocalDate(new Date(baseTime + Math.floor(final.startMinute / 1440) * 86400000));
      let endLocalDate = toLocalDate(new Date(baseTime + Math.floor(final.endMinute / 1440) * 86400000));
      if (edge === "move") {
        const track = document.querySelector<HTMLElement>(`.calendar-day[data-day-date="${block.localDate}"] .day-track`);
        const colWidth = track?.getBoundingClientRect().width ?? 0;
        const deltaDays = colWidth > 0 ? Math.round((next.clientX - originX) / colWidth) : 0;
        if (deltaDays !== 0) {
          localDate = addDays(localDate, deltaDays);
          endLocalDate = addDays(endLocalDate, deltaDays);
        }
      }
      const unchanged = startLocal === block.startLocal && endLocal === block.endLocal && localDate === block.localDate && endLocalDate === block.endLocalDate;
      if (!unchanged) { void onUpdate({ ...block, startLocal, endLocal, localDate, endLocalDate }); }
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true });
  };
  const startMove = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button")) return;
    startEdgeResize(event, "move");
  };

  const liveStart = resize?.startMinute ?? initialStart;
  const liveEnd = resize?.endMinute ?? initialEnd;
  const liveStartStr = minutesTime(liveStart % 1440);
  const liveEndStr = minutesTime(liveEnd % 1440);
  const liveDuration = (liveEnd - liveStart + 1440) % 1440 || 1440;
  const displayStyle = resize === null ? baseStyle : (() => {
    const fresh = position(liveStartStr, liveEndStr);
    const style = fresh ?? (() => {
      const top = baseStyle.top as string;
      const minutes = timeMinutes(liveStartStr);
      const endMin = timeMinutes(liveEndStr);
      const duration = (endMin - minutes + 1440) % 1440 || 1440;
      return { ...baseStyle, top, height: `${Math.max(duration / 1440 * 100, 1.25)}%` };
    })();
    if (resize.edge === "move" && resize.clientX !== resize.originX) {
      const deltaX = resize.clientX - resize.originX;
      return { ...style, left: `calc(7px + ${deltaX}px)`, right: "auto", width: "calc(100% - 14px)" };
    }
    return style;
  })();
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const previewAbove = resize !== null && liveDuration > 150;
  const previewTop = resize === null ? 0 : (previewAbove ? resize.clientY - 6 : resize.clientY + 6);
  const previewLeft = resize === null ? 0 : Math.max(80, Math.min(vw - 80, resize.clientX));
  const isResizing = resize !== null;
  const classes = ["calendar-time-block", isResizing ? "is-resizing" : ""].filter(Boolean).join(" ");

  return <>
    <article className={classes} style={displayStyle} onPointerDown={startMove}>
      <button className="time-block-handle time-block-handle-top" aria-label={`调整 ${block.title} 开始时间`} onPointerDown={(e) => startEdgeResize(e, "top")} />
      <time>{liveStartStr}–{liveEndStr}</time>
      <strong>{block.title}</strong>
      <button className="time-block-delete" aria-label={`删除时间块 ${block.title}`} onClick={onDelete}><X size={13} /></button>
      <button className="time-block-handle time-block-handle-bottom" aria-label={`调整 ${block.title} 结束时间`} onPointerDown={(e) => startEdgeResize(e, "bottom")} />
    </article>
    {resize !== null && <div className={`session-resize-preview${previewAbove ? " is-above" : ""}`} role="status" aria-label="调整时间块时长预览" style={{ left: `${previewLeft}px`, top: `${previewTop}px` }}>{liveStartStr}–{liveEndStr} · {liveDuration} 分钟</div>}
  </>;
}

function CalendarSession({ style, targeted = false, overlapTargeted = false, draggingSource = false, session, task, projectTitle, hourHeight, now, records, showActualRecords, snapMinutes, onResize, onResizeStart, onEdit, onProgress, onSkipReview, onContinue, overlay }: {
  style?: CSSProperties; targeted?: boolean; overlapTargeted?: boolean; draggingSource?: boolean;
  session: ExecutionSession; task: Task; projectTitle: string | null; hourHeight: number; now: Date; records: ExecutionRecord[]; showActualRecords: boolean; snapMinutes: AppSettings["snapMinutes"];
  onResize: (duration: number) => Promise<void>; onResizeStart?: () => void; onEdit: () => void; onProgress: (task: Task, value: number) => Promise<void>; onSkipReview: () => Promise<void>; onContinue: () => void;
  overlay?: ReactNode;
}) {
  const articleRef = useRef<HTMLElement>(null);
  const [progressOpen, setProgressOpen] = useState(false);
  const [resize, setResize] = useState<{ duration: number; clientX: number; clientY: number } | null>(null);
  const [reviewPos, setReviewPos] = useState({ top: 0, left: 0 });
  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewLeaveTimer = useRef<number | null>(null);
  const openReview = () => { if (reviewLeaveTimer.current !== null) window.clearTimeout(reviewLeaveTimer.current); reviewLeaveTimer.current = null; setReviewOpen(true); };
  const scheduleCloseReview = () => { if (reviewLeaveTimer.current !== null) window.clearTimeout(reviewLeaveTimer.current); reviewLeaveTimer.current = window.setTimeout(() => setReviewOpen(false), 200); };
  useEffect(() => () => { if (reviewLeaveTimer.current !== null) window.clearTimeout(reviewLeaveTimer.current); }, []);
  const current = sessionContains(session, now);
  const hasRecord = records.some((record) => record.sessionId === session.id);
  const pendingReview = session.status === "scheduled" && !current && sessionEnded(session, now) && task.status !== "completed" && task.progress < 100 && !hasRecord;
  const confirmedNoProgress = session.status === "missed";
  const elapsed = current ? Math.round((now.getTime() - localSessionStart(session)) / Math.max(1, localSessionEnd(session) - localSessionStart(session)) * 100) : 0;
  const availableHeight = sessionDuration(session) / 60 * hourHeight;
  const density = availableHeight < hourHeight / 2 ? "compact" : availableHeight < hourHeight ? "standard" : "detailed";
  const showTimeAndProgress = density !== "compact";
  useEffect(() => {
    if (!pendingReview) return;
    const update = () => {
      const rect = articleRef.current?.getBoundingClientRect();
      if (rect) setReviewPos({ top: Math.min(rect.bottom, window.innerHeight - 64), left: Math.max(8, Math.min(window.innerWidth - 340, rect.left - 2)) });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => { window.removeEventListener("scroll", update, true); window.removeEventListener("resize", update); };
  }, [pendingReview, session.id, session.startLocal, session.endLocal]);
  const showDetails = density === "detailed";
  const status = current ? { icon: <Clock3 size={12} />, label: "当前安排" }
    : pendingReview ? { icon: <CircleAlert size={12} />, label: "待回顾" }
      : confirmedNoProgress ? { icon: <Ban size={12} />, label: "本次未推进" }
        : task.status === "completed" || task.progress === 100 ? { icon: <Check size={12} />, label: "已完成" }
          : null;
  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault(); event.stopPropagation();
    onResizeStart?.();
    const originY = event.clientY;
    const initial = sessionDuration(session);
    const pixelsPerMinute = hourHeight / 60;
    const rounded = (next: PointerEvent) => {
      const snap = next.altKey ? (snapMinutes === "off" ? 15 : 1) : snapMinutes === "off" ? 1 : snapMinutes;
      const deltaMinutes = (next.clientY - originY) / pixelsPerMinute;
      return Math.max(snap, Math.min(1440, initial + Math.round(deltaMinutes / snap) * snap));
    };
    const move = (next: PointerEvent) => setResize({ duration: rounded(next), clientX: next.clientX, clientY: next.clientY });
    const up = (next: PointerEvent) => {
      const duration = rounded(next);
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      setResize(null);
      void onResize(duration);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true });
  };
  const classes = ["calendar-session", session.status === "missed" ? "missed" : "", current ? "current-schedule" : "", pendingReview ? "pending-review" : "", targeted ? "targeted-session" : "", overlapTargeted ? "overlap-target" : "", task.status === "completed" || task.progress === 100 ? "completed" : "", showActualRecords ? "planned-outline" : "", draggingSource ? "is-dragging-source" : "", resize !== null ? "is-resizing" : ""].filter(Boolean).join(" ");
  const displayStyle = resize === null ? (style ?? positionStyle(session.startLocal, session.endLocal)) : { ...(style ?? positionStyle(session.startLocal, session.endLocal)), height: `${resize.duration / 60 * hourHeight}px` };
  return <><article ref={articleRef} tabIndex={0} className={classes} data-session-id={session.id} data-card-density={density} aria-label={`${task.title}，${session.startLocal} 至 ${session.endLocal}${status ? `，${status.label}` : ""}`} style={displayStyle} draggable onPointerEnter={pendingReview ? openReview : undefined} onPointerLeave={pendingReview ? scheduleCloseReview : undefined} onFocus={pendingReview ? openReview : undefined} onBlur={pendingReview ? scheduleCloseReview : undefined} onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === "Enter") { event.preventDefault(); onEdit(); } }} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-daymark-session", session.id); }}>
    {resize !== null && (() => {
      const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
      const flipUp = resize.duration > 150;
      const top = flipUp ? resize.clientY - 6 : resize.clientY + 6;
      const left = Math.max(80, Math.min(vw - 80, resize.clientX));
      return <div className={`session-resize-preview${flipUp ? " is-above" : ""}`} role="status" aria-label="调整时长预览" style={{ left: `${left}px`, top: `${top}px` }}>{session.startLocal}–{minutesTime((timeMinutes(session.startLocal) + resize.duration) % 1440)} · {resize.duration} 分钟</div>;
    })()}
    {showTimeAndProgress && <time className="session-time">{session.startLocal}–{session.endLocal}</time>}<strong>{task.title}</strong>
    {(status || showDetails || (task.deadlineLocal && daysBetween(toLocalDate(now), task.deadlineLocal) <= 7)) && <span className="session-state">{status && <span className="session-status-icon" aria-label={status.label}>{status.icon}{density !== "compact" && <span>{status.label}</span>}</span>}{showDetails && <span className="session-progress-value">{task.progress}%</span>}{task.deadlineLocal && daysBetween(toLocalDate(now), task.deadlineLocal) <= 7 && <span title={`截止日期：${formatLongDate(task.deadlineLocal)}`}><Flag size={12} aria-label={`截止日期 ${task.deadlineLocal}`} /></span>}</span>}
    {showDetails && projectTitle && <span className="session-project">{projectTitle}</span>}
    {current && showTimeAndProgress && <div className="session-elapsed" role="progressbar" aria-label={`${task.title} 本时段已过去`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={elapsed}><span style={{ width: `${elapsed}%` }} /></div>}
    {showTimeAndProgress && <div className="session-task-progress" role="progressbar" aria-label={`${task.title} 手动任务进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={task.progress}><span style={{ width: `${task.progress}%` }} /></div>}
    {pendingReview && showDetails && <span className="review-summary">时段已结束 · 当前进度 {task.progress}%</span>}
    {overlay}
    <button className="session-edit-button" data-action-visibility={showDetails ? "visible" : "on-demand"} aria-label={`编辑 ${task.title} 时间`} onClick={onEdit}><Pencil size={12} /></button>
    <button className="resize-handle" aria-label={`调整 ${task.title} 时长`} onPointerDown={startResize} />
  </article>
  {pendingReview && createPortal(
    <div className={`session-review-actions${reviewOpen ? " open" : ""}`} style={{ top: `${reviewPos.top}px`, left: `${reviewPos.left}px` }} aria-label={`${task.title} 待回顾操作`} onPointerEnter={openReview} onPointerLeave={scheduleCloseReview}><button onClick={() => setProgressOpen((value) => !value)}>更新进度</button><button onClick={onContinue}>继续安排</button><button onClick={() => void onSkipReview()}>本次未推进</button>{progressOpen && <ProgressControl task={task} onCommit={onProgress} />}</div>,
    document.body
  )}
  </>;
}

function ContinueScheduleDialog({ session, task, snapMinutes, onClose, onSave }: {
  session: ExecutionSession; task: Task; snapMinutes: AppSettings["snapMinutes"]; onClose: () => void; onSave: (localDate: string, startLocal: string) => Promise<void>;
}) {
  const today = toLocalDate(new Date()); const snap = snapMinutes === "off" ? 1 : snapMinutes;
  let initialDate = session.endLocalDate < today ? today : session.endLocalDate;
  let initialMinutes = initialDate === today ? Math.ceil((new Date().getHours() * 60 + new Date().getMinutes()) / snap) * snap : timeMinutes(session.endLocal);
  if (initialMinutes >= 1440) { initialDate = addDays(initialDate, 1); initialMinutes = 0; }
  const [localDate, setLocalDate] = useState(initialDate); const [startLocal, setStartLocal] = useState(minutesTime(initialMinutes)); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement>(null); useModalBehavior(dialogRef, onClose, busy);
  const save = async () => { setBusy(true); setError(""); try { await onSave(localDate, startLocal); } catch (reason) { setError(readError(reason)); } finally { setBusy(false); } };
  return createPortal(<div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}><section ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="continue-schedule-title"><div className="modal-icon"><CalendarDays /></div><h2 id="continue-schedule-title">继续安排：{task.title}</h2><p>先确认下一次日期和开始时间，创建后原时段与历史事实保持不变。</p><label>日期<input autoFocus type="date" value={localDate} onChange={(event) => setLocalDate(event.target.value)} /></label><label>开始<input type="time" value={startLocal} onChange={(event) => setStartLocal(event.target.value)} /></label><small>默认沿用任务的单次投入时长；你仍可在创建后精确编辑。</small>{error && <p className="error-message" role="alert"><CircleAlert />{error}</p>}<div className="form-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={busy || !localDate || !startLocal} onClick={() => void save()}>{busy ? "正在创建…" : "创建后续安排"}</Button></div></section></div>, document.body);
}

function SessionEditDialog({ session, task, onClose, onSave }: { session: ExecutionSession; task: Task; onClose: () => void; onSave: (localDate: string, startLocal: string, duration: number) => Promise<void> }) {
  const [localDate, setLocalDate] = useState(session.localDate);
  const [startLocal, setStartLocal] = useState(session.startLocal);
  const [endLocal, setEndLocal] = useState(session.endLocal);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement>(null); useModalBehavior(dialogRef, onClose, busy);
  const startMinutes = timeMinutes(startLocal); let endMinutes = timeMinutes(endLocal); if (endMinutes <= startMinutes) endMinutes += 1440;
  const duration = endMinutes - startMinutes; const valid = duration >= 5 && duration <= 1440;
  const save = async () => { setBusy(true); setError(""); try { await onSave(localDate, startLocal, duration); } catch (reason) { setError(readError(reason)); setBusy(false); } };
  return createPortal(<div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}><section ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="session-edit-title"><div className="modal-icon"><Pencil /></div><h2 id="session-edit-title">编辑时间：{task.title}</h2><p>修改日期或起止时间后保存；结束时间早于开始时间时按跨午夜处理。</p><label>日期<input type="date" value={localDate} onChange={(event) => setLocalDate(event.target.value)} /></label><div className="time-inputs"><label>开始<input type="time" value={startLocal} onChange={(event) => setStartLocal(event.target.value)} /></label><label>结束<input type="time" value={endLocal} onChange={(event) => setEndLocal(event.target.value)} /></label></div><small>{localDate} {startLocal}–{endLocal} · 持续 {duration} 分钟</small>{error && <p className="error-message" role="alert"><CircleAlert />{error}</p>}<div className="form-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={busy || !valid} onClick={() => void save()}>{busy ? "正在保存…" : "保存时间"}</Button></div></section></div>, document.body);
}

function ProjectsPage({ workspace, onCreate, onUpdateProject, onCreateMilestone, onUpdateMilestone, onDeleteMilestone, onProgress, onFetchBilibili }: {
  workspace: WorkspaceSnapshot; onCreate: (project: Project, tasks: Task[]) => Promise<void>;
  onUpdateProject: (project: Project) => Promise<void>;
  onCreateMilestone: (milestone: ProjectMilestone) => Promise<void>; onUpdateMilestone: (milestone: ProjectMilestone) => Promise<void>; onDeleteMilestone: (milestone: ProjectMilestone) => Promise<void>;
  onProgress: (task: Task, value: number) => Promise<void>; onFetchBilibili: (bvid: string) => Promise<BilibiliVideo>;
}) {
  const today = toLocalDate(new Date());
  const [mode, setMode] = useState<"none" | "project" | "course" | "bilibili">("none");
  const [title, setTitle] = useState(""); const [deadline, setDeadline] = useState(""); const [source, setSource] = useState(""); const [drafts, setDrafts] = useState<CourseTaskDraft[]>([]); const [busy, setBusy] = useState(false);
  const [bilibili, setBilibili] = useState<BilibiliVideo | null>(null); const [biliSelected, setBiliSelected] = useState<number[]>([]); const [importError, setImportError] = useState("");
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [milestoneDraft, setMilestoneDraft] = useState<{ projectId: string; editing: ProjectMilestone | null; continuing: boolean } | null>(null);
  const closeForm = () => { setMode("none"); setTitle(""); setDeadline(""); setSource(""); setDrafts([]); setBilibili(null); setBiliSelected([]); };
  const create = async () => {
    if (!title.trim() || busy) return; setBusy(true);
    const project: Project = { id: crypto.randomUUID(), title: title.trim(), deadlineLocal: deadline || null };
    const selected = mode === "course" ? drafts.filter((draft) => draft.selected).map((draft) => ({ title: draft.title, estimatedMinutes: draft.estimatedMinutes, mediaMinutes: null as number | null, sourceUrl: null as string | null, sourceKey: null as string | null }))
      : mode === "bilibili" && bilibili ? bilibili.parts.filter((part) => biliSelected.includes(part.page)).map((part) => ({ title: part.title, estimatedMinutes: null, mediaMinutes: Math.max(1, Math.ceil(part.durationSeconds / 60)), sourceUrl: part.sourceUrl, sourceKey: part.sourceKey })) : [];
    const tasks: Task[] = selected.map((draft, index) => ({ id: crypto.randomUUID(), projectId: project.id, title: draft.title, progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: draft.estimatedMinutes, sessionMinutes: null, priority: "normal", sortOrder: index, sourceUrl: draft.sourceUrl, sourceKey: draft.sourceKey, mediaMinutes: draft.mediaMinutes, kind: "task" }));
    try { await onCreate(project, tasks); closeForm(); } finally { setBusy(false); }
  };
  return <section className="page-stack" aria-labelledby="projects-title"><PageHeader eyebrow="把长期结果拆成可行动的任务" title="项目" actions={<><Button onClick={() => setMode("project")}><Plus size={17} />新建项目</Button><Button onClick={() => setMode("course")}><Upload size={17} />导入文本课程</Button><Button variant="primary" onClick={() => setMode("bilibili")}><Upload size={17} />B 站链接 Beta</Button></>} />
    {mode !== "none" && <section className="surface-card project-form"><div className="section-heading"><h2>{mode === "course" ? "导入课程分集" : mode === "bilibili" ? "读取 B 站公开视频" : "创建普通项目"}</h2><button className="icon-action" aria-label="关闭" onClick={() => setMode("none")}><X /></button></div><label>项目标题<input autoFocus={mode !== "bilibili"} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      {mode === "project" && <label>项目截止日期（可选）<input type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} /></label>}
      {mode === "course" && <><label>粘贴分集文本<textarea rows={6} value={source} placeholder={'P1 起步 12:30\nP2 数据建模 18:00\n\n使用说明\n23:19\nUnit1 Lesson 1\n58:39'} onChange={(event) => { setSource(event.target.value); setDrafts(parseCourseText(event.target.value)); }} /></label><div className="import-preview" aria-label="课程导入预览">{drafts.map((draft, index) => <div key={`${draft.title}-${index}`}><input type="checkbox" aria-label={`选择 ${draft.title}`} checked={draft.selected} onChange={(event) => setDrafts((items) => items.map((item, at) => at === index ? { ...item, selected: event.target.checked } : item))} /><input aria-label={`编辑第 ${index + 1} 个分集`} value={draft.title} onChange={(event) => setDrafts((items) => items.map((item, at) => at === index ? { ...item, title: event.target.value } : item))} /><span>{draft.estimatedMinutes ? `${draft.estimatedMinutes} 分钟` : "未估时"}</span></div>)}</div></>}
      {mode === "bilibili" && <><label>B 站普通视频链接<input autoFocus value={source} onChange={(event) => setSource(event.target.value)} placeholder="https://www.bilibili.com/video/BV…" /></label><Button disabled={!source.trim() || busy} onClick={async () => { setBusy(true); setImportError(""); try { const video = await onFetchBilibili(extractBvid(source)); setBilibili(video); setTitle(video.title); setBiliSelected(video.parts.map((part) => part.page)); } catch (error) { setImportError(readError(error)); } finally { setBusy(false); } }}>{busy ? "正在读取…" : "读取公开元数据"}</Button>{importError && <p className="error-message" role="alert"><CircleAlert />{importError}</p>}{bilibili && <><p className="import-source">{bilibili.ownerName} · {bilibili.bvid} · {bilibili.parts.length} 个分 P</p><div className="import-preview" role="region" aria-label="B 站分 P 预览">{bilibili.parts.map((part) => <div key={part.sourceKey}><input type="checkbox" aria-label={`选择 ${part.title}`} checked={biliSelected.includes(part.page)} onChange={(event) => setBiliSelected((pages) => event.target.checked ? [...pages, part.page] : pages.filter((page) => page !== part.page))} /><span>P{part.page}</span><input aria-label={`编辑第 ${part.page} 个分 P`} value={part.title} onChange={(event) => setBilibili((video) => video ? { ...video, parts: video.parts.map((item) => item.sourceKey === part.sourceKey ? { ...item, title: event.target.value } : item) } : video)} /><span>{Math.ceil(part.durationSeconds / 60)} 分钟</span></div>)}</div></>}</>}
      <div className="form-actions"><Button onClick={() => setMode("none")}>取消</Button><Button variant="primary" disabled={!title.trim() || (mode === "course" && !drafts.some((item) => item.selected)) || (mode === "bilibili" && (!bilibili || biliSelected.length === 0)) || busy} onClick={() => void create()}>{busy ? "正在写入…" : "创建"}</Button></div>
    </section>}
    <div className="project-grid">{workspace.projects.length === 0 ? <article className="surface-card project-card-empty"><span className="eyebrow">还没有项目</span><h2>把长期目标拆成可执行的任务</h2><p>在项目里集中管理一组相关任务，能更快看到推进和截止。</p><Button variant="primary" onClick={() => setMode("project")}><Plus size={17} />创建第一个项目</Button></article> : workspace.projects.map((project) => {
      const tasks = workspace.tasks.filter((task) => task.projectId === project.id);
      const weighted = projectProgress(tasks);
      const milestones = workspace.projectMilestones.filter((milestone) => milestone.projectId === project.id).sort((a, b) => a.targetLocalDate.localeCompare(b.targetLocalDate) || a.sortOrder - b.sortOrder);
      return <article key={project.id} className="surface-card project-card"><div className="project-title"><div><span className="eyebrow">{tasks.length} 个任务</span><h2>{project.title}</h2></div><div className="project-title-side"><strong>{weighted}%</strong><button className="icon-action" aria-label={`编辑项目 ${project.title}`} onClick={() => setEditingProjectId((id) => id === project.id ? null : project.id)}><Pencil size={15} /></button></div></div>
        {project.deadlineLocal && <ProjectDeadlineChip deadline={project.deadlineLocal} today={today} />}
        <div className="progress-track"><span style={{ width: `${weighted}%` }} /></div>
        {editingProjectId === project.id && <ProjectEditor project={project} onSave={async (next) => { await onUpdateProject(next); setEditingProjectId(null); }} onClose={() => setEditingProjectId(null)} />}
        <div className="project-milestones"><div className="section-heading"><h3>里程碑</h3><button className="icon-action" aria-label={`为 ${project.title} 新增里程碑`} onClick={() => setMilestoneDraft({ projectId: project.id, editing: null, continuing: false })}><Plus size={15} /></button></div>
          {milestones.map((milestone) => {
            if (milestoneDraft?.editing?.id === milestone.id) return null;
            const reached = milestoneReached(milestone, tasks, weighted);
            const outcome = workspace.milestoneOutcomes.find((item) => item.milestoneId === milestone.id);
            const status = outcome ? { className: "milestone-status missed", label: "未达成" } : reached ? { className: "milestone-status reached", label: "已达成" } : { className: "milestone-status", label: "进行中" };
            const detail = outcome ? `${outcome.resultText} · ${formatShortDate(outcome.targetLocalDate)} 到期` : milestoneSummary(milestone, tasks);
            return <div key={milestone.id} className="milestone-row"><div><strong>{milestone.title}</strong><span>{detail}</span></div><span className={status.className}>{status.label}</span>{outcome && <button className="icon-action" aria-label={`续排里程碑 ${milestone.title}`} title="将剩余目标纳入后续计划" onClick={() => setMilestoneDraft({ projectId: project.id, editing: continueMilestoneDraft(milestone, tasks, weighted, today), continuing: true })}><RotateCcw size={14} /></button>}<button className="icon-action" aria-label={`编辑里程碑 ${milestone.title}`} onClick={() => setMilestoneDraft({ projectId: project.id, editing: milestone, continuing: false })}><Pencil size={14} /></button><button className="icon-action" aria-label={`删除里程碑 ${milestone.title}`} onClick={() => void onDeleteMilestone(milestone)}><X size={14} /></button></div>;
          })}
          {milestones.length === 0 && <p className="milestone-empty">还没有里程碑，可按任务、数量或进度设定检查点。</p>}
        </div>
        {milestoneDraft?.projectId === project.id && <MilestoneForm project={project} tasks={tasks} sortOrder={milestones.length} editing={milestoneDraft.editing} continuing={milestoneDraft.continuing} onCancel={() => setMilestoneDraft(null)} onSave={async (milestone) => { if (milestoneDraft.editing && !milestoneDraft.continuing) await onUpdateMilestone(milestone); else await onCreateMilestone(milestone); setMilestoneDraft(null); }} />}
        <div className="project-tasks">{tasks.map((task, index) => <div key={task.id}><span>{index + 1}</span><div><strong>{task.title}</strong><ProgressControl task={task} onCommit={onProgress} showComplete /></div></div>)}</div></article>;
    })}
      {workspace.projects.length === 0 && <EmptyState icon={<FolderKanban />} title="还没有项目" text="创建普通项目，或粘贴课程分集文本批量建立有序任务。" />}
    </div>
  </section>;
}

function ProjectDeadlineChip({ deadline, today }: { deadline: string; today: string }) {
  const urgency = deadlineUrgency(deadline, today);
  const days = daysBetween(today, deadline);
  const detail = urgency === "overdue" ? `已逾期 ${Math.abs(days)} 天` : urgency === "today" ? "今天到期" : `还有 ${days} 天`;
  return <span className={urgency === "overdue" ? "project-deadline overdue" : "project-deadline"} title="项目截止日期，区别于子任务截止"><Flag size={13} aria-hidden="true" />项目截止 {formatShortDate(deadline)} · {detail}</span>;
}

function ProjectEditor({ project, onSave, onClose }: { project: Project; onSave: (project: Project) => Promise<void>; onClose: () => void }) {
  const [title, setTitle] = useState(project.title); const [deadline, setDeadline] = useState(project.deadlineLocal ?? "");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const save = async () => {
    if (!title.trim()) { setError("项目标题不能为空"); return; }
    setBusy(true); setError("");
    try { await onSave({ ...project, title: title.trim(), deadlineLocal: deadline || null }); }
    catch (reason) { setError(readError(reason)); setBusy(false); }
  };
  return <form className="project-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <label>项目标题<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label>项目截止日期（可清除）<input type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} /></label>
    <small>截止日期属于项目整体，不是子任务的截止。</small>
    {error && <p className="error-message" role="alert"><CircleAlert />{error}</p>}
    <div className="form-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? "正在保存…" : "保存项目"}</Button></div>
  </form>;
}

function MilestoneForm({ project, tasks, sortOrder, editing, continuing = false, onSave, onCancel }: {
  project: Project; tasks: Task[]; sortOrder: number; editing: ProjectMilestone | null; continuing?: boolean;
  onSave: (milestone: ProjectMilestone) => Promise<void>; onCancel: () => void;
}) {
  const [title, setTitle] = useState(editing?.title ?? "");
  const [date, setDate] = useState(editing?.targetLocalDate ?? "");
  const [criterion, setCriterion] = useState<ProjectMilestone["criterionKind"]>(editing?.criterionKind ?? "orderedTask");
  const [targetTaskId, setTargetTaskId] = useState(editing?.targetTaskId ?? "");
  const [targetCount, setTargetCount] = useState(editing?.targetCount ?? 1);
  const [targetProgress, setTargetProgress] = useState(editing?.targetProgress ?? 50);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const goalText = criterion === "orderedTask" ? `完成任务「${tasks.find((task) => task.id === targetTaskId)?.title ?? "…"}」`
    : criterion === "taskCount" ? `完成 ${targetCount} 个项目任务`
    : `项目加权进度达到 ${targetProgress}%`;
  const summaryText = date ? `${goalText} · ${formatShortDate(date)} 前` : goalText;
  const ready = Boolean(title.trim() && date && (criterion !== "orderedTask" || targetTaskId));
  const save = async () => {
    if (!title.trim()) { setError("里程碑名称不能为空"); return; }
    if (!date) { setError("请选择目标日期"); return; }
    if (criterion === "orderedTask" && !targetTaskId) { setError("请选择目标任务"); return; }
    setBusy(true); setError("");
    const base = { id: editing?.id ?? crypto.randomUUID(), projectId: project.id, title: title.trim(), targetLocalDate: date, sortOrder: editing?.sortOrder ?? sortOrder };
    let milestone: ProjectMilestone;
    if (criterion === "orderedTask") milestone = { ...base, criterionKind: "orderedTask", targetTaskId, targetCount: null, targetProgress: null };
    else if (criterion === "taskCount") milestone = { ...base, criterionKind: "taskCount", targetTaskId: null, targetCount, targetProgress: null };
    else milestone = { ...base, criterionKind: "projectProgress", targetTaskId: null, targetCount: null, targetProgress };
    try { await onSave(milestone); }
    catch (reason) { setError(readError(reason)); setBusy(false); }
  };
  return <form className="milestone-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <div className="section-heading"><h3>{continuing ? `续排里程碑：${editing?.title ?? ""}` : editing ? `编辑里程碑：${editing.title}` : "新增里程碑"}</h3><button className="icon-action" aria-label="关闭里程碑表单" onClick={onCancel}><X size={15} /></button></div>
    {continuing && <small>未达成里程碑的剩余目标已按差额预填，调整日期后保存。</small>}
    <label>里程碑名称<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label>目标日期<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
    <label>达成条件<select value={criterion} onChange={(event) => setCriterion(event.target.value as ProjectMilestone["criterionKind"])}><option value="orderedTask">指定任务完成</option><option value="taskCount">完成任务数量</option><option value="projectProgress">项目进度达到</option></select></label>
    {criterion === "orderedTask" && <label>目标任务<select value={targetTaskId} onChange={(event) => setTargetTaskId(event.target.value)}><option value="">选择项目内任务</option>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>}
    {criterion === "taskCount" && <label>完成任务数（项目内共 {tasks.length} 个）<input type="number" min="1" value={targetCount} onChange={(event) => setTargetCount(Math.max(1, Number(event.target.value) || 1))} /></label>}
    {criterion === "projectProgress" && <label>项目加权进度（%）<input type="number" min="1" max="100" value={targetProgress} onChange={(event) => setTargetProgress(Math.min(100, Math.max(1, Number(event.target.value) || 1)))} /></label>}
    <small>保存后：{summaryText}</small>
    {error && <p className="error-message" role="alert"><CircleAlert />{error}</p>}
    <div className="form-actions"><Button disabled={busy} onClick={onCancel}>取消</Button><Button variant="primary" disabled={busy || !ready} onClick={() => void save()}>{busy ? "正在保存…" : continuing ? "保存续排" : "保存里程碑"}</Button></div>
  </form>;
}

function continueMilestoneDraft(milestone: ProjectMilestone, tasks: Task[], weighted: number, today: string): ProjectMilestone {
  const base = { id: crypto.randomUUID(), projectId: milestone.projectId, title: milestone.title, targetLocalDate: addDays(today, 7), sortOrder: milestone.sortOrder };
  if (milestone.criterionKind === "orderedTask") return { ...base, criterionKind: "orderedTask", targetTaskId: milestone.targetTaskId, targetCount: null, targetProgress: null };
  if (milestone.criterionKind === "taskCount") {
    const done = tasks.filter((task) => task.status === "completed" || task.progress >= 100).length;
    return { ...base, criterionKind: "taskCount", targetTaskId: null, targetCount: Math.max(1, milestone.targetCount - done), targetProgress: null };
  }
  return { ...base, criterionKind: "projectProgress", targetTaskId: null, targetCount: null, targetProgress: milestone.targetProgress };
}

function milestoneSummary(milestone: ProjectMilestone, tasks: Task[]) {
  const task = milestone.targetTaskId ? tasks.find((item) => item.id === milestone.targetTaskId) : null;
  const goal = milestone.criterionKind === "orderedTask" ? `完成任务「${task?.title ?? "任务已不在项目中"}」`
    : milestone.criterionKind === "taskCount" ? `完成 ${milestone.targetCount} 个项目任务`
    : `项目加权进度达到 ${milestone.targetProgress}%`;
  return `${goal} · ${formatShortDate(milestone.targetLocalDate)} 前`;
}

function milestoneReached(milestone: ProjectMilestone, tasks: Task[], weighted: number) {
  const completed = (task: Task) => task.status === "completed" || task.progress >= 100;
  if (milestone.criterionKind === "orderedTask") { const task = tasks.find((item) => item.id === milestone.targetTaskId); return Boolean(task && completed(task)); }
  if (milestone.criterionKind === "taskCount") return tasks.filter(completed).length >= milestone.targetCount;
  return weighted >= milestone.targetProgress;
}

function AutoScheduleDialog({ workspace, preferences, onClose, onApply }: { workspace: WorkspaceSnapshot; preferences: AppSettings; onClose: () => void; onApply: (sessions: ExecutionSession[], occurrences: HabitOccurrence[]) => Promise<void> }) {
  const today = toLocalDate(new Date()); const endDate = addDays(today, 6);
  const items = useMemo<ScheduleItem[]>(() => {
    const projectDeadlineById = new Map(workspace.projects.map((project) => [project.id, project.deadlineLocal]));
    const tasks = workspace.tasks.filter((task) => task.status === "active" && task.kind !== "habit").map((task) => {
      const projectDeadline = task.projectId ? projectDeadlineById.get(task.projectId) ?? null : null;
      return { key: `task:${task.id}`, taskId: task.id, title: task.title, targetMinutes: task.sessionMinutes ?? preferences.defaultSessionMinutes, deadlineLocal: task.deadlineLocal ?? projectDeadline, priority: task.priority ?? "normal", sortOrder: task.sortOrder };
    });
    const habits = workspace.recurringHabits.flatMap((habit) => {
      const task = workspace.tasks.find((item) => item.id === habit.taskId); if (!task) return [];
      return habitDatesBetween(habit, today, endDate).filter((date) => !workspace.habitOccurrences.some((occurrence) => occurrence.habitId === habit.id && occurrence.localDate === date)).map((date, index) => ({ key: `habit:${habit.id}:${date}`, taskId: habit.taskId, title: `${habit.title} · ${formatShortDate(date)}`, targetMinutes: habit.sessionMinutes, deadlineLocal: date, priority: "normal" as const, sortOrder: workspace.tasks.length + index, fixedDate: date, fixedStartLocal: habit.preferredStartLocal ?? undefined, habitId: habit.id }));
    });
    return [...tasks, ...habits];
  }, [endDate, preferences.defaultSessionMinutes, today, workspace]);
  const busy = useMemo(() => {
    const now = new Date(); const elapsed = now.getHours() * 60 + now.getMinutes();
    const past = elapsed > 0 ? [{ localDate: today, endLocalDate: today, startLocal: "00:00", endLocal: minutesTime(Math.min(1439, elapsed + 1)) }] : [];
    return [...workspace.executionSessions.filter((session) => session.status === "scheduled"), ...workspace.timeBlocks, ...past];
  }, [today, workspace.executionSessions, workspace.timeBlocks]);
  const recommended = useMemo(() => buildSchedulePlan({ startDate: today, days: 7, items, defaultTimeSlots: preferences.defaultTimeSlots, busy, minimumMinutes: preferences.minimumSessionMinutes }), [busy, items, preferences.defaultTimeSlots, preferences.minimumSessionMinutes, today]);
  const [selected, setSelected] = useState(() => new Set(recommended.allocations.map((allocation) => allocation.key)));
  const [preview, setPreview] = useState(false); const [busySaving, setBusySaving] = useState(false); const [error, setError] = useState("");
  const plan = useMemo(() => buildSchedulePlan({ startDate: today, days: 7, items: items.filter((item) => selected.has(item.key)), defaultTimeSlots: preferences.defaultTimeSlots, busy, minimumMinutes: preferences.minimumSessionMinutes }), [busy, items, preferences.defaultTimeSlots, preferences.minimumSessionMinutes, selected, today]);
  const dialogRef = useRef<HTMLElement>(null); useModalBehavior(dialogRef, onClose, busySaving);
  const apply = async () => {
    setBusySaving(true); setError("");
    const sessions = plan.allocations.map((allocation) => sessionFromAllocation(allocation));
    const occurrences = plan.allocations.flatMap((allocation, index) => allocation.habitId ? [{ id: crypto.randomUUID(), habitId: allocation.habitId, localDate: allocation.localDate, status: "scheduled" as const, sessionId: sessions[index].id }] : []);
    try { await onApply(sessions, occurrences); } catch (reason) { setError(readError(reason)); setBusySaving(false); }
  };
  return createPortal(<div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busySaving && onClose()}><section ref={dialogRef} className="modal schedule-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-title"><div className="modal-icon"><Sparkles /></div><h2 id="schedule-title">{preview ? "确认排程草案" : "自动排程 Lite"}</h2><p>仅追加到未来 7 天的默认时段空档，不调整已有安排或时间块。</p><div className="capacity-summary">已选 {selected.size} 项 · 建议 {plan.allocations.length} 个时段 · 使用 {plan.usedMinutes} / 可用 {recommended.availableMinutes} 分钟</div>{preview ? <div className="schedule-preview">{plan.allocations.map((allocation) => <article key={allocation.key}><time>{formatShortDate(allocation.localDate)} {allocation.startLocal}–{allocation.endLocal}</time><strong>{allocation.title}</strong><span>{allocation.minutes < allocation.targetMinutes ? `先安排 ${allocation.minutes}/${allocation.targetMinutes} 分钟` : `${allocation.minutes} 分钟`}</span></article>)}{plan.allocations.length === 0 && <p>当前选择没有可应用的空档。</p>}</div> : <div className="schedule-candidates">{items.map((item) => { const allocation = recommended.allocations.find((value) => value.key === item.key); return <label key={item.key}><input type="checkbox" checked={selected.has(item.key)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(item.key); else next.delete(item.key); return next; })} /><span><strong>{item.title}</strong><small>{allocation ? `${formatShortDate(allocation.localDate)} 可安排 ${allocation.minutes} 分钟` : "当前 7 天暂时放不下"}</small></span></label>; })}{items.length === 0 && <p>当前没有需要安排的活动任务或习惯发生项。</p>}</div>}{error && <p className="error-message" role="alert"><CircleAlert />{error}</p>}<div className="form-actions"><Button disabled={busySaving} onClick={preview ? () => setPreview(false) : onClose}>{preview ? "返回选择" : "取消"}</Button>{preview ? <Button variant="primary" disabled={busySaving || plan.allocations.length === 0} onClick={() => void apply()}>{busySaving ? "正在应用…" : "应用全部"}</Button> : <Button variant="primary" disabled={selected.size === 0 || plan.allocations.length === 0} onClick={() => setPreview(true)}>生成排程草案</Button>}</div></section></div>, document.body);
}

function ReviewPage({ workspace, onGoToday }: { workspace: WorkspaceSnapshot; onGoToday: () => void }) {
  const today = toLocalDate(new Date()); const review = buildSevenDayReview(workspace, today);
  const totalMinutes = review.days.reduce((sum, day) => sum + day.actualMinutes, 0); const totalDelta = review.days.reduce((sum, day) => sum + day.progressDelta, 0);
  const hasFacts = totalMinutes > 0 || totalDelta !== 0 || review.days.some((day) => day.missedCount + day.skippedCount > 0);
  return <section className="page-stack" aria-labelledby="review-title"><PageHeader eyebrow={`${formatShortDate(review.startDate)} — ${formatShortDate(review.endDate)}`} title="最近 7 天回顾" actions={<div className="summary-pills"><span>实际投入 {totalMinutes} 分钟</span><span>进度 +{totalDelta}%</span></div>} />{hasFacts ? <><div className="review-outcomes"><section className="surface-card"><h2>完成与推进</h2><p>{review.completedTaskIds.length} 项完成 · {review.progressedTaskIds.length} 项有推进</p><div className="review-task-list">{review.progressedTaskIds.map((id) => <span key={id}>{taskTitle(workspace, id)}</span>)}</div></section><section className="surface-card"><h2>待续</h2><p>{review.carryoverTaskIds.length} 项仍可继续安排</p><div className="review-task-list">{review.carryoverTaskIds.map((id) => <span key={id}>{taskTitle(workspace, id)}</span>)}</div></section></div><section className="surface-card"><div className="section-heading"><h2>每天的事实</h2><span>不评分，不计算连续天数</span></div><div className="review-days">{review.days.map((day) => <article key={day.date}><time>{weekday(day.date)}<small>{formatShortDate(day.date)}</small></time><div className="review-bar"><span style={{ width: `${Math.min(100, Math.max(day.progressDelta, day.actualMinutes / 3))}%` }} /></div><p>进度 {day.progressDelta >= 0 ? "+" : ""}{day.progressDelta}% · 投入 {day.actualMinutes} 分钟 · 未执行／跳过 {day.missedCount + day.skippedCount}</p></article>)}</div></section></> : <EmptyState icon={<ChartNoAxesColumnIncreasing />} title="有实际推进后，这里会出现回顾" text="没有记录时不绘制全零图表，也不会把未记录解释为失败。" action={<Button variant="primary" onClick={onGoToday}>前往今日</Button>} />}</section>;
}

function DataPage({ native }: { native: NativeApi }) {
  const [message, setMessage] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [restoreSelection, setRestoreSelection] = useState<BackupPreview | null>(null); const [restoreError, setRestoreError] = useState(""); const [restoreBusy, setRestoreBusy] = useState(false);
  const closeRestore = useCallback(() => setRestoreSelection(null), []);
  useEffect(() => { void native.getDataOverview().then((value) => { setBackups(value.backups); setBackupError(value.backupError); }); }, [native]);
  const run = async (action: () => Promise<BackupInfo | null>, success: string) => { setBusy(true); setError(""); try { const result = await action(); if (result) { setMessage(success); setBackupError(null); setBackups((items) => [result, ...items.filter((item) => item.path !== result.path)]); } } catch (reason) { setError(readError(reason)); } finally { setBusy(false); } };
  const chooseRestore = async () => { setBusy(true); setError(""); try { const source = await native.chooseRestoreSource(); if (source) setRestoreSelection(await native.inspectBackup(source)); } catch (reason) { setError(readError(reason)); } finally { setBusy(false); } };
  const confirmRestore = async () => { if (!restoreSelection) return; setRestoreBusy(true); setRestoreError(""); try { await native.restoreBackup(restoreSelection.source); window.location.reload(); } catch (reason) { setRestoreError(readError(reason)); setRestoreBusy(false); } };
  return <section className="page-stack"><PageHeader eyebrow="SQLite · 每日 7 份" title="数据与安全" /><section className="surface-card data-card"><ArchiveRestore size={32} /><div><h2>本地备份</h2><p>每次核心写入后刷新当天备份；恢复前会先保存当前状态并验证目标文件。</p></div><div className="form-actions"><Button disabled={busy} onClick={() => void run(() => native.createDailyBackup(), "已刷新今天的备份")}>立即备份</Button><Button disabled={busy} onClick={() => void run(() => native.createManualBackup(), "已导出手动备份")}>导出</Button><Button variant="primary" disabled={busy} onClick={() => void chooseRestore()}>恢复</Button></div></section>{backupError && <p className="error-message" role="alert"><CircleAlert />自动备份未完成：{backupError}。下次核心写入或手动备份时会重试。</p>}{message && <p className="success-message" role="status"><Check />{message}</p>}{error && <p className="error-message" role="alert"><CircleAlert />{error}</p>}<div className="backup-list">{backups.map((backup) => <div key={backup.path}><Database /><div><strong>{backup.kind === "daily" ? "每日备份" : backup.kind === "manual" ? "手动备份" : "恢复前备份"}</strong><span>{backup.path}</span></div></div>)}</div>{restoreSelection && <RestoreDialog preview={restoreSelection} error={restoreError} busy={restoreBusy} onClose={closeRestore} onConfirm={confirmRestore} />}</section>;
}

function SettingsPage({ preferences, onChange }: { preferences: AppSettings; onChange: (patch: Partial<AppSettings>) => void }) {
  const slots = preferences.defaultTimeSlots;
  const updateSlot = (index: number, patch: Partial<DefaultTimeSlot>) => onChange({ defaultTimeSlots: slots.map((slot, at) => at === index ? { ...slot, ...patch } : slot) });
  const addSlot = () => { const start = slots.at(-1)?.end ?? "19:00"; onChange({ defaultTimeSlots: [...slots, { id: crypto.randomUUID(), label: "新的专注时段", start, end: minutesTime(timeMinutes(start) + 120), weekdays: [1, 2, 3, 4, 5] }] }); };
  const removeSlot = (index: number) => onChange({ defaultTimeSlots: slots.filter((_, at) => at !== index) });
  return <section className="page-stack"><PageHeader eyebrow="少量偏好保存在 Tauri Store" title="设置" /><div className="settings-grid"><section className="surface-card"><h2><Palette />外观与无障碍</h2><div className="radio-grid"><RadioOption label="跟随系统" checked={preferences.appearance === "system"} onChange={() => onChange({ appearance: "system" })} icon={<Palette />} /><RadioOption label="浅色" checked={preferences.appearance === "light"} onChange={() => onChange({ appearance: "light" })} icon={<Sun />} /><RadioOption label="深色" checked={preferences.appearance === "dark"} onChange={() => onChange({ appearance: "dark" })} icon={<Moon />} /></div><label>动态效果<select value={preferences.motion} onChange={(event) => onChange({ motion: event.target.value as AppSettings["motion"] })}><option value="system">跟随系统</option><option value="reduce">减少</option><option value="full">完整</option></select></label><label>界面缩放 <strong>{preferences.scale}%</strong><input type="range" min="100" max="200" step="25" value={preferences.scale} onChange={(event) => onChange({ scale: Number(event.target.value) })} /></label><Toggle label="在日历工具栏显示实际记录开关" note="隐藏入口不会删除实际记录，也不会改变已保存的叠加状态。" checked={preferences.showActualRecordsControl} onChange={(checked) => onChange({ showActualRecordsControl: checked })} /></section>
    <section className="surface-card"><h2><Bell />提醒与行动</h2><Toggle label="记录开始／结束本次" note="默认关闭；只有主动开始才形成实际执行记录。" checked={preferences.checkInEnabled} onChange={(checked) => onChange({ checkInEnabled: checked })} /><label>开始宽限期<select disabled={!preferences.checkInEnabled} value={preferences.checkInGraceMinutes} onChange={(event) => onChange({ checkInGraceMinutes: Number(event.target.value) as AppSettings["checkInGraceMinutes"] })}>{[3, 5, 10, 15].map((value) => <option key={value} value={value}>{value} 分钟</option>)}</select></label><Toggle label="错过后显示挽救提示" note="只出现一次，提供开始、延后、改期和跳过。" checked={preferences.rescuePromptsEnabled} onChange={(checked) => onChange({ rescuePromptsEnabled: checked })} /><Toggle label="执行提醒" note="提醒只定位到任务，不会自动开始。" checked={preferences.remindersEnabled} onChange={(checked) => onChange({ remindersEnabled: checked })} /><label>提前分钟数<input type="number" min="0" max="120" value={preferences.reminderLeadMinutes} onChange={(event) => onChange({ reminderLeadMinutes: Number(event.target.value) })} /></label><label>启动摘要<select value={preferences.startupSummary} onChange={(event) => onChange({ startupSummary: event.target.value as AppSettings["startupSummary"] })}><option value="never">从不提醒</option><option value="daily">每天首次启动</option><option value="everyLaunch">每次启动</option></select></label></section>
    <section className="surface-card"><h2><Clock3 />时间与排程</h2><p>自动排程只使用这些偏好窗口，并避开已有安排和时间块。</p><label>日视图默认显示<select value={preferences.calendarDayMode} onChange={(event) => onChange({ calendarDayMode: event.target.value as AppSettings["calendarDayMode"] })}><option value="fullDay">全天</option><option value="defaultSlots">默认时段（折叠其他时间）</option></select></label>{slots.map((slot, index) => <fieldset key={slot.id} className="slot-editor"><legend>{index === 0 ? "默认时段" : `时段 ${index + 1}`}<button className="icon-action slot-remove" aria-label={`删除时段 ${slot.label}`} onClick={() => removeSlot(index)}><X size={14} /></button></legend><label>名称<input value={slot.label} onChange={(event) => updateSlot(index, { label: event.target.value })} /></label><div className="time-inputs"><label>开始<input type="time" value={slot.start} onChange={(event) => updateSlot(index, { start: event.target.value })} /></label><label>结束<input type="time" value={slot.end} onChange={(event) => updateSlot(index, { end: event.target.value })} /></label></div><fieldset className="weekday-picker"><legend>适用星期</legend><div className="weekday-checks">{[1, 2, 3, 4, 5, 6, 0].map((day) => <label key={day}><input type="checkbox" checked={slot.weekdays.includes(day)} onChange={(event) => updateSlot(index, { weekdays: event.target.checked ? [...slot.weekdays, day] : slot.weekdays.filter((value) => value !== day) })} />{["日", "一", "二", "三", "四", "五", "六"][day]}</label>)}</div></fieldset></fieldset>)}<div className="form-actions"><Button variant="secondary" onClick={addSlot}><Plus size={16} />添加时段</Button></div><label>全局单次投入（分钟）<input type="number" min="5" max="240" value={preferences.defaultSessionMinutes} onChange={(event) => onChange({ defaultSessionMinutes: Number(event.target.value) })} /></label><label>最低有效时长<select value={preferences.minimumSessionMinutes} onChange={(event) => onChange({ minimumSessionMinutes: Number(event.target.value) as AppSettings["minimumSessionMinutes"] })}>{[5, 10, 15, 20, 30].map((value) => <option key={value} value={value}>{value} 分钟</option>)}</select></label><Toggle label="自动排程辅助" note="只提示可以安排的任务，仍需你预览确认。" checked={preferences.autoScheduleAssist} onChange={(checked) => onChange({ autoScheduleAssist: checked })} /></section></div></section>;
}

function FinishDialog({ record, task, onClose, onSubmit }: { record: ExecutionRecord; task: Task; onClose: () => void; onSubmit: (progress: number, note: string, actualEndUtc: string) => Promise<void> }) {
  const [progress, setProgress] = useState(task.progress); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false);
  const [actualMinutes, setActualMinutes] = useState(() => Math.max(1, Math.round((Date.now() - new Date(record.actualStartUtc).getTime()) / 60_000)));
  const dialogRef = useRef<HTMLElement>(null); useModalBehavior(dialogRef, onClose, busy);
  const actualEndUtc = new Date(new Date(record.actualStartUtc).getTime() + actualMinutes * 60_000).toISOString();
  return createPortal(<div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}><section ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="finish-title"><div className="modal-icon"><Square /></div><h2 id="finish-title">结束本次：{task.title}</h2><p>本次执行会立即形成实际投入记录；任务完成度仍由你确认。</p><label>实际投入（分钟）<input type="number" min="1" max="1440" value={actualMinutes} onChange={(event) => setActualMinutes(Math.max(1, Number(event.target.value)))} /></label><label>任务完成度 <strong>{progress}%</strong><input type="range" min="0" max="100" step="5" value={progress} onChange={(event) => setProgress(Number(event.target.value))} /></label><label>本次小结（可选）<textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="留下对下次有帮助的一句话" /></label><small>开始于 {formatClock(record.actualStartUtc)}</small><div className="form-actions"><Button disabled={busy} onClick={onClose}>继续执行</Button><Button variant="primary" disabled={busy} onClick={async () => { setBusy(true); try { await onSubmit(progress, note, actualEndUtc); } finally { setBusy(false); } }}>{busy ? "正在保存…" : "结束并保存"}</Button></div></section></div>, document.body);
}

function RestoreDialog({ preview, error, busy, onClose, onConfirm }: { preview: BackupPreview; error: string; busy: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  const dialogRef = useRef<HTMLElement>(null); useModalBehavior(dialogRef, onClose, busy);
  return createPortal(<div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}><section ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="restore-title"><div className="modal-icon"><ArchiveRestore /></div><h2 id="restore-title">确认恢复备份</h2><p>将恢复 <strong>{preview.projects}</strong> 个项目和 <strong>{preview.tasks}</strong> 个任务。开始替换前会创建恢复前备份。</p><small>{preview.source}</small>{busy && <p role="status"><span className="spinner" />正在验证并安全替换，当前步骤不可取消…</p>}{error && <p className="error-message" role="alert"><CircleAlert />恢复未完成：{error}</p>}<div className="form-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="danger" disabled={busy} onClick={() => void onConfirm()}>{busy ? "正在恢复…" : "验证并恢复"}</Button></div></section></div>, document.body);
}

function useModalBehavior(dialogRef: RefObject<HTMLElement | null>, onClose: () => void, busy: boolean) {
  const busyRef = useRef(busy); busyRef.current = busy;
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>(".app-shell"); const previousFocus = document.activeElement as HTMLElement | null;
    shell?.setAttribute("inert", "");
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? []);
      if (!controls.length) return; const first = controls[0]; const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKeyDown);
    requestAnimationFrame(() => (dialogRef.current?.querySelector<HTMLElement>("[autofocus]") ?? dialogRef.current?.querySelector<HTMLElement>("button, input, textarea"))?.focus());
    return () => { document.removeEventListener("keydown", handleKeyDown); shell?.removeAttribute("inert"); requestAnimationFrame(() => previousFocus?.focus()); };
  }, [dialogRef, onClose]);
}

function ProgressControl({ task, onCommit, showComplete = false }: { task: Task; onCommit: (task: Task, value: number) => Promise<void>; showComplete?: boolean }) {
  const [value, setValue] = useState(task.progress); useEffect(() => setValue(task.progress), [task.progress]);
  const commit = () => { if (value !== task.progress) void onCommit(task, value); };
  const markComplete = () => { setValue(100); if (task.progress !== 100) void onCommit(task, 100); };
  return <div className={showComplete ? "progress-control has-complete" : "progress-control"}><input aria-label={`${task.title} 完成度`} type="range" min="0" max="100" step="5" value={value} onChange={(event) => setValue(Number(event.target.value))} onPointerUp={commit} onKeyUp={commit} />{showComplete ? <div className="progress-side"><button type="button" className="progress-complete" aria-label={`标记 ${task.title} 已完成`} onClick={markComplete} disabled={task.progress === 100}>完成</button><span>{value}%</span></div> : <span>{value}%</span>}</div>;
}

function useCurrentTime() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(timer); }, []);
  return now;
}


function TaskEditorFields({ task, projects, onUpdate }: { task: Task; projects: Project[]; onUpdate: (task: Task) => Promise<void> }) {
  const [draft, setDraft] = useState(task);
  useEffect(() => setDraft(task), [task]);
  const save = (next: Task) => { setDraft(next); if (JSON.stringify(next) !== JSON.stringify(task)) void onUpdate(next); };
  return <>
    <label>标题<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} onBlur={() => draft.title.trim() && save({ ...draft, title: draft.title.trim() })} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setDraft(task); event.currentTarget.blur(); } }} /></label>
    <label>项目<select value={draft.projectId ?? ""} onChange={(event) => save({ ...draft, projectId: event.target.value || null })}><option value="">独立任务</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
    <label>截止日期<input type="date" value={draft.deadlineLocal ?? ""} onChange={(event) => save({ ...draft, deadlineLocal: event.target.value || null })} /></label>
    <label>预计耗时（分钟）<input type="number" min="1" max="1440" value={draft.estimatedMinutes ?? ""} onChange={(event) => setDraft({ ...draft, estimatedMinutes: event.target.value ? Number(event.target.value) : null })} onBlur={() => save(draft)} /></label>
    <label>单次投入（分钟）<input type="number" min="5" max="240" value={draft.sessionMinutes ?? ""} onChange={(event) => setDraft({ ...draft, sessionMinutes: event.target.value ? Number(event.target.value) : null })} onBlur={() => save(draft)} /></label>
    <label>优先级<select value={draft.priority ?? "normal"} onChange={(event) => save({ ...draft, priority: event.target.value as Task["priority"] })}><option value="low">低</option><option value="normal">普通</option><option value="high">高</option></select></label>
  </>;
}

function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) { return <div className="empty-state"><span>{icon}</span><strong>{title}</strong><p>{text}</p>{action}</div>; }
function RadioOption({ label, checked, onChange, icon }: { label: string; checked: boolean; onChange: () => void; icon: ReactNode }) { return <label className={checked ? "radio-option selected" : "radio-option"}>{icon}<input type="radio" name="appearance" checked={checked} onChange={onChange} /><strong>{label}</strong>{checked && <Check />}</label>; }
function Toggle({ label, note, checked, onChange }: { label: string; note: string; checked: boolean; onChange: (checked: boolean) => void }) { return <label className="toggle-row"><span><strong>{label}</strong><small>{note}</small></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /></label>; }

function makeSession(task: Task, date: string, start: string, requestedDuration?: number): ExecutionSession {
  const duration = Math.max(5, requestedDuration ?? task.sessionMinutes ?? task.estimatedMinutes ?? 60); const endTotal = timeMinutes(start) + duration;
  return { id: crypto.randomUUID(), taskId: task.id, localDate: date, endLocalDate: endTotal >= 1440 ? addDays(date, 1) : date, startLocal: start, endLocal: minutesTime(endTotal % 1440), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local", utcOffsetMinutes: -new Date().getTimezoneOffset(), status: "scheduled" };
}
function sessionFromAllocation(allocation: ScheduleAllocation): ExecutionSession {
  return { id: crypto.randomUUID(), taskId: allocation.taskId, localDate: allocation.localDate, endLocalDate: allocation.endLocal === "00:00" ? addDays(allocation.localDate, 1) : allocation.localDate, startLocal: allocation.startLocal, endLocal: allocation.endLocal, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local", utcOffsetMinutes: -new Date().getTimezoneOffset(), status: "scheduled" };
}
function moveSessionTo(session: ExecutionSession, date: string, start: string, duration: number): ExecutionSession { const end = timeMinutes(start) + duration; return { ...session, localDate: date, endLocalDate: end >= 1440 ? addDays(date, 1) : date, startLocal: start, endLocal: minutesTime(end % 1440), status: "scheduled" }; }
function progressEvent(task: Task, toProgress: number): ProgressEvent { return { id: crypto.randomUUID(), taskId: task.id, fromProgress: task.progress, toProgress, occurredAtUtc: new Date().toISOString() }; }
function sessionDuration(session: ExecutionSession) { const start = timeMinutes(session.startLocal); let end = timeMinutes(session.endLocal); if (session.endLocalDate !== session.localDate || end <= start) end += 1440; return end - start; }
function placementDateTime(date: string, minute: number) { const dayOffset = Math.floor(Math.max(0, minute) / 1440); return { date: addDays(date, dayOffset), time: minutesTime(Math.max(0, minute) % 1440) }; }
function positionStyle(start: string, end: string) { const top = timeMinutes(start) / 1440 * 100; let duration = timeMinutes(end) - timeMinutes(start); if (duration <= 0) duration += 1440; return { top: `${top}%`, height: `${Math.max(duration / 1440 * 100, 1.25)}%` }; }
function closestZoom(view: AppSettings["calendarView"], scale: number): AppSettings["calendarZoom"]["day"] {
  return (["compact", "standard", "detailed"] as const).reduce((closest, candidate) =>
    Math.abs(calendarScaleForZoom(view, candidate) - scale) < Math.abs(calendarScaleForZoom(view, closest) - scale) ? candidate : closest);
}
function sessionContains(session: ExecutionSession, now: Date) { const value = now.getTime(); return localSessionStart(session) <= value && value < localSessionEnd(session); }
function sessionEnded(session: ExecutionSession, now: Date) { return localSessionEnd(session) <= now.getTime(); }
function localSessionStart(session: ExecutionSession) { return sessionLocalInstant(session.localDate, session.startLocal, session.utcOffsetMinutes); }
function localSessionEnd(session: ExecutionSession) { return sessionLocalInstant(session.endLocalDate, session.endLocal, session.utcOffsetMinutes); }
function sessionLocalInstant(date: string, time: string, utcOffsetMinutes: number | null) {
  if (utcOffsetMinutes === null) return new Date(`${date}T${time}:00`).getTime();
  const [year, month, day] = date.split("-").map(Number); const [hour, minute] = time.split(":").map(Number);
  return Date.UTC(year, month - 1, day, hour, minute) - utcOffsetMinutes * 60_000;
}
function formatLocalClock(value: Date) { return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`; }
function actualRecordSlice(record: ExecutionRecord, date: string, now: Date) {
  const start = new Date(record.actualStartUtc); const end = record.actualEndUtc ? new Date(record.actualEndUtc) : now;
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return null;
  const startDate = toLocalDate(start); const endDate = toLocalDate(end);
  if (date < startDate || date > endDate || (date === endDate && formatLocalClock(end) === "00:00" && date !== startDate)) return null;
  const startMinute = date === startDate ? start.getHours() * 60 + start.getMinutes() : 0;
  const endMinute = date === endDate ? end.getHours() * 60 + end.getMinutes() : 1440;
  if (endMinute <= startMinute) return null;
  return {
    start: startMinute === 0 ? "00:00" : minutesTime(startMinute),
    end: endMinute === 1440 ? "24:00" : minutesTime(endMinute),
    style: { top: `${startMinute / 1440 * 100}%`, height: `${Math.max((endMinute - startMinute) / 1440 * 100, 1.25)}%` },
  };
}
function boundaryTime(minute: number) { return minute === 1440 ? "24:00" : minutesTime(minute); }
function rangeOverlaps(start: string, end: string, rangeStart: number, rangeEnd: number) { const startMinute = timeMinutes(start); let endMinute = timeMinutes(end); if (endMinute <= startMinute) endMinute = 1440; return startMinute < rangeEnd && endMinute > rangeStart; }
function timeMinutes(value: string) { const [hours, minutes] = value.split(":").map(Number); return hours * 60 + minutes; }
function minutesTime(total: number) { const value = ((total % 1440) + 1440) % 1440; return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`; }
function compareSessions(a: ExecutionSession, b: ExecutionSession) { return `${a.localDate}${a.startLocal}`.localeCompare(`${b.localDate}${b.startLocal}`); }
function compareDeadlines(a: Task, b: Task) { return (a.deadlineLocal ?? "9999").localeCompare(b.deadlineLocal ?? "9999"); }
function toLocalDate(date: Date) { const offset = date.getTimezoneOffset() * 60_000; return new Date(date.getTime() - offset).toISOString().slice(0, 10); }
function addDays(date: string, amount: number) { const value = new Date(`${date}T12:00:00`); value.setDate(value.getDate() + amount); return toLocalDate(value); }
function weekDates(anchor: string) { const date = new Date(`${anchor}T12:00:00`); const mondayOffset = (date.getDay() + 6) % 7; const monday = addDays(anchor, -mondayOffset); return Array.from({ length: 7 }, (_, index) => addDays(monday, index)); }
function addMonths(date: string, amount: number) { const value = new Date(`${date}T12:00:00`); const day = value.getDate(); value.setDate(1); value.setMonth(value.getMonth() + amount); value.setDate(Math.min(day, new Date(value.getFullYear(), value.getMonth() + 1, 0).getDate())); return toLocalDate(value); }
function monthDates(anchor: string) { const first = `${anchor.slice(0, 7)}-01`; const date = new Date(`${first}T12:00:00`); const mondayOffset = (date.getDay() + 6) % 7; const start = addDays(first, -mondayOffset); return Array.from({ length: 42 }, (_, index) => addDays(start, index)); }
function daysBetween(from: string, to: string) { return Math.round((new Date(`${to}T12:00:00`).getTime() - new Date(`${from}T12:00:00`).getTime()) / 86_400_000); }
function deadlineLabel(today: string, deadline: string) { const days = daysBetween(today, deadline); return days < 0 ? `逾期 ${Math.abs(days)} 天` : days === 0 ? "今天截止" : days === 1 ? "明天截止" : `还有 ${days} 天`; }
function weekday(date: string) { return new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(new Date(`${date}T12:00:00`)); }
function formatLongDate(date: string) { return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date(`${date}T12:00:00`)); }
function formatShortDate(date: string) { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(`${date}T12:00:00`)); }
function formatMonth(date: string) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(new Date(`${date}T12:00:00`)); }
function formatClock(iso: string) { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso)); }
function taskTitle(workspace: WorkspaceSnapshot, taskId: string) { return workspace.tasks.find((task) => task.id === taskId)?.title ?? "未知任务"; }
function projectProgress(tasks: Task[]) { const weighted = tasks.reduce((sum, task) => sum + task.progress * (task.estimatedMinutes ?? 60), 0); const total = tasks.reduce((sum, task) => sum + (task.estimatedMinutes ?? 60), 0); return total ? Math.round(weighted / total) : 0; }
function isEditable(target: EventTarget | null) { return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)); }
function applyDisplayPreferences(settings: AppSettings, systemDark: boolean, systemReduced: boolean) { const root = document.documentElement; root.dataset.theme = settings.appearance === "system" ? (systemDark ? "dark" : "light") : settings.appearance; root.dataset.motion = settings.motion === "system" ? (systemReduced ? "reduce" : "full") : settings.motion; root.style.fontSize = `${settings.scale}%`; }
function readError(error: unknown) { return error instanceof Error ? error.message : String(error); }
