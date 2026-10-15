import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeadlinesPage } from "./deadlines-page";
import { DEFAULT_DEADLINE_FILTER, type DeadlineFilter } from "../../lib/deadlines";
import { createWorkspaceIndex } from "../../lib/workspaceSelectors";
import { EMPTY_WORKSPACE, type Project, type ProjectMilestone, type Task, type WorkspaceSnapshot } from "../../lib/native";

/** 阶段 4 P4-06 / AC08：截止页的呈现、两种空状态、行级动作与焦点恢复。 */

const TODAY = "2026-03-07";

afterEach(() => vi.useRealTimers());

function task(id: string, patch: Partial<Task> = {}): Task {
  return { id, projectId: null, title: id, progress: 0, status: "active", deadlineLocal: TODAY, estimatedMinutes: null, sortOrder: 0, ...patch };
}

function project(id: string, patch: Partial<Project> = {}): Project {
  return { id, title: id, deadlineLocal: TODAY, ...patch };
}

function frozenMilestone(id: string, projectId: string): ProjectMilestone {
  return { id, projectId, title: `目标 ${id}`, targetLocalDate: "2026-03-01", sortOrder: 0, criterionKind: "taskCount", targetTaskId: null, targetCount: 3, targetProgress: null };
}

function workspace(patch: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return { ...structuredClone(EMPTY_WORKSPACE), ...patch };
}

/**
 * 滚动容器是一个**已经挂载**的宿主节点，与真实应用一致（`main` 由应用壳持有，
 * 切换页面时它本身不会重新挂载）。位置与容器都用普通对象承载，方便断言。
 */
function renderPage(overrides: { workspace: WorkspaceSnapshot; filter?: DeadlineFilter; focusKey?: string | null }) {
  const handlers = {
    onEditTask: vi.fn(),
    onArrangeTask: vi.fn(),
    onOpenProject: vi.fn(),
    onContinueMilestone: vi.fn(),
    onFocusKey: vi.fn(),
  };
  const index = createWorkspaceIndex(overrides.workspace);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const scrollRef = { current: container } as RefObject<HTMLElement | null>;
  const scrollTop = { current: 0 };

  function Harness() {
    const [filter, setFilter] = useState<DeadlineFilter>(overrides.filter ?? DEFAULT_DEADLINE_FILTER);
    const [focusKey, setFocusKey] = useState<string | null>(overrides.focusKey ?? null);
    return <DeadlinesPage index={index} filter={filter} onFilterChange={setFilter} focusKey={focusKey}
      onFocusKey={(key) => { setFocusKey(key); handlers.onFocusKey(key); }} scrollRef={scrollRef} scrollTop={scrollTop}
      onEditTask={handlers.onEditTask} onArrangeTask={handlers.onArrangeTask} onOpenProject={handlers.onOpenProject} onContinueMilestone={handlers.onContinueMilestone} />;
  }
  render(<Harness />, { container });
  return { ...handlers, index, container, scrollTop };
}

function rowOf(key: string) {
  const row = document.querySelector<HTMLElement>(`[data-deadline-key="${key}"]`);
  if (!row) throw new Error(`没有找到 ${key} 对应的截止行`);
  return row;
}

function rowTitles() {
  return [...document.querySelectorAll(".deadline-title")].map((node) => node.textContent);
}

