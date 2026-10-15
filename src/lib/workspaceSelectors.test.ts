import { describe, expect, it } from "vitest";

import {
  createWorkspaceIndex, isPendingReview, isPendingReviewIn, isTaskCompleted, milestoneReached, milestoneReachedNow, milestoneSummary, orderedMilestoneTasks,
  pendingReviewSessions, projectProgress, projectTaskCounts, projectTasksOf, taskTitleOf,
} from "./workspaceSelectors";
import { EMPTY_WORKSPACE, type ExecutionSession, type Project, type ProjectMilestone, type Task, type WorkspaceSnapshot } from "./native";

/** 阶段 4 P4-06：共享索引与事实选择器（含「待回顾」的唯一判断）。 */

function task(id: string, patch: Partial<Task> = {}): Task {
  return { id, projectId: null, title: id, progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sortOrder: 0, ...patch };
}

function project(id: string): Project {
  return { id, title: id, deadlineLocal: null };
}

function session(id: string, patch: Partial<ExecutionSession> = {}): ExecutionSession {
  return { id, taskId: "t-1", localDate: "2026-03-07", endLocalDate: "2026-03-07", startLocal: "09:00", endLocal: "10:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled", ...patch };
}

function workspace(patch: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return { ...structuredClone(EMPTY_WORKSPACE), ...patch };
}

const NOON = new Date("2026-03-07T12:00:00+08:00");

describe("workspace index", () => {
  it("indexes every collection by id and groups sessions and project tasks", () => {
    const snapshot = workspace({
      projects: [project("p-1")],
      tasks: [task("t-1", { projectId: "p-1" }), task("t-2")],
      executionSessions: [session("s-1"), session("s-2", { taskId: "t-2" })],
      executionRecords: [
        { id: "r-1", sessionId: "s-1", taskId: "t-1", actualStartUtc: "2026-03-07T01:00:00Z", actualEndUtc: "2026-03-07T02:00:00Z", note: "" },
        { id: "r-2", sessionId: null, taskId: "t-1", actualStartUtc: "2026-03-07T03:00:00Z", actualEndUtc: "2026-03-07T04:00:00Z", note: "补录" },
      ],
    });
    const index = createWorkspaceIndex(snapshot);
    expect(index.tasksById.get("t-1")).toBe(snapshot.tasks[0]);
    expect(index.projectsById.get("p-1")).toBe(snapshot.projects[0]);
    expect(index.sessionsById.get("s-2")).toBe(snapshot.executionSessions[1]);
    expect(index.recordsById.get("r-2")).toBe(snapshot.executionRecords[1]);
    expect(index.recordsBySessionId.get("s-1")?.map((record) => record.id)).toEqual(["r-1"]);
    // 直接挂任务的补录不属于任何时段，不能算进「该时段已有记录」。
    expect(index.recordsBySessionId.has("")).toBe(false);
    expect(projectTasksOf(index, "p-1").map((item) => item.id)).toEqual(["t-1"]);
    expect(projectTasksOf(index, "missing")).toEqual([]);
    expect(taskTitleOf(index, "t-2")).toBe("t-2");
    expect(taskTitleOf(index, "missing")).toBe("未知任务");
  });

  it("indexes milestones and frozen outcomes so the deadline view never rescans them", () => {
    const milestone: ProjectMilestone = { id: "m-1", projectId: "p-1", title: "里程碑", targetLocalDate: "2026-03-01", sortOrder: 0, criterionKind: "taskCount", targetTaskId: null, targetCount: 2, targetProgress: null };
    const snapshot = workspace({
      projects: [project("p-1")],
      projectMilestones: [milestone],
      milestoneOutcomes: [{ id: "o-1", milestoneId: "m-1", projectId: "p-1", title: "里程碑", targetLocalDate: "2026-03-01", reached: false, resultText: "完成 0/2，未达成", frozenAtUtc: "2026-03-02T00:00:00Z" }],
    });
    const index = createWorkspaceIndex(snapshot);
    expect(index.milestonesById.get("m-1")).toBe(snapshot.projectMilestones[0]);
    expect(index.milestonesByProjectId.get("p-1")).toHaveLength(1);
    expect(index.outcomesByMilestoneId.get("m-1")?.resultText).toBe("完成 0/2，未达成");
    expect([...index.frozenMilestoneIds]).toEqual(["m-1"]);
  });

  it("is a snapshot of one workspace revision instead of a live view", () => {
    const snapshot = workspace({ tasks: [task("t-1")] });
    const index = createWorkspaceIndex(snapshot);
    snapshot.tasks.push(task("t-2"));
    expect(index.tasksById.has("t-2")).toBe(false);
    expect(createWorkspaceIndex(snapshot).tasksById.has("t-2")).toBe(true);
  });
});

