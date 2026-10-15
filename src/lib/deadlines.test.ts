import { describe, expect, it } from "vitest";

import {
  DEADLINE_GROUP_ORDER, DEFAULT_DEADLINE_FILTER, addLocalDays, buildDeadlineItems, buildDeadlineItemsFromIndex, deadlineGroupOf,
  deadlineItemSourceExists, groupDeadlineItems, isDefaultDeadlineFilter, localDaysBetween, type DeadlineFilter,
} from "./deadlines";
import { createWorkspaceIndex, projectTaskCounts } from "./workspaceSelectors";
import { EMPTY_WORKSPACE, type Project, type ProjectMilestone, type Task, type WorkspaceSnapshot } from "./native";

/** 阶段 4 P4-06 / AC08：截止投影的分组边界、排序、过滤与里程碑冻结优先。 */

const TODAY = "2026-03-07";

function task(id: string, patch: Partial<Task> = {}): Task {
  return { id, projectId: null, title: id, progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sortOrder: 0, ...patch };
}

function project(id: string, patch: Partial<Project> = {}): Project {
  return { id, title: id, deadlineLocal: null, ...patch };
}

function milestone(id: string, projectId: string, patch: Partial<ProjectMilestone> = {}): ProjectMilestone {
  return { id, projectId, title: id, targetLocalDate: TODAY, sortOrder: 0, criterionKind: "projectProgress", targetTaskId: null, targetCount: null, targetProgress: 50, ...patch } as ProjectMilestone;
}

function workspace(patch: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return { ...structuredClone(EMPTY_WORKSPACE), ...patch };
}

function withFilter(patch: Partial<DeadlineFilter> = {}): DeadlineFilter {
  return { ...DEFAULT_DEADLINE_FILTER, ...patch };
}

