import { ChartNoAxesColumnIncreasing, Eraser, List, Maximize2, Pencil, Sparkles } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { Button } from "../ui/button";
import { ReviewChart, type ReviewChartRow } from "./review-chart";
import { ReviewDetail, formatDayLabel, type ReviewSelection } from "./review-detail";
import { ReviewPeriodPicker } from "./review-period-picker";
import { localDateOf } from "../../lib/deadlines";
import {
  REVIEW_PERIOD_LABEL, buildReviewFromIndex, formatPercentPoints, formatRecordedMs, formatTaskProgressRange,
  type ReviewPeriod, type ReviewResult,
} from "../../lib/review";
import type { Task } from "../../lib/native";
import type { AppSettings } from "../../lib/settings";
import type { WorkspaceIndex } from "../../lib/workspaceSelectors";

export type { ReviewSelection } from "./review-detail";

/**
 * 日／周／月回顾页面（阶段 4 P4-08，规格 §7.4 / M11）。
 *
 * 页面顺序按规格固定：① 成果与待续 → ② 投入和进度图 → ③ 任务／项目明细，最后是页面内
 * 明细区与口径说明。它**只呈现** `review.ts` 的只读投影：不评分、不算连续天数、不把
 * 「未记录」读成失败，也不在组件里另写统计公式（需要新派生值就加进引擎）。
 *
 * 状态归属：
 * - `reviewPeriod`／`reviewAnchorDate` 是**偏好**，经 App 的 `updatePreferences` 写进既有
 *   的 `SettingsRepository` 顺序写入队列（周期选择与翻页是唯一的持久化状态）。
 * - 项目筛选与明细选择只活在 App 层内存：同会话跨页返回有效，重启不恢复，不写 Store。
 */

const PERIODS: ReviewPeriod[] = ["day", "week", "month"];
/** 「继续推进」最多直接列几项；再多就交给下方任务明细，避免摘要变成一墙胶囊。 */
const CARRYOVER_PREVIEW = 6;
/** 投入去向最多画几条；再多的合并成一行合计。 */
const SPLIT_PREVIEW = 8;
/** 周视图的刻度要带星期：只有 7 列，放得下「周一 10/19」。 */
const WEEKDAY_LABEL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export interface ReviewPageProps {
  index: WorkspaceIndex;
  preferences: AppSettings;
  /** 写偏好（周期／锚点）；沿用 App 的 `updatePreferences`，不另建写入通道。 */
  onPreferences: (patch: Partial<AppSettings>) => void;
  /** 项目下钻（引擎查询的一部分）；只放 App 层内存。 */
  projectId: string | null;
  onProjectId: (projectId: string | null) => void;
  /** 明细区当前目标；只放 App 层内存。 */
  selection: ReviewSelection | null;
  onSelection: (selection: ReviewSelection | null) => void;
  /** 列表滚动容器（应用主内容区）与它的滚动位置。 */
  scrollRef: RefObject<HTMLElement | null>;
  scrollTop: RefObject<number>;
  onGoToday: () => void;
  onEditTask: (task: Task, anchorElement: HTMLElement) => void;
  onArrangeTask: (task: Task) => void;
  onOpenProject: (projectId: string, milestoneId: string | null) => void;
}

