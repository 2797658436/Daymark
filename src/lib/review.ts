import type { CompletionFit, CompletionRecordSummary, ExecutionRecord, ExecutionSession, HabitOccurrence, ProgressEvent, TaskStatus, WorkspaceSnapshot } from "./native";
import { addLocalDays, isLocalDate, localDateOf } from "./deadlines";
import { sessionMinutes } from "./calendarPlacement";
import { createWorkspaceIndex, isPendingReviewIn, milestoneReached, milestoneSummary, projectProgress, projectTasksOf, type WorkspaceIndex } from "./workspaceSelectors";
import { COMPLETION_TAGS } from "./completion";

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
  /**
   * 该日的完成记录（规格 0007 §6）：按完成时间与稳定 ID 排序，含已撤回。
   *
   * 与 `events`／`records` 同一性质——同一批事实的另一种投影，只为下钻呈现，
   * 不参与任何统计；页面因此不必自己按日期过滤一遍。
   */
  completions: ReviewCompletionSummary[];
}

/**
 * 一条完成记录在回顾里的只读投影（规格 0007 §6）。
 *
 * 就是快照里的那条记录加上任务标题：`fit`／`tags`／`note`／`imageCount` 全部来自用户
 * 写下的事实，回顾不加工也不推断；`revertedAtUtc` 有值即「已撤回」，仍留在明细里。
 */
export interface ReviewCompletionSummary extends CompletionRecordSummary {
  /** 任务标题；任务已不在工作区时为「来源不可用」，不造一个名字。 */
  title: string;
}

/**
 * 周／月的「完成感受」聚合：**只统计未撤回**的记录（规格 §6 的口径行）。
 *
 * 已撤回的记录留在明细与 `revertedCount` 里，但不进分布与标签，也就不会把一次
 * 用户自己否认的完成算进感受。分布零值档仍给出 0 计数，不画条。
 */
export interface ReviewFeelingSummary {
  fitCounts: Record<CompletionFit, number>;
  /** 按选择次数取前 3；同一次数按词表顺序稳定排列。 */
  topTags: { tag: string; count: number }[];
  /** 周期内的完成记录总数（含已撤回）。 */
  recordCount: number;
  /** 参与感受聚合的条数（未撤回）。 */
  countedCount: number;
  /** 已撤回、因此不计入感受的条数。 */
  revertedCount: number;
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

/**
 * 待续理由的**长句**：明细区逐条解释用（`review-detail.tsx` 直接 import）。
 * 与下面的短标签是同一个 `reason` 的两种文案，必须住在同一个模块里 —— 否则两个文件
 * 各写一份，改一处就会漂。
 */
export const CARRYOVER_REASON_LABEL: Record<ReviewCarryoverReason, string> = {
  incompleteAdvance: "周期内有未完成的进度推进",
  pendingReview: "有已结束但还没有记录的时段",
  notAdvanced: "有明确未推进／跳过／取消安排的时段",
  skippedOccurrence: "有跳过的习惯发生项",
};

/** 理由的展示顺序：先说「为什么还没完」，再说「推进过但没走完」。 */
export const CARRYOVER_REASON_ORDER: ReviewCarryoverReason[] = ["pendingReview", "notAdvanced", "skippedOccurrence", "incompleteAdvance"];

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
  /** 周期内该任务的完成记录（含已撤回，按完成时间与稳定 ID 排序）。 */
  completions: ReviewCompletionSummary[];
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

/** 待回顾条目：`ExecutionSession` 的全部字段 + 引擎算好的时长（跨午夜由引擎处理）。 */
export type ReviewPendingSession = ExecutionSession & { durationMinutes: number };

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
  pendingReview: ReviewPendingSession[];
  notAdvanced: ReviewNotAdvancedSummary;
  /** 待续任务 ID（按任务去重）；只提供查看或安排，不复制任务。 */
  carryoverTaskIds: string[];
  tasks: ReviewTaskDetail[];
  /** 周期内全部完成记录（含已撤回），按完成时间与稳定 ID 排序。 */
  completions: ReviewCompletionSummary[];
  /** 「完成感受」聚合：分布与标签只算未撤回的记录。 */
  feeling: ReviewFeelingSummary;
  /** 周期内到期的里程碑快照（冻结结果优先）。 */
  milestones: ReviewMilestoneSummary[];
  /** 口径说明，页面原样展示，不自行编造。 */
  notes: string[];
}

export const REVIEW_PERIOD_LABEL: Record<ReviewPeriod, string> = { day: "日", week: "周", month: "月" };
/** 当前周期徽标与「回到当前周期」的文案：日／周／月各自用「今日／本周／本月」。
 *  页头与「选择日期」里的日历共用一份，避免两处各写一套说法。 */