describe("deadlines page", () => {
  it("shows each kind with its own facts instead of inventing a project completion", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-03-07T09:00:00"));
    renderPage({
      workspace: workspace({
        projects: [project("p-1", { title: "学会 Python" })],
        tasks: [task("t-1", { title: "写第一段代码", projectId: "p-1", progress: 40 }), task("t-2", { title: "读文档", projectId: "p-1", status: "completed", progress: 100 })],
        projectMilestones: [frozenMilestone("m-1", "p-1")],
        milestoneOutcomes: [{ id: "o-1", milestoneId: "m-1", projectId: "p-1", title: "目标 m-1", targetLocalDate: "2026-03-01", reached: false, resultText: "完成 1/3，未达成", frozenAtUtc: "2026-03-02T00:00:00Z" }],
      }),
    });

    expect(within(rowOf("task:t-1")).getByText("进度 40%")).toBeVisible();
    expect(within(rowOf("project:p-1")).getByText("当前任务 1/2 已完成")).toBeVisible();
    const milestoneRow = rowOf("milestone:m-1");
    expect(within(milestoneRow).getByText("到期未达成")).toBeVisible();
    expect(within(milestoneRow).getByText(/完成 1\/3，未达成/)).toBeVisible();
    // 冻结目标只有查看与续排。
    expect(within(milestoneRow).getByRole("button", { name: /定位里程碑/ })).toBeVisible();
    expect(within(milestoneRow).getByRole("button", { name: /续排里程碑/ })).toBeVisible();
  });

  it("separates the no-data state from the no-match state and only the latter offers clearing", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-03-07T09:00:00"));
    renderPage({ workspace: workspace() });
    expect(screen.getByText("没有截止事项")).toBeVisible();
    expect(within(document.querySelector(".empty-state") as HTMLElement).queryByRole("button")).toBeNull();

    renderPage({ workspace: workspace({ tasks: [task("t-1", { title: "只有一项" })] }), filter: { ...DEFAULT_DEADLINE_FILTER, query: "找不到的东西" } });
    expect(screen.getByText("筛选没有匹配")).toBeVisible();
    expect(within(document.querySelectorAll(".empty-state")[1] as HTMLElement).getByRole("button", { name: /清除筛选/ })).toBeVisible();
  });

  it("filters by keyword and by type without reordering the remaining rows", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-03-07T09:00:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage({
      workspace: workspace({
        tasks: [task("t-1", { title: "Alpha 一", sortOrder: 0 }), task("t-2", { title: "Beta", sortOrder: 1 }), task("t-3", { title: "Alpha 二", sortOrder: 2 })],
      }),
    });

    await user.type(screen.getByLabelText("按关键字筛选"), "alpha");
    expect(rowTitles()).toEqual(["Alpha 一", "Alpha 二"]);

    await user.clear(screen.getByLabelText("按关键字筛选"));
    expect(rowTitles()).toEqual(["Alpha 一", "Beta", "Alpha 二"]);
    // 类型筛选是可切换的：关掉「任务」后这一页只剩项目与里程碑（这里都没有）。
    await user.click(screen.getByRole("button", { name: "任务" }));
    expect(rowTitles()).toEqual([]);
    expect(screen.getByText("筛选没有匹配")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "任务" }));
    expect(rowTitles()).toEqual(["Alpha 一", "Beta", "Alpha 二"]);
  });

  it("keeps a paused task visible without offering a schedule entry", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-03-07T09:00:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const harness = renderPage({ workspace: workspace({ tasks: [task("t-1", { title: "暂停中的任务", status: "paused" })] }) });

    expect(screen.queryByText("暂停中的任务")).toBeNull();
    await user.click(screen.getByLabelText("显示已暂停的任务"));
    const row = rowOf("task:t-1");
    expect(within(row).getByText("已暂停，不能重新安排")).toBeVisible();
    expect(within(row).queryByRole("button", { name: /安排任务/ })).toBeNull();
    await user.click(within(row).getByRole("button", { name: /^编辑任务/ }));
    expect(harness.onEditTask).toHaveBeenCalledTimes(1);
    expect(harness.onEditTask.mock.calls[0][0]).toMatchObject({ id: "t-1" });
    expect(harness.onEditTask.mock.calls[0][1]).toBeInstanceOf(HTMLElement);
    expect(harness.onArrangeTask).not.toHaveBeenCalled();
  });

  it("hides currently reached milestones until the user asks for them", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-03-07T09:00:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage({
      workspace: workspace({
        projects: [project("p-1", { title: "项目" })],
        tasks: [task("t-1", { projectId: "p-1", status: "completed", progress: 100 })],
        projectMilestones: [{ id: "m-1", projectId: "p-1", title: "已达成目标", targetLocalDate: TODAY, sortOrder: 0, criterionKind: "taskCount", targetTaskId: null, targetCount: 1, targetProgress: null }],
      }),
    });
    expect(screen.queryByText("已达成目标")).toBeNull();
    await user.click(screen.getByLabelText("显示当前已达成的里程碑"));
    expect(within(rowOf("milestone:m-1")).getByText("当前已达成")).toBeVisible();
    // 当前达成项不是冻结历史，因此没有续排入口。
    expect(within(rowOf("milestone:m-1")).queryByRole("button", { name: /续排里程碑/ })).toBeNull();
  });

  it("emits row intents with the original source objects", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-03-07T09:00:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const harness = renderPage({
      workspace: workspace({
        projects: [project("p-1", { title: "项目" })],
        tasks: [task("t-1", { title: "可安排任务" })],
        projectMilestones: [frozenMilestone("m-1", "p-1")],
        milestoneOutcomes: [{ id: "o-1", milestoneId: "m-1", projectId: "p-1", title: "目标 m-1", targetLocalDate: "2026-03-01", reached: false, resultText: "完成 0/3，未达成", frozenAtUtc: "2026-03-02T00:00:00Z" }],
      }),
    });

    await user.click(within(rowOf("task:t-1")).getByRole("button", { name: /^安排任务/ }));
    expect(harness.onArrangeTask.mock.calls[0][0]).toMatchObject({ id: "t-1", title: "可安排任务" });
    await user.click(within(rowOf("project:p-1")).getByRole("button", { name: /定位项目/ }));
    expect(harness.onOpenProject).toHaveBeenCalledWith("p-1", null);
    await user.click(within(rowOf("milestone:m-1")).getByRole("button", { name: /定位里程碑/ }));
    expect(harness.onOpenProject).toHaveBeenCalledWith("p-1", "m-1");
    await user.click(within(rowOf("milestone:m-1")).getByRole("button", { name: /续排里程碑/ }));
    expect(harness.onContinueMilestone.mock.calls[0][0]).toMatchObject({ id: "m-1", projectId: "p-1" });
  });

  it("restores the remembered focus row on mount", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-03-07T09:00:00"));
    renderPage({ workspace: workspace({ tasks: [task("t-1", { title: "第一项" }), task("t-2", { title: "第二项", sortOrder: 1 })] }), focusKey: "task:t-2" });
    expect(document.activeElement).toBe(rowOf("task:t-2"));
    expect(rowOf("task:t-2").className).toContain("focused");
  });

  it("reports a stale focus item, clears it and keeps the list on the current snapshot", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-03-07T09:00:00"));
    const harness = renderPage({ workspace: workspace({ tasks: [task("t-1", { title: "还在的任务" })] }), focusKey: "task:deleted" });
    expect(screen.getByRole("status")).toHaveTextContent("上次查看的对象已经不存在");
    expect(harness.onFocusKey).toHaveBeenCalledWith(null);
    expect(screen.getByText("还在的任务")).toBeVisible();
  });

  it("records the scroll position of the shared container while the page is mounted", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-03-07T09:00:00"));
    const harness = renderPage({ workspace: workspace({ tasks: [task("t-1", { title: "第一项" })] }) });
    harness.container.scrollTop = 240;
    harness.container.dispatchEvent(new Event("scroll"));
    expect(harness.scrollTop.current).toBe(240);
  });
});