export function ReviewPage({ index, preferences, onPreferences, projectId, onProjectId, selection, onSelection, scrollRef, scrollTop, onGoToday, onEditTask, onArrangeTask, onOpenProject }: ReviewPageProps) {
  const now = useCurrentTime();
  const today = localDateOf(now);
  const period = preferences.reviewPeriod;
  // `reviewAnchorDate` 为 null 时按「当前周期」计算 —— 时钟由页面注入，引擎内不读时钟。
  const anchorDate = preferences.reviewAnchorDate ?? today;
  const review = useMemo(() => buildReviewFromIndex(index, { period, anchorDate, projectId }, now), [index, period, anchorDate, projectId, now]);

  const detailRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const triggerKeyRef = useRef<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const preOpenScroll = useRef(0);
  const restored = useRef(false);
  const mounted = useRef(false);
  const lastSelection = useRef<ReviewSelection | null>(selection);

  // 进入页面先恢复上次的滚动位置（同会话跨页返回有效；重启后 ref 归零，自然回到顶部）。
  useLayoutEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const container = scrollRef.current;
    if (container) container.scrollTop = scrollTop.current;
  }, [scrollRef, scrollTop]);

  // 打开明细时把它带进视野并聚焦，之后 Tab 可以正常进出；挂载时不抢焦点、不改滚动。
  useLayoutEffect(() => {
    if (!mounted.current) { mounted.current = true; lastSelection.current = selection; return; }
    if (!selection || selection === lastSelection.current) { lastSelection.current = selection; return; }
    lastSelection.current = selection;
    const node = detailRef.current;
    if (typeof node?.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
    node?.focus({ preventScroll: true });
    // 从「详细」气泡里下钻时，浮层关闭会由宿主在下一帧把焦点还给它的触发按钮。
    // 明细必须保住焦点，否则 Esc 落不到自己的处理函数里 —— 所以要排在宿主那一帧之后
    // 再补一次（宿主在「层数归零」的 effect 里排 rAF，比这里晚一帧才排上）。
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        if (node?.isConnected && !node.contains(document.activeElement)) node.focus({ preventScroll: true });
      });
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [selection]);

  // 滚动位置只在内存里跟手记录：不写 Store，也不触发重渲染。
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const record = () => { scrollTop.current = container.scrollTop; };
    container.addEventListener("scroll", record, { passive: true });
    return () => container.removeEventListener("scroll", record);
  }, [scrollRef, scrollTop]);

  const openDetail = useCallback((next: ReviewSelection, trigger: HTMLElement | null) => {
    triggerRef.current = trigger;
    // 触发元素的身份（`kind:id`）：切页返回或继续下钻后原节点已经不在了，
    // 关闭时按它重新找同一个目标（与截止页用 `data-deadline-key` 找回焦点行同理）。
    triggerKeyRef.current = `${next.kind}:${next.id}`;
    preOpenScroll.current = scrollRef.current?.scrollTop ?? 0;
    onSelection(next);
  }, [onSelection, scrollRef]);

  /** 关闭明细：焦点回到触发元素，滚动回到打开汇总时的位置（查询不变）。 */
  const closeDetail = useCallback(() => {
    const trigger = triggerRef.current;
    const container = scrollRef.current;
    onSelection(null);
    // 原触发元素还在就直接用它；否则按身份找同一个目标；再不行退到页面标题 ——
    // 不调用已断开的节点，键盘用户也不会掉到 body。
    const target = trigger?.isConnected
      ? trigger
      : document.querySelector<HTMLElement>(`[data-review-trigger="${triggerKeyRef.current}"]`);
    (target ?? headingRef.current)?.focus({ preventScroll: true });
    if (container) container.scrollTop = preOpenScroll.current;
  }, [onSelection, scrollRef]);

  const titleOf = (taskId: string) => index.tasksById.get(taskId)?.title ?? "来源不可用";
  const projectTitleOf = (id: string) => index.projectsById.get(id)?.title ?? "来源不可用";

  // 明细区的 Esc 兜底：容器自己的 onKeyDown 只在焦点落在里面时才生效，而从浮层里下钻时
  // 宿主可能把焦点抢回触发按钮（归还发生在下一帧），那时 Esc 就没人接。
  // 这里在文档上再挂一层：只要没有别的对话框在最上面，Esc 就关明细。
  useEffect(() => {
    if (!selection) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="dialog"]')) return;
      event.stopPropagation();
      closeDetail();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selection, closeDetail]);
  const taskChip = (taskId: string) => <button key={taskId} type="button" className="review-task-chip" data-review-trigger={`task:${taskId}`} aria-label={`查看任务「${titleOf(taskId)}」的明细`} onClick={(event) => openDetail({ kind: "task", id: taskId }, event.currentTarget)}>{titleOf(taskId)}</button>;

  const hasFacts = review.tasks.length > 0 || review.milestones.length > 0 || review.pendingReview.length > 0
    || review.notAdvanced.count > 0 || review.actual.runningRecords.length > 0;

  const tickOf = (date: string) => {
    if (period === "day") return formatDayLabel(date);
    // 周视图只有 7 列，放得下「周一 10/19」；月视图 31 列只留日号。
    if (period === "week") return `${WEEKDAY_LABEL[new Date(`${date}T12:00:00`).getDay()]} ${date.slice(5, 7)}/${date.slice(8, 10)}`;
    return String(Number(date.slice(8, 10)));
  };
  /** 200% 缩放下列宽只剩一半：「周一 10/19」会叠在一起，退成「周一」。 */
  const shortTickOf = (date: string) => period === "week" ? WEEKDAY_LABEL[new Date(`${date}T12:00:00`).getDay()] : undefined;
  const minuteRows: ReviewChartRow[] = review.days.map((day) => ({
    date: day.date,
    value: day.recordedMinutes,
    // 0 分钟说「未记录」：没有记录不等于 0% 执行率，也不画零柱。
    label: day.recordedMinutes > 0 ? `${day.recordedMinutes} 分钟` : "未记录",
    tick: tickOf(day.date),
    tickShort: shortTickOf(day.date),
    fullLabel: formatDayLabel(day.date),
  }));
  const deltaRows: ReviewChartRow[] = review.days.map((day) => ({
    date: day.date,
    value: day.progressDelta,
    label: formatPercentPoints(day.progressDelta),
    tick: tickOf(day.date),
    tickShort: shortTickOf(day.date),
    fullLabel: formatDayLabel(day.date),
  }));

  // 投入与净进度共用一张图：同一批日期、同一个时间轴，切成两个数值看。
  // 合并后省掉一整行，也避免两张图各自的坐标轴互相对齐。
  const [metric, setMetric] = useState<"minutes" | "delta">("minutes");
  const [expanded, setExpanded] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const detailAnchor = useRef<HTMLButtonElement | null>(null);
  const isMinutes = metric === "minutes";
  const chartRows = isMinutes ? minuteRows : deltaRows;
  const chartTitle = isMinutes ? "实际投入" : "净进度变化";
  const chartUnit = isMinutes ? "分钟" : "百分点";

  const weekDetail = period === "week" ? review.days.map((day) => ({
    date: day.date,
    fullLabel: formatDayLabel(day.date),
    weekday: WEEKDAY_LABEL[new Date(`${day.date}T12:00:00`).getDay()],
    minutes: day.recordedMinutes > 0 ? `${day.recordedMinutes} 分钟` : "未记录",
    delta: formatPercentPoints(day.progressDelta),
  })) : undefined;

  // 图表的标题行：切换与按钮都在这里，图本身不再带一行标题。
  const chartsHeading = <div className="section-heading review-charts-head">
    <h2 id="review-charts-title">投入和进度</h2>
    <div className="review-charts-tools">
      <div className="review-charts-group">
        <div className="segmented review-metric-switch" role="group" aria-label="图表数值">
          <button type="button" aria-pressed={isMinutes} className={isMinutes ? "active" : ""} onClick={() => setMetric("minutes")}>实际投入</button>
          <button type="button" aria-pressed={!isMinutes} className={!isMinutes ? "active" : ""} onClick={() => setMetric("delta")}>净进度</button>
        </div>
        <span className="review-charts-unit">单位：{chartUnit}</span>
      </div>
      <div className="review-charts-group">
        {period === "week" && <button ref={detailAnchor} type="button" className="review-chart-expand" aria-expanded={detailOpen}
          onClick={() => setDetailOpen(true)}><List size={14} />详细</button>}
        {chartRows.some((row) => row.value !== 0) && <button type="button" className="review-chart-expand" aria-label={`放大${chartTitle}图表`}
          onClick={() => setExpanded(true)}><Maximize2 size={14} />放大</button>}
      </div>
    </div>
  </div>;

  const mergedChart = <ReviewChart
    title={chartTitle}
    unit={chartUnit}
    rows={chartRows}
    signed={!isMinutes}
    emptyText={isMinutes ? "本周期没有记录实际投入，因此不绘制全零图表。" : "本周期没有进度变化。"}
    baselineNote={isMinutes ? undefined : "零基线以上是上调，以下是下调；下调如实显示，不代表失败。"}
    splitDetail={weekDetail}
    onOpenDate={(date, trigger) => openDetail({ kind: "date", id: date }, trigger)}
    expanded={expanded} onExpand={setExpanded}
    detailOpen={detailOpen} onDetailOpen={setDetailOpen} detailAnchor={detailAnchor} />;

  // 没有记录时也给一个「0 分钟」的占位圆环：比整块消失更能说明「这里本来该有东西」。
  const splitChart = <SplitChart entries={review.actual.byProject} titleOf={(id) => id === null ? "独立任务" : projectTitleOf(id)}
    onOpen={(id, trigger) => id !== null && openDetail({ kind: "project", id }, trigger)} />;

  const taskRows = review.tasks.length > 0
    ? <div className="review-detail-rows">{review.tasks.map((detail) => {
      const task = index.tasksById.get(detail.taskId);
      return <article className="review-detail-row" key={detail.taskId} data-review-task={detail.taskId}>
        <div className="review-detail-main">
          <strong className="review-detail-title">{task
            ? <button type="button" className="review-inline-link" data-review-trigger={`task:${detail.taskId}`} aria-label={`查看任务「${task.title}」的明细`} onClick={(event) => openDetail({ kind: "task", id: detail.taskId }, event.currentTarget)}>{task.title}</button>
            : <span>来源不可用</span>}</strong>
          {detail.projectId
            ? <button type="button" className="review-inline-link" data-review-trigger={`project:${detail.projectId}`} aria-label={`查看项目「${projectTitleOf(detail.projectId)}」的明细`} onClick={(event) => openDetail({ kind: "project", id: detail.projectId! }, event.currentTarget)}>{projectTitleOf(detail.projectId)}</button>
            : <span className="review-muted">独立任务</span>}
          <span className="review-detail-range">{formatTaskProgressRange(detail)}</span>
          <span className="review-detail-metric">净变化 {formatPercentPoints(detail.netDelta)}</span>
          <span className="review-detail-metric">投入 {formatRecordedMs(detail.recordedMs)}</span>
          {detail.pendingReviewCount > 0 && <span className="review-detail-metric">待回顾 {detail.pendingReviewCount}</span>}
          {detail.carryover && <span className="muted-chip">待续</span>}
        </div>
        {task && <div className="review-detail-actions">
          <Button aria-label={`编辑任务 ${task.title}`} onClick={(event) => onEditTask(task, event.currentTarget)}><Pencil size={14} />编辑</Button>
          {/* 每行都放实心主按钮会把整页的视觉重量压到明细区：安排是次要动作，用次级按钮。 */}
          {task.status === "active"
            ? <Button aria-label={`安排任务 ${task.title}`} onClick={() => onArrangeTask(task)}><Sparkles size={14} />安排</Button>
            : <span className="muted-chip">{task.status === "paused" ? "已暂停，不能重新安排" : "已完成"}</span>}
        </div>}
      </article>;
    })}</div>
    : <p className="review-muted">本周期没有任务事实。</p>;

  // 明确未推进／跳过／取消安排分别说明：它们是用户显式给出的结果，不是时间流逝的推断。
  const notAdvanced = review.notAdvanced.count > 0 && <div className="review-not-advanced">
    <h3>明确未推进与跳过</h3>
    <ul className="review-detail-list">
      {review.notAdvanced.missedSessions.map((session) => <li key={session.id}><span className="review-tag">明确未推进</span>{titleOf(session.taskId)}<time>{formatDayLabel(session.localDate)} {session.startLocal}–{session.endLocal}</time></li>)}
      {review.notAdvanced.skippedSessions.map((session) => <li key={session.id}><span className="review-tag">跳过</span>{titleOf(session.taskId)}<time>{formatDayLabel(session.localDate)} {session.startLocal}–{session.endLocal}</time></li>)}
      {review.notAdvanced.cancelledSessions.map((session) => <li key={session.id}><span className="review-tag">取消安排</span>{titleOf(session.taskId)}<time>{formatDayLabel(session.localDate)} {session.startLocal}–{session.endLocal}</time></li>)}
      {review.notAdvanced.skippedOccurrences.map((occurrence) => <li key={occurrence.id}><span className="review-tag">跳过</span>{index.workspace.recurringHabits.find((habit) => habit.id === occurrence.habitId)?.title ?? "来源不可用"}<time>{formatDayLabel(occurrence.localDate)}</time></li>)}
    </ul>
  </div>;

  return <section className="page-stack review-page" aria-labelledby="review-title">
    <header className="page-header">
      <div>
        <span className="eyebrow">{period === "day" ? formatDayLabel(review.startDate) : `${formatDayLabel(review.startDate)} — ${formatDayLabel(review.endDate)}`}</span>
        <h1 id="review-title" ref={headingRef} tabIndex={-1}>{periodTitle(period, review, today)}</h1>
      </div>
      <div className="header-actions">
        <div className="segmented" role="group" aria-label="回顾周期">
          {PERIODS.map((option) => <button key={option} aria-pressed={period === option} className={period === option ? "active" : ""} onClick={() => onPreferences({ reviewPeriod: option })}>{REVIEW_PERIOD_LABEL[option]}</button>)}
        </div>
        {/* 不再用左右箭头翻页：点日期打开日历，在日历里直接跳到想看的那一天／那一周／那一个月。 */}
        <ReviewPeriodPicker period={period} anchorDate={anchorDate} today={today}
          onSelect={(nextPeriod, nextAnchor) => onPreferences({ reviewPeriod: nextPeriod, reviewAnchorDate: nextAnchor })} />
        {!review.days.some((day) => day.date === today) && <Button onClick={() => onPreferences({ reviewAnchorDate: null })}>回到当前周期</Button>}
      </div>
    </header>

    {/* 第一行就是三个大字：投入、净进度、曾完成。此前它们缩在页头右侧的胶囊里，
        和下面的图表、明细争夺同一行空间，读起来像备注而不是结论。
        用 div + role=group 而不是 section：规格里的三段顺序（成果→图表→明细）不该被摘要打断。 */}
    {hasFacts && <div className="review-stats" role="group" aria-label="本周期总览">
      <Stat kind="actual" value={formatRecordedMs(review.actual.recordedMs)} label="实际投入" />
      <Stat kind="progress" value={formatPercentPoints(review.progress.netDelta)} label="净进度" note={`${review.progress.changedTaskIds.length} 项有进度变化`} />
      <Stat kind="completed" value={`${review.progress.completedTaskIds.length} 项完成`} note={`${review.carryoverTaskIds.length} 项仍可继续`} />
    </div>}

    {projectId !== null && <p className="review-scope" role="status">
      <span className="muted-chip">仅统计项目：{projectTitleOf(projectId)}</span>
      <Button onClick={() => onProjectId(null)}><Eraser size={14} />清除项目筛选</Button>
    </p>}

    {!hasFacts && <ReviewEmpty icon={<ChartNoAxesColumnIncreasing />} title="有实际推进后，这里会出现回顾" text="没有记录时不绘制全零图表，也不会把未记录解释为失败。" action={<Button variant="primary" onClick={onGoToday}>前往今日</Button>} />}

    {hasFacts && <>
      {/* ① 成果与待续 */}
      <section className="surface-card review-outcomes" aria-labelledby="review-outcomes-title">
        <div className="section-heading"><h2 id="review-outcomes-title">成果与待续</h2></div>
        {/* 一行总账替代原来的四段计数句子：同样的数字只出现一次，细节交给下面三块与任务明细。 */}
        <p className="review-outcome-summary">
          {review.progress.changedTaskIds.length} 项有进度变化 · {review.carryoverTaskIds.length} 项仍可继续安排
          {review.progress.completedTaskIds.length > 0 && ` · ${review.progress.completedTaskIds.length} 项完成`}
        </p>
        <div className="review-outcome-grid">
          <article className="review-outcome-block">
            <h3>继续推进</h3>
            {review.carryoverTaskIds.length > 0 ? <>
              <div className="review-task-list">{review.carryoverTaskIds.slice(0, CARRYOVER_PREVIEW).map(taskChip)}</div>
              {review.carryoverTaskIds.length > CARRYOVER_PREVIEW && <p className="review-muted">还有 {review.carryoverTaskIds.length - CARRYOVER_PREVIEW} 项，见下方任务明细。</p>}
            </> : <p className="review-muted">本周期没有需要继续推进的任务。</p>}
          </article>
          {/* 待回顾与里程碑同属「需要你处理」，竖着排在一列：它们很少同时为空，
              分三列会让中间空出一整栏。两者都为空时并成一句，别让空状态占掉半张卡。 */}
          {(review.pendingReview.length > 0 || review.actual.runningRecords.length > 0 || review.milestones.length > 0)
            ? <div className="review-outcome-side">
              <article className="review-outcome-block">
                <h3>待回顾</h3>
                {(review.pendingReview.length > 0 || review.actual.runningRecords.length > 0) ? <>
                  <p>{review.pendingReview.length} 个已结束的时段还没有记录</p>
                  <ul className="review-detail-list">
                    {review.pendingReview.map((session) => <li key={session.id}>
                      <button type="button" className="review-inline-link" data-review-trigger={`task:${session.taskId}`} aria-label={`查看任务「${titleOf(session.taskId)}」的明细`} onClick={(event) => openDetail({ kind: "task", id: session.taskId }, event.currentTarget)}>{titleOf(session.taskId)}</button>
                      <time>{formatDayLabel(session.localDate)} {session.startLocal}–{session.endLocal}</time>
                    </li>)}
                    {/* 进行中的执行不是「待回顾」，但同样没有结束时间、同样不计入投入：并进这一块，用标签区分。 */}
                    {review.actual.runningRecords.map((record) => <li key={record.id}>
                      <span className="review-tag">进行中</span>
                      <button type="button" className="review-inline-link" data-review-trigger={`task:${record.taskId}`} aria-label={`查看任务「${titleOf(record.taskId)}」的明细`} onClick={(event) => openDetail({ kind: "task", id: record.taskId }, event.currentTarget)}>{titleOf(record.taskId)}</button>
                      <time>开始于 {formatClock(record.actualStartUtc)}</time>
                    </li>)}
                  </ul>
                </> : <p className="review-muted">没有需要回顾的时段。</p>}
              </article>
              <article className="review-outcome-block">
                <h3>里程碑</h3>
                {review.milestones.length > 0 ? <>
                  <p>{review.milestones.length} 个在本周期到期</p>
                  <ul className="review-detail-list">{review.milestones.map((milestone) => <li key={milestone.milestoneId} className="review-milestone">
                    <div className="review-milestone-head">
                      <button type="button" className="review-inline-link" data-review-trigger={`project:${milestone.projectId}`} aria-label={`查看项目「${projectTitleOf(milestone.projectId)}」的明细`} onClick={(event) => openDetail({ kind: "project", id: milestone.projectId }, event.currentTarget)}>{milestone.title}</button>
                      <time>{formatDayLabel(milestone.targetLocalDate)}</time>
                      <span className={milestone.reached ? "review-tag" : "review-tag is-unmet"}>{milestone.reached ? "达成" : "未达成"}</span>
                    </div>
                    {/* 结果文字单独一行：和名称、日期挤在同一行时，「未达成」会被读两遍。 */}
                    <p className="review-milestone-note">{milestone.frozen ? "到期冻结，后续推进不改写" : "当前达成情况"} · {milestone.resultText}</p>
                  </li>)}</ul>
                </> : <p className="review-muted">本周期没有到期的里程碑。</p>}
              </article>
            </div>
            : <article className="review-outcome-block">
              <h3>需要你处理</h3>
              <p className="review-muted">本期没有待回顾的时段，也没有到期的里程碑。</p>
            </article>}
        </div>
      </section>

      {period === "day"
        // 单日没有「按天比较」的意义：上面的三个大字已经给了投入与净进度，
        // 这里只留投入去向与任务明细，合成一张卡（左圆环、右明细）。
        ? <section className="surface-card review-merged" aria-labelledby="review-merged-title">
          <div className="section-heading"><h2 id="review-merged-title">投入去向与任务</h2><span>{review.tasks.length} 项有事实</span></div>
          <div className={splitChart ? "review-merged-split" : undefined}>
            {splitChart}
            <div className="review-merged-tasks">{taskRows}{notAdvanced}</div>
          </div>
        </section>
        : <>
          {/* ② 投入和进度图：一张图、一个单位，切换看投入还是净进度 */}
          <section className="surface-card review-charts" aria-labelledby="review-charts-title">
            {/* 周视图分两栏：标题（含切换与按钮）和柱状图同属左栏，右栏从第一行就是投入去向。
                月视图 31 列需要整宽，标题在上、圆环在下。 */}
            {period === "week" ? <div className="review-charts-row">
              <div className="review-charts-col">
                {chartsHeading}
                {mergedChart}
              </div>
              {splitChart}
            </div> : <>
              {chartsHeading}
              {mergedChart}
              {splitChart}
            </>}
          </section>

          {/* ③ 任务／项目明细 */}
          <section className="surface-card review-tasks" aria-labelledby="review-tasks-title">
            <div className="section-heading"><h2 id="review-tasks-title">任务／项目明细</h2><span>{review.tasks.length} 项有事实</span></div>
            {taskRows}
            {notAdvanced}
          </section>
        </>}
    </>}

    {selection && <ReviewDetail containerRef={detailRef} index={index} review={review} selection={selection} projectId={projectId}
      onClose={closeDetail} onEditTask={onEditTask} onArrangeTask={onArrangeTask} onOpenProject={onOpenProject} onProjectId={onProjectId}
      onOpenTask={(taskId, trigger) => openDetail({ kind: "task", id: taskId }, trigger)} />}
  </section>;
}

