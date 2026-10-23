import { describe, expect, it } from "vitest";

import type { ProjectMilestone, Task } from "./native";
import { buildProjectRail, milestoneRailPosition } from "./projectRail";

function task(id: string, estimatedMinutes: number | null, progress = 0, sortOrder = 0): Task {
  return {
    id, projectId: "p-1", title: id, progress, status: progress >= 100 ? "completed" : "active",
    deadlineLocal: null, estimatedMinutes, sessionMinutes: null, priority: "normal", sortOrder, kind: "task",
  };
}

function milestone(overrides: Partial<ProjectMilestone>): ProjectMilestone {
  return {
    id: "m-1", projectId: "p-1", title: "里程碑", targetLocalDate: "2026-09-01", sortOrder: 0,
    criterionKind: "projectProgress", targetTaskId: null, targetCount: null, targetProgress: 50,
    ...overrides,
  } as ProjectMilestone;
}

describe("project rail", () => {
  it("places a projectProgress milestone exactly at its target", () => {
    expect(milestoneRailPosition(milestone({ targetProgress: 62 }), [task("a", 60)])).toBe(62);
  });

  it("places an orderedTask milestone at the weighted progress through its target", () => {
    const tasks = [task("a", 60, 0, 0), task("b", 120, 0, 1), task("c", 60, 0, 2)];
    const m = milestone({ criterionKind: "orderedTask", targetTaskId: "b", targetProgress: null });
    expect(milestoneRailPosition(m, tasks)).toBe(75);
  });

  it("places a taskCount milestone at the equal-weight target ratio and marks it approximate", () => {
    const tasks = [task("a", 60, 0, 0), task("b", 120, 0, 1), task("c", 60, 0, 2), task("d", 60, 0, 3)];
    const m = milestone({ criterionKind: "taskCount", targetCount: 2, targetProgress: null });
    const rail = buildProjectRail({ tasks, milestones: [m], outcomes: new Map(), progress: 30 });
    expect(rail.nodes[0].position).toBe(50);
    expect(rail.nodes[0].approximate).toBe(true);
    expect(rail.nodes[0].state).toBe("active");
  });

  it("uses the frozen outcome for reached/missed state and picks the earliest active milestone as next", () => {
    const tasks = [task("a", 60, 100, 0), task("b", 60, 0, 1)];
    const frozenMissed = milestone({ id: "m-missed", title: "已冻结", targetLocalDate: "2026-08-01", criterionKind: "taskCount", targetCount: 2, targetProgress: null });
    const active = milestone({ id: "m-active", title: "下一步", targetLocalDate: "2026-09-01", targetProgress: 50 });
    const reached = milestone({ id: "m-reached", title: "已达成", targetLocalDate: "2026-07-01", targetProgress: 10 });
    const outcomes = new Map([["m-missed", { id: "o-1", milestoneId: "m-missed", projectId: "p-1", title: "已冻结", targetLocalDate: "2026-08-01", reached: false, resultText: "完成 0/2，未达成", frozenAtUtc: "2026-08-02T00:00:00Z" }]]);
    const rail = buildProjectRail({ tasks, milestones: [frozenMissed, active, reached], outcomes, progress: 40 });
    expect(rail.nodes.find((node) => node.milestone.id === "m-missed")?.state).toBe("missed");
    expect(rail.nodes.find((node) => node.milestone.id === "m-reached")?.state).toBe("reached");
    expect(rail.next?.milestone.id).toBe("m-active");
  });

  it("drops a milestone whose ordered target is no longer in the project", () => {
    const m = milestone({ criterionKind: "orderedTask", targetTaskId: "gone", targetProgress: null });
    expect(milestoneRailPosition(m, [task("a", 60)])).toBeNull();
  });
});
