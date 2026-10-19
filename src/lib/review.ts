import type { ExecutionRecord, ExecutionSession, HabitOccurrence, ProgressEvent, TaskStatus, WorkspaceSnapshot } from "./native";
import { addLocalDays, isLocalDate, localDateOf } from "./deadlines";
import { createWorkspaceIndex, isPendingReviewIn, milestoneReached, milestoneSummary, projectProgress, projectTasksOf, type WorkspaceIndex } from "./workspaceSelectors";

/**
 * 日／周／月回顾引擎（阶段 4 P4-07 建立，P4-08 补下钻明细；规格 §7 / M11）。
 *
 * 它是**只读投影**：读现有工作区快照，产出周期内的统计与明细，不写任何领域事实、
 * 不新增表字段、不生成评分或连续天数。计划时段、实际执行与手动进度始终分开统计。
 *
 * 三条贯穿全篇的口径：
 *
 * 1. **周期是日历周期**：日＝一个本地自然日，周＝周一至周日，月＝自然月（不是最近
 *    30 天）。日期加减一律走 `addLocalDays` 的 UTC 日历整数加减，不用固定毫秒增减 ——
 *    跨月、闰年与夏令时按毫秒算都会错一天。
 * 2. **`now` 显式注入**：引擎内部不读 `Date.now()`／`new Date()` 取「现在」；页面之间
 *    不得各算一次时钟。`new Date(...)` 只用来把已经保存的 UTC 时间点解析成时间戳，
 *    以及按设备本地时区构造某个本地日期的日界。
 * 3. **实际投入按 UTC 毫秒求交、精度保留到汇总结束**：一条记录跨午夜时按本地日窗口
 *    切分（23:50–次日 00:20 → 前日 10 分钟、次日 20 分钟），毫秒级累加，只在最后
 *    一次换算成显示分钟 —— 逐条四舍五入再相加会累积偏差。
 *
 * P4-08 只**补了下钻用的明细列表**（`days[].events`／`days[].records`、
 * `tasks[].sessions`／`records`／`runningRecords`）：页面据此显示原始事件时间、进度变化、
 * 实际起止与已记录备注，而不必在组件里再按日期或任务过滤一遍事实。九项口径、`notes`
 * 与排序规则都没有变化 —— 明细是同一批事实的另一种投影，不新增统计。
 */

export type ReviewPeriod = "day" | "week" | "month";

export interface ReviewQuery {
  period: ReviewPeriod;
  /** 周期锚点：日＝该日，周＝该日所在的周，月＝该日所在的月。非法日期回退到 `now` 的本地日期。 */
  anchorDate: string;
  /** `null` 统计全部；非空只统计该项目的任务与其时段／记录。 */
  projectId: string | null;
}

export interface ReviewDaySummary {
  date: string;
  /** 该日净进度变化，百分点，可负。 */
  progressDelta: number;
  /** 该日实际投入（毫秒，已按本地日窗口切分、未四舍五入）。 */
  recordedMs: number;
  /** 该日实际投入的显示值：由该日毫秒**一次**换算得到。 */
  recordedMinutes: number;
  /** 该日待回顾的时段数。 */
  pendingReviewCount: number;
  /** 该日明确未推进（`missed`，且没有实际执行记录）的时段数。 */
  notAdvancedCount: number;
  /** 该日跳过（`skipped`）与取消安排（`cancelled`）的条数，含习惯发生项。 */
  skippedCount: number;
  /** 该日进行中的执行记录数（没有 `actualEndUtc`）。 */
  runningCount: number;
  /**
   * 该日进度事件（与 `progress` 同一份排序）。**只为下钻呈现**：页面不需要再按日期
   * 过滤一遍事件，也就不会在组件里长出第二套分桶规则。不参与任何统计。
   */
  events: ProgressEvent[];
  /**
   * 与该日本地窗口有交集的**已结束**记录（按开始时间与稳定 ID 排序）。
   *
   * 跨午夜的记录会同时出现在两天 —— 它本来就是两天各自的事实；`recordedMs` 仍然
   * 按交集毫秒切分，两者不会互相矛盾。进行中的记录不在这里（单列，不计入投入）。
   */
  records: ExecutionRecord[];
}

