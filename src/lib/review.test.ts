import { describe, expect, it } from "vitest";

import { EMPTY_WORKSPACE, type WorkspaceSnapshot } from "./native";
import { buildSevenDayReview } from "./review";

describe("simple seven-day review", () => {
  it("summarizes progress, actual input and missed facts without a score", () => {
    const workspace: WorkspaceSnapshot = {
      ...structuredClone(EMPTY_WORKSPACE),
      tasks: [
        { id: "done", projectId: null, title: "完成项", progress: 100, status: "completed", deadlineLocal: null, estimatedMinutes: 30, sessionMinutes: null, priority: "normal", sortOrder: 0, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task" },
        { id: "carry", projectId: null, title: "待续项", progress: 30, status: "active", deadlineLocal: null, estimatedMinutes: 60, sessionMinutes: null, priority: "normal", sortOrder: 1, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task" },
      ],
      progressEvents: [
        { id: "p1", taskId: "done", fromProgress: 60, toProgress: 100, occurredAtUtc: "2026-08-01T04:00:00.000Z" },
        { id: "p2", taskId: "carry", fromProgress: 10, toProgress: 30, occurredAtUtc: "2026-08-02T04:00:00.000Z" },
      ],
      executionSessions: [{ id: "s1", taskId: "carry", localDate: "2026-08-02", endLocalDate: "2026-08-02", startLocal: "19:00", endLocal: "20:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "missed" }],
      executionRecords: [{ id: "r1", sessionId: null, taskId: "done", actualStartUtc: "2026-08-01T03:30:00.000Z", actualEndUtc: "2026-08-01T04:00:00.000Z", note: "" }],
    };

    const review = buildSevenDayReview(workspace, "2026-08-02");
    expect(review.completedTaskIds).toEqual(["done"]);
    expect(review.progressedTaskIds).toEqual(["done", "carry"]);
    expect(review.carryoverTaskIds).toEqual(["carry"]);
    expect(review.days.find((day) => day.date === "2026-08-01")).toMatchObject({ progressDelta: 40, actualMinutes: 30 });
    expect(review.days.find((day) => day.date === "2026-08-02")).toMatchObject({ progressDelta: 20, missedCount: 1 });
    expect(review).not.toHaveProperty("score");
  });

  it("counts a directly skipped habit occurrence without inventing a missed fact for recovered work", () => {
    const workspace: WorkspaceSnapshot = {
      ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "habit-task", projectId: null, title: "Stretch", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sessionMinutes: 10, priority: "normal", sortOrder: 0, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "habit" }],
      recurringHabits: [{ id: "habit", taskId: "habit-task", title: "Stretch", pattern: "daily", weekdays: [], startDate: "2026-08-01", sessionMinutes: 10, preferredStartLocal: null, status: "active" }],
      executionSessions: [{ id: "recovered", taskId: "habit-task", localDate: "2026-08-02", endLocalDate: "2026-08-02", startLocal: "19:00", endLocal: "20:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "missed" }],
      executionRecords: [{ id: "record", sessionId: "recovered", taskId: "habit-task", actualStartUtc: "2026-08-02T12:00:00.000Z", actualEndUtc: "2026-08-02T12:10:00.000Z", note: "recovered" }],
      habitOccurrences: [{ id: "skip", habitId: "habit", localDate: "2026-08-02", status: "skipped", sessionId: null }],
    };
    const day = buildSevenDayReview(workspace, "2026-08-02").days.at(-1);
    expect(day).toMatchObject({ missedCount: 0, skippedCount: 1, actualMinutes: 10 });
    expect(buildSevenDayReview(workspace, "2026-08-02").carryoverTaskIds).toEqual(["habit-task"]);
  });

  it("stays empty when there are no facts at all", () => {
    const review = buildSevenDayReview(structuredClone(EMPTY_WORKSPACE), "2026-08-02");
    expect(review.days).toHaveLength(7);
    expect(review.days.every((day) => day.actualMinutes === 0 && day.progressDelta === 0 && day.missedCount === 0 && day.skippedCount === 0)).toBe(true);
    expect(review.completedTaskIds).toEqual([]);
    expect(review.progressedTaskIds).toEqual([]);
    expect(review.carryoverTaskIds).toEqual([]);
    expect(review.days.reduce((sum, day) => sum + day.actualMinutes, 0)).toBe(0);
  });

  it("does not count media minutes or scheduled sessions without execution as actual input", () => {
    const workspace: WorkspaceSnapshot = {
      ...structuredClone(EMPTY_WORKSPACE),
      tasks: [
        { id: "bili", projectId: null, title: "公开课程", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sessionMinutes: null, priority: "normal", sortOrder: 0, sourceUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1", sourceKey: "BV1xx411c7mD:1", mediaMinutes: 50, kind: "task" },
        { id: "planned", projectId: null, title: "计划未执行", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 30, sessionMinutes: null, priority: "normal", sortOrder: 1, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task" },
      ],
      executionSessions: [{ id: "s1", taskId: "planned", localDate: "2026-08-02", endLocalDate: "2026-08-02", startLocal: "19:00", endLocal: "19:30", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
    };
    const review = buildSevenDayReview(workspace, "2026-08-02");
    expect(review.days.reduce((sum, day) => sum + day.actualMinutes, 0)).toBe(0);
    expect(review.days.every((day) => day.actualMinutes === 0)).toBe(true);
    expect(review.days.find((day) => day.date === "2026-08-02")).toMatchObject({ missedCount: 0, skippedCount: 0 });
  });
});
