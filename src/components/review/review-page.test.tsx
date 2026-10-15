import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewPage, type ReviewSelection } from "./review-page";
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
  render(<Harness />, { container });
  return { ...handlers, index, container, scrollTop };
}

const figures = () => Array.from(document.querySelectorAll<HTMLElement>(".review-chart-figure"));
const minutesFigure = () => figures()[0];
const progressFigure = () => figures()[1];
/** ③ 明细里的那一行（① 的任务胶囊与它同名，都是同一个下钻入口，所以查询要限定范围）。 */
const taskRowButton = (title: string) => within(document.querySelector<HTMLElement>(".review-tasks")!).getByRole("button", { name: `查看任务「${title}」的明细` });
const chartPairs = (figure: HTMLElement) => ({
  columns: Array.from(figure.querySelectorAll<HTMLElement>(".review-chart-column")).map((column) => [column.dataset.chartDate, Number(column.dataset.chartValue)] as const),
  rows: Array.from(figure.querySelectorAll<HTMLElement>("[data-chart-row]")).map((row) => [row.dataset.chartRow, row.querySelector("td")?.textContent] as const),
});

describe("review page", () => {
  it("lays the period page out in the spec order and keeps the charts next to their numeric tables", () => {
    renderPage();
    // ① 成果与待续 → ② 投入和进度图 → ③ 任务／项目明细，口径说明在最后。
    const sections = Array.from(document.querySelectorAll<HTMLElement>(".review-page > section")).map((node) => node.className);
    expect(sections.map((name) => name.split(" ").at(-1))).toEqual(["review-outcomes", "review-charts", "review-tasks", "review-notes"]);
    expect(screen.getByRole("heading", { name: "成果与待续", level: 2 })).toBeVisible();
    expect(screen.getByRole("heading", { name: "投入和进度", level: 2 })).toBeVisible();
    expect(screen.getByRole("heading", { name: "任务／项目明细", level: 2 })).toBeVisible();
    // 两张图、两张表，一一对应。
    expect(figures()).toHaveLength(2);
    expect(document.querySelectorAll(".review-chart-table")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "本周回顾", level: 1 })).toBeVisible();
  });

  it("keeps one unit per chart and lets the numeric table stand in for the bars", () => {
    renderPage();
    // 投入图只用分钟。
    expect(within(minutesFigure()).getByText("单位：分钟")).toBeVisible();
    expect(minutesFigure().textContent).not.toContain("百分点");
    // 进度图只用百分点。
    expect(within(progressFigure()).getByText("单位：百分点")).toBeVisible();
    expect(progressFigure().textContent).not.toContain("分钟");

    // 等价数值表与图上的柱逐列一致，不依赖悬停。
    const minutes = chartPairs(minutesFigure());
    expect(minutes.columns.map(([date]) => date)).toEqual(minutes.rows.map(([date]) => date));
    expect(minutes.columns.map(([, value]) => value)).toEqual([0, 0, 0, 60, 0, 0, 0]);
    expect(minutes.rows.map(([, label]) => label)).toEqual(["未记录", "未记录", "未记录", "60 分钟", "未记录", "未记录", "未记录"]);

    const progress = chartPairs(progressFigure());
    expect(progress.columns.map(([, value]) => value)).toEqual([0, 0, 0, 20, -30, 0, 0]);
    expect(progress.rows.map(([, label]) => label)).toEqual(["+0 百分点", "+0 百分点", "+0 百分点", "+20 百分点", "-30 百分点", "+0 百分点", "+0 百分点"]);
  });

  it("puts the zero baseline above the bottom when progress went down and explains it in words", () => {
    renderPage();
    // 上调 20、下调 30 → 零基线在容器 40% 处，而不是底部。
    const zero = progressFigure().querySelector<HTMLElement>(".review-chart-zero")!;
    expect(zero.style.top).toBe("40%");
    expect(progressFigure().querySelectorAll(".review-chart-bar.up")).toHaveLength(1);
    expect(progressFigure().querySelectorAll(".review-chart-bar.down")).toHaveLength(1);
    expect(within(progressFigure()).getByText(/零基线以上是上调，以下是下调/)).toBeVisible();
    // 投入图没有负值，零基线就在底部。
    expect(minutesFigure().querySelector<HTMLElement>(".review-chart-zero")!.style.top).toBe("100%");
  });

  it("draws no all-zero chart and never reads 未记录 as a zero-percent execution rate", () => {
    // 只有进度事件与一个计划时段、没有任何实际记录：投入图不画全零柱，只给一句「没有记录」。
    renderPage({ workspace: {
      ...structuredClone(EMPTY_WORKSPACE),
      tasks: [task("t-alpha")],
      progressEvents: [event("e-alpha")],
      executionSessions: [session("s-1", { taskId: "t-alpha", localDate: "2026-03-06", endLocalDate: "2026-03-06", startLocal: "19:00", endLocal: "20:00" })],
    } });
    expect(figures()).toHaveLength(2);
    expect(minutesFigure().querySelector(".review-chart-plot")).toBeNull();
    expect(within(minutesFigure()).getByText(/本周期没有记录实际投入/)).toBeVisible();
    expect(progressFigure().querySelector(".review-chart-plot")).not.toBeNull();
    // 有计划但没有记录时说「未记录」，不说 0% 执行率。
    expect(document.querySelector(".review-notes")?.textContent).toContain("本周期有计划但没有任何实际记录");
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

    await user.click(screen.getByRole("button", { name: "月" }));
    expect(harness.onPreferences).toHaveBeenLastCalledWith({ reviewPeriod: "month" });
    expect(screen.getByRole("heading", { name: "2026年3月回顾", level: 1 })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "上一周期" }));
    expect(harness.onPreferences).toHaveBeenLastCalledWith({ reviewAnchorDate: "2026-02-07" });
    expect(screen.getByRole("heading", { name: "2026年2月回顾", level: 1 })).toBeVisible();

    // 离开当前周期后出现「回到当前周期」，它把锚点交回给时钟（null）。
    await user.click(screen.getByRole("button", { name: "回到当前周期" }));
    expect(harness.onPreferences).toHaveBeenLastCalledWith({ reviewAnchorDate: null });
    expect(screen.getByRole("heading", { name: "2026年3月回顾", level: 1 })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "日" }));
    expect(harness.onPreferences).toHaveBeenLastCalledWith({ reviewPeriod: "day" });
    expect(screen.getByRole("heading", { name: "3月7日回顾", level: 1 })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "下一周期" }));
    expect(harness.onPreferences).toHaveBeenLastCalledWith({ reviewAnchorDate: "2026-03-08" });
  });

  it("opens the in-page detail with the keyboard, shows the raw facts and gives the focus back on Escape", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    const trigger = taskRowButton("Alpha 任务");
    trigger.focus();
    await user.keyboard("{Enter}");

    const detail = document.querySelector<HTMLElement>(".review-drilldown")!;
    expect(detail).not.toBeNull();
    // 打开后焦点进入明细区，Esc 才落在它自己的处理函数里。
    expect(document.activeElement).toBe(detail);
    expect(detail.textContent).toContain("40% → 60%");
    expect(detail.textContent).toContain("第一段");
    expect(detail.textContent).toContain("当前值，不是周期历史");
    expect(detail.textContent).toContain("3月5日");

    await user.keyboard("{Escape}");
    expect(document.querySelector(".review-drilldown")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps the query and the scroll position when the detail closes", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const harness = renderPage();
    harness.container.scrollTop = 320;
    harness.container.dispatchEvent(new Event("scroll"));
    expect(harness.scrollTop.current).toBe(320);

    await user.click(taskRowButton("Alpha 任务"));
    // 打开明细后页面被带到别处；关闭时必须回到汇总原来的位置，且查询不变。
    harness.container.scrollTop = 0;
    await user.click(screen.getByRole("button", { name: "关闭明细" }));
    expect(harness.container.scrollTop).toBe(320);
    expect(harness.onPreferences).not.toHaveBeenCalled();
  });

  it("re-finds the trigger for the same target when the original element is gone", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();
    // 日期明细 → 再点它里面的任务名：日期明细随之卸载，原触发元素不复存在。
    await user.click(within(minutesFigure()).getByRole("button", { name: "查看 3月5日 的明细" }));
    await user.click(within(document.querySelector<HTMLElement>(".review-drilldown")!).getAllByRole("button", { name: "查看任务「Alpha 任务」的明细" })[0]);
    await user.keyboard("{Escape}");
    expect(document.querySelector(".review-drilldown")).toBeNull();
    // 不调用已断开的节点：按身份找回同一个目标的另一个入口。
    expect(document.activeElement).toBe(document.querySelector('[data-review-trigger="task:t-alpha"]'));
  });

  it("keeps the still-true facts and stays usable when a selected source is gone", () => {
    renderPage({ selection: { kind: "task", id: "t-deleted" } });
    expect(screen.getByText(/来源不可用：这个任务已经不在工作区里/)).toBeVisible();
    // 页面其余部分仍然成立。
    expect(screen.getByRole("heading", { name: "任务／项目明细", level: 2 })).toBeVisible();
    expect(screen.getByRole("heading", { name: "成果与待续", level: 2 })).toBeVisible();
  });

  it("falls back to the page heading when there is no trigger left for the target", () => {
    renderPage({ selection: { kind: "task", id: "t-idle" } });
    // 该任务在本周期内没有任何事实：明细保留「当前完成度是当前值」这条仍成立的事实。
    expect(screen.getByText(/该任务在当前周期内没有事实/)).toBeVisible();
    expect(document.querySelector('[data-review-trigger="task:t-idle"]')).toBeNull();
    fireEvent.keyDown(document.querySelector<HTMLElement>(".review-drilldown")!, { key: "Escape" });
    expect(document.querySelector(".review-drilldown")).toBeNull();
    // 没有任何入口可还焦点时退到页面标题，不掉到 body。
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "本周回顾", level: 1 }));
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

    await user.click(screen.getByRole("button", { name: "编辑任务 Alpha 任务" }));
    expect(harness.onEditTask.mock.calls[0][0]).toMatchObject({ id: "t-alpha", title: "Alpha 任务" });
    expect(harness.onEditTask.mock.calls[0][1]).toBeInstanceOf(HTMLElement);
    await user.click(screen.getByRole("button", { name: "安排任务 Alpha 任务" }));
    expect(harness.onArrangeTask.mock.calls[0][0]).toMatchObject({ id: "t-alpha" });

    // 项目下钻：先看明细，再把它设成引擎查询的一部分。
    await user.click(within(document.querySelector<HTMLElement>(".review-tasks")!).getByRole("button", { name: "查看项目「学会 Rust」的明细" }));
    const detail = document.querySelector<HTMLElement>(".review-drilldown")!;
    expect(detail.textContent).toContain("第一阶段");
    expect(detail.textContent).toContain("到期冻结，后续推进不改写这个结果");
    await user.click(within(detail).getByRole("button", { name: "只看这个项目" }));
    expect(harness.onProjectId).toHaveBeenLastCalledWith("p-1");
    // 项目筛选生效后：顶部出现范围说明，汇总只统计该项目。
    expect(await screen.findByText("仅统计项目：学会 Rust")).toBeVisible();
    expect(screen.getByText("实际投入 60 分钟")).toBeVisible();
    expect(screen.getByText("净进度 +20 百分点")).toBeVisible();
  });

  it("shows the engine's notes verbatim instead of inventing its own wording", () => {
    renderPage();
    const notes = document.querySelector<HTMLElement>(".review-notes")!;
    expect(notes.textContent).toContain("进度事件按当前设备本地时区");
    expect(notes.textContent).toContain("计划仍按保存的本地日期展示");
  });

  it("explains 明确未推进, 跳过 and 取消安排 separately and lists 待回顾", () => {
    renderPage();
    const notAdvanced = document.querySelector<HTMLElement>(".review-not-advanced")!;
    expect(notAdvanced.textContent).toContain("明确未推进");
    expect(notAdvanced.textContent).toContain("Beta 任务");
    // 待回顾：已结束但没有记录的时段单独一块，并说明它不需要被当成失败。
    expect(screen.getByRole("heading", { name: "待回顾", level: 3 })).toBeVisible();
    expect(screen.getByText("1 个已结束的时段还没有记录")).toBeVisible();
    expect(screen.getByText("1 个在本周期到期")).toBeVisible();
  });
});