export interface ReviewProgressSummary {
  /** 周期内逐条 `toProgress - fromProgress` 的合计，百分点，可负；**不是**完成率。 */
  netDelta: number;
  /** 周期内存在进度事件的任务 ID（按 ID 去重，按首次事件顺序）。 */
  changedTaskIds: string[];
  /** 周期内至少一次 `toProgress = 100` 的任务 ID（按 ID 去重，重复完成不重复计数）。 */
  completedTaskIds: string[];
}

export interface ReviewActualSummary {
  /** 已结束记录与周期各日本地窗口的交集总时长（毫秒，保留精度到汇总结束）。 */
  recordedMs: number;
  /** 显示用分钟：由 `recordedMs` 一次换算得到。 */
  recordedMinutes: number;
  /** 没有 `actualEndUtc` 的记录；单独列出，不混入已确认投入。 */
  runningRecords: ExecutionRecord[];
  /** 周期内是否存在并行的执行记录：合计按记录相加，不是唯一墙钟时间。 */
  overlapping: boolean;
  /** 没有任何实际投入事实（既无已结束交集，也无进行中记录）。 */
  unrecorded: boolean;
  /**
   * 实际投入按项目分组（毫秒，按数值降序）。`projectId` 为 `null` 表示独立任务。
   * 只统计确有已结束记录的时长：进行中的执行不计入，与 `recordedMs` 口径一致。
   */
  byProject: { projectId: string | null; recordedMs: number }[];
}

export interface ReviewPlanSummary {
  /** 周期内的计划时段数（含尚未结束的），用于「有计划仍显示计划」。 */
  sessionCount: number;
}

export interface ReviewNotAdvancedSummary {  /** 明确未推进：`missed` 且没有实际执行记录。 */
  missedSessions: ExecutionSession[];
  /** 跳过：`skipped`。 */
  skippedSessions: ExecutionSession[];
  /** 取消安排：`cancelled`；与「跳过」分开说明。 */
  cancelledSessions: ExecutionSession[];
  /** 习惯发生项自己的跳过状态（与已计入的时段去重后）。 */
  skippedOccurrences: HabitOccurrence[];
  /** 去重后的总条数。 */
  count: number;
}

/**
 * 周期内到期里程碑的一次只读快照（规格 §7.3 最后一条）。
 *
 * 已经冻结的结果**优先**：它是当时的历史，后续推进不会改写这个周期看到的文本。
 * 没有冻结结果时才按 M7 的同一规则（`milestoneReached`）派生当前是否达成 —— 规则
 * 只有一份，不在这里另写。
 */
export interface ReviewMilestoneSummary {
  milestoneId: string;
  projectId: string;
  title: string;
  targetLocalDate: string;
  /** 是否存在到期冻结结果。 */
  frozen: boolean;
  /** 冻结时为当时的结果；未冻结时为派生的当前达成情况。 */
  reached: boolean;
  /** 冻结用结果文本，未冻结用达成条件摘要。 */
  resultText: string;
}

/**
 * 待续的原因：引擎实际命中的分支，按固定顺序给出。
 *
 * 规格 §7.2 的待续口径是「周期内有未完成推进**或**待回顾／未推进／跳过事实」，
 * 四个分支语义不同（「推进过但没完成」与「根本没推进」不是一件事），所以页面
 * 需要能如实说出是哪一种，而不是自己再判断一遍。
 */
export type ReviewCarryoverReason = "incompleteAdvance" | "pendingReview" | "notAdvanced" | "skippedOccurrence";

