import {
  ArchiveRestore, ArrowDown, ArrowUp, Bell, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleAlert,
  Clock3, Copy, Database, Diamond, Ellipsis, Eraser, FolderKanban, Home, Inbox, ListFilter, LocateFixed, Magnet, Palette, Pencil, Play, Plus, RotateCcw, Rows2, Rows3, Rows4,
  Settings2, Square, Upload, X, ChartNoAxesColumnIncreasing, Sparkles, Repeat2, Ban, Flag, ArrowRightToLine,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";

import { hasSubmittingEditor, hasUncommittedEditorDraft, useEditorSession, type EditorSessionApi } from "./hooks/useEditorSession";
import { seedCalendarPositions, useCalendarViewport, type CalendarPosition, type TimelineView } from "./hooks/useCalendarViewport";
import { DragSessionProvider, useDragSession, useDragSessionContext, type DragDecision, type DragSessionPreview } from "./hooks/useDragSession";
import { FloatingPanel } from "./components/ui/floating-panel";
import { DragTimePreview } from "./components/ui/drag-time-preview";
import { snapDelta, snapMinutesFor, snapTo } from "./lib/timelineDrag";
import { placementSettled, setPendingPlacement, usePendingPlacement } from "./lib/pendingPlacement";
import { OverlayHostProvider, useOptionalOverlayHost, useOverlayLayer } from "./components/ui/overlay-host";
import { Button } from "./components/ui/button";
import { RangeBar } from "./components/ui/range-bar";
import { NumberField } from "./components/ui/number-field";
import { DateField } from "./components/ui/date-field";
import { SelectField } from "./components/ui/select-field";
import { WeekdayPicker } from "./components/ui/weekday-picker";
import { TimeField } from "./components/ui/time-picker";
import { SettingsChoice, SettingsRow, SettingsSection, SettingsToggleRow } from "./components/settings/settings-ui";
import { CompletionBubble, type CompletionTarget } from "./components/completion/completion-bubble";
import { CarryOverLauncher } from "./components/today/carry-over";
import { DeadlinesPage } from "./components/deadlines/deadlines-page";
import { ReviewPage, type ReviewSelection } from "./components/review/review-page";
import { ProjectRail } from "./components/projects/project-rail";
import { parseCourseText, type CourseTaskDraft } from "./lib/courseImport";
import { COMPLETION_FIT_LABEL, isCompletionPromptTarget } from "./lib/completion";
import { buildProjectRail } from "./lib/projectRail";
import { extractBvid } from "./lib/bilibili";
import { habitDatesBetween, habitOccursOn } from "./lib/recurrence";
import { resolveScheduleWindow, windowEndDate, type ScheduleWindowMode } from "./lib/scheduleWindow";
import { buildSchedulePlan, type ScheduleAllocation, type ScheduleItem, type ScheduleUnscheduledItem } from "./lib/scheduling";
import { scheduleUnscheduledText } from "./lib/scheduleReasons";
import {
  addAvailability, addFold, availabilityBlocks, availabilitySegments, DEFAULT_FOLDED_RANGES, FOLDED_RANGE_MIN_MINUTES,
  foldedClock, foldedMinute, mergeAvailability, moveAvailability, normalizeFoldedRanges, removeAvailability, removeFold,
  replaceAvailability, snapMinute, type AvailabilityBlock, type AvailabilitySegment, type AvailabilitySnap,
} from "./lib/availability";
import { DEFAULT_DEADLINE_FILTER, type DeadlineFilter } from "./lib/deadlines";
import { carryOverTasks, createWorkspaceIndex, isPendingReview, isPendingReviewIn, isTaskCompleted, milestoneReached, milestoneSummary, orderedMilestoneTasks, projectProgress, projectTasksOf, type WorkspaceIndex } from "./lib/workspaceSelectors";
import { collapsedGapHeight, createCalendarTimeline, defaultSlotSlicesForWeekday, fullDayEffectiveRanges, timelineRangeFromKey, type CalendarTimeline } from "./lib/calendarTimeline";
import { blockOverlapping, CARD_LANE_GUTTER_PX, concurrentLayouts, dropImpact, placeableSessions, resizeChanges, resolveCalendarDrop, type CalendarDropIntent, type CalendarDropMode, type SessionPlacementChange } from "./lib/calendarPlacement";
import { calendarDayMarkers, calendarDaySummary, deadlineUrgency, deadlineUrgencyLabel, formatCompactMinutes, type CalendarMarker, type DeadlineUrgency } from "./lib/calendarSummary";
import {
  createNativeApi, EMPTY_WORKSPACE, type BackupInfo, type BackupPreview, type BilibiliVideo, type CompletionImage, type CompletionRecord, type CompletionRecordSummary,
  type ExecutionRecord, type ExecutionSession,
  type HabitOccurrence, type NativeApi, type ProgressEvent, type Project, type ProjectMilestone, type RecurringHabit, type Task, type TimeBlock, type WorkspaceSnapshot,
} from "./lib/native";
import {
  CALENDAR_SCALE_RANGE, calendarScaleForZoom, CHECK_IN_GRACE_MINUTES_PRESETS, CHECK_IN_GRACE_MINUTES_RANGE, createSettingsRepository,
  DAILY_BUDGET_MINUTES_RANGE, DEFAULT_SETTINGS, MINIMUM_SESSION_MINUTES_PRESETS, MINIMUM_SESSION_MINUTES_RANGE, type AppSettings, type DefaultTimeSlot, type FoldedRange, type PageId, type SettingsRepository,
} from "./lib/settings";

type SaveState = "saved" | "saving" | "unsaved";
type UndoOperation = { label: string; run: () => Promise<WorkspaceSnapshot> };
/** UI-SPEC §187：「拖拽提交后在底部显示**约 5 秒**的轻量结果提示和撤销操作」。 */
const UNDO_TOAST_MS = 5_000;
interface AppProps { settings?: SettingsRepository; native?: NativeApi }
/** 从截止事项页跳到项目页时要定位（或续排）的目标。 */
interface ProjectFocusRequest { projectId: string; milestoneId: string | null; action: "locate" | "continue" }
/**
 * 完成气泡关闭后留在底部的一次性提示（规格 0007 §3.2 的提示链）。
 * 每条都带自己的动作：保存后可以撤回、撤回后可以重新完成、跳过填写后可以补写。
 */
type CompletionNotice =
  | { kind: "saved"; taskId: string; recordId: string }
  | { kind: "reverted"; taskId: string; progress: number }
  | { kind: "skipped"; target: CompletionTarget };
/** 底部提示的停留时长；悬停或键盘聚焦时暂停，与撤销提示同一套规矩。 */
const COMPLETION_TOAST_MS = 8_000;

const pages: Array<{ id: PageId; label: string; icon: typeof Home }> = [
  { id: "today", label: "今日", icon: Home },
  { id: "calendar", label: "日历", icon: CalendarDays },
  { id: "deadlines", label: "截止", icon: Flag },
  { id: "projects", label: "项目", icon: FolderKanban },
  { id: "review", label: "回顾", icon: ChartNoAxesColumnIncreasing },
  { id: "data", label: "数据", icon: Database },
  { id: "appearance", label: "设置", icon: Settings2 },
];

export default function App({ settings: injectedSettings, native: injectedNative }: AppProps) {
  return <OverlayHostProvider><AppShell settings={injectedSettings} native={injectedNative} /></OverlayHostProvider>;
}

function AppShell({ settings: injectedSettings, native: injectedNative }: AppProps) {
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
  // 撤销提示是**短暂**的（UI-SPEC §187–188：底部约 5 秒，鼠标悬停或键盘聚焦时暂停计时），
  // 但撤销栈本身不随提示消失而清空 —— 提示没了以后 Ctrl+Z 依然可用。两者是分开的状态，
  // 否则要么提示永不消失，要么一次撤销就丢掉整个栈。
  const [undoToastOpen, setUndoToastOpen] = useState(false);
  const undoToastTimer = useRef<number | null>(null);
  const [finishing, setFinishing] = useState<ExecutionRecord | null>(null);
  const [taskPoolOpen, setTaskPoolOpen] = useState(true);
  const [poolOverlayOpen, setPoolOverlayOpen] = useState(false);
  // 面板一关 `<aside>` 就卸载，所以「展开了哪个项目」「需要关注展开没」必须放在 App 这一层：
  // 留在面板内部的话，收起再打开就回到默认，用户刚展开的项目等于白点一次。
  // `undefined` = 从没手动选过（继续用「第一个小项目」的默认规则），`null` = 明确全部收起。
  const [poolOpenProject, setPoolOpenProject] = useState<string | null | undefined>(undefined);
  // `null` = 没手动动过（按临期数量决定默认），true/false = 用户的选择。
  const [poolAttentionOpen, setPoolAttentionOpen] = useState<boolean | null>(null);
  // 判据必须与 styles.css 的 @media (max-width: 1199px) 完全一致：React 状态与 CSS 布局
  // 各用一套（innerWidth < 1200 vs 媒体查询）时，窗口尺寸刚变化、resize 监听尚未挂上的
  // 那个间隙会让两者分叉 —— React 仍以为窗口够宽而按内联渲染任务池，CSS 已按窄窗口把它
  // 定位成固定浮层，浮层盖住日历头部使点击被拦截。订阅时先同步一次，补上挂载与订阅之间
  // 错过的变更；matchMedia 的宽度与 CSS 媒体查询同源，不受滚动条宽度影响。
  const [narrowWindow, setNarrowWindow] = useState(() => window.matchMedia("(max-width: 1199px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1199px)");
    const sync = () => setNarrowWindow(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  // 自动排程只有一个入口状态：`taskId` 是单项入口的目标（打开后滚到该行并高亮），
  // `projectId` 是项目级入口的作用域（候选只列该项目、预选该项目的推荐组合）。
  // 两者都为 null 就是从任务池头打开的普通流程。
  const [scheduling, setScheduling] = useState<{ taskId: string | null; projectId: string | null } | null>(null);
  const [calendarFocusSessionId, setCalendarFocusSessionId] = useState<string | null>(null);
  // 截止事项页的会话状态（规格 §6.2）：筛选与焦点项只放 App 层内存 —— 同一会话内跨页
  // 返回仍然有效、应用重启后不恢复，也不写 Tauri Store、不与搜索文本一并保存。
  // 滚动位置用 ref 跟手记录，避免每滚一像素都重渲染整个应用壳。
  const [deadlinesView, setDeadlinesView] = useState<{ filter: DeadlineFilter; focusKey: string | null }>({ filter: DEFAULT_DEADLINE_FILTER, focusKey: null });
  const deadlinesScrollTop = useRef(0);
  // 回顾页的会话状态（规格 §7.4）：项目下钻与明细区目标只放 App 层内存 —— 同一会话内
  // 跨页返回仍然有效、应用重启后不恢复，也不写 Tauri Store。周期与锚点是**偏好**，
  // 走 `preferences.reviewPeriod`／`reviewAnchorDate`，不在这里重复一份。
  const [reviewView, setReviewView] = useState<{ projectId: string | null; selection: ReviewSelection | null }>({ projectId: null, selection: null });
  // 项目页选中的项目：与截止页/回顾页一样只放 App 层内存，同会话跨页返回有效。
  const [projectView, setProjectView] = useState<{ selectedId: string | null }>({ selectedId: null });
  const reviewScrollTop = useRef(0);
  // 任务编辑气泡的锚点：截止页与回顾页共用同一个气泡与编辑会话，不各造一份表单。
  const [taskEditorAnchor, setTaskEditorAnchor] = useState<{ taskId: string; anchorElement: HTMLElement | null } | null>(null);
  const [taskEditorBusy, setTaskEditorBusy] = useState(false);
  // 完成记录气泡（规格 0007）：全应用同一时刻只允许一个，所以状态挂在应用壳上，
  // 由 `updateProgress` 在提交成功后统一开启；各页面只负责交出自己的锚点。
  const [completionTarget, setCompletionTarget] = useState<CompletionTarget | null>(null);
  // 气泡期间刚完成的任务行要留在原分组里供锚定；关闭后先淡出再离开活动池。
  const [leavingTaskId, setLeavingTaskId] = useState<string | null>(null);
  const [completionNotice, setCompletionNotice] = useState<CompletionNotice | null>(null);
  const completionToastTimer = useRef<number | null>(null);
  const completionTargetRef = useRef<CompletionTarget | null>(null);
  completionTargetRef.current = completionTarget;
  const [projectFocus, setProjectFocus] = useState<ProjectFocusRequest | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  // 周视图「假想停靠后」的网格可用宽。只由外壳、侧栏、页内边距与池宽决定，
  // 不读当前日历视口：池子转覆盖后视口会变宽，读它会让判据在阈值两侧来回跳。
  const [weekGridAvailableWidth, setWeekGridAvailableWidth] = useState<number | null>(null);
  // 稳定索引在快照变更时重建一次（规格 §8）：列表渲染不再逐行扫描全量数组。
  const workspaceIndex = useMemo(() => createWorkspaceIndex(workspace), [workspace]);
  /**
   * 「待续」浮钮的数据：快照变了才重算，不跟着每次渲染走。
   *
   * 时钟取 `new Date()` 而不是订阅 `useCurrentTime` —— 那样整棵树每 30 秒重渲染一次，
   * 而这个判据比较的是「时段是否已经结束」，分钟级偏差不影响结果。
   */
  const carryOver = useMemo(() => carryOverTasks(workspaceIndex, new Date()), [workspaceIndex]);
  const workspaceRef = useRef(workspace); const preferencesRef = useRef(preferences);
  workspaceRef.current = workspace; preferencesRef.current = preferences;
  const saveRevision = useRef(0);
  const remindedSessions = useRef(new Set<string>());
  const startupSummaryShown = useRef(false);
  const retryAction = useRef<null | (() => Promise<void>)>(null);
  const markingRescue = useRef(new Set<string>());
  const poolResize = useRef<{ startX: number; startWidth: number } | null>(null);
  useLayoutEffect(() => {
    const shell = shellRef.current; const main = mainRef.current;
    const sidebar = shell?.querySelector<HTMLElement>(".sidebar");
    if (!shell || !main || !sidebar) return;
    const measure = () => {
      const shellWidth = shell.clientWidth; const sidebarWidth = sidebar.getBoundingClientRect().width;
      const mainStyle = getComputedStyle(main);
      const horizontalPadding = parseFloat(mainStyle.paddingLeft) + parseFloat(mainStyle.paddingRight);
      const poolWidth = parseFloat(getComputedStyle(shell).getPropertyValue("--pool-width")) || 320;
      setWeekGridAvailableWidth(shellWidth > 0 && sidebarWidth > 0 ? shellWidth - sidebarWidth - horizontalPadding - poolWidth - 6 : null);
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(shell);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [page, preferences.calendarView, preferences.scale, preferences.taskPoolWidth]);

  const reload = useCallback(async () => {
    try { setLoadError(null); setWorkspace(await native.getWorkspace()); }
    catch (error) { setLoadError(readError(error)); }
  }, [native]);

  useEffect(() => {
    let alive = true;
    Promise.all([settingsRepository.load(), native.getWorkspace()])
      .then(([savedPreferences, data]) => {
        if (!alive) return;
        // 把偏好里的日／周浏览位置播种进滚动仲裁入口的内存：内存是位置的单一真相，
        // 偏好是它的持久化镜像。恢复备份会整页重载，走的也是同一条路径，因此内存
        // 一定与恢复后的偏好一致，不会残留恢复前的位置。
        seedCalendarPositions(savedPreferences.calendarPositions);
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
    if (patch.lastPage) { setPage(patch.lastPage); setPoolOverlayOpen(false); }
  }, [persist]);

  /**
   * 「可用时间」弹窗的提交：defaultTimeSlots 与 foldedRanges 一起写，await 到写盘结果。
   *
   * 与其它偏好不同，这里必须让调用方拿到成败 —— 弹窗要「失败保留草稿、不关、给可重试错误」，
   * 而 persist 把错误吞进侧栏的「未保存／重试」里，弹窗看不到。
   */
  const saveAvailability = useCallback(async (next: { defaultTimeSlots: DefaultTimeSlot[]; foldedRanges: FoldedRange[] }) => {
    const merged = { ...preferencesRef.current, ...next };
    setPreferences(merged);
    const revision = ++saveRevision.current;
    setSaveState("saving"); setSaveError(null);
    try {
      await settingsRepository.save(merged);
      if (revision === saveRevision.current) { setSaveState("saved"); retryAction.current = null; }
    } catch (error) {
      // 失败时把内存里的值退回写盘前那一份：弹窗里的草稿还在，界面不该显示成已生效。
      setPreferences(preferencesRef.current);
      if (revision === saveRevision.current) { retryAction.current = () => saveAvailability(next); setSaveState("unsaved"); setSaveError(readError(error)); }
      throw error;
    }
  }, [settingsRepository]);
  /**
   * 用户滚动停止 300ms 后的日／周浏览位置写入偏好。
   *
   * 位置只在用户滚动时到这里（程序性滚动由 `useCalendarViewport` 的闸门挡住），
   * 写入沿用 `persist` 的同一条 `SettingsRepository.writeQueue`，不另建通道。
   * 值与当前偏好完全相同时不触发重渲染，也不重复写盘。
   */
  const rememberCalendarPosition = useCallback((view: TimelineView, position: CalendarPosition) => {
    setPreferences((current) => {
      const existing = current.calendarPositions[view];
      if (existing && existing.date === position.date && existing.minute === position.minute && existing.viewportRatio === position.viewportRatio) return current;
      const next = { ...current, calendarPositions: { ...current.calendarPositions, [view]: position } };
      void persist(next);
      return next;
    });
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

  const clearUndoToastTimer = useCallback(() => {
    if (undoToastTimer.current !== null) { window.clearTimeout(undoToastTimer.current); undoToastTimer.current = null; }
  }, []);
  const dismissUndoToastLater = useCallback(() => {
    clearUndoToastTimer();
    undoToastTimer.current = window.setTimeout(() => { undoToastTimer.current = null; setUndoToastOpen(false); }, UNDO_TOAST_MS);
  }, [clearUndoToastTimer]);
  useEffect(() => clearUndoToastTimer, [clearUndoToastTimer]);

  // 完成记录的底部提示与撤销提示同一套计时规矩：悬停或键盘聚焦时暂停，离开再继续。
  const clearCompletionToast = useCallback(() => {
    if (completionToastTimer.current !== null) { window.clearTimeout(completionToastTimer.current); completionToastTimer.current = null; }
  }, []);
  const dismissCompletionToastLater = useCallback(() => {
    clearCompletionToast();
    completionToastTimer.current = window.setTimeout(() => { completionToastTimer.current = null; setCompletionNotice(null); }, COMPLETION_TOAST_MS);
  }, [clearCompletionToast]);
  useEffect(() => clearCompletionToast, [clearCompletionToast]);

  const pushUndo = useCallback((operation: UndoOperation) => {
    setUndoStack((items) => [...items.slice(-9), operation]);
    setUndoToastOpen(true);
    dismissUndoToastLater();
  }, [dismissUndoToastLater]);
  const undo = useCallback(async () => {
    const operation = undoStack.at(-1); if (!operation) return;
    try {
      await commit(operation.run);
      const remaining = undoStack.slice(0, -1);
      setUndoStack(remaining);
      // 栈空了才收起提示；还有可撤销的操作就再显示一轮，连续拖拽可以逐步撤销。
      if (remaining.length === 0) { clearUndoToastTimer(); setUndoToastOpen(false); }
      else { setUndoToastOpen(true); dismissUndoToastLater(); }
    }
    catch { /* persistent banner owns the retry story */ }
  }, [commit, undoStack, clearUndoToastTimer, dismissUndoToastLater]);

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !isEditable(event.target)) {
        event.preventDefault(); void undo();
      }
    };
    window.addEventListener("keydown", handle); return () => window.removeEventListener("keydown", handle);
  }, [undo]);

  const createTask = async (title: string, extras: Partial<Task> = {}) => {
    const task: Task = {
      id: crypto.randomUUID(), projectId: null, title: title.trim(), progress: 0, status: "active",
      deadlineLocal: null, estimatedMinutes: null, sessionMinutes: null, priority: "normal", sortOrder: workspace.tasks.length,
      sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task", ...extras,
    };
    await commit(() => native.createTask(task));
    return task;
  };

  const updateProgress = async (task: Task, toProgress: number, anchor: HTMLElement | null = null) => {
    if (task.progress === toProgress) return;
    const fromProgress = task.progress;
    // 锚点矩形必须在提交**之前**量：提交会让这一行重排（任务池那行换成完成态），
    // 之后再 `getBoundingClientRect()` 拿到的是脱离文档流的全 0 矩形，气泡会飞到窗口左上角。
    const anchorRect = anchor?.getBoundingClientRect() ?? null;
    const event = progressEvent(task, toProgress);
    await commit(() => native.applyProgress(event));
    // 触发条件与「是否真的弹」分开判：口径同 §3.1，开关只决定打扰与否。
    if (!isCompletionPromptTarget(task, fromProgress, toProgress)) return;
    if (!preferences.completionRecordPrompt) return;
    openCompletion({
      taskId: task.id,
      progressEventId: event.id,
      completedAtUtc: event.occurredAtUtc,
      progressBefore: fromProgress,
      record: null,
      imageCount: 0,
      anchorElement: anchor,
      anchorRect,
    });
  };

  /**
   * 打开完成气泡。全应用同一时刻只有一个：气泡开着时另一个任务也到 100%，
   * 后者不叠开，只留在「今日完成」里等补写（规格 §3.1）。
   */
  const openCompletion = (target: CompletionTarget) => {
    if (completionTargetRef.current) return;
    completionTargetRef.current = target;
    clearCompletionToast();
    setCompletionTarget(target);
  };

  /**
   * 关闭气泡：任务行先以 160ms 淡出离开活动池，再留下底部提示。
   * `notice` 为跳过填写时的「补写」入口；保存与撤回各自带自己的动作。
   */
  const closeCompletion = (notice?: CompletionNotice) => {
    const target = completionTargetRef.current;
    completionTargetRef.current = null;
    setCompletionTarget(null);
    if (!target) return;
    setLeavingTaskId(target.taskId);
    window.setTimeout(() => setLeavingTaskId((current) => (current === target.taskId ? null : current)), 160);
    if (notice) { setCompletionNotice(notice); dismissCompletionToastLater(); }
  };

  const saveCompletion = async (target: CompletionTarget, record: CompletionRecord, images: CompletionImage[]) => {
    await commit(() => (target.record ? native.updateCompletion(record, images) : native.recordCompletion(record, images)));
  };

  /** 事后入口：从「今日完成」的一行打开补写／编辑（规格 §3.3）。 */
  const openCompletionForEvent = (task: Task, event: ProgressEvent, record: CompletionRecordSummary | null, anchor: HTMLElement | null) => {
    openCompletion({ taskId: task.id, progressEventId: event.id, completedAtUtc: event.occurredAtUtc, progressBefore: event.fromProgress, record, imageCount: record?.imageCount ?? 0, anchorElement: anchor, anchorRect: anchor?.getBoundingClientRect() ?? null });
  };

  /** 回顾明细里的「编辑」：记录自带它引用的完成事实，不需要再回查进度事件。 */
  const openCompletionForRecord = (record: CompletionRecordSummary, anchor: HTMLElement | null) => {
    openCompletion({ taskId: record.taskId, progressEventId: record.progressEventId, completedAtUtc: record.completedAtUtc, progressBefore: record.progressBefore, record, imageCount: record.imageCount, anchorElement: anchor, anchorRect: anchor?.getBoundingClientRect() ?? null });
  };

  /**
   * 撤回完成：原子地写一次回退进度事件并把记录标记为已撤回。
   * 还没保存过的填写只回退进度 —— 没有记录可标记，也就没有内容要删。
   */
  const revertCompletion = async (target: CompletionTarget) => {
    const event: ProgressEvent = {
      id: crypto.randomUUID(), taskId: target.taskId, fromProgress: 100, toProgress: target.progressBefore,
      occurredAtUtc: new Date().toISOString(),
    };
    await commit(() => (target.record ? native.revertCompletion(target.record.id, event) : native.applyProgress(event)));
    closeCompletion({ kind: "reverted", taskId: target.taskId, progress: target.progressBefore });
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
    // 预览与提交共用这一份落点/后移：输入集合统一为当天 scheduled|missed（F09），
    // 卡片中央松手一律按 overlap（F04/D5），不再有「什么都不发生」的分支。
    const resolved = resolveCalendarDrop({
      sessions: placeableSessions(workspace.executionSessions, intent.date),
      sourceSessionId: source?.id ?? "",
      sourceDuration: duration,
      pointerMinute: intent.startMinute,
      targetSessionId: intent.targetSessionId,
      targetRatio: intent.targetRatio ?? null,
      requestedMode: intent.mode,
      overlapLatched: intent.mode === "overlap",
      commit: true,
    });
    const at = placementDateTime(intent.date, resolved.startMinute);
    const placed = source ? moveSessionTo(source, at.date, at.time, duration) : makeSession(task!, at.date, at.time, duration);
    const updates = resolved.shifted.map((change) => { const nextAt = placementDateTime(intent.date, change.startMinute); return moveSessionTo(change.session, nextAt.date, nextAt.time, sessionDuration(change.session)); });
    if (source) updates.unshift(placed);
    const previous = [source, ...resolved.shifted.map((change) => change.session)].filter((item): item is ExecutionSession => Boolean(item));
    await commit(() => native.applyExecutionSessionChanges({ create: source ? [] : [placed], update: updates, deleteIds: [] }));
    pushUndo({ label: resolved.mode.startsWith("insert") ? "撤销插入排程" : resolved.mode === "overlap" ? "撤销同时安排" : source ? "撤销时间修改" : "撤销安排", run: () => native.applyExecutionSessionChanges({ create: [], update: previous, deleteIds: source ? [] : [placed.id] }) });
  };

  /**
   * 改时长的提交（B3／D12）。
   *
   * 「时长变化 + 它推走的后续时段」必须落在**一次**写入与**一个**撤销项里：分两次写会出现
   * 「时长已经变了、后面还没让位」的中间态，撤销也得分两次。让位集合在这里按同一份纯函数
   * 重算一次（与拖动中的预览同口径，输入集合都是 `placeableSessions`）。
   *
   * 没有让位时仍走原来那条单字段写入 —— 行为与 B2 完全一致，少一次整批事务。
   */
  const resizeCalendarSession = async (session: ExecutionSession, duration: number) => {
    const sessions = placeableSessions(workspace.executionSessions, session.localDate);
    const shifted = resizeChanges({ sessions, session, startMinute: timeMinutes(session.startLocal), duration });
    if (shifted.length === 0) { await moveSession(session, session.localDate, session.startLocal, duration); return; }
    const next = moveSessionTo(session, session.localDate, session.startLocal, duration);
    const updates = [next, ...shifted.map((change) => {
      const at = placementDateTime(session.localDate, change.startMinute);
      return moveSessionTo(change.session, at.date, at.time, sessionDuration(change.session));
    })];
    const previous = [session, ...shifted.map((change) => change.session)];
    await commit(() => native.applyExecutionSessionChanges({ create: [], update: updates, deleteIds: [] }));
    pushUndo({ label: "撤销时间修改", run: () => native.applyExecutionSessionChanges({ create: [], update: previous, deleteIds: [] }) });
  };

  const cancelSession = async (session: ExecutionSession) => {
    await commit(() => native.deleteExecutionSession(session.id));
    pushUndo({ label: "恢复本次安排", run: () => native.createExecutionSession(session) });
  };

  // ---------------------------------------------------------------------------
  // 拖拽（B2 起全仓唯一通道）：状态机放在 App 这一层
  // ---------------------------------------------------------------------------
  // 任务池与日历是兄弟节点：池行要能拉起同一个 session、日历要在拖动中画落点、
  // 池要在拖回时显示落区。只有把 Provider 罩在两者之上，才不必在组件之间传指针状态。
  const calendarRootRef = useRef<HTMLElement | null>(null);
  /** 日历把滚动仲裁的 begin/end 注册到这里：状态机不直接依赖 `useCalendarViewport`。 */
  const viewportDragRef = useRef<null | { begin: () => void; end: () => void }>(null);
  /**
   * 日视图的折叠条正在被拖拽悬停展开（B3／D13 的边缘滚动 gate）。
   *
   * 写它的是 `DayCalendarGrid` 那个既有的 `dragExpandedGapKey`（不新建第二套状态），读它的是
   * `useDragSession` 的 rAF 循环：展开期间速度直接 0，展开结束且指针离开折叠条后自动恢复。
   */
  const gapExpansionHoldRef = useRef(false);
  /**
   * 松手后先按落点画一份（`pendingPlacement`），等写入回来再交给事实。
   * 目标列与源列是兄弟组件，落地覆盖只能靠这份共享状态；失败时撤掉覆盖。
   */
  const commitCalendarDrag = async (intent: CalendarDropIntent) => {
    const session = workspace.executionSessions.find((item) => item.id === intent.sessionId);
    if (session) {
      const at = placementDateTime(intent.date, intent.startMinute);
      const atEnd = placementDateTime(intent.date, intent.startMinute + sessionDuration(session));
      setPendingPlacement({ sessionId: session.id, localDate: at.date, startLocal: at.time, endLocalDate: atEnd.date, endLocal: atEnd.time });
    }
    try { await placeCalendarItem(intent); } catch (error) { setPendingPlacement(null); throw error; }
  };
  /**
   * 松手时问一次「要不要先确认」——两条业务规则都在这里，状态机只负责停在 `deciding`：
   * ① 落点在时间块中央（§185/186）：三个选项，「仍然安排」只覆盖本次；
   * ② 插入把别的安排推出了可用时间窗口或推到新日期（§187/188）：确认才提交。
   *
   * B3 起改时长走同两条规则（§189 后半／§197／D12），两处判据换了对象：
   * 时间块看**拉长后的区间**覆盖了谁（不是指针位置 —— 拖底边时指针一直在卡片下缘），
   * 越界看 `preview.shifted`，也就是这次拉长推开的那一段。
   */
  const buildDragDecision = (input: { intent: CalendarDropIntent; preview: DragSessionPreview; point: { x: number; y: number } }): DragDecision | null => {
    const { intent, preview, point } = input;
    const resizing = preview.kind === "resize";
    const block = resizing
      ? blockOverlapping({ blocks: workspace.timeBlocks, date: preview.date, startMinute: preview.startMinute, duration: preview.duration })
      : preview.blockId ? workspace.timeBlocks.find((item) => item.id === preview.blockId) ?? null : null;
    if (block) {
      return {
        kind: "block", reason: "block", anchor: point, count: 1, dates: [], blockTitle: block.title, intent,
        // 改时长没有「放到时间块之后」：时长已经由手势定死，把它整体挪到块后面是另一件事。
        afterIntent: resizing ? null : { ...intent, startMinute: timeMinutes(block.endLocal), mode: "place", targetSessionId: "", targetRatio: null },
        resizeDuration: resizing ? preview.duration : null,
      };
    }
    // 「越出可用时间」只在**日视图的可用时间模式**里成立：那是唯一把非可用时间折成 44px 带子的
    // 视图，被推出去的安排当场就看不见了，才需要确认。周视图与全天模式全程可见，
    // 再问一次只是把每一次插入都变成两步（§188「没有跨时段的普通插入直接提交」）。
    const foldsDefaultSlots = preferences.calendarView === "day" && preferences.calendarDayMode === "defaultSlots";
    const weekdayNumber = new Date(`${intent.date}T12:00:00`).getDay();
    const defaultRanges = foldsDefaultSlots
      ? defaultSlotSlicesForWeekday(preferences.defaultTimeSlots, weekdayNumber).map((slot) => ({ start: timeMinutes(slot.start), end: timeMinutes(slot.end) }))
      : [];
    const impact = dropImpact({ date: intent.date, shifted: preview.shifted, defaultRanges });
    if (!impact) return null;
    return { kind: "boundary", reason: impact.reason, anchor: point, count: impact.affected.length, dates: impact.dates, blockTitle: "", intent, afterIntent: null, resizeDuration: resizing ? preview.duration : null };
  };
  const dragSession = useDragSession({
    rootRef: calendarRootRef,
    snapMinutes: preferences.snapMinutes,
    hourHeight: preferences.calendarScale[preferences.calendarView === "week" ? "week" : "day"],
    sessionsFor: (date) => placeableSessions(workspace.executionSessions, date),
    onCommit: commitCalendarDrag,
    onResize: resizeCalendarSession,
    onCancelSession: cancelSession,
    onDragStart: () => viewportDragRef.current?.begin(),
    onDragEnd: () => viewportDragRef.current?.end(),
    buildDecision: buildDragDecision,
    edgeScrollHoldRef: gapExpansionHoldRef,
  });

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

  const hasTaskPool = page === "today" || page === "calendar";
  // A5：首列随界面缩放长大（3.625rem），只有列下限与余量按 --calendar-ui-factor 倒数收缩。
  // 100% = 58 + 7×112 + 60 = 902；200% = 116 + 7×56 + 30 = 538（旧口径 451）。
  const weekGridDesignWidth = 58 * preferences.scale / 100 + 844 * (100 / preferences.scale);
  // 只有周视图参与「网格可用宽不足就转覆盖」；日视图维持 960–1199 的静态侧栏例外。
  const weekPoolNeedsOverlay = page === "calendar" && preferences.calendarView === "week" && weekGridAvailableWidth !== null && weekGridAvailableWidth < weekGridDesignWidth;
  const poolUsesOverlay = (narrowWindow && !(page === "calendar" && preferences.calendarView === "day")) || weekPoolNeedsOverlay;
  const showTaskPool = hasTaskPool && (poolUsesOverlay ? poolOverlayOpen : taskPoolOpen);
  // 日视图单列太宽：窄窗口时也让任务池保持侧栏形态，而不是转浮层
  const dayViewPool = page === "calendar" && preferences.calendarView === "day";
  // 覆盖面板的 Esc：只关覆盖态；宽窗口的静态侧栏仍用面板自己的关闭按钮。
  // 必须放在 loading 提前返回之前 —— 否则加载完成时 Hook 顺序会变。
  useEffect(() => {
    if (!showTaskPool) return;
    const closeOverlay = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector('[role="dialog"]')) return;
      if (poolUsesOverlay) setPoolOverlayOpen(false);
      else if (narrowWindow) setTaskPoolOpen(false);
    };
    window.addEventListener("keydown", closeOverlay);
    return () => window.removeEventListener("keydown", closeOverlay);
  }, [narrowWindow, poolUsesOverlay, showTaskPool]);

  if (loading) return <main className="loading-screen" aria-busy="true"><span className="spinner" aria-hidden="true" />正在恢复本地计划…</main>;

  const activeTasks = workspace.tasks.filter((task) => task.status === "active" && task.kind !== "habit");
  /**
   * 任务池的可见列表：气泡打开期间刚完成的那一行**保留在原分组里**供锚定，关闭后
   * 再跟随淡出留 160ms。保留的是完整的排序过滤结果，所以位置与分组都不变。
   */
  const heldCompletionIds = new Set([completionTarget?.taskId, leavingTaskId].filter((id): id is string => Boolean(id)));
  const poolTasks = heldCompletionIds.size === 0 ? activeTasks
    : workspace.tasks.filter((task) => task.kind !== "habit" && (task.status === "active" || heldCompletionIds.has(task.id)));
  const heldTasks = workspace.tasks.filter((task) => heldCompletionIds.has(task.id));
  const running = workspace.executionRecords.find((record) => !record.actualEndUtc) ?? null;

  const startPoolResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const pool = document.getElementById("task-pool");
    if (!pool) return;
    poolResize.current = { startX: event.clientX, startWidth: pool.getBoundingClientRect().width };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.dataset.poolResizing = "true";
  };
  const movePoolResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = poolResize.current; if (!drag) return;
    const width = Math.min(560, Math.max(260, Math.round(drag.startWidth - (event.clientX - drag.startX))));
    document.querySelector<HTMLElement>(".app-shell")?.style.setProperty("--pool-width", `${width}px`);
  };
  const endPoolResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!poolResize.current) return;
    poolResize.current = null;
    delete document.body.dataset.poolResizing;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const width = parseInt(document.querySelector<HTMLElement>(".app-shell")?.style.getPropertyValue("--pool-width") ?? "", 10);
    if (Number.isFinite(width) && width !== preferences.taskPoolWidth) updatePreferences({ taskPoolWidth: width });
  };
  const nudgePoolWidth = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = preferences.taskPoolWidth ?? Math.round(document.getElementById("task-pool")?.getBoundingClientRect().width ?? 320);
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const width = Math.min(560, Math.max(260, current + (event.key === "ArrowRight" ? 16 : -16)));
    updatePreferences({ taskPoolWidth: width });
  };

  const saveLabel = saveState === "saved" ? "已保存到本机" : saveState === "saving" ? "正在保存…" : "未保存，点击重试";
  return (
    <DragSessionProvider value={dragSession}>
    <div ref={shellRef} className={`app-shell ${showTaskPool ? "with-task-pool" : "without-task-pool"} ${dayViewPool && showTaskPool ? "day-view-pool" : ""} ${poolUsesOverlay ? "pool-overlay" : ""}`} style={preferences.taskPoolWidth ? ({ "--pool-width": `${preferences.taskPoolWidth}px` } as CSSProperties) : undefined}>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <aside className="sidebar">
        <div className="brand" aria-label="Daymark"><span className="brand-mark">D</span><strong>Daymark</strong></div>
        <nav aria-label="主导航">
          {pages.map(({ id, label, icon: Icon }) => (
            <button key={id} className={page === id ? "nav-item active" : "nav-item"} aria-current={page === id ? "page" : undefined}
              onClick={() => updatePreferences({ lastPage: id })}><Icon aria-hidden="true" size={20} /><span>{label}</span></button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button type="button" className="save-light" aria-label={saveLabel} aria-disabled={saveState !== "unsaved"} onClick={saveState === "unsaved" ? () => void retryAction.current?.() : undefined}>
            <span className={`save-dot ${saveState}`} aria-hidden="true" />
            <span className="save-tip" aria-hidden="true">{saveLabel}</span>
          </button>
        </div>
      </aside>

      <main id="main-content" ref={mainRef} className={`workspace-main ${page === "calendar" ? "calendar-workspace" : ""}`}>
        {saveError && <div className="error-banner" role="alert"><CircleAlert size={18} />未保存：{saveError}<Button variant="secondary" onClick={() => void retryAction.current?.()}>重试保存</Button></div>}
        {loadError && <div className="error-banner" role="alert"><CircleAlert size={18} />读取失败：{loadError}<Button variant="secondary" onClick={() => void reload()}>重试</Button></div>}
        {undoStack.length > 0 && undoToastOpen && <button className="undo-toast" onClick={() => void undo()} onMouseEnter={clearUndoToastTimer} onMouseLeave={dismissUndoToastLater} onFocus={clearUndoToastTimer} onBlur={dismissUndoToastLater}><RotateCcw size={16} />{undoStack.at(-1)?.label}（Ctrl+Z）</button>}

        {page === "today" && <TodayPage index={workspaceIndex} workspace={workspace} preferences={preferences} running={running} onStart={startSession} onFinish={setFinishing} onProgress={updateProgress} onGoCalendar={(session) => { if (session) openCalendarSession(session.id); else { setCalendarFocusSessionId(null); updatePreferences({ lastPage: "calendar" }); } }} onDelay={async (session) => { const now = new Date(); await moveSession(session, session.localDate, minutesTime(now.getHours() * 60 + now.getMinutes() + 10)); }} onSkip={async (session) => { const previous = session; await commit(() => native.updateExecutionSession({ ...session, status: "cancelled" })); pushUndo({ label: "恢复本次安排", run: () => native.updateExecutionSession(previous) }); }} onMove={moveSession} onRecordCompletion={openCompletionForEvent} onEditTask={(task, anchorElement) => setTaskEditorAnchor({ taskId: task.id, anchorElement })} />}
        {page === "calendar" && <CalendarPage workspace={workspace} index={workspaceIndex} preferences={preferences} focusSessionId={calendarFocusSessionId} onPreferences={updatePreferences} onCalendarPosition={rememberCalendarPosition} onSchedule={scheduleTask} onCreateTaskAt={createTaskAt} onMove={moveSession} rootRef={calendarRootRef} viewportDragRef={viewportDragRef} edgeScrollHoldRef={gapExpansionHoldRef} onProgress={updateProgress} onSkipReview={async (session) => { const previous = session; await commit(() => native.updateExecutionSession({ ...session, status: "missed" })); pushUndo({ label: "恢复待回顾时段", run: () => native.updateExecutionSession(previous) }); }} onCreateBlock={async (block) => { await commit(() => native.createTimeBlock(block)); }} onUpdateBlock={async (previous, next) => { await commit(() => native.updateTimeBlock(next)); pushUndo({ label: "恢复时间块", run: () => native.updateTimeBlock(previous) }); }} onDeleteBlock={async (id) => { await commit(() => native.deleteTimeBlock(id)); }} />}
        {page === "deadlines" && <DeadlinesPage index={workspaceIndex} filter={deadlinesView.filter} onFilterChange={(filter) => setDeadlinesView((current) => ({ ...current, filter }))}
          focusKey={deadlinesView.focusKey} onFocusKey={(key) => setDeadlinesView((current) => ({ ...current, focusKey: key }))}
          scrollRef={mainRef} scrollTop={deadlinesScrollTop}
          onEditTask={(task, anchorElement) => setTaskEditorAnchor({ taskId: task.id, anchorElement })}
          onArrangeTask={(task) => setScheduling({ taskId: task.id, projectId: null })}
          onOpenProject={(projectId, milestoneId) => { setProjectFocus({ projectId, milestoneId, action: "locate" }); updatePreferences({ lastPage: "projects" }); }}
          onContinueMilestone={(milestone) => { setProjectFocus({ projectId: milestone.projectId, milestoneId: milestone.id, action: "continue" }); updatePreferences({ lastPage: "projects" }); }} />}
        {page === "projects" && <ProjectsPage workspace={workspace} index={workspaceIndex} focus={projectFocus} onFocusHandled={() => setProjectFocus(null)} selectedProjectId={projectView.selectedId} onSelectProject={(selectedId) => setProjectView({ selectedId })} onEditTask={(task, anchorElement) => setTaskEditorAnchor({ taskId: task.id, anchorElement })} onCreateTask={async (task) => { await commit(() => native.createTask(task)); }} onArrange={(task) => setScheduling({ taskId: task.id, projectId: null })} onArrangeProject={(projectId) => setScheduling({ taskId: null, projectId })} onCreate={async (project, tasks) => { await commit(() => native.createProjectWithTasks(project, tasks)); }}
          onUpdateProject={async (project) => { await commit(() => native.updateProject(project)); }}
          onCreateMilestone={async (milestone) => { await commit(() => native.createProjectMilestone(milestone)); }}
          onUpdateMilestone={async (milestone) => { await commit(() => native.updateProjectMilestone(milestone)); }}
          onDeleteMilestone={async (milestone) => { await commit(() => native.deleteProjectMilestone(milestone.id)); pushUndo({ label: "恢复项目里程碑", run: () => native.createProjectMilestone(milestone) }); }}
          onProgress={updateProgress} onFetchBilibili={(bvid) => native.fetchBilibiliVideo(bvid)} />}
        {page === "review" && <ReviewPage index={workspaceIndex} preferences={preferences} onPreferences={updatePreferences}
          projectId={reviewView.projectId} onProjectId={(projectId) => setReviewView((current) => ({ ...current, projectId }))}
          selection={reviewView.selection} onSelection={(selection) => setReviewView((current) => ({ ...current, selection }))}
          scrollRef={mainRef} scrollTop={reviewScrollTop}
          onGoToday={() => updatePreferences({ lastPage: "today" })}
          onEditTask={(task, anchorElement) => setTaskEditorAnchor({ taskId: task.id, anchorElement })}
          onArrangeTask={(task) => setScheduling({ taskId: task.id, projectId: null })}
          onOpenProject={(projectId, milestoneId) => { setProjectFocus({ projectId, milestoneId, action: "locate" }); updatePreferences({ lastPage: "projects" }); }}
          onLoadCompletionImages={(recordId) => native.getCompletionImages(recordId)}
          onEditCompletion={openCompletionForRecord} />}
        {page === "data" && <DataPage native={native} />}
        {page === "appearance" && <SettingsPage preferences={preferences} onChange={updatePreferences} onSaveAvailability={saveAvailability} native={native} />}
        {hasTaskPool && !showTaskPool && <button className="task-pool-toggle" aria-label="打开任务池" onClick={() => poolUsesOverlay ? setPoolOverlayOpen(true) : setTaskPoolOpen(true)}><Inbox size={18} /><span>任务池</span></button>}
      </main>

      {/* 待续浮钮固定左下角：右下角是任务池浮钮的位置，两者不抢位（左＝回头看，右＝往前做）。 */}
      {page === "today" && <CarryOverLauncher entries={carryOver} today={toLocalDate(new Date())} onSchedule={(task) => setScheduling({ taskId: task.id, projectId: null })} />}

      {showTaskPool && (
        <>
        <section className="pool-splitter-region" aria-label="任务池宽度控制">
          <div className="pool-splitter" role="separator" aria-label="调整任务池宽度" aria-orientation="vertical"
            aria-valuemin={260} aria-valuemax={560} aria-valuenow={preferences.taskPoolWidth ?? 320} tabIndex={0}
            onKeyDown={nudgePoolWidth} onPointerDown={startPoolResize} onPointerMove={movePoolResize} onPointerUp={endPoolResize} />
        </section>
        <button className="task-pool-scrim" aria-label="关闭任务池浮层" onClick={() => poolUsesOverlay ? setPoolOverlayOpen(false) : setTaskPoolOpen(false)} />
        <TaskPool index={workspaceIndex} tasks={poolTasks} heldTasks={heldTasks} leavingTaskId={leavingTaskId} habits={workspace.recurringHabits} occurrences={workspace.habitOccurrences} autoScheduleAssist={preferences.autoScheduleAssist}
          openProject={poolOpenProject} onOpenProjectChange={setPoolOpenProject} attentionOpen={poolAttentionOpen} onAttentionOpenChange={setPoolAttentionOpen}
          onCreate={createTask} onUpdate={async (task) => { await commit(() => native.updateTask(task)); }} onProgress={updateProgress} onClose={() => poolUsesOverlay ? setPoolOverlayOpen(false) : setTaskPoolOpen(false)} onAutoSchedule={() => setScheduling({ taskId: null, projectId: null })} onCreateHabit={createHabit} onScheduleHabit={scheduleHabit} onSkipHabit={skipHabit} />
        </>
      )}

      {finishing && <FinishDialog record={finishing} task={workspace.tasks.find((task) => task.id === finishing.taskId)!}
        onClose={() => setFinishing(null)} onSubmit={async (progress, note, actualEndUtc) => {
          const task = workspace.tasks.find((item) => item.id === finishing.taskId)!;
          const fromProgress = task.progress;
          const event = progressEvent(task, progress);
          await commit(() => native.finishExecution(finishing.id, actualEndUtc, note, event));
          setFinishing(null);
          // 模态对话框不能与气泡同帧叠开：先关掉对话框，再把气泡锚到今日页的当前行（§3.1）。
          if (!isCompletionPromptTarget(task, fromProgress, progress) || !preferences.completionRecordPrompt) return;
          // 锚点从 `.now-card` 换成时间轴上的当前行 —— 改版后不再有「现在」大卡。
          const card = document.querySelector<HTMLElement>(".today-row.is-current");
          openCompletion({ taskId: task.id, progressEventId: event.id, completedAtUtc: event.occurredAtUtc, progressBefore: fromProgress, record: null, imageCount: 0, anchorElement: card, anchorRect: card?.getBoundingClientRect() ?? null });
        }} />}
      {/* 完成记录气泡：任务池、项目、今日与日历都汇到这一个实例，同一时刻只开一个。 */}
      {completionTarget && (() => {
        const task = workspaceIndex.tasksById.get(completionTarget.taskId);
        return task ? <CompletionBubble
          task={task}
          target={completionTarget}
          onDismiss={(skipped) => closeCompletion(skipped ? { kind: "skipped", target: completionTarget } : undefined)}
          onSave={(record, images) => saveCompletion(completionTarget, record, images)}
          onSaved={(record) => closeCompletion({ kind: "saved", taskId: record.taskId, recordId: record.id })}
          onRevert={() => revertCompletion(completionTarget)}
          onOpenExisting={() => {
            // 后端报告这次完成已有记录：把内容读回来转成编辑态，不弹错误横幅（§4.3）。
            const existing = workspaceRef.current.completionRecords.find((item) => item.progressEventId === completionTarget.progressEventId) ?? null;
            setCompletionTarget({ ...completionTarget, record: existing, imageCount: existing?.imageCount ?? 0 });
          }}
        /> : null;
      })()}
      {completionNotice && (() => {
        const noticeTask = completionNotice.kind === "skipped"
          ? workspaceIndex.tasksById.get(completionNotice.target.taskId) ?? null
          : workspaceIndex.tasksById.get(completionNotice.taskId) ?? null;
        const label = completionNotice.kind === "saved" ? "完成记录已保存"
          : completionNotice.kind === "reverted" ? `已撤回完成，进度回到 ${completionNotice.progress}%`
            : `${noticeTask?.title ?? "这项完成"}还没记录`;
        // 容器是 `role="status"` 的活区（保存／撤回的结果要读出来），动作是里面那个真按钮。
        // 把两者合成一个 `<button role="status">` 会同时踩中 axe 的两条：按钮不许改写成状态域，
        // 而改写之后它的可访问名不再来自内容 —— 读屏就拿到一个没有名字的按钮。
        return <div className="completion-toast" role="status"
          onMouseEnter={clearCompletionToast} onMouseLeave={dismissCompletionToastLater} onFocus={clearCompletionToast} onBlur={dismissCompletionToastLater}>
          {completionNotice.kind === "reverted" ? <RotateCcw size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
          <span>{label}</span>
          <button type="button" className="completion-toast-action" onClick={(event) => {
            const anchor = event.currentTarget;
            clearCompletionToast();
            setCompletionNotice(null);
            if (completionNotice.kind === "saved") {
              const record = workspaceRef.current.completionRecords.find((item) => item.id === completionNotice.recordId);
              if (record) void revertCompletion({ taskId: record.taskId, progressEventId: record.progressEventId, completedAtUtc: record.completedAtUtc, progressBefore: record.progressBefore, record, imageCount: record.imageCount, anchorElement: anchor, anchorRect: anchor.getBoundingClientRect() });
              return;
            }
            if (completionNotice.kind === "reverted") {
              if (noticeTask) void updateProgress(noticeTask, 100, anchor);
              return;
            }
            openCompletion({ ...completionNotice.target, anchorElement: anchor, anchorRect: anchor.getBoundingClientRect() });
          }}>
            {completionNotice.kind === "saved" ? "撤回完成" : completionNotice.kind === "reverted" ? "重新完成" : "补写"}
          </button>
        </div>;
      })()}
      {scheduling && <SchedulePanel workspace={workspace} index={workspaceIndex} preferences={preferences} target={scheduling}
        onClose={() => setScheduling(null)}
        onOpenSettings={() => { setScheduling(null); updatePreferences({ lastPage: "appearance" }); }}
        onApply={async (sessions, occurrences) => { await commit(() => native.applyScheduleDraft(sessions, occurrences)); pushUndo({ label: "撤销本次自动排程", run: () => native.deleteExecutionSessions(sessions.map((session) => session.id)) }); setScheduling(null); }} />}
      {/* 截止页与回顾页共用的任务编辑气泡：复用与任务池完全相同的编辑会话，不复制表单。 */}
      {taskEditorAnchor && (() => { const task = workspaceIndex.tasksById.get(taskEditorAnchor.taskId); return task ? <FloatingPanel className="task-editor-panel" label={`编辑任务 ${task.title}`} anchorElement={taskEditorAnchor.anchorElement} busy={taskEditorBusy} closeOnOutsideClick onClose={() => setTaskEditorAnchor(null)}><div className="task-editor-fields">
        <h2>编辑任务</h2><TaskEditorFields task={task} projects={workspace.projects} onUpdate={async (next) => { await commit(() => native.updateTask(next)); setTaskEditorAnchor(null); }} onCancel={() => setTaskEditorAnchor(null)} onPhase={setTaskEditorBusy} />
      </div></FloatingPanel> : null; })()}
      {/* 松手后的确认气泡（§185/§187/§197）：状态机停在 `deciding`，这里只负责文案与出口。
          改时长侵入时间块只给「仍然安排／取消」两个出口（没有「之后」语义，D12）。 */}
      {dragSession.decision && (() => {
        const decision = dragSession.decision;
        return <FloatingPanel kind="action" className="drag-decision-panel" label={decision.kind === "block" ? "重叠确认" : "越界确认"}
          anchor={dragDecisionAnchor(decision)} closeOnOutsideClick onClose={dragSession.dismissDecision}>
          <div className="drag-decision">
            <strong>{decision.kind === "block" ? `与时间块「${decision.blockTitle}」同一时段` : `会影响 ${decision.count} 项已有安排`}</strong>
            <p>{decision.kind === "block"
              ? "仍然安排会与时间块重叠；时间块与任务各自独立，不会合并数据。"
              : decision.reason === "cross-day"
                ? `它们会被推到 ${decision.dates.map(formatShortDate).join("、")}。`
                : "它们会被推出可用时间。"}</p>
            <div className="drag-decision-actions">
              {decision.kind === "block" ? <>
                <button type="button" className="button-primary" onClick={dragSession.confirmDecision}>仍然安排</button>
                {/* 改时长没有「放到时间块之后」：时长已经由手势定死，整体挪到块后面是另一件事（D12）。 */}
                {decision.afterIntent && <button type="button" className="button-quiet" onClick={dragSession.chooseAfterBlock}>放到时间块之后</button>}
                <button type="button" className="button-quiet" onClick={dragSession.dismissDecision}>取消</button>
              </> : <>
                <button type="button" className="button-primary" onClick={dragSession.confirmDecision}>确认</button>
                <button type="button" className="button-quiet" onClick={dragSession.dismissDecision}>取消</button>
              </>}
            </div>
          </div>
        </FloatingPanel>;
      })()}
    </div>
    </DragSessionProvider>
  );
}

/**
 * 确认气泡的锚点：优先取**落点框**的矩形，让气泡贴着它出现（§187「在落点附近」）。
 *
 * 不能直接传松手点那个 `DOMRect(x, y, 0, 0)`：`FloatingPanel` 把零尺寸矩形当成
 * 「没有锚点」，会退回 `activeElement`（拖完松手时是任务池里的输入框），气泡于是
 * 飘到面板另一头（实测偏出 340px）。所以退回分支也给一个 1×1 的矩形。
 */
function dragDecisionAnchor(decision: DragDecision): DOMRect {
  const ghost = typeof document === "undefined" ? null : document.querySelector<HTMLElement>(".calendar-drag-preview")?.getBoundingClientRect() ?? null;
  if (ghost && ghost.width > 0 && ghost.height > 0) return ghost;
  return new DOMRect(decision.anchor.x, decision.anchor.y, 1, 1);
}

function PageHeader({ eyebrow, title, actions, className, titleId, titleLabel, titleLive }: {
  eyebrow?: string; title: ReactNode; actions?: ReactNode; className?: string; titleId?: string; titleLabel?: string; titleLive?: boolean;
}) {
  return <header className={["page-header", className].filter(Boolean).join(" ")}>
    <div className="page-header-title">{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1 id={titleId} aria-label={titleLabel} title={titleLabel} aria-live={titleLive ? "polite" : undefined}>{title}</h1></div>
    <div className="header-actions">{actions}</div>
  </header>;
}

/**
 * 今日页（2026-10-28 改版）。
 *
 * **一条时间轴承担全部**：已过的时段留在原位、当前时段整行放大、空档由一条「现在」行交代。
 * 此前同一批 `executionSessions` 被渲染了三遍 —— `nowState` 大卡、待回顾卡片、时间线各一遍，
 * 首屏于是把同一件事说了两三次。现在只有一份。
 *
 * 三条约定：
 * - 已过的时段**不写 `missed`**、不做裁决：留在轴上显示「已过」，可以更新进度，也可以
 *   一键挪到明天同一时间（行尾两个图标按钮：顺延／去日历改时间）。
 *   原来的「本次未推进」按钮从今日页移除（日历页的待回顾流程保持不变）。
 * - 当前行是唯一的「现在」模块：标题、剩余时间、进度、主操作都在行内。
 * - 右列只放「今天之外」的事实：临期（只写名字与天数，动作在气泡里）和今天完成。
 */
function TodayPage({ index, workspace, preferences, running, onStart, onFinish, onProgress, onGoCalendar, onDelay, onSkip, onMove, onRecordCompletion, onEditTask }: {
  /** 共享稳定索引；时段与任务查找都走同一处，不另写一份。 */
  index: WorkspaceIndex;
  workspace: WorkspaceSnapshot; preferences: AppSettings; running: ExecutionRecord | null;
  onStart: (session: ExecutionSession) => Promise<void>; onFinish: (record: ExecutionRecord) => void;
  onProgress: (task: Task, value: number, anchor: HTMLElement | null) => Promise<void>; onGoCalendar: (session?: ExecutionSession) => void;
  onDelay: (session: ExecutionSession) => Promise<void>; onSkip: (session: ExecutionSession) => Promise<void>;
  onMove: (session: ExecutionSession, localDate: string, startLocal: string) => Promise<void>;
  onRecordCompletion: (task: Task, event: ProgressEvent, record: CompletionRecordSummary | null, anchor: HTMLElement) => void;
  onEditTask: (task: Task, anchorElement: HTMLElement) => void;
}) {
  const now = useCurrentTime();
  const today = toLocalDate(now);
  const nowMs = now.getTime();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const sessions = workspace.executionSessions.filter((item) => item.localDate <= today && item.endLocalDate >= today && item.status === "scheduled").sort(compareSessions);
  // 正在记录的那一段也算「现在」：提前开始、或时段已经到点但还没结束本次时，
  // 时钟不一定落在这个区间里，但「结束本次」必须始终有出口。
  const runningSessionId = running?.sessionId ?? null;
  const current = sessions.find((session) => sessionContains(session, now) || session.id === runningSessionId) ?? null;
  const next = sessions.find((session) => localSessionStart(session) > nowMs) ?? null;
  const passedCount = sessions.filter((session) => session !== current && localSessionEnd(session) <= nowMs).length;
  const rescue = preferences.checkInEnabled && preferences.rescuePromptsEnabled && !running
    ? workspace.executionSessions.find((session) => (session.status === "scheduled" || session.status === "missed") && session.localDate === today && workspace.rescuePromptedSessionIds.includes(session.id) && !workspace.executionRecords.some((record) => record.sessionId === session.id) && timeMinutes(session.startLocal) + preferences.checkInGraceMinutes < nowMinutes)
    : undefined;
  const due = workspace.tasks.filter((task) => task.status === "active" && task.deadlineLocal && daysBetween(today, task.deadlineLocal) <= 7).sort(compareDeadlines);
  const todayEvents = workspace.progressEvents.filter((event) => toLocalDate(new Date(event.occurredAtUtc)) === today);
  const completedToday = (() => {
    // 每个任务只看**最新一次**「到 100」：撤回再完成时，站着的事实是后一次。
    const latest = new Map<string, { task: Task; event: ProgressEvent }>();
    for (const event of todayEvents) {
      if (event.toProgress !== 100) continue;
      const task = index.tasksById.get(event.taskId);
      // 已撤回的任务回到活动池，不在「今日完成」里冒充一次完成（规格 §3.3）。
      if (!task || task.kind === "habit" || task.progress !== 100) continue;
      const existing = latest.get(event.taskId);
      if (!existing || event.occurredAtUtc > existing.event.occurredAtUtc) latest.set(event.taskId, { task, event });
    }
    return [...latest.values()]
      .map((entry) => ({ ...entry, record: workspace.completionRecords.find((record) => record.progressEventId === entry.event.id) ?? null }))
      .sort((left, right) => right.event.occurredAtUtc.localeCompare(left.event.occurredAtUtc));
  })();
  const runningMinutes = running ? Math.max(1, Math.round((nowMs - new Date(running.actualStartUtc).getTime()) / 60_000)) : 0;
  /** 今天有没有「已经排进轴上」的任务 —— 临期列用它决定要不要打「今天」角标。 */
  const scheduledTaskIds = new Set(sessions.map((session) => session.taskId));

  /** 临时层：临期条目。同一时刻只会有一个。 */
  const [dueAnchor, setDueAnchor] = useState<{ taskId: string; element: HTMLElement } | null>(null);
  const dueTask = dueAnchor ? index.tasksById.get(dueAnchor.taskId) ?? null : null;
  /** 从临期气泡「在轴上查看」跳过去的那一段，会在轴上亮 4 秒。 */
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  useEffect(() => () => { if (flashTimer.current) window.clearTimeout(flashTimer.current); }, []);

  /**
   * 进入今日页时把当前行带进视野。
   *
   * 去掉顶部「现在」模块之后，当前行不再天然在首屏：一天排八段时它可能落在第五行。
   * 只在**看不清**它的时候才滚（露出不足 64px 就算看不清），已经能看见就不动 ——
   * 用户主动滚到别处、隔半分钟回来时不会被反复拽回来。
   */
  const currentRowRef = useRef<HTMLLIElement | null>(null);
  const currentId = current?.id ?? null;
  useEffect(() => {
    const node = currentRowRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const visible = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
    if (visible >= Math.min(rect.height, 64)) return;
    const reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    node.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  }, [currentId, today]);

  /**
   * 「在轴上查看」：滚到那一段，并让它亮 4 秒。
   *
   * 不走 `CSS.escape` —— 用属性逐行比对，测试环境（jsdom）也稳。
   */
  const revealSession = (session: ExecutionSession) => {
    const node = [...document.querySelectorAll<HTMLElement>(".today-row")].find((row) => row.dataset.sessionId === session.id);
    if (!node) return;
    const reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // `?.` 兜一下 jsdom：单元测试环境里没有 scrollIntoView，高亮本身并不依赖滚动。
    node.scrollIntoView?.({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
    setFlashId(session.id);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashId(null), 4000);
  };
  /** 行类名统一出口：闪一下的那个状态也在这里拼，省得三处各写一遍。 */
  const rowClass = (session: ExecutionSession, extra?: string) => ["today-row", extra, flashId === session.id ? "is-flash" : ""].filter(Boolean).join(" ");
  /** 已过的行：留在原位、保持可读，但不与当前行争视觉重心。 */
  const rowPast = (session: ExecutionSession) => {
    const task = index.tasksById.get(session.taskId);
    if (!task) return null;
    return <li key={session.id} data-session-id={session.id} className={rowClass(session, "is-past")}>
      <time dateTime={`${session.localDate}T${session.startLocal}`}><strong>{session.startLocal}</strong><span>{session.endLocal}</span></time>
      <span className="today-row-rail" aria-hidden="true"><span className="today-row-dot" /></span>
      <div className="today-row-body">
        <div className="today-row-line">
          <strong className="today-row-title" title={task.title}>{task.title}</strong>
          {/* 「已过」也不再用 chip 说：时钟已经翻过这一行，弱化的标题与空心点就是事实本身。 */}
          <RowProgress task={task} onCommit={onProgress} />
          
          <div className="today-row-acts">
            <button type="button" className="icon-action" aria-label={`把 ${task.title} 挪到明天同一时间`} title="挪到明天同一时间" onClick={() => void onMove(session, addDays(today, 1), session.startLocal)}><ArrowRightToLine size={16} aria-hidden="true" /></button>
            <button type="button" className="icon-action" aria-label={`在日历中查看 ${task.title}`} title="在日历中查看" onClick={() => onGoCalendar(session)}><CalendarDays size={16} aria-hidden="true" /></button>
          </div>
        </div>
      </div>
    </li>;
  };

  /** 当前行 = 唯一的「现在」模块：两行式，主操作落在行内。 */
  const rowCurrent = (session: ExecutionSession) => {
    const task = index.tasksById.get(session.taskId);
    if (!task) return null;
    const isRunning = running?.sessionId === session.id;
    const urgent = task.deadlineLocal && daysBetween(today, task.deadlineLocal) <= 7;
    return <li key={session.id} data-session-id={session.id} className={rowClass(session, "is-current")} ref={currentRowRef}>
      <time dateTime={`${session.localDate}T${session.startLocal}`}><strong>{session.startLocal}</strong><span>{session.endLocal}</span></time>
      <span className="today-row-rail" aria-hidden="true"><span className="today-row-dot" /></span>
      <div className="today-row-body">
        <div className="today-row-line">
          <strong className="today-row-title" title={task.title}>{task.title}</strong>
          {/* 「现在」不再用 chip 说 —— 整行的橙色底与实心点已经在说。只有「正在记录」是额外事实。 */}
          {isRunning && <span className="today-chip is-now">正在记录</span>}
          {urgent && <span className="today-chip is-due"><Flag size={11} aria-hidden="true" /><span className="deadline-long">{deadlineLabel(today, task.deadlineLocal!)}</span><span className="deadline-short">{deadlineLabelShort(today, task.deadlineLocal!)}</span></span>}
          <span className="today-remain">{isRunning ? `已进行 ${formatDuration(runningMinutes)}` : <>剩 <Countdown target={localSessionEnd(session)} /></>}</span>
        </div>
        <div className="today-row-line">
          <RowProgress task={task} onCommit={onProgress} />

          {isRunning
            ? <Button variant="primary" onClick={() => onFinish(running!)}><Square size={16} aria-hidden="true" />结束本次</Button>
            : preferences.checkInEnabled
              ? <Button variant="primary" onClick={() => void onStart(session)}><Play size={16} aria-hidden="true" />开始</Button>
              : <span className="muted-chip">开始／结束记录未开启</span>}
          <button type="button" className="icon-action" aria-label={`在日历中查看 ${task.title}`} title="在日历中查看" onClick={() => onGoCalendar(session)}><CalendarDays size={16} aria-hidden="true" /></button>
        </div>
      </div>
    </li>;
  };

  /** 还没开始的行：保持紧凑，提前开始直接落在这一行上。 */
  const rowFuture = (session: ExecutionSession) => {
    const task = index.tasksById.get(session.taskId);
    if (!task) return null;
    const urgent = task.deadlineLocal && daysBetween(today, task.deadlineLocal) <= 7;
    return <li key={session.id} data-session-id={session.id} className={rowClass(session)}>
      <time dateTime={`${session.localDate}T${session.startLocal}`}><strong>{session.startLocal}</strong><span>{session.endLocal}</span></time>
      <span className="today-row-rail" aria-hidden="true"><span className="today-row-dot" /></span>
      <div className="today-row-body">
        <div className="today-row-line">
          <strong className="today-row-title" title={task.title}>{task.title}</strong>
          {urgent && <span className="today-chip is-due"><Flag size={11} aria-hidden="true" /><span className="deadline-long">{deadlineLabel(today, task.deadlineLocal!)}</span><span className="deadline-short">{deadlineLabelShort(today, task.deadlineLocal!)}</span></span>}
          <RowProgress task={task} onCommit={onProgress} />
          
          <div className="today-row-acts">
            {preferences.checkInEnabled && <button type="button" className="today-quiet" aria-label={`提前开始 ${task.title}`} title="提前开始" onClick={() => void onStart(session)}><Play size={13} aria-hidden="true" /><span className="today-quiet-label">提前开始</span></button>}
            <button type="button" className="icon-action" aria-label={`在日历中查看 ${task.title}`} title="在日历中查看" onClick={() => onGoCalendar(session)}><CalendarDays size={16} aria-hidden="true" /></button>
          </div>
        </div>
      </div>
    </li>;
  };

  /** 现在落在空档里：这一行就是「现在」，交代还要等多久。 */
  const gapRow = () => <li key="today-gap" className="today-gap-row">
    <time><strong>{formatLocalClock(now)}</strong><span>现在</span></time>
    <span className="today-row-rail" aria-hidden="true"><span className="today-row-dot" /></span>
    <div className="today-row-body">
      {/* 单行：标题、剩余时间紧挨着，「添加」靠右并随行居中 —— 空档不是任务，撑两行只会显得有事要办。 */}
      <div className="today-row-line">
        <strong className="today-gap-title">无任务</strong>
        <span className="today-gap-note">{next ? <>剩余 <Countdown target={localSessionStart(next)} /></> : "今天剩下的时间都空着"}</span>
        <Button variant="primary" onClick={() => onGoCalendar()}>添加</Button>
      </div>
    </div>
  </li>;
  const rows: ReactNode[] = [];
  let gapPlaced = false;
  for (const session of sessions) {
    if (!gapPlaced && !current && localSessionStart(session) > nowMs) { rows.push(gapRow()); gapPlaced = true; }
    rows.push(session === current ? rowCurrent(session) : localSessionEnd(session) <= nowMs ? rowPast(session) : rowFuture(session));
  }
  if (!gapPlaced && !current) rows.push(gapRow());

  return <section className="page-stack today-page" aria-labelledby="today-title">
    <header className="page-header today-header">
      <h1 id="today-title" className="today-date">{formatLongDate(today)}</h1>
      <div className="header-actions">
        <Button onClick={() => onGoCalendar()}><CalendarDays size={16} aria-hidden="true" />打开日历</Button>
      </div>
    </header>
    {rescue && <section className="rescue-card" aria-labelledby="rescue-title"><div className="rescue-main"><span className="eyebrow">重新安排一下</span><h2 id="rescue-title">{taskTitle(workspace, rescue.taskId)}</h2><p>原定 {rescue.startLocal} 开始。选择一个现在容易做到的下一步。</p></div><div className="rescue-actions"><Button variant="primary" onClick={() => void onStart(rescue)}><Play size={16} aria-hidden="true" />现在开始</Button><Button onClick={() => void onDelay(rescue)}>延后 10 分钟</Button><Button onClick={() => onGoCalendar()}>重新选择时间</Button><Button onClick={() => void onSkip(rescue)}><Ban size={16} aria-hidden="true" />本次跳过</Button></div></section>}
    <div className="today-layout">
      <div className="today-axis-column">
        {/* 段数注脚放在卡片外、贴在卡片右上角：它是这张卡的说明，不是卡里的内容。 */}
        <div className="today-axis-count"><span>{sessions.length} 段{passedCount > 0 ? ` · ${passedCount} 段已过` : ""}</span></div>
        <section className="surface-card today-axis" aria-label="今天的时间轴">
          {sessions.length
            ? <ol className="today-timeline">{rows}</ol>
            : <EmptyState icon={<Clock3 />} title="今天的时间线是空的" text="任务不会因此消失。从任务池拖入，或打开日历安排一个时段。" action={<Button onClick={() => onGoCalendar()}>打开日历</Button>} />}
          {current && <button type="button" className="today-gap-hint" onClick={() => onGoCalendar()}><Plus size={14} aria-hidden="true" />添加任务</button>}
        </section>
      </div>
      <aside className="today-side" aria-label="今天之外">
        {due.length > 0 && <section className="surface-card today-due" aria-labelledby="today-due-title">
          <div className="today-card-head"><h2 id="today-due-title">临期</h2><span>{due.length}</span></div>
          <div className="today-due-list">{due.map((task) => {
            const urgency = deadlineUrgency(task.deadlineLocal!, today);
            return <button type="button" key={task.id} className={`today-due-item is-${urgency}`}
              aria-label={`${task.title}，${deadlineLabel(today, task.deadlineLocal!)}`}
              onClick={(click) => setDueAnchor({ taskId: task.id, element: click.currentTarget })}>
              <span className="today-due-name"><Flag size={12} aria-hidden="true" /><span title={task.title}>{task.title}</span>{scheduledTaskIds.has(task.id) && <em>今天</em>}</span>
              <span className="today-due-when">{deadlineLabel(today, task.deadlineLocal!)}</span>
            </button>;
          })}</div>
        </section>}
        {completedToday.length > 0 && <section className="surface-card today-done" aria-labelledby="today-done-title">
          <div className="today-card-head"><h2 id="today-done-title">今天完成</h2><span>{completedToday.length}</span></div>
          <div className="today-done-list">{completedToday.map(({ task, event: completionEvent, record }) => <button type="button" key={task.id} className="today-done-item" title={completionRowLabel(completionEvent, record)} onClick={(click) => onRecordCompletion(task, completionEvent, record, click.currentTarget)}>
            <Check size={12} aria-hidden="true" />
            <span title={task.title}>{task.title}</span>
          </button>)}</div>
        </section>}
      </aside>
    </div>
    {dueAnchor && dueTask && <FloatingPanel className="today-due-panel" label={`${dueTask.title} 临期操作`} anchorElement={dueAnchor.element} closeOnOutsideClick onClose={() => setDueAnchor(null)}>
      <div className="today-pop-body">
        <h2>{dueTask.title}</h2>
        <p className="today-pop-meta">{deadlineLabel(today, dueTask.deadlineLocal!)} · 手动进度 {dueTask.progress}%{scheduledTaskIds.has(dueTask.id) ? " · 今天已安排" : " · 今天还没排"}</p>
        <ProgressControl task={dueTask} onCommit={onProgress} />
        <div className="today-pop-actions">
          {/* 「在轴上查看」不是跳到日历，而是滚回这条轴上的那一段并亮 4 秒 —— 同一份数据，只是换个地方看。 */}
          <Button onClick={() => { const target = sessions.find((session) => session.taskId === dueTask.id) ?? null; setDueAnchor(null); if (target) revealSession(target); else onGoCalendar(); }}>{scheduledTaskIds.has(dueTask.id) ? "在轴上查看" : "安排一段"}</Button>
          <Button className="today-pop-icon" aria-label={`编辑任务 ${dueTask.title}`} title="编辑任务" onClick={() => { const element = dueAnchor.element; setDueAnchor(null); onEditTask(dueTask, element); }}><Pencil size={16} aria-hidden="true" /></Button>
          {/* 去日历改时间：任务今天有排就落在那一段上，没排就打开日历自己找位置。 */}
          <Button className="today-pop-icon" aria-label={`在日历中查看 ${dueTask.title}`} title="在日历中查看" onClick={() => { const target = sessions.find((session) => session.taskId === dueTask.id) ?? null; setDueAnchor(null); onGoCalendar(target ?? undefined); }}><CalendarDays size={16} aria-hidden="true" /></Button>
        </div>
      </div>
    </FloatingPanel>}
  </section>;
}

/**
 * 任务池。
 *
 * 数据来源是 App 建好的共享稳定索引（`WorkspaceIndex`）而不是若干全量数组：每张卡片只
 * 取**自己任务**的时段（`sessionsByTaskId`），项目名走 `projectsById`，拖回取消走
 * `sessionsById`。此前这里对每一行都 `sessions.some/filter` 扫一遍 3,000 条时段
 * （1,000 任务 → 每次渲染约三百万次比较），是规格 §8 点名要消除的模式。
 */
function TaskPool({ index, tasks, heldTasks, leavingTaskId, habits, occurrences, autoScheduleAssist, openProject, onOpenProjectChange, attentionOpen: attentionChoice, onAttentionOpenChange, onCreate, onUpdate, onProgress, onClose, onAutoSchedule, onCreateHabit, onScheduleHabit, onSkipHabit }: {
  index: WorkspaceIndex; tasks: Task[]; heldTasks: Task[]; leavingTaskId: string | null; habits: RecurringHabit[]; occurrences: HabitOccurrence[]; autoScheduleAssist: boolean;
  /** 由 App 持有：面板关闭会卸载本组件，展开状态放在这里才不会丢。`undefined` = 没手动选过。 */
  openProject: string | null | undefined; onOpenProjectChange: (key: string | null) => void;
  /** 同上：`null` = 没手动动过，按临期数量决定默认。 */
  attentionOpen: boolean | null; onAttentionOpenChange: (open: boolean) => void;
  onCreate: (title: string) => Promise<Task>; onUpdate: (task: Task) => Promise<void>; onProgress: (task: Task, value: number, anchor: HTMLElement | null) => Promise<void>;
  /** 拖回任务池的落区与「松手取消本次安排」都由拖拽状态机承载（§191），池子不再自己处理 DnD。 */
  onClose: () => void; onAutoSchedule: () => void;
  onCreateHabit: (habit: Omit<RecurringHabit, "id" | "taskId" | "status">) => Promise<void>;
  onScheduleHabit: (habit: RecurringHabit, date: string) => Promise<void>; onSkipHabit: (habit: RecurringHabit, date: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [filter, setFilter] = useState<"all" | "unscheduled" | "scheduled">("all");
  const [busy, setBusy] = useState(false);
  const [habitsOpen, setHabitsOpen] = useState(false);
  // 提交态由 HabitEditor 的编辑会话上报；FloatingPanel 据此在提交中拦住 Esc 与外部点击。
  const [habitBusy, setHabitBusy] = useState(false);
  const [habitAnchor, setHabitAnchor] = useState<DOMRect | null>(null);
  const today = toLocalDate(useCurrentTime());
  const attention = tasks.filter((task) => task.deadlineLocal && daysBetween(today, task.deadlineLocal) <= 7).sort(compareDeadlines);
  // 关注条默认只在 1–2 项时展开；更多时先只给一行摘要，避免把项目列表推出首屏。
  // 用户手动展开／收起过就以那个选择为准（`attentionChoice` 记在 App 上）。
  const attentionOpen = attentionChoice ?? attention.length <= 2;
  // 「需要关注」是 visible 的补集：用 Set 判归属，避免每行 `attention.includes()` 再扫一遍。
  const attentionIds = new Set(attention.map((task) => task.id));
  const visible = tasks.filter((task) => {
    if (attentionIds.has(task.id)) return false;
    if (filter === "all") return true;
    const scheduled = (index.sessionsByTaskId.get(task.id) ?? []).some(hasFutureSchedule);
    return scheduled ? filter === "scheduled" : filter === "unscheduled";
  });
  const [editing, setEditing] = useState<{ taskId: string; anchor: HTMLElement } | null>(null);
  /** 编辑任务气泡的提交态；由 TaskEditorFields 上报，用于在提交期间拦住 Esc 与外部点击。 */
  const [taskEditorBusy, setTaskEditorBusy] = useState(false);
  const editingTask = editing ? tasks.find((task) => task.id === editing.taskId) ?? null : null;
  const toggleEditor = (task: Task, anchor: HTMLElement) => {
    if (editing?.taskId === task.id) { setEditing(null); return; }
    setEditing({ taskId: task.id, anchor: anchor.closest<HTMLElement>(".task-card") ?? anchor });
  };
  // 百分比是进度的唯一入口：锚定气泡里完成调整，行内不再藏悬停滑块。
  const [progressEdit, setProgressEdit] = useState<{ taskId: string; anchor: HTMLElement } | null>(null);
  const progressTask = progressEdit ? tasks.find((task) => task.id === progressEdit.taskId) ?? null : null;
  const groups: { key: string; project: Project | null; tasks: Task[] }[] = [];
  {
    const byProject = new Map<string, Task[]>();
    for (const task of visible) {
      const key = task.projectId ?? "__independent__";
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key)!.push(task);
    }
    for (const [key, groupTasks] of byProject) groups.push({ key, project: index.projectsById.get(key) ?? null, tasks: groupTasks });
  }
  const assistCount = tasks.filter((task) => !(index.sessionsByTaskId.get(task.id) ?? []).some(hasFutureSchedule)).length
    + habits.filter((habit) => habitOccursOn(habit, today) && !occurrences.some((occurrence) => occurrence.habitId === habit.id && occurrence.localDate === today)).length;
  const dueHabits = habits.filter((habit) => habitOccursOn(habit, today));
  const ordinaryCount = tasks.length - attention.length;
  // 只有一个「独立任务」组时不再套项目头，任务池就是一份平铺清单。
  const flattenGroups = groups.length === 1 && groups[0].key === "__independent__";
  // 默认打开第一个小项目；大项目保持收起，避免一次渲染几十上百行。用户手动点开后再全部展开。
  const defaultProjectKey = !flattenGroups && groups[0] && groups[0].tasks.length <= 6 ? groups[0].key : null;
  // 记住的项目可能已经删了或组被拆散：key 失效时退回默认，而不是让整份清单都收起。
  const rememberedProjectExpired = openProject !== null && openProject !== undefined && !groups.some((group) => group.key === openProject);
  const activeProjectKey = openProject === undefined || rememberedProjectExpired ? defaultProjectKey : openProject;
  const toggleProject = (key: string) => onOpenProjectChange(activeProjectKey === key ? null : key);
  const submit = async () => { if (!title.trim() || busy) return; setBusy(true); try { await onCreate(title); setTitle(""); } finally { setBusy(false); } };
  const row = (task: Task) => <TaskPoolRow key={task.id} task={task} sessions={index.sessionsByTaskId.get(task.id) ?? []} completed={task.status === "completed"} leaving={leavingTaskId === task.id} progressOpen={progressEdit?.taskId === task.id} onProgressEdit={(next, anchor) => setProgressEdit({ taskId: next.id, anchor })} onEdit={toggleEditor} />;
  const drag = useDragSessionContext();
  const poolDropActive = drag.overPool && drag.kind === "move";
  return <aside id="task-pool" className={`task-pool${poolDropActive ? " is-drop-target" : ""}`} aria-label="任务池" data-drop-target={poolDropActive ? "true" : undefined}>
    {/* §191 拖回任务池：落区在拖动期间明确出现，文案先说清「只取消这一次」——
        用户担心的是「拖回去会不会把任务一起删了」。 */}
    {poolDropActive && <div className="pool-drop-zone" role="status">
      <Inbox size={18} aria-hidden="true" />
      <strong>移回任务池</strong>
      <span>只取消本次时段，保留任务与历史</span>
    </div>}
    <header className="pool-head">
      <h2>任务池</h2>
      <span className="pool-count">{tasks.length} 项</span>
      {/* 自动排程与新建习惯从 ⋯ 菜单里提出来常驻：这两件事每天都要点，
          藏在二级菜单里等于每次多点一步。头部因此正好三个按钮（排程／习惯／收起）。 */}
      <div className="pool-head-actions">
        <button type="button" className="icon-action" aria-label="自动排程" title="自动排程" onClick={onAutoSchedule}><Sparkles size={18} aria-hidden="true" /></button>
        <button type="button" className="icon-action" aria-label="新建重复习惯" title="新建重复习惯" onClick={(event) => setHabitAnchor(event.currentTarget.getBoundingClientRect())}><Repeat2 size={18} aria-hidden="true" /></button>
        <button className="icon-action" aria-label="收起任务池" onClick={onClose}><X size={18} /></button>
      </div>
    </header>

    {/* 自动排程辅助：一行中性提示，不用 hover-only 的 title —— 那等于没有提示（UI-SPEC:219）。 */}
    {autoScheduleAssist && assistCount > 0 && <p className="pool-assist">
      <span>现在 {assistCount} 项可以安排</span>
      <button type="button" onClick={onAutoSchedule}>查看</button>
    </p>}

    <form className="pool-compose" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <input aria-label="任务标题" placeholder="写一件事" title="写一件事，按 Enter 创建" value={title} onChange={(event) => setTitle(event.target.value)} />
      <button type="submit" className="pool-add" aria-label="创建任务" disabled={!title.trim() || busy}><Plus size={16} /></button>
    </form>

    <div className="pool-scroll">
      {attention.length > 0 && <details className="attention-pool" open={attentionOpen} onToggle={(event) => {
        // 只记「用户真的改了」：`open` 由状态驱动，挂载／重渲染时也可能触发 toggle，
        // 那些事件里的 open 与我们刚设的值相同，直接忽略，否则默认规则会被一次空事件覆盖。
        const next = (event.currentTarget as HTMLDetailsElement).open;
        if (next !== attentionOpen) onAttentionOpenChange(next);
      }}>
        <summary><CircleAlert size={15} aria-hidden="true" /><strong>需要关注</strong><span className="attention-count">{attention.length} 项临期</span><ChevronDown className="attention-chevron" size={14} aria-hidden="true" /></summary>
        <div className="task-list attention-list">{attention.map(row)}</div>
      </details>}

      {/* 筛选从 ⋯ 菜单挪到这里：和「需要关注」贴在一起，选完立刻看得到列表变化，
          也不用先想「筛选藏在哪」。三段本身就是状态显示，不再另挂一行文字提示。 */}
      {tasks.length > 0 && <div className="segmented compact pool-filter" role="group" aria-label="任务池筛选">
        {(["all", "unscheduled", "scheduled"] as const).map((value) => <button key={value} type="button" className={filter === value ? "active" : ""} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === "all" ? "全部" : value === "unscheduled" ? "未安排" : "已安排"}</button>)}
      </div>}

      {groups.length > 0 && <div className={flattenGroups ? "task-list pool-project-list is-flat" : "task-list pool-project-list"}>
        {flattenGroups ? groups[0].tasks.map(row) : groups.map(({ key, project, tasks: groupTasks }) => {
          const isOpen = activeProjectKey === key;
          const avg = groupTasks.length ? Math.round(groupTasks.reduce((sum, task) => sum + task.progress, 0) / groupTasks.length) : 0;
          return <section key={key} className={isOpen ? "project-group is-open" : "project-group"}>
            <button type="button" className="project-group-header" aria-expanded={isOpen} onClick={() => toggleProject(key)}>
              <strong>{project?.title ?? "独立任务"}</strong>
              <span className="project-group-meta">{groupTasks.length} 项</span>
              <span className="project-group-pct" title="组内平均完成度">{avg}%</span>
              {isOpen ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
            </button>
            <div className="project-group-meter" aria-hidden="true"><span style={{ width: `${avg}%` }} /></div>
            {isOpen && <div className="project-group-body is-expanded">{groupTasks.map(row)}</div>}
          </section>;
        })}
      </div>}

      {visible.length === 0 && (tasks.length === 0
        ? <div className="pool-empty"><span><Inbox size={20} aria-hidden="true" /></span><strong>任务池是空的</strong><p>在上方写下一件事，按 Enter 就会出现在这里。</p></div>
        : ordinaryCount === 0
          ? <p className="empty-inline">其余任务都在上方「需要关注」里。</p>
          : <div className="pool-empty"><span><ListFilter size={20} aria-hidden="true" /></span><strong>当前筛选没有任务</strong><p>切回「全部」即可看到其余 {ordinaryCount} 项。</p><Button onClick={() => setFilter("all")}>清除筛选</Button></div>)}
    </div>

    {habits.length > 0 && <details className="pool-habits" open={habitsOpen} onToggle={(event) => setHabitsOpen(event.currentTarget.open)}>
      <summary><Repeat2 size={15} aria-hidden="true" /><strong>重复习惯</strong><span className="pool-habits-meta">{dueHabits.length > 0 ? `今天 ${dueHabits.length}` : "今天无"}</span><ChevronDown className="pool-habits-chevron" size={14} aria-hidden="true" /></summary>
      <div className="habit-list">
        {dueHabits.length === 0 && <p className="pool-habits-empty">今天没有要执行的习惯。</p>}
        {dueHabits.map((habit) => {
          const occurrence = occurrences.find((item) => item.habitId === habit.id && item.localDate === today);
          return <article key={habit.id}><div><strong>{habit.title}</strong><span>{habit.pattern === "daily" ? "每天" : habit.pattern === "weekdays" ? "工作日" : "每周选日"} · {habit.sessionMinutes} 分钟</span></div>{occurrence ? <span className="muted-chip">{occurrence.status === "scheduled" ? "已安排" : occurrence.status === "skipped" ? "本次已跳过" : "已完成"}</span> : <div className="habit-actions"><Button onClick={() => void onScheduleHabit(habit, today)}>安排今天</Button><Button variant="quiet" onClick={() => void onSkipHabit(habit, today)}>跳过本次</Button></div>}</article>;
        })}
      </div>
    </details>}

    {habitAnchor && <FloatingPanel label="新建重复习惯" anchor={habitAnchor} busy={habitBusy} closeOnOutsideClick onClose={() => setHabitAnchor(null)}><HabitEditor onCancel={() => setHabitAnchor(null)} onCreate={async (habit) => { await onCreateHabit(habit); setHabitAnchor(null); setHabitsOpen(true); }} onPhase={setHabitBusy} /></FloatingPanel>}
    {progressEdit && progressTask && <FloatingPanel className="pool-progress-panel" label={`调整进度 ${progressTask.title}`} anchorElement={progressEdit.anchor} closeOnOutsideClick onClose={() => setProgressEdit(null)}><PoolProgressEditor task={progressTask} anchor={progressEdit.anchor} onCommit={onProgress} onClose={() => setProgressEdit(null)} /></FloatingPanel>}
    {editing && editingTask && <FloatingPanel key={editingTask.id} className="task-editor-panel" label={`编辑任务 ${editingTask.title}`} anchorElement={editing.anchor} busy={taskEditorBusy} closeOnOutsideClick onClose={() => setEditing(null)}><div className="task-editor-fields">
      <h2>编辑任务</h2><TaskEditorFields task={editingTask} projects={index.workspace.projects} onUpdate={async (next) => { await onUpdate(next); setEditing(null); }} onCancel={() => setEditing(null)} onPhase={setTaskEditorBusy} />
    </div></FloatingPanel>}
  </aside>;
}

/**
 * 单行任务；`sessions` 已经是**该任务自己的**时段（来自 `WorkspaceIndex.sessionsByTaskId`），
 * 不再自行过滤全量。
 *
 * 项目优先的第二层：标题、一个最近的时间信号和完成度收在一行；百分比本身是入口，
 * 点开后弹出锚定气泡。整行保持 44px 命中区，拖动仍从行本身开始。
 *
 * `completed` 只出现在完成记录气泡打开期间：这一行留在原分组里当锚点，显示完成态；
 * 气泡关闭后 `leaving` 让它淡出 160ms 再离开活动池（规格 0007 §3.1）。
 */
function TaskPoolRow({ task, sessions, completed = false, leaving = false, progressOpen, onProgressEdit, onEdit }: { task: Task; sessions: ExecutionSession[]; completed?: boolean; leaving?: boolean; progressOpen: boolean; onProgressEdit: (task: Task, anchor: HTMLElement) => void; onEdit: (task: Task, anchor: HTMLElement) => void }) {
  const today = toLocalDate(new Date());
  const upcoming = sessions.filter(hasFutureSchedule).sort(compareSessions);
  const next = upcoming[0] ?? null;
  const deadlineDays = task.deadlineLocal ? daysBetween(today, task.deadlineLocal) : null;
  const urgentDeadline = deadlineDays !== null && deadlineDays <= 7;
  const when = task.deadlineLocal && urgentDeadline
    ? deadlineLabel(today, task.deadlineLocal)
    : next
      ? `${scheduleDayLabel(today, next.localDate)} ${next.startLocal}`
      : task.deadlineLocal
        ? deadlineLabel(today, task.deadlineLocal)
        : null;
  const whenTitle = task.deadlineLocal
    ? `截止：${formatShortDate(task.deadlineLocal)}${next ? ` · 下次：${formatShortDate(next.localDate)} ${next.startLocal}` : ""}`
    : next ? `下次安排：${formatShortDate(next.localDate)} ${next.startLocal}（共 ${upcoming.length} 次）` : "尚未安排";
  const hint = `拖动安排 · 完成度 ${task.progress}%${task.deadlineLocal ? ` · 截止 ${formatShortDate(task.deadlineLocal)}` : ""}${next ? ` · 下次 ${formatShortDate(next.localDate)} ${next.startLocal}（共 ${upcoming.length} 次）` : ""}`;
  const drag = useDragSessionContext();
  const isDragSource = drag.kind === "create" && drag.sourceTaskId === task.id && drag.phase !== "idle";
  const className = ["task-card", "pool-task-row", completed ? "is-completed" : "", leaving ? "is-leaving" : "", isDragSource ? "is-dragging-source" : ""].filter(Boolean).join(" ");
  return <article className={className} tabIndex={0} title={hint} data-dragging={isDragSource ? "true" : undefined} onPointerDown={(event) => {
    if (completed || event.button !== 0) return;
    // 卡身上的按钮（进度、编辑）只执行自己的操作，不触发拖拽（UI-SPEC §91）。
    if ((event.target as HTMLElement).closest("button, input, select, textarea, a")) return;
    drag.beginCreate(event, task);
  }}>
    <div className="pool-task-main">
      <span className="pool-task-title-row">
        {completed && <span className="pool-task-check" aria-hidden="true"><Check size={13} /></span>}
        <strong className="pool-task-title" title={task.title}>{task.title}</strong>
      </span>
      <div className="pool-task-meta">
        {/* 完成态不再重复一遍百分比：右侧那一格已经是 100%，勾 + 标题 + 一个数字就够。 */}
        {!completed && when && <span className={urgentDeadline ? "pool-task-when is-due" : "pool-task-when"} title={whenTitle}>{when}</span>}
        {/* 进度与编辑共用一个胶囊外框：一行里只出现一个形状。两个按钮各自保持独立语义，
            悬停只填被指的那一段（见 `.pool-task-side` 的样式注释）。 */}
        <span className="pool-task-side">
          <button type="button" className="pool-task-progress" aria-haspopup="dialog" aria-expanded={progressOpen} aria-label={`调整进度 ${task.title}，当前 ${task.progress}%`} title="调整完成度" onClick={(event) => onProgressEdit(task, event.currentTarget)}>{task.progress}%</button>
          {!completed && <button data-editor-anchor={task.id} type="button" className="icon-action task-editor-button pool-task-edit" aria-label={`编辑任务 ${task.title}`} title="编辑任务" onClick={(event) => onEdit(task, event.currentTarget)}><Pencil size={12} /></button>}
        </span>
      </div>
    </div>
  </article>;
}

/** 任务池的进度气泡：当前值和常用值同一行；滑块松手后写入，任务名只在无障碍名里出现。 */
function PoolProgressEditor({ task, anchor, onCommit, onClose }: { task: Task; anchor: HTMLElement | null; onCommit: (task: Task, value: number, anchor: HTMLElement | null) => Promise<void>; onClose: () => void }) {
  const [value, setValue] = useState(task.progress);
  useEffect(() => setValue(task.progress), [task.progress]);
  const commit = (next: number) => { if (next !== task.progress) void onCommit(task, next, anchor); };
  const choose = (next: number) => { setValue(next); commit(next); };
  return <div className="pool-progress-editor">
    <div className="pool-progress-head">
      <strong className="pool-progress-title">调整进度</strong>
      <button type="button" className="pool-progress-close" aria-label="关闭进度编辑" onClick={onClose}><X size={14} /></button>
    </div>
    <div className="pool-progress-main">
      <strong className="pool-progress-value">{value}%</strong>
      <div className="pool-progress-choices">
        <div className="pool-progress-presets" role="group" aria-label="常用进度">
          {[0, 25, 50, 75].map((preset) => <button key={preset} type="button" className={value === preset ? "is-active" : ""} aria-pressed={value === preset} onClick={() => choose(preset)}>{preset}%</button>)}
        </div>
        <button type="button" className="pool-progress-complete" aria-label={`标记 ${task.title} 已完成`} disabled={value === 100} onClick={() => { setValue(100); commit(100); onClose(); }}>完成</button>
      </div>
    </div>
    <RangeBar compact initialFocus label={`${task.title} 完成度`} min={0} max={100} step={5} value={value} onChange={setValue} onPointerUp={() => commit(value)} onKeyUp={() => commit(value)} />
  </div>;
}

function CalendarPage({ workspace, index, preferences, focusSessionId, onPreferences, onCalendarPosition, onSchedule, onCreateTaskAt, onMove, rootRef, viewportDragRef, edgeScrollHoldRef, onProgress, onSkipReview, onCreateBlock, onUpdateBlock, onDeleteBlock }: {
  workspace: WorkspaceSnapshot; index: WorkspaceIndex; preferences: AppSettings; focusSessionId: string | null; onPreferences: (patch: Partial<AppSettings>) => void;
  /** 用户滚动落定后的日／周浏览位置（只有用户滚动会到这里，见 `useCalendarViewport`）。 */
  onCalendarPosition: (view: TimelineView, position: CalendarPosition) => void;
  onSchedule: (task: Task, date: string, start: string) => Promise<void>;
  onCreateTaskAt: (title: string, date: string, start: string, duration: number) => Promise<void>;
  onMove: (session: ExecutionSession, date: string, start: string, duration?: number) => Promise<void>;
  /** 拖拽状态机在 App 层（任务池与日历是兄弟节点），日历把自己的根节点交给它做落点查询。 */
  rootRef: RefObject<HTMLElement | null>;
  /** 把滚动仲裁的 begin/end 注册给状态机：进入 dragging 时低优先级恢复请求延后。 */
  viewportDragRef: RefObject<null | { begin: () => void; end: () => void }>;
  /** 日视图把「折叠条正在被悬停展开」写进这个 ref：拖拽边缘滚动据此让路（B3／D13）。 */
  edgeScrollHoldRef: RefObject<boolean>;
  onProgress: (task: Task, value: number, anchor: HTMLElement | null) => Promise<void>; onSkipReview: (session: ExecutionSession) => Promise<void>;
  onCreateBlock: (block: TimeBlock) => Promise<void>; onUpdateBlock: (previous: TimeBlock, next: TimeBlock) => Promise<void>; onDeleteBlock: (id: string) => Promise<void>;
}) {
  const anchor = preferences.calendarAnchors[preferences.calendarView] ?? toLocalDate(new Date());
  const setAnchor = (date: string) => onPreferences({ calendarAnchors: { ...preferences.calendarAnchors, [preferences.calendarView]: date } });
  const [editingSession, setEditingSession] = useState<{ session: ExecutionSession; anchorElement: HTMLElement | null } | null>(null);
  // 精确时间编辑的提交态：FloatingPanel 据此在提交中拦住 Esc 与外部点击。
  const [editingSessionBusy, setEditingSessionBusy] = useState(false);
  const [continuingSession, setContinuingSession] = useState<ExecutionSession | null>(null);
  const [selectedCalendarDate, setSelectedCalendarDate] = useState<string | null>(null); const [detailTaskId, setDetailTaskId] = useState<string | null>(null); const [detailProjectId, setDetailProjectId] = useState<string | null>(null);
  const [monthFocusDate, setMonthFocusDate] = useState<string | null>(null);
  const [weekKeyboardFocus, setWeekKeyboardFocus] = useState<{ kind: "header" | "grid"; date: string; minute: number }>(() => ({ kind: "header", date: anchor, minute: 540 }));
  // 全天标记与日期头共用一行：收起时整行不渲染（C1／#10），展开时仍是 A6 的单行 chip 带。
  const [allDayOpen, setAllDayOpen] = useState(() => preferences.scale < 200);
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  /** 周视图点击任何「一天」的表面都跳到该日的日视图（D17）；月视图保留右侧详情。 */
  const openDay = (date: string) => onPreferences({ calendarView: "day", calendarAnchors: { ...preferences.calendarAnchors, day: date } });
  const closeDateDetails = () => { setSelectedCalendarDate(null); setDetailTaskId(null); setDetailProjectId(null); };
  const calendarRef = rootRef; const weekFocusRequested = useRef(false); const [nowDirection, setNowDirection] = useState<"up" | "down" | null>(null);
  /** 「回到现在」在锚点非今天时先换日：换日后的首次渲染再执行显露。 */
  const pendingRevealRef = useRef(false);
  // 周列宽用真实网格量（详情面板挤占后也成立）；<96px 时并行最多并排 2 项。
  const [weekColumnWidth, setWeekColumnWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (preferences.calendarView !== "week") { setWeekColumnWidth(null); return; }
    const grid = calendarRef.current?.querySelector<HTMLElement>(".calendar-grid.week");
    if (!grid) { setWeekColumnWidth(null); return; }
    // 首列是 3.625rem（100% 为 58px、200% 为 116px），不再写死 58px。
    const gutter = 58 * preferences.scale / 100;
    const measure = () => { const width = grid.getBoundingClientRect().width; setWeekColumnWidth(width > 0 ? (width - gutter) / 7 : null); };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(grid);
    return () => observer?.disconnect();
  }, [preferences.calendarView, preferences.scale]);
  const weekConcurrencyLimit = weekColumnWidth !== null && weekColumnWidth < 96 ? 2 : 3;
  const now = useCurrentTime();
  const dates = weekDates(anchor);
  const zoom = preferences.calendarZoom[preferences.calendarView];
  const scale = preferences.calendarScale[preferences.calendarView];
  // 日／周共用的单一滚动仲裁入口：恢复记忆位置、首次定位、缩放锚点、三日缓冲与拖拽
  // 优先级都在这里排队（规格 §5.2）。位置以模块级内存为单一真相，用户滚动落定后
  // 经 `onCalendarPosition` 写进偏好；跨启动由 App 播种回来（P4-05）。
  const viewport = useCalendarViewport({
    view: preferences.calendarView, date: anchor, now, scale,
    slots: preferences.defaultTimeSlots, dates, rootRef: calendarRef,
    onPositionSettled: onCalendarPosition,
  });
  const drag = useDragSessionContext();
  // 把滚动仲裁的 begin/end 交给 App 层状态机：日历自己不再持有拖拽状态（B2）。
  useEffect(() => {
    viewportDragRef.current = { begin: viewport.beginDrag, end: viewport.endDrag };
    return () => { viewportDragRef.current = null; };
  }, [viewport.beginDrag, viewport.endDrag, viewportDragRef]);
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
    // 锚点不在今天时先换日，等新日期渲染完再显露；同一帧里排队会被日期切换作废（generation）。
    const today = toLocalDate(now);
    if (anchor !== today) { pendingRevealRef.current = true; setAnchor(today); return; }
    viewport.revealNow();
  };
  useEffect(() => {
    if (!pendingRevealRef.current) return;
    pendingRevealRef.current = false;
    viewport.revealNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);
  useLayoutEffect(() => { if (preferences.calendarView === "month") { const viewportElement = calendarRef.current?.querySelector<HTMLElement>(".calendar-viewport"); if (viewportElement) viewportElement.scrollTop = 0; } }, [preferences.calendarView]);
  // 跨页目标显露（今日页「去日历」、提醒后的托盘恢复）：优先级 2，交给同一个仲裁入口。
  useEffect(() => {
    if (!focusSessionId) return;
    viewport.revealSession(focusSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSessionId, anchor, preferences.calendarView]);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const wheelHandlerRef = useRef<(event: WheelEvent) => void>(() => {});
  // React 17+ 在根节点把 wheel 注册成 **passive** 监听，合成事件里的 preventDefault() 无效，
  // 于是浏览器还会执行自己的默认滚动，并且可能**先于**下面的处理器改变 scrollTop ——
  // 处理器随后用 getBoundingClientRect 取到的锚点比例就偏了，缩放后指针下的时间会跳动
  // （实测位移 108px，正对应偏掉后的 09:55）。改用非 passive 的原生监听让 preventDefault 生效。
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const handler = (event: WheelEvent) => wheelHandlerRef.current(event);
    element.addEventListener("wheel", handler, { passive: false });
    return () => element.removeEventListener("wheel", handler);
  }, []);
  const zoomWithWheel = (event: WheelEvent) => {
    if (!event.ctrlKey || preferences.calendarView === "month" || event.deltaY === 0) return;
    event.preventDefault();
    const [minimumScale, maximumScale] = CALENDAR_SCALE_RANGE[preferences.calendarView];
    const nextScale = Math.max(minimumScale, Math.min(maximumScale, scale + (event.deltaY < 0 ? 4 : -4)));
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
    const scroller = preferences.calendarView === "day" ? calendarRef.current?.querySelector<HTMLElement>(".continuous-day-axis") : viewportRef.current;
    const scrollerRect = scroller?.getBoundingClientRect();
    const pointerOffset = scrollerRect ? clientY - scrollerRect.top : 0;
    const contentRatio = scroller?.scrollHeight ? (scroller.scrollTop + pointerOffset) / scroller.scrollHeight : null;
    if (scroller) viewport.captureZoomAnchor({ scroller, date, anchorRatio, anchorMinute, clientY, pointerOffset, contentRatio });
    onPreferences({
      calendarZoom: { ...preferences.calendarZoom, [preferences.calendarView]: closestZoom(preferences.calendarView, nextScale) },
      calendarScale: { ...preferences.calendarScale, [preferences.calendarView]: nextScale },
    });
  };
  useEffect(() => { wheelHandlerRef.current = zoomWithWheel; });
  const calendarStyle = {
    "--calendar-hour-height": `${scale}px`,
    "--calendar-month-row-height": `${scale}px`,
    // 折叠条高度与时间轴映射共用同一个像素值（A6／F20①）：界面缩放越大，带子越高。
    "--collapsed-gap-height": `${collapsedGapHeight(preferences.scale)}px`,
    // 界面缩放（根字号）越大，保留同样「设计宽」所需的 CSS px 越少；
    // 网格下限定宽按它反比缩放，200% 下不再把日历顶出横向滚动。
    "--calendar-ui-factor": String(100 / preferences.scale),
  } as CSSProperties;
  const rangeTitle = preferences.calendarView === "day"
    ? `${formatShortDate(anchor)} ${weekday(anchor)}`
    : preferences.calendarView === "week"
      ? `${formatShortDate(dates[0])} — ${formatShortDate(dates[6])}`
      : formatMonth(anchor);
  const compactRangeTitle = preferences.calendarView === "week"
    ? `${compactMonthDay(dates[0])}–${compactMonthDay(dates[6])}`
    : preferences.calendarView === "day"
      ? `${compactMonthDay(anchor)} ${weekday(anchor)}`
      : null;
  const snapLabel = preferences.snapMinutes === "off" ? "吸附已关闭" : `吸附 ${preferences.snapMinutes} 分钟`;
  const backToCurrentLabel = preferences.calendarView === "day" ? "回到今天" : preferences.calendarView === "week" ? "回到本周" : "回到本月";
  const defaultSlotsEmpty = preferences.defaultTimeSlots.length === 0;
  const zoomControl = <div className="segmented calendar-zoom" role="group" aria-label="日历缩放">{([["compact", "紧凑", Rows4], ["standard", "标准", Rows3], ["detailed", "详细", Rows2]] as const).map(([value, label, Icon]) => <button key={value} type="button" aria-label={label} title={label} aria-pressed={zoom === value} className={zoom === value ? "active" : ""} onClick={() => setZoom(value)}><span className="calendar-zoom-label">{label}</span><Icon className="calendar-zoom-icon" size={14} aria-hidden="true" /></button>)}</div>;
  const actualRecordToggle = preferences.showActualRecordsControl ? <label className="actual-record-toggle" title="显示实际记录"><input type="checkbox" aria-label="显示实际记录" checked={preferences.showActualRecords} onChange={(event) => onPreferences({ showActualRecords: event.target.checked })} /><span className="calendar-actual-label-full">显示实际记录</span><span className="calendar-actual-label-short" aria-hidden="true">实际记录</span></label> : null;
  const moreTrigger = <button type="button" className="calendar-more-trigger" aria-haspopup="dialog" aria-expanded={moreAnchor !== null} aria-label="显示更多日历选项" onClick={(event) => { const trigger = event.currentTarget; setMoreAnchor((current) => current ? null : trigger); }}><span className="calendar-more-label">显示</span><Ellipsis size={16} aria-hidden="true" /></button>;
  return <section ref={calendarRef} className="calendar-page" aria-labelledby="calendar-title" data-calendar-zoom={zoom} data-calendar-scale={scale} data-calendar-view={preferences.calendarView} data-ui-scale={preferences.scale} data-drag-phase={drag.phase} data-compact-title={compactRangeTitle ? "true" : undefined} style={calendarStyle}>
    <PageHeader
      className="calendar-header"
      titleId="calendar-title"
      titleLabel={rangeTitle}
      titleLive
      title={<><span className="calendar-range-full">{rangeTitle}</span>{compactRangeTitle && <span className="calendar-range-short" aria-hidden="true">{compactRangeTitle}</span>}</>}
      actions={<>
        <div className="segmented calendar-view-switch" role="group" aria-label="日历视图">
          {([["day", "日"], ["week", "周"], ["month", "月"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={preferences.calendarView === value} className={preferences.calendarView === value ? "active" : ""} onClick={() => { viewport.flush(); onPreferences({ calendarView: value }); }}>{label}</button>)}
        </div>
        <div className="calendar-step-group" role="group" aria-label="日期导航">
          <button type="button" aria-label="上一段日期" onClick={() => shift(-1)}><ChevronLeft size={16} /></button>
          <button type="button" className="calendar-today" aria-label={backToCurrentLabel} title={backToCurrentLabel} onClick={() => setAnchor(toLocalDate(new Date()))}>今天</button>
          <button type="button" aria-label="下一段日期" onClick={() => shift(1)}><ChevronRight size={16} /></button>
        </div>
        {/* 月／周把密度、实际记录与「显示…」并进第一行（C1／#15）；日视图控件多，保留第二行。 */}
        {preferences.calendarView !== "day" && <div className="calendar-header-tools" role="group" aria-label="日历显示选项">
          {zoomControl}
          {preferences.calendarView === "week" && actualRecordToggle}
          {/* 月视图没有可显示的低频项（D15 删掉时间块入口后只剩吸附），触发按钮一并移除。 */}
          {preferences.calendarView !== "month" && moreTrigger}
        </div>}
      </>}
    />
    {preferences.calendarView === "day" && <div className="calendar-toolbar" role="group" aria-label="日历显示选项">
      <div className="calendar-status-start">
        <div className="segmented calendar-day-mode" role="group" aria-label="日视图显示模式">{([["defaultSlots", "可用时间"], ["fullDay", "全天"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={preferences.calendarDayMode === value} className={preferences.calendarDayMode === value ? "active" : ""} disabled={value === "defaultSlots" && defaultSlotsEmpty} title={value === "defaultSlots" && defaultSlotsEmpty ? "先在设置里标出可用时间" : undefined} onClick={() => onPreferences({ calendarDayMode: value })}>{label}</button>)}</div>
        {zoomControl}
      </div>
      <div className="calendar-status-end">
        {actualRecordToggle}
        {moreTrigger}
      </div>
    </div>}
    <div ref={viewportRef} className={`calendar-viewport ${preferences.calendarView}-viewport`} role="region" aria-label="日历时间网格">
      {preferences.calendarView === "month" ? (
        <div className={`month-calendar-layout ${selectedCalendarDate ? "with-detail" : ""}`}>
          <MonthCalendar anchor={anchor} workspace={workspace} selectedDate={selectedCalendarDate} focusDate={monthFocusDate ?? anchor} onFocusDate={setMonthFocusDate} onNavigateDate={(date) => { setMonthFocusDate(date); if (!monthDates(anchor).includes(date)) setAnchor(date); }} onSelectDate={(date) => { setSelectedCalendarDate((current) => current === date ? null : date); setDetailTaskId(null); setDetailProjectId(null); }} onOpenDate={(date) => { setSelectedCalendarDate(date); setDetailTaskId(null); setDetailProjectId(null); }} onOpenTask={(date, taskId) => { setSelectedCalendarDate(date); setDetailTaskId(taskId); setDetailProjectId(null); }} onOpenProject={(date, projectId) => { setSelectedCalendarDate(date); setDetailProjectId(projectId); setDetailTaskId(null); }} />
          {selectedCalendarDate && <CalendarDateDetails date={selectedCalendarDate} workspace={workspace} taskId={detailTaskId} projectId={detailProjectId} onOpenDay={() => openDay(selectedCalendarDate)} onClose={closeDateDetails} />}
        </div>
      ) : preferences.calendarView === "day" ? (
        <ContinuousDayView anchor={anchor} workspace={workspace} index={index} preferences={preferences} now={now} focusSessionId={focusSessionId} edgeScrollHoldRef={edgeScrollHoldRef} onAnchorChange={setAnchor} onProgrammaticPosition={viewport.noteProgrammaticPosition} onBufferShift={viewport.requestBufferShift} isProgrammaticScroll={viewport.isProgrammaticPosition} onSchedule={onSchedule} onCreateTaskAt={onCreateTaskAt} onProgress={onProgress} onSkipReview={onSkipReview} onContinue={setContinuingSession} onCreateBlock={onCreateBlock} onUpdateBlock={onUpdateBlock} onDeleteBlock={onDeleteBlock} onEditSession={(session, anchorElement) => setEditingSession({ session, anchorElement })} />
      ) : (
        /* 周视图不再挂右侧详情面板（D17）：日期头、空白格与全天 chip 都直接跳日视图。 */
        <div className="week-calendar-layout">
          <div className="week-calendar-main">
            <div className="week-sticky-header">
              <WeekDateHeaders dates={dates} today={toLocalDate(now)} focusDate={weekKeyboardFocus.kind === "header" ? weekKeyboardFocus.date : null} onFocusDate={(date) => setWeekKeyboardFocus((current) => ({ ...current, kind: "header", date }))} onMoveDate={(date) => moveWeekFocus("header", date)} onOpenDate={openDay} allDayOpen={allDayOpen} allDayId="calendar-week-all-day" onToggleAllDay={() => setAllDayOpen((open) => !open)} />
              <WeekAllDayArea id="calendar-week-all-day" open={allDayOpen} dates={dates} workspace={workspace} onOpenDay={openDay} />
            </div>
            <div className="calendar-grid week week-body">
              <CalendarTimeAxis />
              {dates.map((date) => <CalendarDay key={date} date={date} workspace={workspace} index={index} preferences={preferences} now={now} concurrencyLimit={weekConcurrencyLimit} onOpenDay={openDay} weekGridTabIndex={weekKeyboardFocus.kind === "grid" && weekKeyboardFocus.date === date ? 0 : -1} weekGridMinute={weekKeyboardFocus.minute} onWeekGridFocus={() => setWeekKeyboardFocus((current) => ({ ...current, kind: "grid", date }))} onWeekGridNavigate={(event) => { const snap = preferences.snapMinutes === "off" ? 1 : preferences.snapMinutes; let nextDate = date; let nextMinute = weekKeyboardFocus.minute; if (event.key === "ArrowLeft") nextDate = addDays(date, -1); else if (event.key === "ArrowRight") nextDate = addDays(date, 1); else if (event.key === "ArrowUp") nextMinute = Math.max(0, nextMinute - snap); else if (event.key === "ArrowDown") nextMinute = Math.min(1439, nextMinute + snap); else if (event.key === "PageUp") nextDate = addDays(date, -7); else if (event.key === "PageDown") nextDate = addDays(date, 7); else return; event.preventDefault(); moveWeekFocus("grid", nextDate, nextMinute); calendarRef.current?.querySelector<HTMLElement>(`.calendar-day[data-day-date="${nextDate}"] .day-track`)?.focus(); }} onSchedule={onSchedule} onCreateTaskAt={onCreateTaskAt} onProgress={onProgress} onSkipReview={onSkipReview} onContinue={setContinuingSession} onCreateBlock={onCreateBlock} onUpdateBlock={onUpdateBlock} onDeleteBlock={onDeleteBlock} onEditSession={(session, anchorElement) => setEditingSession({ session, anchorElement })} />)}
            </div>
          </div>
        </div>
      )}
    </div>
    {preferences.calendarView !== "month" && <button type="button" className="back-to-now" onClick={returnToNow}>{nowDirection === "up" ? <ArrowUp size={16} aria-hidden="true" /> : nowDirection === "down" ? <ArrowDown size={16} aria-hidden="true" /> : <LocateFixed size={16} aria-hidden="true" />}回到现在</button>}
    {moreAnchor && preferences.calendarView !== "month" && <FloatingPanel kind="action" className="calendar-more-panel" label="日历显示选项" anchorElement={moreAnchor} closeOnOutsideClick onClose={() => setMoreAnchor(null)}>
      <div className="calendar-more-list">
        <button type="button" className={`calendar-more-item${preferences.snapMinutes === "off" ? "" : " is-active"}`} aria-label={snapLabel} aria-pressed={preferences.snapMinutes !== "off"} onClick={() => onPreferences({ snapMinutes: preferences.snapMinutes === "off" ? 15 : "off" })}>
          <Magnet size={16} aria-hidden="true" />
          <span className="calendar-more-copy"><strong>吸附</strong><small>{preferences.snapMinutes === "off" ? "落点按分钟自由放置" : `落点按 ${preferences.snapMinutes} 分钟取整`}</small></span>
          <span className="calendar-more-state">{preferences.snapMinutes === "off" ? "关" : "开"}</span>
        </button>
      </div>
      <p className="calendar-more-note">拖拽时按 Alt 临时反转吸附</p>
    </FloatingPanel>}
    {editingSession && (() => { const task = workspace.tasks.find((item) => item.id === editingSession.session.taskId); return task ? <SessionEditPopover session={editingSession.session} task={task} anchorElement={editingSession.anchorElement} onClose={() => setEditingSession(null)} onPhase={setEditingSessionBusy} onSave={async (date, start, duration) => { await onMove(editingSession.session, date, start, duration); setEditingSession(null); }} /> : null; })()}
    {continuingSession && (() => { const task = workspace.tasks.find((item) => item.id === continuingSession.taskId); return task ? <ContinueScheduleDialog session={continuingSession} task={task} snapMinutes={preferences.snapMinutes} onClose={() => setContinuingSession(null)} onSave={async (date, start) => { await onSchedule(task, date, start); setContinuingSession(null); }} /> : null; })()}
  </section>;
}

function ContinuousDayView({ anchor, workspace, index, preferences, now, focusSessionId, edgeScrollHoldRef, onAnchorChange, onProgrammaticPosition, onBufferShift, isProgrammaticScroll, onSchedule, onCreateTaskAt, onProgress, onSkipReview, onContinue, onCreateBlock, onUpdateBlock, onDeleteBlock, onEditSession }: {
  anchor: string; workspace: WorkspaceSnapshot; index: WorkspaceIndex; preferences: AppSettings; now: Date; focusSessionId: string | null; onAnchorChange: (date: string) => void;
  /** 「折叠条正在被悬停展开」的出口：三块网格共用一个 ref，见 `DayCalendarGrid` 的写入规则。 */
  edgeScrollHoldRef: RefObject<boolean>;
  /** 三日缓冲在仲裁落点写完之后上报：这次 scroll 是应用自己的定位，不是用户滚动。 */
  onProgrammaticPosition: () => void;
  /** 优先级 4：把三日缓冲的对齐交给滚动仲裁，与进入恢复／首次定位按顺序落地。 */
  onBufferShift: (apply: () => boolean, onDiscard?: () => void) => void;
  /** 只读：这次 scroll 是否仍落在应用自己刚写下的位置上（恢复 / 显露 / 平移）。 */
  isProgrammaticScroll: () => boolean;
  onSchedule: (task: Task, date: string, start: string) => Promise<void>;
  onCreateTaskAt: (title: string, date: string, start: string, duration: number) => Promise<void>;
  onProgress: (task: Task, value: number, anchor: HTMLElement | null) => Promise<void>; onSkipReview: (session: ExecutionSession) => Promise<void>; onContinue: (session: ExecutionSession) => void;
  onCreateBlock: (block: TimeBlock) => Promise<void>; onUpdateBlock: (previous: TimeBlock, next: TimeBlock) => Promise<void>; onDeleteBlock: (id: string) => Promise<void>; onEditSession: (session: ExecutionSession, anchorElement: HTMLElement | null) => void;
}) {
  const axisRef = useRef<HTMLDivElement>(null); const pendingScrollOffset = useRef<number | null>(null); const shifting = useRef(false);
  const drag = useDragSessionContext();
  /** 落点目前落在哪一天：那一天的吸顶日期带在拖动中保持醒目（§198）。 */
  const dragTargetDate = drag.phase === "dragging" || drag.phase === "deciding" ? drag.preview?.date ?? null : null;
  const previousPanelRef = useRef<HTMLElement | null>(null);
  const previousExpansionRef = useRef<null | { beforeHeight: number; scrollTop: number }>(null);
  const previousDate = addDays(anchor, -1);
  /** 展开过的前一天只属于当前浏览过程；锚点一变就自然失效，不回缩。 */
  const [expandedPreviousDate, setExpandedPreviousDate] = useState<string | null>(null);
  const previousExpanded = expandedPreviousDate === previousDate;
  /**
   * 展开那一次手势不算「用户要退到前一天」。
   *
   * 带子展开后前一天整块网格就压在视口上方，`scrollTop` 天然低于中段起点 —— 不吞掉这一次
   * 越界，点一下「展开」就会顺手把锚点改到昨天（改前／改后取决于当时停在哪，行为不可复现）。
   * 用户之后再次向上越过边界（先滚回今天再滚上来）才按原有的三日缓冲语义平移锚点。
   */
  const suppressPreviousShift = useRef(false);
  const expandPreviousDay = useCallback(() => {
    if (previousExpanded) return;
    const panel = previousPanelRef.current; const axis = axisRef.current;
    previousExpansionRef.current = { beforeHeight: panel?.getBoundingClientRect().height ?? 0, scrollTop: axis?.scrollTop ?? 0 };
    suppressPreviousShift.current = true;
    setExpandedPreviousDate(previousDate);
  }, [previousDate, previousExpanded]);
  useLayoutEffect(() => {
    if (!previousExpanded) return;
    const info = previousExpansionRef.current; previousExpansionRef.current = null;
    const panel = previousPanelRef.current; const axis = axisRef.current;
    if (!info || !panel || !axis) return;
    const delta = panel.getBoundingClientRect().height - info.beforeHeight;
    // 用户停在日期带顶部时，展开就是把前一天铺在下面；停在别处时保持当前内容不动，
    // 只把新增的高度补进 scrollTop，避免整屏跳走。
    if (delta > 0 && info.scrollTop > 0) { axis.scrollTop = info.scrollTop + delta; onProgrammaticPosition(); }
  }, [previousExpanded, onProgrammaticPosition]);
  // 三日缓冲的对齐不再直接写 scrollTop：交给父级的滚动仲裁（优先级 4），由它把
  // 「缓冲平移 → 进入恢复／首次定位」串成一次落地。layout effect 只负责最早提交请求；
  // 真正的写入发生在仲裁的 rAF 里 —— 那时父级 ref 已挂上，`onProgrammaticPosition()`
  // 才能找到滚动容器（首屏直接挂载日视图时，子组件的 layout effect 早于父级 ref）。
  useLayoutEffect(() => {
    const discard = () => { pendingScrollOffset.current = null; shifting.current = false; };
    onBufferShift(() => {
      const axis = axisRef.current;
      if (!axis) return true;
      const panels = Array.from(axis.querySelectorAll<HTMLElement>(".continuous-day-panel"));
      const fallback = axis.scrollHeight / 3;
      const starts = continuousPanelStarts(axis, panels, fallback);
      axis.scrollTop = starts[1] + (pendingScrollOffset.current ?? 0);
      // 写入之后告知滚动仲裁入口：刚发生的这次 scroll 是应用自己的定位
      // （三日缓冲平移，优先级 4），不是用户滚动，不能作废「进入视图恢复」。
      onProgrammaticPosition();
      pendingScrollOffset.current = null; shifting.current = false;
      return true;
    }, discard);
  }, [anchor, onBufferShift, onProgrammaticPosition]);
  const onScroll = () => {
    const axis = axisRef.current; if (!axis || shifting.current) return;
    // 应用自己的定位（恢复浏览位置、目标显露、三日缓冲平移）不参与「滚到隔壁那天」的判定：
    // 刚过午夜时「现在」本来就在首段上半部分，居中会让 scrollTop 落到中段起点之上，
    // 那不是用户意图，之前会把锚点错误地退到前一天。
    if (isProgrammaticScroll()) return;
    const panels = Array.from(axis.querySelectorAll<HTMLElement>(".continuous-day-panel"));
    const fallback = axis.scrollHeight / 3; if (!fallback) return;
    const [firstStart, middleStart, nextStart] = continuousPanelStarts(axis, panels, fallback);
    if (axis.scrollTop < middleStart) {
      // 前一天还是 44px 带子时，顶部不是「用户已经进入前一天」，先把带子展开；
      // 展开后继续向上滚才真正把锚点移到前一天。
      if (!previousExpanded) return;
      if (suppressPreviousShift.current) { suppressPreviousShift.current = false; return; }
      shifting.current = true; pendingScrollOffset.current = axis.scrollTop - firstStart; onAnchorChange(addDays(anchor, -1));
    }
    else { suppressPreviousShift.current = false; if (axis.scrollTop >= nextStart) { shifting.current = true; pendingScrollOffset.current = axis.scrollTop - nextStart; onAnchorChange(addDays(anchor, 1)); } }
  };
  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (previousExpanded || event.ctrlKey || event.deltaY >= 0) return;
    const axis = axisRef.current;
    if (axis && axis.scrollTop <= 0) expandPreviousDay();
  };
  return <div ref={axisRef} className="continuous-day-axis" role="region" aria-label="连续日时间轴" onScroll={onScroll} onWheel={onWheel}>
    {[previousDate, anchor, addDays(anchor, 1)].map((date) => {
      const collapsedPrevious = date === previousDate && !previousExpanded;
      return <section key={date} ref={date === previousDate ? previousPanelRef : undefined} className={`continuous-day-panel ${collapsedPrevious ? "is-previous-collapsed" : ""}`.trim()} data-calendar-date={date} aria-label={formatLongDate(date)}>
        {/* §198：跨过午夜拖动时，落点所在那一天的日期带保持醒目 —— 日期归属由它承担。 */}
        <CalendarDayBand date={date} workspace={workspace} now={now} previous={date === previousDate} collapsed={collapsedPrevious} dragging={dragTargetDate === date} onExpand={collapsedPrevious ? expandPreviousDay : undefined} />
        {!collapsedPrevious && <DayCalendarGrid date={date} workspace={workspace} index={index} preferences={preferences} now={now} focusSessionId={focusSessionId} edgeScrollHoldRef={edgeScrollHoldRef} onSchedule={onSchedule} onCreateTaskAt={onCreateTaskAt} onProgress={onProgress} onSkipReview={onSkipReview} onContinue={onContinue} onCreateBlock={onCreateBlock} onUpdateBlock={onUpdateBlock} onDeleteBlock={onDeleteBlock} onEditSession={onEditSession} />}
      </section>;
    })}
  </div>;
}

function CalendarDayBand({ date, workspace, now, previous, collapsed, dragging = false, onExpand }: {
  date: string; workspace: WorkspaceSnapshot; now: Date; previous: boolean; collapsed: boolean; dragging?: boolean; onExpand?: () => void;
}) {
  const today = toLocalDate(now);
  const summary = calendarDaySummary(workspace, date, today);
  const count = summary.scheduledSessions.length;
  const minutes = formatCompactMinutes(summary.scheduledMinutes);
  const facts = count === 0 ? "无安排" : `${count} 项安排`;
  const detail = `${facts}${minutes ? ` · 投入 ${minutes}` : ""}`;
  return <header className={`calendar-day-band ${previous ? "is-previous" : ""} ${collapsed ? "is-collapsed" : ""} ${dragging ? "is-drag-target" : ""}`.trim()} data-drag-target={dragging ? "true" : undefined} aria-label={`${previous ? "前一天 " : ""}${formatLongDate(date)} · ${detail}`}>
    <strong className="calendar-day-band-date">{formatShortDate(date)} <span>{weekday(date)}</span></strong>
    {date === today && <span className="calendar-day-band-today">今天</span>}
    <span className="calendar-day-band-summary" title={detail}>{facts}{minutes ? ` · 投入 ${minutes}` : ""}</span>
    {onExpand && <button type="button" className="calendar-day-band-expand" aria-label={`展开前一天 ${formatLongDate(date)}`} title="展开前一天" onClick={onExpand}><ChevronDown size={16} aria-hidden="true" />展开</button>}
  </header>;
}

function continuousPanelStarts(axis: HTMLElement, panels: HTMLElement[], fallback: number): [number, number, number] {
  const axisTop = axis.getBoundingClientRect().top;
  const measured = panels.map((panel) => panel.getBoundingClientRect().top - axisTop + axis.scrollTop);
  return measured.length === 3 && measured[1] > measured[0] && measured[2] > measured[1]
    ? measured as [number, number, number]
    : [0, fallback, fallback * 2];
}

function DayCalendarGrid({ date, workspace, index, preferences, now, focusSessionId, edgeScrollHoldRef, onSchedule, onCreateTaskAt, onProgress, onSkipReview, onContinue, onCreateBlock, onUpdateBlock, onDeleteBlock, onEditSession }: {
  date: string; workspace: WorkspaceSnapshot; index: WorkspaceIndex; preferences: AppSettings; now: Date; focusSessionId: string | null;
  /** 折叠条正在被拖拽悬停展开时置 true：`useDragSession` 的边缘滚动据此让路（B3／D13）。 */
  edgeScrollHoldRef: RefObject<boolean>;
  onSchedule: (task: Task, date: string, start: string) => Promise<void>;
  onCreateTaskAt: (title: string, date: string, start: string, duration: number) => Promise<void>;
  onProgress: (task: Task, value: number, anchor: HTMLElement | null) => Promise<void>; onSkipReview: (session: ExecutionSession) => Promise<void>; onContinue: (session: ExecutionSession) => void;
  onCreateBlock: (block: TimeBlock) => Promise<void>; onUpdateBlock: (previous: TimeBlock, next: TimeBlock) => Promise<void>; onDeleteBlock: (id: string) => Promise<void>; onEditSession: (session: ExecutionSession, anchorElement: HTMLElement | null) => void;
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
  // 有效日：凌晨／深夜没有安排、时间块或记录，且「现在」不在其中时才折叠。
  // 判定只看该日真实存在的事实；偏移量仍由 calendarTimeline 的补集逻辑算。
  const fullDayRanges = useMemo(() => {
    if (preferences.calendarDayMode !== "fullDay") return undefined;
    const occupied: Array<{ start: number; end: number }> = [];
    for (const session of workspace.executionSessions) {
      if (session.localDate !== date || session.status === "cancelled" || session.status === "skipped") continue;
      const start = timeMinutes(session.startLocal); const end = timeMinutes(session.endLocal);
      occupied.push({ start, end: end <= start ? 1440 : end });
    }
    for (const block of workspace.timeBlocks) {
      if (block.localDate !== date) continue;
      const start = timeMinutes(block.startLocal); const end = timeMinutes(block.endLocal);
      occupied.push({ start, end: end <= start ? 1440 : end });
    }
    for (const record of workspace.executionRecords) {
      const slice = actualRecordSlice(record, date, now);
      if (slice) occupied.push({ start: timeMinutes(slice.start), end: timeMinutes(slice.end) });
    }
    occupied.push(...currentSessionRanges, ...focusedSessionRanges);
    return fullDayEffectiveRanges({
      occupiedRanges: occupied,
      currentMinute: isToday ? now.getHours() * 60 + now.getMinutes() : null,
    });
  }, [currentSessionRanges, date, focusedSessionRanges, isToday, now, preferences.calendarDayMode, workspace.executionRecords, workspace.executionSessions, workspace.timeBlocks]);
  // 设置里没有可用时间窗口时，defaultSlots 会整天塌成一条折叠带（calendarTimeline.ts 的补集逻辑）；
  // 这里按 fullDay 渲染兜底，偏好值不改写 —— 用户补回时段后自动恢复默认时段渲染（C1／#1）。
  // 判据只看设置里的整份列表：只有某天没有时段（如周末）是原本就有的折叠语义，不在本包范围。
  const defaultsCollapsed = preferences.calendarDayMode === "defaultSlots" && preferences.defaultTimeSlots.length === 0;
  const timeline = useMemo(() => createCalendarTimeline({
    mode: defaultsCollapsed ? "fullDay" : preferences.calendarDayMode,
    slots,
    expandedGapKeys: visibleGapKeys,
    currentMinute: preferences.calendarDayMode === "defaultSlots" && !defaultsCollapsed && isToday ? now.getHours() * 60 + now.getMinutes() : null,
    revealedRanges: [...currentSessionRanges, ...focusedSessionRanges],
    fullDayRanges,
    pixelsPerHour: preferences.calendarScale.day,
    collapsedGapPx: collapsedGapHeight(preferences.scale),
  }), [currentSessionRanges, focusedSessionRanges, fullDayRanges, isToday, now, preferences.calendarDayMode, preferences.calendarScale.day, preferences.scale, slots, visibleGapKeys, defaultsCollapsed]);
  // 全天模式默认按百分比铺满 24 小时，不建映射（保持既有布局与既有偏移语义）。
  // 只有这个日子**真的**折掉了凌晨／深夜时才切到分段映射：折叠条、卡片偏移与滚动采样
  // 必须共用同一套像素。判据看有效日范围是不是还覆盖整天，而不是「当前有没有折叠条」——
  // 两端都折时范围会合成一整段，手动展开整天后范围仍是拆开的，映射要留着，
  // 「收起凌晨／收起深夜」才继续点得到。
  const foldsEffectiveDay = preferences.calendarDayMode === "fullDay"
    && !fullDayRanges?.some((range) => range.start === 0 && range.end === 1440);
  const activeTimeline = (preferences.calendarDayMode === "defaultSlots" && !defaultsCollapsed) || foldsEffectiveDay ? timeline : undefined;
  const toggleGap = (key: string) => setExpandedGapKeys((current) => {
    const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next;
  });
  const cancelDragHoverTimer = useCallback(() => { if (dragHoverTimer.current !== null) window.clearTimeout(dragHoverTimer.current); dragHoverTimer.current = null; }, []);
  useEffect(() => () => cancelDragHoverTimer(), [cancelDragHoverTimer]);
  const beginGapHover = (key: string) => { if (dragHoverTimer.current !== null || dragExpandedGapKey === key) return; dragHoverTimer.current = window.setTimeout(() => { dragHoverTimer.current = null; setDragExpandedGapKey(key); }, 500); };
  const leaveGapHover = () => { if (dragHoverTimer.current !== null) { window.clearTimeout(dragHoverTimer.current); dragHoverTimer.current = null; } };
  /**
   * 拖拽悬停折叠条约半秒自动展开（§128）。B2 起没有 `dragenter` 可听：指针在哪条折叠条上
   * 由状态机算（`preview.collapsedGapKey`），这里只按它开表计时。
   */
  const drag = useDragSessionContext();
  /**
   * 指针下的折叠条。展开之后那条折叠条本身就不存在了，所以还要认「指针仍在刚展开的那一段里」
   * —— 否则展开后指针一动就自己收回去（旧实现靠 `drag-expanded-region` 的 dragleave 兜住）。
   */
  const hoveredGapKey = (() => {
    if (!drag.preview || drag.preview.kind === "resize" || drag.preview.date !== date) return null;
    if (drag.preview.collapsedGapKey) return drag.preview.collapsedGapKey;
    if (!dragExpandedGapKey) return null;
    const gap = timelineRangeFromKey(dragExpandedGapKey);
    const minute = drag.preview.startMinute;
    return gap && minute >= gap.start && minute <= gap.end ? dragExpandedGapKey : null;
  })();
  /** 展开过的那一段：松手成功时要把它留在 `expandedGapKeys` 里（§128 的最后半句）。 */
  const dragExpandedRef = useRef<string | null>(null);
  useEffect(() => {
    if (hoveredGapKey) {
      dragExpandedRef.current = hoveredGapKey;
      beginGapHover(hoveredGapKey);
      return;
    }
    leaveGapHover();
    setDragExpandedGapKey(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredGapKey]);
  /**
   * 松手后：提交成功就保留这次临时展开（让用户看到结果），取消则复原。
   * 判据是状态机的 `commitCount` —— 取消/拖出不会加一。
   */
  const commitCountRef = useRef(drag.commitCount);
  const wasDraggingRef = useRef(false);
  useEffect(() => {
    if (drag.phase !== "idle") { wasDraggingRef.current = true; return; }
    if (!wasDraggingRef.current) { commitCountRef.current = drag.commitCount; return; }
    wasDraggingRef.current = false;
    const expanded = dragExpandedRef.current;
    if (drag.commitCount !== commitCountRef.current && expanded) {
      setExpandedGapKeys((current) => new Set(current).add(expanded));
    }
    setDragExpandedGapKey(null);
    dragExpandedRef.current = null;
    commitCountRef.current = drag.commitCount;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag.phase, drag.commitCount]);
  /**
   * 展开期间给边缘滚动踩刹车（B3／D13）。
   *
   * 只在**本网格**的展开态真的变化时写这个 ref：三日缓冲有三块网格共用一个出口，
   * 每次渲染都无条件写会让「一块展开」被「另一块本来就是收起」覆盖掉。
   */
  const holdWrittenRef = useRef(false);
  useEffect(() => {
    const hold = dragExpandedGapKey !== null;
    if (hold === holdWrittenRef.current) return;
    holdWrittenRef.current = hold;
    edgeScrollHoldRef.current = hold;
  }, [dragExpandedGapKey, edgeScrollHoldRef]);
  useEffect(() => () => { if (holdWrittenRef.current) edgeScrollHoldRef.current = false; }, [edgeScrollHoldRef]);
  // 目标时段的显露（优先级 2）由 CalendarPage 的滚动仲裁统一处理，
  // 这里只负责把聚焦时段并入折叠时间轴的临时显露范围。
  return <div className="calendar-grid day" style={activeTimeline ? { height: `${activeTimeline.totalHeight}px` } : undefined}><CalendarTimeAxis timeline={activeTimeline} /><CalendarDay date={date} workspace={workspace} index={index} preferences={preferences} now={now} timeline={activeTimeline} expandedGapKeys={expandedGapKeys} dragExpandedGapKey={dragExpandedGapKey} focusSessionId={focusSessionId} onToggleGap={toggleGap} onSchedule={onSchedule} onCreateTaskAt={onCreateTaskAt} onProgress={onProgress} onSkipReview={onSkipReview} onContinue={onContinue} onCreateBlock={onCreateBlock} onUpdateBlock={onUpdateBlock} onDeleteBlock={onDeleteBlock} onEditSession={onEditSession} /></div>;
}

function CalendarTimeAxis({ timeline }: { timeline?: CalendarTimeline }) {
  return <div className="time-axis"><div className="time-axis-track" style={timeline ? { height: `${timeline.totalHeight}px` } : undefined}>{Array.from({ length: 24 }, (_, hour) => {
    const minute = hour * 60; const segment = timeline?.segments.find((item) => minute >= item.start && minute < item.end);
    if (segment?.collapsed) return null;
    return <span key={hour} style={{ top: timeline ? `${timeline.offsetAtMinute(minute)}px` : `${hour / 24 * 100}%` }}>{String(hour).padStart(2, "0")}:00</span>;
  })}</div></div>;
}

function MonthCalendar({ anchor, workspace, selectedDate, focusDate, onFocusDate, onNavigateDate, onSelectDate, onOpenDate, onOpenTask, onOpenProject }: { anchor: string; workspace: WorkspaceSnapshot; selectedDate: string | null; focusDate: string; onFocusDate: (date: string) => void; onNavigateDate: (date: string) => void; onSelectDate: (date: string) => void; onOpenDate: (date: string) => void; onOpenTask: (date: string, taskId: string) => void; onOpenProject: (date: string, projectId: string) => void }) {
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
  // 月历是一张真正的表：6 行 × 7 列。`role="grid"` 的直接子元素只能是 `role="row"`，
  // 表头那一行也一样 —— 否则 42 个 gridcell 与 7 个 columnheader 都没有 row 祖先，
  // axe 报 `aria-required-children` + `aria-required-parent`（P4-11 修）。
  // 七列因此落在「行」上，外层只排 7 行；视觉几何不变（见 styles.css 的
  // `.month-calendar`／`.month-calendar-row`）。
  const weeks = Array.from({ length: 6 }, (_, index) => dates.slice(index * 7, index * 7 + 7));
  return <div ref={gridRef} className="month-calendar" role="grid" aria-label="月历">
    <div className="month-calendar-row" role="row">
      {(["一", "二", "三", "四", "五", "六", "日"] as const).map((day) => <div key={day} role="columnheader" aria-label={`周${day}`}>周{day}</div>)}
    </div>
    {weeks.map((week) => <div key={week[0]} className="month-calendar-row" role="row">
      {week.map((date) => {
        const summary = calendarDaySummary(workspace, date, today);
        // 标记行只放重要事实，至多两条；安排／完成／推进收成一条聚合行，零值不写那一段。
        const markers = [
          ...summary.deadlines.map((task) => ({ id: `deadline:${task.id}`, kind: "deadline" as const, label: task.title, taskId: task.id, projectId: null, urgency: deadlineUrgency(date, today) })),
          ...summary.projectDeadlines.map((project) => ({ id: `projectDeadline:${project.id}`, kind: "projectDeadline" as const, label: project.title, taskId: null, projectId: project.id, urgency: deadlineUrgency(date, today) })),
          ...summary.milestones.map((milestone) => ({ id: `milestone:${milestone.id}`, kind: "milestone" as const, label: milestone.title, taskId: null, projectId: milestone.projectId, urgency: deadlineUrgency(date, today) })),
        ];
        const visible = markers.slice(0, 2); const overflow = markers.length - visible.length;
        const aggregate = [
          summary.scheduledSessions.length ? `安排 ${summary.scheduledSessions.length}` : "",
          summary.completedTasks.length ? `完成 ${summary.completedTasks.length}` : "",
          summary.progressedTasks.length ? `推进 ${summary.progressedTasks.length}` : "",
        ].filter(Boolean).join(" · ");
        return <div key={date} role="gridcell" data-month-date={date} tabIndex={date === focusDate ? 0 : -1} className={`${date.startsWith(month) ? "" : "adjacent-month"} ${date === today ? "today" : ""} ${date === selectedDate ? "selected" : ""}`.trim()} aria-label={`${date} ${formatLongDate(date)}`} aria-selected={date === selectedDate} onFocus={() => onFocusDate(date)} onKeyDown={(event) => keyDown(event, date)} onClick={() => onSelectDate(date)}><header><span>{Number(date.slice(-2))}</span>{date === today && <small>今天</small>}</header>{(visible.length > 0 || overflow > 0 || aggregate) && <div className="month-cell-summary">{visible.map((item) => item.kind === "deadline" ? <button key={item.id} className={`month-summary-item deadline urgency-${item.urgency}`} aria-label={`${deadlineUrgencyLabel(item.urgency)}：${item.label}`} title={`${deadlineUrgencyLabel(item.urgency)}：${item.label}`} onClick={(event) => { event.stopPropagation(); onOpenTask(date, item.taskId!); }}><Flag size={11} aria-hidden="true" /><span title={item.label}>{item.label}</span></button> : item.kind === "projectDeadline" ? <button key={item.id} className={`month-summary-item projectDeadline urgency-${item.urgency}`} aria-label={`${deadlineUrgencyLabel(item.urgency)}：项目截止 ${item.label}`} title={`${deadlineUrgencyLabel(item.urgency)}：项目截止 ${item.label}`} onClick={(event) => { event.stopPropagation(); onOpenProject(date, item.projectId!); }}><Flag size={11} aria-hidden="true" /><span title={item.label}>{item.label}</span></button> : <button key={item.id} className="month-summary-item milestone milestone-marker" aria-label={`里程碑：${item.label}`} title={`里程碑：${item.label}`} onClick={(event) => { event.stopPropagation(); onOpenProject(date, item.projectId!); }}><Diamond size={11} aria-hidden="true" /><span title={item.label}>{item.label}</span></button>)}{overflow > 0 && <button className="month-summary-overflow" onClick={(event) => { event.stopPropagation(); onOpenDate(date); }}>另外 {overflow} 项</button>}{aggregate && <span className="month-cell-aggregate" title={aggregate}>{aggregate}</span>}</div>}</div>;
      })}</div>)}
  </div>;
}

const CALENDAR_URGENCY_RANK: Record<DeadlineUrgency, number> = { overdue: 0, today: 1, soon: 2, later: 3 };
/** 日历卡片的分类色条：与回顾页／任务池的项目标识共用同一套 `--chart-N` 色板。 */
function calendarProjectColor(projects: Project[], projectId: string | null) {
  if (!projectId) return "var(--muted-strong)";
  const position = projects.findIndex((project) => project.id === projectId);
  return position < 0 ? "var(--muted-strong)" : `var(--chart-${(position % 6) + 1}-ink)`;
}
function calendarMarkerLabel(marker: CalendarMarker) {
  return marker.kind === "milestone" ? marker.label : marker.kind === "projectDeadline" ? `项目截止 · ${marker.label}` : `${marker.urgency !== "later" ? `${deadlineUrgencyLabel(marker.urgency)} · ` : ""}${marker.label}`;
}

function WeekDateHeaders({ dates, today, focusDate, allDayOpen, allDayId, onToggleAllDay, onFocusDate, onMoveDate, onOpenDate }: { dates: string[]; today: string; focusDate: string | null; allDayOpen: boolean; allDayId: string; onToggleAllDay: () => void; onFocusDate: (date: string) => void; onMoveDate: (date: string) => void; onOpenDate: (date: string) => void }) {
  const keyDown = (event: React.KeyboardEvent<HTMLButtonElement>, date: string) => {
    if (event.key === "Enter") { event.preventDefault(); onOpenDate(date); return; }
    const next = event.key === "ArrowLeft" ? addDays(date, -1) : event.key === "ArrowRight" ? addDays(date, 1) : event.key === "PageUp" ? addDays(date, -7) : event.key === "PageDown" ? addDays(date, 7) : null;
    if (!next) return;
    event.preventDefault(); onMoveDate(next);
    event.currentTarget.closest(".week-date-headers")?.querySelector<HTMLElement>(`[data-week-header="${next}"]`)?.focus();
  };
  // D17：日期头不再是「选中这一列」，点击／Enter 直接进入该日的日视图。
  return <div className="week-date-headers" aria-label="周日期头"><div className="week-date-gutter"><button type="button" className="week-all-day-toggle" aria-expanded={allDayOpen} aria-controls={allDayId} aria-label={allDayOpen ? "收起全天标记" : "展开全天标记"} title={allDayOpen ? "收起全天标记" : "展开全天标记"} onClick={onToggleAllDay}><span>全天</span>{allDayOpen ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}</button></div>{dates.map((date) => <div key={date} className="week-date-cell"><button type="button" data-week-header={date} className="week-date-main" tabIndex={date === focusDate ? 0 : -1} aria-label={`打开 ${date} ${formatLongDate(date)} 日视图`} onFocus={() => onFocusDate(date)} onKeyDown={(event) => keyDown(event, date)} onClick={() => onOpenDate(date)}><strong>{date === today ? "今天" : weekday(date)}</strong><span className={date === today ? "today-number" : ""}>{Number(date.slice(-2))}</span></button></div>)}</div>;
}

function WeekAllDayArea({ id, open, dates, workspace, onOpenDay }: { id: string; open: boolean; dates: string[]; workspace: WorkspaceSnapshot; onOpenDay: (date: string) => void }) {
  const today = toLocalDate(new Date());
  const groupsFor = (markers: CalendarMarker[]) => ([
    { kind: "taskDeadline" as const, label: "截止", markers: markers.filter((marker) => marker.kind === "taskDeadline") },
    { kind: "projectDeadline" as const, label: "项目截止", markers: markers.filter((marker) => marker.kind === "projectDeadline") },
    { kind: "milestone" as const, label: "里程碑", markers: markers.filter((marker) => marker.kind === "milestone") },
  ]).filter((group) => group.markers.length > 0);
  // D17：全天 chip 也是「一天」的入口，单击直接进入该日日视图；不再列二级名单。
  return <section id={id} className={`week-all-day ${open ? "open" : "collapsed"}`} aria-label="全天标记" hidden={!open}><div className="week-all-day-spacer" aria-hidden="true" />{open && dates.map((date) => { const markers = calendarDayMarkers(workspace, date, today); const groups = groupsFor(markers); /* 单行带：只留第一组，其余收进「+N」。 */ const visible = groups.slice(0, 1); const extra = groups.length - visible.length; return <div key={date} className="week-all-day-cell" data-all-day-date={date}>{visible.map((group) => { const urgency = group.markers.reduce<DeadlineUrgency>((worst, marker) => CALENDAR_URGENCY_RANK[marker.urgency] < CALENDAR_URGENCY_RANK[worst] ? marker.urgency : worst, "later"); const label = `${group.label} ${group.markers.length}`; const detail = group.markers.map(calendarMarkerLabel).join("；"); return <button key={group.kind} type="button" className={`week-all-day-chip urgency-${urgency} ${group.kind === "milestone" ? "milestone-marker" : group.kind === "projectDeadline" ? "project-deadline-marker" : ""}`} data-all-day-group={group.kind} aria-label={`${label} 项：${detail}，打开 ${formatLongDate(date)} 日视图`} title={detail} onClick={() => onOpenDay(date)}>{group.kind === "milestone" ? <Diamond size={11} aria-hidden="true" /> : <Flag size={11} aria-hidden="true" />}<span title={detail}>{label}</span></button>; })}{extra > 0 && <button type="button" className="week-all-day-chip week-all-day-more" data-all-day-group="more" aria-label={`另外 ${extra} 组全天标记，打开 ${formatLongDate(date)} 日视图`} title={`另外 ${extra} 组：${markers.map(calendarMarkerLabel).join("；")}`} onClick={() => onOpenDay(date)}>+{extra}</button>}</div>; })}</section>;
}

function CalendarDateDetails({ date, workspace, taskId, projectId, onOpenDay, onClose }: { date: string; workspace: WorkspaceSnapshot; taskId: string | null; projectId: string | null; onOpenDay: () => void; onClose: () => void }) {
  const host = useOptionalOverlayHost();
  const layerCount = host?.layerCount ?? 0;
  const closeRef = useRef(onClose); closeRef.current = onClose;
  // 详情面板不是浮层栈成员：只在没有其它浮层时接 Esc，避免和气泡抢同一个键。
  useEffect(() => {
    if (layerCount > 0) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); closeRef.current(); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [layerCount]);
  const summary = calendarDaySummary(workspace, date); const task = taskId ? workspace.tasks.find((item) => item.id === taskId) ?? null : null;
  const project = projectId ? workspace.projects.find((item) => item.id === projectId) ?? null : null;
  const sessions = workspace.executionSessions.filter((session) => session.localDate === date && session.status !== "cancelled").sort(compareSessions);
  const blocks = workspace.timeBlocks.filter((block) => block.localDate === date).sort((left, right) => left.startLocal.localeCompare(right.startLocal));
  return <aside className="calendar-date-details" aria-label={`${date} ${formatLongDate(date)}详情`}><header><div><span className="eyebrow">已选日期</span><h2>{formatLongDate(date)}</h2></div><div className="calendar-date-details-actions"><Button onClick={onOpenDay}>打开日视图</Button><button type="button" className="icon-action" aria-label="关闭日期详情" title="关闭日期详情" onClick={onClose}><X size={16} aria-hidden="true" /></button></div></header>{task ? <section className="calendar-task-detail"><span className="eyebrow">截止任务</span><h3>{task.title}</h3><p>{workspace.projects.find((project) => project.id === task.projectId)?.title ?? "独立任务"} · 当前进度 {task.progress}%</p><span className="deadline-chip">截止 {formatShortDate(date)}</span></section> : project ? <section className="calendar-project-detail"><span className="eyebrow">项目</span><h3>{project.title}</h3>{project.deadlineLocal ? <ProjectDeadlineChip deadline={project.deadlineLocal} today={date} /> : <p>没有设置项目截止日期。</p>}<div className="calendar-project-milestones">{workspace.projectMilestones.filter((milestone) => milestone.projectId === project.id).sort((a, b) => a.targetLocalDate.localeCompare(b.targetLocalDate) || a.sortOrder - b.sortOrder).map((milestone) => <article key={milestone.id} className={milestone.targetLocalDate === date ? "on-date" : ""}><Diamond size={14} aria-hidden="true" /><div><strong>{milestone.title}</strong><span>{milestone.targetLocalDate === date ? "今天到期" : `${formatShortDate(milestone.targetLocalDate)}到期`} · {milestoneSummary(milestone, workspace.tasks.filter((item) => item.projectId === project.id))}</span></div></article>)}{workspace.projectMilestones.some((milestone) => milestone.projectId === project.id) || <p className="empty-inline">该项目还没有里程碑。</p>}</div></section> : <><section><h3>重要事实</h3>{summary.deadlines.map((item) => <article key={item.id}><Flag size={14} /><div><strong>{item.title}</strong><span>任务截止 · {item.progress}%</span></div></article>)}{summary.projectDeadlines.map((item) => <article key={`project-${item.id}`}><Flag size={14} /><div><strong>{item.title}</strong><span>项目截止</span></div></article>)}{summary.milestones.map((item) => <article key={`milestone-${item.id}`}><Diamond size={14} /><div><strong>{item.title}</strong><span>里程碑到期</span></div></article>)}{summary.completedTasks.map((item) => <article key={`done-${item.id}`}><Check size={14} /><div><strong>{item.title}</strong><span>当天曾完成 · 当前 {item.progress}%</span></div></article>)}{summary.progressedTasks.map((item) => <article key={`progress-${item.id}`}><ArrowUp size={14} /><div><strong>{item.title}</strong><span>当天有进度变化</span></div></article>)}{summary.missedTasks.map((item) => <article key={`missed-${item.id}`}><Ban size={14} /><div><strong>{item.title}</strong><span>本次未推进</span></div></article>)}{summary.deadlines.length + summary.projectDeadlines.length + summary.milestones.length + summary.completedTasks.length + summary.progressedTasks.length + summary.missedTasks.length === 0 && <p className="empty-inline">当天没有截止、完成或推进事实。</p>}</section><section><h3>当天安排</h3>{sessions.map((session) => <article key={session.id}><Clock3 size={14} /><div><strong>{taskTitle(workspace, session.taskId)}</strong><span>{session.startLocal}–{session.endLocal}</span></div></article>)}{blocks.map((block) => <article key={block.id}><Clock3 size={14} /><div><strong>{block.title}</strong><span>{block.startLocal}–{block.endLocal} · 时间块</span></div></article>)}{sessions.length + blocks.length === 0 && <p className="empty-inline">当天没有执行时段或时间块。</p>}</section></>}</aside>;
}

function CalendarDay({ date, workspace, index, preferences, now, timeline, expandedGapKeys, dragExpandedGapKey, focusSessionId, onToggleGap, concurrencyLimit, onOpenDay, weekGridTabIndex, weekGridMinute, onWeekGridFocus, onWeekGridNavigate, onSchedule, onCreateTaskAt, onProgress, onSkipReview, onContinue, onCreateBlock, onUpdateBlock, onDeleteBlock, onEditSession }: {
  date: string; workspace: WorkspaceSnapshot; index: WorkspaceIndex; preferences: AppSettings; now: Date;
  /** 只有日视图会传 `timeline`／`expandedGapKeys`／`onToggleGap`：折叠与拖拽悬停展开只属于日视图（D6）。 */
  timeline?: CalendarTimeline; expandedGapKeys?: ReadonlySet<string>; dragExpandedGapKey?: string | null; focusSessionId?: string | null; onToggleGap?: (key: string) => void;
  concurrencyLimit?: number; weekGridTabIndex?: number; weekGridMinute?: number; onWeekGridFocus?: () => void; onWeekGridNavigate?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  /** 周视图的「点一天」入口：单击空白格（没有拖出选区）时跳到该日日视图（D17）。 */
  onOpenDay?: (date: string) => void;
  onSchedule: (task: Task, date: string, start: string) => Promise<void>;
  onCreateTaskAt: (title: string, date: string, start: string, duration: number) => Promise<void>;
  onProgress: (task: Task, value: number, anchor: HTMLElement | null) => Promise<void>; onSkipReview: (session: ExecutionSession) => Promise<void>; onContinue: (session: ExecutionSession) => void;
  onCreateBlock: (block: TimeBlock) => Promise<void>; onUpdateBlock: (previous: TimeBlock, next: TimeBlock) => Promise<void>; onDeleteBlock: (id: string) => Promise<void>;
  onEditSession: (session: ExecutionSession, anchorElement: HTMLElement | null) => void;
}) {
  // B2 起列里没有任何拖拽状态：预览、跟手位移、落点全部来自 App 层的那一个状态机。
  const [expandedConcurrency, setExpandedConcurrency] = useState<string | null>(null);
  /** 并行组里被选中的那一张：视觉浮前 + 左右方向键切换（§176），不改日历顺序。 */
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [blankHoverMinute, setBlankHoverMinute] = useState<number | null>(null);
  const [blankRange, setBlankRange] = useState<{ start: number; end: number } | null>(null);
  const [blankAction, setBlankAction] = useState<"menu" | "new" | "pool" | "block" | null>(null);
  const [blankBusy, setBlankBusy] = useState(false); const [blankError, setBlankError] = useState("");
  const [blankAnchor, setBlankAnchor] = useState<DOMRect | null>(null);
  // 「从任务池安排」便捷面板：项目筛选 + 标题搜索（与任务池的分组语义一致）。
  const [blankQuery, setBlankQuery] = useState("");
  const [blankProject, setBlankProject] = useState("all");
  const [blankTitle, setBlankTitle] = useState(""); const blankSelectionStart = useRef<number | null>(null); const blankBubbleRef = useRef<HTMLElement>(null);
  const sessions = placeableSessions(workspace.executionSessions, date);
  /**
   * 刚刚放开去、写入还没回来的那一份。
   *
   * 源列把它从 `sessions` 里摘掉，目标列按落点先画一份 —— 否则松手后旧位置会继续
   * 显示这一份，等数据回来才跳走，就是跨列松手时的错位动画。清除时机见
   * `lib/pendingPlacement.ts`。
   */
  const pendingPlacement = usePendingPlacement();
  const landingHere = pendingPlacement && pendingPlacement.localDate === date
    ? workspace.executionSessions.find((item) => item.id === pendingPlacement.sessionId) ?? null
    : null;
  useEffect(() => {
    if (pendingPlacement && placementSettled(pendingPlacement, workspace.executionSessions)) setPendingPlacement(null);
  }, [pendingPlacement, workspace.executionSessions]);
  const renderedSessions = [...sessions.filter((item) => item.id !== pendingPlacement?.sessionId), ...(landingHere ? [landingHere] : [])];
  const concurrency = concurrentLayouts(sessions, concurrencyLimit);
  const blocks = workspace.timeBlocks.filter((item) => item.localDate === date);
  const defaultSlots = defaultSlotSlicesForWeekday(preferences.defaultTimeSlots, new Date(`${date}T12:00:00`).getDay());
  const isToday = date === toLocalDate(now); const nowMinute = now.getHours() * 60 + now.getMinutes();
  const effectiveDay = preferences.calendarDayMode === "fullDay";
  const firstCollapsedGapKey = timeline?.segments.find((segment) => segment.collapsed)?.gapKey ?? null;
  const actualRecords = preferences.showActualRecords ? workspace.executionRecords.flatMap((record) => {
    const slice = actualRecordSlice(record, date, now); return slice ? [{ record, ...slice }] : [];
  }) : [];
  const drag = useDragSessionContext();
  /**
   * 拖动中的落点预览。`move`（日历内移动）与 `create`（任务池拉进来新增一次时段）
   * 共用同一套渲染 —— 列里不再有第二份 preview 状态（B1 的列级 `dragPreview` 已删）。
   *
   * `resize` 不画落点框（卡片本身就是落点），但它的**让位**必须走同一条路（B3／F21）：
   * 拉长时同列后续时段的 `shifted` 与插入的 `shifted` 是同一份结构，真卡照常 `top` 过渡。
   */
  const columnPreview = drag.preview && drag.preview.date === date ? drag.preview : null;
  const activePreview = columnPreview && columnPreview.kind !== "resize" ? columnPreview : null;
  /**
   * §177 重叠区预演：把「松手后会变成什么」提前算出来。
   *
   * 只对 overlap 预览算 —— 把被抓的那一份以落点插进当天集合（移动时先摘掉源），
   * 再用同一个 `concurrentLayouts` 排一遍。预览期间的并排宽度、以及某项会不会被收进
   * 「另外 N 项」，都与松手后完全一致：同一份纯函数，不另写一套试算。
   */
  const previewLayouts = (() => {
    if (!activePreview || activePreview.mode !== "overlap") return null;
    const base = drag.sourceId ? sessions.filter((item) => item.id !== drag.sourceId) : sessions;
    const virtual: ExecutionSession = {
      id: "__drag-preview__", taskId: "",
      localDate: date, endLocalDate: placementDateTime(date, activePreview.startMinute + activePreview.duration).date,
      startLocal: minutesTime(activePreview.startMinute % 1440),
      endLocal: minutesTime((activePreview.startMinute + activePreview.duration) % 1440),
      timeZone: "local", utcOffsetMinutes: -new Date().getTimezoneOffset(), status: "scheduled",
    };
    return concurrentLayouts([...base, virtual], concurrencyLimit);
  })();
  const ghostRef = useRef<HTMLElement>(null);

  const minuteAtPointer = (clientY: number, track: HTMLDivElement) => {
    const rect = track.getBoundingClientRect(); if (!rect.height) return 0;
    const raw = timeline ? timeline.minuteAtOffset(clientY - rect.top) : ((clientY - rect.top) / rect.height) * 1440;
    return snapTo(raw, snapMinutesFor(preferences.snapMinutes, false), 0, 1439);
  };
  const pointsAtBlankTrack = (target: EventTarget | null) => !(target as HTMLElement | null)?.closest("button, input, .calendar-session, .calendar-time-block, .calendar-actual-record, .blank-action-bubble, .resize-handle, .session-edit-button");
  const dayClasses = ["calendar-day", isToday ? "today" : ""].filter(Boolean).join(" ");
  /**
   * 周视图**不是**一张表格：7 个日列各自是一条 24 小时连续时间轴，DOM 里没有「行」。
   * 所以这里不给 `.day-track` 挂 `role="gridcell"` —— 那会声称一个并不存在的
   * `grid → row → gridcell` 结构（axe `aria-required-parent`）。方案 B：日列与列里的
   * 时间光标都用 `group` + 可访问名表达（日列给出日期，光标给出「日期 + 时间 + 空白时间」）。
   * 周视图没有选中态：点一天直接进入日视图（D17）。
   * 方向键语义不变，说明见 docs/reports/phase-4-p4-11-implementation.md。
   */
  return <div className={dayClasses} data-day-date={date} role={onWeekGridNavigate ? "group" : undefined} aria-label={onWeekGridNavigate ? `${date} ${formatLongDate(date)}` : undefined}>
    <div className={timeline ? "day-track folded-timeline" : "day-track"} role={onWeekGridNavigate ? "group" : undefined} tabIndex={weekGridTabIndex} aria-label={onWeekGridNavigate ? `${date} ${minutesTime(weekGridMinute ?? 540)} 空白时间` : undefined} onFocus={(event) => { if (event.target === event.currentTarget) onWeekGridFocus?.(); }} onKeyDown={(event) => { if (event.target !== event.currentTarget || !onWeekGridNavigate) return; if (event.key === "Enter") { event.preventDefault(); const start = weekGridMinute ?? 540; setBlankRange({ start, end: Math.min(1440, start + 30) }); setBlankAction("menu"); return; } onWeekGridNavigate(event); }} style={timeline ? { height: `${timeline.totalHeight}px` } : undefined}
      onPointerDown={(event) => { if (event.button !== 0 || !pointsAtBlankTrack(event.target)) return; const minute = minuteAtPointer(event.clientY, event.currentTarget); blankSelectionStart.current = minute; setBlankRange({ start: minute, end: minute + 5 }); setBlankAction(null); try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* synthetic pointers need no capture */ } }}
      onPointerMove={(event) => { if (event.buttons !== 0) { if (blankSelectionStart.current === null) { setBlankHoverMinute(null); } return; } if (!pointsAtBlankTrack(event.target)) { if (blankSelectionStart.current === null) setBlankHoverMinute(null); return; } const minute = minuteAtPointer(event.clientY, event.currentTarget); if (blankSelectionStart.current === null) setBlankHoverMinute(minute); else { const start = Math.min(blankSelectionStart.current, minute); const end = Math.max(blankSelectionStart.current, minute, start + 5); setBlankRange({ start, end }); } }}
      onPointerUp={(event) => { if (blankSelectionStart.current === null) return; const origin = blankSelectionStart.current; const minute = minuteAtPointer(event.clientY, event.currentTarget); blankSelectionStart.current = null; const release = () => { try { if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ } }; /* 没拖出选区的单击＝打开这一天（D17）；拖过格才进入空白创建。 */ if (minute === origin && onOpenDay) { setBlankRange(null); setBlankAction(null); setBlankHoverMinute(null); setBlankQuery(""); setBlankProject("all"); release(); onOpenDay(date); return; } const start = Math.min(origin, minute); const end = minute === origin ? origin + 30 : Math.max(origin, minute, start + 5); setBlankAnchor(new DOMRect(event.clientX, event.clientY, 0, 0)); setBlankRange({ start, end: Math.min(1440, end) }); setBlankAction("menu"); setBlankQuery(""); setBlankProject("all"); release(); }}
      onPointerLeave={() => { if (blankSelectionStart.current === null) setBlankHoverMinute(null); }}
      /* 落点、让位与提交全部由 App 层的 `useDragSession` 处理：DOM 上不再挂任何 DnD 处理器（B2）。 */
      >
      {timeline?.segments.map((segment) => <i key={`map-${segment.start}-${segment.end}`} aria-hidden="true" className="timeline-map-segment" data-start-minute={segment.start} data-end-minute={segment.end} data-collapsed={segment.collapsed} style={{ top: `${segment.top}px`, height: `${segment.height}px` }} />)}
      {Array.from({ length: 24 }, (_, hour) => { const minute = hour * 60; const segment = timeline?.segments.find((item) => minute >= item.start && minute < item.end); return segment?.collapsed ? null : <div key={hour} className="hour-line" style={{ top: timeline ? `${timeline.offsetAtMinute(minute)}px` : `${hour / 24 * 100}%` }} />; })}
      {timeline?.segments.filter((segment) => segment.collapsed).map((segment) => {
        const count = [...sessions, ...blocks].filter((item) => rangeOverlaps(item.startLocal, item.endLocal, segment.start, segment.end)).length;
        const label = effectiveDay ? (segment.start === 0 ? "凌晨" : segment.start >= 1380 ? "深夜" : "非活跃时段") : `${boundaryTime(segment.start)}–${boundaryTime(segment.end)}`;
        const summary = effectiveDay ? "无安排" : `${count} 项安排`;
        const description = effectiveDay ? `${label} ${boundaryTime(segment.start)}–${boundaryTime(segment.end)} · ${summary}` : `${boundaryTime(segment.start)}–${boundaryTime(segment.end)} · ${summary}`;
        return <div key={`${segment.start}-${segment.end}`} className={`collapsed-time-gap ${effectiveDay ? "effective-day-gap" : ""}`.trim()} style={{ top: `${segment.top}px`, height: `${segment.height}px` }} data-gap-key={segment.gapKey ?? undefined}>
          <button type="button" className="collapsed-gap-main" aria-label={description} onClick={() => segment.gapKey && onToggleGap?.(segment.gapKey)}>{label}<span>{summary}</span></button>
          {effectiveDay && segment.gapKey === firstCollapsedGapKey && <button type="button" className="effective-day-expand" aria-label="展开整天" onClick={() => timeline.gaps.forEach((gap) => { if (!expandedGapKeys?.has(gap.key)) onToggleGap?.(gap.key); })}>展开整天</button>}
        </div>;
      })}
      {dragExpandedGapKey && timeline && (() => { const gap = timelineRangeFromKey(dragExpandedGapKey); return gap ? <div aria-hidden="true" className="drag-expanded-region" style={{ top: `${timeline.offsetAtMinute(gap.start)}px`, height: `${timeline.offsetAtMinute(gap.end) - timeline.offsetAtMinute(gap.start)}px` }} /> : null; })()}
      {[...(expandedGapKeys ?? [])].map((key) => { const gap = timelineRangeFromKey(key); return gap && timeline ? <button key={key} className="expanded-gap-toggle" aria-label={`收起 ${boundaryTime(gap.start)}–${boundaryTime(gap.end)}`} style={{ top: `${timeline.offsetAtMinute(gap.start)}px` }} onClick={() => onToggleGap?.(key)}>{effectiveDay ? (gap.start === 0 ? "收起凌晨" : gap.start >= 1380 ? "收起深夜" : "收起非可用时间") : "收起非可用时间"}</button> : null; })}
      {isToday && <><div className="calendar-past-region" aria-hidden="true" style={timeline ? { height: `${timeline.offsetAtMinute(nowMinute)}px` } : { height: `${nowMinute / 1440 * 100}%` }} /><div className="calendar-now-line" data-now-marker style={timeline ? { top: `${timeline.offsetAtMinute(nowMinute)}px` } : { top: `${nowMinute / 1440 * 100}%` }}><time>{formatLocalClock(now)}</time></div></>}
      {defaultSlots.map((slot) => { const style = timeline ? timeline.positionForRange(slot.start, slot.end) : positionStyle(slot.start, slot.end); return style ? <div key={slot.id} className="default-slot" style={style} /> : null; })}
      {blankHoverMinute !== null && !blankRange && !activePreview && <div className="blank-hover-cue" aria-hidden="true" style={{ top: timeline ? `${timeline.offsetAtMinute(blankHoverMinute)}px` : `${blankHoverMinute / 1440 * 100}%` }}><Plus size={14} /><time>{minutesTime(blankHoverMinute)}</time></div>}
      {blankRange && <div className="blank-range-preview" aria-label={`已选择 ${minutesTime(blankRange.start)} 至 ${minutesTime(blankRange.end % 1440)}`} style={timeline ? { top: `${timeline.offsetAtMinute(blankRange.start)}px`, height: `${Math.max(6, timeline.offsetAtMinute(blankRange.end) - timeline.offsetAtMinute(blankRange.start))}px` } : { top: `${blankRange.start / 1440 * 100}%`, height: `${(blankRange.end - blankRange.start) / 1440 * 100}%` }} />}
      {blankRange && blankAction && <FloatingPanel label="空白时段操作" kind="action" anchor={blankAnchor} onClose={() => { setBlankAction(null); setBlankRange(null); }} closeOnOutsideClick><section ref={blankBubbleRef} aria-busy={blankBusy} className="blank-action-bubble" onPointerDown={(event) => event.stopPropagation()}>
        <header><strong>{minutesTime(blankRange.start)}–{minutesTime(blankRange.end % 1440)}</strong><button disabled={blankBusy} aria-label="关闭空白时段操作" onClick={() => { setBlankAction(null); setBlankRange(null); }}><X size={13} /></button></header>
        {blankAction === "menu" && <div className="blank-action-menu"><button className="is-primary" onClick={() => setBlankAction("new")}><Plus size={14} aria-hidden="true" /><span>新建任务</span></button><button onClick={() => { setBlankQuery(""); setBlankProject("all"); setBlankAction("pool"); }}><Inbox size={14} aria-hidden="true" /><span>从任务池安排</span></button><button onClick={() => setBlankAction("block")}><Clock3 size={14} aria-hidden="true" /><span>时间块</span></button></div>}
        {blankAction === "new" && <div className="blank-inline-form"><label>任务标题<input autoFocus value={blankTitle} onChange={(event) => setBlankTitle(event.target.value)} /></label><div><button disabled={blankBusy} className="button-quiet" onClick={() => setBlankAction("menu")}>返回</button><button className="button-primary" disabled={blankBusy || !blankTitle.trim()} onClick={() => { if (blankBusy) return; setBlankBusy(true); setBlankError(""); const title = blankTitle.trim(); const duration = blankRange.end - blankRange.start; void onCreateTaskAt(title, date, minutesTime(blankRange.start), duration).then(() => { setBlankTitle(""); setBlankAction(null); setBlankRange(null); }).catch((reason) => setBlankError(readError(reason))).finally(() => setBlankBusy(false)); }}>创建</button></div></div>}
        {blankAction === "block" && <TimeBlockEditor initial={{ localDate: date, startLocal: minutesTime(blankRange.start), endLocal: minutesTime(blankRange.end % 1440) }} onCancel={() => setBlankAction("menu")} onCreate={async (block) => { await onCreateBlock(block); setBlankAction(null); setBlankRange(null); }} onPhase={setBlankBusy} />}
        {blankAction === "pool" && (() => {
          const schedulable = workspace.tasks.filter((task) => task.status === "active" && task.kind !== "habit");
          const projectIds = new Set(schedulable.map((task) => task.projectId ?? "__independent__"));
          const projectTitle = new Map(workspace.projects.map((project) => [project.id, project.title]));
          const query = blankQuery.trim().toLocaleLowerCase();
          const matches = schedulable.filter((task) => (blankProject === "all" || (task.projectId ?? "__independent__") === blankProject) && (!query || task.title.toLocaleLowerCase().includes(query)));
          if (!schedulable.length) return <span className="empty-inline">任务池暂无可安排任务</span>;
          return <div className="blank-task-picker">
            <input type="search" className="blank-task-search" aria-label="搜索任务" placeholder="搜索任务" value={blankQuery} onChange={(event) => setBlankQuery(event.target.value)} />
            <div className="blank-task-filters" role="group" aria-label="按项目筛选">
              <button type="button" className="filter-chip" aria-pressed={blankProject === "all"} onClick={() => setBlankProject("all")}>全部</button>
              {projectIds.has("__independent__") && <button type="button" className="filter-chip" aria-pressed={blankProject === "__independent__"} onClick={() => setBlankProject("__independent__")}>独立任务</button>}
              {workspace.projects.filter((project) => projectIds.has(project.id)).map((project) => <button key={project.id} type="button" className="filter-chip" aria-pressed={blankProject === project.id} onClick={() => setBlankProject(project.id)}>{project.title}</button>)}
            </div>
            <div className="blank-task-list">
              {matches.map((task) => <button type="button" disabled={blankBusy} key={task.id} onClick={() => { if (blankBusy) return; setBlankBusy(true); setBlankError(""); void onSchedule(task, date, minutesTime(blankRange.start)).then(() => { setBlankAction(null); setBlankRange(null); }).catch((reason) => setBlankError(readError(reason))).finally(() => setBlankBusy(false)); }}><span className="blank-task-icon" aria-hidden="true"><Inbox size={14} /></span><span className="blank-task-text"><strong>{task.title}</strong><small>{task.projectId ? projectTitle.get(task.projectId) ?? "独立任务" : "独立任务"} · {task.sessionMinutes ?? task.estimatedMinutes ?? 60} 分钟</small></span></button>)}
              {!matches.length && <span className="empty-inline">没有匹配的任务</span>}
            </div>
          </div>;
        })()}
        {blankError && <p role="alert">{blankError}</p>}
      </section></FloatingPanel>}
      {activePreview && (() => {
        // 虚线框按吸附后的落点绘制；拖动中的真卡由 `useDragSession` 两轴跟手。
        const start = minutesTime(activePreview.startMinute % 1440); const end = minutesTime((activePreview.startMinute + activePreview.duration) % 1440);
        const previewStyle = timeline ? timeline.positionForRange(start, end) : positionStyle(start, end);
        // §185 时间块的文案与任务重叠区分开；§177 重叠预演里若这一张会被收进「另外 N 项」，
        // 虚线框就不画了 —— 该展示的是汇总卡上的新计数，不是一格看不见的框。
        const label = activePreview.blockId ? "与时间块同时安排"
          : activePreview.mode === "insert-before" || activePreview.mode === "insert-after" ? "插入并后移"
            : activePreview.mode === "overlap" ? (activePreview.targetSessionId ? "同时安排" : "与时间块同时安排")
              : activePreview.targetSessionId ? "悬停 0.5 秒以同时安排" : "松开放置";
        const ghostLayout = previewLayouts?.get("__drag-preview__") ?? null;
        const ghostStyle = previewStyle && ghostLayout
          ? { ...previewStyle, left: `calc(${ghostLayout.left}% + ${CARD_LANE_GUTTER_PX}px)`, right: "auto", width: `calc(${ghostLayout.width}% - ${CARD_LANE_GUTTER_PX * 2}px)` }
          : previewStyle;
        return <>
          {ghostStyle && !ghostLayout?.hidden && <article ref={ghostRef} className={`calendar-drag-preview ${activePreview.mode}${activePreview.blockId ? " block-overlap" : ""}`} role="status" aria-label="拖拽排程预览" style={ghostStyle}><span>{label}</span></article>}
          {activePreview.mode === "insert-before" || activePreview.mode === "insert-after" ? <div className="calendar-insert-line" aria-label="插入位置" style={{ top: timeline ? `${timeline.offsetAtMinute(activePreview.startMinute)}px` : `${activePreview.startMinute / 1440 * 100}%` }}><span>插入并后移</span></div> : null}
          {/* 从任务池拖进来的那一份没有源卡片，读数就挂在落点框上（§166/168 的「持续显示精确起止」）。 */}
          {drag.kind === "create" && <DragTimePreview active anchorRef={ghostRef} label="拖动时间预览" followKey={`${start}-${end}`}>{start}–{end} · {activePreview.duration} 分钟</DragTimePreview>}
        </>;
      })()}
      {blocks.map((block) => {
        const baseStyle = timeline ? timeline.positionForRange(block.startLocal, block.endLocal) : positionStyle(block.startLocal, block.endLocal);
        if (!baseStyle) return null;
        const position = (startLocal: string, endLocal: string) => timeline ? timeline.positionForRange(startLocal, endLocal) : positionStyle(startLocal, endLocal);
        return <CalendarTimeBlock key={block.id} block={block} baseStyle={baseStyle} position={position} hourHeight={preferences.calendarScale[preferences.calendarView]} snapMinutes={preferences.snapMinutes} onResizeStart={() => { setBlankHoverMinute(null); setBlankRange(null); setBlankAction(null); }} onUpdate={(next) => onUpdateBlock(block, next)} onDelete={() => void onDeleteBlock(block.id)} />;
      })}
      {renderedSessions.map((session) => {
        const task = workspace.tasks.find((item) => item.id === session.taskId);
        // 落点覆盖：目标列先用落点时间画这一份（布局分栏等写入回来再算）。
        const landing = pendingPlacement?.sessionId === session.id ? pendingPlacement : null;
        const shown = landing ? { ...session, ...landing } : session;
        // §171 真卡片让位：插入预览期间把被推后的卡片移到新位置，靠 `.calendar-session`
        // 既有的 top 过渡平滑滑过去；松手前不提交，拖出有效区域时预览清空、自动复原。
        // 改时长（§197）读的是同一份 `shifted`，所以这里不区分手势。
        const yielding = landing ? undefined : columnPreview?.shifted.find((change) => change.session.id === session.id);
        const displayed = yielding
          ? { ...shown, startLocal: minutesTime(yielding.startMinute % 1440), endLocal: minutesTime((yielding.startMinute + sessionDuration(session)) % 1440) }
          : shown;
        // 重叠预演期间读试算出来的那套分栏：松手前就能看到「会变多宽 / 谁会被收进汇总」。
        const baseStyle = timeline ? timeline.positionForRange(displayed.startLocal, displayed.endLocal) : positionStyle(displayed.startLocal, displayed.endLocal);
        const layout = landing ? undefined : previewLayouts?.get(session.id) ?? concurrency.get(session.id);
        if (!task || !baseStyle || layout?.hidden) return null;
        const style = layout ? { ...baseStyle, left: `calc(${layout.left}% + ${CARD_LANE_GUTTER_PX}px)`, right: "auto", width: `calc(${layout.width}% - ${CARD_LANE_GUTTER_PX * 2}px)` } : baseStyle;
        // 拖拽命中读的横向栏必须是**落库**布局：§177 的预演会随指针临时改宽度，
        // 按预演判定会让目标卡在指针下消失（D16／C4，见 `sessionAtPoint`）。
        const hitLane = concurrency.get(session.id) ?? null;
        const groupSiblings = (concurrency.get(session.id)?.groupId ?? "") !== ""
          ? sessions.filter((item) => concurrency.get(item.id)?.groupId === concurrency.get(session.id)?.groupId).sort((a, b) => timeMinutes(a.startLocal) - timeMinutes(b.startLocal) || a.id.localeCompare(b.id))
          : [];
        return <CalendarSession key={session.id} style={style} lane={hitLane} categoryColor={calendarProjectColor(workspace.projects, task.projectId)} landing={landing !== null} yielding={Boolean(yielding)} targeted={session.id === focusSessionId} overlapTargeted={activePreview?.mode === "overlap" && activePreview.targetSessionId === session.id} selected={selectedSessionId === session.id} onSelect={() => setSelectedSessionId(session.id)} groupSize={groupSiblings.length} onCycleGroup={(direction) => { const index = groupSiblings.findIndex((item) => item.id === session.id); if (index < 0) return; const next = groupSiblings[(index + direction + groupSiblings.length) % groupSiblings.length]; setSelectedSessionId(next.id); document.querySelector<HTMLElement>(`.calendar-session[data-session-id="${next.id}"]`)?.focus(); }} session={shown} task={task} projectTitle={workspace.projects.find((project) => project.id === task.projectId)?.title ?? null} hourHeight={preferences.calendarScale[preferences.calendarView]} now={now} sessionRecords={index.recordsBySessionId.get(shown.id) ?? []} showActualRecords={preferences.showActualRecords} onResizeStart={() => { setBlankHoverMinute(null); setBlankRange(null); setBlankAction(null); }} onEdit={(anchor) => onEditSession(session, anchor)} onProgress={onProgress} onSkipReview={() => onSkipReview(session)} onContinue={() => onContinue(session)} overlay={layout?.hiddenCount ? <button className="concurrent-summary" aria-expanded={expandedConcurrency === layout.groupId} onClick={(event) => { event.stopPropagation(); setExpandedConcurrency((current) => current === layout.groupId ? null : layout.groupId); }}>另外 {layout.hiddenCount} 项</button> : layout?.showCount ? <span className="simultaneous-count">同时 {layout.totalCount} 项</span> : null} />;
      })}
      {expandedConcurrency && (() => {
        const groupSessions = sessions.filter((session) => concurrency.get(session.id)?.groupId === expandedConcurrency);
        if (groupSessions.length < 4) return null;
        const first = groupSessions.reduce((earliest, session) => timeMinutes(session.startLocal) < timeMinutes(earliest.startLocal) ? session : earliest);
        const top = timeline ? timeline.offsetAtMinute(timeMinutes(first.startLocal)) : timeMinutes(first.startLocal) / 1440 * 100;
        return <section className="concurrent-expanded-list" aria-label="同时安排的全部任务" style={timeline ? { top: `${top}px` } : { top: `${top}%` }}>{groupSessions.map((session) => <button key={session.id} onClick={() => onEditSession(session, null)}><strong>{taskTitle(workspace, session.taskId)}</strong><time>{session.startLocal}–{session.endLocal}</time></button>)}</section>;
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
  const articleRef = useRef<HTMLElement>(null);
  const [resize, setResize] = useState<null | { edge: "move" | "top" | "bottom"; startMinute: number; endMinute: number; snapStartMinute: number; snapEndMinute: number; clientX: number; clientY: number; originX: number; trackWidth: number }>(null);
  /**
   * 松手后已经落定的位置。
   *
   * 从松开到父级 workspace 更新之间，`block` 仍是旧时间。若这段时间直接回落到
   * `baseStyle`，卡片会带着刚恢复的 `top/height` 过渡「弹回」旧位置，等数据回来后
   * 再跳到新位置 —— 看上去就是动画错误。所以把落点记下来渲染，直到 `block` 真的变成它。
   *
   * 跨列时落点仍然由**本列这一份**渲染（横向按整列吸附的 `offsetDays`），只是瞬时收到
   * 落点、不做过渡：卡片就在虚线落点框的位置上，等 workspace 追上来时目标列渲染的真身
   * 与之完全重合。这样既没有弹回源列的过程，也不必把一个元素搬进另一列的 DOM。
   */
  const [landed, setLanded] = useState<null | { startLocal: string; endLocal: string; localDate: string; endLocalDate: string; offsetDays: number; trackWidth: number }>(null);
  // 一旦 block 追上落点，覆盖显示就交还给 baseStyle。
  useEffect(() => {
    if (!landed) return;
    if (block.startLocal === landed.startLocal && block.endLocal === landed.endLocal && block.localDate === landed.localDate && block.endLocalDate === landed.endLocalDate) setLanded(null);
  }, [block.startLocal, block.endLocal, block.localDate, block.endLocalDate, landed]);
  const initialStart = timeMinutes(block.startLocal);
  const initialEnd = timeMinutes(block.endLocal);
  const initialDuration = (initialEnd - initialStart + 1440) % 1440 || 1440;

  const startEdgeResize = (event: React.PointerEvent<HTMLElement>, edge: "move" | "top" | "bottom") => {
    event.preventDefault(); event.stopPropagation();
    // 上一次落点若因写入失败而一直没被 block 追上，这里清掉，避免下一次拖动从陈旧位置起算。
    setLanded(null);
    onResizeStart?.();
    const originY = event.clientY;
    const originX = event.clientX;
    const pixelsPerMinute = hourHeight / 60;
    const trackWidth = articleRef.current?.closest<HTMLElement>(".day-track")?.getBoundingClientRect().width ?? 0;
    const compute = (next: PointerEvent) => {
      const snap = snapMinutesFor(snapMinutes, next.altKey);
      const delta = (next.clientY - originY) / pixelsPerMinute;
      const roundedDelta = snapDelta(delta, snap);
      if (edge === "move") {
        // 卡片本体自由跟手（不吸附），落点单独算吸附值：虚线框会"跳格"停在
        // 最终真正会落到的那一格，卡片则平滑跟随指针。两者分离才看得出落点。
        const freeStart = Math.round(Math.max(0, Math.min(1440 - initialDuration, initialStart + delta)));
        const snapStart = Math.max(0, Math.min(1440 - initialDuration, Math.round(freeStart / snap) * snap));
        return { startMinute: freeStart, endMinute: freeStart + initialDuration, snapStartMinute: snapStart, snapEndMinute: snapStart + initialDuration };
      }
      if (edge === "top") {
        const newStart = Math.max(0, Math.min(initialEnd, initialStart + roundedDelta));
        return { startMinute: newStart, endMinute: initialEnd, snapStartMinute: newStart, snapEndMinute: initialEnd };
      }
      const newEnd = Math.max(initialStart, Math.min(1440, initialEnd + roundedDelta));
      return { startMinute: initialStart, endMinute: newEnd, snapStartMinute: initialStart, snapEndMinute: newEnd };
    };
    const move = (next: PointerEvent) => { const next1 = compute(next); setResize({ edge, ...next1, clientX: next.clientX, clientY: next.clientY, originX, trackWidth }); };
    const up = (next: PointerEvent) => {
      const final = compute(next);
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      setResize(null);
      // 落库一律用吸附后的落点，不把跟手过程中的中间像素写成事实。
      const startLocal = minutesTime(final.snapStartMinute % 1440);
      const endLocal = minutesTime(final.snapEndMinute % 1440);
      const baseTime = new Date(`${block.localDate}T00:00:00`).getTime();
      let localDate = toLocalDate(new Date(baseTime + Math.floor(final.snapStartMinute / 1440) * 86400000));
      let endLocalDate = toLocalDate(new Date(baseTime + Math.floor(final.snapEndMinute / 1440) * 86400000));
      let offsetDays = 0;
      if (edge === "move") {
        offsetDays = trackWidth > 0 ? Math.round((next.clientX - originX) / trackWidth) : 0;
        if (offsetDays !== 0) {
          localDate = addDays(localDate, offsetDays);
          endLocalDate = addDays(endLocalDate, offsetDays);
        }
      }
      const unchanged = startLocal === block.startLocal && endLocal === block.endLocal && localDate === block.localDate && endLocalDate === block.endLocalDate;
      if (!unchanged) {
        setLanded({ startLocal, endLocal, localDate, endLocalDate, offsetDays, trackWidth });
        // 写入失败时把落点覆盖撤掉，让卡片回到事实位置（错误由顶部横幅统一提示）。
        void onUpdate({ ...block, startLocal, endLocal, localDate, endLocalDate }).catch(() => setLanded(null));
      }
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
  const dropStart = resize?.snapStartMinute ?? initialStart;
  const dropEnd = resize?.snapEndMinute ?? initialEnd;
  const dropStartStr = minutesTime(dropStart % 1440);
  const dropEndStr = minutesTime(dropEnd % 1440);
  const dropDuration = (dropEnd - dropStart + 1440) % 1440 || 1440;
  // 纵向与横向都自由跟手（卡片贴着指针走）；横向按整列吸附只用于**落点虚线框**，
  // 两者分离才看得出最终会落在哪一列哪一格。
  const columnDays = resize && resize.edge === "move" && resize.trackWidth > 0 ? Math.round((resize.clientX - resize.originX) / resize.trackWidth) : 0;
  const columnShift = (style: CSSProperties, days: number, trackWidth: number): CSSProperties =>
    days === 0 || trackWidth <= 0 ? style : { ...style, left: `calc(7px + ${days * trackWidth}px)`, right: "auto", width: "calc(100% - 14px)" };
  const liveStyleFor = (startStr: string, endStr: string, offsetPx = 0) => {
    const fresh = position(startStr, endStr);
    const style = fresh ?? (() => {
      const top = baseStyle.top as string;
      const minutes = timeMinutes(startStr);
      const endMin = timeMinutes(endStr);
      const duration = (endMin - minutes + 1440) % 1440 || 1440;
      return { ...baseStyle, top, height: `${Math.max(duration / 1440 * 100, 1.25)}%` };
    })();
    if (offsetPx === 0) return style;
    return { ...style, left: `calc(7px + ${offsetPx}px)`, right: "auto", width: "calc(100% - 14px)" };
  };
  // 落点：吸附后的时间 + 按整列的横向吸附，且不加过渡（瞬时收到虚线框里）。
  const landedStyle = landed ? columnShift(position(landed.startLocal, landed.endLocal) ?? baseStyle, landed.offsetDays, landed.trackWidth) : null;
  const displayStyle = resize !== null
    ? liveStyleFor(liveStartStr, liveEndStr, resize.edge === "move" ? resize.clientX - resize.originX : 0)
    : (landedStyle ?? baseStyle);
  // 落点框只在"移动"时出现：改时长时卡片边界本身就是最终边界，再叠一层虚线只是噪音。
  const dropStyle = resize === null || resize.edge !== "move" ? null : columnShift(liveStyleFor(dropStartStr, dropEndStr), columnDays, resize.trackWidth);
  const isResizing = resize !== null;
  const classes = ["calendar-time-block", isResizing ? "is-resizing" : ""].filter(Boolean).join(" ");

  return <>
    {dropStyle && <div aria-hidden="true" className="calendar-time-block-drop" style={dropStyle} />}
    {resize !== null && resize.edge === "move" && <div aria-hidden="true" className="calendar-time-block-origin" style={baseStyle} />}
    <article ref={articleRef} className={classes} style={displayStyle} onPointerDown={startMove} data-block-id={block.id} data-resize-edge={resize?.edge} data-landed={landed !== null ? "true" : undefined}>
      <button className="time-block-handle time-block-handle-top" aria-label={`调整 ${block.title} 开始时间`} onPointerDown={(e) => startEdgeResize(e, "top")} />
      <time>{liveStartStr}–{liveEndStr}</time>
      <strong>{block.title}</strong>
      <button className="time-block-delete" aria-label={`删除时间块 ${block.title}`} onClick={onDelete}><X size={13} /></button>
      <button className="time-block-handle time-block-handle-bottom" aria-label={`调整 ${block.title} 结束时间`} onPointerDown={(e) => startEdgeResize(e, "bottom")} />
    </article>
    <DragTimePreview active={resize !== null} anchorRef={articleRef} label="时间块时间预览" followKey={`${liveStartStr}-${liveEndStr}`}>{dropStartStr}–{dropEndStr} · {dropDuration} 分钟</DragTimePreview>
  </>;
}

function CalendarSession({ style, lane, categoryColor, landing = false, yielding = false, targeted = false, overlapTargeted = false, selected = false, onSelect, groupSize = 0, onCycleGroup, session, task, projectTitle, hourHeight, now, sessionRecords, showActualRecords, onResizeStart, onEdit, onProgress, onSkipReview, onContinue, overlay }: {
  style?: CSSProperties;
  /** 落库后的并排栏（百分比）：写进 `data-lane-*` 供拖拽命中判横向（C4／D16）。 */
  lane?: { left: number; width: number } | null;
  categoryColor?: string; landing?: boolean; yielding?: boolean; targeted?: boolean; overlapTargeted?: boolean;
  /** §176：并行组里被选中时视觉浮前（不改日历顺序），左右方向键在同组之间切换。 */
  selected?: boolean; onSelect?: () => void; groupSize?: number; onCycleGroup?: (direction: -1 | 1) => void;
  session: ExecutionSession; task: Task; projectTitle: string | null; hourHeight: number; now: Date; /** 只传该时段自己的执行记录，避免每行扫描全量历史。 */ sessionRecords: ExecutionRecord[]; showActualRecords: boolean;
  onResizeStart?: () => void; onEdit: (anchorElement: HTMLElement | null) => void; onProgress: (task: Task, value: number, anchor: HTMLElement | null) => Promise<void>; onSkipReview: () => Promise<void>; onContinue: () => void;
  overlay?: ReactNode;
}) {
  const articleRef = useRef<HTMLElement>(null);
  const drag = useDragSessionContext();
  const [progressOpen, setProgressOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const current = sessionContains(session, now);
  const pendingReview = isPendingReview(session, task, sessionRecords, now);
  const confirmedNoProgress = session.status === "missed";
  const elapsed = current ? Math.round((now.getTime() - localSessionStart(session)) / Math.max(1, localSessionEnd(session) - localSessionStart(session)) * 100) : 0;
  /** C3／D14：「剩余 X 分钟」只属于进行中的卡；≥60 分钟折成「X 小时 Y 分」。 */
  const remainingMinutes = current ? Math.max(0, Math.ceil((localSessionEnd(session) - now.getTime()) / 60_000)) : 0;
  const remainingLabel = remainingMinutes >= 60
    ? `剩余 ${Math.floor(remainingMinutes / 60)} 小时${remainingMinutes % 60 ? ` ${remainingMinutes % 60} 分` : ""}`
    : `剩余 ${remainingMinutes} 分钟`;
  const availableHeight = sessionDuration(session) / 60 * hourHeight;
  /**
   * 盒子高度档位只留给两个消费方：`data-card-density`（悬停动作条阈值与测试钩子）和
   * `showDetails`。**不再决定渲染哪些行** —— 行的显隐全部交给卡片自身的高度容器查询
   * （`styles.css` 的 `@container (min-height: …)`，断点与内容同用 rem），
   * 这样 200% 下同一个 px 盒子会自动少显示行，而不是把内容压出卡外。
   */
  const density = availableHeight < hourHeight / 2 ? "compact" : availableHeight < hourHeight ? "standard" : "detailed";
  const showDetails = density === "detailed";
  /**
   * 待回顾动作的开合。
   *
   * 以前是 hover 即弹：鼠标扫过日历就会冒出一串气泡盖住下面的卡片，指针挪到
   * 「更新进度」的滑块上就自动关掉，键盘 Tab 进去也留不住。现在只在用户明确
   * 表达时才打开 —— 点卡片本体，或聚焦「待回顾」入口按钮后回车；关闭交给浮层
   * 宿主（Esc、点外部、动作完成），定位用锚元素实时跟随。
   */
  const reviewActions = pendingReview && reviewOpen ? (
    <FloatingPanel label={`${task.title} 待回顾操作`} kind="action" busy={false} anchorElement={articleRef.current} closeOnOutsideClick onClose={() => { setReviewOpen(false); setProgressOpen(false); }}>
      <div className="session-review-actions">
        <button onClick={() => setProgressOpen((value) => !value)}>更新进度</button>
        <button onClick={() => { setReviewOpen(false); onContinue(); }}>继续安排</button>
        <button onClick={() => { setReviewOpen(false); void onSkipReview(); }}>本次未推进</button>
        {progressOpen && <ProgressControl task={task} onCommit={onProgress} />}
      </div>
    </FloatingPanel>
  ) : null;
  /**
   * 卡片状态（当前安排／待回顾／本次未推进／已完成）。
   *
   * 两种呈现：可交互的「待回顾」入口是 `<button>`，`aria-label` 合法；其余状态是**纯展示**
   * 的 `<span>`，**不能**再挂 `aria-label` —— `span` 的隐式角色是 `generic`，ARIA 1.2 禁止它
   * 被命名（axe `aria-prohibited-attr`，wcag2a／4.1.2）。周视图在 960×200% 下每列不足 100px，
   * 容器查询会把里面的文字隐藏，于是这个 span 既没有可见文字、名字又被丢弃 —— 状态就彻底读不到了。
   * 状态本来就写在这张卡片自己的 `aria-label` 里（`${task.title}，${start} 至 ${end}，${status.label}`），
   * 所以删掉多余的 `aria-label` 不会丢信息（P4-11 修，见 docs/reports/phase-4-p4-11-implementation.md）。
   */
  const status = current ? { icon: <Clock3 size={12} />, label: "当前安排" }
    : pendingReview ? { icon: <CircleAlert size={12} />, label: "待回顾" }
      : confirmedNoProgress ? { icon: <Ban size={12} />, label: "本次未推进" }
        : isTaskCompleted(task) || task.progress === 100 ? { icon: <Check size={12} />, label: "已完成" }
          : null;
  const nextDeadline = task.deadlineLocal && daysBetween(toLocalDate(now), task.deadlineLocal) <= 7 ? task.deadlineLocal : null;
  const isDragSource = drag.sourceId === session.id && drag.phase !== "idle";
  const isMoving = isDragSource && drag.kind === "move" && drag.phase === "dragging";
  const resizeDuration = isDragSource && drag.kind === "resize" && drag.preview ? drag.preview.duration : null;
  const isResizing = resizeDuration !== null;
  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault(); event.stopPropagation();
    onResizeStart?.();
    setReviewOpen(false);
    drag.beginResize(event, session);
  };
  const classes = ["calendar-session", session.status === "missed" ? "missed" : "", current ? "current-schedule" : "", pendingReview ? "pending-review" : "", targeted ? "targeted-session" : "", overlapTargeted ? "overlap-target" : "", selected ? "is-selected" : "", isTaskCompleted(task) || task.progress === 100 ? "completed" : "", showActualRecords ? "planned-outline" : "", isMoving ? "is-dragging-source" : "", landing ? "is-landed" : "", yielding ? "is-yielding" : "", isResizing ? "is-resizing" : ""].filter(Boolean).join(" ");
  const baseStyle = style ?? positionStyle(session.startLocal, session.endLocal);
  const displayStyle = resizeDuration === null ? baseStyle : { ...baseStyle, height: `${resizeDuration / 60 * hourHeight}px` };
  const cardStyle = {
    ...displayStyle,
    ...(categoryColor ? { "--session-category": categoryColor } : {}),
    ...(isMoving ? { transform: `translate(${drag.delta.x}px, ${drag.delta.y}px)` } : {}),
  } as CSSProperties;
  const readoutStart = isResizing ? session.startLocal : drag.preview?.kind === "move" ? minutesTime(drag.preview.startMinute % 1440) : null;
  const readoutEnd = isResizing && resizeDuration !== null ? minutesTime((timeMinutes(session.startLocal) + resizeDuration) % 1440)
    : drag.preview?.kind === "move" ? minutesTime((drag.preview.startMinute + drag.preview.duration) % 1440) : null;
  const readoutDuration = isResizing ? resizeDuration : drag.preview?.kind === "move" ? drag.preview.duration : null;
  const readoutActive = isResizing || (isMoving && Boolean(drag.preview));
  return <><article ref={articleRef} tabIndex={0} className={classes} data-session-id={session.id} data-lane-left={lane?.left} data-lane-width={lane?.width} data-card-density={density} data-dragging={isMoving ? "true" : undefined} data-resizing={isResizing ? "true" : undefined} data-yielding={yielding ? "true" : undefined} title={task.title} aria-label={`${task.title}，${session.startLocal} 至 ${session.endLocal}${status ? `，${status.label}` : ""}`} style={cardStyle} onClick={(event) => { if (drag.suppressClick(session.id)) return; if ((event.target as HTMLElement).closest("button")) return; onSelect?.(); if (pendingReview) setReviewOpen(true); }} onFocus={() => onSelect?.()} onKeyDown={(event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter") { event.preventDefault(); onEdit(articleRef.current); return; }
      // §176：并行组内的左右方向键只在组内切换选中，不改日历顺序、也不移动卡片。
      if (groupSize > 1 && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        onCycleGroup?.(event.key === "ArrowLeft" ? -1 : 1);
      }
    }} onPointerDown={(event) => { if (event.button !== 0) return; if ((event.target as HTMLElement).closest("button, input, .session-task-progress, .session-elapsed, .concurrent-summary, .simultaneous-count")) return; drag.beginMove(event, session); }}>
    <time className="session-time">{session.startLocal}–{session.endLocal}</time><strong>{task.title}</strong>
    {(status || nextDeadline) && <span className="session-state">{status && (pendingReview
      ? <button type="button" className="session-status-icon session-review-trigger" aria-label={status.label} title="处理这次待回顾" onClick={() => setReviewOpen(true)}>{status.icon}<span>{status.label}</span></button>
      : <span className="session-status-icon">{status.icon}<span>{status.label}</span></span>)}{nextDeadline && <span className="session-deadline-flag" title={`截止日期：${formatLongDate(nextDeadline)}`}><Flag size={12} aria-label={`截止日期 ${nextDeadline}`} /></span>}</span>}
    <span className="session-meta">{projectTitle && <span className="session-project">{projectTitle}</span>}<span className="session-progress-value">{task.progress}%</span></span>
    {current && <span className="session-remaining" title={`本时段共 ${Math.max(1, Math.round((localSessionEnd(session) - localSessionStart(session)) / 60_000))} 分钟，还剩 ${remainingMinutes} 分钟`}>{remainingLabel}</span>}
    {current && <div className="session-elapsed" role="progressbar" aria-label={`${task.title} 时间已进行`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={elapsed} aria-valuetext={`时间已进行 ${elapsed}%`} title={`时间已进行 ${elapsed}%`}><span style={{ width: `${elapsed}%` }} /></div>}
    {pendingReview && <span className="review-summary">时段已结束 · 当前进度 {task.progress}%</span>}
    {/* C3／D14：任务进度条移出文档流、改画卡顶全宽平头帽；与卡底的「时间已进行」圆角胶囊在位置、宽度、形态三层都分开。 */}
    <div className="session-task-progress" role="progressbar" aria-label={`${task.title} 任务进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={task.progress} aria-valuetext={`任务进度 ${task.progress}%`} title={`任务进度 ${task.progress}%`}><span style={{ width: `${task.progress}%` }} /></div>
    {overlay}
    <button className="session-edit-button" data-session-edit-button data-action-visibility={showDetails ? "visible" : "on-demand"} aria-label={`编辑 ${task.title} 时间`} onClick={(event) => onEdit(event.currentTarget)}><Pencil size={12} /></button>
    <button className="resize-handle" aria-label={`调整 ${task.title} 时长`} onPointerDown={startResize} />
  </article>
  {/* 读数必须挂在**卡片外面**：`.calendar-session` 有 `container-type: size`（contain: layout），
      而拖动中的跟手卡又带 `transform` —— 两者任一个都会让 `position: fixed` 的后代改以这张卡
      为包含块，读数于是按「卡片内的坐标」摆放，实测偏到列外（851/676 vs 卡片 425/310）。
      与 `CalendarTimeBlock` 的写法一致：锚点是这张卡，DOM 上是兄弟。 */}
  <DragTimePreview active={readoutActive} anchorRef={articleRef} label={isResizing ? "调整时长预览" : "拖动时间预览"} followKey={`${readoutStart}-${readoutEnd}`}>{readoutStart}–{readoutEnd} · {readoutDuration} 分钟</DragTimePreview>
  {reviewActions}
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
  const save = async () => { setBusy(true); setError(""); try { await onSave(localDate, startLocal); } catch (reason) { setError(readError(reason)); } finally { setBusy(false); } };
  return <ConfirmDialog id="continue-schedule-dialog" labelledBy="continue-schedule-title" busy={busy} onClose={onClose}><div className="modal-icon"><CalendarDays /></div><h2 id="continue-schedule-title">继续安排：{task.title}</h2><p>先确认下一次日期和开始时间，创建后原时段与历史事实保持不变。</p><div className="continue-schedule-fields"><label>日期<input autoFocus type="date" value={localDate} onChange={(event) => setLocalDate(event.target.value)} /></label><label>开始<TimeField label="开始时间" value={startLocal} onChange={setStartLocal} /></label></div><small>默认沿用任务的单次投入时长；你仍可在创建后精确编辑。</small>{error && <p className="error-message" role="alert"><CircleAlert />{error}</p>}<div className="form-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={busy || !localDate || !startLocal} onClick={() => void save()}>{busy ? "正在创建…" : "创建后续安排"}</Button></div></ConfirmDialog>;
}

function SessionEditPopover({ session: planned, task, anchorElement, onClose, onSave, onPhase }: {
  session: ExecutionSession; task: Task; anchorElement: HTMLElement | null;
  onClose: () => void; onSave: (localDate: string, startLocal: string, duration: number) => Promise<void>;
  onPhase?: (busy: boolean) => void;
}) {
  const editor = useEditorSession<{ localDate: string; startLocal: string; endLocal: string }>({
    key: planned.id,
    initial: { localDate: planned.localDate, startLocal: planned.startLocal, endLocal: planned.endLocal },
    canSave: (draft) => { const value = clockDuration(draft.startLocal, draft.endLocal); return value >= 5 && value <= 1440; },
    onSave: (draft) => onSave(draft.localDate, draft.startLocal, clockDuration(draft.startLocal, draft.endLocal)),
    onClose: (reason) => { if (reason !== "saved") onClose(); },
    onPhaseChange: (phase) => onPhase?.(phase === "submitting"),
  });
  const { draft, patchDraft, busy, error } = editor;
  const duration = clockDuration(draft.startLocal, draft.endLocal);
  return <FloatingPanel label={`编辑时间：${task.title}`} anchorElement={anchorElement} busy={busy} onClose={onClose} closeOnOutsideClick><form aria-busy={busy} className="session-edit-fields" onSubmit={(event) => { event.preventDefault(); void editor.save(); }}>
    <header><strong>{task.title}</strong><span className="session-edit-popover-label">编辑时间</span></header>
    <label>日期<input type="date" value={draft.localDate} onChange={(event) => patchDraft({ localDate: event.target.value })} /></label>
    <div className="time-row"><label>开始<TimeField label="开始时间" value={draft.startLocal} onChange={(startLocal) => patchDraft({ startLocal })} /></label><span aria-hidden="true">至</span><label>结束<TimeField label="结束时间" value={draft.endLocal} onChange={(endLocal) => patchDraft({ endLocal })} /></label></div>
    <small>{formatShortDate(draft.localDate)} {draft.startLocal}–{draft.endLocal} · 持续 {duration} 分钟</small>
    {error && <p className="error-message" role="alert"><CircleAlert />{error}</p>}
    <div className="form-actions"><Button disabled={busy} onClick={editor.cancel}>取消</Button><Button type="submit" variant="primary" disabled={busy || !editor.canSave}>{busy ? "正在保存…" : "保存时间"}</Button></div>
  </form></FloatingPanel>;
}

/**
 * 轻量时间块的新建表单（P4-03）。
 *
 * 接入编辑会话后，「提交只发一次、失败保留草稿、提交中 Esc／取消无效」不再由
 * 本地 `busy` 逐个手写，而与任务／里程碑走同一条状态机。
 */
function TimeBlockEditor({ initial, onCancel, onCreate, onPhase }: {
  initial: { localDate: string; startLocal: string; endLocal: string }; onCancel: () => void; onCreate: (block: TimeBlock) => Promise<void>; onPhase?: (busy: boolean) => void;
}) {
  const session = useEditorSession<{ title: string; localDate: string; startLocal: string; endLocal: string }>({
    key: "new-time-block",
    initial: { title: "", localDate: initial.localDate, startLocal: initial.startLocal, endLocal: initial.endLocal },
    canSave: (draft) => Boolean(draft.title.trim() && draft.localDate && timeMinutes(draft.endLocal) > timeMinutes(draft.startLocal)),
    onSave: (draft) => onCreate({
      id: crypto.randomUUID(), title: draft.title.trim(), localDate: draft.localDate, endLocalDate: draft.localDate,
      startLocal: draft.startLocal, endLocal: draft.endLocal,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local", utcOffsetMinutes: -new Date().getTimezoneOffset(),
    }),
    onClose: (reason) => { if (reason !== "saved") onCancel(); },
    onPhaseChange: (phase) => onPhase?.(phase === "submitting"),
  });
  const { draft, patchDraft, busy, error } = session;
  const duration = clockDuration(draft.startLocal, draft.endLocal);
  // 与可用时间同一套「从开始往后推」的时长按钮：比先改开始再改结束少一半操作。
  const setDuration = (minutes: number) => patchDraft({ endLocal: minutesTime(timeMinutes(draft.startLocal) + minutes) });
  return <form aria-busy={busy} className="time-block-form" onSubmit={(event) => { event.preventDefault(); void session.save(); }}>
    <label>标题<input autoFocus value={draft.title} onChange={(event) => patchDraft({ title: event.target.value })} placeholder="会议、通勤或休息" /></label>
    <label>日期<input type="date" value={draft.localDate} onChange={(event) => patchDraft({ localDate: event.target.value })} /></label>
    <div className="time-row">
      <label>开始<TimeField label="开始时间" value={draft.startLocal} onChange={(startLocal) => patchDraft({ startLocal })} /></label>
      <span aria-hidden="true">至</span>
      <label>结束<TimeField label="结束时间" value={draft.endLocal} onChange={(endLocal) => patchDraft({ endLocal })} /></label>
    </div>
    <div className="duration-row">
      {SLOT_DURATION_CHOICES.map(([minutes, text]) => <button key={minutes} type="button" className={duration === minutes ? "duration-chip is-active" : "duration-chip"} aria-pressed={duration === minutes} onClick={() => setDuration(minutes)}>{text}</button>)}
    </div>
    <small className="time-block-summary">{draft.endLocal > draft.startLocal ? durationLabel(duration) : "结束时间需晚于开始时间"}</small>
    <div className="form-actions"><Button disabled={busy} onClick={session.cancel}>取消</Button><Button type="submit" variant="primary" disabled={busy || !session.canSave}>{busy ? "正在创建…" : "创建时间块"}</Button></div>
    {error && <p className="error-message" role="alert"><CircleAlert />{error}</p>}
  </form>;
}

/** 新建重复习惯表单（P4-03）。这里只定义规则；发生项与欠账由后续执行闭环处理。 */
function HabitEditor({ onCancel, onCreate, onPhase }: {
  onCancel: () => void;
  onCreate: (habit: Omit<RecurringHabit, "id" | "taskId" | "status">) => Promise<void>;
  onPhase?: (busy: boolean) => void;
}) {
  const session = useEditorSession<{ title: string; pattern: RecurringHabit["pattern"]; weekdays: number[]; sessionMinutes: number; preferredStartLocal: string }>({
    key: "new-habit",
    initial: { title: "", pattern: "daily", weekdays: [1], sessionMinutes: 30, preferredStartLocal: "" },
    canSave: (draft) => Boolean(draft.title.trim() && draft.sessionMinutes >= 5 && draft.sessionMinutes <= 240 && (draft.pattern !== "weekly" || draft.weekdays.length > 0)),
    onSave: (draft) => onCreate({
      title: draft.title.trim(),
      pattern: draft.pattern,
      weekdays: draft.pattern === "weekly" ? draft.weekdays : [],
      startDate: toLocalDate(new Date()),
      sessionMinutes: draft.sessionMinutes,
      preferredStartLocal: draft.preferredStartLocal || null,
    }),
    onClose: (reason) => { if (reason !== "saved") onCancel(); },
    onPhaseChange: (phase) => onPhase?.(phase === "submitting"),
  });
  const { draft, patchDraft, busy, error } = session;
  return <form aria-busy={busy} className="habit-form" onSubmit={(event) => { event.preventDefault(); void session.save(); }}>
    <label>习惯名称<input autoFocus value={draft.title} onChange={(event) => patchDraft({ title: event.target.value })} /></label>
    <label>重复规则<SelectField value={draft.pattern} onChange={(value) => patchDraft({ pattern: value as RecurringHabit["pattern"] })} options={[{ value: "daily", label: "每天" }, { value: "weekdays", label: "工作日" }, { value: "weekly", label: "每周选择" }]} /></label>
    {draft.pattern === "weekly" && <div className="habit-field" role="group" aria-label="选择星期"><span className="editor-field-label" aria-hidden="true">选择星期</span><WeekdayPicker value={draft.weekdays} onChange={(weekdays) => patchDraft({ weekdays })} /></div>}
    {/* 这两行必须是 div 而不是 <label>：`label` 的点击激活只认第一个可关联元素，
        而这里第一个可关联元素是减号按钮 —— 点标签文字或数值框右侧留白都会莫名其妙地减一档。
        与上面的「选择星期」同一套网格，标签改用 `editor-field-label` 承载。 */}
    <div className="habit-field"><span className="editor-field-label">单次投入</span><NumberField label="单次投入" suffix="分钟" min={5} max={240} step={5} presets={[15, 30, 45, 60, 90]} value={draft.sessionMinutes} onChange={(value) => { if (value !== null) patchDraft({ sessionMinutes: value }); }} /></div>
    <div className="habit-field"><span className="editor-field-label">固定开始</span><TimeField label="固定开始时间" value={draft.preferredStartLocal} placeholder="未设置" allowClear onChange={(value) => patchDraft({ preferredStartLocal: value })} /></div>
    <div className="form-actions"><Button disabled={busy} onClick={session.cancel}>取消</Button><Button type="submit" variant="primary" disabled={busy || !session.canSave}>{busy ? "正在创建…" : "创建习惯"}</Button></div>
    {error && <p className="error-message" role="alert"><CircleAlert />{error}</p>}
  </form>;
}

type ProjectImportMode = "none" | "project" | "course" | "bilibili";

/**
 * 新建项目／导入三种模式共用的草稿。
 *
 * 三种模式共用一份草稿对象而不是三个会话：模式切换只是改 `mode`，
 * 各模式自己的标题与来源数据因此天然互不串味（E2E 锁定的行为）。
 */
interface ProjectImportDraft {
  mode: ProjectImportMode;
  titles: { project: string; course: string; bilibili: string };
  deadline: string;
  source: string;
  drafts: CourseTaskDraft[];
  biliSource: string;
  bilibili: BilibiliVideo | null;
  biliSelected: number[];
}

const EMPTY_PROJECT_IMPORT: ProjectImportDraft = {
  mode: "none", titles: { project: "", course: "", bilibili: "" }, deadline: "",
  source: "", drafts: [], biliSource: "", bilibili: null, biliSelected: [],
};

type ProjectSort = "recent" | "deadline" | "name";

/**
 * 项目页（2026-10-22 重排）。
 *
 * 结构：页头 → 筛选条 → 宽屏「项目列表 + 右侧详情」／窄屏「列表 + 抽屉详情」。
 * - 详情是页面内的主从分栏，不是二级页面；宽屏停靠、窄屏/200% 退成抽屉。
 * - 列表卡在详情打开时收成紧凑卡（CSS 容器查询），关闭后恢复两列完整卡。
 * - 进度轨由 projectRail.ts 派生：项目加权进度 + 里程碑菱形；近似位置在图例标“≈”。
 * - 任务池不再出现在项目页（项目页已经按项目列任务），今日/日历保留。
 *
 * 数据来源仍是 App 建好的共享稳定索引；不要在渲染每一行时重新扫全量数组。
 */
function ProjectsPage({ workspace, index, focus, onFocusHandled, selectedProjectId, onSelectProject, onCreate, onUpdateProject, onCreateMilestone, onUpdateMilestone, onDeleteMilestone, onProgress, onEditTask, onFetchBilibili, onCreateTask, onArrange, onArrangeProject }: {
  /** 来自截止事项页的定位／续排请求；处理完立即回调清空，只生效一次。 */
  focus: ProjectFocusRequest | null; onFocusHandled: () => void;
  /** 当前打开的项目（App 层内存，同会话跨页返回有效）。 */
  selectedProjectId: string | null; onSelectProject: (projectId: string | null) => void;
  onCreateTask: (task: Task) => Promise<void>; onArrange: (task: Task) => void; onArrangeProject: (projectId: string) => void;
  onEditTask: (task: Task, anchorElement: HTMLElement) => void;
  workspace: WorkspaceSnapshot; index: WorkspaceIndex; onCreate: (project: Project, tasks: Task[]) => Promise<void>;
  onUpdateProject: (project: Project) => Promise<void>;
  onCreateMilestone: (milestone: ProjectMilestone) => Promise<void>; onUpdateMilestone: (milestone: ProjectMilestone) => Promise<void>; onDeleteMilestone: (milestone: ProjectMilestone) => Promise<void>;
  onProgress: (task: Task, value: number, anchor: HTMLElement | null) => Promise<void>; onFetchBilibili: (bvid: string) => Promise<BilibiliVideo>;
}) {
  const today = toLocalDate(new Date());
  const detailHeadingRef = useRef<HTMLHeadingElement | null>(null);

  /**
   * 每个项目「最近一次进度上调」的事件（用于「继续」和「最近推进」）。
   * 一次遍历建表，而不是每个项目各扫一遍全部事件再排序。
   */
  const recentAdvanceByProject = useMemo(() => {
    const best = new Map<string, ProgressEvent>();
    for (const event of workspace.progressEvents) {
      if (event.toProgress <= event.fromProgress) continue;
      const projectId = index.tasksById.get(event.taskId)?.projectId;
      if (!projectId) continue;
      const current = best.get(projectId);
      if (!current || event.occurredAtUtc > current.occurredAtUtc) best.set(projectId, event);
    }
    return best;
  }, [index, workspace.progressEvents]);

  // 导入／新建项目的草稿由编辑会话持有；取消按模式保留草稿，草稿不随面板卸载而消失。
  const [importBusy, setImportBusy] = useState(false);
  const [importFetching, setImportFetching] = useState(false);
  const [importFetchError, setImportFetchError] = useState("");
  const projectImportRef = useRef<EditorSessionApi<ProjectImportDraft> | null>(null);
  const projectImport = useEditorSession<ProjectImportDraft>({
    key: "project-import",
    initial: EMPTY_PROJECT_IMPORT,
    registerInRegistry: false,
    canSave: (draft) => {
      if (draft.mode === "none" || !draft.titles[draft.mode].trim()) return false;
      if (draft.mode === "course" && !draft.drafts.some((item) => item.selected)) return false;
      if (draft.mode === "bilibili" && (!draft.bilibili || draft.biliSelected.length === 0)) return false;
      return true;
    },
    onSave: async (draft) => {
      const name = draft.mode === "none" ? "project" : draft.mode;
      const project: Project = { id: crypto.randomUUID(), title: draft.titles[name].trim(), deadlineLocal: draft.mode === "project" ? (draft.deadline || null) : null };
      const selected = draft.mode === "course"
        ? draft.drafts.filter((item) => item.selected).map((item) => ({ title: item.title, estimatedMinutes: item.estimatedMinutes, mediaMinutes: null as number | null, sourceUrl: null as string | null, sourceKey: null as string | null }))
        : draft.mode === "bilibili" && draft.bilibili
          ? draft.bilibili.parts.filter((part) => draft.biliSelected.includes(part.page)).map((part) => ({ title: part.title, estimatedMinutes: null, mediaMinutes: Math.max(1, Math.ceil(part.durationSeconds / 60)), sourceUrl: part.sourceUrl, sourceKey: part.sourceKey }))
          : [];
      const tasks: Task[] = selected.map((item, index) => ({ id: crypto.randomUUID(), projectId: project.id, title: item.title, progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: item.estimatedMinutes, sessionMinutes: null, priority: "normal", sortOrder: index, sourceUrl: item.sourceUrl, sourceKey: item.sourceKey, mediaMinutes: item.mediaMinutes, kind: "task" }));
      await onCreate(project, tasks);
      setProjectQuery("");
      setSoonOnly(false);
      onSelectProject(project.id);
      setPendingScrollId("project-" + project.id);
    },
    // 成功＝这次事务结束，整份清空；取消只关面板，各模式草稿原样保留。
    onClose: (reason) => { if (reason === "saved") { projectImportRef.current?.resetDraft(); setImportFetchError(""); } },
    onPhaseChange: (phase) => setImportBusy(phase === "submitting"),
  });
  projectImportRef.current = projectImport;
  const importDraft = projectImport.draft;
  const patchImport = projectImport.patchDraft;
  const importTitle = importDraft.titles[importDraft.mode === "none" ? "project" : importDraft.mode];

  const [projectQuery, setProjectQuery] = useState("");
  const [projectSort, setProjectSort] = useState<ProjectSort>("recent");
  const [soonOnly, setSoonOnly] = useState(false);
  const [taskFilter, setTaskFilter] = useState(false);
  const [importMenuAnchor, setImportMenuAnchor] = useState<HTMLElement | null>(null);
  const [pendingImportMode, setPendingImportMode] = useState<Exclude<ProjectImportMode, "none"> | null>(null);
  const [newProjectTask, setNewProjectTask] = useState<Task | null>(null);
  const [newProjectTaskBusy, setNewProjectTaskBusy] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [projectEditAnchor, setProjectEditAnchor] = useState<HTMLElement | null>(null);
  const [milestoneDraft, setMilestoneDraft] = useState<{ projectId: string; editing: ProjectMilestone | null; continuing: boolean } | null>(null);
  const [milestoneBusy, setMilestoneBusy] = useState(false);
  const [progressEdit, setProgressEdit] = useState<{ taskId: string; anchor: HTMLElement } | null>(null);
  const [milestoneDelete, setMilestoneDelete] = useState<{ milestone: ProjectMilestone; anchor: HTMLElement } | null>(null);
  const [pendingScrollId, setPendingScrollId] = useState<string | null>(null);

  // 导入菜单是 action 浮层；先让它卸载，再开创建/导入的 editor 浮层，
  // 否则两层在同一帧里换位，新的 editor 会有一帧被当成非栈顶（pointer-events: none）。
  useEffect(() => {
    if (!pendingImportMode) return;
    patchImport({ mode: pendingImportMode });
    setPendingImportMode(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingImportMode]);

  /** 每个项目「下一步」：优先最近推进的未完成任务，否则第一个未完成任务。 */
  const nextTaskOf = (projectId: string, tasks: Task[]) => {
    const recent = recentAdvanceByProject.get(projectId);
    const recentTask = recent ? tasks.find((task) => task.id === recent.taskId) : null;
    if (recentTask && recentTask.status !== "completed") return recentTask;
    return [...tasks]
      .filter((task) => !isTaskCompleted(task))
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))[0] ?? null;
  };

  const soonCount = workspace.projects.filter((project) => project.deadlineLocal && deadlineUrgency(project.deadlineLocal, today) !== "later").length;
  const visibleProjects = useMemo(() => {
    const needle = projectQuery.trim().toLowerCase();
    const matches = (project: Project) => {
      if (soonOnly && !(project.deadlineLocal && deadlineUrgency(project.deadlineLocal, today) !== "later")) return false;
      if (!needle) return true;
      if (project.title.toLowerCase().includes(needle)) return true;
      return projectTasksOf(index, project.id).some((task) => task.title.toLowerCase().includes(needle));
    };
    const sorted = workspace.projects.filter(matches);
    sorted.sort((left, right) => {
      if (projectSort === "name") return left.title.localeCompare(right.title, "zh-CN");
      if (projectSort === "deadline") {
        const leftDeadline = left.deadlineLocal ?? "9999-12-31";
        const rightDeadline = right.deadlineLocal ?? "9999-12-31";
        return leftDeadline.localeCompare(rightDeadline) || left.title.localeCompare(right.title, "zh-CN");
      }
      const leftRecent = recentAdvanceByProject.get(left.id)?.occurredAtUtc ?? "";
      const rightRecent = recentAdvanceByProject.get(right.id)?.occurredAtUtc ?? "";
      return rightRecent.localeCompare(leftRecent) || left.title.localeCompare(right.title, "zh-CN");
    });
    return sorted;
  }, [workspace.projects, index, projectQuery, projectSort, soonOnly, today, recentAdvanceByProject]);

  const selectedProject = selectedProjectId ? index.projectsById.get(selectedProjectId) ?? null : null;
  const selectedTasks = selectedProject ? projectTasksOf(index, selectedProject.id) : [];
  const selectedWeighted = selectedProject ? projectProgress(selectedTasks) : 0;
  const selectedMilestones = selectedProject
    ? [...(index.milestonesByProjectId.get(selectedProject.id) ?? [])].sort((left, right) => left.targetLocalDate.localeCompare(right.targetLocalDate) || left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
    : [];
  const selectedRail = selectedProject ? buildProjectRail({ tasks: selectedTasks, milestones: selectedMilestones, outcomes: index.outcomesByMilestoneId, progress: selectedWeighted }) : null;
  const selectedCompleted = selectedTasks.filter(isTaskCompleted).length;
  const selectedReached = selectedMilestones.filter((milestone) => {
    const outcome = index.outcomesByMilestoneId.get(milestone.id);
    return outcome ? outcome.reached : milestoneReached(milestone, selectedTasks, selectedWeighted);
  }).length;
  const selectedRecent = selectedProject ? recentAdvanceByProject.get(selectedProject.id) ?? null : null;
  const selectedRecentTaskId = selectedRecent && selectedTasks.some((task) => task.id === selectedRecent.taskId) ? selectedRecent.taskId : null;
  const selectedNextTask = selectedProject ? nextTaskOf(selectedProject.id, selectedTasks) : null;
  const shownSelectedTasks = selectedTasks.filter((task) => !taskFilter || !isTaskCompleted(task));
  const selectedTaskPositions = new Map(selectedTasks.map((task, index) => [task.id, index + 1]));

  // 选中项目被筛选/删除掉时收起详情，避免右侧留一个对不上的面板。
  useEffect(() => {
    if (!selectedProjectId) return;
    if (!visibleProjects.some((project) => project.id === selectedProjectId)) onSelectProject(null);
  }, [selectedProjectId, visibleProjects, onSelectProject]);

  useEffect(() => {
    if (!pendingScrollId) return;
    let attempts = 0;
    let timer = 0;
    const attempt = () => {
      const target = document.getElementById(pendingScrollId);
      if (target) { target.scrollIntoView?.({ block: "center" }); setPendingScrollId(null); return; }
      if (++attempts < 12) timer = window.setTimeout(attempt, 40);
    };
    timer = window.setTimeout(attempt, 40);
    return () => window.clearTimeout(timer);
  }, [pendingScrollId, selectedProjectId]);

  const openProject = (projectId: string) => {
    onSelectProject(projectId);
    window.setTimeout(() => detailHeadingRef.current?.focus({ preventScroll: true }), 0);
  };
  const closeProject = () => {
    const previous = selectedProjectId;
    onSelectProject(null);
    window.setTimeout(() => {
      const trigger = previous ? document.querySelector<HTMLElement>('[data-project-open="' + previous + '"]') : null;
      trigger?.focus({ preventScroll: true });
    }, 0);
  };
  const toggleProject = (projectId: string) => {
    if (selectedProjectId === projectId) closeProject();
    else openProject(projectId);
  };
  const continueProject = (projectId: string, task: Task | null) => {
    if (selectedProjectId !== projectId) openProject(projectId);
    if (task) setPendingScrollId("project-task-" + task.id);
  };

  /** 截止事项页的行级动作只定位到既有入口：项目卡、里程碑行、续排表单。 */
  useEffect(() => {
    if (!focus) return;
    setProjectQuery("");
    setSoonOnly(false);
    onSelectProject(focus.projectId);
    const milestone = focus.milestoneId ? index.milestonesById.get(focus.milestoneId) ?? null : null;
    if (focus.action === "continue" && milestone) setMilestoneDraft({ projectId: focus.projectId, editing: continueMilestoneDraft(milestone, today), continuing: true });
    setPendingScrollId(focus.milestoneId ? "milestone-" + focus.milestoneId : "project-" + focus.projectId);
    onFocusHandled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const clearFilters = () => { setProjectQuery(""); setSoonOnly(false); };

  const taskMeta = (task: Task) => {
    const parts: string[] = [];
    if (task.priority === "high") parts.push("高优先级");
    if (task.deadlineLocal) parts.push("截止 " + formatShortDate(task.deadlineLocal) + " · " + deadlineLabel(today, task.deadlineLocal));
    if (task.estimatedMinutes) parts.push("预计 " + task.estimatedMinutes + " 分钟");
    return parts.join(" · ");
  };

  const renderProjectCard = (project: Project) => {
    const tasks = projectTasksOf(index, project.id);
    const weighted = projectProgress(tasks);
    const milestones = index.milestonesByProjectId.get(project.id) ?? [];
    const rail = buildProjectRail({ tasks, milestones, outcomes: index.outcomesByMilestoneId, progress: weighted });
    const completed = tasks.filter(isTaskCompleted).length;
    const recent = recentAdvanceByProject.get(project.id);
    const recentDate = recent ? toLocalDate(new Date(recent.occurredAtUtc)) : null;
    const nextTask = nextTaskOf(project.id, tasks);
    const isSelected = selectedProjectId === project.id;
    return <article key={project.id} id={"project-" + project.id} className={"project-card" + (isSelected ? " is-selected" : "")} data-project-card={project.id}>
      {/* 整卡是打开/关闭详情的按钮；内部动作按钮用 z-index 浮在它上面，避免嵌套按钮。 */}
      <button type="button" className="project-card-open" data-project-open={project.id}
        aria-label={(isSelected ? "关闭项目 " : "打开项目 ") + project.title} aria-expanded={isSelected} aria-controls="project-detail"
        onClick={() => toggleProject(project.id)} />
      <div className="project-card-head">
        <h2>{project.title}</h2>
        <span className="project-card-pct">{weighted}%</span>
      </div>
      <p className="project-card-meta">
        {project.deadlineLocal ? <ProjectDeadlineChip deadline={project.deadlineLocal} today={today} /> : <span className="project-nodeadline">无项目截止</span>}
        <span className="project-card-count" title="已完成任务 / 任务总数" aria-label={`任务完成 ${completed} / ${tasks.length}`}><Check size={12} aria-hidden="true" />{completed} / {tasks.length}</span>
      </p>
      <ProjectRail rail={rail} compact />
      <div className="project-card-foot">
        <button type="button" className="project-continue" onClick={(event) => { event.stopPropagation(); continueProject(project.id, nextTask); }}>
          <span>{nextTask ? "继续：" + nextTask.title : "打开项目"}</span>
          <ChevronRight size={14} aria-hidden="true" />
        </button>
        {/* 次操作：进同一个自动排程气泡，作用域锁在本项目（候选只列该项目、预选其推荐组合）。 */}
        <button type="button" className="project-card-arrange" aria-label={"安排项目 " + project.title}
          onClick={(event) => { event.stopPropagation(); onArrangeProject(project.id); }}>安排项目</button>
        {recentDate
          ? <time className="project-card-recent" dateTime={recentDate}>上次推进 {formatRecentAdvanceDate(recentDate, today)}</time>
          : <span className="project-card-recent">还没有推进</span>}
      </div>
    </article>;
  };

  return <section className="page-stack projects-page" aria-labelledby="projects-title">
    <header className="page-header project-page-header" inert={selectedProject ? true : undefined}>
      <div>
        <h1 id="projects-title">项目</h1>
        <p className="project-subtitle">{visibleProjects.length === workspace.projects.length ? workspace.projects.length + " 个项目" : visibleProjects.length + " / " + workspace.projects.length + " 个项目"}{soonCount > 0 ? " · " + soonCount + " 个临期" : ""}</p>
      </div>
      <div className="header-actions">
        <Button variant="primary" onClick={() => patchImport({ mode: "project" })}><Plus size={17} />新建项目</Button>
        <Button aria-haspopup="dialog" aria-expanded={Boolean(importMenuAnchor)} onClick={(event) => { event.stopPropagation(); const anchor = event.currentTarget; setImportMenuAnchor((current) => current ? null : anchor); }}><Upload size={17} />导入</Button>
      </div>
    </header>

    {importMenuAnchor && <FloatingPanel kind="action" label="导入项目" anchorElement={importMenuAnchor} closeOnOutsideClick onClose={() => setImportMenuAnchor(null)} className="project-import-menu">
      <h2>导入</h2>
      <button type="button" className="project-import-option" aria-label="文本课程" onClick={() => { setImportMenuAnchor(null); setPendingImportMode("course"); }}>
        <Upload size={16} aria-hidden="true" /><span><strong>文本课程</strong><small>粘贴分集文本，批量建立有序任务</small></span>
      </button>
      <button type="button" className="project-import-option" aria-label="B 站链接 Beta" onClick={() => { setImportMenuAnchor(null); setPendingImportMode("bilibili"); }}>
        <Upload size={16} aria-hidden="true" /><span><strong>B 站链接 Beta</strong><small>读取公开视频的分 P 元数据</small></span>
      </button>
    </FloatingPanel>}

    <div className="deadline-filters project-filters" role="group" aria-label="项目筛选" inert={selectedProject ? true : undefined}>
      <div className="deadline-filter-main">
        <label className="deadline-field deadline-field-grow">搜索
          <input aria-label="搜索项目或任务" placeholder="搜索项目或任务" value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} />
        </label>
        <div className="deadline-chip-group" role="group" aria-label="项目排序">
          <span className="deadline-filter-label">排序</span>
          {([{ value: "recent", label: "最近推进" }, { value: "deadline", label: "截止日期" }, { value: "name", label: "名称" }] as const).map((option) => <button key={option.value} type="button" className="filter-chip" aria-pressed={projectSort === option.value} onClick={() => setProjectSort(option.value)}>{option.label}</button>)}
        </div>
      </div>
      <div className="deadline-chip-group" role="group" aria-label="项目筛选">
        <span className="deadline-filter-label">筛选</span>
        <button type="button" className="filter-chip" aria-pressed={soonOnly} aria-label="只看临期项目"
          title="已逾期、今天或 7 天内截止的项目" onClick={() => setSoonOnly((current) => !current)}>临期项目</button>
      </div>
    </div>

    {importDraft.mode !== "none" && <FloatingPanel label="创建项目" wide={importDraft.mode !== "project"} busy={importBusy || importFetching} onClose={() => patchImport({ mode: "none" })}><form aria-busy={importBusy} className="project-form" onSubmit={(event) => { event.preventDefault(); void projectImport.save(); }}><div className="section-heading"><h2>{importDraft.mode === "course" ? "导入课程分集" : importDraft.mode === "bilibili" ? "读取 B 站公开视频" : "创建普通项目"}</h2><button className="icon-action" type="button" disabled={importBusy} aria-label="关闭" onClick={() => patchImport({ mode: "none" })}><X /></button></div><label>项目标题<input autoFocus={importDraft.mode !== "bilibili"} value={importTitle} onChange={(event) => patchImport({ titles: { ...importDraft.titles, [importDraft.mode]: event.target.value } })} /></label>
      {importDraft.mode === "project" && <label>项目截止日期（可选）<DateField label="项目截止日期" value={importDraft.deadline || null} today={today} onChange={(value) => patchImport({ deadline: value ?? "" })} /></label>}
      {importDraft.mode === "course" && <><label>粘贴分集文本<textarea rows={6} value={importDraft.source} placeholder={'P1 起步 12:30\nP2 数据建模 18:00\n\n使用说明\n23:19\nUnit1 Lesson 1\n58:39'} onChange={(event) => patchImport({ source: event.target.value, drafts: parseCourseText(event.target.value) })} /></label><div className="import-preview" aria-label="课程导入预览">{importDraft.drafts.map((draft, index) => <div key={draft.title + "-" + index}><input type="checkbox" aria-label={"选择 " + draft.title} checked={draft.selected} onChange={(event) => patchImport({ drafts: importDraft.drafts.map((item, at) => at === index ? { ...item, selected: event.target.checked } : item) })} /><input aria-label={"编辑第 " + (index + 1) + " 个分集"} value={draft.title} onChange={(event) => patchImport({ drafts: importDraft.drafts.map((item, at) => at === index ? { ...item, title: event.target.value } : item) })} /><span>{draft.estimatedMinutes ? draft.estimatedMinutes + " 分钟" : "未估时"}</span></div>)}</div></>}
      {importDraft.mode === "bilibili" && <><label>B 站普通视频链接<input autoFocus value={importDraft.biliSource} onChange={(event) => patchImport({ biliSource: event.target.value })} placeholder="https://www.bilibili.com/video/BV…" /></label><Button type="button" disabled={!importDraft.biliSource.trim() || importBusy || importFetching} onClick={async () => { setImportFetching(true); setImportFetchError(""); try { const video = await onFetchBilibili(extractBvid(importDraft.biliSource)); patchImport({ bilibili: video, titles: { ...importDraft.titles, bilibili: video.title }, biliSelected: video.parts.map((part) => part.page) }); } catch (error) { setImportFetchError(readError(error)); } finally { setImportFetching(false); } }}>{importFetching ? "正在读取…" : "读取公开元数据"}</Button>{importFetchError && <p className="error-message" role="alert"><CircleAlert />{importFetchError}</p>}{importDraft.bilibili && <><p className="import-source">{importDraft.bilibili.ownerName} · {importDraft.bilibili.bvid} · {importDraft.bilibili.parts.length} 个分 P</p><div className="import-preview" role="region" aria-label="B 站分 P 预览">{importDraft.bilibili.parts.map((part) => <div key={part.sourceKey}><input type="checkbox" aria-label={"选择 " + part.title} checked={importDraft.biliSelected.includes(part.page)} onChange={(event) => patchImport({ biliSelected: event.target.checked ? [...importDraft.biliSelected, part.page] : importDraft.biliSelected.filter((page) => page !== part.page) })} /><span>P{part.page}</span><input aria-label={"编辑第 " + part.page + " 个分 P"} value={part.title} onChange={(event) => patchImport({ bilibili: importDraft.bilibili ? { ...importDraft.bilibili, parts: importDraft.bilibili.parts.map((item) => item.sourceKey === part.sourceKey ? { ...item, title: event.target.value } : item) } : null })} /><span>{Math.ceil(part.durationSeconds / 60)}分钟</span></div>)}</div></>}</>}
      {importDraft.mode !== "bilibili" && projectImport.error && <p role="alert">{projectImport.error}</p>}{!importTitle.trim() && <small>填写项目标题后即可创建。</small>}<div className="form-actions"><Button disabled={importBusy} onClick={() => patchImport({ mode: "none" })}>取消</Button><Button type="submit" variant="primary" disabled={importBusy || !projectImport.canSave}>{importBusy ? "正在写入…" : "创建"}</Button></div>
    </form></FloatingPanel>}

    {newProjectTask && <FloatingPanel className="task-editor-panel" label="添加项目任务" busy={newProjectTaskBusy} closeOnOutsideClick onClose={() => setNewProjectTask(null)}><div className="task-editor-fields"><h2>添加任务</h2><TaskEditorFields task={newProjectTask} projects={workspace.projects} onCancel={() => setNewProjectTask(null)} onUpdate={async (task) => { await onCreateTask(task); setNewProjectTask(null); }} onPhase={setNewProjectTaskBusy} /></div></FloatingPanel>}

    <div className="project-layout">
      <div className="project-list" inert={selectedProject ? true : undefined}>
        {visibleProjects.length === 0
          ? workspace.projects.length === 0
            ? <EmptyState icon={<FolderKanban />} title="还没有项目" text="创建普通项目，或粘贴课程分集文本批量建立有序任务。" action={<Button variant="primary" onClick={() => patchImport({ mode: "project" })}><Plus size={17} />创建第一个项目</Button>} />
            : <EmptyState icon={<ListFilter />} title="没有匹配的项目" text="当前搜索或筛选条件下没有项目。" action={<Button onClick={clearFilters}><RotateCcw size={15} />清除筛选</Button>} />
          : <div className="project-grid">{visibleProjects.map(renderProjectCard)}</div>}
      </div>

      {/* 详情始终是右侧抽屉：遮罩 + 背景 inert，列表保持完整两列卡。 */}
      {selectedProject && selectedRail && <div id="project-detail" className="project-detail" role="dialog" aria-modal="true" aria-labelledby="project-detail-title"
        onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); closeProject(); } }}>
        <button type="button" className="project-detail-scrim" tabIndex={-1} aria-label="关闭项目详情遮罩" onClick={closeProject} />
        <div className="project-detail-panel">
          <header className="project-detail-head">
            <div>
              <h2 id="project-detail-title" ref={detailHeadingRef} tabIndex={-1}>{selectedProject.title}</h2>
              <p>{selectedProject.deadlineLocal ? <ProjectDeadlineChip deadline={selectedProject.deadlineLocal} today={today} /> : <span className="project-nodeadline">无项目截止</span>}<span>{selectedTasks.length} 个任务</span></p>
            </div>
            <button type="button" className="icon-action project-detail-close" aria-label="关闭项目详情" onClick={closeProject}><X size={18} /></button>
          </header>
          <div className="project-detail-body">
            <div className="project-progress">
              <div className="project-progress-top">
                <div><span className="project-progress-value">{selectedWeighted}<small>%</small></span><span className="project-progress-caption">项目进度（耗时加权）</span></div>
                <div className="project-progress-facts"><span>任务 {selectedCompleted} / {selectedTasks.length} 完成</span><span>里程碑 {selectedReached} / {selectedMilestones.length} 达成</span></div>
              </div>
              <ProjectRail rail={selectedRail} />
            </div>

            <section className="project-detail-section" aria-labelledby="project-milestones-title">
              <div className="project-detail-section-head">
                <h3 id="project-milestones-title">里程碑 <span>{selectedMilestones.length}</span></h3>
                <button type="button" className="icon-action project-row-icon" aria-label={"为 " + selectedProject.title + " 新增里程碑"} title="添加里程碑" onClick={() => setMilestoneDraft({ projectId: selectedProject.id, editing: null, continuing: false })}><Plus size={16} /></button>
              </div>
              <div className="project-milestone-list">
                {selectedMilestones.map((milestone) => {
                  const outcome = index.outcomesByMilestoneId.get(milestone.id);
                  const reached = milestoneReached(milestone, selectedTasks, selectedWeighted);
                  const status = outcome
                    ? { className: "milestone-status missed", label: "未达成" }
                    : reached ? { className: "milestone-status reached", label: "已达成" } : { className: "milestone-status", label: "进行中" };
                  const detail = outcome ? outcome.resultText + " · " + formatShortDate(outcome.targetLocalDate) + "到期" : milestoneSummary(milestone, selectedTasks);
                  return <div key={milestone.id} id={"milestone-" + milestone.id} className="project-milestone-row">
                    <span className={"project-milestone-dot" + (outcome ? " is-missed" : reached ? " is-reached" : " is-active")} aria-hidden="true" />
                    <div className="project-milestone-main"><strong>{milestone.title}</strong><small>{detail}</small></div>
                    <span className={status.className}>{status.label}</span>
                    <div className="project-row-actions">
                      {outcome
                        ? <Button variant="quiet" aria-label={"续排里程碑 " + milestone.title} onClick={() => setMilestoneDraft({ projectId: selectedProject.id, editing: continueMilestoneDraft(milestone, today), continuing: true })}>续排</Button>
                        : <><button type="button" className="icon-action project-row-icon" aria-label={"编辑里程碑 " + milestone.title} onClick={() => setMilestoneDraft({ projectId: selectedProject.id, editing: milestone, continuing: false })}><Pencil size={14} /></button><button type="button" className="icon-action project-row-icon" aria-label={"删除里程碑 " + milestone.title} onClick={(event) => setMilestoneDelete({ milestone, anchor: event.currentTarget })}><X size={14} /></button></>}
                    </div>
                  </div>;
                })}
                {selectedMilestones.length === 0 && <p className="project-empty-line">还没有里程碑，可按任务、数量或进度设定检查点。</p>}
              </div>
            </section>

            <section className="project-detail-section" aria-labelledby="project-tasks-title">
              <div className="project-detail-section-head">
                <h3 id="project-tasks-title">任务 <span>{shownSelectedTasks.length}</span></h3>
                <button type="button" className="filter-chip" aria-pressed={taskFilter} onClick={() => setTaskFilter((value) => !value)}>只看未完成</button>
              </div>
              <div className="project-task-list">
                {shownSelectedTasks.map((task) => {
                  const meta = taskMeta(task);
                  return <div key={task.id} id={"project-task-" + task.id} className={"project-task-row" + (isTaskCompleted(task) ? " is-done" : "")}>
                    <span className="project-task-num">{selectedTaskPositions.get(task.id)}</span>
                    <div className="project-task-main">
                      <button type="button" className="project-task-title" aria-label={"编辑任务 " + task.title} onClick={(event) => onEditTask(task, event.currentTarget)}>{task.title}</button>
                      {meta && <small>{meta}</small>}
                    </div>
                    <InlineTaskProgress task={task} onCommit={onProgress} onOpen={(anchor) => setProgressEdit({ taskId: task.id, anchor })} />
                    <div className="project-task-actions">
                      {isTaskCompleted(task)
                        ? <span className="project-task-done"><Check size={13} aria-hidden="true" />已完成</span>
                        : <Button variant="quiet" aria-label={"安排 " + task.title} onClick={() => onArrange(task)}>安排</Button>}
                    </div>
                  </div>;
                })}
                {shownSelectedTasks.length === 0 && <p className="project-empty-line">{selectedTasks.length === 0 ? "这个项目还没有任务。" : "所有任务都已完成。"}</p>}
              </div>
            </section>
          </div>
          <footer className="project-detail-foot">
            {selectedRecentTaskId && <button type="button" className="project-quiet-action project-recent-jump" onClick={() => { setTaskFilter(false); setPendingScrollId("project-task-" + selectedRecentTaskId); }}><LocateFixed size={14} aria-hidden="true" />跳转最近推进</button>}
            <Button aria-label={"编辑项目 " + selectedProject.title} onClick={(event) => { setProjectEditAnchor(event.currentTarget); setEditingProjectId(selectedProject.id); }}>编辑项目</Button>
            <Button variant="primary" onClick={() => setNewProjectTask({ id: crypto.randomUUID(), projectId: selectedProject.id, title: "", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sessionMinutes: null, priority: "normal", sortOrder: selectedTasks.length, kind: "task" })}><Plus size={16} />添加任务</Button>
          </footer>
        </div>
      </div>}
    </div>

    {editingProjectId && (() => {
      const project = index.projectsById.get(editingProjectId);
      return project ? <FloatingPanel label={"编辑项目 " + project.title} anchorElement={projectEditAnchor} closeOnOutsideClick onClose={() => setEditingProjectId(null)}><ProjectEditor project={project} onSave={async (next) => { await onUpdateProject(next); setEditingProjectId(null); }} onClose={() => setEditingProjectId(null)} /></FloatingPanel> : null;
    })()}

    {milestoneDraft && (() => {
      const project = index.projectsById.get(milestoneDraft.projectId);
      if (!project) return null;
      const tasks = projectTasksOf(index, project.id);
      const milestones = index.milestonesByProjectId.get(project.id) ?? [];
      return <FloatingPanel label="里程碑" busy={milestoneBusy} closeOnOutsideClick onClose={() => setMilestoneDraft(null)}><MilestoneForm project={project} tasks={tasks} sortOrder={milestones.length} editing={milestoneDraft.editing} continuing={milestoneDraft.continuing} onCancel={() => setMilestoneDraft(null)} onPhase={setMilestoneBusy} onSave={async (milestone) => { if (milestoneDraft.editing && !milestoneDraft.continuing) await onUpdateMilestone(milestone); else await onCreateMilestone(milestone); setMilestoneDraft(null); }} /></FloatingPanel>;
    })()}

    {progressEdit && (() => {
      const task = index.tasksById.get(progressEdit.taskId);
      return task ? <FloatingPanel kind="action" label={"调整进度 " + task.title} anchorElement={progressEdit.anchor} closeOnOutsideClick onClose={() => setProgressEdit(null)} className="project-progress-panel"><h2>调整进度</h2><p>{task.title}</p><ProgressControl task={task} showComplete onCommit={async (next, value) => { setProgressEdit(null); await onProgress(next, value, progressEdit.anchor); }} /></FloatingPanel> : null;
    })()}

    {milestoneDelete && <FloatingPanel kind="confirm" label={"删除里程碑 " + milestoneDelete.milestone.title} anchorElement={milestoneDelete.anchor} closeOnOutsideClick onClose={() => setMilestoneDelete(null)} className="project-confirm-bubble">
      <p className="project-confirm-text">删除里程碑「{milestoneDelete.milestone.title}」？</p>
      <p className="project-confirm-note">删除后可在底部提示里撤销。</p>
      <div className="form-actions"><Button onClick={() => setMilestoneDelete(null)}>取消</Button><Button variant="danger" onClick={() => { const target = milestoneDelete.milestone; setMilestoneDelete(null); void onDeleteMilestone(target); }}>删除</Button></div>
    </FloatingPanel>}
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
    <label>项目截止日期<DateField label="项目截止日期" value={deadline || null} today={toLocalDate(new Date())} onChange={(value) => setDeadline(value ?? "")} /></label>
    {error && <p className="error-message" role="alert"><CircleAlert />{error}</p>}
    <div className="form-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? "正在保存…" : "保存项目"}</Button></div>
  </form>;
}

function MilestoneForm({ project, tasks, sortOrder, editing, continuing = false, onSave, onCancel, onPhase }: {
  project: Project; tasks: Task[]; sortOrder: number; editing: ProjectMilestone | null; continuing?: boolean;
  onSave: (milestone: ProjectMilestone) => Promise<void>; onCancel: () => void; onPhase?: (busy: boolean) => void;
}) {
  const blankMilestone: ProjectMilestone = tasks.length
    ? { id: "", projectId: project.id, title: "", targetLocalDate: "", sortOrder, criterionKind: "orderedTask", targetTaskId: "", targetCount: null, targetProgress: null }
    : { id: "", projectId: project.id, title: "", targetLocalDate: "", sortOrder, criterionKind: "projectProgress", targetTaskId: null, targetCount: null, targetProgress: 50 };
  const session = useEditorSession<ProjectMilestone>({
    key: editing?.id ?? `new:${project.id}`,
    initial: editing ?? blankMilestone,
    canSave: (draft) => Boolean(draft.title.trim() && draft.targetLocalDate && (draft.criterionKind !== "orderedTask" || draft.targetTaskId)),
    onSave: (draft) => {
      const base = { id: draft.id || crypto.randomUUID(), projectId: project.id, title: draft.title.trim(), targetLocalDate: draft.targetLocalDate, sortOrder: draft.sortOrder };
      // 判别联合必须按 criterionKind 显式构造，展开会丢掉窄化。
      const milestone: ProjectMilestone = draft.criterionKind === "orderedTask"
        ? { ...base, criterionKind: "orderedTask", targetTaskId: draft.targetTaskId ?? "", targetCount: null, targetProgress: null }
        : draft.criterionKind === "taskCount"
          ? { ...base, criterionKind: "taskCount", targetTaskId: null, targetCount: Math.max(1, draft.targetCount ?? 1), targetProgress: null }
          : { ...base, criterionKind: "projectProgress", targetTaskId: null, targetCount: null, targetProgress: Math.min(100, Math.max(1, draft.targetProgress ?? 50)) };
      return onSave(milestone);
    },
    onClose: (reason) => { if (reason !== "saved") onCancel(); },
    onPhaseChange: (phase) => onPhase?.(phase === "submitting"),
  });
  // 草稿是唯一事实来源：输入直接写会话草稿，保存与 canSave 都读它。
  const { draft, patchDraft, busy } = session;
  const goalText = draft.criterionKind === "orderedTask" ? `完成任务「${tasks.find((task) => task.id === draft.targetTaskId)?.title ?? "…"}」`
    : draft.criterionKind === "taskCount" ? `完成 ${draft.targetCount ?? 1} 个项目任务`
    : `项目加权进度达到 ${draft.targetProgress ?? 50}%`;
  const summaryText = draft.targetLocalDate ? `${goalText} · ${formatShortDate(draft.targetLocalDate)}前` : goalText;

  return <form aria-busy={busy} className="milestone-form" onSubmit={(event) => { event.preventDefault(); void session.save(); }}>
    <div className="section-heading"><h3>{continuing ? `续排里程碑：${editing?.title ?? ""}` : editing ? `编辑里程碑：${editing.title}` : "新增里程碑"}</h3><button className="icon-action" type="button" disabled={busy} aria-label="关闭里程碑表单" onClick={session.cancel}><X size={15} /></button></div>
    {continuing && <small>保留原累计目标并顺延日期；当前差额会随后续进度继续减少。</small>}
    <label className="milestone-field"><span>里程碑名称</span><input value={draft.title} onChange={(event) => patchDraft({ title: event.target.value } as Partial<ProjectMilestone>)} /></label>
    <div className="milestone-field"><span>目标日期</span><DateField label="目标日期" value={draft.targetLocalDate || null} today={toLocalDate(new Date())} onChange={(value) => patchDraft({ targetLocalDate: value ?? "" } as Partial<ProjectMilestone>)} /></div>
    <label className="milestone-field"><span>达成条件</span><SelectField value={draft.criterionKind} onChange={(value) => setCriterion(patchDraft, value as ProjectMilestone["criterionKind"])} options={[{ value: "orderedTask", label: "按顺序完成至指定任务", disabled: !tasks.length }, { value: "taskCount", label: "完成任务数量", disabled: !tasks.length }, { value: "projectProgress", label: "项目进度达到" }]} /></label>
    {draft.criterionKind === "orderedTask" && <label className="milestone-field"><span>顺序目标任务</span><SelectField value={draft.targetTaskId ?? ""} onChange={(value) => patchDraft({ targetTaskId: value } as Partial<ProjectMilestone>)} options={[{ value: "", label: "选择项目内任务" }, ...tasks.map((task) => ({ value: task.id, label: task.title }))]} /></label>}
    {draft.criterionKind === "taskCount" && <label className="milestone-field"><span>完成任务数</span><input type="number" min="1" value={draft.targetCount ?? 1} onChange={(event) => patchDraft({ targetCount: Math.max(1, Number(event.target.value) || 1) } as Partial<ProjectMilestone>)} /></label>}
    {draft.criterionKind === "projectProgress" && <label className="milestone-field"><span>目标进度</span><input type="number" min="1" max="100" value={draft.targetProgress ?? 50} onChange={(event) => patchDraft({ targetProgress: Math.min(100, Math.max(1, Number(event.target.value) || 1)) } as Partial<ProjectMilestone>)} /></label>}
    {draft.criterionKind === "taskCount" && <small>项目内共 {tasks.length} 个任务。</small>}
    {!tasks.length && <small>项目还没有任务。添加任务后即可设置按任务或数量达成。</small>}<small>保存后：{summaryText}</small>
    {session.error && <p className="error-message" role="alert"><CircleAlert />{session.error}</p>}
    <div className="form-actions"><Button disabled={busy} onClick={session.cancel}>取消</Button><Button variant="primary" disabled={busy || !session.canSave} onClick={() => void session.save()}>{busy ? "正在保存…" : continuing ? "保存续排" : "保存里程碑"}</Button></div>
  </form>;
}

/** 切换达成条件时同步清掉另外两个分支的取值，保证草稿始终符合判别联合的形状。 */
function setCriterion(patchDraft: (patch: Partial<ProjectMilestone>) => void, kind: ProjectMilestone["criterionKind"]) {
  if (kind === "orderedTask") patchDraft({ criterionKind: "orderedTask", targetCount: null, targetProgress: null } as Partial<ProjectMilestone>);
  else if (kind === "taskCount") patchDraft({ criterionKind: "taskCount", targetTaskId: null, targetProgress: null } as Partial<ProjectMilestone>);
  else patchDraft({ criterionKind: "projectProgress", targetTaskId: null, targetCount: null } as Partial<ProjectMilestone>);
}

function continueMilestoneDraft(milestone: ProjectMilestone, today: string): ProjectMilestone {
  const base = { id: crypto.randomUUID(), projectId: milestone.projectId, title: milestone.title, targetLocalDate: addDays(today, 7), sortOrder: milestone.sortOrder };
  if (milestone.criterionKind === "orderedTask") return { ...base, criterionKind: "orderedTask", targetTaskId: milestone.targetTaskId, targetCount: null, targetProgress: null };
  if (milestone.criterionKind === "taskCount") return { ...base, criterionKind: "taskCount", targetTaskId: null, targetCount: milestone.targetCount, targetProgress: null };
  return { ...base, criterionKind: "projectProgress", targetTaskId: null, targetCount: null, targetProgress: milestone.targetProgress };
}

/**
 * 自动排程的入口作用域：单项入口给 `taskId`（打开后滚到该行并高亮 1.5 秒），
 * 项目卡给 `projectId`（候选只列该项目、预选该项目的推荐组合）。都为 null 就是普通流程。
 */
interface SchedulingRequest { taskId: string | null; projectId: string | null }

/**
 * 候选清单的**一行**。任务一行一项；习惯按 `habitId` 收成一行（2026-10-24 D5=a，
 * 与任务池「今天 N 项」的语言一致），展开后才逐日可单独取消。
 */
interface ScheduleCandidateGroup {
  /** 行标识：任务行是 `task:<taskId>`，习惯行是 `habit:<habitId>`。 */
  id: string;
  taskId: string;
  habitId?: string;
  title: string;
  projectId: string | null;
  /** 这一行代表的所有 `ScheduleItem.key`（习惯是多日）。 */
  keys: string[];
  /** 目标总分钟数。 */
  minutes: number;
  deadlineLocal: string | null;
  /** 习惯行逐日展开用；任务行为空。 */
  occurrences: Array<{ key: string; date: string }>;
}

/** 候选行分组：任务一行一项，习惯按 `habitId` 收组。顺序沿用引擎给候选的池序。 */
function scheduleCandidateGroups(items: ScheduleItem[], workspace: WorkspaceSnapshot): ScheduleCandidateGroup[] {
  const projectOf = new Map(workspace.tasks.map((task) => [task.id, task.projectId ?? null]));
  const habitOf = new Map(workspace.recurringHabits.map((habit) => [habit.id, habit]));
  const groups: ScheduleCandidateGroup[] = [];
  const byHabit = new Map<string, ScheduleCandidateGroup>();
  for (const item of items) {
    const projectId = projectOf.get(item.taskId) ?? null;
    if (item.habitId) {
      const existing = byHabit.get(item.habitId);
      if (existing) {
        existing.keys.push(item.key);
        existing.minutes += item.targetMinutes;
        existing.occurrences.push({ key: item.key, date: item.deadlineLocal ?? "" });
        continue;
      }
      const group: ScheduleCandidateGroup = {
        id: `habit:${item.habitId}`, taskId: item.taskId, habitId: item.habitId,
        title: habitOf.get(item.habitId)?.title ?? item.title, projectId,
        keys: [item.key], minutes: item.targetMinutes, deadlineLocal: null,
        occurrences: [{ key: item.key, date: item.deadlineLocal ?? "" }],
      };
      byHabit.set(item.habitId, group);
      groups.push(group);
      continue;
    }
    groups.push({ id: item.key, taskId: item.taskId, title: item.title, projectId, keys: [item.key], minutes: item.targetMinutes, deadlineLocal: item.deadlineLocal, occurrences: [] });
  }
  return groups;
}

/**
 * 自动排程气泡：候选选择与草案预览两步都在**同一个非模态大气泡**里完成（D2=a）。
 *
 * 结构照 `.review-detail-panel` 拼：`padding:0` + flex 列 + 头／容量／工具行／滚动体／底栏。
 * 点空白或 Esc 关闭即丢弃本次勾选 —— 勾选是纯临时状态，不写任何数据（应用前零写入、
 * 应用后可整组撤销），所以它不该占居中模态那一档。
 */
function SchedulePanel({ workspace, index, preferences, target, onClose, onOpenSettings, onApply }: {
  workspace: WorkspaceSnapshot;
  index: WorkspaceIndex;
  preferences: AppSettings;
  target: SchedulingRequest;
  onClose: () => void;
  onOpenSettings: () => void;
  onApply: (sessions: ExecutionSession[], occurrences: HabitOccurrence[]) => Promise<void>;
}) {
  const today = toLocalDate(new Date());
  // 窗口口径是这一个面板的配置，放在派生值之前（items 依赖它的末日）。
  const [windowMode, setWindowMode] = useState<ScheduleWindowMode>("next7");
  const scheduleWindow = useMemo(() => resolveScheduleWindow(windowMode, today), [windowMode, today]);
  const endDate = windowEndDate(scheduleWindow);
  const minimumMinutes = preferences.minimumSessionMinutes;
  const slots = preferences.defaultTimeSlots;
  const zeroSlots = slots.length === 0;
  // 本次排程的每日上限：面板内可临时改，seed 自设置里的默认值（null = 不限）。
  const [budgetMinutes, setBudgetMinutes] = useState<number | null>(preferences.dailyScheduleBudgetMinutes);

  const items = useMemo<ScheduleItem[]>(() => {
    const tasks = workspace.tasks.filter((task) => task.status === "active" && task.kind !== "habit").map((task) => {
      return { key: `task:${task.id}`, taskId: task.id, title: task.title, targetMinutes: task.sessionMinutes ?? preferences.defaultSessionMinutes, deadlineLocal: scheduleDeadlineForTask(workspace, task, today), priority: task.priority ?? "normal", sortOrder: task.sortOrder };
    });
    const habits = workspace.recurringHabits.flatMap((habit) => {
      const task = workspace.tasks.find((item) => item.id === habit.taskId); if (!task) return [];
      return habitDatesBetween(habit, scheduleWindow.startDate, endDate).filter((date) => !workspace.habitOccurrences.some((occurrence) => occurrence.habitId === habit.id && occurrence.localDate === date)).map((date, position) => ({ key: `habit:${habit.id}:${date}`, taskId: habit.taskId, title: `${habit.title} · ${formatShortDate(date)}`, targetMinutes: habit.sessionMinutes, deadlineLocal: date, priority: "normal" as const, sortOrder: workspace.tasks.length + position, fixedDate: date, fixedStartLocal: habit.preferredStartLocal ?? undefined, habitId: habit.id }));
    });
    return [...tasks, ...habits];
  }, [endDate, preferences.defaultSessionMinutes, scheduleWindow.startDate, today, workspace]);

  const busy = useMemo(() => {
    const now = new Date(); const elapsed = now.getHours() * 60 + now.getMinutes();
    const past = elapsed > 0 ? [{ localDate: today, endLocalDate: today, startLocal: "00:00", endLocal: minutesTime(Math.min(1439, elapsed + 1)) }] : [];
    return [...workspace.executionSessions.filter((session) => session.status === "scheduled"), ...workspace.timeBlocks, ...past];
  }, [today, workspace.executionSessions, workspace.timeBlocks]);

  const projectOfTask = useMemo(() => new Map(workspace.tasks.map((task) => [task.id, task.projectId ?? null])), [workspace.tasks]);
  const groups = useMemo(() => scheduleCandidateGroups(items, workspace), [items, workspace]);
  const recommended = useMemo(() => buildSchedulePlan({ startDate: scheduleWindow.startDate, days: scheduleWindow.days, items, defaultTimeSlots: slots, busy, minimumMinutes, dailyBudgetMinutes: budgetMinutes }), [budgetMinutes, busy, items, minimumMinutes, scheduleWindow, slots]);
  const recommendedKeys = useMemo(() => new Set(recommended.allocations.map((allocation) => allocation.key)), [recommended]);

  // 打开时的那一组勾选：单项入口只勾那一个任务；项目级入口只勾该项目的推荐组合；
  // 普通入口就是全量推荐组合（容量充裕时等于「所有放得下的」）。
  const defaultSelection = useMemo(() => {
    const base = { startDate: scheduleWindow.startDate, days: scheduleWindow.days, defaultTimeSlots: slots, busy, minimumMinutes, dailyBudgetMinutes: budgetMinutes };
    if (target.taskId) return new Set(buildSchedulePlan({ ...base, items: items.filter((item) => item.taskId === target.taskId) }).allocations.map((allocation) => allocation.key));
    if (target.projectId) return new Set(buildSchedulePlan({ ...base, items: items.filter((item) => projectOfTask.get(item.taskId) === target.projectId) }).allocations.map((allocation) => allocation.key));
    return new Set(recommendedKeys);
  }, [budgetMinutes, busy, items, minimumMinutes, projectOfTask, recommendedKeys, slots, target.projectId, target.taskId, today]);

  const [selected, setSelected] = useState<Set<string>>(() => new Set(defaultSelection));
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState(target.projectId ?? "");
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showUnavailable, setShowUnavailable] = useState(Boolean(target.taskId));
  const [openHabits, setOpenHabits] = useState<Set<string>>(() => new Set());

  const plan = useMemo(() => buildSchedulePlan({ startDate: scheduleWindow.startDate, days: scheduleWindow.days, items: items.filter((item) => selected.has(item.key)), defaultTimeSlots: slots, busy, minimumMinutes, dailyBudgetMinutes: budgetMinutes }), [budgetMinutes, busy, items, minimumMinutes, scheduleWindow, selected, slots]);

  // 「其他可安排」= 全量推荐里排不进、但**单独**能排进的项。逐项跑一次只含自己的计划，
  // 这是区分「容量不够」与「根本排不进」的唯一确定性依据（不靠猜）。
  const soloById = useMemo(() => {
    const map = new Map<string, { ok: boolean; reason: ScheduleUnscheduledItem | null; minutes: number }>();
    for (const item of items) {
      const single = buildSchedulePlan({ startDate: scheduleWindow.startDate, days: scheduleWindow.days, items: [item], defaultTimeSlots: slots, busy, minimumMinutes, dailyBudgetMinutes: budgetMinutes });
      map.set(item.key, { ok: single.allocations.length > 0, reason: single.unscheduled[0] ?? null, minutes: single.allocations[0]?.minutes ?? 0 });
    }
    return map;
  }, [budgetMinutes, busy, items, minimumMinutes, slots, today]);

  const matches = (group: ScheduleCandidateGroup) => (!projectFilter || group.projectId === projectFilter)
    && (!query.trim() || group.title.toLowerCase().includes(query.trim().toLowerCase()));
  const visibleGroups = groups.filter(matches);
  const bucketOf = (group: ScheduleCandidateGroup) => group.keys.some((key) => recommendedKeys.has(key)) ? "recommended" : group.keys.some((key) => soloById.get(key)?.ok) ? "other" : "unavailable";
  const recommendedGroups = visibleGroups.filter((group) => bucketOf(group) === "recommended");
  const otherGroups = visibleGroups.filter((group) => bucketOf(group) === "other");
  const unavailableGroups = visibleGroups.filter((group) => bucketOf(group) === "unavailable");
  const hiddenSelected = groups.filter((group) => !matches(group)).reduce((sum, group) => sum + group.keys.filter((key) => selected.has(key)).length, 0);
  const filtering = Boolean(projectFilter || query.trim());

  const availableMinutes = recommended.availableMinutes;
  const remainingMinutes = availableMinutes - plan.usedMinutes;
  // 容量条画的是**剩余**：100% = 这段时间完全空着，随排入逐渐缩短到 0。
  // 变色的时机也按剩余算 —— 剩余降到 10% 以下才提醒，而不是等已经超了才提醒。
  const remainingRatio = availableMinutes > 0 ? Math.min(1, Math.max(0, remainingMinutes / availableMinutes)) : 0;
  // 不做 `availableMinutes > 0` 的前置：可用时长为 0（所有空档都短于最低有效时长）时
  // 条本来就是空的，那正是最该报警的状态，不该因为分母是 0 就退化成中性色。
  const capacityLow = remainingMinutes <= availableMinutes * 0.1;
  const selectedGroups = groups.filter((group) => group.keys.some((key) => selected.has(key)));
  const blocked = items.filter((item) => selected.has(item.key)).flatMap((item) => {
    const allocation = plan.allocations.find((value) => value.key === item.key);
    if (!allocation) return [{ key: item.key, title: item.title, text: scheduleUnscheduledText(plan.unscheduled.find((value) => value.key === item.key), minimumMinutes, budgetMinutes) }];
    if (allocation.minutes >= item.targetMinutes) return [];
    return [{ key: item.key, title: item.title, text: `只能安排 ${allocation.minutes}/${item.targetMinutes} 分钟，剩余以后继续` }];
  });
  const unallocated = items.filter((item) => selected.has(item.key) && !plan.allocations.some((allocation) => allocation.key === item.key));
  // 全选是「当前筛选结果的全选」：计数与勾/取消都只作用于 visibleGroups，被筛掉的勾选原样保留。
  const visibleCheckedGroups = visibleGroups.filter((group) => group.keys.every((key) => selected.has(key))).length;
  const allVisibleChecked = visibleGroups.length > 0 && visibleCheckedGroups === visibleGroups.length;
  const someVisibleChecked = visibleCheckedGroups > 0 && !allVisibleChecked;
  const lockedCount = workspace.executionSessions.filter((session) => session.status === "scheduled").length + workspace.timeBlocks.length;

  // 正文底边淡出：还能往下滚才软化，滚到底撤掉（照 `.review-detail-body.is-scrollable`）。
  const bodyRef = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    const check = () => setMoreBelow(node.scrollHeight - node.scrollTop - node.clientHeight > 4);
    check();
    node.addEventListener("scroll", check, { passive: true });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(check) : null;
    observer?.observe(node);
    return () => { node.removeEventListener("scroll", check); observer?.disconnect(); };
  }, [preview, query, projectFilter, showUnavailable, plan.allocations.length, visibleGroups.length]);

  // 单项入口：把目标行滚进视口并高亮 1.5 秒，用户不用在十几行里自己找刚才点的那个任务。
  const flashKey = target.taskId ? `task:${target.taskId}` : null;
  const [flashRow, setFlashRow] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!flashKey) return;
    const node = bodyRef.current?.querySelector<HTMLElement>(`[data-schedule-row="${flashKey}"]`);
    if (!node) return;
    node.scrollIntoView?.({ block: "center" });
    setFlashRow(flashKey);
    const timer = window.setTimeout(() => setFlashRow(null), 1500);
    return () => window.clearTimeout(timer);
  }, [flashKey]);

  const toggleGroup = (group: ScheduleCandidateGroup, on: boolean) => setSelected((current) => {
    const next = new Set(current);
    for (const key of group.keys) { if (on) next.add(key); else next.delete(key); }
    return next;
  });
  const toggleKey = (key: string, on: boolean) => setSelected((current) => {
    const next = new Set(current);
    if (on) next.add(key); else next.delete(key);
    return next;
  });
  const removeAllocation = (key: string) => setSelected((current) => { const next = new Set(current); next.delete(key); return next; });

  // 逐行结果读的是**当前勾选**算出来的 `plan`，不是全量推荐计划 —— 取消勾选后行内文字立刻跟着变。
  const resultOf = (group: ScheduleCandidateGroup) => {
    const checkedKeys = group.keys.filter((key) => selected.has(key));
    if (!checkedKeys.length) {
      const recommendedHere = group.keys.filter((key) => recommendedKeys.has(key));
      if (recommendedHere.length) {
        const allocation = recommended.allocations.find((value) => value.key === recommendedHere[0]);
        return group.keys.length > 1 || !allocation ? `推荐 ${recommendedHere.length} 个时段` : `推荐 ${scheduleDayLabel(today, allocation.localDate)} ${allocation.minutes} 分钟`;
      }
      const solo = soloById.get(group.keys[0]);
      return solo?.ok ? `单独可排 ${solo.minutes} 分钟` : "暂时无法安排";
    }
    const allocations = checkedKeys.flatMap((key) => plan.allocations.find((value) => value.key === key) ?? []);
    if (!allocations.length) return "当前组合放不下";
    if (group.keys.length === 1) {
      const allocation = allocations[0];
      return allocation.minutes >= allocation.targetMinutes ? `${scheduleDayLabel(today, allocation.localDate)} ${allocation.minutes} 分钟` : `${allocation.minutes}/${allocation.targetMinutes} 分钟`;
    }
    const got = allocations.reduce((sum, allocation) => sum + allocation.minutes, 0);
    return got >= group.minutes ? `${allocations.length} 个时段 · 共 ${got} 分钟` : `${allocations.length}/${group.keys.length} 个时段 · ${got}/${group.minutes} 分钟`;
  };

  /**
   * 行内第二行：先说「为什么排不进或只能排一半」，再说「它凭什么排在这里」。
   * 这一行**永远有内容**（最差也有「任务池顺序」），所以所有行高一致，竖着扫不会跳。
   */
  const basisLineOf = (group: ScheduleCandidateGroup) => {
    const parts: string[] = [];
    const checkedKeys = group.keys.filter((key) => selected.has(key));
    if (checkedKeys.length) {
      const allocations = checkedKeys.flatMap((key) => plan.allocations.find((value) => value.key === key) ?? []);
      const got = allocations.reduce((sum, allocation) => sum + allocation.minutes, 0);
      if (!allocations.length) parts.push(scheduleUnscheduledText(plan.unscheduled.find((value) => checkedKeys.includes(value.key)), minimumMinutes, budgetMinutes));
      else if (got < group.minutes) parts.push(`还差 ${group.minutes - got} 分钟`);
    } else if (bucketOf(group) === "unavailable") {
      parts.push(scheduleUnscheduledText(soloById.get(group.keys[0])?.reason ?? undefined, minimumMinutes, budgetMinutes));
    }
    // 有原因时只说原因：原因 + 依据拼在 600px 的第二行里会被截断，反而两头都读不全。
    return parts.length ? parts.join(" · ") : basisTextOf(group);
  };

  /** 依据：习惯 → 项目 → 高优先级 → 截止 → 池序。只在界面这一层算关系，不重排引擎给的顺序。 */
  const basisTextOf = (group: ScheduleCandidateGroup) => {
    const parts: string[] = [];
    if (group.habitId) {
      const habit = workspace.recurringHabits.find((value) => value.id === group.habitId);
      parts.push(habit?.pattern === "weekdays" ? "习惯 · 工作日" : habit?.pattern === "weekly" ? "习惯 · 每周" : "习惯 · 每天");
    } else if (group.projectId) {
      const project = workspace.projects.find((value) => value.id === group.projectId);
      if (project) parts.push(project.title);
    }
    if (!group.habitId) {
      const task = workspace.tasks.find((value) => value.id === group.taskId);
      if (task && (task.priority ?? "normal") === "high") parts.push("高优先级");
    }
    if (group.deadlineLocal) parts.push(`${formatShortDate(group.deadlineLocal)}截止`);
    if (!parts.length) parts.push("任务池顺序");
    return parts.join(" · ");
  };

  /** 行右侧的第二枚胶囊：逾期与「截止早于范围」这类事实，短到能塞进一个 pill 里。 */
  const sideNoteOf = (group: ScheduleCandidateGroup) => {
    const parts: string[] = [];
    const overdue = overdueDaysOf(group);
    if (overdue > 0) parts.push(`逾期 ${overdue} 天`);
    // 选「下周 / 本周剩余」时，有些任务的截止日期落在范围起点之前：它会被挤到范围首日之后，
    // 看上去像算错。这一枚就是把这个冲突说出来（未来 7 天从今天起算，走不到这里）。
    if (overdue === 0 && group.deadlineLocal && group.deadlineLocal < scheduleWindow.startDate) parts.push("截止早于范围");
    return parts.join(" · ");
  };

  const overdueDaysOf = (group: ScheduleCandidateGroup) => group.deadlineLocal && group.deadlineLocal < today ? daysBetween(group.deadlineLocal, today) : 0;

  const resultOfOccurrence = (key: string) => {
    if (!selected.has(key)) return "未选";
    const allocation = plan.allocations.find((value) => value.key === key);
    if (!allocation) return "放不下";
    return allocation.minutes >= allocation.targetMinutes ? `${allocation.minutes} 分钟` : `${allocation.minutes}/${allocation.targetMinutes} 分钟`;
  };

  const renderRow = (group: ScheduleCandidateGroup) => {
    const checkedCount = group.keys.filter((key) => selected.has(key)).length;
    const allChecked = checkedCount === group.keys.length;
    const sideNote = sideNoteOf(group);
    return <div key={group.id} className={flashRow === group.id ? "schedule-row is-flash" : "schedule-row"} data-schedule-row={group.id}>
      <label className="schedule-row-label">
        <input type="checkbox" checked={allChecked}
          ref={(element) => { if (element) element.indeterminate = checkedCount > 0 && !allChecked; }}
          onChange={(event) => toggleGroup(group, event.target.checked)} />
        <span className="schedule-row-text">
          <span className="schedule-row-title">{group.title}</span>
          <span className="schedule-row-note">{basisLineOf(group)}</span>
        </span>
      </label>
      {/* 右侧固定一列：结果胶囊在上，事实胶囊（逾期 / 截止早于范围）在下。行高随内容浮动，不为对齐而留空。 */}
      <span className="schedule-row-side">
        <span className={checkedCount ? "schedule-chip" : "schedule-chip is-muted"}>{resultOf(group)}</span>
        {sideNote && <span className="schedule-chip is-soft">{sideNote}</span>}
      </span>
      {group.habitId && <button type="button" className="schedule-row-more" aria-label={`展开 ${group.title} 的逐日安排`} aria-expanded={openHabits.has(group.id)}
        onClick={() => setOpenHabits((current) => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; })}>
        {openHabits.has(group.id) ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
      </button>}
      {group.habitId && openHabits.has(group.id) && <div className="schedule-subrows">
        {group.occurrences.map((occurrence) => <label key={occurrence.key} className="schedule-subrow">
          <input type="checkbox" checked={selected.has(occurrence.key)} onChange={(event) => toggleKey(occurrence.key, event.target.checked)} />
          <span>{formatShortDate(occurrence.date)}</span>
          <span className={selected.has(occurrence.key) ? "schedule-chip" : "schedule-chip is-muted"}>{resultOfOccurrence(occurrence.key)}</span>
        </label>)}
      </div>}
    </div>;
  };

  /** 依据 chip：习惯 → 已逾期/临期 → 高优先级 → 项目下一项 → 按池序（领域关系只在界面这一层算）。 */
  const basisOf = (allocation: ScheduleAllocation) => {
    if (allocation.habitId) return "习惯";
    const task = workspace.tasks.find((value) => value.id === allocation.taskId);
    if (!task) return "任务池顺序";
    const deadline = scheduleDeadlineForTask(workspace, task, today);
    if (deadline) {
      const days = daysBetween(today, deadline);
      if (days < 0) return `已逾期 ${Math.abs(days)} 天`;
      if (days === 0) return "今天截止";
      if (days <= 3) return `还有 ${days} 天截止`;
    }
    if ((task.priority ?? "normal") === "high") return "高优先级";
    if (task.projectId) {
      const next = workspace.tasks.filter((value) => value.projectId === task.projectId && value.status === "active" && value.kind !== "habit").sort((left, right) => left.sortOrder - right.sortOrder)[0];
      if (next?.id === task.id) return "项目下一项";
    }
    return "任务池顺序";
  };
  const titleOfAllocation = (allocation: ScheduleAllocation) => allocation.habitId
    ? workspace.recurringHabits.find((habit) => habit.id === allocation.habitId)?.title ?? allocation.title
    : workspace.tasks.find((task) => task.id === allocation.taskId)?.title ?? allocation.title;

  const apply = async () => {
    setSaving(true); setError("");
    const sessions = plan.allocations.map((allocation) => sessionFromAllocation(allocation));
    const occurrences = plan.allocations.flatMap((allocation, at) => allocation.habitId ? [{ id: crypto.randomUUID(), habitId: allocation.habitId, localDate: allocation.localDate, status: "scheduled" as const, sessionId: sessions[at].id }] : []);
    try { await onApply(sessions, occurrences); } catch (reason) { setError(readError(reason)); setSaving(false); }
  };

  const toggleAllVisible = (on: boolean) => setSelected((current) => {
    const next = new Set(current);
    for (const group of visibleGroups) for (const key of group.keys) { if (on) next.add(key); else next.delete(key); }
    return next;
  });
  /**
   * 底栏那枚可点计数：不另列清单（原因已经写在每行第二行），
   * 直接把列表滚到第一个只能部分安排 / 放不下的行并高亮，省掉一份重复文案。
   */
  const jumpToBlocked = () => {
    const first = blocked[0];
    if (!first) return;
    const group = groups.find((value) => value.keys.includes(first.key));
    if (!group) return;
    if (bucketOf(group) === "unavailable" && !showUnavailable) setShowUnavailable(true);
    window.setTimeout(() => {
      const node = bodyRef.current?.querySelector<HTMLElement>(`[data-schedule-row="${group.id}"]`);
      node?.scrollIntoView?.({ block: "center" });
      setFlashRow(group.id);
      window.setTimeout(() => setFlashRow(null), 1500);
    }, 0);
  };

  const previewDates = [...new Set(plan.allocations.map((allocation) => allocation.localDate))].sort();
  const bodyClass = moreBelow ? "schedule-body is-scrollable" : "schedule-body";

  return <FloatingPanel kind="action" wide closeOnOutsideClick busy={saving} label={preview ? "排程草案" : "自动排程"} titleId="schedule-panel-title" className="schedule-panel" onClose={onClose}>
    <div className="schedule-head">
      {preview && <button type="button" className="icon-action schedule-back" aria-label="返回选择" onClick={() => setPreview(false)}><ChevronLeft size={18} aria-hidden="true" /></button>}
      <h2 id="schedule-panel-title" className="schedule-title">{preview ? "排程草案" : "自动排程"}</h2>
      {/* 顺序是「口径 → 日期」：先选按哪种范围排，右边跟着显示这次具体覆盖哪几天。
          副标题写日期而不是「未来 7 天」—— 周三打开时没人知道那 7 天到底是哪 7 天。 */}
      {!preview && !zeroSlots && <span className="schedule-window">
        <SelectField ariaLabel="排程范围" value={windowMode} onChange={(value) => setWindowMode(value as ScheduleWindowMode)}
          options={[{ value: "next7", label: "未来 7 天" }, { value: "thisWeek", label: "本周剩余" }, { value: "nextWeek", label: "下周" }]} />
      </span>}
      <p className="schedule-sub">{formatShortDate(scheduleWindow.startDate)}–{formatShortDate(endDate)}</p>
      {/* 三枚容量 chip 直接挂在标题行，取代原来那条独立容量行：「可用」「已锁」已经进「规则」，
          「用 X」删掉 —— 剩多少是唯一要答的问题。 */}
      {/* 顶部只留结论性的剩余量，做成容量条；项数与时段数下沉到底栏左下角，跟全选放在一起。 */}
      {!preview && !zeroSlots && <span className="schedule-head-caps">
        <span className="schedule-meter" role="img" data-low={capacityLow ? "true" : undefined}
          aria-label={`可安排时间${remainingMinutes < 0 ? `已超出 ${formatDuration(-remainingMinutes)}` : `还剩 ${formatDuration(remainingMinutes)}`}，共 ${formatDuration(availableMinutes)}`}
          title={remainingMinutes < 0 ? `已超出 ${formatDuration(-remainingMinutes)}` : `剩余 ${formatDuration(remainingMinutes)} / 共 ${formatDuration(availableMinutes)}`}>
          <span className="schedule-meter-value" aria-hidden="true">{remainingMinutes < 0 ? `超 ${formatClockMinutes(remainingMinutes)}` : formatClockMinutes(remainingMinutes)}</span>
          <span className="schedule-meter-track" aria-hidden="true">
            <span className="schedule-meter-fill" style={{ width: `${Math.round(remainingRatio * 100)}%` }} />
          </span>
          {/* 右侧的总量是分母：只有「剩 12:55」时你没法判断这算多算少，配上 27:30 比例才有意义。 */}
          <span className="schedule-meter-total" aria-hidden="true">{formatClockMinutes(availableMinutes)}</span>
        </span>
      </span>}
      {preview && unallocated.length > 0 && <span className="schedule-head-caps">
        <span className="schedule-cap">仍未安排 <strong>{unallocated.length}</strong> 项</span>
      </span>}
      <details className="schedule-rules">
        <summary>规则</summary>
        <p>仅追加到空档，不调整已有安排或时间块。所选范围共 {formatDuration(availableMinutes)} 可用；已锁 {lockedCount} 个既有安排与时间块，这部分时间不会被重复使用。</p>
      </details>
      <button type="button" className="icon-action schedule-close" aria-label="关闭自动排程" onClick={onClose}><X size={18} aria-hidden="true" /></button>
    </div>

    {!preview && !zeroSlots && <div className="schedule-toolbar">
      <label className="schedule-field"><span>项目</span>
        <SelectField value={projectFilter} onChange={setProjectFilter} options={[{ value: "", label: "全部" }, ...workspace.projects.map((project) => ({ value: project.id, label: project.title }))]} />
      </label>
      <input type="search" aria-label="搜索排程任务" placeholder="搜索任务或习惯" value={query} onChange={(event) => setQuery(event.target.value)} data-autofocus />
      {/* 每日上限：留空 = 不限（null），改动只作用于本次排程、不写设置。不套 <label>：
          NumberField 内部先有 ± 按钮，label 的隐式关联会落到减号上（控件自带文档的已知坑）。 */}
      <span className="schedule-field"><span aria-hidden="true">每日上限</span>
        <NumberField label="每日排程时长上限，留空为不限" suffix="分钟" min={DAILY_BUDGET_MINUTES_RANGE[0]} max={DAILY_BUDGET_MINUTES_RANGE[1]} step={30} nullable value={budgetMinutes} onChange={setBudgetMinutes} />
      </span>
    </div>}

    {preview
      ? <div className={bodyClass} ref={bodyRef} tabIndex={0} role="region" aria-label="排程草案">
        {previewDates.map((date) => {
          const dayAllocations = plan.allocations.filter((allocation) => allocation.localDate === date).sort((left, right) => left.startLocal.localeCompare(right.startLocal));
          return <section key={date} className="schedule-day">
            <h3>{scheduleDayLabel(today, date)} · {dayAllocations.length} 个时段 · {formatDuration(dayAllocations.reduce((sum, allocation) => sum + allocation.minutes, 0))}</h3>
            {dayAllocations.map((allocation) => <article key={allocation.key} className="schedule-card">
              <strong>{titleOfAllocation(allocation)}</strong>
              {/* 时刻与时长合并成一枚，跟依据并列在行右侧 —— 与候选行同一套「左标题、右事实」的阅读顺序。 */}
              <span className="schedule-card-time">{allocation.startLocal}–{allocation.endLocal} · {allocation.minutes >= allocation.targetMinutes ? `${allocation.minutes} 分钟` : `${allocation.minutes}/${allocation.targetMinutes} 分钟`}</span>
              <span className="schedule-basis">{basisOf(allocation)}</span>
              <button type="button" className="icon-action schedule-card-remove" aria-label={`移除 ${titleOfAllocation(allocation)}`} onClick={() => removeAllocation(allocation.key)}><X size={16} aria-hidden="true" /></button>
            </article>)}
          </section>;
        })}
        {!previewDates.length && <div className="schedule-empty">
          <strong>没有可应用的时段</strong>
          <p>当前勾选在当前空档里排不下。返回选择改一改，或放弃预览。</p>
          <Button onClick={() => setPreview(false)}>返回选择</Button>
        </div>}
      </div>
      : <div className={bodyClass} ref={bodyRef} tabIndex={0} role="region" aria-label="排程候选">
        {zeroSlots
          ? <div className="schedule-empty">
            <span><CalendarDays size={20} aria-hidden="true" /></span>
            <strong>还没有可用时间</strong>
            <p>自动排程只在可用时间里找空档；先去设置里标出你能用的时段。</p>
            <div className="schedule-empty-actions"><Button variant="primary" onClick={onOpenSettings}>去标记可用时间</Button><Button onClick={onClose}>关闭</Button></div>
          </div>
          : <>
            {filtering && <div className="schedule-hint">
              <span>已按{projectFilter ? "项目" : "搜索"}筛选 · 显示 {visibleGroups.length}/{groups.length} · 选择仍含其余 {hiddenSelected} 项</span>
              <button type="button" onClick={() => { setProjectFilter(""); setQuery(""); }}>显示全部</button>
            </div>}
            {recommendedGroups.length > 0 && <section className="schedule-group" aria-labelledby="schedule-group-recommended">
              <div className="schedule-group-head">
                <strong id="schedule-group-recommended">推荐本次安排</strong>
                <button type="button" onClick={() => setSelected(new Set(defaultSelection))}>恢复推荐</button>
              </div>
              {recommendedGroups.map(renderRow)}
            </section>}
            {otherGroups.length > 0 && <section className="schedule-group" aria-labelledby="schedule-group-other">
              <div className="schedule-group-head">
                <strong id="schedule-group-other">其他可安排</strong>
                <span className="schedule-group-meta">{otherGroups.length} 项</span>
                <button type="button" onClick={() => setSelected((current) => { const next = new Set(current); for (const group of otherGroups) for (const key of group.keys) next.add(key); return next; })}>全选本组</button>
              </div>
              {otherGroups.map(renderRow)}
            </section>}
            {unavailableGroups.length > 0 && <section className="schedule-group">
              <button type="button" className="schedule-fold" aria-expanded={showUnavailable} onClick={() => setShowUnavailable(!showUnavailable)}>
                {showUnavailable ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                另有 {unavailableGroups.length} 项暂时无法安排
              </button>
              {showUnavailable && unavailableGroups.map(renderRow)}
            </section>}
            {!visibleGroups.length && (groups.length
              ? <div className="schedule-empty"><strong>当前筛选没有任务</strong><p>切回全部即可看到其余 {groups.length} 项。</p><Button onClick={() => { setProjectFilter(""); setQuery(""); }}>清除筛选</Button></div>
              : <div className="schedule-empty"><strong>没有可安排的任务</strong><p>任务池里的活动任务都已安排，或暂时没有任务。</p></div>)}
          </>}
      </div>}

    {(!zeroSlots || preview) && <div className="schedule-foot">
      {error && <p className="error-message" role="alert"><CircleAlert />{error}</p>}
      <span className="schedule-foot-left">
        {/* data-* 给结构账探针读（跟 data-schedule-row 一样）：DOM 的 checked 与 React state 是否一致靠它验证。 */}
        {!preview && !zeroSlots && <label className="schedule-selectall" data-all={allVisibleChecked ? "1" : "0"} data-some={someVisibleChecked ? "1" : "0"} data-groups={visibleGroups.length}>
          <input type="checkbox" checked={allVisibleChecked} aria-label={`全选当前筛选的 ${visibleGroups.length} 项`}
            ref={(element) => { if (element) element.indeterminate = someVisibleChecked; }}
            /* 按当前状态取反，不读 event.target.checked：受控 checkbox 在 indeterminate 状态
               下，浏览器在 change 之前会把 checked 复原成 props 里的值，读到的永远是 false
               —— 于是「点全选」变成了「全部取消」。 */
            onChange={() => toggleAllVisible(!allVisibleChecked)} />
          <span>全选</span>
        </label>}
        {(!zeroSlots || preview) && <>
          <span className="schedule-cap">共 <strong>{visibleGroups.length}</strong> 项</span>
          <span className="schedule-cap"><strong>{plan.allocations.length}</strong> 个时段</span>
        </>}
        {!preview && !zeroSlots && blocked.length > 0 && <button type="button" className="schedule-blocked-jump" onClick={jumpToBlocked}>
          {blocked.length} 项只能部分安排<ChevronRight size={13} aria-hidden="true" />
        </button>}
        {!preview && !zeroSlots && plan.allocations.length === 0 && <span className="schedule-foot-hint">请先选择至少一个任务</span>}
      </span>
      <span className="schedule-foot-actions">
        {preview
          ? <><Button disabled={saving} onClick={onClose}>放弃预览</Button><Button variant="primary" disabled={saving || plan.allocations.length === 0} onClick={() => void apply()}>{saving ? "正在应用…" : `应用 ${plan.allocations.length} 个时段`}</Button></>
          : <><Button disabled={saving} onClick={onClose}>取消</Button><Button variant="primary" disabled={saving || plan.allocations.length === 0} onClick={() => setPreview(true)}>生成排程草案</Button></>}
      </span>
    </div>}
  </FloatingPanel>;
}

function scheduleDeadlineForTask(workspace: WorkspaceSnapshot, task: Task, today: string) {
  if (task.deadlineLocal) return task.deadlineLocal;
  if (!task.projectId) return null;
  const projectTasks = workspace.tasks.filter((item) => item.projectId === task.projectId);
  const completed = (item: Task) => item.status === "completed" || item.progress >= 100;
  const weighted = projectProgress(projectTasks);
  const frozenIds = new Set(workspace.milestoneOutcomes.map((outcome) => outcome.milestoneId));
  const milestoneDeadlines = workspace.projectMilestones
    .filter((milestone) => milestone.projectId === task.projectId && milestone.targetLocalDate >= today && !frozenIds.has(milestone.id) && !milestoneReached(milestone, projectTasks, weighted))
    .filter((milestone) => {
      if (milestone.criterionKind === "orderedTask") return orderedMilestoneTasks(milestone, projectTasks).some((item) => item.id === task.id);
      if (milestone.criterionKind === "taskCount") {
        const remaining = Math.max(0, milestone.targetCount - projectTasks.filter(completed).length);
        return projectTasks.filter((item) => item.status === "active" && item.kind !== "habit").sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id)).slice(0, remaining).some((item) => item.id === task.id);
      }
      return true;
    })
    .map((milestone) => milestone.targetLocalDate);
  const projectDeadline = workspace.projects.find((project) => project.id === task.projectId)?.deadlineLocal ?? null;
  return [...milestoneDeadlines, ...(projectDeadline ? [projectDeadline] : [])].sort()[0] ?? null;
}

function DataPage({ native }: { native: NativeApi }) {
  const [message, setMessage] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [currentCounts, setCurrentCounts] = useState<{ projects: number; tasks: number } | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [restoreSelection, setRestoreSelection] = useState<BackupPreview | null>(null); const [restoreError, setRestoreError] = useState(""); const [restoreBusy, setRestoreBusy] = useState(false);
  const closeRestore = useCallback(() => setRestoreSelection(null), []);
  useEffect(() => { void native.getDataOverview().then((value) => { setBackups(value.backups); setCurrentCounts(value.counts); setBackupError(value.backupError); }).catch((reason) => setError(readError(reason))); }, [native]);
  const run = async (action: () => Promise<BackupInfo | null>, success: string) => { setBusy(true); setError(""); try { const result = await action(); if (result) { setMessage(success); setBackupError(null); setBackups((items) => [result, ...items.filter((item) => item.path !== result.path)]); } } catch (reason) { setError(readError(reason)); } finally { setBusy(false); } };
  const chooseRestore = async () => { setBusy(true); setError(""); try { const source = await native.chooseRestoreSource(); if (source) setRestoreSelection(await native.inspectBackup(source)); } catch (reason) { setError(readError(reason)); } finally { setBusy(false); } };
  // 恢复会整页重载：先查活动编辑会话（规格 §4.3 表末两行）。
  // 提交中 → 等待，不打断请求；有未提交草稿 → 返回并要求先处理，不静默丢弃。
  const confirmRestore = async () => {
    if (!restoreSelection) return;
    if (hasSubmittingEditor()) { setRestoreError("有正在保存的编辑，稍候再试。"); return; }
    if (hasUncommittedEditorDraft()) { setRestoreError("有未保存的编辑，请先保存或取消后再恢复备份。"); return; }
    setRestoreBusy(true); setRestoreError("");
    try { await native.restoreBackup(restoreSelection.source); window.location.reload(); }
    catch (reason) { setRestoreError(readError(reason)); setRestoreBusy(false); }
  };
  return <section className="page-stack narrow-page"><PageHeader eyebrow="本地保存 · 保留最近 7 天备份" title="数据与安全" /><section className="surface-card data-card"><div className="data-card-main"><ArchiveRestore size={32} /><div><h2>本地备份</h2><p>每次核心写入后刷新当天备份；恢复前会先保存当前状态并验证目标文件。</p></div></div><div className="form-actions"><Button variant="primary" disabled={busy} onClick={() => void run(() => native.createDailyBackup(), "已刷新今天的备份")}>立即备份</Button><Button disabled={busy} onClick={() => void run(() => native.createManualBackup(), "已导出手动备份")}>导出</Button><Button disabled={busy} onClick={() => void chooseRestore()}>恢复</Button></div></section>{backupError && <p className="error-message" role="alert"><CircleAlert />自动备份未完成：{backupError}。下次核心写入或手动备份时会重试。</p>}{message && <p className="success-message" role="status"><Check />{message}</p>}{error && <p className="error-message" role="alert"><CircleAlert />{error}</p>}<section className="settings-section backup-section"><div className="settings-section-head"><Database /><h2>备份记录</h2><p>{backups.length ? `共 ${backups.length} 份` : "还没有备份"}</p></div>{backups.length === 0 ? <p className="settings-empty">还没有备份记录。点「立即备份」生成第一份。</p> : <div className="settings-rows">{backups.map((backup) => <BackupRow key={backup.path} backup={backup} native={native} disabled={busy} onPreview={setRestoreSelection} />)}</div>}</section>{restoreSelection && <RestoreDialog currentCounts={currentCounts} preview={restoreSelection} error={restoreError} busy={restoreBusy} onClose={closeRestore} onConfirm={confirmRestore} />}</section>;
}

function BackupRow({ backup, native, disabled, onPreview }: { backup: BackupInfo; native: NativeApi; disabled: boolean; onPreview: (preview: BackupPreview) => void }) {
  const [preview, setPreview] = useState<BackupPreview | null>(null); const [error, setError] = useState("");
  const [copied, setCopied] = useState(false); const copyTimer = useRef<number | null>(null);
  useEffect(() => { let alive = true; void native.inspectBackup(backup.path).then((value) => { if (alive) setPreview(value); }).catch((reason) => { if (alive) setError(readError(reason)); }); return () => { alive = false; }; }, [backup, native]);
  useEffect(() => () => { if (copyTimer.current) window.clearTimeout(copyTimer.current); }, []);
  // 路径默认不占位（见样式里的 `.backup-path-tip`），复制是唯一的取用方式；
  // `execCommand` 是 WebView2 里 `navigator.clipboard` 不可用时的退路。
  const copyPath = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(backup.path);
      else { const area = document.createElement("textarea"); area.value = backup.path; area.setAttribute("readonly", ""); area.style.cssText = "position:fixed;opacity:0"; document.body.append(area); area.select(); document.execCommand("copy"); area.remove(); }
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch { setCopied(false); }
  };
  return <div className="settings-row backup-row">
    <div className="settings-label">
      <strong>{backup.kind === "daily" ? "每日备份" : backup.kind === "manual" ? "手动备份" : "恢复前备份"}</strong>
      {preview
        ? <small className="backup-meta">{formatDateTimeLong(preview.modifiedAt)} · {(preview.sizeBytes / 1024).toFixed(1)} KB<span className="backup-status ok">检查通过</span></small>
        : <small className="backup-meta">{error ? <span className="backup-status bad">{error}</span> : "正在检查备份…"}</small>}
    </div>
    <div className="settings-control">
      <Button disabled={disabled || !preview} onClick={() => preview && onPreview(preview)}>检查并预览</Button>
      <button type="button" className="icon-action backup-copy" aria-label={copied ? "已复制备份文件位置" : `复制备份文件位置 ${backup.path}`} onClick={() => void copyPath()}>
        {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
        <span className="backup-path-tip" aria-hidden="true">{backup.path}</span>
      </button>
    </div>
  </div>;
}


const APPEARANCE_OPTIONS: Array<{ value: AppSettings["appearance"]; label: string }> = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];
const MOTION_OPTIONS: Array<{ value: AppSettings["motion"]; label: string }> = [
  { value: "system", label: "跟随系统" },
  { value: "reduce", label: "减少" },
  { value: "full", label: "完整" },
];
const [CHECK_IN_GRACE_MIN, CHECK_IN_GRACE_MAX] = CHECK_IN_GRACE_MINUTES_RANGE;
const [MINIMUM_SESSION_MIN, MINIMUM_SESSION_MAX] = MINIMUM_SESSION_MINUTES_RANGE;

/** 每周固定星期顺序：界面列顺序为周一到周日（0 = 周日）。 */
const AVAILABILITY_WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const AVAILABILITY_DAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"] as const;
/** 每小时高度的区间（rem）：1.5rem 一屏能看完一天，5rem 够看清 15 分钟的差别。 */
const AVAILABILITY_HOUR_REM_RANGE = [1.5, 5] as const;
/** 缩放滑杆的百分比区间：50% 最紧凑、100% 最宽松；默认 70%（≈2.9rem/小时）。 */
const AVAILABILITY_ZOOM_RANGE = [50, 100] as const;
const AVAILABILITY_ZOOM_DEFAULT = 70;
/** 一次「＋」与一次「折叠」加出来的长度，以及块的最短长度。 */
const AVAILABILITY_ADD_MINUTES = 60;
const AVAILABILITY_MIN_MINUTES = 15;
/** 块矮到放不下常规字号时换紧凑排法：块内只写时间，没有第二行。 */
const AVAILABILITY_TINY_PX = 26;
/** 够高的块在**窄列**里可以把起止拆成两行（见 styles.css 的容器查询）。 */
const AVAILABILITY_TALL_PX = 40;

/** 滑杆百分比 → 每小时高度（rem）：50% = 1.5rem，100% = 5rem。 */
function availabilityHourRemFor(percent: number) {
  const [low, high] = AVAILABILITY_ZOOM_RANGE;
  const [minimum, maximum] = AVAILABILITY_HOUR_REM_RANGE;
  const clamped = Math.max(low, Math.min(high, percent));
  return minimum + ((clamped - low) / (high - low)) * (maximum - minimum);
}

/**
 * 根字号（px）：rem 是主题与界面缩放的唯一出口，折叠带的拖动灵敏度要按它换算成像素。
 *
 * 浏览器给的是**解析后的绝对值**（`16px` / `32px`）；jsdom 只把内联样式原样读回来
 * （`100%` / `200%`），所以这里两种写法都认 —— 百分比按 16px 的默认根字号折算。
 */
function availabilityRemPx() {
  if (typeof window === "undefined" || typeof document === "undefined") return 16;
  const raw = window.getComputedStyle(document.documentElement).fontSize || "";
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) return 16;
  return raw.trim().endsWith("%") ? (value / 100) * 16 : value;
}

/** 页脚与列头用的小时写法：整数写 39h，其余写 5.6h。 */
function availabilityHours(minutes: number) {
  const hours = minutes / 60;
  return (Number.isInteger(hours) ? String(hours) : hours.toFixed(1)) + "h";
}

/** 一天里合并后的空闲分钟数：存储里相邻的两段先并起来再相加。 */
function availabilityDayMinutes(slots: DefaultTimeSlot[], weekday: number) {
  return mergeAvailability(slots.filter((slot) => slot.weekdays.includes(weekday)))
    .reduce((sum, slot) => sum + (timeMinutes(slot.end) - timeMinutes(slot.start)), 0);
}

/** 整周空闲分钟数：七天分别合并后相加（不能拿一段乘星期数 —— 合并会改变每段时长）。 */
function availabilityWeekMinutes(slots: DefaultTimeSlot[]) {
  return AVAILABILITY_WEEK_ORDER.reduce<number>((sum, weekday) => sum + availabilityDayMinutes(slots, weekday), 0);
}

/** 选中项：一块空闲，或一条折叠带。两者都支持 Delete。 */
type AvailabilitySelection =
  | { kind: "slot"; weekday: number; start: string; end: string }
  | { kind: "fold"; start: string; end: string };

/** 窗口起止只能落在 00:00–23:59：`24:00` 是折叠段的写法，不是窗口的。 */
function availabilitySlotClock(minute: number) {
  return foldedClock(Math.max(0, Math.min(1439, Math.round(minute))));
}

/** 折叠带里的小时写法：整数写 `6 小时`，半小时写 `1.5 小时`。 */
function availabilityBandHours(minutes: number) {
  const hours = minutes / 60;
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

const AVAILABILITY_HINT_GROUPS = [
  { title: "空闲", items: ["悬停空白处点「＋」加 1 小时", "拖块上／下沿改起止，↑↓ 也改", "拖块身整体移位", "× 或 Delete 删除"] },
  { title: "折叠", items: ["悬停左侧时间点「折叠」折起 1 小时", "拖灰带上／下沿改范围", "拖灰带中部整段平移", "× 展开这一段"] },
] as const;
/**
 * 「可用时间」A3 设计器（2026-11-08）。
 *
 * 同一根时间轴上：展开段按 `(end - start) / 60 × 每小时高度` 铺开，折叠段压成一条灰带。
 * 折叠只改**画法**，不改时间连续性 —— 段与段首尾相接、合起来正好覆盖一整天。
 *
 * 三组手势共用一套状态：悬停（框出要加的那一小时）、块拖动（拖身／拖上下沿）、
 * 灰带拖动（拖上／下沿改范围、拖中部平移）。拖动中只画读数，松手才交给
 * `onSlotsChange` / `onFoldsChange`；点一下块只选中，不写历史、不写存储。
 *
 * 跨折叠边界的块：只改看得见的那一片，藏在灰带里的首尾由 `replaceAvailability`
 * 原样写回（设计稿修过的数据丢失 bug）。
 */
function AvailabilityDesigner({ slots, folds, snapMinutes, zoomPercent, onSlotsChange, onFoldsChange }: {
  slots: DefaultTimeSlot[];
  folds: FoldedRange[];
  snapMinutes: AppSettings["snapMinutes"];
  zoomPercent: number;
  onSlotsChange: (next: DefaultTimeSlot[]) => void;
  onFoldsChange: (next: FoldedRange[]) => void;
}) {
  const snap: AvailabilitySnap = snapMinutes === "off" ? 0 : snapMinutes;
  const blocks = useMemo(() => availabilityBlocks(slots), [slots]);
  const [selected, setSelected] = useState<AvailabilitySelection | null>(null);
  const [hover, setHover] = useState<{ seg: number; weekday: number; start: number } | null>(null);
  const [tag, setTag] = useState<{ text: string; x: number; y: number } | null>(null);
  /**
   * 拖拽中的实时几何（块或灰带）。
   *
   * 只在松手时写库，但**画**必须跟手：块与灰带的 top／height 由这里覆盖，
   * 否则拖动过程只有指针旁的读数在动、被拖的那块停在原地（A3 重写时丢的）。
   * `kind` 决定覆盖哪一类：`block` 按「星期 + 原起止」认，`fold` 按原段认。
   */
  const [liveDrag, setLiveDrag] = useState<
    | { kind: "block"; weekday: number; fromStart: string; fromEnd: string; start: number; end: number }
    | { kind: "fold"; fromStart: number; fromEnd: number; start: number; end: number }
    | null
  >(null);
  /** 拖动结束后浏览器仍会补一次 click：用它挡掉，免得「拖完顺手又选中／又新建」。 */
  const suppressClick = useRef(false);
  /**
   * 上一次拖动没走完的收尾（防御性）。
   *
   * 正常路径是松手／取消时自己摘监听；但只要中途任何一步提前返回（move 里抛错、
   * 组件被卸载、测试在 pointerup 之前就结束），那套 window 监听就会留到下一次交互 ——
   * 表现是「之后的 Esc 没反应」。所以每次按下新拖动前先跑一遍上一次的清理。
   */
  const teardownDragRef = useRef<(() => void) | null>(null);
  const resetDrag = () => { teardownDragRef.current?.(); teardownDragRef.current = null; };
  const hourPx = availabilityHourRemFor(zoomPercent) * availabilityRemPx();
  const clock = (minute: number) => foldedClock(Math.max(0, Math.min(1440, Math.round(minute))));
  /**
   * 拖灰带时的「预览折叠集合」：把被拖的那一段换成实时范围再规范化。
   * 段的位置与长度都从这份集合算，所以灰带拖动时整条轴会实时重排（不是只有读数在动）。
   */
  const liveFolds = useMemo(() => {
    if (liveDrag?.kind !== "fold") return folds;
    const rest = folds.filter((range) => {
      const from = foldedMinute(range.start);
      const to = foldedMinute(range.end);
      return !(from === liveDrag.fromStart && to === liveDrag.fromEnd);
    });
    return normalizeFoldedRanges([...rest, { start: foldedClock(liveDrag.start), end: foldedClock(liveDrag.end) }]);
  }, [folds, liveDrag]);
  const segments = useMemo(() => availabilitySegments(liveFolds), [liveFolds]);
  const minuteIn = (seg: AvailabilitySegment, rect: DOMRect, clientY: number) =>
    seg.start + ((clientY - rect.top) / Math.max(1, rect.height)) * (seg.end - seg.start);
  const foldStep = snap === 0 ? 5 : snap;

  const addSlot = (weekday: number, start: number, end: number) => {
    onSlotsChange(mergeAvailability(addAvailability(slots, weekday, availabilitySlotClock(start), availabilitySlotClock(end), () => crypto.randomUUID())));
  };
  const removeSlot = (weekday: number, start: string, end: string) => {
    onSlotsChange(mergeAvailability(removeAvailability(slots, weekday, start, end)));
    setSelected(null);
  };
  const unfold = (start: number, end: number) => {
    onFoldsChange(removeFold(folds, { start: clock(start), end: clock(end) }));
    setSelected(null);
  };

  // 弹窗卸载时兜底：拖动若还没结束，把它的 window 监听一并摘掉。
  useEffect(() => () => { teardownDragRef.current?.(); teardownDragRef.current = null; }, []);

  // Delete / Backspace 删除选中项；Esc 清选中。输入框里的按键不受影响。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select")) return;
      // 拖动中的 Esc 由拖动自己挂的捕获监听处理（要先于弹窗的「关弹窗」）：
      // 这里只负责非拖动状态下清掉选中。
      if (event.key === "Escape") { setSelected(null); return; }
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (!selected) return;
      event.preventDefault();
      if (selected.kind === "fold") unfold(timeMinutes(selected.start), timeMinutes(selected.end));
      else removeSlot(selected.weekday, selected.start, selected.end);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  /** 块拖动：拖身平移、拖上下沿改起止；只作用于看得见的那一片。 */
  const beginBlockDrag = (block: AvailabilityBlock, seg: AvailabilitySegment, edge: "move" | "top" | "bottom") => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const track = (event.currentTarget as HTMLElement).closest<HTMLElement>(".availability-track");
    if (!track) return;
    resetDrag();
    event.preventDefault(); event.stopPropagation();
    suppressClick.current = true;
    setHover(null);
    const fromStart = timeMinutes(block.start);
    const fromEnd = timeMinutes(block.end) === 0 ? 1440 : timeMinutes(block.end);
    const visibleStart = Math.max(fromStart, seg.start);
    const visibleEnd = Math.min(fromEnd, seg.end);
    if (visibleEnd <= visibleStart) return;
    const rect = track.getBoundingClientRect();
    const grab = minuteIn(seg, rect, event.clientY);
    const length = visibleEnd - visibleStart;
    const compute = (clientY: number) => {
      const minute = minuteIn(seg, rect, clientY);
      if (edge === "move") {
        const start = Math.max(seg.start, Math.min(seg.end - length, snapMinute(visibleStart + (minute - grab), snap)));
        return { start, end: start + length };
      }
      if (edge === "top") return { start: Math.max(seg.start, Math.min(visibleEnd - AVAILABILITY_MIN_MINUTES, snapMinute(minute, snap))), end: visibleEnd };
      return { start: visibleStart, end: Math.max(visibleStart + AVAILABILITY_MIN_MINUTES, Math.min(seg.end, snapMinute(minute, snap))) };
    };
    setLiveDrag({ kind: "block", weekday: block.weekday, fromStart: block.start, fromEnd: block.end, start: visibleStart, end: visibleEnd });
    // 拖动期间禁掉文本选择：块里的时间是可选中的文字，指针扫过相邻块会把它框起来，
    // 松手后选区还留着（用户看到的就是一条蓝底时间）。日历那边一直是靠
    // `body[data-calendar-dragging]` 挡住的，时间轴重写后这层丢了。
    document.body.dataset.availabilityDragging = "true";
    window.getSelection()?.removeAllRanges();
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      delete document.body.dataset.availabilityDragging;
      // 收尾再清一次：拖动过程中若已生成选区，松手不该把它留在界面上。
      window.getSelection()?.removeAllRanges();
      setTag(null); setLiveDrag(null);
      // click 紧跟 pointerup 同步派发；放到下一个任务里再解锁，刚好吞掉这一次。
      window.setTimeout(() => { suppressClick.current = false; }, 0);
    };
    teardownDragRef.current = finish;
    /** 中止拖动：只撤预览、不写库（pointercancel 与卸载走这里）。 */
    const cancel = () => finish();
    const move = (next: PointerEvent) => {
      const live = compute(next.clientY);
      setLiveDrag({ kind: "block", weekday: block.weekday, fromStart: block.start, fromEnd: block.end, start: live.start, end: live.end });
      setTag({ text: clock(live.start) + "–" + clock(live.end) + " · " + availabilityBandHours(live.end - live.start) + " 小时", x: next.clientX, y: next.clientY });
    };
    const up = (next: PointerEvent) => {
      const live = compute(next.clientY);
      if (live.start === visibleStart && live.end === visibleEnd) {
        finish();
        setSelected({ kind: "slot", weekday: block.weekday, start: block.start, end: block.end });
        return;
      }
      finish();
      onSlotsChange(replaceAvailability(
        slots, block.weekday,
        { start: block.start, end: block.end },
        { start: availabilitySlotClock(live.start), end: availabilitySlotClock(live.end) },
        { start: seg.start, end: seg.end },
        () => crypto.randomUUID(),
      ));
      setSelected({ kind: "slot", weekday: block.weekday, start: availabilitySlotClock(live.start), end: availabilitySlotClock(live.end) });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
  };

  /** 灰带拖动：拖上／下沿改范围（最短 30 分钟），拖中部整段平移（时长不变）。 */
  const beginFoldDrag = (seg: AvailabilitySegment, mode: "start" | "end" | "move") => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    resetDrag();
    event.preventDefault(); event.stopPropagation();
    suppressClick.current = true;
    setHover(null);
    const origin = { start: seg.start, end: seg.end };
    const y0 = event.clientY;
    // 灰带高度固定，不能拿它除时长：按「每小时多少像素」换算灵敏度，再按吸附取整。
    const perPx = 60 / Math.max(1, hourPx);
    const compute = (clientY: number) => {
      const raw = (clientY - y0) * perPx;
      const delta = Math.round(raw / foldStep) * foldStep;
      if (mode === "move") {
        const length = origin.end - origin.start;
        const start = Math.max(0, Math.min(1440 - length, origin.start + delta));
        return { start, end: start + length };
      }
      if (mode === "start") return { start: Math.max(0, Math.min(origin.end - FOLDED_RANGE_MIN_MINUTES, origin.start + delta)), end: origin.end };
      return { start: origin.start, end: Math.max(origin.start + FOLDED_RANGE_MIN_MINUTES, Math.min(1440, origin.end + delta)) };
    };
    setLiveDrag({ kind: "fold", fromStart: origin.start, fromEnd: origin.end, start: origin.start, end: origin.end });
    document.body.dataset.availabilityDragging = "true";
    window.getSelection()?.removeAllRanges();
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      delete document.body.dataset.availabilityDragging;
      window.getSelection()?.removeAllRanges();
      setTag(null); setLiveDrag(null);
      window.setTimeout(() => { suppressClick.current = false; }, 0);
    };
    teardownDragRef.current = finish;
    /** 与块拖动同理。 */
    const cancel = () => finish();
    const move = (next: PointerEvent) => {
      const live = compute(next.clientY);
      setLiveDrag({ kind: "fold", fromStart: origin.start, fromEnd: origin.end, start: live.start, end: live.end });
      setTag({ text: clock(live.start) + "–" + clock(live.end) + " · 折叠", x: next.clientX, y: next.clientY });
    };
    const up = (next: PointerEvent) => {
      const live = compute(next.clientY);
      if (live.start === origin.start && live.end === origin.end) {
        finish();
        setSelected({ kind: "fold", start: clock(origin.start), end: clock(origin.end) });
        return;
      }
      finish();
      const rest = folds.filter((range) => !(timeMinutes(range.start) === origin.start && foldedMinute(range.end) === origin.end));
      onFoldsChange(normalizeFoldedRanges([...rest, { start: clock(live.start), end: clock(live.end) }]));
      setSelected({ kind: "fold", start: clock(live.start), end: clock(live.end) });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
  };

  const trackMove = (index: number, seg: AvailabilitySegment, weekday: number) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (suppressClick.current) return;
    // 压在块上：这一小时已经占用了，收起「＋」。压在「＋」自己身上：什么都不做 ——
    // 清掉 hover 会把正要点的按钮从指针底下撤走（设计稿同样直接 return）。
    if ((event.target as HTMLElement).closest(".availability-slot")) { setHover(null); return; }
    if ((event.target as HTMLElement).closest(".availability-hover-add")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.height < 1) return;
    // 指针已经出了轨道（胶囊探出去的那几像素）就不再按轨道比例算时间。
    if (event.clientY < rect.top || event.clientY > rect.bottom) { setHover(null); return; }
    const minute = minuteIn(seg, rect, event.clientY);
    const floor = Math.floor(minute / 60) * 60;
    const start = Math.max(seg.start, Math.min(floor, Math.max(seg.start, seg.end - AVAILABILITY_ADD_MINUTES)));
    if (seg.end - start < AVAILABILITY_MIN_MINUTES) { setHover(null); return; }
    if (hover && hover.seg === index && hover.weekday === weekday && hover.start === start) return;
    setHover({ seg: index, weekday, start });
  };

  /** 键盘：聚焦某一列按 Enter / 空格 = 加 09:00–10:00（与设计稿的键盘路径一致）。 */
  const trackKeyDown = (seg: AvailabilitySegment, weekday: number) => (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if ((event.target as HTMLElement).closest(".availability-slot")) return;
    event.preventDefault();
    const start = Math.max(seg.start, Math.min(9 * 60, Math.max(seg.start, seg.end - AVAILABILITY_ADD_MINUTES)));
    addSlot(weekday, start, Math.min(seg.end, start + AVAILABILITY_ADD_MINUTES));
  };

  const allFolded = segments.every((seg) => seg.collapsed);
  return <div className="availability-designer">
    <div className="availability-timeline" style={{ "--ah": availabilityHourRemFor(zoomPercent) + "rem" } as CSSProperties}>
      <div className="availability-corner" style={{ gridRow: 1, gridColumn: 1 }}><span>时间</span></div>
      {AVAILABILITY_WEEK_ORDER.map((weekday, index) => {
        const minutes = availabilityDayMinutes(slots, weekday);
        return <div key={weekday} className={minutes > 0 ? "availability-day-head" : "availability-day-head is-empty"} style={{ gridRow: 1, gridColumn: index + 2 }}>
          <b>{AVAILABILITY_DAY_NAMES[weekday]}</b>
          <small>{availabilityHours(minutes)}{minutes > 0 ? "" : " · 待补"}</small>
        </div>;
      })}
      {segments.map((seg, index) => {
        const row = index + 2;
        const height = seg.collapsed ? "var(--availability-band)" : `calc(var(--ah) * ${(seg.end - seg.start) / 60})`;
        if (seg.collapsed) {
          // 拖灰带时 liveFolds 已经把这一段的边界换成实时值，所以 seg 自身就是预览几何；
          // 只需要认出「被拖的是哪一条」来加 is-dragging（按实时范围匹配，原段已经不在了）。
          const startLabel = clock(seg.start);
          const endLabel = clock(seg.end);
          const isDragging = liveDrag?.kind === "fold" && clock(liveDrag.start) === startLabel && clock(liveDrag.end) === endLabel;
          const isSelected = selected?.kind === "fold" && selected.start === startLabel && selected.end === endLabel;
          const hiddenBlocks = blocks.filter((block) => timeMinutes(block.start) < seg.end && (timeMinutes(block.end) === 0 ? 1440 : timeMinutes(block.end)) > seg.start).length;
          return <Fragment key={"fold-" + seg.start + "-" + seg.end}>
            <div className="availability-gutter is-fold" style={{ gridRow: row, gridColumn: 1, height }} />
            <div className={["availability-band", isSelected ? "is-selected" : "", isDragging ? "is-dragging" : ""].filter(Boolean).join(" ")} data-seg={index} role="group" tabIndex={0} aria-selected={isSelected}
              aria-label={"已折叠 " + startLabel + "–" + endLabel + "，共 " + availabilityBandHours(seg.end - seg.start) + " 小时"}
              title="拖上／下沿改范围，拖中部整段平移，× 展开"
              style={{ gridRow: row, gridColumn: "2 / -1", height }}
              onPointerDown={(event) => {
                if ((event.target as HTMLElement).closest(".availability-band-x")) return;
                const edge = (event.target as HTMLElement).closest("[data-edge]")?.getAttribute("data-edge");
                beginFoldDrag(seg, edge === "start" ? "start" : edge === "end" ? "end" : "move")(event);
              }}>
              <span className="availability-band-edge is-top" data-edge="start" aria-hidden="true" />
              <span className="availability-band-body">
                <b>{startLabel}–{endLabel}</b>
                <span className="availability-band-note">{availabilityBandHours(seg.end - seg.start)} 小时已折叠</span>
                {hiddenBlocks > 0 && <span className="availability-band-extra">含 {hiddenBlocks} 段空闲</span>}
              </span>
              <button type="button" className="availability-band-x" aria-label={"展开 " + startLabel + "–" + endLabel + "（取消折叠）"} title="展开这一段"
                onClick={(event) => { event.stopPropagation(); unfold(seg.start, seg.end); }}>
                <X size={12} aria-hidden="true" />
              </button>
              <span className="availability-band-edge is-bottom" data-edge="end" aria-hidden="true" />
            </div>
          </Fragment>;
        }
        const marks: number[] = [];
        for (let minute = Math.ceil(seg.start / 60) * 60; minute < seg.end; minute += 60) marks.push(minute);
        if (!marks.length || marks[0] !== seg.start) marks.unshift(seg.start);
        const foldButtons: Array<{ at: number; end: number }> = [];
        for (let at = Math.ceil(seg.start / 60) * 60; at < seg.end; at += 60) {
          if (seg.end - at < FOLDED_RANGE_MIN_MINUTES) continue;
          foldButtons.push({ at, end: Math.min(at + AVAILABILITY_ADD_MINUTES, seg.end) });
        }
        return <Fragment key={"seg-" + seg.start + "-" + seg.end}>
          <div className="availability-gutter" style={{ gridRow: row, gridColumn: 1, height }}>
            {marks.map((minute) => <span key={minute}
              className={"availability-gutter-label" + (minute === seg.start ? " is-first" : "") + (minute % 180 === 0 ? " is-major" : "")}
              style={minute === seg.start ? undefined : { top: `calc(var(--ah) * ${(minute - seg.start) / 60})`, transform: "translateY(-50%)" }}>
              {clock(minute)}
            </span>)}
            {foldButtons.map((fold) => <button key={fold.at} type="button" className="availability-fold-add"
              style={{ top: `calc(var(--ah) * ${(fold.at - seg.start) / 60})`, height: `calc(var(--ah) * ${(fold.end - fold.at) / 60})` }}
              aria-label={"在 " + clock(fold.at) + " 折叠 1 小时（" + clock(fold.at) + "–" + clock(fold.end) + "）"}
              title={clock(fold.at) + "–" + clock(fold.end) + " 折叠"}
              onClick={() => onFoldsChange(addFold(folds, clock(fold.at), clock(fold.end)))}>折叠</button>)}
          </div>
          {AVAILABILITY_WEEK_ORDER.map((weekday, column) => {
            const dayBlocks = blocks.filter((block) => block.weekday === weekday);
            const hoverHere = hover && hover.seg === index && hover.weekday === weekday ? hover : null;
            return <div key={weekday} className="availability-track" data-seg={index} data-day={weekday} role="group" tabIndex={0}
              aria-label={"周" + AVAILABILITY_DAY_NAMES[weekday] + " 可用时间"} style={{ gridRow: row, gridColumn: column + 2, height }}
              onPointerMove={trackMove(index, seg, weekday)} onPointerLeave={() => setHover(null)}
              onKeyDown={trackKeyDown(seg, weekday)}>
              {marks.map((minute) => <span key={minute} aria-hidden="true"
                className={minute % 180 === 0 ? "availability-hour-line is-major" : "availability-hour-line"}
                style={{ top: `calc(var(--ah) * ${(minute - seg.start) / 60})` }} />)}
              {dayBlocks.map((block) => {
                const blockEnd = timeMinutes(block.end) === 0 ? 1440 : timeMinutes(block.end);
                // 拖拽中：这一块用自己的实时几何画，而不是等松手落库后再重绘。
                const live = liveDrag?.kind === "block" && liveDrag.weekday === weekday && liveDrag.fromStart === block.start && liveDrag.fromEnd === block.end ? liveDrag : null;
                const shownStart = live ? live.start : timeMinutes(block.start);
                const shownEnd = live ? live.end : blockEnd;
                const start = Math.max(shownStart, seg.start);
                const end = Math.min(shownEnd, seg.end);
                if (end <= start) return null;
                const px = ((end - start) / 60) * hourPx;
                const isSelected = selected?.kind === "slot" && selected.weekday === weekday && selected.start === block.start && selected.end === block.end;
                const classes = ["availability-slot", px < AVAILABILITY_TINY_PX ? "is-tiny" : px >= AVAILABILITY_TALL_PX ? "is-tall" : "", isSelected ? "is-selected" : "", live ? "is-dragging" : ""].filter(Boolean).join(" ");
                const label = "周" + AVAILABILITY_DAY_NAMES[weekday] + " " + clock(shownStart) + "–" + clock(shownEnd) + " 空闲";
                return <div key={block.slotId + "-" + weekday} className={classes} role="group" tabIndex={0} aria-selected={isSelected}
                  aria-label={label} title={label} data-day={weekday} data-start={block.start} data-end={block.end} data-seg={index}
                  style={{ top: `calc(var(--ah) * ${(start - seg.start) / 60})`, height: `calc(var(--ah) * ${(end - start) / 60})` }}
                  onPointerDown={(event) => { if (!(event.target as HTMLElement).closest("button")) beginBlockDrag(block, seg, "move")(event); }}
                  onClick={(event) => { event.stopPropagation(); if (suppressClick.current) return; setSelected({ kind: "slot", weekday, start: block.start, end: block.end }); }}
                  onKeyDown={(event) => {
                    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); event.stopPropagation(); removeSlot(weekday, block.start, block.end); return; }
                    if (event.key === " ") { event.preventDefault(); setSelected({ kind: "slot", weekday, start: block.start, end: block.end }); return; }
                    // 气泡撤掉后，起止改在画布上直接做（UI-SPEC §54 的键盘替代路径）：
                    // ↑／↓ 整段平移，Shift 改结束，Alt 改开始；步长沿用吸附设置。
                    const step = snap === 0 ? 5 : snap;
                    const delta = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
                    if (!delta) return;
                    event.preventDefault(); event.stopPropagation();
                    const from = start;
                    const to = end;
                    const length = to - from;
                    let nextStart = from;
                    let nextEnd = to;
                    if (event.altKey) nextStart = Math.max(0, Math.min(to - AVAILABILITY_MIN_MINUTES, from + delta));
                    else if (event.shiftKey) nextEnd = Math.min(1440, Math.max(from + AVAILABILITY_MIN_MINUTES, to + delta));
                    else { nextStart = Math.max(0, Math.min(1440 - length, from + delta)); nextEnd = nextStart + length; }
                    if (nextStart === from && nextEnd === to) return;
                    onSlotsChange(mergeAvailability(replaceAvailability(
                      slots, weekday,
                      { start: block.start, end: block.end },
                      { start: availabilitySlotClock(nextStart), end: availabilitySlotClock(nextEnd) },
                      { start: seg.start, end: seg.end },
                      () => crypto.randomUUID(),
                    )));
                    setSelected({ kind: "slot", weekday, start: availabilitySlotClock(nextStart), end: availabilitySlotClock(nextEnd) });
                  }}>
                  <button type="button" className="availability-slot-handle is-top" tabIndex={-1} aria-label={"调整 " + block.start + " 开始时间"}
                    onPointerDown={beginBlockDrag(block, seg, "top")} onClick={(event) => event.stopPropagation()} />
                  <span className="availability-slot-time"><b>{clock(shownStart)}</b><i aria-hidden="true">–</i><b>{clock(shownEnd)}</b></span>
                  <button type="button" className="availability-slot-delete" aria-label={"删除 周" + AVAILABILITY_DAY_NAMES[weekday] + " " + block.start + "–" + block.end} title="删除这一段"
                    onClick={(event) => { event.stopPropagation(); removeSlot(weekday, block.start, block.end); }}>
                    <X size={12} aria-hidden="true" />
                  </button>
                  <button type="button" className="availability-slot-handle is-bottom" tabIndex={-1} aria-label={"调整 " + block.end + " 结束时间"}
                    onPointerDown={beginBlockDrag(block, seg, "bottom")} onClick={(event) => event.stopPropagation()} />
                </div>;
              })}
              {hoverHere && (() => {
                const end = Math.min(seg.end, hoverHere.start + AVAILABILITY_ADD_MINUTES);
                return <span className="availability-hover-frame"
                  style={{ top: `calc(var(--ah) * ${(hoverHere.start - seg.start) / 60})`, height: `calc(var(--ah) * ${(end - hoverHere.start) / 60})` }}>
                  <button type="button" className="availability-hover-add"
                    aria-label={"在周" + AVAILABILITY_DAY_NAMES[weekday] + " " + clock(hoverHere.start) + " 添加 1 小时空闲"} title="添加 1 小时空闲"
                    onClick={(event) => { event.stopPropagation(); addSlot(weekday, hoverHere.start, end); setHover(null); }}>
                    <span className="availability-hover-chip"><Plus size={10} aria-hidden="true" />{clock(hoverHere.start)}</span>
                  </button>
                </span>;
              })()}
            </div>;
          })}
        </Fragment>;
      })}
    </div>
    {allFolded && <p className="availability-all-folded">全部时间都已折叠。点任意灰带右侧的 × 展开一段，或
      <Button variant="quiet" onClick={() => onFoldsChange(DEFAULT_FOLDED_RANGES.map((range) => ({ ...range })))}>恢复默认折叠</Button>
    </p>}
    {tag && <span className="availability-drag-tag" role="status" style={{ left: tag.x + 14, top: tag.y - 32 }}>{tag.text}</span>}
  </div>;
}

/**
 * 「可用时间」弹窗的外壳：标题 + `?` 操作说明 + `⋯` 更多操作 + 时间轴 + 页脚。
 *
 * 草稿只活在这里：`完成` 才把 `defaultTimeSlots` 与 `foldedRanges` 一起交给设置仓库；
 * `取消`／Esc 丢掉草稿。写入失败时保留草稿、弹窗不关、给可重试的错误 —— 不伪装成已保存。
 * 缩放滑杆是**本次查看**状态：只改每小时像素，不写设置、不改吸附、不改折叠带高度。
 */
function AvailabilityDialog({ slots, folds, snapMinutes, onCancel, onCommit }: {
  slots: DefaultTimeSlot[];
  folds: FoldedRange[];
  snapMinutes: AppSettings["snapMinutes"];
  onCancel: () => void;
  onCommit: (next: { defaultTimeSlots: DefaultTimeSlot[]; foldedRanges: FoldedRange[] }) => Promise<void>;
}) {
  const [draftSlots, setDraftSlots] = useState(slots);
  const [draftFolds, setDraftFolds] = useState(folds);
  const [zoomPercent, setZoomPercent] = useState(AVAILABILITY_ZOOM_DEFAULT);
  const [history, setHistory] = useState<Array<{ slots: DefaultTimeSlot[]; folds: FoldedRange[] }>>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hintOpen, setHintOpen] = useState(false);
  const [hintPinned, setHintPinned] = useState(false);
  const hintTimer = useRef<number | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [bulkStart, setBulkStart] = useState("09:00");
  const [bulkEnd, setBulkEnd] = useState("11:00");
  const [bulkDays, setBulkDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const toolsRef = useRef<HTMLSpanElement | null>(null);
  const addToggleRef = useRef<HTMLButtonElement | null>(null);
  const clearToggleRef = useRef<HTMLButtonElement | null>(null);
  const helpRef = useRef<HTMLButtonElement | null>(null);

  /** 每次改动先压一份历史：撤销只回退草稿，不写库。 */
  const record = () => setHistory((current) => [...current, { slots: draftSlots, folds: draftFolds }].slice(-60));
  const commitSlots = (next: DefaultTimeSlot[]) => { record(); setDraftSlots(next); setStatus(""); setError(null); };
  const commitFolds = (next: FoldedRange[]) => { record(); setDraftFolds(next); setStatus(""); setError(null); };
  const undo = () => setHistory((current) => {
    const previous = current.at(-1);
    if (!previous) return current;
    setDraftSlots(previous.slots); setDraftFolds(previous.folds); setStatus(""); setError(null);
    return current.slice(0, -1);
  });

  const setHint = (open: boolean) => { setHintOpen(open); if (!open) setHintPinned(false); };
  const closeMenus = () => { setHint(false); setBulkOpen(false); setClearOpen(false); };

  // 指针离开后留 260ms：从「?」滑到气泡里不会闪一下又消失。钉住时永不自动收起。
  const hintEnter = () => { if (hintTimer.current) window.clearTimeout(hintTimer.current); setHintOpen(true); };
  const hintLeave = () => {
    if (hintPinned) return;
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => { if (!hintPinned) setHintOpen(false); }, 260);
  };
  useEffect(() => () => { if (hintTimer.current) window.clearTimeout(hintTimer.current); }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".availability-tools")) return;
      setHint(false); setBulkOpen(false); setClearOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  // 说明气泡、添加面板与清空确认的 Esc 必须在浮动层宿主之前处理（宿主在 document 上的捕获监听会先关整个弹窗）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if ((event.target as HTMLElement | null)?.closest(".floating-panel")) return;
      if (clearOpen) { event.preventDefault(); event.stopPropagation(); setClearOpen(false); return; }
      if (bulkOpen) { event.preventDefault(); event.stopPropagation(); setBulkOpen(false); return; }
      if (hintOpen) { event.preventDefault(); event.stopPropagation(); setHint(false); }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [clearOpen, bulkOpen, hintOpen]);

  const total = availabilityWeekMinutes(draftSlots);
  const average = Math.round((total / 7 / 6)) / 10;
  const applyBulk = () => {
    if (timeMinutes(bulkEnd) <= timeMinutes(bulkStart) || !bulkDays.length) return;
    let next = draftSlots;
    for (const weekday of bulkDays) next = addAvailability(next, weekday, bulkStart, bulkEnd, () => crypto.randomUUID());
    commitSlots(mergeAvailability(next));
    setBulkOpen(false);
  };
  const clearAll = () => { record(); setDraftSlots([]); setClearOpen(false); setStatus(""); setError(null); };

  const done = async () => {
    setBusy(true); setError(null);
    try {
      await onCommit({ defaultTimeSlots: draftSlots, foldedRanges: draftFolds });
      setStatus("已保存");
    } catch (failure) {
      // 写不进去就明说：草稿还在、弹窗还开着，用户可以直接重试。
      setStatus("");
      setError("保存失败：" + readError(failure));
    } finally {
      setBusy(false);
    }
  };

  return <ConfirmDialog id="availability-dialog" labelledBy="availability-title" busy={busy} className="availability-modal"
    onClose={() => { if (!busy) onCancel(); }}>
    <div className="availability-modal-head">
      <h2 id="availability-title">可用时间</h2>
      <span className="availability-tools" ref={toolsRef}>
        <span className="availability-help-wrap" onPointerEnter={hintEnter} onPointerLeave={hintLeave}>
          <button ref={helpRef} type="button" className="availability-icon-button availability-help" aria-expanded={hintOpen} aria-haspopup="dialog"
            aria-controls="availability-hint" title="操作说明" aria-label="操作说明"
            onClick={(event) => { event.stopPropagation(); const next = !hintPinned; setHintPinned(next); setHintOpen(next); }}>?</button>
          {hintOpen && <div id="availability-hint" className="availability-hint" role="dialog" aria-modal="false" aria-labelledby="availability-hint-title"
            onPointerDown={(event) => event.stopPropagation()}>
            <h3 id="availability-hint-title">操作说明</h3>
            {AVAILABILITY_HINT_GROUPS.map((group) => <div key={group.title} className="availability-hint-group">
              <h4>{group.title}</h4>
              <ul>{group.items.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>)}
          </div>}
        </span>
        <span className="availability-tools-end">
          {/* 2026-11-08：⋯ 菜单撤掉，原来藏在里面的两件事直接做成右上角图标 ——
              添加（同时用于精确录入与批量套用）与清空。「恢复默认数据」不再保留。 */}
          <button ref={addToggleRef} type="button" className="availability-icon-button availability-add-toggle" aria-expanded={bulkOpen} aria-haspopup="dialog"
            aria-controls="availability-bulk" title="精确添加空闲时间" aria-label="精确添加空闲时间"
            onClick={(event) => { event.stopPropagation(); setBulkOpen(!bulkOpen); setHint(false); setClearOpen(false); }}>
            <Plus size={16} aria-hidden="true" />
          </button>
          <button ref={clearToggleRef} type="button" className="availability-icon-button availability-clear-toggle" aria-expanded={clearOpen} aria-haspopup="dialog"
            aria-controls="availability-clear" title="清空本周空闲时间" aria-label="清空本周空闲时间" disabled={!draftSlots.length}
            onClick={(event) => { event.stopPropagation(); setClearOpen(!clearOpen); setHint(false); setBulkOpen(false); }}>
            <Eraser size={15} aria-hidden="true" />
          </button>
          {bulkOpen && <div id="availability-bulk" className="availability-bulk" role="dialog" aria-modal="false" aria-labelledby="availability-bulk-title" onPointerDown={(event) => event.stopPropagation()}>
            <h3 id="availability-bulk-title">精确添加</h3>
            <div className="availability-bulk-time">
              <TimeField label="批量开始时间" value={bulkStart} onChange={setBulkStart} />
              <span aria-hidden="true">至</span>
              <TimeField label="批量结束时间" value={bulkEnd} onChange={setBulkEnd} />
            </div>
            <WeekdayPicker value={bulkDays} onChange={setBulkDays} />
            <div className="availability-bulk-actions">
              <Button variant="quiet" onClick={() => { setBulkOpen(false); addToggleRef.current?.focus(); }}>取消</Button>
              <Button variant="primary" disabled={!bulkDays.length || timeMinutes(bulkEnd) <= timeMinutes(bulkStart)} onClick={applyBulk}>应用到 {bulkDays.length} 天</Button>
            </div>
          </div>}
          {clearOpen && <div id="availability-clear" className="availability-confirm" role="dialog" aria-modal="false" aria-labelledby="availability-clear-title" onPointerDown={(event) => event.stopPropagation()}>
            <h3 id="availability-clear-title">清空本周空闲时间？</h3>
            <p>会移除全部 <b>{draftSlots.length}</b> 段空闲，清空后可以用「撤销上一步」恢复。</p>
            <div className="availability-bulk-actions">
              <Button variant="quiet" onClick={() => { setClearOpen(false); clearToggleRef.current?.focus(); }}>取消</Button>
              <Button variant="danger" onClick={clearAll}>清空</Button>
            </div>
          </div>}
        </span>
      </span>
    </div>
    <div className="availability-board">
      <AvailabilityDesigner slots={draftSlots} folds={draftFolds} snapMinutes={snapMinutes} zoomPercent={zoomPercent}
        onSlotsChange={commitSlots} onFoldsChange={commitFolds} />
    </div>
    <div className="availability-foot">
      {/* 用 role="group" 而不是 <label>：`.modal label` 是 `display: grid`，会把图标／滑杆／读数
          竖排成三行（读数因此掉到框外第二行）。RangeBar 自己带可访问名，不需要外层 label。 */}
      <span className="availability-zoom" role="group" aria-label="时间轴缩放">
        <RangeBar label="时间轴缩放比例" compact min={AVAILABILITY_ZOOM_RANGE[0]} max={AVAILABILITY_ZOOM_RANGE[1]} step={5}
          value={zoomPercent} onChange={setZoomPercent} formatValue={(value) => value + "%"} />
        <output className="availability-zoom-value">{zoomPercent}%</output>
      </span>
      <span className="availability-stat">本周 <b>{availabilityHours(total)}</b> · 平均 <b>{average}h/天</b></span>
      <span className="availability-status" aria-live="polite">{status}</span>
      <span className="availability-foot-gap" aria-hidden="true" />
      <Button variant="quiet" disabled={!history.length || busy} onClick={undo}>撤销上一步</Button>
      <Button disabled={busy} onClick={onCancel}>取消</Button>
      <Button variant="primary" disabled={busy} onClick={() => void done()}>{busy ? "正在保存…" : "完成"}</Button>
    </div>
    {error && <p className="error-message" role="alert"><CircleAlert aria-hidden="true" />{error}
      <Button variant="secondary" disabled={busy} onClick={() => void done()}>重试保存</Button></p>}
  </ConfirmDialog>;
}


function SettingsPage({ preferences, onChange, onSaveAvailability, native }: { preferences: AppSettings; onChange: (patch: Partial<AppSettings>) => void; onSaveAvailability: (next: { defaultTimeSlots: DefaultTimeSlot[]; foldedRanges: FoldedRange[] }) => Promise<void>; native: NativeApi }) {
  const slots = preferences.defaultTimeSlots;
  // 开机自启动是**系统状态**（Windows 注册表），不写进 AppSettings：用户可能在任务管理器里
  // 改过它，界面必须以系统为准，而不是以一份可能过期的偏好镜像为准。
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartError, setAutostartError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    native.isAutostartEnabled()
      .then((enabled) => { if (!cancelled) setAutostart(enabled); })
      .catch(() => { if (!cancelled) setAutostartError("无法读取系统里的开机自启动状态。"); });
    return () => { cancelled = true; };
  }, [native]);
  const toggleAutostart = async (enabled: boolean) => {
    setAutostartBusy(true);
    setAutostartError(null);
    try {
      await native.setAutostartEnabled(enabled);
      setAutostart(enabled);
    } catch {
      setAutostartError(enabled ? "开启开机自启动失败，请检查系统权限后重试。" : "关闭开机自启动失败，请重试。");
    } finally {
      setAutostartBusy(false);
    }
  };
  /** 「可用时间」是二级弹窗：设置页只留一个入口，草稿与保存都在弹窗里。 */
  const [availabilityOpen, setAvailabilityOpen] = useState(false);
  // 单项重置只比较值本身；数组项没有稳定标识，用「是否为空」判断（默认值就是空数组）。
  const changed = (key: Exclude<keyof AppSettings, "defaultTimeSlots">) => preferences[key] !== DEFAULT_SETTINGS[key];
  return <section className="page-stack settings-page narrow-page">
    <PageHeader eyebrow="按你的习惯调整" title="设置" />
    <SettingsSection icon={<Palette />} title="外观与无障碍">
      <SettingsRow label="主题" note="跟随系统会随 Windows 的深浅色设置切换。" modified={changed("appearance")} onReset={() => onChange({ appearance: DEFAULT_SETTINGS.appearance })}>
        <SettingsChoice label="主题" name="appearance" value={preferences.appearance} onChange={(appearance) => onChange({ appearance })} options={APPEARANCE_OPTIONS} />
      </SettingsRow>
      <SettingsRow label="动态效果" note="减少动态时仍保留文字与图标的状态反馈。" modified={changed("motion")} onReset={() => onChange({ motion: DEFAULT_SETTINGS.motion })}>
        <SettingsChoice label="动态效果" name="motion" value={preferences.motion} onChange={(motion) => onChange({ motion })} options={MOTION_OPTIONS} />
      </SettingsRow>
      <SettingsRow label="界面缩放" note="只影响界面密度，不改变日历时间轴的纵向比例。" htmlFor="settings-scale" modified={changed("scale")} onReset={() => onChange({ scale: DEFAULT_SETTINGS.scale })}>
        <RangeBar id="settings-scale" label="界面缩放" min={100} max={200} step={25} value={preferences.scale} formatValue={(value) => `${value}%`} dots={[0.25, 0.5, 0.75]} commitOnRelease onChange={(scale) => onChange({ scale })} />
        <strong className="settings-value">{preferences.scale}%</strong>
      </SettingsRow>
      <SettingsToggleRow label="在日历工具栏显示实际记录开关" note="隐藏入口不会删除实际记录，也不会改变已保存的叠加状态。" checked={preferences.showActualRecordsControl} modified={changed("showActualRecordsControl")} onReset={() => onChange({ showActualRecordsControl: DEFAULT_SETTINGS.showActualRecordsControl })} onChange={(checked) => onChange({ showActualRecordsControl: checked })} />
    </SettingsSection>
    <SettingsSection icon={<Bell />} title="提醒与行动">
      <SettingsToggleRow label="记录开始／结束本次" note="默认关闭；只有主动开始才形成实际执行记录。" checked={preferences.checkInEnabled} modified={changed("checkInEnabled")} onReset={() => onChange({ checkInEnabled: DEFAULT_SETTINGS.checkInEnabled })} onChange={(checked) => onChange({ checkInEnabled: checked })} />
      <SettingsRow label="开始宽限期" note="超过这个时间仍未开始时，记为错过。" htmlFor="settings-grace" dependent muted={!preferences.checkInEnabled} modified={changed("checkInGraceMinutes")} onReset={() => onChange({ checkInGraceMinutes: DEFAULT_SETTINGS.checkInGraceMinutes })}>
        <NumberField id="settings-grace" label="开始宽限期" suffix="分钟" min={CHECK_IN_GRACE_MIN} max={CHECK_IN_GRACE_MAX} step={1} presets={CHECK_IN_GRACE_MINUTES_PRESETS} disabled={!preferences.checkInEnabled} value={preferences.checkInGraceMinutes} onChange={(value) => { if (value !== null) onChange({ checkInGraceMinutes: value }); }} />
      </SettingsRow>
      <SettingsToggleRow label="错过后显示挽救提示" note={preferences.checkInEnabled ? "只出现一次，提供开始、延后、改期和跳过。" : "开启开始／结束记录后生效，当前保留你的偏好。"} checked={preferences.rescuePromptsEnabled} dependent muted={!preferences.checkInEnabled} modified={changed("rescuePromptsEnabled")} onReset={() => onChange({ rescuePromptsEnabled: DEFAULT_SETTINGS.rescuePromptsEnabled })} onChange={(checked) => onChange({ rescuePromptsEnabled: checked })} />
      <SettingsToggleRow label="完成后询问记录" note="关闭后完成任务不再弹出记录气泡；仍可在「今日完成」和回顾明细里补写。" checked={preferences.completionRecordPrompt} modified={changed("completionRecordPrompt")} onReset={() => onChange({ completionRecordPrompt: DEFAULT_SETTINGS.completionRecordPrompt })} onChange={(checked) => onChange({ completionRecordPrompt: checked })} />
      <SettingsToggleRow label="执行提醒" note="提醒只定位到任务，不会自动开始。" checked={preferences.remindersEnabled} modified={changed("remindersEnabled")} onReset={() => onChange({ remindersEnabled: DEFAULT_SETTINGS.remindersEnabled })} onChange={(checked) => onChange({ remindersEnabled: checked })} />
      <SettingsRow label="提前分钟数" note="在执行时段开始前多久发出提醒。" htmlFor="settings-lead" dependent muted={!preferences.remindersEnabled} modified={changed("reminderLeadMinutes")} onReset={() => onChange({ reminderLeadMinutes: DEFAULT_SETTINGS.reminderLeadMinutes })}>
        <NumberField id="settings-lead" label="提前分钟数" suffix="分钟" min={0} max={120} step={5} disabled={!preferences.remindersEnabled} value={preferences.reminderLeadMinutes} onChange={(value) => { if (value !== null) onChange({ reminderLeadMinutes: value }); }} />
      </SettingsRow>
      <SettingsToggleRow label="开机自启动" note={autostart === null ? "正在读取系统设置…" : "登录 Windows 后自动启动 Daymark，并留在托盘，不主动弹出主窗口。"}
        checked={autostart === true} disabled={autostart === null || autostartBusy} modified={autostart === true}
        onReset={autostart === true && !autostartBusy ? () => void toggleAutostart(false) : undefined}
        onChange={(enabled) => void toggleAutostart(enabled)} />
      {autostartError && <p className="error-message" role="alert"><CircleAlert aria-hidden="true" />{autostartError}</p>}
      <SettingsRow label="启动摘要" note="应用启动后汇总临近与逾期任务。" htmlFor="settings-startup" modified={changed("startupSummary")} onReset={() => onChange({ startupSummary: DEFAULT_SETTINGS.startupSummary })}>
        <SelectField id="settings-startup" value={preferences.startupSummary} onChange={(value) => onChange({ startupSummary: value as AppSettings["startupSummary"] })} options={[{ value: "never", label: "从不提醒" }, { value: "daily", label: "每天首次启动" }, { value: "everyLaunch", label: "每次启动" }]} />
      </SettingsRow>
    </SettingsSection>
    <SettingsSection icon={<Clock3 />} title="时间与排程">
      <SettingsRow label="日视图默认显示" note="选择「可用时间」时，其他时间会折叠起来。" modified={changed("calendarDayMode")} onReset={() => onChange({ calendarDayMode: DEFAULT_SETTINGS.calendarDayMode })}>
        <SettingsChoice label="日视图默认显示" name="calendar-day-mode" value={preferences.calendarDayMode} onChange={(calendarDayMode) => onChange({ calendarDayMode })} options={[{ value: "defaultSlots", label: "可用时间" }, { value: "fullDay", label: "全天" }]} />
      </SettingsRow>
      <SettingsRow label="可用时间" note="自动排程只在这些窗口里安排；点「编辑」在时间轴上标出空闲段与折叠范围。">
        <Button variant="secondary" onClick={() => setAvailabilityOpen(true)}><CalendarDays size={16} />编辑</Button>
      </SettingsRow>
      {availabilityOpen && <AvailabilityDialog
        slots={slots}
        folds={preferences.foldedRanges}
        snapMinutes={preferences.snapMinutes}
        onCancel={() => setAvailabilityOpen(false)}
        onCommit={async (next) => {
          // 两个字段一起提交：写失败时弹窗自己展示可重试的错误，草稿留在原地、弹窗不关。
          await onSaveAvailability(next);
          setAvailabilityOpen(false);
        }} />}
      <SettingsRow label="全局单次投入" note="新建任务时的默认单次投入时长。" htmlFor="settings-session" modified={changed("defaultSessionMinutes")} onReset={() => onChange({ defaultSessionMinutes: DEFAULT_SETTINGS.defaultSessionMinutes })}>
        <NumberField id="settings-session" label="全局单次投入" suffix="分钟" min={5} max={240} step={5} value={preferences.defaultSessionMinutes} onChange={(value) => { if (value !== null) onChange({ defaultSessionMinutes: value }); }} />
      </SettingsRow>
      <SettingsRow label="最低有效时长" note="短于该阈值的空档不用于自动排程，仍可手动放置。" htmlFor="settings-minimum" modified={changed("minimumSessionMinutes")} onReset={() => onChange({ minimumSessionMinutes: DEFAULT_SETTINGS.minimumSessionMinutes })}>
        <NumberField id="settings-minimum" label="最低有效时长" suffix="分钟" min={MINIMUM_SESSION_MIN} max={MINIMUM_SESSION_MAX} step={5} presets={MINIMUM_SESSION_MINUTES_PRESETS} value={preferences.minimumSessionMinutes} onChange={(value) => { if (value !== null) onChange({ minimumSessionMinutes: value }); }} />
      </SettingsRow>
      <SettingsToggleRow label="自动排程辅助" note="只提示可以安排的任务，仍需你预览确认。" checked={preferences.autoScheduleAssist} modified={changed("autoScheduleAssist")} onReset={() => onChange({ autoScheduleAssist: DEFAULT_SETTINGS.autoScheduleAssist })} onChange={(checked) => onChange({ autoScheduleAssist: checked })} />
    </SettingsSection>
  </section>;
}

/** 可用时间的常用时长（分钟）。最后一档之外的走「自定义」。 */
const SLOT_DURATION_CHOICES = [[30, "30 分"], [45, "45 分"], [60, "1 小时"], [90, "1.5 小时"], [120, "2 小时"]] as const;

function durationLabel(minutes: number) {
  if (minutes === 1440) return "共 24 小时";
  if (minutes % 60 === 0) return `共 ${minutes / 60} 小时`;
  if (minutes > 60) return `共 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
  return `共 ${minutes} 分钟`;
}

function FinishDialog({ record, task, onClose, onSubmit }: { record: ExecutionRecord; task: Task; onClose: () => void; onSubmit: (progress: number, note: string, actualEndUtc: string) => Promise<void> }) {
  const [progress, setProgress] = useState(task.progress); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false);
  const [actualMinutes, setActualMinutes] = useState(() => Math.max(1, Math.round((Date.now() - new Date(record.actualStartUtc).getTime()) / 60_000)));
  const actualEndUtc = new Date(new Date(record.actualStartUtc).getTime() + actualMinutes * 60_000).toISOString();
  return <ConfirmDialog id="finish-dialog" labelledBy="finish-title" busy={busy} onClose={onClose}><div className="modal-icon"><Square /></div><h2 id="finish-title">结束本次：{task.title}</h2><p>本次执行会立即形成实际投入记录；任务完成度仍由你确认。</p><label>实际投入（分钟）<input type="number" min="1" max="1440" value={actualMinutes} onChange={(event) => setActualMinutes(Math.max(1, Number(event.target.value)))} /></label><label>任务完成度 <strong>{progress}%</strong><RangeBar compact min={0} max={100} step={5} value={progress} onChange={setProgress} /></label><label>本次小结（可选）<textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="留下对下次有帮助的一句话" /></label><small>开始于 {formatClock(record.actualStartUtc)}</small><div className="form-actions"><Button disabled={busy} onClick={onClose}>继续执行</Button><Button variant="primary" disabled={busy} onClick={async () => { setBusy(true); try { await onSubmit(progress, note, actualEndUtc); } finally { setBusy(false); } }}>{busy ? "正在保存…" : "结束并保存"}</Button></div></ConfirmDialog>;
}

function RestoreDialog({ preview, error, busy, onClose, onConfirm, currentCounts }: { currentCounts?: { projects: number; tasks: number } | null; preview: BackupPreview; error: string; busy: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  return <ConfirmDialog id="restore-dialog" labelledBy="restore-title" busy={busy} onClose={onClose}><div className="modal-icon"><ArchiveRestore /></div><h2 id="restore-title">确认恢复备份</h2><p>{currentCounts && <>当前有 {currentCounts.projects} 个项目、{currentCounts.tasks} 个任务。<br /></>}将恢复 <strong>{preview.projects}</strong> 个项目和 <strong>{preview.tasks}</strong> 个任务。开始替换前会创建恢复前备份。</p><p>备份时间：{new Date(preview.modifiedAt).toLocaleString()} · {(preview.sizeBytes / 1024).toFixed(1)} KB</p><p>恢复会替换当前项目、任务、安排和历史。{preview.includesPreferences === true ? "此备份包含应用设置，将一并恢复。" : preview.includesPreferences === false ? "此备份不包含设置，保留当前设置。" : "设置包含情况待原生版本确认。"}</p><details><summary>来源文件</summary><small>{preview.source}</small></details>{busy && <p role="status"><span className="spinner" />正在验证并安全替换，当前步骤不可取消…</p>}{error && <p className="error-message" role="alert"><CircleAlert />恢复未完成：{error}</p>}<div className="form-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="danger" disabled={busy} onClick={() => void onConfirm()}>{busy ? "正在恢复…" : "验证并恢复"}</Button></div></ConfirmDialog>;
}

/** 危险确认模态：语义与几何由调用方保留，inert／Esc／Tab／焦点统一交给浮层宿主。 */
function ConfirmDialog({ id, children, busy, onClose, className, labelledBy }: { id: string; children: ReactNode; busy: boolean; onClose: () => void; className?: string; labelledBy?: string }) {
  useOverlayLayer(id, { kind: "confirm", dismissible: !busy, onDismiss: onClose });
  return createPortal(<div id={id} className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}><section className={className ? `modal ${className}` : "modal"} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>{children}</section></div>, document.body);
}

/** 任务行内进度：悬浮或聚焦时出现把手，拖动实时预览，松手再写库。 */
function InlineTaskProgress({ task, onCommit, onOpen }: { task: Task; onCommit: (task: Task, value: number, anchor: HTMLElement | null) => Promise<void>; onOpen: (anchor: HTMLElement) => void }) {
  const [value, setValue] = useState(task.progress);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => setValue(task.progress), [task.progress]);
  const commit = () => { if (value !== task.progress) void onCommit(task, value, root.current); };
  return <div ref={root} className="project-task-progress">
    <span className="project-task-slider">
      <span className="project-task-track" aria-hidden="true">
        <span className="project-task-fill" style={{ width: value + "%" }} />
        <span className="project-task-thumb" style={{ left: `clamp(.3125rem, ${value}%, calc(100% - .3125rem))` }} />
      </span>
      <input type="range" className="project-task-range" min={0} max={100} step={5} value={value}
        aria-label={task.title + " 完成度"} aria-valuetext={value + "%"}
        onChange={(event) => setValue(Number(event.target.value))} onPointerUp={commit} onKeyUp={commit} />
    </span>
    <button type="button" className="project-task-pct" aria-label={"调整进度 " + task.title} onClick={(event) => onOpen(event.currentTarget)}>{value}%</button>
  </div>;
}

function ProgressControl({ task, onCommit, showComplete = false }: { task: Task; onCommit: (task: Task, value: number, anchor: HTMLElement | null) => Promise<void>; showComplete?: boolean }) {
  const [value, setValue] = useState(task.progress); useEffect(() => setValue(task.progress), [task.progress]);
  /** 锚点就是进度控件自己：完成气泡开在它旁边，而不是开在整张卡片中央。 */
  const root = useRef<HTMLDivElement>(null);
  const commit = () => { if (value !== task.progress) void onCommit(task, value, root.current); };
  const markComplete = () => { setValue(100); if (task.progress !== 100) void onCommit(task, 100, root.current); };
  return <div ref={root} className={showComplete ? "progress-control has-complete" : "progress-control"}><RangeBar compact label={`${task.title} 完成度`} min={0} max={100} step={5} value={value} onChange={setValue} onPointerUp={commit} onKeyUp={commit} />{showComplete ? <div className="progress-side"><button type="button" className="progress-complete" aria-label={`标记 ${task.title} 已完成`} onClick={markComplete} disabled={task.progress === 100}>完成</button><span>{value}%</span></div> : <span>{value}%</span>}</div>;
}

/**
 * 轴上的行内进度条 = 控件本身。
 *
 * 2026-10-28 起不再开「进度气泡」：同一个数摆两个入口，改一次要先进浮层再拖一次。
 * 外观沿用设置页那条滑动条（标准 `RangeBar`，不传 compact）：平时把轨道压成 5px 细线，
 * 悬浮／聚焦才还原成标准滑块。形态切换全在 CSS 里，这里只管值和提交；
 * 锚点照旧传出去 —— 走到 100% 时「完成记录」气泡要贴在这一行上。
 */
function RowProgress({ task, onCommit }: { task: Task; onCommit: (task: Task, value: number, anchor: HTMLElement | null) => Promise<void> }) {
  const [value, setValue] = useState(task.progress);
  useEffect(() => setValue(task.progress), [task.progress]);
  const root = useRef<HTMLSpanElement>(null);
  const commit = () => { if (value !== task.progress) void onCommit(task, value, root.current); };
  return <span ref={root} className="today-progress">
    <RangeBar className="today-progress-bar" label={`${task.title} 完成度`} min={0} max={100} step={5} fillFromZero
      value={value} onChange={setValue} onPointerUp={commit} onKeyUp={commit} formatValue={(next) => `${next}%`} />
    <span className="today-progress-value" aria-hidden="true">{value}%</span>
  </span>;
}

function useCurrentTime() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(timer); }, []);
  return now;
}


function TaskEditorFields({ task, projects, onUpdate, onCancel, onPhase }: { task: Task; projects: Project[]; onUpdate: (task: Task) => Promise<void>; onCancel: () => void; onPhase?: (busy: boolean) => void }) {
  const session = useEditorSession<Task>({
    key: task.id,
    initial: task,
    onSave: (draft) => onUpdate({ ...draft, title: draft.title.trim() }),
    onClose: (reason) => { if (reason !== "saved") onCancel(); },
    canSave: (draft) => Boolean(draft.title.trim()),
    onPhaseChange: (phase) => onPhase?.(phase === "submitting"),
  });
  const { draft, patchDraft, busy, error, phase } = session;
  return <form aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void session.save(); }}>
    <label>标题<input required value={draft.title} onChange={(event) => patchDraft({ title: event.target.value })} /></label>
    <label>项目<SelectField value={draft.projectId ?? ""} onChange={(value) => patchDraft({ projectId: value || null })} options={[{ value: "", label: "独立任务" }, ...projects.map((project) => ({ value: project.id, label: project.title }))]} /></label>
    <label>截止日期<DateField label="截止日期" value={draft.deadlineLocal} today={toLocalDate(new Date())} onChange={(value) => patchDraft({ deadlineLocal: value })} /></label>
    <label>预计耗时<NumberField label="预计耗时" suffix="分钟" min={5} max={1440} step={15} nullable presets={[30, 60, 120, 180]} value={draft.estimatedMinutes ?? null} onChange={(value) => patchDraft({ estimatedMinutes: value })} /></label>
    <label>单次投入<NumberField label="单次投入" suffix="分钟" min={5} max={240} step={5} nullable presets={[15, 30, 45, 60, 90]} value={draft.sessionMinutes ?? null} onChange={(value) => patchDraft({ sessionMinutes: value })} /></label>
    <div className="editor-field"><span className="editor-field-label">优先级</span>
      <div className="segmented" role="group" aria-label="优先级">
        {([{ value: "low", text: "低" }, { value: "normal", text: "普通" }, { value: "high", text: "高" }] as const).map((option) => <button key={option.value} type="button"
          aria-pressed={(draft.priority ?? "normal") === option.value} className={(draft.priority ?? "normal") === option.value ? "active" : ""}
          onClick={() => patchDraft({ priority: option.value })}>{option.text}</button>)}
      </div>
    </div>
    {error && phase === "error" && <p role="alert">{error}</p>}<div className="form-actions"><Button disabled={busy} onClick={session.cancel}>取消</Button><Button type="submit" variant="primary" disabled={busy || !draft.title.trim()}>{busy ? "正在保存…" : "保存任务"}</Button></div>
  </form>;
}

function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) { return <div className="empty-state"><span>{icon}</span><strong>{title}</strong><p>{text}</p>{action}</div>; }

function makeSession(task: Task, date: string, start: string, requestedDuration?: number): ExecutionSession {
  const duration = Math.max(5, requestedDuration ?? task.sessionMinutes ?? task.estimatedMinutes ?? 60); const endTotal = timeMinutes(start) + duration;
  return { id: crypto.randomUUID(), taskId: task.id, localDate: date, endLocalDate: endTotal >= 1440 ? addDays(date, 1) : date, startLocal: start, endLocal: minutesTime(endTotal % 1440), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local", utcOffsetMinutes: -new Date().getTimezoneOffset(), status: "scheduled" };
}
function sessionFromAllocation(allocation: ScheduleAllocation): ExecutionSession {
  return { id: crypto.randomUUID(), taskId: allocation.taskId, localDate: allocation.localDate, endLocalDate: allocation.endLocal === "00:00" ? addDays(allocation.localDate, 1) : allocation.localDate, startLocal: allocation.startLocal, endLocal: allocation.endLocal, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local", utcOffsetMinutes: -new Date().getTimezoneOffset(), status: "scheduled" };
}
function moveSessionTo(session: ExecutionSession, date: string, start: string, duration: number): ExecutionSession { const end = timeMinutes(start) + duration; return { ...session, localDate: date, endLocalDate: end >= 1440 ? addDays(date, 1) : date, startLocal: start, endLocal: minutesTime(end % 1440), status: "scheduled" }; }
function progressEvent(task: Task, toProgress: number): ProgressEvent { return { id: crypto.randomUUID(), taskId: task.id, fromProgress: task.progress, toProgress, occurredAtUtc: new Date().toISOString() }; }
/** 由起止时钟算时长；结束不晚于开始即视为跨午夜。 */
function clockDuration(startLocal: string, endLocal: string) { const start = timeMinutes(startLocal); let end = timeMinutes(endLocal); if (end <= start) end += 1440; return end - start; }
function sessionDuration(session: ExecutionSession) { const start = timeMinutes(session.startLocal); let end = timeMinutes(session.endLocal); if (session.endLocalDate !== session.localDate || end <= start) end += 1440; return end - start; }
function placementDateTime(date: string, minute: number) { const dayOffset = Math.floor(Math.max(0, minute) / 1440); return { date: addDays(date, dayOffset), time: minutesTime(Math.max(0, minute) % 1440) }; }
function positionStyle(start: string, end: string) { const top = timeMinutes(start) / 1440 * 100; let duration = timeMinutes(end) - timeMinutes(start); if (duration <= 0) duration += 1440; return { top: `${top}%`, height: `${Math.max(duration / 1440 * 100, 1.25)}%` }; }
function closestZoom(view: AppSettings["calendarView"], scale: number): AppSettings["calendarZoom"]["day"] {
  return (["compact", "standard", "detailed"] as const).reduce((closest, candidate) =>
    Math.abs(calendarScaleForZoom(view, candidate) - scale) < Math.abs(calendarScaleForZoom(view, closest) - scale) ? candidate : closest);
}
function sessionContains(session: ExecutionSession, now: Date) { const value = now.getTime(); return localSessionStart(session) <= value && value < localSessionEnd(session); }
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
/** 页头与日期详情用的长日期：`8月5日 星期三`（日与星期之间留一个空格，挤在一起读着黏）。 */
function formatLongDate(date: string) { const value = new Date(`${date}T12:00:00`); return `${new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(value)} ${new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(value)}`; }
function formatShortDate(date: string) { return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(new Date(`${date}T12:00:00`)); }
/** 200% 界面缩放下页头放不下的紧凑日期：`8/5`。 */
function compactMonthDay(date: string) { const value = new Date(`${date}T12:00:00`); return `${value.getMonth() + 1}/${value.getDate()}`; }
function scheduleDayLabel(today: string, date: string) { const offset = daysBetween(today, date); return offset === 0 ? "今天" : offset === 1 ? "明天" : formatShortDate(date); }
function formatRecentAdvanceDate(date: string, today: string) {
  const sameYear = date.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat("zh-CN", sameYear ? { month: "long", day: "numeric" } : { year: "numeric", month: "long", day: "numeric" }).format(new Date(`${date}T12:00:00`));
}
function formatMonth(date: string) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(new Date(`${date}T12:00:00`)); }
function formatDateTimeLong(value: string) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatClock(iso: string) { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso)); }
function taskTitle(workspace: WorkspaceSnapshot, taskId: string) { return workspace.tasks.find((task) => task.id === taskId)?.title ?? "未知任务"; }
/**
 * 「今日完成」一行的副行：完成时间在前，已记录的适应程度／张数跟在后面；
 * 没记就直说「未填写完成记录」——它同时是补写入口的提示（规格 §3.3）。
 */
function completionRowLabel(event: ProgressEvent, record: CompletionRecordSummary | null) {
  const at = `完成于 ${formatClock(event.occurredAtUtc)}`;
  if (!record) return `${at} · 未填写完成记录`;
  const parts = [at];
  if (record.fit) parts.push(COMPLETION_FIT_LABEL[record.fit]);
  if (record.imageCount > 0) parts.push(`${record.imageCount} 张图片`);
  return parts.join(" · ");
}
function isEditable(target: EventTarget | null) { return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)); }
function applyDisplayPreferences(settings: AppSettings, systemDark: boolean, systemReduced: boolean) { const root = document.documentElement; root.dataset.theme = settings.appearance === "system" ? (systemDark ? "dark" : "light") : settings.appearance; root.dataset.motion = settings.motion === "system" ? (systemReduced ? "reduce" : "full") : settings.motion; root.dataset.scale = settings.scale >= 150 ? "large" : "normal"; root.style.fontSize = `${settings.scale}%`; }
function readError(error: unknown) { return error instanceof Error ? error.message : String(error); }

/** 容量条两侧的时长：`h:mm`，等宽数字所以条宽不跳动。
    超容量时前缀「超」而不是负号 —— 负号要读者自己换算成「欠了多少」。 */
function formatClockMinutes(minutes: number) {
  const total = Math.abs(minutes);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatDuration(minutes: number) { const hours = Math.floor(minutes / 60); const rest = minutes % 60; return hours === 0 ? `${rest} 分钟` : rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`; }

/**
 * 截止标签的兜底短形态：只在容器窄到「还有 6 天」会把任务名挤成一个字时才用（200% 界面缩放）。
 * 两份文案都渲染、用容器查询切换 —— 拿不到 CSS 之外的真实可用宽度，用 JS 量会抖。
 */
function deadlineLabelShort(today: string, deadline: string) {
  const days = daysBetween(today, deadline);
  return days < 0 ? `逾期 ${Math.abs(days)} 天` : days === 0 ? "今天" : days === 1 ? "明天" : `${days} 天`;
}

/**
 * 倒计时：≥1 小时用 `h:mm:ss`，不足一小时用 `mm:ss`（59 分钟 → `59:00`）。
 *
 * 「还剩 30 分钟」是个不动的事实，「30:00」才看得出时间在走 —— 所以精确到秒，
 * 并且向上取整：刚跳进来那一秒不会先显示 29:59。
 */
function formatCountdown(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${two(minutes)}:${two(seconds)}`;
}

/**
 * 每秒一跳的倒计时节点。
 *
 * 只有它自己重渲染 —— 把秒放进页面时钟会让整张今日页每秒重算一遍。
 */
function Countdown({ target }: { target: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <>{formatCountdown(target - now)}</>;
}

function hasFutureSchedule(session: ExecutionSession) { return session.status === "scheduled" && localSessionStart(session) > Date.now(); }