describe("deadline grouping", () => {
  it("keeps the next-seven-days window exact across a daylight-saving boundary", () => {
    // 2026-03-08 是北美夏令时开始日：这一天在本地时区只有 23 小时，
    // 用固定 24 小时推算的边界会整体提前一天。这里的分组读的是本地日历。
    expect(deadlineGroupOf("2026-03-06", TODAY)).toBe("overdue");
    expect(deadlineGroupOf(TODAY, TODAY)).toBe("today");
    expect(deadlineGroupOf(addLocalDays(TODAY, 1), TODAY)).toBe("nextSevenDays");
    expect(deadlineGroupOf("2026-03-08", TODAY)).toBe("nextSevenDays");
    expect(deadlineGroupOf(addLocalDays(TODAY, 7), TODAY)).toBe("nextSevenDays");
    expect(deadlineGroupOf(addLocalDays(TODAY, 8), TODAY)).toBe("later");
  });

  it("adds and subtracts local days by calendar, not by fixed milliseconds", () => {
    expect(addLocalDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addLocalDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addLocalDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addLocalDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addLocalDays("2028-02-29", 1)).toBe("2028-03-01");
    expect(addLocalDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addLocalDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addLocalDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(localDaysBetween("2026-03-07", "2026-03-14")).toBe(7);
    expect(localDaysBetween("2026-03-14", "2026-03-07")).toBe(-7);
    expect(localDaysBetween("2026-02-28", "2026-03-01")).toBe(1);
  });

  it("groups only the buckets that actually hold items, in the fixed order", () => {
    const items = buildDeadlineItems(workspace({
      tasks: [
        task("overdue", { deadlineLocal: "2026-03-01" }),
        task("today", { deadlineLocal: TODAY }),
        task("soon", { deadlineLocal: "2026-03-09" }),
        task("later", { deadlineLocal: "2026-04-01" }),
      ],
    }), TODAY);
    expect(groupDeadlineItems(items, TODAY).map((bucket) => bucket.group)).toEqual([...DEADLINE_GROUP_ORDER]);
    expect(groupDeadlineItems(items.slice(0, 2), TODAY).map((bucket) => bucket.group)).toEqual(["overdue", "today"]);
  });
});

describe("deadline sorting", () => {
  it("sorts by date, then kind, then the original sort order, then a stable id", () => {
    const items = buildDeadlineItems(workspace({
      tasks: [
        task("task-late", { deadlineLocal: "2026-03-09", sortOrder: 0 }),
        task("task-b", { deadlineLocal: TODAY, sortOrder: 5 }),
        task("task-a", { deadlineLocal: TODAY, sortOrder: 1 }),
        task("task-c", { deadlineLocal: TODAY, sortOrder: 1 }),
      ],
      projects: [project("project-1", { deadlineLocal: TODAY, title: "Z 项目" })],
      projectMilestones: [milestone("milestone-1", "project-1")],
    }), TODAY);
    // 同一日期：任务 → 项目 → 里程碑；任务内部先按 sortOrder，再按稳定 ID。
    expect(items.map((item) => item.sourceId)).toEqual(["task-a", "task-c", "task-b", "project-1", "milestone-1", "task-late"]);
    expect(items.map((item) => item.key)).toEqual(["task:task-a", "task:task-c", "task:task-b", "project:project-1", "milestone:milestone-1", "task:task-late"]);
  });

  it("orders projects on the same date by title because the domain has no project sort order", () => {
    const items = buildDeadlineItems(workspace({
      projects: [project("p-2", { title: "B 项目", deadlineLocal: TODAY }), project("p-1", { title: "A 项目", deadlineLocal: TODAY })],
    }), TODAY);
    expect(items.map((item) => item.title)).toEqual(["A 项目", "B 项目"]);
  });

  it("produces the same order no matter how the workspace arrays are ordered", () => {
    // 「确定性全序」的真正判据：顺序只能由数据决定，不能由输入数组的排列决定。
    // 项目没有 sortOrder，所以它的那一级用标题收尾；这条用例保证没有哪一级偷偷依赖了输入顺序。
    const tasks = [
      task("t-a", { deadlineLocal: TODAY, sortOrder: 1 }),
      task("t-b", { deadlineLocal: TODAY, sortOrder: 1 }),
      task("t-c", { deadlineLocal: addLocalDays(TODAY, 2), sortOrder: 0 }),
    ];
    const projects = [project("p-2", { title: "B 项目", deadlineLocal: TODAY }), project("p-1", { title: "A 项目", deadlineLocal: TODAY })];
    const projectMilestones = [milestone("m-2", "p-1", { sortOrder: 1 }), milestone("m-1", "p-1", { sortOrder: 0 })];

    const forward = buildDeadlineItems(workspace({ tasks, projects, projectMilestones }), TODAY).map((item) => item.key);
    const reversed = buildDeadlineItems(workspace({
      tasks: [...tasks].reverse(), projects: [...projects].reverse(), projectMilestones: [...projectMilestones].reverse(),
    }), TODAY).map((item) => item.key);

    expect(reversed).toEqual(forward);
    expect(forward).toEqual(["task:t-a", "task:t-b", "project:p-1", "project:p-2", "milestone:m-1", "milestone:m-2", "task:t-c"]);
  });
});

describe("deadline task rules", () => {
  it("hides tasks without a deadline and every habit-internal task", () => {
    const items = buildDeadlineItems(workspace({
      tasks: [
        task("no-deadline"),
        task("habit-task", { deadlineLocal: TODAY, kind: "habit" }),
        task("normal", { deadlineLocal: TODAY }),
      ],
    }), TODAY);
    expect(items.map((item) => item.sourceId)).toEqual(["normal"]);
  });

  it("shows only active tasks by default and accepts explicit completed or paused opt-ins", () => {
    const snapshot = workspace({
      tasks: [
        task("active", { deadlineLocal: TODAY }),
        task("completed", { deadlineLocal: TODAY, status: "completed", progress: 100 }),
        task("paused", { deadlineLocal: TODAY, status: "paused" }),
      ],
    });
    expect(buildDeadlineItems(snapshot, TODAY).map((item) => item.sourceId)).toEqual(["active"]);
    expect(buildDeadlineItems(snapshot, TODAY, withFilter({ taskStatuses: ["active", "completed"] })).map((item) => item.sourceId)).toEqual(["active", "completed"]);
    expect(buildDeadlineItems(snapshot, TODAY, withFilter({ taskStatuses: ["paused"] })).map((item) => item.sourceId)).toEqual(["paused"]);
  });

  it("filters by project and by keyword without changing order or content", () => {
    const snapshot = workspace({
      projects: [project("p-1", { title: "课程" })],
      tasks: [
        task("in-project", { projectId: "p-1", title: "Alpha 一", deadlineLocal: TODAY, sortOrder: 0 }),
        task("alpha-2", { title: "Alpha 二", deadlineLocal: TODAY, sortOrder: 1 }),
        task("beta", { title: "Beta", deadlineLocal: TODAY, sortOrder: 2 }),
      ],
    });
    expect(buildDeadlineItems(snapshot, TODAY, withFilter({ projectId: "p-1" })).map((item) => item.sourceId)).toEqual(["in-project"]);
    const searched = buildDeadlineItems(snapshot, TODAY, withFilter({ query: "alpha" }));
    expect(searched.map((item) => item.sourceId)).toEqual(["in-project", "alpha-2"]);
    expect(searched[0]).toEqual({ key: "task:in-project", kind: "task", sourceId: "in-project", projectId: "p-1", date: TODAY, title: "Alpha 一", state: "open" });
  });

  it("matches keywords against the title only, never the owning project's name", () => {
    // 刻意的产品口径（D2）：搜「Rust」不会因为项目名命中而带出该项目下标题不含关键字的
    // 任务 —— 想按项目看就用「项目」下拉筛选。
    const snapshot = workspace({
      projects: [project("p-rust", { title: "Rust 入门" })],
      tasks: [task("t-1", { projectId: "p-rust", title: "起步", deadlineLocal: TODAY })],
    });
    expect(buildDeadlineItems(snapshot, TODAY).map((item) => item.sourceId)).toEqual(["t-1"]);
    expect(buildDeadlineItems(snapshot, TODAY, withFilter({ query: "Rust" }))).toEqual([]);
    expect(buildDeadlineItems(snapshot, TODAY, withFilter({ projectId: "p-rust" })).map((item) => item.sourceId)).toEqual(["t-1"]);
  });

  it("keeps task items keyed by kind and source id and resolves them against the index", () => {
    const snapshot = workspace({ tasks: [task("t-1", { deadlineLocal: TODAY })] });
    const items = buildDeadlineItems(snapshot, TODAY);
    const index = createWorkspaceIndex(snapshot);
    expect(items[0].key).toBe("task:t-1");
    expect(deadlineItemSourceExists(index, items[0].key)).toBe(true);
    expect(deadlineItemSourceExists(index, "task:missing")).toBe(false);
    expect(deadlineItemSourceExists(index, "nonsense")).toBe(false);
  });
});

describe("deadline project rules", () => {
  it("uses the project's own declared deadline and never the last child deadline", () => {
    const items = buildDeadlineItems(workspace({
      projects: [project("p-1", { title: "学会 Python", deadlineLocal: "2026-05-01" })],
      tasks: [task("child", { projectId: "p-1", deadlineLocal: "2026-03-09" })],
    }), TODAY, withFilter({ kinds: ["project"] }));
    expect(items).toHaveLength(1);
    expect(items[0].date).toBe("2026-05-01");
    expect(items[0].projectId).toBe("p-1");
  });

  it("still shows a project deadline when the project has no tasks", () => {
    const snapshot = workspace({ projects: [project("p-1", { title: "空项目", deadlineLocal: TODAY })] });
    expect(buildDeadlineItems(snapshot, TODAY, withFilter({ kinds: ["project"] })).map((item) => item.sourceId)).toEqual(["p-1"]);
    expect(projectTaskCounts(createWorkspaceIndex(snapshot), "p-1")).toEqual({ total: 0, completed: 0 });
  });

  it("counts completed project tasks instead of claiming the project is finished", () => {
    const snapshot = workspace({
      projects: [project("p-1", { title: "项目", deadlineLocal: TODAY })],
      tasks: [
        task("done", { projectId: "p-1", status: "completed", progress: 100 }),
        task("open", { projectId: "p-1" }),
        task("elsewhere", { projectId: null, status: "completed", progress: 100 }),
      ],
    });
    expect(projectTaskCounts(createWorkspaceIndex(snapshot), "p-1")).toEqual({ total: 2, completed: 1 });
  });
});

describe("deadline milestone rules", () => {
  it("keeps a frozen unmet result even after the project has caught up", () => {
    const snapshot = workspace({
      projects: [project("p-1", { title: "项目" })],
      tasks: [task("t-1", { projectId: "p-1", status: "completed", progress: 100 })],
      projectMilestones: [milestone("m-1", "p-1", { targetLocalDate: "2026-03-01", criterionKind: "taskCount", targetCount: 2, targetProgress: null })],
      milestoneOutcomes: [{ id: "o-1", milestoneId: "m-1", projectId: "p-1", title: "m-1", targetLocalDate: "2026-03-01", reached: false, resultText: "完成 0/2，未达成", frozenAtUtc: "2026-03-02T00:00:00Z" }],
    });
    const items = buildDeadlineItems(snapshot, TODAY, withFilter({ kinds: ["milestone"] }));
    expect(items).toHaveLength(1);
    expect(items[0].state).toBe("frozenUnmet");
    expect(items[0].date).toBe("2026-03-01");
  });

  it("hides currently reached milestones by default and shows them on request", () => {
    const snapshot = workspace({
      projects: [project("p-1", { title: "项目" })],
      tasks: [task("t-1", { projectId: "p-1", status: "completed", progress: 100 })],
      projectMilestones: [milestone("m-1", "p-1", { criterionKind: "taskCount", targetCount: 1, targetProgress: null })],
    });
    expect(buildDeadlineItems(snapshot, TODAY, withFilter({ kinds: ["milestone"] }))).toEqual([]);
    const shown = buildDeadlineItems(snapshot, TODAY, withFilter({ kinds: ["milestone"], includeReachedMilestones: true }));
    expect(shown).toHaveLength(1);
    expect(shown[0].state).toBe("currentlyReached");
  });

  it("derives the current state with the same rule as M7 when nothing is frozen", () => {
    const ordered: ProjectMilestone = { id: "m-ordered", projectId: "p-1", title: "m-ordered", targetLocalDate: TODAY, sortOrder: 0, criterionKind: "orderedTask", targetTaskId: "t-2", targetCount: null, targetProgress: null };
    // 目标任务已完成，但它前面的任务还没完成 —— 按 M7 规则仍视为未达成。
    const blocked = workspace({
      projects: [project("p-1", { title: "项目" })],
      tasks: [task("t-1", { projectId: "p-1", sortOrder: 0 }), task("t-2", { projectId: "p-1", sortOrder: 1, status: "completed", progress: 100 })],
      projectMilestones: [ordered],
    });
    expect(buildDeadlineItems(blocked, TODAY, withFilter({ kinds: ["milestone"] }))[0].state).toBe("open");
    // 前置任务补齐后同一条规则给出「当前已达成」。
    const unblocked = workspace({ ...blocked, tasks: blocked.tasks.map((item) => item.id === "t-1" ? { ...item, status: "completed" as const, progress: 100 } : item) });
    expect(buildDeadlineItems(unblocked, TODAY, withFilter({ kinds: ["milestone"], includeReachedMilestones: true }))[0].state).toBe("currentlyReached");
  });

  it("does not hide project items when their tasks are counted as reached", () => {
    const snapshot = workspace({
      projects: [project("p-1", { title: "项目", deadlineLocal: TODAY })],
      tasks: [task("t-1", { projectId: "p-1", status: "completed", progress: 100 })],
      projectMilestones: [milestone("m-1", "p-1", { criterionKind: "taskCount", targetCount: 1, targetProgress: null })],
    });
    const items = buildDeadlineItems(snapshot, TODAY);
    expect(items.map((item) => item.key)).toEqual(["project:p-1"]);
  });
});

describe("deadline filter helpers", () => {
  it("recognizes the default filter and every explicit deviation", () => {
    expect(isDefaultDeadlineFilter(DEFAULT_DEADLINE_FILTER)).toBe(true);
    expect(isDefaultDeadlineFilter({ ...DEFAULT_DEADLINE_FILTER, kinds: ["task", "project"] })).toBe(false);
    expect(isDefaultDeadlineFilter({ ...DEFAULT_DEADLINE_FILTER, projectId: "p-1" })).toBe(false);
    expect(isDefaultDeadlineFilter({ ...DEFAULT_DEADLINE_FILTER, taskStatuses: ["active", "paused"] })).toBe(false);
    expect(isDefaultDeadlineFilter({ ...DEFAULT_DEADLINE_FILTER, includeReachedMilestones: true })).toBe(false);
    expect(isDefaultDeadlineFilter({ ...DEFAULT_DEADLINE_FILTER, query: "  " })).toBe(true);
    expect(isDefaultDeadlineFilter({ ...DEFAULT_DEADLINE_FILTER, query: "x" })).toBe(false);
  });

  it("projects the same list from a prepared index as from the raw snapshot", () => {
    const snapshot = workspace({ tasks: [task("t-1", { deadlineLocal: TODAY })] });
    expect(buildDeadlineItemsFromIndex(createWorkspaceIndex(snapshot), TODAY)).toEqual(buildDeadlineItems(snapshot, TODAY));
  });
});