export interface ReviewTaskDetail {
  taskId: string;
  title: string;
  projectId: string | null;
  /** 任务**当前**完成度；与周期内历史分开，不能用它冒充历史。 */
  currentProgress: number;
  currentStatus: TaskStatus;
  /** 周期内净变化，百分点，可负。 */
  netDelta: number;
  /** 周期内事件，按发生时间与稳定 ID 排序。 */
  events: ProgressEvent[];
  /**
   * 周期内该任务的**计划时段**（按日期、开始时间与稳定 ID 排序）。
   *
   * 计划与实际始终分开：这里只给用户自己安排的时段，不因为出现了执行记录就被改写。
   */
  sessions: ExecutionSession[];
  /** 周期内该任务已结束记录的交集时长（毫秒，未四舍五入）。 */
  recordedMs: number;
  /** 周期内该任务的已结束记录（按开始时间与稳定 ID 排序）。 */
  records: ExecutionRecord[];
  /** 周期内该任务的进行中记录（没有 `actualEndUtc`）；不计入 `recordedMs`。 */
  runningRecords: ExecutionRecord[];
  /** 周期内第一条事件的 `fromProgress`；无事件为 `null`（不从当前值反推历史）。 */
  startProgress: number | null;
  /** 周期内最后一条事件的 `toProgress`；无事件为 `null`。 */
  endProgress: number | null;
  /** 周期内是否至少一次达到 100（与「当前是否已完成」分开）。 */
  everCompleted: boolean;
  /** 周期内该任务的进行中记录数。 */
  runningCount: number;
  /** 周期内该任务的待回顾时段数。 */
  pendingReviewCount: number;
  /** 周期内该任务明确未推进的时段数。 */
  missedCount: number;
  /** 周期内该任务跳过／取消安排的条数（时段＋习惯发生项，已去重）。 */
  skippedCount: number;
  /** 是否属于待续。 */
  carryover: boolean;
  /** 待续的原因（不在待续时为空数组）；只在引擎命中的分支上给值。 */
  carryoverReasons: ReviewCarryoverReason[];
}

export interface ReviewResult {
  period: ReviewPeriod;
  anchorDate: string;
  /** 周期起点（本地日期，含）。 */
  startDate: string;
  /** 周期终点（本地日期，含）。 */
  endDate: string;
  projectId: string | null;
  days: ReviewDaySummary[];
  progress: ReviewProgressSummary;
  actual: ReviewActualSummary;
  plan: ReviewPlanSummary;
  /** 待回顾：派生状态，不写 `missed`；判断来自 `workspaceSelectors` 的唯一实现。 */
  pendingReview: ExecutionSession[];
  notAdvanced: ReviewNotAdvancedSummary;
  /** 待续任务 ID（按任务去重）；只提供查看或安排，不复制任务。 */
  carryoverTaskIds: string[];
  tasks: ReviewTaskDetail[];
  /** 周期内到期的里程碑快照（冻结结果优先）。 */
  milestones: ReviewMilestoneSummary[];
  /** 口径说明，页面原样展示，不自行编造。 */
  notes: string[];
}

export const REVIEW_PERIOD_LABEL: Record<ReviewPeriod, string> = { day: "日", week: "周", month: "月" };

/** 周期覆盖的本地日期范围；周为周一至周日，月为自然月。 */
export function reviewRange(period: ReviewPeriod, anchorDate: string): { startDate: string; endDate: string } {
  if (period === "day") return { startDate: anchorDate, endDate: anchorDate };
  if (period === "week") {
    // 周一为一周第一天：JS 的 getUTCDay() 里周日是 0。
    const offsetFromMonday = (utcWeekday(anchorDate) + 6) % 7;
    const startDate = addLocalDays(anchorDate, -offsetFromMonday);
    return { startDate, endDate: addLocalDays(startDate, 6) };
  }
  const [year, month] = anchorDate.split("-").map(Number);
  const first = `${year}-${pad(month)}-01`;
  return { startDate: first, endDate: addLocalDays(first, daysInMonth(year, month) - 1) };
}

/** 由快照直接统计；内部建一次索引，行为与 `buildReviewFromIndex` 完全一致。 */
export function buildReview(workspace: WorkspaceSnapshot, query: ReviewQuery, now: Date): ReviewResult {
  return buildReviewFromIndex(createWorkspaceIndex(workspace), query, now);
}

/** 复用调用方已经建好的索引（页面只建一次索引，不为了回顾再扫一遍全量数组）。 */
export function buildReviewFromIndex(index: WorkspaceIndex, query: ReviewQuery, now: Date): ReviewResult {
  const anchorDate = isLocalDate(query.anchorDate) ? query.anchorDate : localDateOf(now);
  const { startDate, endDate } = reviewRange(query.period, anchorDate);
  return buildRange(index, query.period, anchorDate, startDate, endDate, query.projectId, now);
}

/** 净进度变化是**百分点**，跨任务合计不叫完成率。 */
export function formatPercentPoints(value: number): string {
  const rounded = Math.round(value);
  return `${rounded >= 0 ? "+" : ""}${rounded} 百分点`;
}