/** 与 `App.tsx`／截止页同一套空状态类名；页面是独立模块，不反向依赖应用壳。 */
function ReviewEmpty({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><span>{icon}</span><strong>{title}</strong><p>{text}</p>{action}</div>;
}

/** 第一行的三个大字。数值用 `data-review-stat` 标出，方便核对与测试。
 *  数字与单位分开排：单位跟数字同高会把「1481 分钟」读成两个等重的信息。
 *  没有标签的那一块仍然占住标签行（`min-height`），否则下面的注释会跟旁边错行。 */
function Stat({ kind, value, label, note }: { kind: "actual" | "progress" | "completed"; value: string; label?: string; note?: string }) {
  const [amount, unit] = value.split(" ");
  return <div className="review-stat" data-review-stat={kind}>
    <span className="review-stat-value">{amount}{unit && <>{" "}<span className="review-stat-unit">{unit}</span></>}</span>
    <span className="review-stat-label">{label ?? ""}</span>
    {note && <span className="review-stat-note">{note}</span>}
  </div>;
}

/**
 * 投入去向：圆环 + 图例。
 *
 * 和上面两张图共用「一个单位」的规矩（分钟），但没有日期维度，所以用圆环直接比较
 * 各部分占多少。圆环用 SVG 分段（每段可单独悬停），对辅助技术隐藏（`aria-hidden`），
 * 可读的等价物是左边那列图例；悬停某一段或某一行时，环心换成那一段的百分比。
 * 项目名可点，进入该项目在本周期的明细。
 */
function SplitChart({ entries, titleOf, onOpen }: {
  entries: { projectId: string | null; recordedMs: number }[];
  titleOf: (projectId: string | null) => string;
  onOpen: (projectId: string | null, trigger: HTMLElement) => void;
}) {
  const [hot, setHot] = useState<string | null>(null);
  const visible = entries.slice(0, SPLIT_PREVIEW);
  const rest = entries.slice(SPLIT_PREVIEW);
  const total = entries.reduce((sum, entry) => sum + entry.recordedMs, 0);
  const restMs = rest.reduce((sum, entry) => sum + entry.recordedMs, 0);

  const arcs: { key: string; label: string; recordedMs: number; color: string; percent: number; offset: number }[] = [];
  let cursor = 0;
  visible.forEach((entry, index) => {
    const percent = (entry.recordedMs / total) * 100;
    arcs.push({ key: entry.projectId ?? "independent", label: titleOf(entry.projectId), recordedMs: entry.recordedMs, color: `var(--chart-${(index % 6) + 1})`, percent, offset: cursor });
    cursor += percent;
  });
  if (restMs > 0) arcs.push({ key: "rest", label: `另外 ${rest.length} 个去处`, recordedMs: restMs, color: "var(--line-strong)", percent: (restMs / total) * 100, offset: cursor });

  const hotArc = arcs.find((arc) => arc.key === hot);

  const row = (arc: typeof arcs[number], content: ReactNode) => <li key={arc.key}
    className={hot === arc.key ? "is-hot" : undefined}
    onMouseEnter={() => setHot(arc.key)} onMouseLeave={() => setHot(null)}
    onFocus={() => setHot(arc.key)} onBlur={() => setHot(null)}>
    <span className="review-split-dot" style={{ background: arc.color }} aria-hidden="true" />
    {content}
    <span className="review-split-value">{formatRecordedMs(arc.recordedMs)}</span>
  </li>;

  return <section className="review-split" aria-labelledby="review-split-title">
    <div className="review-split-head"><strong id="review-split-title">投入去向</strong></div>
    <div className="review-split-body">
      {total === 0
        // 没有记录时给一个空环：整块消失会让人以为这里本来就没有这个板块。
        ? <p className="review-split-empty">本期还没有记录投入</p>
        : <ul className="review-split-list">
          {visible.map((entry, index) => {
            const arc = arcs[index];
            const name = <span className="review-split-name">{arc.label}</span>;
            return row(arc, entry.projectId
              ? <button type="button" className="review-inline-link review-split-label" data-review-trigger={`project:${entry.projectId}`} aria-label={`查看项目「${arc.label}」的明细`} onClick={(event) => onOpen(entry.projectId, event.currentTarget)}>{name}</button>
              : <span className="review-split-label">{name}</span>);
          })}
          {rest.length > 0 && row(arcs[arcs.length - 1], <span className="review-split-label">另外 {rest.length} 个去处</span>)}
        </ul>}
      <div className="review-donut-wrap">
        <svg className="review-donut" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
          {total === 0
            ? <circle cx="50" cy="50" r="38" fill="none" stroke="var(--line-soft)" strokeWidth="22" />
            : arcs.map((arc) => <circle key={arc.key} cx="50" cy="50" r="38" fill="none" pathLength={100}
              stroke={arc.color} strokeWidth="22"
              strokeDasharray={`${Math.max(0, arc.percent - 0.9)} ${100 - Math.max(0, arc.percent - 0.9)}`}
              strokeDashoffset={-arc.offset}
              transform="rotate(-90 50 50)"
              className={`review-donut-arc${hot && hot !== arc.key ? " is-dim" : ""}`}
              onMouseEnter={() => setHot(arc.key)} onMouseLeave={() => setHot(null)} />)}
        </svg>
        <span className="review-donut-center" aria-hidden="true">
          <strong>{hotArc ? `${Math.round(hotArc.percent)}%` : Math.round(total / 60_000)}</strong>
          <span>{hotArc ? formatRecordedMs(hotArc.recordedMs) : "分钟"}</span>
        </span>
      </div>
    </div>
  </section>;
}

/** 周期标题按周期给出：日＝「今日回顾」（看别的日子才写日期），月＝「2026 年 8 月回顾」，
 *  周＝当前周说「本周」。日期本身已经在页头的小字里，标题不再重复一遍。 */
function periodTitle(period: ReviewPeriod, review: ReviewResult, today: string) {
  if (period === "day") return review.startDate === today ? "今日回顾" : `${formatDayLabel(review.startDate)}回顾`;
  if (period === "month") return `${new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(new Date(`${review.startDate}T12:00:00`))}回顾`;
  return review.days.some((day) => day.date === today) ? "本周回顾" : `${formatDayLabel(review.startDate)} — ${formatDayLabel(review.endDate)}回顾`;
}

function formatClock(iso: string) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

/** 周期边界与「本周」判断会随时间推移改变，页面自己按 30 秒节拍取本地时间（与截止页同一做法）。 */
function useCurrentTime() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(timer); }, []);
  return now;
}
