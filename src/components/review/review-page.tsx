import { ChartNoAxesColumnIncreasing, Check, ChevronDown, CircleAlert, Eraser, List, Maximize2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { Button } from "../ui/button";
import { FloatingPanel } from "../ui/floating-panel";
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
 * 页面顺序按规格固定：① 周期总览（三个数字 + 到期里程碑，原「成果与待续」段并进来）
 * → ② 投入和进度图 → ③ 任务／项目明细，最后是页面内明细区。它**只呈现** `review.ts` 的
 * 只读投影：不评分、不算连续天数、不把「未记录」读成失败，也不在组件里另写统计公式
 * （需要新派生值就加进引擎）。
 *
 * 状态归属：
 * - `reviewPeriod`／`reviewAnchorDate` 是**偏好**，经 App 的 `updatePreferences` 写进既有
 *   的 `SettingsRepository` 顺序写入队列（周期选择与翻页是唯一的持久化状态）。
 * - 项目筛选与明细选择只活在 App 层内存：同会话跨页返回有效，重启不恢复，不写 Store。
 */

const PERIODS: ReviewPeriod[] = ["day", "week", "month"];
/** 投入去向最多画几条；再多的合并成一行合计。 */
const SPLIT_PREVIEW = 6;
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
  // 顶部这张卡把单位换成「净进度」：一行放下「+10 净进度」，写「+10 百分点」再单起一行太长。
  // 数字仍由 formatPercentPoints 统一格式化（符号 + 四舍五入），这里只换单位词。
  const netDeltaValue = `${formatPercentPoints(review.progress.netDelta).replace(" 百分点", "")} 净进度`;

  const hasFacts = review.tasks.length > 0 || review.milestones.length > 0 || review.pendingReview.length > 0
    || review.notAdvanced.count > 0 || review.actual.runningRecords.length > 0;

  // 首屏只留「数字 + 里程碑」：里程碑数量由用户自己建，天然有限；待回顾与待续的数量不可控，
  // 所以不占首屏 —— 待回顾缩成一行提示（有才出现），名单进浮层；待续的名单本来就在明细里。
  // 这行提示守的是数据可信度：上面的投入只算「已记录」，没记录的时段得让人知道。
  const pendingNotice = review.pendingReview.length > 0 && review.actual.runningRecords.length > 0
    ? `${review.pendingReview.length} 个已结束的时段还没记录、${review.actual.runningRecords.length} 条还在进行中，都不计入上面的投入`
    : review.pendingReview.length > 0
      ? `${review.pendingReview.length} 个已结束的时段还没记录，不计入上面的投入`
      : review.actual.runningRecords.length > 0
        ? `${review.actual.runningRecords.length} 条执行还在进行中，不计入上面的投入`
        : null;

  /** 里程碑一行：名称／日期／达成态 + 结果文字。首屏只放第一条，完整列表在「详细」浮层里。 */
  const milestoneRow = (milestone: ReviewResult["milestones"][number]) => (
    <article key={milestone.milestoneId} className="review-milestone">
      <div className="review-milestone-head">
        <button type="button" className="review-inline-link" data-review-trigger={`project:${milestone.projectId}`} aria-label={`查看项目「${projectTitleOf(milestone.projectId)}」的明细`} onClick={(event) => openDetail({ kind: "project", id: milestone.projectId }, event.currentTarget)}>{milestone.title}</button>
        <time>{formatDayLabel(milestone.targetLocalDate)}</time>
        {/* 达成态不只靠色差：图标 + 文字两重编码，也不用失败红。 */}
        <span className={milestone.reached ? "review-tag" : "review-tag is-unmet"}>
          {milestone.reached ? <Check size={11} aria-hidden="true" /> : <CircleAlert size={11} aria-hidden="true" />}
          {milestone.reached ? "达成" : "未达成"}
        </span>
      </div>
      {/* 结果文字单独一行：和名称、日期挤在同一行时，「未达成」会被读两遍。 */}
      <p className="review-milestone-note">{milestone.frozen ? "到期冻结，后续推进不改写" : "当前达成情况"} · {milestone.resultText}</p>
    </article>
  );

  /** 待回顾的名单：首屏只留一行提示，名单在「查看」浮层里。 */
  const pendingList = <ul className="review-detail-list">
    {review.pendingReview.map((session) => <li key={session.id}>
      <button type="button" className="review-inline-link" data-review-trigger={`task:${session.taskId}`} aria-label={`查看任务「${titleOf(session.taskId)}」的明细`} onClick={(event) => openDetail({ kind: "task", id: session.taskId }, event.currentTarget)}>{titleOf(session.taskId)}</button>
      <time>{formatDayLabel(session.localDate)} {session.startLocal}–{session.endLocal}</time>
      {/* 时长由引擎算好：这一行要直接回答「现在要不要处理」。 */}
      <span className="review-tag">{session.durationMinutes} 分钟</span>
    </li>)}
    {/* 进行中的执行不是「待回顾」，但同样没有结束时间、同样不计入投入：并进这份名单，用标签区分。 */}
    {review.actual.runningRecords.map((record) => <li key={record.id}>
      <span className="review-tag">进行中</span>
      <button type="button" className="review-inline-link" data-review-trigger={`task:${record.taskId}`} aria-label={`查看任务「${titleOf(record.taskId)}」的明细`} onClick={(event) => openDetail({ kind: "task", id: record.taskId }, event.currentTarget)}>{titleOf(record.taskId)}</button>
      <time>开始于 {formatClock(record.actualStartUtc)}</time>
    </li>)}
  </ul>;

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
  /** 首屏两个浮层共用一套状态：里程碑「详细」与待回顾「查看」，同一时刻只开一个。 */
  const [headlinePanel, setHeadlinePanel] = useState<{ kind: "milestones" | "pending"; anchor: DOMRect } | null>(null);
  const toggleHeadlinePanel = (kind: "milestones" | "pending", trigger: HTMLElement) => {
    setHeadlinePanel((current) => current?.kind === kind ? null : { kind, anchor: trigger.getBoundingClientRect() });
  };
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
  /** 圆环与项目卡头同源取色：按「投入去向」的顺序取 `--chart-N`，前 6 个才有独立色，
   *  其余（含被折进「另外 N 个去处」的）用中性色 —— 与圆环里那一段的颜色一致。 */
  const projectColorOf = (id: string | null) => {
    const position = review.actual.byProject.slice(0, SPLIT_PREVIEW).findIndex((entry) => entry.projectId === id);
    return position === -1 ? "var(--line-strong)" : `var(--chart-${(position % 6) + 1})`;
  };

  /** 项目名用的**同色深版**：和色点同色相，但压到正文对比度达标（扇区色直接当字只有 2.4–3.9:1）。 */
  const projectInkOf = (id: string | null) => {
    const position = review.actual.byProject.slice(0, SPLIT_PREVIEW).findIndex((entry) => entry.projectId === id);
    return position === -1 ? "var(--muted-strong)" : `var(--chart-${(position % 6) + 1}-ink)`;
  };

  const splitChart = <SplitChart entries={review.actual.byProject} titleOf={(id) => id === null ? "独立任务" : projectTitleOf(id)} colorOf={projectColorOf}
    onOpen={(id, trigger) => id !== null && openDetail({ kind: "project", id }, trigger)} />;

  /** 一行任务：任务名 + 一行副标题（进度区间 · 投入 · 待续）。
   *  两行结构是照设置页的设置行来的：标题一行、说明一行，左列就不会空成一条缝。
   *  **行里不放写入口**：回顾页是只读投影，编辑与安排在下钻明细里 —— 那里带着原始事件、
   *  计划时段与备注，动作才有上下文；行内每行两个按钮会把明细区变成待办清单，200% 下
   *  还会把任务名挤到折行。行内只留「待续」这个**事实**标记。 */
  const taskRow = (detail: ReviewResult["tasks"][number]) => {
    const task = index.tasksById.get(detail.taskId);
    return <article className="review-detail-row" key={detail.taskId} data-review-task={detail.taskId}>
      <div className="review-detail-main">
        <strong className="review-detail-title">{task
          ? <button type="button" className="review-inline-link" data-review-trigger={`task:${detail.taskId}`} aria-label={`查看任务「${task.title}」的明细`} onClick={(event) => openDetail({ kind: "task", id: detail.taskId }, event.currentTarget)}>{task.title}</button>
          : <span>来源不可用</span>}</strong>
        <p className="review-detail-meta">
          <span className="review-detail-range">{formatTaskProgressRange(detail)}</span>
          <span className="review-detail-metric">投入 {formatRecordedMs(detail.recordedMs)}</span>
          {/* 「待续」和另外两个事实同一行：留在说明行里，右列就不会再出现一排按钮。 */}
          {detail.carryover && <span className="review-detail-flag">待续</span>}
        </p>
      </div>
    </article>;
  };

  /** 按项目分组：组按首次出现排，组内保持引擎给的顺序。分组只是展示顺序，
   *  组头的小计是把引擎已经算好的 `recordedMs` 相加，不引入新的口径。 */
  const taskGroups = (() => {
    const groups = new Map<string, { key: string; projectId: string | null; title: string; items: ReviewResult["tasks"] }>();
    for (const detail of review.tasks) {
      const key = detail.projectId ?? "__independent__";
      if (!groups.has(key)) {
        groups.set(key, { key, projectId: detail.projectId, title: detail.projectId ? projectTitleOf(detail.projectId) : "独立任务", items: [] });
      }
      groups.get(key)!.items.push(detail);
    }
    return [...groups.values()];
  })();

  const taskRows = review.tasks.length > 0
    ? <div className="review-task-groups">{taskGroups.map((group, groupIndex) => <section className="review-task-group" key={group.key} aria-labelledby={`review-group-${groupIndex}`}>
      <div className="review-task-group-head">
        {/* 色点与左边圆环的扇区同色：一眼能把这一组和圆环里那一块对上。 */}
        <span className="review-task-group-dot" style={{ background: projectColorOf(group.projectId) }} aria-hidden="true" />
        {/* 卡头就是项目的下钻入口：项目名从行里移到卡头，入口不能跟着消失。 */}
        <h3 id={`review-group-${groupIndex}`} style={{ color: projectInkOf(group.projectId) }}>{group.projectId
          ? <button type="button" className="review-inline-link" data-review-trigger={`project:${group.projectId}`} aria-label={`查看项目「${group.title}」的明细`} onClick={(event) => openDetail({ kind: "project", id: group.projectId! }, event.currentTarget)}>{group.title}</button>
          : group.title}</h3>
        <span className="review-task-group-count">{group.items.length} 项 · {formatRecordedMs(group.items.reduce((sum, item) => sum + item.recordedMs, 0))}</span>
      </div>
      <div className="review-detail-rows">{group.items.map(taskRow)}</div>
    </section>)}</div>
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

    {/* 首屏一行两块：左边三个数字，右边里程碑。
        里程碑是这一页唯一独占的信息（按周期聚合到期、达成态、冻结结果），而且数量由用户
        自己建、天然有限，所以敢放首屏；「继续推进」与「待回顾」的条数不可控（0 到十几个），
        放进固定高度的首屏必然把卡片撑高 —— 前者的名单本来就在 ③ 明细里，后者缩成一行提示。
        统计仍是 div + role=group：它是摘要，不是规格里的「一段」。 */}
    {hasFacts && <div className="review-headline-wrap">
    <div className="review-headline">
      <div className="review-stats" role="group" aria-label="本周期总览">
        <Stat kind="actual" value={formatRecordedMs(review.actual.recordedMs)} caption="实际投入" />
        <Stat kind="progress" value={netDeltaValue} caption={`${review.progress.changedTaskIds.length} 项有进度变化`} />
        <Stat kind="completed" value={`${review.progress.completedTaskIds.length} 项完成`} caption={`${review.carryoverTaskIds.length} 项仍可继续`} />
      </div>
      {review.milestones.length > 0 && <section className="review-milestone-cell" aria-labelledby="review-milestone-title">
        <div className="review-cell-head">
          <h2 id="review-milestone-title">里程碑<span className="review-block-count">{review.milestones.length}</span></h2>
          <button type="button" className="review-cell-more" aria-expanded={headlinePanel?.kind === "milestones"}
            onClick={(event) => toggleHeadlinePanel("milestones", event.currentTarget)}>查看全部</button>
        </div>
        {milestoneRow(review.milestones[0])}
      </section>}
    </div>
    </div>}

    {/* 待回顾不占块：一行说清「上面的数字是残缺的」，名单在「查看」浮层里。 */}
    {hasFacts && pendingNotice && <p className="review-pending-line">
      <CircleAlert size={13} aria-hidden="true" />
      <span>{pendingNotice}</span>
      <button type="button" className="review-cell-more" aria-expanded={headlinePanel?.kind === "pending"}
        onClick={(event) => toggleHeadlinePanel("pending", event.currentTarget)}>查看</button>
    </p>}

    {projectId !== null && <p className="review-scope" role="status">
      <span className="muted-chip">仅统计项目：{projectTitleOf(projectId)}</span>
      <Button onClick={() => onProjectId(null)}><Eraser size={14} />清除项目筛选</Button>
    </p>}

    {!hasFacts && <ReviewEmpty icon={<ChartNoAxesColumnIncreasing />} title="有实际推进后，这里会出现回顾" text="没有记录时不绘制全零图表，也不会把未记录解释为失败。" action={<Button variant="primary" onClick={onGoToday}>前往今日</Button>} />}

    {hasFacts && <>
      {/* ② 投入和进度图 + 投入去向：日视图没有「按天比较」的意义，圆环挪进下面的明细里当左栏。 */}
      {period !== "day" && <section className="surface-card review-charts" aria-labelledby="review-charts-title">
          {/* 周视图分两栏：左栏是标题（含切换与按钮）和柱状图，右栏是投入去向。
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
        </section>}

      {/* ③ 任务／项目明细：周／月只有项目与任务、占满整行；日视图把圆环收进左栏（上环下项目）。 */}
      <section className="review-tasks" aria-labelledby="review-tasks-title">
        <div className="section-heading"><h2 id="review-tasks-title">任务／项目明细</h2><span>{review.tasks.length} 项有事实</span></div>
        {period === "day"
          ? <div className="review-tasks-body">
            {splitChart}
            <div className="review-task-main">{taskRows}{notAdvanced}</div>
          </div>
          : <>{taskRows}{notAdvanced}</>}
      </section>
    </>}

    {/* 首屏两个浮层：里程碑的完整列表、待回顾的完整名单。用浮层而不是展开，
        是为了让首屏高度只由「有没有」决定，不由「有几条」决定。 */}
    {headlinePanel?.kind === "milestones" && <FloatingPanel kind="action" label="本周期到期的里程碑" anchor={headlinePanel.anchor}
      closeOnOutsideClick className="review-headline-popover" onClose={() => setHeadlinePanel(null)}>
      <div className="review-popover-list">{review.milestones.map(milestoneRow)}</div>
    </FloatingPanel>}
    {headlinePanel?.kind === "pending" && <FloatingPanel kind="action" label="还没有记录的时段" anchor={headlinePanel.anchor}
      closeOnOutsideClick className="review-headline-popover" onClose={() => setHeadlinePanel(null)}>
      {pendingList}
    </FloatingPanel>}

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
/** 统计卡固定两行：第一行「数字 + 单位」，第二行说这是什么。
 *  次要计数跟在第二行后面（同一行），不再单起一行 —— 三个卡高度才会一样。 */
function Stat({ kind, value, caption, detail }: { kind: "actual" | "progress" | "completed"; value: string; caption: string; detail?: string }) {
  const [amount, unit] = value.split(" ");
  return <div className="review-stat" data-review-stat={kind}>
    <span className="review-stat-value">{amount}{unit && <>{" "}<span className="review-stat-unit">{unit}</span></>}</span>
    <span className="review-stat-caption">{caption}{detail && <span className="review-stat-detail"> · {detail}</span>}</span>
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
function SplitChart({ entries, titleOf, colorOf, onOpen }: {
  entries: { projectId: string | null; recordedMs: number }[];
  titleOf: (projectId: string | null) => string;
  /** 与项目卡头的色点同源，保证圆环和右边那一组是同一个颜色。 */
  colorOf: (projectId: string | null) => string;
  onOpen: (projectId: string | null, trigger: HTMLElement) => void;
}) {
  const [hot, setHot] = useState<string | null>(null);
  const [extraOpen, setExtraOpen] = useState(false);
  const extraAnchor = useRef<HTMLButtonElement | null>(null);
  // 气泡宽度固定 16rem，打开时按「锚点右边缘 − 面板宽」算左上角，
  // 让气泡右边缘和「另外 N 个去处」这一行对齐；交给默认的左侧锚定会往右探出去。
  const [extraAnchorRect, setExtraAnchorRect] = useState<DOMRect | null>(null);
  const visible = entries.slice(0, SPLIT_PREVIEW);
  const rest = entries.slice(SPLIT_PREVIEW);
  const total = entries.reduce((sum, entry) => sum + entry.recordedMs, 0);
  const restMs = rest.reduce((sum, entry) => sum + entry.recordedMs, 0);

  const arcs: { key: string; label: string; recordedMs: number; color: string; percent: number; offset: number }[] = [];
  let cursor = 0;
  visible.forEach((entry, index) => {
    const percent = (entry.recordedMs / total) * 100;
    arcs.push({ key: entry.projectId ?? "independent", label: titleOf(entry.projectId), recordedMs: entry.recordedMs, color: colorOf(entry.projectId), percent, offset: cursor });
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

  return <section className="review-split" aria-label="投入去向">
    <div className="review-split-body">
      {total === 0
        // 没有记录时给一个空环：整块消失会让人以为这里本来就没有这个板块。
        ? <p className="review-split-empty">本期还没有记录投入</p>
        : <div className="review-split-main">
          <ul className="review-split-list">
            {visible.map((entry, index) => {
              const arc = arcs[index];
              const name = <span className="review-split-name">{arc.label}</span>;
              return row(arc, entry.projectId
                ? <button type="button" className="review-inline-link review-split-label" data-review-trigger={`project:${entry.projectId}`} aria-label={`查看项目「${arc.label}」的明细`} onClick={(event) => onOpen(entry.projectId, event.currentTarget)}>{name}</button>
                : <span className="review-split-label">{name}</span>);
            })}
            {/* 去处太多时折进气泡：点开才列全，不占版面、也不把卡片撑长。 */}
            {rest.length > 0 && <li className="review-split-more">
              <span className="review-split-dot" style={{ background: "var(--line-strong)" }} aria-hidden="true" />
              <button ref={extraAnchor} type="button" aria-expanded={extraOpen} onClick={(event) => {
                // 气泡和「投入去向」这一栏同宽、左右都对齐：左取图例的左边缘，右取整行的右边缘
                // （含分钟数那一列）。只锚一侧会显得浮在中间。
                const row = (event.currentTarget.closest("li") ?? event.currentTarget).getBoundingClientRect();
                const block = event.currentTarget.closest(".review-split")?.querySelector(".review-split-main");
                const rootRem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
                const blockLeft = block ? block.getBoundingClientRect().left : row.right - 16 * rootRem;
                // 太窄时保住最小宽度，但右边缘仍然钉在同一处 —— 否则右边会探出去。
                const width = Math.max(12 * rootRem, row.right - blockLeft);
                setExtraAnchorRect(new DOMRect(row.right - width, row.top, width, row.height));
                setExtraOpen(true);
              }}>
                另外 {rest.length} 个去处<ChevronDown size={13} aria-hidden="true" />
              </button>
              <span className="review-split-value">{formatRecordedMs(restMs)}</span>
            </li>}
          </ul>
        </div>}
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

    {extraOpen && <FloatingPanel kind="action" label={`另外 ${rest.length} 个去处`} anchor={extraAnchorRect} style={{ width: extraAnchorRect?.width }} closeOnOutsideClick
      className="review-split-popover" onClose={() => setExtraOpen(false)}>
      <ul className="review-split-popover-list">
        {rest.map((entry) => <li key={entry.projectId ?? "independent"}>
          <span className="review-split-name">{titleOf(entry.projectId)}</span>
          <span className="review-split-value">{formatRecordedMs(entry.recordedMs)}</span>
        </li>)}
      </ul>
    </FloatingPanel>}
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