/** 实际投入的显示值；没有任何事实时说「未记录」，不说 0%。 */
export function formatRecordedMs(recordedMs: number): string {
  if (recordedMs <= 0) return "未记录";
  if (recordedMs < 60_000) return "不足 1 分钟";
  return `${Math.round(recordedMs / 60_000)} 分钟`;
}

/**
 * 单任务进度起止**只在事件证据支持时**显示：周期内第一条 `fromProgress` 与最后一条
 * `toProgress`。没有事件就不从当前值反推历史。
 */
export function formatTaskProgressRange(detail: ReviewTaskDetail): string {
  if (detail.startProgress === null || detail.endProgress === null) {
    return `本周期无进度记录，当前 ${detail.currentProgress}%`;
  }
  return `${detail.startProgress}% → ${detail.endProgress}%`;
}

function buildRange(
  index: WorkspaceIndex,
  period: ReviewPeriod,
  anchorDate: string,
  startDate: string,
  endDate: string,
  projectId: string | null,
  now: Date,
): ReviewResult {
  const dates: string[] = [];
  for (let date = startDate; date <= endDate; date = addLocalDays(date, 1)) dates.push(date);
  const dayIndex = new Map(dates.map((date, position) => [date, position]));
  const days: ReviewDaySummary[] = dates.map((date) => ({ date, progressDelta: 0, recordedMs: 0, recordedMinutes: 0, pendingReviewCount: 0, notAdvancedCount: 0, skippedCount: 0, runningCount: 0, events: [], records: [] }));

  const periodStartMs = localDayStartMs(startDate);
  const periodEndMs = localDayStartMs(addLocalDays(endDate, 1));
  const dayWindows = dates.map((date) => [localDayStartMs(date), localDayStartMs(addLocalDays(date, 1))] as const);

  // 项目过滤：非空时只保留该项目的任务，时段／记录／事件／习惯都按「任务属于该项目」收敛。
  const scopedTasks = index.workspace.tasks.filter((task) => projectId === null || task.projectId === projectId);
  const taskIds = new Set(scopedTasks.map((task) => task.id));
  const habitTaskIds = new Map<string, string>();
  for (const habit of index.workspace.recurringHabits) {
    if (taskIds.has(habit.taskId)) habitTaskIds.set(habit.id, habit.taskId);
  }

  // 周期内事件：按发生时间与稳定 ID 排序，同一时刻的事件保留明细、不假造先后。
  const periodEvents = index.workspace.progressEvents
    .filter((event) => taskIds.has(event.taskId))
    .map((event) => ({ event, ms: Date.parse(event.occurredAtUtc) }))
    .filter((entry) => Number.isFinite(entry.ms) && dayIndex.has(localDateOf(new Date(entry.ms))))
    .sort((left, right) => left.ms - right.ms || compareIds(left.event.id, right.event.id))
    .map((entry) => entry.event);

  let netDelta = 0;
  const changedTaskIds: string[] = [];
  const completedTaskIds: string[] = [];
  const seenChanged = new Set<string>();
  const seenCompleted = new Set<string>();
  for (const event of periodEvents) {
    netDelta += event.toProgress - event.fromProgress;
    const position = dayIndex.get(localDateOf(new Date(event.occurredAtUtc)));
    if (position !== undefined) { days[position].progressDelta += event.toProgress - event.fromProgress; days[position].events.push(event); }
    if (!seenChanged.has(event.taskId)) { seenChanged.add(event.taskId); changedTaskIds.push(event.taskId); }
    if (event.toProgress === 100 && !seenCompleted.has(event.taskId)) { seenCompleted.add(event.taskId); completedTaskIds.push(event.taskId); }
  }
  const ambiguousOrder = periodEvents.some((event, position) => position > 0 && Date.parse(event.occurredAtUtc) === Date.parse(periodEvents[position - 1].occurredAtUtc));

  // 已记录实际投入：按 UTC 毫秒求交，日界换算成 UTC；跨日分别计入。
  const recordedMsByTask = new Map<string, number>();
  const recordsByTask = new Map<string, ExecutionRecord[]>();
  const clipped: Array<{ start: number; end: number }> = [];
  for (const record of index.workspace.executionRecords) {
    if (!taskIds.has(record.taskId)) continue;
    if (!record.actualEndUtc) continue;
    const start = Date.parse(record.actualStartUtc);
    const end = Date.parse(record.actualEndUtc);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (end <= periodStartMs || start >= periodEndMs) continue;
    clipped.push({ start: Math.max(start, periodStartMs), end: Math.min(end, periodEndMs) });
    const ofTask = recordsByTask.get(record.taskId);
    if (ofTask) ofTask.push(record); else recordsByTask.set(record.taskId, [record]);
    for (let position = 0; position < dayWindows.length; position += 1) {
      const [dayStart, dayEnd] = dayWindows[position];
      const overlap = Math.min(end, dayEnd) - Math.max(start, dayStart);
      if (overlap <= 0) continue;
      days[position].recordedMs += overlap;
      days[position].records.push(record);
      recordedMsByTask.set(record.taskId, (recordedMsByTask.get(record.taskId) ?? 0) + overlap);
    }
  }
  const recordedMs = days.reduce((sum, day) => sum + day.recordedMs, 0);
  for (const day of days) day.recordedMinutes = Math.round(day.recordedMs / 60_000);
  // 明细列表按发生时间与稳定 ID 排序；同一份记录可以属于两天（跨午夜），两天各自是事实。
  for (const day of days) day.records.sort(compareRecords);
  for (const records of recordsByTask.values()) records.sort(compareRecords);

  // 进行中的执行：没有 actualEndUtc 的记录单独列出，不混入已确认投入。
  const runningRecords: ExecutionRecord[] = [];
  for (const record of index.workspace.executionRecords) {
    if (!taskIds.has(record.taskId) || record.actualEndUtc) continue;
    const start = Date.parse(record.actualStartUtc);
    if (!Number.isFinite(start) || start >= periodEndMs) continue;
    runningRecords.push(record);
    const position = dayIndex.get(localDateOf(new Date(Math.max(start, periodStartMs))));
    if (position !== undefined) days[position].runningCount += 1;
  }

  const periodSessions = index.workspace.executionSessions.filter((session) => taskIds.has(session.taskId) && dayIndex.has(session.localDate));
  const pendingReview = periodSessions.filter((session) => isPendingReviewIn(index, session, now));
  for (const session of pendingReview) days[dayIndex.get(session.localDate)!].pendingReviewCount += 1;

  // 明确未推进／跳过：读显式状态。已经产生实际记录的 `missed` 时段按实际投入计入，不重复
  // 记为未推进（与既有 7 天回顾一致，避免同一件事被说成两件）。
  const missedSessions = periodSessions.filter((session) => session.status === "missed" && !(index.recordsBySessionId.get(session.id)?.length));
  const skippedSessions = periodSessions.filter((session) => session.status === "skipped");
  const cancelledSessions = periodSessions.filter((session) => session.status === "cancelled");
  const countedSessionIds = new Set([...missedSessions, ...skippedSessions, ...cancelledSessions].map((session) => session.id));
  const skippedOccurrences = index.workspace.habitOccurrences.filter((occurrence) => habitTaskIds.has(occurrence.habitId) && dayIndex.has(occurrence.localDate)
    && occurrence.status === "skipped" && !(occurrence.sessionId && countedSessionIds.has(occurrence.sessionId)));
  for (const session of missedSessions) days[dayIndex.get(session.localDate)!].notAdvancedCount += 1;
  for (const session of [...skippedSessions, ...cancelledSessions]) days[dayIndex.get(session.localDate)!].skippedCount += 1;
  for (const occurrence of skippedOccurrences) days[dayIndex.get(occurrence.localDate)!].skippedCount += 1;

  // 待续：当前 active，且周期内有未完成推进、待回顾、未推进／跳过／取消安排的事实。
  const pendingReviewIds = new Set(pendingReview.map((session) => session.id));
  const incompleteAdvanceTaskIds = new Set(periodEvents.filter((event) => event.toProgress < 100).map((event) => event.taskId));
  const pendingReviewTaskIds = new Set(pendingReview.map((session) => session.taskId));
  const notAdvancedTaskIds = new Set([...missedSessions, ...skippedSessions, ...cancelledSessions].map((session) => session.taskId));
  const skippedOccurrenceTaskIds = new Set(skippedOccurrences.map((occurrence) => habitTaskIds.get(occurrence.habitId)!));
  const carryoverTaskIds = scopedTasks
    .filter((task) => task.status === "active"
      && (incompleteAdvanceTaskIds.has(task.id) || pendingReviewTaskIds.has(task.id) || notAdvancedTaskIds.has(task.id) || skippedOccurrenceTaskIds.has(task.id)))
    .map((task) => task.id);
  const carryover = new Set(carryoverTaskIds);

  // 明细：只列出周期内确有事实的任务 —— 没有事实的任务不显示，也就不存在伪造的 0% 执行率。
  // 先按任务分组一次，避免每行再扫一遍全量数组（规格 §8 的同一要求）。
  const eventsByTask = groupByTask(periodEvents, (event) => event.taskId);
  const sessionsByTask = groupByTask(periodSessions, (session) => session.taskId);
  const missedByTask = groupByTask(missedSessions, (session) => session.taskId);
  const droppedByTask = groupByTask([...skippedSessions, ...cancelledSessions], (session) => session.taskId);
  const occurrencesByTask = groupByTask(skippedOccurrences, (occurrence) => habitTaskIds.get(occurrence.habitId)!);
  const runningByTaskRecords = groupByTask(runningRecords, (record) => record.taskId);
  for (const sessions of sessionsByTask.values()) sessions.sort(compareSessions);
  for (const records of runningByTaskRecords.values()) records.sort(compareRecords);

  const tasks: ReviewTaskDetail[] = [];
  for (const task of scopedTasks) {
    const events = eventsByTask.get(task.id) ?? [];
    const sessions = sessionsByTask.get(task.id) ?? [];
    const occurrences = occurrencesByTask.get(task.id) ?? [];
    const records = recordsByTask.get(task.id) ?? [];
    const runningOfTask = runningByTaskRecords.get(task.id) ?? [];
    const recordedMsOfTask = recordedMsByTask.get(task.id) ?? 0;
    if (events.length === 0 && sessions.length === 0 && occurrences.length === 0 && recordedMsOfTask === 0 && runningOfTask.length === 0) continue;
    const carryoverReasons: ReviewCarryoverReason[] = [];
    if (incompleteAdvanceTaskIds.has(task.id)) carryoverReasons.push("incompleteAdvance");
    if (pendingReviewTaskIds.has(task.id)) carryoverReasons.push("pendingReview");
    if (notAdvancedTaskIds.has(task.id)) carryoverReasons.push("notAdvanced");
    if (skippedOccurrenceTaskIds.has(task.id)) carryoverReasons.push("skippedOccurrence");
    tasks.push({
      taskId: task.id,
      title: task.title,
      projectId: task.projectId,
      currentProgress: task.progress,
      currentStatus: task.status,
      netDelta: events.reduce((sum, event) => sum + event.toProgress - event.fromProgress, 0),
      events,
      sessions,
      recordedMs: recordedMsOfTask,
      records,
      runningRecords: runningOfTask,
      startProgress: events.length > 0 ? events[0].fromProgress : null,
      endProgress: events.length > 0 ? events[events.length - 1].toProgress : null,
      everCompleted: events.some((event) => event.toProgress === 100),
      runningCount: runningOfTask.length,
      pendingReviewCount: sessions.filter((session) => pendingReviewIds.has(session.id)).length,
      missedCount: (missedByTask.get(task.id) ?? []).length,
      skippedCount: (droppedByTask.get(task.id) ?? []).length + occurrences.length,
      carryover: carryover.has(task.id),
      carryoverReasons: carryover.has(task.id) ? carryoverReasons : [],
    });
  }

  const sessionCount = periodSessions.length;
  const unrecorded = recordedMs === 0 && runningRecords.length === 0;
  const overlapping = unionMs(clipped) < recordedMs;

  // 投入去向：从已经算好的任务明细里按项目累加，不另扫一遍记录；独立任务归到 null 一档。
  const recordedByProject = new Map<string | null, number>();
  for (const detail of tasks) {
    if (detail.recordedMs <= 0) continue;
    recordedByProject.set(detail.projectId, (recordedByProject.get(detail.projectId) ?? 0) + detail.recordedMs);
  }
  const byProject = [...recordedByProject.entries()]
    .map(([entryProjectId, entryMs]) => ({ projectId: entryProjectId, recordedMs: entryMs }))
    .sort((left, right) => right.recordedMs - left.recordedMs);

  // 周期内到期的里程碑：冻结结果优先，未冻结才按 M7 的唯一规则派生。
  const milestones: ReviewMilestoneSummary[] = index.workspace.projectMilestones
    .filter((milestone) => (projectId === null || milestone.projectId === projectId) && dayIndex.has(milestone.targetLocalDate))
    .map((milestone) => {
      const outcome = index.outcomesByMilestoneId.get(milestone.id);
      const projectTasks = projectTasksOf(index, milestone.projectId);
      return {
        milestoneId: milestone.id,
        projectId: milestone.projectId,
        title: milestone.title,
        targetLocalDate: milestone.targetLocalDate,
        frozen: outcome !== undefined,
        reached: outcome ? outcome.reached : milestoneReached(milestone, projectTasks, projectProgress(projectTasks)),
        resultText: outcome ? outcome.resultText : milestoneSummary(milestone, projectTasks),
      };
    });

  const notes: string[] = [`进度事件按当前设备本地时区（${deviceTimeZone()}）分桶；计划仍按保存的本地日期展示。`];
  if (projectId !== null) notes.push(`仅统计项目「${index.projectsById.get(projectId)?.title ?? "来源不可用"}」下的任务与其时段／记录。`);
  if (overlapping) notes.push("存在并行的执行记录，实际投入为「执行记录累计」，不等于唯一墙钟时间。");
  if (ambiguousOrder) notes.push("同一时刻存在多条进度事件，先后无法证明；明细按发生时间与稳定 ID 排序。");
  if (sessionCount > 0 && unrecorded) notes.push("本周期有计划但没有任何实际记录，显示「未记录」，不视为 0% 执行率。");

  return {
    period,
    anchorDate,
    startDate,
    endDate,
    projectId,
    days,
    progress: { netDelta, changedTaskIds, completedTaskIds },
    actual: { recordedMs, recordedMinutes: Math.round(recordedMs / 60_000), runningRecords, overlapping, unrecorded, byProject },
    plan: { sessionCount },
    pendingReview,
    notAdvanced: { missedSessions, skippedSessions, cancelledSessions, skippedOccurrences, count: missedSessions.length + skippedSessions.length + cancelledSessions.length + skippedOccurrences.length },
    carryoverTaskIds,
    tasks,
    milestones,
    notes,
  };
}