export const REVIEW_CURRENT_LABEL: Record<ReviewPeriod, string> = { day: "今天", week: "本周", month: "本月" };
export const REVIEW_BACK_LABEL: Record<ReviewPeriod, string> = { day: "回到今日", week: "回到本周", month: "回到本月" };

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
  const days: ReviewDaySummary[] = dates.map((date) => ({ date, progressDelta: 0, recordedMs: 0, recordedMinutes: 0, pendingReviewCount: 0, notAdvancedCount: 0, skippedCount: 0, runningCount: 0, events: [], records: [], completions: [] }));

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
  // 时长由引擎算（跨午夜在 `sessionMinutes` 里处理）：页面要回答「现在要不要处理」，
  // 但不在组件里减时间戳。
  const pendingReview: ReviewPendingSession[] = periodSessions
    .filter((session) => isPendingReviewIn(index, session, now))
    .map((session) => ({ ...session, durationMinutes: sessionMinutes(session) }));
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

  // 完成记录（规格 0007 §6）：第四类事实的只读投影。周期口径用 `completedAtUtc`
  // ——用户点完成的那一刻；已撤回的记录照样进明细，只是不进感受聚合。
  // 「曾完成任务数」仍以上面的进度事件为准，不受这里有没有记录、是否撤回影响。
  const periodCompletions = index.workspace.completionRecords
    .filter((record) => taskIds.has(record.taskId))
    .map((record) => ({ record, ms: Date.parse(record.completedAtUtc) }))
    .filter((entry) => Number.isFinite(entry.ms) && dayIndex.has(localDateOf(new Date(entry.ms))))
    .sort((left, right) => left.ms - right.ms || compareIds(left.record.id, right.record.id))
    .map(({ record }): ReviewCompletionSummary => ({
      ...record,
      title: index.tasksById.get(record.taskId)?.title ?? "来源不可用",
    }));
  for (const completion of periodCompletions) {
    days[dayIndex.get(localDateOf(new Date(completion.completedAtUtc)))!].completions.push(completion);
  }
  const fitCounts: Record<CompletionFit, number> = { light: 0, fit: 0, hard: 0 };
  const tagCounts = new Map<string, number>();
  let feelingCounted = 0;
  let feelingReverted = 0;
  for (const completion of periodCompletions) {
    if (completion.revertedAtUtc) { feelingReverted += 1; continue; }
    feelingCounted += 1;
    if (completion.fit) fitCounts[completion.fit] += 1;
    for (const tag of completion.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  // 次数相同按词表顺序排，避免同样三次的标签每次渲染换个位置。
  const topTags = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((left, right) => right.count - left.count || COMPLETION_TAGS.indexOf(left.tag as (typeof COMPLETION_TAGS)[number]) - COMPLETION_TAGS.indexOf(right.tag as (typeof COMPLETION_TAGS)[number]))
    .slice(0, 3);
  const feeling: ReviewFeelingSummary = { fitCounts, topTags, recordCount: periodCompletions.length, countedCount: feelingCounted, revertedCount: feelingReverted };

  // 待续：当前 active，且周期内有未完成推进、待回顾、未推进／跳过／取消安排的事实。
  const pendingReviewIds = new Set(pendingReview.map((session) => session.id));
  const incompleteAdvanceTaskIds = new Set(periodEvents.filter((event) => event.toProgress < 100).map((event) => event.taskId));
  const pendingReviewTaskIds = new Set(pendingReview.map((session) => session.taskId));
  const notAdvancedTaskIds = new Set([...missedSessions, ...skippedSessions, ...cancelledSessions].map((session) => session.taskId));
  const skippedOccurrenceTaskIds = new Set(skippedOccurrences.map((occurrence) => habitTaskIds.get(occurrence.habitId)!));
  const reasonHit = (reason: ReviewCarryoverReason, taskId: string) => reason === "pendingReview" ? pendingReviewTaskIds.has(taskId)
    : reason === "notAdvanced" ? notAdvancedTaskIds.has(taskId)
      : reason === "skippedOccurrence" ? skippedOccurrenceTaskIds.has(taskId)
        : incompleteAdvanceTaskIds.has(taskId);
  /** 任务在展示顺序里最靠前的那条理由的位次；没有命中排到最后。 */
  const reasonRank = (taskId: string) => {
    const position = CARRYOVER_REASON_ORDER.findIndex((reason) => reasonHit(reason, taskId));
    return position === -1 ? CARRYOVER_REASON_ORDER.length : position;
  };
  // 排序按理由优先级，不按任务顺序：先说「有待回顾」「计划没做」，再说「推进过但没走完」。
  const carryoverTaskIds = scopedTasks
    .filter((task) => task.status === "active"
      && (incompleteAdvanceTaskIds.has(task.id) || pendingReviewTaskIds.has(task.id) || notAdvancedTaskIds.has(task.id) || skippedOccurrenceTaskIds.has(task.id)))
    .sort((left, right) => reasonRank(left.id) - reasonRank(right.id))
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
  const completionsByTask = groupByTask(periodCompletions, (completion) => completion.taskId);
  for (const sessions of sessionsByTask.values()) sessions.sort(compareSessions);
  for (const records of runningByTaskRecords.values()) records.sort(compareRecords);

  const tasks: ReviewTaskDetail[] = [];
  for (const task of scopedTasks) {
    const events = eventsByTask.get(task.id) ?? [];
    const sessions = sessionsByTask.get(task.id) ?? [];
    const occurrences = occurrencesByTask.get(task.id) ?? [];
    const records = recordsByTask.get(task.id) ?? [];
    const completions = completionsByTask.get(task.id) ?? [];
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
      completions,
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
  if (feeling.revertedCount > 0) notes.push(`有 ${feeling.revertedCount} 条完成记录被撤回，未计入感受聚合。`);

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
    completions: periodCompletions,
    feeling,
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
