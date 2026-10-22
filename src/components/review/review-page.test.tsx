import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewPage, type ReviewSelection } from "./review-page";
import { OverlayHostProvider } from "../ui/overlay-host";
import { createWorkspaceIndex } from "../../lib/workspaceSelectors";
import { DEFAULT_SETTINGS, type AppSettings } from "../../lib/settings";
import { EMPTY_WORKSPACE, type ExecutionRecord, type ExecutionSession, type ProgressEvent, type Task, type WorkspaceSnapshot } from "../../lib/native";

/**
 * 阶段 4 P4-08 / AC13：周期页面的顺序、图表等价数据、下钻键盘路径与「回到汇总保留查询与滚动」。
 *
 * 夹具一律用**本地墙钟**构造，`now` 由假时钟给出（页面自己取时钟并注入引擎）。
 */

const TODAY = "2026-03-07";

afterEach(() => vi.useRealTimers());

/** 「本地日期 + 本地时间」→ UTC 时间点；夹具只描述用户看到的墙钟。 */
function localToUtc(date: string, time: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

function task(id: string, patch: Partial<Task> = {}): Task {
  return { id, projectId: null, title: id, progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0, kind: "task", ...patch };
}

function session(id: string, patch: Partial<ExecutionSession> = {}): ExecutionSession {
  return { id, taskId: "t-alpha", localDate: TODAY, endLocalDate: TODAY, startLocal: "09:00", endLocal: "10:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled", ...patch };
}

function record(id: string, patch: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return { id, sessionId: null, taskId: "t-alpha", actualStartUtc: localToUtc(TODAY, "09:00"), actualEndUtc: localToUtc(TODAY, "10:00"), note: "", ...patch };
}

function event(id: string, patch: Partial<ProgressEvent> = {}): ProgressEvent {
  return { id, taskId: "t-alpha", fromProgress: 40, toProgress: 60, occurredAtUtc: localToUtc("2026-03-05", "09:00"), ...patch };
}

/**
 * 一周内的四类事实：上调、下调、已记录投入、待回顾／明确未推进。
 * 项目 p-1 只包含上调的那一项，因此项目筛选在数字上可判别（全量 −10 百分点 / p-1 +20 百分点）。
 */
function fixture(): WorkspaceSnapshot {
  return {
    ...structuredClone(EMPTY_WORKSPACE),
    projects: [{ id: "p-1", title: "学会 Rust", deadlineLocal: "2026-03-31" }, { id: "p-2", title: "另一个项目", deadlineLocal: null }],
    projectMilestones: [{ id: "m-1", projectId: "p-1", title: "第一阶段", targetLocalDate: "2026-03-06", sortOrder: 0, criterionKind: "taskCount", targetTaskId: null, targetCount: 2, targetProgress: null }],
    milestoneOutcomes: [{ id: "o-1", milestoneId: "m-1", projectId: "p-1", title: "第一阶段", targetLocalDate: "2026-03-06", reached: false, resultText: "完成 0/2，未达成", frozenAtUtc: "2026-03-07T00:00:00Z" }],
    tasks: [
      task("t-alpha", { projectId: "p-1", title: "Alpha 任务", progress: 60, sortOrder: 0 }),
      task("t-beta", { projectId: "p-2", title: "Beta 任务", progress: 20, sortOrder: 1 }),
      task("t-loose", { projectId: null, title: "独立任务", progress: 30, sortOrder: 2 }),
      // 本周期内没有任何事实：明细不该补一行 0%，也不该有触发入口。
      task("t-idle", { projectId: null, title: "空闲任务", progress: 5, sortOrder: 3 }),
    ],
    progressEvents: [
      event("e-alpha", { taskId: "t-alpha", fromProgress: 40, toProgress: 60, occurredAtUtc: localToUtc("2026-03-05", "09:00") }),
      event("e-beta", { taskId: "t-beta", fromProgress: 50, toProgress: 20, occurredAtUtc: localToUtc("2026-03-06", "10:00") }),
    ],
    executionSessions: [
      session("s-pending", { taskId: "t-loose", localDate: "2026-03-06", endLocalDate: "2026-03-06", startLocal: "19:00", endLocal: "20:00" }),
      session("s-missed", { taskId: "t-beta", localDate: TODAY, endLocalDate: TODAY, startLocal: "09:00", endLocal: "10:00", status: "missed" }),
    ],
    executionRecords: [record("r-1", { taskId: "t-alpha", actualStartUtc: localToUtc("2026-03-05", "20:00"), actualEndUtc: localToUtc("2026-03-05", "21:00"), note: "第一段" })],
  };
}

interface HarnessOptions {
  workspace?: WorkspaceSnapshot;
  preferences?: Partial<AppSettings>;
  projectId?: string | null;
  selection?: ReviewSelection | null;
}

/**
 * 滚动容器是一个**已经挂载**的宿主节点，与真实应用一致（`main` 由应用壳持有，
 * 切换页面时它本身不会重新挂载）。位置与容器都用普通对象承载，方便断言。
 */
function renderPage(options: HarnessOptions = {}) {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-03-07T12:00:00"));
  const handlers = {
    onPreferences: vi.fn(), onProjectId: vi.fn(), onSelection: vi.fn(),
    onGoToday: vi.fn(), onEditTask: vi.fn(), onArrangeTask: vi.fn(), onOpenProject: vi.fn(),
  };
  const index = createWorkspaceIndex(options.workspace ?? fixture());
  const container = document.createElement("div");
  document.body.appendChild(container);
  const scrollRef = { current: container } as RefObject<HTMLElement | null>;
  const scrollTop = { current: 0 };

  function Harness() {
    const [preferences, setPreferences] = useState<AppSettings>({ ...DEFAULT_SETTINGS, ...options.preferences });
    const [projectId, setProjectId] = useState<string | null>(options.projectId ?? null);
    const [selection, setSelection] = useState<ReviewSelection | null>(options.selection ?? null);
    return <ReviewPage index={index} preferences={preferences}
      onPreferences={(patch) => { handlers.onPreferences(patch); setPreferences((current) => ({ ...current, ...patch })); }}
      projectId={projectId} onProjectId={(id) => { handlers.onProjectId(id); setProjectId(id); }}
      selection={selection} onSelection={(next) => { handlers.onSelection(next); setSelection(next); }}
      scrollRef={scrollRef} scrollTop={scrollTop} onGoToday={handlers.onGoToday}
      onEditTask={handlers.onEditTask} onArrangeTask={handlers.onArrangeTask} onOpenProject={handlers.onOpenProject} />;
  }
  // 明细是浮层：Esc 的顶层裁决与焦点归还都归宿主，测试必须和 App 一样包一层。
  render(<OverlayHostProvider><Harness /></OverlayHostProvider>, { container });
  return { ...handlers, index, container, scrollTop };
}

const figures = () => Array.from(document.querySelectorAll<HTMLElement>(".review-chart-figure"));
const minutesFigure = () => figures()[0];
/** ③ 明细里的那一行（① 的任务胶囊与它同名，都是同一个下钻入口，所以查询要限定范围）。 */
const taskRowButton = (title: string) => within(document.querySelector<HTMLElement>(".review-tasks")!).getByRole("button", { name: `查看任务「${title}」的明细` });

describe("review page", () => {
  it("lays the period page out in the spec order and keeps a numeric table behind the chart", () => {
    renderPage();
    // 首屏是「三个数字 + 里程碑」的摘要行（不是一段），后面才是图表与明细。口径说明已按用户要求移除。
    const sections = Array.from(document.querySelectorAll<HTMLElement>(".review-page > section")).map((node) => node.className);
    expect(sections.map((name) => name.split(" ").at(-1))).toEqual(["review-charts", "review-tasks"]);
    expect(document.querySelector(".review-headline")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "投入和进度", level: 2 })).toBeVisible();
    expect(screen.getByRole("heading", { name: "任务／项目明细", level: 2 })).toBeVisible();
    // 投入与净进度合并成一张图；周视图的等价数值表折进「详细」气泡，点开才在 DOM 里出现。
    expect(figures()).toHaveLength(1);
    expect(document.querySelectorAll(".review-chart-table")).toHaveLength(0);
    // 柱顶只给有数值的柱子标字：没记录的日子留空，不写 0。
    expect(minutesFigure().querySelectorAll(".review-chart-value")).toHaveLength(1);
    expect(minutesFigure().querySelector(".review-chart-value")!.textContent).toBe("60");
    expect(screen.getByRole("button", { name: "详细" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "3月2日 — 3月8日", level: 1 })).toBeVisible();
  });

  it("switches one chart between minutes and percentage points and lists both in the 详细 table", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    const switcher = screen.getByRole("group", { name: "图表数值" });
    // 默认看投入，只有分钟；单位放在图的右下角，不再占标题行。
    expect(minutesFigure().querySelector(".review-chart-unit")).toHaveTextContent("单位：分钟");
    expect(document.querySelector(".review-charts-tools")!.textContent).not.toContain("单位");
    expect(minutesFigure().textContent).not.toContain("百分点");

    await user.click(within(switcher).getByRole("button", { name: "净进度" }));
    // 切成百分点后，同一张图只讲百分点。
    expect(minutesFigure().querySelector(".review-chart-unit")).toHaveTextContent("单位：百分点");
    expect(minutesFigure().textContent).not.toContain("分钟");

    // 「详细」打开气泡：周视图的表格是四列，投入与百分点并排。
    await user.click(screen.getByRole("button", { name: "详细" }));
    const popover = document.querySelector<HTMLElement>(".review-chart-popover")!;
    expect([...popover.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual(["日期", "星期", "投入时间", "百分点"]);
    const row = popover.querySelector<HTMLElement>('[data-chart-row="2026-03-05"]')!;
    expect(row.textContent).toBe("3月5日");
    expect(row.parentElement!.textContent).toBe("3月5日周四60 分钟+20 百分点");
    // 点页面别处收起。
    await user.click(screen.getByRole("heading", { name: "3月2日 — 3月8日", level: 1 }));
    expect(document.querySelector(".review-chart-popover")).toBeNull();
  });

  it("draws the dashed reference line at the average of days that have values", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await user.click(within(screen.getByRole("group", { name: "图表数值" })).getByRole("button", { name: "净进度" }));
    // 上调 20、下调 30 → 有数值日均 -5。零值在 40% 处，平均值线在 50% 处（不再画零基线）。
    expect(minutesFigure().querySelector<HTMLElement>(".review-chart-average")!.style.top).toBe("50%");
    expect(minutesFigure().querySelector(".review-chart-zero")).toBeNull();
    expect(minutesFigure().querySelectorAll(".review-chart-bar.up")).toHaveLength(1);
    expect(minutesFigure().querySelectorAll(".review-chart-bar.down")).toHaveLength(1);
    // 解释性长句已按用户 2026-10-22 的要求移除；方向由柱的正负、颜色与数值表表达。
    expect(minutesFigure().querySelector(".review-chart-note")).toBeNull();
    expect(minutesFigure().querySelector(".review-chart-unit")).toHaveTextContent("平均 -5");
    // 投入只有一天有记录：平均就是那天的 60 分钟，线落在柱顶（0%）。
    await user.click(within(screen.getByRole("group", { name: "图表数值" })).getByRole("button", { name: "实际投入" }));
    expect(minutesFigure().querySelector<HTMLElement>(".review-chart-average")!.style.top).toBe("0%");
    expect(minutesFigure().querySelector(".review-chart-unit")).toHaveTextContent("平均 60");
  });

  it("opens the month detail as a calendar of days with a minutes/percent switch", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage({ preferences: { reviewPeriod: "month" } });
    // 月视图不再常驻折叠表：等价数值物是「详细」气泡里的月历。
    expect(minutesFigure().querySelector(".review-chart-table")).toBeNull();
    await user.click(screen.getByRole("button", { name: "详细" }));
    const popover = document.querySelector<HTMLElement>(".review-chart-popover")!;
    const calendar = within(popover).getByRole("table", { name: "按日期查看数值" });
    // 3 月 1 日是周日 → 周一起头时空 6 格；31 天一个不少，排 6 行
    //（主月历与周期选择器都是周一起头，回顾里的月历不单独改成周日开头）。
    expect(calendar.querySelectorAll("[data-chart-row]")).toHaveLength(31);
    expect(calendar.querySelectorAll("tbody tr")).toHaveLength(6);
    expect(calendar.querySelector("thead tr")!.textContent).toBe("一二三四五六日");
    // 默认跟图一致看分钟：5 日 60 分钟，7 日没有记录（写「未记录」，不写 0）。
    expect(calendar.querySelector('[data-chart-row="2026-03-05"]')!.textContent).toContain("60");
    expect(calendar.querySelector('[data-chart-row="2026-03-07"]')!.textContent).toBe("7-");
    // 切到百分点：同一格换成带符号的数值，日期与下钻入口不变。
    await user.click(within(popover).getByRole("button", { name: "百分点" }));
    expect(calendar.querySelector('[data-chart-row="2026-03-05"]')!.textContent).toContain("+20");
    expect(within(popover).getByRole("button", { name: "查看 3月5日 的明细：+20 百分点" })).toBeVisible();
  });

  it("puts the three headline numbers in the first row as large figures", () => {
    renderPage();
    const stats = Array.from(document.querySelectorAll<HTMLElement>("[data-review-stat]"));
    expect(stats.map((node) => node.dataset.reviewStat)).toEqual(["actual", "progress", "completed"]);
    expect(stats[0]).toHaveTextContent("60 分钟");
    expect(stats[1]).toHaveTextContent("-10 净进度");
    expect(stats[2]).toHaveTextContent("0 项");
    // 页头不再重复这三个数字。
    expect(document.querySelector(".page-header .summary-pills")).toBeNull();
  });

  it("labels each bar with its day and value on hover and offers a zoomed, pannable chart", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    // 悬停气泡：视觉增强，但仍逐列带着当天的日期与数值。
    const tips = Array.from(minutesFigure().querySelectorAll(".review-chart-tip")).map((node) => node.textContent);
    expect(tips).toContain("3月5日 · 60 分钟");
    expect(tips).toContain("3月4日 · 未记录");

    await user.click(screen.getByRole("button", { name: "放大实际投入图表" }));
    const dialog = screen.getByRole("dialog", { name: "实际投入" });
    expect(dialog).toBeVisible();
    // 放大后每根柱都有自己的完整日期刻度。
    expect(within(dialog).getAllByText("3月5日")).toHaveLength(1);
    expect(within(dialog).getByText("60")).toBeVisible();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "实际投入" })).toBeNull();
  });

  it("breaks the investment down by project once there is more than one destination", () => {
    renderPage({ workspace: {
      ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "p-1", title: "学会 Rust", deadlineLocal: null }, { id: "p-2", title: "另一个项目", deadlineLocal: null }],
      tasks: [task("t-alpha", { projectId: "p-1", title: "Alpha 任务" }), task("t-beta", { projectId: "p-2", title: "Beta 任务" })],
      executionRecords: [
        record("r-1", { taskId: "t-alpha", actualStartUtc: localToUtc(TODAY, "09:00"), actualEndUtc: localToUtc(TODAY, "10:00") }),
        record("r-2", { taskId: "t-beta", actualStartUtc: localToUtc(TODAY, "11:00"), actualEndUtc: localToUtc(TODAY, "11:30") }),
      ],
    } });
    const split = document.querySelector<HTMLElement>(".review-split")!;
    expect(split).not.toBeNull();
    // 「投入去向」四个字已经去掉：圆环本身就是它，名字只留给读屏（aria-label）。
    expect(split.getAttribute("aria-label")).toBe("投入去向");
    expect(split.textContent).toContain("学会 Rust");
    expect(split.textContent).toContain("另一个项目");
    expect(split.textContent).toContain("60 分钟");
    expect(split.textContent).toContain("30 分钟");
  });

  it("folds a single day into one card: the ring beside the task rows", () => {
    renderPage({ preferences: { reviewPeriod: "day", reviewAnchorDate: "2026-03-05" } });
    // 单日没有「按天比较」的意义：不画柱图；圆环收进明细的左栏（上环下项目），右栏是项目卡。
    expect(figures()).toHaveLength(0);
    expect(document.querySelector(".review-tasks-body > .review-split")).not.toBeNull();
    expect(document.querySelector(".review-donut")).not.toBeNull();
    const tasks = document.querySelector<HTMLElement>(".review-tasks")!;
    expect(within(tasks).getByRole("heading", { name: "任务／项目明细", level: 2 })).toBeVisible();
    expect(within(tasks).getByRole("button", { name: "查看任务「Alpha 任务」的明细" })).toBeVisible();
  });

  it("draws no all-zero chart and never reads 未记录 as a zero-percent execution rate", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // 只有进度事件与一个计划时段、没有任何实际记录：投入不画全零柱，只给一句「没有记录」。
    renderPage({ workspace: {
      ...structuredClone(EMPTY_WORKSPACE),
      tasks: [task("t-alpha")],
      progressEvents: [event("e-alpha")],
      executionSessions: [session("s-1", { taskId: "t-alpha", localDate: "2026-03-06", endLocalDate: "2026-03-06", startLocal: "19:00", endLocal: "20:00" })],
    } });
    expect(figures()).toHaveLength(1);
    expect(minutesFigure().querySelector(".review-chart-plot")).toBeNull();
    expect(within(minutesFigure()).getByText(/本周期没有记录实际投入/)).toBeVisible();
    // 切到净进度：同一张图这时才有柱子。
    await user.click(within(screen.getByRole("group", { name: "图表数值" })).getByRole("button", { name: "净进度" }));
    expect(minutesFigure().querySelector(".review-chart-plot")).not.toBeNull();
  });

  it("keeps the period selector and a neutral empty state when the period has no facts at all", () => {
    renderPage({ workspace: structuredClone(EMPTY_WORKSPACE) });
    expect(screen.getByText("有实际推进后，这里会出现回顾")).toBeVisible();
    expect(screen.getByText(/不会把未记录解释为失败/)).toBeVisible();
    expect(document.querySelectorAll(".review-chart-plot")).toHaveLength(0);
    expect(document.querySelectorAll(".review-chart-table")).toHaveLength(0);
    // 周期入口仍在，空周期也能换周期看。
    expect(screen.getByRole("group", { name: "回顾周期" })).toBeVisible();
  });

  it("writes the period and the anchor through the preference callback and follows the clock when the anchor is null", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const harness = renderPage();
    const header = () => within(screen.getByRole("group", { name: "回顾周期" }));
    const openPicker = () => user.click(document.querySelector<HTMLElement>(".review-picker-trigger")!);
    const picker = () => within(document.querySelector<HTMLElement>(".review-picker")!);

    await user.click(header().getByRole("button", { name: "月" }));
    expect(harness.onPreferences).toHaveBeenLastCalledWith({ reviewPeriod: "month" });
    expect(screen.getByRole("heading", { name: "2026年3月", level: 1 })).toBeVisible();

    // 日历跳到 2 月：月模式给的是年视图，点「2 月」直接换月。
    await openPicker();
    await user.click(picker().getByRole("button", { name: "2 月" }));
    expect(harness.onPreferences).toHaveBeenLastCalledWith({ reviewPeriod: "month", reviewAnchorDate: "2026-02-01" });
    expect(screen.getByRole("heading", { name: "2026年2月", level: 1 })).toBeVisible();

    // 离开当前周期后出现「回到本月」，它把锚点交回给时钟（null）。
    await user.click(screen.getByRole("button", { name: "回到本月" }));
    expect(harness.onPreferences).toHaveBeenLastCalledWith({ reviewAnchorDate: null });
    expect(screen.getByRole("heading", { name: "2026年3月", level: 1 })).toBeVisible();

    await user.click(header().getByRole("button", { name: "日" }));
    expect(harness.onPreferences).toHaveBeenLastCalledWith({ reviewPeriod: "day" });
    expect(screen.getByRole("heading", { name: /3月7日\s*周六/, level: 1 })).toBeVisible();

    // 日模式：在月历里点某一天。
    await openPicker();
    await user.click(picker().getByRole("button", { name: "2026 年 3 月 12 日" }));
    expect(harness.onPreferences).toHaveBeenLastCalledWith({ reviewPeriod: "day", reviewAnchorDate: "2026-03-12" });
    expect(screen.getByRole("heading", { name: /3月12日\s*周四/, level: 1 })).toBeVisible();
  });

  it("steps through the period with the arrows and names the way back by day, week and month", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const harness = renderPage();
    const periodGroup = () => within(screen.getByRole("group", { name: "回顾周期" }));

    // 当前周：标题是日期范围，右侧是安静的状态徽标；没有「回到…」按钮。
    expect(screen.getByRole("heading", { name: "3月2日 — 3月8日", level: 1 })).toBeVisible();
    expect(screen.getByText("本周")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^回到/ })).toBeNull();

    // 下一周：写显式锚点，同一个位置换成「回到本周」。
    await user.click(screen.getByRole("button", { name: "下一周" }));
    expect(harness.onPreferences).toHaveBeenLastCalledWith({ reviewAnchorDate: "2026-03-09" });
    expect(screen.getByRole("heading", { name: "3月9日 — 3月15日", level: 1 })).toBeVisible();
    expect(screen.getByRole("button", { name: "回到本周" })).toBeVisible();

    // 「选择日期」里也有同一个动作：不必把鼠标移回页头左侧；点完日历收起。
    await user.click(document.querySelector<HTMLElement>(".review-picker-trigger")!);
    const picker = within(document.querySelector<HTMLElement>(".review-picker")!);
    await user.click(picker.getByRole("button", { name: "回到本周" }));
    expect(harness.onPreferences).toHaveBeenLastCalledWith({ reviewPeriod: "week", reviewAnchorDate: null });
    expect(document.querySelector(".review-picker")).toBeNull();
    expect(screen.getByRole("heading", { name: "3月2日 — 3月8日", level: 1 })).toBeVisible();

    // 页头那颗「回到本周」会随状态一起消失：焦点交给页面标题而不是掉到 body。
    await user.click(screen.getByRole("button", { name: "下一周" }));
    await user.click(screen.getByRole("button", { name: "回到本周" }));
    expect(harness.onPreferences).toHaveBeenLastCalledWith({ reviewAnchorDate: null });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "3月2日 — 3月8日", level: 1 })));

    // 日：徽标说「今天」，按钮说「回到今日」；箭头按天走。
    await user.click(periodGroup().getByRole("button", { name: "日" }));
    expect(screen.getByRole("heading", { name: /3月7日\s*周六/, level: 1 })).toBeVisible();
    expect(screen.getByText("今天")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "后一天" }));
    expect(harness.onPreferences).toHaveBeenLastCalledWith({ reviewAnchorDate: "2026-03-08" });
    expect(screen.getByRole("heading", { name: /3月8日\s*周日/, level: 1 })).toBeVisible();
    expect(screen.getByRole("button", { name: "回到今日" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "前一天" }));
    expect(harness.onPreferences).toHaveBeenLastCalledWith({ reviewAnchorDate: "2026-03-07" });
    expect(screen.getByText("今天")).toBeVisible();

    // 月：徽标说「本月」，按钮说「回到本月」；箭头按自然月走。
    await user.click(periodGroup().getByRole("button", { name: "月" }));
    expect(screen.getByRole("heading", { name: "2026年3月", level: 1 })).toBeVisible();
    expect(screen.getByText("本月")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "下个月" }));
    expect(harness.onPreferences).toHaveBeenLastCalledWith({ reviewAnchorDate: "2026-04-01" });
    expect(screen.getByRole("heading", { name: "2026年4月", level: 1 })).toBeVisible();
    expect(screen.getByRole("button", { name: "回到本月" })).toBeVisible();
  });

  it("keeps the calendar on the month grid for weeks and highlights the whole row", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const harness = renderPage();
    await user.click(document.querySelector<HTMLElement>(".review-picker-trigger")!);
    const picker = document.querySelector<HTMLElement>(".review-picker")!;
    // 周模式仍然是月历，但每一行是一整条可点的横条。
    expect(picker.querySelector(".review-picker-grid.is-week")).not.toBeNull();
    expect(picker.querySelectorAll(".review-picker-week")).toHaveLength(6);
    // 当前周那一条有标记；已经在当前周期时底部不出现「回到本周」。
    expect(picker.querySelectorAll(".review-picker-week.is-current")).toHaveLength(1);
    expect(picker.querySelector(".review-picker-foot")).toBeNull();
    // 点的是整条横条，落点取那一周的周一。
    await user.click(within(picker).getByRole("button", { name: "2026 年 3 月 9 日 那一周" }));
    expect(harness.onPreferences).toHaveBeenLastCalledWith({ reviewPeriod: "week", reviewAnchorDate: "2026-03-09" });
  });

  it("opens the detail as a bubble under the trigger, shows the raw facts and gives the focus back on Escape", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    const trigger = taskRowButton("Alpha 任务");
    trigger.focus();
    await user.keyboard("{Enter}");

    const panel = document.querySelector<HTMLElement>(".review-detail-panel")!;
    const detail = document.querySelector<HTMLElement>(".review-detail")!;
    expect(panel).not.toBeNull();
    // 信息气泡：有可访问名，但不锁背景（`aria-modal` 不写）。
    expect(panel).toHaveAttribute("role", "dialog");
    expect(panel).toHaveAttribute("aria-labelledby", "review-detail-title");
    expect(panel).not.toHaveAttribute("aria-modal");
    // 打开后焦点进入气泡，Esc 由宿主的顶层裁决处理。
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(detail.textContent).toContain("40% → 60%");
    expect(detail.textContent).toContain("第一段");
    // 「当前完成度」由标签自己说明是当前值，不再补一句免责说明。
    expect(detail.textContent).toContain("当前完成度");
    expect(detail.textContent).toContain("3月5日");

    await user.keyboard("{Escape}");
    expect(document.querySelector(".review-detail")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("states each fact once in the bubble instead of repeating it", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await user.click(taskRowButton("Alpha 任务"));
    const taskDetail = document.querySelector<HTMLElement>(".review-detail")!;
    // 「净进度变化」就是区间两端之差，不再单列；副标题只说项目，不重复「当前完成度」。
    expect(taskDetail.textContent).not.toContain("净进度变化");
    expect(taskDetail.querySelector(".review-detail-sub")?.textContent).toBe("学会 Rust");
    // 三个计数都是 0 时不渲染胶囊，也不写「本周期没有…」这类占位句；
    // 这个任务有「待续」，所以执行卡还在。
    expect(taskDetail.querySelector(".review-detail-chips")).toBeNull();
    expect(taskDetail.textContent).not.toContain("本周期没有待回顾");
    expect(taskDetail.querySelector('[aria-label="执行"]')).not.toBeNull();

    // 项目：截止日期只在数字卡里出现一次（副标题不再写「截止 X」）。
    await user.click(within(document.querySelector<HTMLElement>(".review-task-group-head")!).getByRole("button", { name: "查看项目「学会 Rust」的明细" }));
    const projectDetail = document.querySelector<HTMLElement>(".review-detail")!;
    expect(projectDetail.querySelector(".review-detail-sub")).toBeNull();
    expect((projectDetail.textContent ?? "").split("2026-03-31").length - 1).toBe(1);
  });

  it("drops the execution card entirely when there is nothing to report", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const workspace = fixture();
    // 已完成、没有待回顾／未推进／跳过、也不待续 —— 执行卡没有任何内容可说。
    workspace.tasks = [...workspace.tasks, task("t-done", { title: "已完成任务", progress: 100, status: "completed", sortOrder: 9 })];
    workspace.progressEvents = [...workspace.progressEvents, event("e-done", { taskId: "t-done", fromProgress: 0, toProgress: 100, occurredAtUtc: localToUtc("2026-03-05", "10:00") })];
    renderPage({ workspace });
    await user.click(taskRowButton("已完成任务"));
    const detail = document.querySelector<HTMLElement>(".review-detail")!;
    expect(detail.querySelector('[aria-label="执行"]')).toBeNull();
    expect(detail.textContent).not.toContain("本周期没有待回顾");
  });

  it("closes the bubble on a blank click and lets the next row take over in one click", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    await user.click(taskRowButton("Alpha 任务"));
    expect(document.querySelector(".review-detail")).not.toBeNull();

    // 点空白处：气泡直接关掉（不需要先按 Esc）。
    await user.click(document.body);
    await waitFor(() => expect(document.querySelector(".review-detail")).toBeNull());

    // 点另一行：旧气泡让位、新气泡接上，一次点击完成，不用点两次。
    await user.click(taskRowButton("Alpha 任务"));
    await user.click(taskRowButton("Beta 任务"));
    await waitFor(() => expect(document.querySelector(".review-detail")?.textContent).toContain("50% → 20%"));
  });

  it("closes the list popover together with the detail opened from it", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    // 首屏「查看」开待回顾名单，名单里点任务名 → 明细叠在名单上面。
    await user.click(within(document.querySelector<HTMLElement>(".review-pending-line")!).getByRole("button", { name: "查看" }));
    const popover = document.querySelector<HTMLElement>(".review-headline-popover")!;
    expect(popover).not.toBeNull();
    await user.click(within(popover).getByRole("button", { name: "查看任务「独立任务」的明细" }));
    expect(document.querySelector(".review-detail")).not.toBeNull();
    expect(document.querySelectorAll(".floating-panel")).toHaveLength(2);

    // Esc 关明细时名单一起收起：只关掉上面那层会看起来像「点了没反应」。
    await user.keyboard("{Escape}");
    expect(document.querySelector(".review-detail")).toBeNull();
    expect(document.querySelector(".review-headline-popover")).toBeNull();
  });

  it("keeps the query and the page position when the detail closes", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const harness = renderPage();
    harness.container.scrollTop = 320;
    harness.container.dispatchEvent(new Event("scroll"));
    expect(harness.scrollTop.current).toBe(320);

    // 气泡不把页面滚到别处：打开、关闭都不动滚动位置，也不写偏好。
    await user.click(taskRowButton("Alpha 任务"));
    expect(harness.container.scrollTop).toBe(320);
    await user.click(screen.getByRole("button", { name: "关闭明细" }));
    expect(harness.container.scrollTop).toBe(320);
    expect(harness.onPreferences).not.toHaveBeenCalled();
  });

  it("re-finds the trigger for the same target when the original element is gone", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    // 日期明细 → 再点它里面的任务名：日期明细随之卸载，原触发元素不复存在。
    await user.click(screen.getByRole("button", { name: "详细" }));
    await user.click(within(document.querySelector<HTMLElement>(".review-chart-popover")!).getByRole("button", { name: "查看 3月5日 的明细" }));
    await user.click(within(document.querySelector<HTMLElement>(".review-detail")!).getAllByRole("button", { name: "查看任务「Alpha 任务」的明细" })[0]);
    await user.keyboard("{Escape}");
    expect(document.querySelector(".review-detail")).toBeNull();
    // 不调用已断开的节点：按身份找回同一个目标的另一个入口。
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('[data-review-trigger="task:t-alpha"]')));
  });

  it("keeps the still-true facts and stays usable when a selected source is gone", () => {
    renderPage({ selection: { kind: "task", id: "t-deleted" } });
    expect(screen.getByText(/来源不可用：这个任务已经不在工作区里/)).toBeVisible();
    // 页面其余部分仍然成立。
    expect(screen.getByRole("heading", { name: "任务／项目明细", level: 2 })).toBeVisible();
    expect(document.querySelector(".review-headline")).not.toBeNull();
  });

  it("falls back to the page heading when there is no trigger left for the target", async () => {
    renderPage({ selection: { kind: "task", id: "t-idle" } });
    // 该任务在本周期内没有任何事实：明细只说这一句，不编造数字。
    expect(screen.getByText(/该任务在当前周期内没有事实/)).toBeVisible();
    expect(document.querySelector('[data-review-trigger="task:t-idle"]')).toBeNull();
    fireEvent.keyDown(document.querySelector<HTMLElement>(".review-detail")!, { key: "Escape" });
    expect(document.querySelector(".review-detail")).toBeNull();
    // 没有任何入口可还焦点时退到页面标题，不掉到 body。
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "3月2日 — 3月8日", level: 1 })));
  });

  it("tells a date outside the current period apart from a missing project", () => {
    renderPage({ selection: { kind: "date", id: "2026-05-01" } });
    expect(screen.getByText(/该日期不在当前周期内/)).toBeVisible();
    renderPage({ selection: { kind: "project", id: "p-deleted" } });
    expect(screen.getByText(/来源不可用：这个项目已经不在工作区里/)).toBeVisible();
  });

  it("hands the original task and project to the app and scopes the summary by project", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const harness = renderPage();

    // 行内只剩「任务名」一个入口：回顾页是只读投影，写动作一律在下钻明细里。
    const alphaRow = document.querySelector<HTMLElement>('[data-review-task="t-alpha"]')!;
    expect(within(alphaRow).getAllByRole("button")).toHaveLength(1);

    // 下钻到任务明细后再把原始对象交给 App：锚点元素仍是那个按钮。
    await user.click(taskRowButton("Alpha 任务"));
    const taskDetail = document.querySelector<HTMLElement>(".review-detail")!;
    await user.click(within(taskDetail).getByRole("button", { name: "编辑任务 Alpha 任务" }));
    expect(harness.onEditTask.mock.calls[0][0]).toMatchObject({ id: "t-alpha", title: "Alpha 任务" });
    expect(harness.onEditTask.mock.calls[0][1]).toBeInstanceOf(HTMLElement);
    await user.click(within(taskDetail).getByRole("button", { name: "安排任务 Alpha 任务" }));
    expect(harness.onArrangeTask.mock.calls[0][0]).toMatchObject({ id: "t-alpha" });

    // 项目下钻：先看明细，再把它设成引擎查询的一部分。
    await user.click(within(document.querySelector<HTMLElement>(".review-task-group-head")!).getByRole("button", { name: "查看项目「学会 Rust」的明细" }));
    const detail = document.querySelector<HTMLElement>(".review-detail")!;
    expect(detail.textContent).toContain("第一阶段");
    expect(detail.textContent).toContain("到期冻结，后续推进不改写这个结果");
    await user.click(within(detail).getByRole("button", { name: "只看这个项目" }));
    expect(harness.onProjectId).toHaveBeenLastCalledWith("p-1");
    // 项目筛选生效后：顶部出现范围说明，汇总只统计该项目。
    expect(await screen.findByText("仅统计项目：学会 Rust")).toBeVisible();
    expect(document.querySelector('[data-review-stat="actual"]')).toHaveTextContent("60 分钟");
    expect(document.querySelector('[data-review-stat="progress"]')).toHaveTextContent("+20 净进度");
  });

  it("states each headline count once instead of repeating a totals row", () => {
    renderPage();
    // 顶部统计卡是唯一出处：同一句话不许在页面里出现第二次。
    const text = document.body.textContent ?? "";
    for (const phrase of ["项有进度变化", "项仍可继续", "项完成"]) {
      expect(text.split(phrase).length - 1).toBe(1);
    }
  });

  it("lists only the remaining milestones in the popover instead of repeating the first", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const workspace = fixture();
    // 第一条已经写在首屏那一格里：浮层只补其余的，不把同一条再说一遍。
    workspace.projectMilestones = [...workspace.projectMilestones, { ...workspace.projectMilestones[0], id: "m-2", title: "第二阶段", targetLocalDate: "2026-03-04" }];
    renderPage({ workspace });
    await user.click(screen.getByRole("button", { name: "其余 1 个" }));
    const popover = document.querySelector<HTMLElement>(".review-headline-popover")!;
    expect(within(popover).getByText("第二阶段")).toBeVisible();
    expect(within(popover).queryByText("第一阶段")).toBeNull();
  });

  it("hides the milestone popover trigger when there is nothing left to list", () => {
    renderPage();
    // 夹具只有一条里程碑：全部内容都在首屏那一格里，按钮没有存在的理由。
    expect(screen.queryByRole("button", { name: /其余 \d+ 个/ })).toBeNull();
    expect(document.querySelector(".review-milestone-cell")!.textContent).toContain("第一阶段");
  });

  it("drops the pending line when every ended session already has a record", () => {
    // 只剩「明确未推进」的时段：不算待回顾，所以那行提示不出现（也不留空块）。
    const workspace = fixture();
    renderPage({ workspace: { ...workspace, executionSessions: [session("s-missed", { taskId: "t-beta", localDate: TODAY, endLocalDate: TODAY, startLocal: "09:00", endLocal: "10:00", status: "missed" })] } });
    expect(document.querySelector(".review-pending-line")).toBeNull();
    expect(screen.queryByText(/还没记录/)).toBeNull();
    // 里程碑照旧。
    expect(document.querySelector(".review-milestone-cell")).not.toBeNull();
  });

  it("keeps only the numbers when the period has nothing left to act on", () => {
    renderPage({ workspace: {
      ...structuredClone(EMPTY_WORKSPACE),
      tasks: [task("t-done", { title: "全部做完", progress: 100, status: "completed" })],
      progressEvents: [event("e-done", { taskId: "t-done", fromProgress: 40, toProgress: 100, occurredAtUtc: localToUtc("2026-03-05", "09:00") })],
    } });
    // 没有里程碑、没有待回顾：首屏只剩数字那一格，且它占满整行（不留 24rem 的空列）。
    expect(document.querySelectorAll(".review-headline > *")).toHaveLength(1);
    expect(document.querySelector(".review-milestone-cell")).toBeNull();
    expect(document.querySelector(".review-pending-line")).toBeNull();
    expect(document.querySelector('[data-review-stat="actual"]')).not.toBeNull();
  });

  it("no longer renders the 口径说明 card", () => {
    renderPage();
    expect(document.querySelector(".review-notes")).toBeNull();
    expect(screen.queryByRole("heading", { name: "口径说明" })).toBeNull();
  });

  it("explains 明确未推进 separately and keeps the 待回顾 list behind 查看", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    const notAdvanced = document.querySelector<HTMLElement>(".review-not-advanced")!;
    expect(notAdvanced.textContent).toContain("明确未推进");
    expect(notAdvanced.textContent).toContain("Beta 任务");
    // 待回顾不再占块：首屏只有一行提示，名单在「查看」浮层里，时长由引擎给出。
    expect(screen.queryByRole("heading", { name: /^待回顾/ })).toBeNull();
    expect(document.querySelector(".review-pending-line")!.textContent).toContain("1 个已结束的时段还没记录");
    await user.click(screen.getByRole("button", { name: "查看" }));
    const popover = document.querySelector<HTMLElement>(".review-headline-popover")!;
    expect(popover.textContent).toContain("独立任务");
    expect(popover.textContent).toContain("60 分钟");
    // 里程碑：条数在标题上，达成态给图标 + 文字两重编码。
    expect(screen.getByRole("heading", { name: /^里程碑/, level: 2 }).textContent).toBe("里程碑1");
    const tag = document.querySelector<HTMLElement>(".review-tag.is-unmet")!;
    expect(tag.textContent).toBe("未达成");
    expect(tag.querySelector("svg")).not.toBeNull();
  });
});