/** 某个本地日期的**本地午夜**对应的 UTC 毫秒；用本地日历字段构造，因此自动跨过夏令时。 */
function localDayStartMs(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day).getTime();
}

function utcWeekday(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 区间并集长度；用于判断合计是否大于唯一墙钟时间（即存在并行记录）。 */
function unionMs(intervals: Array<{ start: number; end: number }>): number {
  const sorted = [...intervals].sort((left, right) => left.start - right.start);
  let total = 0;
  let currentStart = Number.NaN;
  let currentEnd = Number.NaN;
  for (const interval of sorted) {
    if (Number.isNaN(currentStart)) { currentStart = interval.start; currentEnd = interval.end; continue; }
    if (interval.start <= currentEnd) currentEnd = Math.max(currentEnd, interval.end);
    else { total += currentEnd - currentStart; currentStart = interval.start; currentEnd = interval.end; }
  }
  if (!Number.isNaN(currentStart)) total += currentEnd - currentStart;
  return total;
}

function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 明细里的记录排序：开始时间 → 稳定 ID。同一时刻的记录保留全部，不假造先后。 */
function compareRecords(left: ExecutionRecord, right: ExecutionRecord): number {
  const difference = Date.parse(left.actualStartUtc) - Date.parse(right.actualStartUtc);
  return difference !== 0 && Number.isFinite(difference) ? difference : compareIds(left.id, right.id);
}

/** 明细里的计划时段排序：日期 → 开始时间 → 稳定 ID（与日历的既有顺序一致）。 */
function compareSessions(left: ExecutionSession, right: ExecutionSession): number {
  return `${left.localDate}${left.startLocal}`.localeCompare(`${right.localDate}${right.startLocal}`) || compareIds(left.id, right.id);
}

/** 按任务分组一次，明细不再逐行扫全量数组。 */
function groupByTask<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(item);
    else grouped.set(key, [item]);
  }
  return grouped;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