describe("pending review", () => {
  const ended = session("s-1", { startLocal: "09:00", endLocal: "10:00" });

  it("only counts a scheduled, ended, unfinished session without an execution record", () => {
    expect(isPendingReview(ended, task("t-1"), [], NOON)).toBe(true);
    expect(isPendingReview(ended, task("t-1"), [{ id: "r-1", sessionId: "s-1", taskId: "t-1", actualStartUtc: "2026-03-07T01:00:00Z", actualEndUtc: "2026-03-07T02:00:00Z", note: "" }], NOON)).toBe(false);
    expect(isPendingReview(session("s-2", { startLocal: "20:00", endLocal: "21:00" }), task("t-1"), [], NOON)).toBe(false);
    expect(isPendingReview(session("s-3", { status: "missed" }), task("t-1"), [], NOON)).toBe(false);
    expect(isPendingReview(ended, task("t-1", { progress: 100, status: "completed" }), [], NOON)).toBe(false);
    expect(isPendingReview(ended, undefined, [], NOON)).toBe(false);
  });

  it("treats an explicit 100% progress as finished even when the status still says active", () => {
    expect(isTaskCompleted(task("t-1", { progress: 100 }))).toBe(true);
    expect(isTaskCompleted(task("t-1", { status: "completed" }))).toBe(true);
    expect(isTaskCompleted(task("t-1", { progress: 60 }))).toBe(false);
    expect(isPendingReview(ended, task("t-1", { progress: 100 }), [], NOON)).toBe(false);
  });

  it("reads the same judgement through the index so callers share one implementation", () => {
    const snapshot = workspace({
      tasks: [task("t-1"), task("t-2", { progress: 100, status: "completed" })],
      executionSessions: [ended, session("s-2", { taskId: "t-2" })],
    });
    const index = createWorkspaceIndex(snapshot);
    expect(isPendingReviewIn(index, snapshot.executionSessions[0], NOON)).toBe(true);
    expect(isPendingReviewIn(index, snapshot.executionSessions[1], NOON)).toBe(false);
    expect(pendingReviewSessions(index, NOON).map((item) => item.id)).toEqual(["s-1"]);
  });
});

describe("shared milestone and project rules", () => {
  it("computes the weighted project progress with a 60 minute fallback", () => {
    expect(projectProgress([task("a", { progress: 50, estimatedMinutes: 120 }), task("b", { progress: 100, estimatedMinutes: 60 })])).toBe(67);
    expect(projectProgress([])).toBe(0);
  });

  it("keeps the ordered-task rule: a finished target is not reached while an earlier task is open", () => {
    const milestone: ProjectMilestone = { id: "m-1", projectId: "p-1", title: "m-1", targetLocalDate: "2026-03-01", sortOrder: 0, criterionKind: "orderedTask", targetTaskId: "t-2", targetCount: null, targetProgress: null };
    const tasks = [task("t-1", { projectId: "p-1", sortOrder: 0 }), task("t-2", { projectId: "p-1", sortOrder: 1, status: "completed", progress: 100 })];
    expect(orderedMilestoneTasks(milestone, tasks).map((item) => item.id)).toEqual(["t-1", "t-2"]);
    expect(milestoneReached(milestone, tasks, projectProgress(tasks))).toBe(false);
    expect(milestoneReached(milestone, [tasks[1]], 100)).toBe(true);
    // 目标任务已经不在项目里：无法证明达成。
    expect(orderedMilestoneTasks(milestone, [tasks[0]])).toEqual([]);
    expect(milestoneReached(milestone, [tasks[0]], 0)).toBe(false);
  });

  it("keeps the count and weighted-progress rules and exposes them through the index", () => {
    const counted: ProjectMilestone = { id: "m-count", projectId: "p-1", title: "m-count", targetLocalDate: "2026-03-01", sortOrder: 0, criterionKind: "taskCount", targetTaskId: null, targetCount: 2, targetProgress: null };
    const progress: ProjectMilestone = { id: "m-progress", projectId: "p-1", title: "m-progress", targetLocalDate: "2026-03-01", sortOrder: 1, criterionKind: "projectProgress", targetTaskId: null, targetCount: null, targetProgress: 60 };
    const snapshot = workspace({
      projects: [project("p-1")],
      tasks: [task("t-1", { projectId: "p-1", status: "completed", progress: 100, estimatedMinutes: 60 }), task("t-2", { projectId: "p-1", estimatedMinutes: 60 })],
      projectMilestones: [counted, progress],
    });
    const index = createWorkspaceIndex(snapshot);
    expect(milestoneReachedNow(index, counted)).toBe(false);
    expect(milestoneReachedNow(index, progress)).toBe(false);
    expect(milestoneReachedNow(index, { ...counted, targetCount: 1 })).toBe(true);
    expect(milestoneReachedNow(index, { ...progress, targetProgress: 50 })).toBe(true);
    expect(projectTaskCounts(index, "p-1")).toEqual({ total: 2, completed: 1 });
  });

  it("renders a readable milestone summary", () => {
    const counted: ProjectMilestone = { id: "m-1", projectId: "p-1", title: "m-1", targetLocalDate: "2026-03-09", sortOrder: 0, criterionKind: "taskCount", targetTaskId: null, targetCount: 3, targetProgress: null };
    expect(milestoneSummary(counted, [])).toBe("完成 3 个项目任务 · 3/9 前");
  });
});
