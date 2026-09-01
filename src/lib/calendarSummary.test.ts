import { describe, expect, it } from "vitest";

import { calendarDayMarkers, calendarDaySummary, deadlineUrgency, deadlineUrgencyLabel } from "./calendarSummary";
import { EMPTY_WORKSPACE, type WorkspaceSnapshot } from "./native";

describe("calendar day summary", () => {
  it("prioritizes deadlines before outcome summaries and caps the month cell at three rows", () => {
    const workspace: WorkspaceSnapshot = {
      ...structuredClone(EMPTY_WORKSPACE),
      tasks: [
        { id: "due-1", projectId: null, title: "先交报告", progress: 20, status: "active", deadlineLocal: "2026-08-05", estimatedMinutes: 60, sortOrder: 0 },
        { id: "due-2", projectId: null, title: "再交附件", progress: 0, status: "active", deadlineLocal: "2026-08-05", estimatedMinutes: 30, sortOrder: 1 },
        { id: "done", projectId: null, title: "完成事项", progress: 100, status: "completed", deadlineLocal: null, estimatedMinutes: 30, sortOrder: 2 },
        { id: "moving", projectId: null, title: "推进事项", progress: 40, status: "active", deadlineLocal: null, estimatedMinutes: 30, sortOrder: 3 },
        { id: "missed", projectId: null, title: "未推进事项", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 30, sortOrder: 4 },
      ],
      progressEvents: [
        { id: "done-event", taskId: "done", fromProgress: 80, toProgress: 100, occurredAtUtc: "2026-08-05T12:00:00Z" },
        { id: "moving-event", taskId: "moving", fromProgress: 10, toProgress: 40, occurredAtUtc: "2026-08-05T13:00:00Z" },
      ],
      executionSessions: [{ id: "missed-session", taskId: "missed", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "09:00", endLocal: "10:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "missed" }],
    };

    const summary = calendarDaySummary(workspace, "2026-08-05", "2026-08-05");

    expect(summary.visible.map((item) => item.label)).toEqual(["先交报告", "再交附件", "完成 1 项"]);
    expect(summary.overflowCount).toBe(2);
    expect(summary.progressDelta).toBe(50);
    expect(summary.missedTasks.map((task) => task.title)).toEqual(["未推进事项"]);
    expect(summary.visible[0].urgency).toBe("today");
  });

  it("classifies deadline urgency against the user's local date", () => {
    expect(deadlineUrgency("2026-08-04", "2026-08-05")).toBe("overdue");
    expect(deadlineUrgency("2026-08-05", "2026-08-05")).toBe("today");
    expect(deadlineUrgency("2026-08-12", "2026-08-05")).toBe("soon");
    expect(deadlineUrgency("2026-08-13", "2026-08-05")).toBe("later");
    expect(deadlineUrgencyLabel("overdue")).toBe("已逾期");
  });

  it("aggregates project deadlines and milestones into the day summary after task deadlines", () => {
    const workspace: WorkspaceSnapshot = {
      ...structuredClone(EMPTY_WORKSPACE),
      projects: [
        { id: "project-1", title: "毕业设计", deadlineLocal: "2026-08-05" },
        { id: "project-2", title: "无截止项目", deadlineLocal: null },
      ],
      projectMilestones: [
        { id: "ms-1", projectId: "project-1", title: "中期答辩", targetLocalDate: "2026-08-05", sortOrder: 0, criterionKind: "orderedTask", targetTaskId: "task-1", targetCount: null, targetProgress: null },
        { id: "ms-2", projectId: "project-1", title: "后续里程碑", targetLocalDate: "2026-09-01", sortOrder: 1, criterionKind: "taskCount", targetTaskId: null, targetCount: 3, targetProgress: null },
      ],
      tasks: [{ id: "task-1", projectId: "project-1", title: "写论文", progress: 40, status: "active", deadlineLocal: "2026-08-05", estimatedMinutes: 60, sortOrder: 0 }],
    };

    const summary = calendarDaySummary(workspace, "2026-08-05", "2026-08-05");

    expect(summary.deadlines.map((task) => task.title)).toEqual(["写论文"]);
    expect(summary.projectDeadlines.map((project) => project.title)).toEqual(["毕业设计"]);
    expect(summary.milestones.map((milestone) => milestone.title)).toEqual(["中期答辩"]);
    expect(summary.visible.map((item) => item.kind)).toEqual(["deadline", "projectDeadline", "milestone"]);
    expect(summary.visible[1]).toMatchObject({ projectId: "project-1", label: "毕业设计", urgency: "today" });
    expect(summary.visible[2]).toMatchObject({ milestoneId: "ms-1", projectId: "project-1", label: "中期答辩" });
  });

  it("builds week markers with distinct kinds for task, project and milestone", () => {
    const workspace: WorkspaceSnapshot = {
      ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "毕业设计", deadlineLocal: "2026-08-05" }],
      projectMilestones: [{ id: "ms-1", projectId: "project-1", title: "中期答辩", targetLocalDate: "2026-08-05", sortOrder: 0, criterionKind: "orderedTask", targetTaskId: "task-1", targetCount: null, targetProgress: null }],
      tasks: [{ id: "task-1", projectId: "project-1", title: "写论文", progress: 40, status: "active", deadlineLocal: "2026-08-05", estimatedMinutes: 60, sortOrder: 0 }],
    };

    const markers = calendarDayMarkers(workspace, "2026-08-05", "2026-08-05");

    expect(markers.map((marker) => marker.kind)).toEqual(["taskDeadline", "projectDeadline", "milestone"]);
    expect(markers[1]).toMatchObject({ projectId: "project-1", label: "毕业设计" });
    expect(markers[2]).toMatchObject({ milestoneId: "ms-1", projectId: "project-1", label: "中期答辩" });
  });
});
