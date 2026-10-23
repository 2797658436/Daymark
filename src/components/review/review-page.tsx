import { ChartNoAxesColumnIncreasing, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Eraser, List, Maximize2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { Button } from "../ui/button";
import { FloatingPanel } from "../ui/floating-panel";
import { ReviewChart, type ReviewChartRow } from "./review-chart";
import { ReviewDetail, formatDayLabel, reviewDetailLabel, type ReviewSelection } from "./review-detail";
import { ReviewPeriodPicker } from "./review-period-picker";
import { addLocalDays, addLocalMonths, localDateOf } from "../../lib/deadlines";
import {
  REVIEW_BACK_LABEL, REVIEW_CURRENT_LABEL, REVIEW_PERIOD_LABEL, buildReviewFromIndex, formatPercentPoints, formatRecordedMs,
  formatTaskProgressRange, type ReviewPeriod, type ReviewResult,
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
/** 页头步进器的读屏名：周期不同，单位不同（「前一天」不说成「上一周期」）。 */
const PERIOD_STEP_LABEL: Record<ReviewPeriod, { previous: string; next: string }> = {
  day: { previous: "前一天", next: "后一天" },
  week: { previous: "上一周", next: "下一周" },
  month: { previous: "上个月", next: "下个月" },
};
/** 月标题的格式化器：Intl.DateTimeFormat 构造很贵，模块级只建一次（P4-09 的同类修复）。 */
const MONTH_TITLE_FORMAT = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" });
/** 投入去向的图例最多排几行：**行数**固定，超出才折进「另外 N 个去处」。
 *  单列（周视图那一栏）维持 6 条 —— 它挨着 9.375rem 的圆环，6 行正好和环同高；
 *  多列时按「列数 × 4 行」算，月视图三列能放 12 条，不必把放得下的项目折起来
 *  （2026-10-21 用户反馈：三列时明明放得下还在折叠）。 */
const SPLIT_MIN_ITEMS = 6;
const SPLIT_MAX_ROWS = 4;
/** 圆环只有 6 个扇区色（`--chart-1..6`）：第 7 个起统一用中性色，和环里的「其余」同色。 */
const SPLIT_PALETTE = 6;
/** 与 CSS `.review-split-list li { flex: 1 1 15rem }`、`gap: 6px 24px` 同源。 */
const SPLIT_ITEM_BASIS_REM = 15;
const SPLIT_ITEM_GAP = 24;
/** 周视图的刻度要带星期：只有 7 列，放得下「周一 10月19日」。 */
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

  const isCurrentPeriod = review.days.some((day) => day.date === today);
  /** 页头标题只写周期本身：当前周期不再靠「本周」这类相对词区分，而由标题右侧的徽标说明；
   *  日期因此只出现一次（旧版 eyebrow 与 h1 各写一遍，切到别的日／周时左上角重复）。 */
  const periodHeading = period === "day"
    ? formatDayLabel(review.startDate)
    : period === "week"
      ? `${formatDayLabel(review.startDate)} — ${formatDayLabel(review.endDate)}`
      : MONTH_TITLE_FORMAT.format(new Date(`${review.startDate}T12:00:00`));
  /** 日视图在日期旁补一个星期：光有「8月4日」时，快速扫页头分不清周几。 */
  const periodWeekday = period === "day" ? WEEKDAY_LABEL[new Date(`${review.startDate}T12:00:00`).getDay()] : null;
  /** 上一／下一周期：日 ±1 天、周 ±7 天、月 ±1 个自然月；写显式锚点，与周期选择器同一通道。 */
  const shiftPeriod = (direction: -1 | 1) => {
    const nextAnchor = period === "day"
      ? addLocalDays(review.startDate, direction)
      : period === "week"
        ? addLocalDays(review.startDate, direction * 7)
        : addLocalMonths(review.startDate, direction);
    onPreferences({ reviewAnchorDate: nextAnchor });
  };

  const triggerRef = useRef<HTMLElement | null>(null);
  const triggerKeyRef = useRef<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  /** 「回到当前周期」按下后它会被徽标替换、从 DOM 里消失：标记一下，等真的回到当前
   *  周期再把焦点交给页面标题，键盘用户不会掉到 body。 */
  const returningToCurrent = useRef(false);
  useEffect(() => {
    if (!returningToCurrent.current || !isCurrentPeriod) return;
    returningToCurrent.current = false;
    headingRef.current?.focus({ preventScroll: true });
  }, [isCurrentPeriod]);
  const restored = useRef(false);
  /** 明细气泡的锚点：触发元素本身（找不到就退到页面标题）。
   *  用 layout effect 在**绘制前**算好，气泡才不会先居中再跳到任务名下面。 */
  const [detailAnchorElement, setDetailAnchorElement] = useState<HTMLElement | null>(null);
  /** 用矩形定位时的锚（触发元素已随气泡卸载的情况）；正常下钻仍用 `detailAnchorElement`。 */
  const [detailAnchorRect, setDetailAnchorRect] = useState<DOMRect | null>(null);

  // 进入页面先恢复上次的滚动位置（同会话跨页返回有效；重启后 ref 归零，自然回到顶部）。
  useLayoutEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const container = scrollRef.current;
    if (container) container.scrollTop = scrollTop.current;
  }, [scrollRef, scrollTop]);

  // 明细是气泡：打开时不滚动、不抢页面位置，只在切页返回时把锚点重新找回来。
  // `anchorRectRef` 优先：从「详细」气泡里下钻时，触发元素会随气泡一起卸载，
  // 只能用气泡当时的位置当锚（否则明细会落到视口左上角）。
  const anchorRectRef = useRef<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!selection) { setDetailAnchorElement(null); setDetailAnchorRect(null); return; }
    if (anchorRectRef.current) {
      setDetailAnchorElement(null);
      setDetailAnchorRect(anchorRectRef.current);
      anchorRectRef.current = null;
      return;
    }
    const key = `${selection.kind}:${selection.id}`;
    const element = triggerKeyRef.current === key && triggerRef.current?.isConnected
      ? triggerRef.current
      : document.querySelector<HTMLElement>(`[data-review-trigger="${key}"]`) ?? headingRef.current;
    setDetailAnchorRect(null);
    setDetailAnchorElement(element);
  }, [selection]);

  // 气泡要落在**触发元素下面**（浮层在下方面积不够时会翻到上面、把列表盖住）。
  // 打开时先量一次：下方不够就把页面滚出一点空间（能滚多少算多少），再按剩下的空间
  // 给气泡定高 —— 高不过可用空间，正文在气泡里滚，永远不会盖住触发它的那一行。
  const [detailMaxHeight, setDetailMaxHeight] = useState<number | undefined>(undefined);
  /** 首屏两个浮层共用一套状态：里程碑「其余 N 个」与待回顾「查看」，同一时刻只开一个。 */
  const [headlinePanel, setHeadlinePanel] = useState<{ kind: "milestones" | "pending"; anchor: DOMRect } | null>(null);

  // 滚动位置只在内存里跟手记录：不写 Store，也不触发重渲染。
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const record = () => { scrollTop.current = container.scrollTop; };
    container.addEventListener("scroll", record, { passive: true });
    return () => container.removeEventListener("scroll", record);
  }, [scrollRef, scrollTop]);

  const openDetail = useCallback((next: ReviewSelection, trigger: HTMLElement | null, anchorRect?: DOMRect) => {
    triggerRef.current = trigger;
    // 触发元素的身份（`kind:id`）：切页返回或继续下钻后原节点已经不在了，
    // 关闭时按它重新找同一个目标（与截止页用 `data-deadline-key` 找回焦点行同理）。
    triggerKeyRef.current = `${next.kind}:${next.id}`;
    const rect = anchorRect ?? trigger?.getBoundingClientRect();
    const target = Math.min(window.innerHeight * 0.86, 620);
    if (anchorRect) {
      // 锚是**已经卸载的 fixed 气泡**：滚动页面不会让它上移，所以不能靠「滚出空间」这一招，
      // 高度直接按上下哪边更宽裕来定（浮层会自己翻到放得下的那一侧）。
      const below = window.innerHeight - anchorRect.bottom - 20;
      const above = anchorRect.top - 20;
      setDetailMaxHeight(Math.max(240, Math.min(Math.max(below, above), target) - 6));
    } else if (rect) {
      const container = scrollRef.current;
      const room = window.innerHeight - rect.bottom - 20;
      // 只滚「补到 target 为止」的那一点，且不越过页面还能滚的距离。
      const gain = container
        ? Math.min(Math.max(0, container.scrollHeight - container.clientHeight - container.scrollTop), Math.max(0, target - room))
        : 0;
      if (gain > 0 && container) container.scrollTop += gain;
      // 再让 6px：浮层的判据是「top + 高度 > 视口 − 12」，正好贴边会因为小数进位翻到上面去。
      setDetailMaxHeight(Math.max(240, Math.min(room + gain, target) - 6));
    }
    // 位置已经由矩形决定时，不要让 `detailAnchorElement` 抢过去。
    anchorRectRef.current = anchorRect ?? null;
    setDetailAnchorElement(anchorRect ? null : trigger);
    setDetailAnchorRect(anchorRect ?? null);
    onSelection(next);
  }, [onSelection, scrollRef]);

  /** 关闭明细：查询不变、页面不动，焦点回到触发元素（找不到就退到页面标题）。 */
  const closeDetail = useCallback(() => {
    const trigger = triggerRef.current;
    onSelection(null);
    // 明细可能是从首屏浮层（里程碑「其余 N 个」／待回顾「查看」）里点开的，那层浮层还开着：
    // 一并收起。否则点空白只关掉上面那层，名单留在原地，看起来像「没关掉」。
    setHeadlinePanel(null);
    // 原触发元素还在就直接用它；否则按身份找同一个目标；再不行退到页面标题 ——
    // 不调用已断开的节点，键盘用户也不会掉到 body。
    const target = trigger?.isConnected
      ? trigger
      : document.querySelector<HTMLElement>(`[data-review-trigger="${triggerKeyRef.current}"]`);
    (target ?? headingRef.current)?.focus({ preventScroll: true });
  }, [onSelection]);

  const titleOf = (taskId: string) => index.tasksById.get(taskId)?.title ?? "来源不可用";
  const projectTitleOf = (id: string) => index.projectsById.get(id)?.title ?? "来源不可用";

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
        <button type="button" className="review-inline-link" data-review-trigger={`project:${milestone.projectId}`} aria-label={`查看项目「${projectTitleOf(milestone.projectId)}」的明细`} title={milestone.title} onClick={(event) => openDetail({ kind: "project", id: milestone.projectId }, event.currentTarget)}>{milestone.title}</button>
        <time>{formatDayLabel(milestone.targetLocalDate)}</time>
        {/* 达成态不只靠色差：图标 + 文字两重编码，也不用失败红。 */}
        <span className={milestone.reached ? "review-tag" : "review-tag is-unmet"}>
          {milestone.reached ? <Check size={11} aria-hidden="true" /> : <CircleAlert size={11} aria-hidden="true" />}
          {milestone.reached ? "达成" : "未达成"}
        </span>
      </div>
      {/* 结果文字单独一行：和名称、日期挤在同一行时，「未达成」会被读两遍。 */}
      <p className="review-milestone-note" title={`${milestone.frozen ? "到期冻结，后续推进不改写" : "当前达成情况"} · ${milestone.resultText}`}>{milestone.frozen ? "到期冻结，后续推进不改写" : "当前达成情况"} · {milestone.resultText}</p>
    </article>
  );

  /** 待回顾的名单：首屏只留一行提示，名单在「查看」浮层里。 */
  const pendingList = <ul className="review-detail-list">
    {review.pendingReview.map((session) => <li key={session.id}>
      <button type="button" className="review-inline-link" data-review-trigger={`task:${session.taskId}`} aria-label={`查看任务「${titleOf(session.taskId)}」的明细`} title={titleOf(session.taskId)} onClick={(event) => openDetail({ kind: "task", id: session.taskId }, event.currentTarget)}>{titleOf(session.taskId)}</button>
      <time>{formatDayLabel(session.localDate)} {session.startLocal}–{session.endLocal}</time>
      {/* 时长由引擎算好：这一行要直接回答「现在要不要处理」。 */}
      <span className="review-tag">{session.durationMinutes} 分钟</span>
    </li>)}
    {/* 进行中的执行不是「待回顾」，但同样没有结束时间、同样不计入投入：并进这份名单，用标签区分。 */}
    {review.actual.runningRecords.map((record) => <li key={record.id}>
      <span className="review-tag">进行中</span>
      <button type="button" className="review-inline-link" data-review-trigger={`task:${record.taskId}`} aria-label={`查看任务「${titleOf(record.taskId)}」的明细`} title={titleOf(record.taskId)} onClick={(event) => openDetail({ kind: "task", id: record.taskId }, event.currentTarget)}>{titleOf(record.taskId)}</button>
      <time>开始于 {formatClock(record.actualStartUtc)}</time>
    </li>)}
  </ul>;

  const tickOf = (date: string) => {
    if (period === "day") return formatDayLabel(date);
    // 周视图只有 7 列，放得下「周一 10月19日」；月视图 31 列只留日号。
    if (period === "week") return `${WEEKDAY_LABEL[new Date(`${date}T12:00:00`).getDay()]} ${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
    return String(Number(date.slice(8, 10)));
  };
  /** 200% 缩放下列宽只剩一半：「周一 10月19日」会叠在一起，退成「周一」。 */
  const shortTickOf = (date: string) => period === "week" ? WEEKDAY_LABEL[new Date(`${date}T12:00:00`).getDay()] : undefined;
  // 今天与未来要分开着色：未来还没到，画成和「做过但没记录」一样的灰会误读成漏记。
  const columnState = (date: string) => ({ isToday: date === today, isFuture: date > today });
  const minuteRows: ReviewChartRow[] = review.days.map((day) => ({
    date: day.date,
    value: day.recordedMinutes,
    // 0 分钟说「未记录」：没有记录不等于 0% 执行率，也不画零柱。
    label: day.recordedMinutes > 0 ? `${day.recordedMinutes} 分钟` : "未记录",
    tick: tickOf(day.date),
    tickShort: shortTickOf(day.date),
    fullLabel: formatDayLabel(day.date),
    ...columnState(day.date),
  }));
  const deltaRows: ReviewChartRow[] = review.days.map((day) => ({
    date: day.date,
    value: day.progressDelta,
    label: formatPercentPoints(day.progressDelta),
    tick: tickOf(day.date),
    tickShort: shortTickOf(day.date),
    fullLabel: formatDayLabel(day.date),
    ...columnState(day.date),
  }));

  // 投入与净进度共用一张图：同一批日期、同一个时间轴，切成两个数值看。
  // 合并后省掉一整行，也避免两张图各自的坐标轴互相对齐。
  const [metric, setMetric] = useState<"minutes" | "delta">("minutes");
  const [expanded, setExpanded] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const toggleHeadlinePanel = (kind: "milestones" | "pending", trigger: HTMLElement) => {
    // 里程碑浮层是「这一格展开」而不是「挂在按钮下面」：锚到整格、宽度也取整格，
    // 左右边缘与卡片对齐（用户 2026-10-20 要求），看起来才像同一张卡展开。
    const rect = kind === "milestones"
      ? (trigger.closest<HTMLElement>(".review-milestone-cell") ?? trigger).getBoundingClientRect()
      : trigger.getBoundingClientRect();
    setHeadlinePanel((current) => current?.kind === kind ? null : { kind, anchor: rect });
  };
  const detailAnchor = useRef<HTMLButtonElement | null>(null);
  const isMinutes = metric === "minutes";
  const chartRows = isMinutes ? minuteRows : deltaRows;
  const chartTitle = isMinutes ? "实际投入" : "净进度变化";
  const chartUnit = isMinutes ? "分钟" : "百分点";

  /** 月视图的「详细」是一张月历：1 号前面按周几空格，每格是日号 + 当天的值。
   *  **周一起头**：主月历与周期选择器都是周一开头，回顾里的月历不能单独改成周日开头
   *  （同一页两套周起始，读日期时会差一天）。 */
  const monthGrid = period === "month" ? {
    leading: (new Date(`${review.startDate}T12:00:00`).getDay() + 6) % 7,
    cells: review.days.map((day) => ({
      date: day.date,
      dayOfMonth: Number(day.date.slice(8, 10)),
      fullLabel: formatDayLabel(day.date),
      // 没有记录就留一个「-」：月历格子窄，「未记录」三个字会把整行撑满，也不该写成 0。
      minutes: day.recordedMinutes > 0 ? `${day.recordedMinutes}` : "-",
      hasRecord: day.recordedMinutes > 0,
      delta: formatPercentPoints(day.progressDelta).replace(" 百分点", ""),
      ...columnState(day.date),
    })),
  } : undefined;

  const weekDetail = period === "week" ? review.days.map((day) => ({
    date: day.date,
    fullLabel: formatDayLabel(day.date),
    weekday: WEEKDAY_LABEL[new Date(`${day.date}T12:00:00`).getDay()],
    minutes: day.recordedMinutes > 0 ? `${day.recordedMinutes} 分钟` : "未记录",
    delta: formatPercentPoints(day.progressDelta),
  })) : undefined;

  // 图表的标题行：只留「切换 + 按钮」。单位挪到图右下角（2026-10-22 用户要求），
  // 标题行不再被「单位：百分点」挤到换行。
  const chartsHeading = <div className="section-heading review-charts-head">
    <h2 id="review-charts-title">投入和进度</h2>
    <div className="review-charts-tools">
      <div className="review-charts-group">
        <div className="segmented review-metric-switch" role="group" aria-label="图表数值">
          <button type="button" aria-pressed={isMinutes} className={isMinutes ? "active" : ""} onClick={() => setMetric("minutes")}>实际投入</button>
          <button type="button" aria-pressed={!isMinutes} className={!isMinutes ? "active" : ""} onClick={() => setMetric("delta")}>净进度</button>
        </div>
      </div>
      <div className="review-charts-group">
        {/* 周是四列数值表、月是月历，都由这一个按钮打开（2026-10-20 起月视图不再有折叠表）。 */}
        {period !== "day" && <button ref={detailAnchor} type="button" className="review-chart-expand" aria-expanded={detailOpen}
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
    splitDetail={weekDetail}
    monthGrid={monthGrid}
    onOpenDate={(date, trigger, anchor) => openDetail({ kind: "date", id: date }, trigger, anchor)}
    expanded={expanded} onExpand={setExpanded}
    detailOpen={detailOpen} onDetailOpen={setDetailOpen} detailAnchor={detailAnchor} />;

  // 没有记录时也给一个「0 分钟」的占位圆环：比整块消失更能说明「这里本来该有东西」。
  /** 圆环与项目卡头同源取色：按「投入去向」的顺序取 `--chart-N`，前 6 个才有独立色，
   *  其余（含被折进「另外 N 个去处」的）用中性色 —— 与圆环里那一段的颜色一致。 */
  const projectColorOf = (id: string | null) => {
    const position = review.actual.byProject.slice(0, SPLIT_PALETTE).findIndex((entry) => entry.projectId === id);
    return position === -1 ? "var(--line-strong)" : `var(--chart-${(position % 6) + 1})`;
  };

  /** 项目名用的**同色深版**：和色点同色相，但压到正文对比度达标（扇区色直接当字只有 2.4–3.9:1）。 */
  const projectInkOf = (id: string | null) => {
    const position = review.actual.byProject.slice(0, SPLIT_PALETTE).findIndex((entry) => entry.projectId === id);
    return position === -1 ? "var(--muted-strong)" : `var(--chart-${(position % 6) + 1}-ink)`;
  };

  const splitChart = <SplitChart entries={review.actual.byProject} titleOf={(id) => id === null ? "独立任务" : projectTitleOf(id)} colorOf={projectColorOf}
    /* 没有记录时只说一次：周／月视图左半边已经写了「不绘制全零图表」，右边空环就够，
       再补一句「本期还没有记录投入」等于同一件事说两遍（2026-10-20 实测）。 */
    showEmptyNote={period === "day"}
    onOpen={(id, trigger) => id !== null && openDetail({ kind: "project", id }, trigger)} />;

  /** 一行任务：任务名 + 一行副标题（进度区间 · 投入 · 待续）。
   *  两行结构是照设置页的设置行来的：标题一行、说明一行，左列就不会空成一条缝。
   *  **行里不放写入口**：回顾页是只读投影，编辑与安排在下钻明细里 —— 那里带着原始事件、
   *  计划时段与备注，动作才有上下文；行内每行两个按钮会把明细区变成待办清单，200% 下
   *  还会把任务名挤到折行。行内只留「待续」这个**事实**标记 —— 放在任务名前面：
   *  它是这一行的结论（要不要接着做），先于名字被扫到；跟在第二行末尾时会被进度数字盖住。 */
  const taskRow = (detail: ReviewResult["tasks"][number]) => {
    const task = index.tasksById.get(detail.taskId);
    return <article className="review-detail-row" key={detail.taskId} data-review-task={detail.taskId}>
      <div className="review-detail-main">
        <strong className="review-detail-title">
          {detail.carryover && <span className="review-detail-flag">待续</span>}
          {task
            ? <button type="button" className="review-inline-link" data-review-trigger={`task:${detail.taskId}`} aria-label={`查看任务「${task.title}」的明细`} title={task.title} onClick={(event) => openDetail({ kind: "task", id: detail.taskId }, event.currentTarget)}>{task.title}</button>
            : <span>来源不可用</span>}
        </strong>
        <p className="review-detail-meta">
          <span className="review-detail-range">{formatTaskProgressRange(detail)}</span>
          <span className="review-detail-metric">投入 {formatRecordedMs(detail.recordedMs)}</span>
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
          ? <button type="button" className="review-inline-link" data-review-trigger={`project:${group.projectId}`} aria-label={`查看项目「${group.title}」的明细`} title={group.title} onClick={(event) => openDetail({ kind: "project", id: group.projectId! }, event.currentTarget)}>{group.title}</button>
          : group.title}</h3>
        {/* 「N 项 · 合计」：合计为 0 时只留项数 —— 「1 项 · 未记录」会被读成「1 项没记录」。 */}
        <span className="review-task-group-count">{group.items.length} 项{(() => {
          const recorded = group.items.reduce((sum, item) => sum + item.recordedMs, 0);
          return recorded > 0 ? ` · ${formatRecordedMs(recorded)}` : "";
        })()}</span>
      </div>
      <div className="review-detail-rows">{group.items.map(taskRow)}</div>
    </section>)}</div>
    : <p className="review-muted">本周期没有任务事实。</p>;

  // 明确未推进／跳过／取消安排分别说明：它们是用户显式给出的结果，不是时间流逝的推断。
  const notAdvanced = review.notAdvanced.count > 0 && <div className="review-not-advanced">
    <h3>明确未推进与跳过</h3>
    <ul className="review-detail-list">
      {review.notAdvanced.missedSessions.map((session) => <li key={session.id}><span className="review-tag">明确未推进</span><span title={titleOf(session.taskId)}>{titleOf(session.taskId)}</span><time>{formatDayLabel(session.localDate)} {session.startLocal}–{session.endLocal}</time></li>)}
      {review.notAdvanced.skippedSessions.map((session) => <li key={session.id}><span className="review-tag">跳过</span><span title={titleOf(session.taskId)}>{titleOf(session.taskId)}</span><time>{formatDayLabel(session.localDate)} {session.startLocal}–{session.endLocal}</time></li>)}
      {review.notAdvanced.cancelledSessions.map((session) => <li key={session.id}><span className="review-tag">取消安排</span><span title={titleOf(session.taskId)}>{titleOf(session.taskId)}</span><time>{formatDayLabel(session.localDate)} {session.startLocal}–{session.endLocal}</time></li>)}
      {review.notAdvanced.skippedOccurrences.map((occurrence) => {
        const title = index.workspace.recurringHabits.find((habit) => habit.id === occurrence.habitId)?.title ?? "来源不可用";
        return <li key={occurrence.id}><span className="review-tag">跳过</span><span title={title}>{title}</span><time>{formatDayLabel(occurrence.localDate)}</time></li>;
      })}
    </ul>
  </div>;

  return <section className="page-stack review-page" aria-labelledby="review-title">
    <header className="page-header review-page-header">
      {/* 页头不再放 eyebrow：主导航已经高亮「回顾」，标题就是周期本身；
          多一行小字只会让左上角显得头重（2026-10-22 用户反馈）。
          周期标题本身就是步进器：< > 紧贴日期，回到当前周期跟在后面；
          「选择日期」和「日／周／月」仍在页头右侧，位置不变。 */}
      <div className="review-period-row">
        <button type="button" className="review-period-step" aria-label={PERIOD_STEP_LABEL[period].previous}
          onClick={() => shiftPeriod(-1)}><ChevronLeft aria-hidden="true" /></button>
        {/* aria-live：点箭头换周期时焦点仍在按钮上，读屏用户需要听到新周期。 */}
        <h1 id="review-title" ref={headingRef} tabIndex={-1} className="review-period-title" aria-live="polite">
          {periodHeading}
          {periodWeekday && <span className="review-period-weekday">{periodWeekday}</span>}
        </h1>
        <button type="button" className="review-period-step" aria-label={PERIOD_STEP_LABEL[period].next}
          onClick={() => shiftPeriod(1)}><ChevronRight aria-hidden="true" /></button>
        {/* 当前周期用安静的状态徽标；离开当前周期时同一个位置换成动作，两者不会同时出现。 */}
        {isCurrentPeriod
          ? <span className="review-current-badge">{REVIEW_CURRENT_LABEL[period]}</span>
          : <button type="button" className="review-back-current" onClick={() => { returningToCurrent.current = true; onPreferences({ reviewAnchorDate: null }); }}>{REVIEW_BACK_LABEL[period]}</button>}
      </div>
      <div className="header-actions">
        <div className="segmented" role="group" aria-label="回顾周期">
          {PERIODS.map((option) => <button key={option} aria-pressed={period === option} className={period === option ? "active" : ""} onClick={() => onPreferences({ reviewPeriod: option })}>{REVIEW_PERIOD_LABEL[option]}</button>)}
        </div>
        <ReviewPeriodPicker period={period} anchorDate={anchorDate} today={today}
          onSelect={(nextPeriod, nextAnchor) => onPreferences({ reviewPeriod: nextPeriod, reviewAnchorDate: nextAnchor })} />
      </div>
    </header>

    {/* 首屏一行两块：左边三个数字，右边里程碑。
        里程碑是这一页唯一独占的信息（按周期聚合到期、达成态、冻结结果），而且数量由用户
        自己建、天然有限，所以敢放首屏；「继续推进」与「待回顾」的条数不可控（0 到十几个），
        放进固定高度的首屏必然把卡片撑高 —— 前者的名单本来就在 ③ 明细里，后者缩成一行提示。
        统计仍是 div + role=group：它是摘要，不是规格里的「一段」。 */}
    {hasFacts && <div className="review-headline-wrap">
    <div className="review-headline">
      <div className="review-stats-wrap">
        <div className="review-stats" role="group" aria-label="本周期总览">
          <Stat kind="actual" value={formatRecordedMs(review.actual.recordedMs)} caption="实际投入" />
          <Stat kind="progress" value={netDeltaValue} caption={`${review.progress.changedTaskIds.length} 项有进度变化`} />
          <Stat kind="completed" value={`${review.progress.completedTaskIds.length} 项完成`} caption={`${review.carryoverTaskIds.length} 项仍可继续`} />
        </div>
      </div>
      {review.milestones.length > 0 && <section className="review-milestone-cell" aria-labelledby="review-milestone-title">
        <div className="review-cell-head">
          <h2 id="review-milestone-title">里程碑<span className="review-block-count">{review.milestones.length}</span></h2>
          {/* 这一格已经写着第一条：浮层只补**其余的**，不把同一条再说一遍。
              只有一条时没有「其余」，按钮整个不出现。 */}
          {review.milestones.length > 1 && <button type="button" className="review-cell-more" aria-expanded={headlinePanel?.kind === "milestones"}
            onClick={(event) => toggleHeadlinePanel("milestones", event.currentTarget)}>其余 {review.milestones.length - 1} 个</button>}
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
    {headlinePanel?.kind === "milestones" && <FloatingPanel kind="action" label={`其余 ${review.milestones.length - 1} 个里程碑`} anchor={headlinePanel.anchor}
      closeOnOutsideClick className="review-headline-popover" style={{ width: headlinePanel.anchor.width }} onClose={() => setHeadlinePanel(null)}>
      {/* 首屏那条不再重复：名单里只有第 2 条起。 */}
      <div className="review-popover-list">{review.milestones.slice(1).map(milestoneRow)}</div>
    </FloatingPanel>}
    {headlinePanel?.kind === "pending" && <FloatingPanel kind="action" label="还没有记录的时段" anchor={headlinePanel.anchor}
      closeOnOutsideClick className="review-headline-popover" onClose={() => setHeadlinePanel(null)}>
      {pendingList}
    </FloatingPanel>}

    {/* 明细是气泡而不是页内区域：锚在触发元素（任务名／项目名／那一天的柱子）下面，
        点空白、点别的板块、Esc 都关掉它 —— 页面本身不滚动、不位移，看完就消失。 */}
    {selection && <FloatingPanel kind="action" className="review-detail-panel" titleId="review-detail-title"
      label={reviewDetailLabel(selection, index)} anchor={detailAnchorRect} anchorElement={detailAnchorElement} closeOnOutsideClick
      style={detailMaxHeight ? { maxHeight: detailMaxHeight } : undefined} onClose={closeDetail}>
      <ReviewDetail index={index} review={review} selection={selection} projectId={projectId}
        onClose={closeDetail} onEditTask={onEditTask} onArrangeTask={onArrangeTask} onOpenProject={onOpenProject} onProjectId={onProjectId}
        onOpenTask={(taskId, trigger) => openDetail({ kind: "task", id: taskId }, trigger)} />
    </FloatingPanel>}
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

/** 图例现在排几列：`.review-split-list` 是 `flex-wrap`，每行能放几条只由宽度和
 *  `flex-basis` 决定（`floor((宽 + 间距) / (基准 + 间距))`）。列数变了要重算能放几条，
 *  所以除了 ResizeObserver，还要盯根字号（界面缩放改的是根字号，元素的 px 宽度不变）。
 *  jsdom 没有布局：`clientWidth` 恒为 0 时保留 1 列，测试才有确定性。 */
function useLegendColumns(itemCount: number) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const [columns, setColumns] = useState(1);

  useLayoutEffect(() => {
    const node = listRef.current;
    if (!node) return;
    const measure = () => {
      if (node.clientWidth === 0) return;
      const rootRem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const basis = SPLIT_ITEM_BASIS_REM * rootRem;
      setColumns(Math.max(1, Math.floor((node.clientWidth + SPLIT_ITEM_GAP) / (basis + SPLIT_ITEM_GAP))));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    const mutation = new MutationObserver(measure);
    mutation.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-scale"] });
    return () => { observer?.disconnect(); mutation.disconnect(); };
  }, [itemCount]);

  return { listRef, columns };
}

/**
 * 投入去向：圆环 + 图例。
 *
 * 和上面两张图共用「一个单位」的规矩（分钟），但没有日期维度，所以用圆环直接比较
 * 各部分占多少。圆环用 SVG 分段（每段可单独悬停），对辅助技术隐藏（`aria-hidden`），
 * 可读的等价物是左边那列图例；悬停某一段或某一行时，环心换成那一段的百分比。
 * 项目名可点，进入该项目在本周期的明细。
 */
function SplitChart({ entries, titleOf, colorOf, showEmptyNote, onOpen }: {
  entries: { projectId: string | null; recordedMs: number }[];
  titleOf: (projectId: string | null) => string;
  /** 与项目卡头的色点同源，保证圆环和右边那一组是同一个颜色。 */
  colorOf: (projectId: string | null) => string;
  /** 空环旁边要不要再写一句「本期还没有记录投入」（日视图独占一块卡时才需要）。 */
  showEmptyNote: boolean;
  onOpen: (projectId: string | null, trigger: HTMLElement) => void;
}) {
  const [hot, setHot] = useState<string | null>(null);
  const [extraOpen, setExtraOpen] = useState(false);
  const extraAnchor = useRef<HTMLButtonElement | null>(null);
  // 气泡宽度固定 16rem，打开时按「锚点右边缘 − 面板宽」算左上角，
  // 让气泡右边缘和「另外 N 个去处」这一行对齐；交给默认的左侧锚定会往右探出去。
  const [extraAnchorRect, setExtraAnchorRect] = useState<DOMRect | null>(null);
  // 图例按可用宽度自动分列（CSS `flex: 1 1 15rem`），**列数决定不折叠能放几条**：
  // 固定「行数」而不是「条数」，三列时才不会把放得下的项目折起来。
  const { listRef, columns } = useLegendColumns(entries.length);
  const capacity = Math.max(SPLIT_MIN_ITEMS, columns * SPLIT_MAX_ROWS);
  const folded = entries.length > capacity;
  // 折叠时最后一条的位置留给「另外 N 个去处」，整块仍然正好是 N 行。
  const visible = entries.slice(0, folded ? capacity - 1 : entries.length);
  const rest = entries.slice(visible.length);
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
        ? (showEmptyNote ? <p className="review-split-empty">本期还没有记录投入</p> : null)
        : <div className="review-split-main">
          <ul className="review-split-list" ref={listRef}>
            {visible.map((entry, index) => {
              const arc = arcs[index];
              // 图例只放得下一行：超长的项目名用省略号收住，完整名称挂在 title 上（悬停可见）。
              const name = <span className="review-split-name" title={arc.label}>{arc.label}</span>;
              return row(arc, entry.projectId
                ? <button type="button" className="review-inline-link review-split-label" data-review-trigger={`project:${entry.projectId}`} aria-label={`查看项目「${arc.label}」的明细`} title={arc.label} onClick={(event) => onOpen(entry.projectId, event.currentTarget)}>{name}</button>
                : <span className="review-split-label" title={arc.label}>{name}</span>);
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
                // 也要有上限：月／日视图的图例是整行宽，跟着整行算会得到 800 多像素的
                // 大气泡、四行内容摊在两端（2026-10-20 实测 833px）。16rem 与 CSS 默认一致。
                const width = Math.min(16 * rootRem, Math.max(12 * rootRem, row.right - blockLeft));
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
          <span className="review-split-name" title={titleOf(entry.projectId)}>{titleOf(entry.projectId)}</span>
          <span className="review-split-value">{formatRecordedMs(entry.recordedMs)}</span>
        </li>)}
      </ul>
    </FloatingPanel>}
  </section>;
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
