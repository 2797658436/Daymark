import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { EMPTY_WORKSPACE, type ExecutionRecord, type ExecutionSession, type HabitOccurrence, type ProgressEvent, type RecurringHabit, type Task, type WorkspaceSnapshot } from "./native";
import { buildReview, buildReviewFromIndex, buildSevenDayReview, formatPercentPoints, formatRecordedMs, formatTaskProgressRange, reviewRange, type ReviewResult } from "./review";
import { createWorkspaceIndex, pendingReviewSessions } from "./workspaceSelectors";

/**
 * 阶段 4 P4-07：周期统计引擎、跨日拆分与事实口径样本（规格 §7.1／§7.2／§7.3）。
 *
 * 夹具一律用**本地墙钟**构造（`localToUtc`／`localNow`），因此整个文件在任意设备时区
 * 下都成立；`now` 显式注入，用例不依赖真实时钟。
 */

function task(id: string, patch: Partial<Task> = {}): Task {
  return { id, projectId: null, title: id, progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sortOrder: 0, ...patch };
}

function session(id: string, patch: Partial<ExecutionSession> = {}): ExecutionSession {
  return { id, taskId: "t-1", localDate: "2026-03-07", endLocalDate: "2026-03-07", startLocal: "09:00", endLocal: "10:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled", ...patch };
}

function record(id: string, patch: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return { id, sessionId: null, taskId: "t-1", actualStartUtc: localToUtc("2026-03-07", "09:00"), actualEndUtc: localToUtc("2026-03-07", "10:00"), note: "", ...patch };
}

function event(id: string, patch: Partial<ProgressEvent> = {}): ProgressEvent {
  return { id, taskId: "t-1", fromProgress: 0, toProgress: 10, occurredAtUtc: localToUtc("2026-03-07", "09:00"), ...patch };
}

function habit(id: string, patch: Partial<RecurringHabit> = {}): RecurringHabit {
  return { id, taskId: "t-1", title: id, pattern: "daily", weekdays: [], startDate: "2026-03-01", sessionMinutes: 10, preferredStartLocal: null, status: "active", ...patch };
}

function occurrence(id: string, patch: Partial<HabitOccurrence> = {}): HabitOccurrence {
  return { id, habitId: "h-1", localDate: "2026-03-07", status: "skipped", sessionId: null, ...patch };
}

function workspace(patch: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return { ...structuredClone(EMPTY_WORKSPACE), ...patch };
}

/** 「本地日期 + 本地时间」→ UTC 时间点；夹具只描述用户看到的墙钟。 */
function localToUtc(date: string, time: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

/** 注入给引擎的「现在」，同样是本地墙钟。 */
function localNow(date: string, time = "12:00"): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute);
}

function dayOf(review: ReviewResult, date: string) {
  const day = review.days.find((entry) => entry.date === date);
  if (!day) throw new Error(`周期里没有 ${date}`);
  return day;
}

const NOON = localNow("2026-03-10", "12:00");

describe("review periods", () => {
  it("aligns a week to Monday through Sunday for any anchor day", () => {
    // 2026-03-08 是周日，2026-03-09 是周一：周日属于上一周。
    expect(reviewRange("week", "2026-03-08")).toEqual({ startDate: "2026-03-02", endDate: "2026-03-08" });
    expect(reviewRange("week", "2026-03-09")).toEqual({ startDate: "2026-03-09", endDate: "2026-03-15" });
    expect(reviewRange("week", "2026-03-02")).toEqual({ startDate: "2026-03-02", endDate: "2026-03-08" });
    expect(reviewRange("day", "2026-03-08")).toEqual({ startDate: "2026-03-08", endDate: "2026-03-08" });
  });

  it("crosses a month and a year boundary instead of adding a fixed number of days", () => {
    expect(reviewRange("week", "2026-12-31")).toEqual({ startDate: "2026-12-28", endDate: "2027-01-03" });
    const review = buildReview(workspace(), { period: "week", anchorDate: "2026-12-31", projectId: null }, NOON);
    expect(review.days.map((day) => day.date)).toEqual(["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03"]);
  });

  it("uses the natural month rather than the last 30 days, leap February included", () => {
    expect(reviewRange("month", "2028-02-15")).toEqual({ startDate: "2028-02-01", endDate: "2028-02-29" });
    expect(reviewRange("month", "2026-02-15")).toEqual({ startDate: "2026-02-01", endDate: "2026-02-28" });
    expect(reviewRange("month", "2026-12-31")).toEqual({ startDate: "2026-12-01", endDate: "2026-12-31" });
    const leap = buildReview(workspace(), { period: "month", anchorDate: "2028-02-15", projectId: null }, NOON);
    expect(leap.days).toHaveLength(29);
    expect(leap.days[0].date).toBe("2028-02-01");
    expect(leap.days.at(-1)?.date).toBe("2028-02-29");
  });

  it("falls back to the local date of the injected now when the anchor is not a real date", () => {
    const review = buildReview(workspace(), { period: "day", anchorDate: "2026-02-30", projectId: null }, localNow("2026-03-08", "12:00"));
    expect(review.startDate).toBe("2026-03-08");
    expect(review.endDate).toBe("2026-03-08");
    expect(review.anchorDate).toBe("2026-03-08");
  });

  it("never reads the system clock: the same facts give different results for different now", () => {
    const snapshot = workspace({ tasks: [task("t-1")], executionSessions: [session("s-1", { taskId: "t-1" })] });
    const query = { period: "day" as const, anchorDate: "2026-03-07", projectId: null };
    expect(buildReview(snapshot, query, localNow("2026-03-07", "09:30")).pendingReview).toHaveLength(0);
    expect(buildReview(snapshot, query, localNow("2026-03-07", "12:00")).pendingReview.map((item) => item.id)).toEqual(["s-1"]);
  });
});

describe("recorded actual input across day boundaries", () => {
  it("splits a 23:50–00:20 record into 10 minutes yesterday and 20 minutes today", () => {
    const review = buildReview(workspace({
      tasks: [task("t-1")],
      executionRecords: [record("r-1", { actualStartUtc: localToUtc("2026-03-07", "23:50"), actualEndUtc: localToUtc("2026-03-08", "00:20") })],
    }), { period: "week", anchorDate: "2026-03-08", projectId: null }, NOON);
    expect(dayOf(review, "2026-03-07").recordedMinutes).toBe(10);
    expect(dayOf(review, "2026-03-08").recordedMinutes).toBe(20);
    expect(review.actual.recordedMs).toBe(30 * 60_000);
    expect(review.actual.recordedMinutes).toBe(30);
  });

  it("splits the same record across a month boundary", () => {
    const review = buildReview(workspace({
      tasks: [task("t-1")],
      executionRecords: [record("r-1", { actualStartUtc: localToUtc("2026-03-31", "23:50"), actualEndUtc: localToUtc("2026-04-01", "00:20") })],
    }), { period: "week", anchorDate: "2026-04-01", projectId: null }, NOON);
    expect(review.startDate).toBe("2026-03-30");
    expect(dayOf(review, "2026-03-31").recordedMinutes).toBe(10);
    expect(dayOf(review, "2026-04-01").recordedMinutes).toBe(20);
  });

  it("counts a record that lies inside one local day once", () => {
    const review = buildReview(workspace({
      tasks: [task("t-1")],
      executionRecords: [record("r-1", { actualStartUtc: localToUtc("2026-03-07", "09:00"), actualEndUtc: localToUtc("2026-03-07", "10:30") })],
    }), { period: "day", anchorDate: "2026-03-07", projectId: null }, NOON);
    expect(dayOf(review, "2026-03-07").recordedMinutes).toBe(90);
  });

  it("keeps millisecond precision until the summary instead of rounding every record", () => {
    // 5 × 30 秒 = 150 秒 = 2.5 分钟 → 一次换算得 3 分钟；逐条四舍五入会得到 5 分钟。
    const thirtySeconds = ["01:00", "02:00", "03:00", "04:00", "05:00"].map((start, index) => {
      const from = localNow("2026-03-07", start).getTime();
      return record(`s-${index}`, { actualStartUtc: new Date(from).toISOString(), actualEndUtc: new Date(from + 30_000).toISOString() });
    });
    const review = buildReview(workspace({ tasks: [task("t-1")], executionRecords: thirtySeconds }), { period: "day", anchorDate: "2026-03-07", projectId: null }, NOON);
    expect(review.actual.recordedMs).toBe(150_000);
    expect(review.actual.recordedMinutes).toBe(3);
    expect(dayOf(review, "2026-03-07").recordedMinutes).toBe(3);
    expect(review.tasks[0].recordedMs).toBe(150_000);
  });

  it("keeps local day windows exact when a daylight-saving shift moves a day boundary", () => {
    // 在 America/New_York，2026-03-08 只有 23 小时：本地 03-09 00:00 之前的一切都属于 03-08。
    // 期望值全部由本地日历构造独立表达；任何「起始 + 固定 86_400_000 毫秒」的实现在带
    // 夏令时的时区下都会把 03-09 的头一小时算进 03-08（UTC+8 没有夏令时，这一项在那里
    // 无法证伪，因此报告里记录了 TZ=America/New_York 下的重跑）。
    const dayStart = new Date(2026, 2, 8).getTime();
    const nextDayStart = new Date(2026, 2, 9).getTime();
    const from = new Date(2026, 2, 9, 0, 0).getTime();
    const to = new Date(2026, 2, 9, 2, 0).getTime();
    const review = buildReview(workspace({
      tasks: [task("t-1")],
      executionRecords: [
        record("r-whole", { actualStartUtc: new Date(dayStart).toISOString(), actualEndUtc: new Date(nextDayStart).toISOString() }),
        record("r-next", { actualStartUtc: new Date(from).toISOString(), actualEndUtc: new Date(to).toISOString() }),
      ],
    }), { period: "month", anchorDate: "2026-03-08", projectId: null }, localNow("2026-03-12"));

    expect(dayOf(review, "2026-03-08").recordedMs).toBe(nextDayStart - dayStart);
    expect(dayOf(review, "2026-03-09").recordedMs).toBe(to - from);
    expect(review.actual.recordedMs).toBe(nextDayStart - dayStart + (to - from));
    expect(review.actual.overlapping).toBe(false);
  });

  it("lists an unfinished execution separately and never adds it to the recorded total", () => {
    const review = buildReview(workspace({
      tasks: [task("t-1")],
      executionRecords: [record("r-1", { actualStartUtc: localToUtc("2026-03-07", "09:00"), actualEndUtc: null })],
    }), { period: "week", anchorDate: "2026-03-07", projectId: null }, NOON);
    expect(review.actual.runningRecords.map((item) => item.id)).toEqual(["r-1"]);
    expect(review.actual.recordedMs).toBe(0);
    expect(formatRecordedMs(review.actual.recordedMs)).toBe("未记录");
    // 有进行中的执行时不能说「没有任何实际投入事实」，但已确认投入仍是 0。
    expect(review.actual.unrecorded).toBe(false);
    expect(dayOf(review, "2026-03-07").runningCount).toBe(1);
    expect(review.tasks[0].runningCount).toBe(1);
  });

  it("does not turn a plan without any record into a zero-percent execution rate", () => {
    const review = buildReview(workspace({ tasks: [task("t-1")], executionSessions: [session("s-1", { taskId: "t-1" })] }), { period: "day", anchorDate: "2026-03-07", projectId: null }, NOON);
    expect(review.plan.sessionCount).toBe(1);
    expect(review.actual.unrecorded).toBe(true);
    expect(review.notes.some((note) => note.includes("未记录"))).toBe(true);
    expect(formatRecordedMs(review.actual.recordedMs)).toBe("未记录");
  });

  it("labels overlapping legacy records as an accumulated sum rather than unique wall-clock time", () => {
    const review = buildReview(workspace({
      tasks: [task("t-1")],
      executionRecords: [
        record("r-1", { actualStartUtc: localToUtc("2026-03-07", "09:00"), actualEndUtc: localToUtc("2026-03-07", "10:00") }),
        record("r-2", { actualStartUtc: localToUtc("2026-03-07", "09:30"), actualEndUtc: localToUtc("2026-03-07", "10:30") }),
      ],
    }), { period: "day", anchorDate: "2026-03-07", projectId: null }, NOON);
    expect(review.actual.recordedMinutes).toBe(120);
    expect(review.actual.overlapping).toBe(true);
    expect(review.notes.some((note) => note.includes("执行记录累计"))).toBe(true);
  });
});

describe("progress semantics", () => {
  it("counts a same-day 40→100→60 as +20 points, one ever-completed task and the current 60%", () => {
    const review = buildReview(workspace({
      tasks: [task("t-1", { progress: 60 })],
      progressEvents: [
        event("p-1", { fromProgress: 40, toProgress: 100, occurredAtUtc: localToUtc("2026-03-07", "09:00") }),
        event("p-2", { fromProgress: 100, toProgress: 60, occurredAtUtc: localToUtc("2026-03-07", "11:00") }),
      ],
    }), { period: "day", anchorDate: "2026-03-07", projectId: null }, NOON);

    expect(review.progress.netDelta).toBe(20);
    expect(review.progress.completedTaskIds).toEqual(["t-1"]);
    expect(review.progress.changedTaskIds).toEqual(["t-1"]);
    // 「曾完成」与「当前完成度」是两个事实：下调之后不得显示当前已完成。
    expect(review.tasks[0].everCompleted).toBe(true);
    expect(review.tasks[0].currentProgress).toBe(60);
    expect(review.tasks[0].startProgress).toBe(40);
    expect(review.tasks[0].endProgress).toBe(60);
    expect(formatTaskProgressRange(review.tasks[0])).toBe("40% → 60%");
    expect(formatPercentPoints(review.progress.netDelta)).toBe("+20 百分点");
  });

  it("sums across tasks as percentage points, never as a project completion rate", () => {
    const review = buildReview(workspace({
      tasks: [task("a", { progress: 40 }), task("b", { progress: 40 })],
      progressEvents: [
        event("p-a", { taskId: "a", fromProgress: 0, toProgress: 40, occurredAtUtc: localToUtc("2026-03-07", "09:00") }),
        event("p-b", { taskId: "b", fromProgress: 50, toProgress: 40, occurredAtUtc: localToUtc("2026-03-07", "10:00") }),
      ],
    }), { period: "day", anchorDate: "2026-03-07", projectId: null }, NOON);

    expect(review.progress.netDelta).toBe(30);
    expect(review.progress.completedTaskIds).toEqual([]);
    expect(formatPercentPoints(review.progress.netDelta)).toBe("+30 百分点");
    // 合计是百分点：不能显示成「完成度 30%」。
    expect(formatPercentPoints(review.progress.netDelta)).not.toContain("%");
  });

  it("keeps a net-zero change visible in the detail with both events", () => {
    const review = buildReview(workspace({
      tasks: [task("t-1", { progress: 30 })],
      progressEvents: [
        event("p-1", { fromProgress: 30, toProgress: 50, occurredAtUtc: localToUtc("2026-03-07", "09:00") }),
        event("p-2", { fromProgress: 50, toProgress: 30, occurredAtUtc: localToUtc("2026-03-07", "10:00") }),
      ],
    }), { period: "day", anchorDate: "2026-03-07", projectId: null }, NOON);
    expect(review.progress.netDelta).toBe(0);
    expect(review.progress.changedTaskIds).toEqual(["t-1"]);
    expect(review.tasks[0].events.map((item) => item.id)).toEqual(["p-1", "p-2"]);
    expect(review.tasks[0].netDelta).toBe(0);
    expect(review.tasks[0].startProgress).toBe(30);
    expect(review.tasks[0].endProgress).toBe(30);
  });

  it("counts a repeated completion once per task and still counts a negative change", () => {
    const review = buildReview(workspace({
      tasks: [task("t-1", { progress: 100, status: "completed" }), task("t-2", { progress: 20 })],
      progressEvents: [
        event("p-1", { fromProgress: 0, toProgress: 100, occurredAtUtc: localToUtc("2026-03-07", "08:00") }),
        event("p-2", { fromProgress: 100, toProgress: 50, occurredAtUtc: localToUtc("2026-03-07", "09:00") }),
        event("p-3", { fromProgress: 50, toProgress: 100, occurredAtUtc: localToUtc("2026-03-07", "10:00") }),
        event("p-4", { taskId: "t-2", fromProgress: 40, toProgress: 20, occurredAtUtc: localToUtc("2026-03-07", "11:00") }),
      ],
    }), { period: "day", anchorDate: "2026-03-07", projectId: null }, NOON);

    expect(review.progress.completedTaskIds).toEqual(["t-1"]);
    expect(review.progress.changedTaskIds).toEqual(["t-1", "t-2"]);
    expect(review.progress.netDelta).toBe(100 - 50 + 50 - 20);
  });

  it("orders events by occurrence time and stable id, keeping same-instant detail", () => {
    const review = buildReview(workspace({
      tasks: [task("t-1", { progress: 40 })],
      progressEvents: [
        event("p-b", { fromProgress: 30, toProgress: 40, occurredAtUtc: localToUtc("2026-03-07", "09:00") }),
        event("p-a", { fromProgress: 20, toProgress: 30, occurredAtUtc: localToUtc("2026-03-07", "09:00") }),
        event("p-c", { fromProgress: 0, toProgress: 20, occurredAtUtc: localToUtc("2026-03-07", "08:00") }),
      ],
    }), { period: "day", anchorDate: "2026-03-07", projectId: null }, NOON);
    expect(review.tasks[0].events.map((item) => item.id)).toEqual(["p-c", "p-a", "p-b"]);
    expect(review.notes.some((note) => note.includes("同一时刻"))).toBe(true);
  });

  it("does not back-derive history from the current progress when the period has no events", () => {
    const snapshot = workspace({
      tasks: [task("t-1", { progress: 60 }), task("t-2", { progress: 80 })],
      executionSessions: [session("s-1", { taskId: "t-1" })],
    });
    const review = buildReview(snapshot, { period: "day", anchorDate: "2026-03-07", projectId: null }, NOON);
    // 只有确有事实的任务进入明细；没有事实的任务不会被补成 0%。
    expect(review.tasks.map((detail) => detail.taskId)).toEqual(["t-1"]);
    expect(review.tasks[0].startProgress).toBeNull();
    expect(review.tasks[0].endProgress).toBeNull();
    expect(review.tasks[0].currentProgress).toBe(60);
    expect(formatTaskProgressRange(review.tasks[0])).toBe("本周期无进度记录，当前 60%");
    expect(review.progress.netDelta).toBe(0);
  });
});

describe("pending review, explicit skips and carryover", () => {
  it("reads pending review through the shared selector instead of a second implementation", () => {
    const snapshot = workspace({
      tasks: [task("t-1"), task("t-2", { progress: 100, status: "completed" })],
      executionSessions: [session("s-1", { taskId: "t-1" }), session("s-2", { taskId: "t-2" }), session("s-3", { taskId: "t-1", localDate: "2026-03-20", endLocalDate: "2026-03-20" })],
    });
    const index = createWorkspaceIndex(snapshot);
    const review = buildReviewFromIndex(index, { period: "week", anchorDate: "2026-03-07", projectId: null }, NOON);
    const shared = pendingReviewSessions(index, NOON).filter((item) => review.days.some((day) => day.date === item.localDate));
    expect(review.pendingReview.map((item) => item.id)).toEqual(shared.map((item) => item.id));
    expect(review.pendingReview.map((item) => item.id)).toEqual(["s-1"]);
    // 时间经过本身不会造出 missed 事实。
    expect(review.notAdvanced.count).toBe(0);
  });

  it("never reports 未推进 for a session that already produced an execution record", () => {
    const review = buildReview(workspace({
      tasks: [task("t-1")],
      executionSessions: [session("s-1", { taskId: "t-1", status: "missed" })],
      executionRecords: [record("r-1", { sessionId: "s-1", taskId: "t-1", actualStartUtc: localToUtc("2026-03-07", "09:00"), actualEndUtc: localToUtc("2026-03-07", "09:10") })],
    }), { period: "day", anchorDate: "2026-03-07", projectId: null }, NOON);
    expect(review.notAdvanced.missedSessions).toEqual([]);
    expect(review.notAdvanced.count).toBe(0);
    expect(review.actual.recordedMinutes).toBe(10);
  });

  it("dedupes a habit occurrence against its own skipped session and keeps a standalone one", () => {
    const review = buildReview(workspace({
      tasks: [task("t-1", { kind: "habit" })],
      recurringHabits: [habit("h-1")],
      executionSessions: [session("s-1", { taskId: "t-1", status: "skipped" })],
      habitOccurrences: [
        occurrence("o-linked", { habitId: "h-1", sessionId: "s-1" }),
        occurrence("o-standalone", { habitId: "h-1", sessionId: null }),
      ],
    }), { period: "day", anchorDate: "2026-03-07", projectId: null }, NOON);
    expect(review.notAdvanced.skippedSessions.map((item) => item.id)).toEqual(["s-1"]);
    expect(review.notAdvanced.skippedOccurrences.map((item) => item.id)).toEqual(["o-standalone"]);
    expect(review.notAdvanced.count).toBe(2);
    expect(dayOf(review, "2026-03-07").skippedCount).toBe(2);
  });

  it("explains 取消安排 separately from 跳过", () => {
    const review = buildReview(workspace({
      tasks: [task("t-1")],
      executionSessions: [session("s-1", { status: "cancelled" }), session("s-2", { status: "skipped" }), session("s-3", { status: "missed" })],
    }), { period: "day", anchorDate: "2026-03-07", projectId: null }, NOON);
    expect(review.notAdvanced.cancelledSessions.map((item) => item.id)).toEqual(["s-1"]);
    expect(review.notAdvanced.skippedSessions.map((item) => item.id)).toEqual(["s-2"]);
    expect(review.notAdvanced.missedSessions.map((item) => item.id)).toEqual(["s-3"]);
    expect(review.notAdvanced.count).toBe(3);
    expect(dayOf(review, "2026-03-07").skippedCount).toBe(2);
    expect(dayOf(review, "2026-03-07").notAdvancedCount).toBe(1);
  });

  it("keeps only currently active tasks with unfinished work as carryover", () => {
    const snapshot = workspace({
      tasks: [
        task("advanced", { progress: 50 }),
        task("downgraded", { progress: 60 }),
        task("completed", { progress: 100, status: "completed" }),
        task("paused", { progress: 30, status: "paused" }),
        task("reviewed", { progress: 20 }),
        task("skipped", { progress: 10 }),
        task("idle", { progress: 5 }),
      ],
      progressEvents: [
        event("p-1", { taskId: "advanced", fromProgress: 10, toProgress: 50, occurredAtUtc: localToUtc("2026-03-07", "08:00") }),
        event("p-2", { taskId: "downgraded", fromProgress: 40, toProgress: 100, occurredAtUtc: localToUtc("2026-03-07", "08:30") }),
        event("p-3", { taskId: "downgraded", fromProgress: 100, toProgress: 60, occurredAtUtc: localToUtc("2026-03-07", "09:00") }),
        event("p-4", { taskId: "completed", fromProgress: 40, toProgress: 100, occurredAtUtc: localToUtc("2026-03-07", "09:30") }),
        event("p-5", { taskId: "paused", fromProgress: 10, toProgress: 30, occurredAtUtc: localToUtc("2026-03-07", "10:00") }),
      ],
      executionSessions: [session("s-1", { taskId: "reviewed" }), session("s-2", { taskId: "skipped", status: "skipped" })],
    });
    const review = buildReview(snapshot, { period: "day", anchorDate: "2026-03-07", projectId: null }, NOON);
    expect(review.carryoverTaskIds).toEqual(["advanced", "downgraded", "reviewed", "skipped"]);
    expect(review.tasks.filter((detail) => detail.carryover).map((detail) => detail.taskId)).toEqual(["advanced", "downgraded", "reviewed", "skipped"]);
    // 待续只给出 ID 与明细，不复制任务：快照本身没有被改写。
    expect(snapshot.tasks.map((item) => item.id)).toEqual(["advanced", "downgraded", "completed", "paused", "reviewed", "skipped", "idle"]);
  });

  it("keeps a frozen unmet milestone result and never rewrites the period snapshot", () => {
    const snapshot = workspace({
      projects: [{ id: "p-1", title: "项目", deadlineLocal: null }],
      tasks: [task("t-1", { projectId: "p-1", progress: 100, status: "completed" }), task("t-2", { projectId: "p-1", progress: 100, status: "completed" })],
      projectMilestones: [
        { id: "m-frozen", projectId: "p-1", title: "已冻结", targetLocalDate: "2026-03-05", sortOrder: 0, criterionKind: "taskCount", targetTaskId: null, targetCount: 2, targetProgress: null },
        { id: "m-open", projectId: "p-1", title: "未到期", targetLocalDate: "2026-03-06", sortOrder: 1, criterionKind: "taskCount", targetTaskId: null, targetCount: 2, targetProgress: null },
      ],
      milestoneOutcomes: [{ id: "o-1", milestoneId: "m-frozen", projectId: "p-1", title: "已冻结", targetLocalDate: "2026-03-05", reached: false, resultText: "完成 0/2，未达成", frozenAtUtc: "2026-03-06T00:00:00Z" }],
    });
    const review = buildReview(snapshot, { period: "week", anchorDate: "2026-03-07", projectId: null }, NOON);
    const frozen = review.milestones.find((item) => item.milestoneId === "m-frozen");
    expect(frozen).toMatchObject({ frozen: true, reached: false, resultText: "完成 0/2，未达成" });
    const open = review.milestones.find((item) => item.milestoneId === "m-open");
    expect(open).toMatchObject({ frozen: false, reached: true });
    expect(snapshot.milestoneOutcomes).toHaveLength(1);
    expect(snapshot.milestoneOutcomes[0].resultText).toBe("完成 0/2，未达成");
  });
});

describe("project filter", () => {
  const snapshot = workspace({
    projects: [{ id: "p-1", title: "甲", deadlineLocal: null }, { id: "p-2", title: "乙", deadlineLocal: null }],
    tasks: [task("t-1", { projectId: "p-1" }), task("t-2", { projectId: "p-2" }), task("t-3")],
    progressEvents: [
      event("p-1", { taskId: "t-1", fromProgress: 0, toProgress: 10, occurredAtUtc: localToUtc("2026-03-07", "09:00") }),
      event("p-2", { taskId: "t-2", fromProgress: 0, toProgress: 20, occurredAtUtc: localToUtc("2026-03-07", "09:00") }),
      event("p-3", { taskId: "t-3", fromProgress: 0, toProgress: 30, occurredAtUtc: localToUtc("2026-03-07", "09:00") }),
    ],
    executionSessions: [session("s-1", { taskId: "t-1" }), session("s-2", { taskId: "t-2" }), session("s-3", { taskId: "t-3" })],
    executionRecords: [
      record("r-1", { taskId: "t-1", actualStartUtc: localToUtc("2026-03-07", "09:00"), actualEndUtc: localToUtc("2026-03-07", "10:00") }),
      record("r-2", { taskId: "t-2", actualStartUtc: localToUtc("2026-03-07", "09:00"), actualEndUtc: localToUtc("2026-03-07", "11:00") }),
    ],
  });

  it("counts every task, session and record when projectId is null", () => {
    const review = buildReview(snapshot, { period: "day", anchorDate: "2026-03-07", projectId: null }, NOON);
    expect(review.progress.netDelta).toBe(60);
    expect(review.actual.recordedMinutes).toBe(180);
    expect(review.plan.sessionCount).toBe(3);
  });

  it("counts only the selected project's tasks and their sessions and records", () => {
    const review = buildReview(snapshot, { period: "day", anchorDate: "2026-03-07", projectId: "p-1" }, NOON);
    expect(review.progress.netDelta).toBe(10);
    expect(review.progress.changedTaskIds).toEqual(["t-1"]);
    expect(review.actual.recordedMinutes).toBe(60);
    expect(review.plan.sessionCount).toBe(1);
    expect(review.tasks.map((detail) => detail.taskId)).toEqual(["t-1"]);
    expect(review.notes.some((note) => note.includes("甲"))).toBe(true);
  });
});

describe("day, week and month aggregation", () => {
  const snapshot = workspace({
    tasks: [task("t-1", { progress: 30 })],
    progressEvents: [
      event("p-1", { fromProgress: 0, toProgress: 10, occurredAtUtc: localToUtc("2026-03-02", "09:00") }),
      event("p-2", { fromProgress: 10, toProgress: 30, occurredAtUtc: localToUtc("2026-03-07", "09:00") }),
    ],
    executionRecords: [record("r-1", { actualStartUtc: localToUtc("2026-03-07", "09:00"), actualEndUtc: localToUtc("2026-03-07", "10:00") })],
  });

  it("aggregates the same facts into a day, a week and a month that can be checked against the detail", () => {
    const day = buildReview(snapshot, { period: "day", anchorDate: "2026-03-07", projectId: null }, NOON);
    const week = buildReview(snapshot, { period: "week", anchorDate: "2026-03-07", projectId: null }, NOON);
    const month = buildReview(snapshot, { period: "month", anchorDate: "2026-03-07", projectId: null }, NOON);

    expect(day.progress.netDelta).toBe(20);
    expect(day.actual.recordedMinutes).toBe(60);
    expect(week.startDate).toBe("2026-03-02");
    expect(week.progress.netDelta).toBe(30);
    expect(week.actual.recordedMinutes).toBe(60);
    expect(month.startDate).toBe("2026-03-01");
    expect(month.progress.netDelta).toBe(30);
    expect(month.days).toHaveLength(31);

    // 汇总必须能被明细核对：周净变化等于周内各日之和，也等于该任务明细的净变化。
    expect(week.days.reduce((sum, item) => sum + item.progressDelta, 0)).toBe(week.progress.netDelta);
    expect(week.tasks.reduce((sum, detail) => sum + detail.netDelta, 0)).toBe(week.progress.netDelta);
    expect(week.tasks[0].events.map((item) => item.id)).toEqual(["p-1", "p-2"]);
    expect(week.actual.recordedMs).toBe(week.days.reduce((sum, item) => sum + item.recordedMs, 0));
  });

  it("keeps the current progress out of the historical range", () => {
    const day = buildReview(snapshot, { period: "day", anchorDate: "2026-03-02", projectId: null }, NOON);
    // 该日只有一条事件；任务当前 30% 不能冒充那一天的历史。
    expect(day.progress.netDelta).toBe(10);
    expect(day.tasks[0].startProgress).toBe(0);
    expect(day.tasks[0].endProgress).toBe(10);
    expect(day.tasks[0].currentProgress).toBe(30);
  });
});

describe("seven-day compatibility entry", () => {
  it("summarizes progress, actual input and missed facts without a score", () => {
    const snapshot = workspace({
      tasks: [
        task("done", { progress: 100, status: "completed", estimatedMinutes: 30, sortOrder: 0 }),
        task("carry", { progress: 30, sortOrder: 1 }),
      ],
      progressEvents: [
        event("p1", { taskId: "done", fromProgress: 60, toProgress: 100, occurredAtUtc: "2026-08-01T04:00:00.000Z" }),
        event("p2", { taskId: "carry", fromProgress: 10, toProgress: 30, occurredAtUtc: "2026-08-02T04:00:00.000Z" }),
      ],
      executionSessions: [session("s1", { taskId: "carry", localDate: "2026-08-02", endLocalDate: "2026-08-02", startLocal: "19:00", endLocal: "20:00", status: "missed" })],
      executionRecords: [record("r1", { sessionId: null, taskId: "done", actualStartUtc: "2026-08-01T03:30:00.000Z", actualEndUtc: "2026-08-01T04:00:00.000Z" })],
    });
    const review = buildSevenDayReview(snapshot, "2026-08-02", localNow("2026-08-02", "21:00"));
    expect(review.completedTaskIds).toEqual(["done"]);
    expect(review.progressedTaskIds).toEqual(["done", "carry"]);
    expect(review.carryoverTaskIds).toEqual(["carry"]);
    expect(review.days.find((day) => day.date === "2026-08-01")).toMatchObject({ progressDelta: 40, actualMinutes: 30 });
    expect(review.days.find((day) => day.date === "2026-08-02")).toMatchObject({ progressDelta: 20, missedCount: 1 });
    expect(review).not.toHaveProperty("score");
  });

  it("counts a directly skipped habit occurrence without inventing a missed fact for recovered work", () => {
    const snapshot = workspace({
      tasks: [task("habit-task", { kind: "habit", sessionMinutes: 10 })],
      recurringHabits: [habit("habit", { taskId: "habit-task", title: "Stretch", sessionMinutes: 10 })],
      executionSessions: [session("recovered", { taskId: "habit-task", localDate: "2026-08-02", endLocalDate: "2026-08-02", startLocal: "19:00", endLocal: "20:00", status: "missed" })],
      executionRecords: [record("record", { sessionId: "recovered", taskId: "habit-task", actualStartUtc: "2026-08-02T12:00:00.000Z", actualEndUtc: "2026-08-02T12:10:00.000Z", note: "recovered" })],
      habitOccurrences: [occurrence("skip", { habitId: "habit", localDate: "2026-08-02", sessionId: null })],
    });
    const review = buildSevenDayReview(snapshot, "2026-08-02", localNow("2026-08-02", "21:00"));
    expect(review.days.at(-1)).toMatchObject({ missedCount: 0, skippedCount: 1, actualMinutes: 10 });
    expect(review.carryoverTaskIds).toEqual(["habit-task"]);
  });

  it("stays empty when there are no facts at all", () => {
    const review = buildSevenDayReview(structuredClone(EMPTY_WORKSPACE), "2026-08-02", localNow("2026-08-02", "21:00"));
    expect(review.days).toHaveLength(7);
    expect(review.days.every((day) => day.actualMinutes === 0 && day.progressDelta === 0 && day.missedCount === 0 && day.skippedCount === 0)).toBe(true);
    expect(review.completedTaskIds).toEqual([]);
    expect(review.progressedTaskIds).toEqual([]);
    expect(review.carryoverTaskIds).toEqual([]);
  });

  it("does not count media minutes or scheduled sessions without execution as actual input", () => {
    const snapshot = workspace({
      tasks: [
        task("bili", { mediaMinutes: 50, sourceUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1", sourceKey: "BV1xx411c7mD:1" }),
        task("planned", { sortOrder: 1, estimatedMinutes: 30 }),
      ],
      executionSessions: [session("s1", { taskId: "planned", localDate: "2026-08-02", endLocalDate: "2026-08-02", startLocal: "19:00", endLocal: "19:30" })],
    });
    const review = buildSevenDayReview(snapshot, "2026-08-02", localNow("2026-08-02", "21:00"));
    expect(review.days.reduce((sum, day) => sum + day.actualMinutes, 0)).toBe(0);
    expect(review.days.find((day) => day.date === "2026-08-02")).toMatchObject({ missedCount: 0, skippedCount: 0 });
  });

  it("is a thin adapter over the same engine: its seven days equal seven single-day reviews", () => {
    const snapshot = workspace({
      tasks: [task("t-1", { progress: 30 })],
      progressEvents: [
        event("p-1", { fromProgress: 0, toProgress: 10, occurredAtUtc: localToUtc("2026-03-05", "09:00") }),
        event("p-2", { fromProgress: 10, toProgress: 30, occurredAtUtc: localToUtc("2026-03-07", "09:00") }),
      ],
      executionSessions: [session("s-1", { localDate: "2026-03-06", endLocalDate: "2026-03-06" }), session("s-2", { localDate: "2026-03-07", endLocalDate: "2026-03-07", status: "skipped" })],
      executionRecords: [record("r-1", { actualStartUtc: localToUtc("2026-03-07", "23:50"), actualEndUtc: localToUtc("2026-03-08", "00:20") })],
    });
    const now = localNow("2026-03-10", "12:00");
    const seven = buildSevenDayReview(snapshot, "2026-03-08", now);
    for (const day of seven.days) {
      const single = buildReview(snapshot, { period: "day", anchorDate: day.date, projectId: null }, now);
      expect({ date: day.date, progressDelta: day.progressDelta, actualMinutes: day.actualMinutes, missedCount: day.missedCount, skippedCount: day.skippedCount })
        .toEqual({ date: day.date, progressDelta: single.progress.netDelta, actualMinutes: single.actual.recordedMinutes, missedCount: single.notAdvanced.missedSessions.length, skippedCount: single.notAdvanced.skippedSessions.length + single.notAdvanced.cancelledSessions.length + single.notAdvanced.skippedOccurrences.length });
    }
    // 刻意行为变化：跨午夜记录不再整段记在起始日。
    expect(seven.days.find((day) => day.date === "2026-03-07")?.actualMinutes).toBe(10);
    expect(seven.days.find((day) => day.date === "2026-03-08")?.actualMinutes).toBe(20);
  });
});

describe("engine guards", () => {
  // 用字符串路径而不是 URL：本机 node 的 fs 被 shim 包装，不接受 URL 对象。
  const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "review.ts"), "utf8");
  // 注释里说明「不读时钟」时会提到那几个 API 名字，所以只检查真正的代码。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("keeps the pending-review judgement in workspaceSelectors instead of a second copy", () => {
    expect(code).toContain("isPendingReviewIn");
    expect(code).toContain("from \"./workspaceSelectors\"");
    expect(code).not.toMatch(/function isPendingReview\b/);
    expect(code).not.toMatch(/status\s*!==\s*"scheduled"/);
  });

  it("never reads the system clock inside the engine", () => {
    expect(code).not.toContain("Date.now()");
    expect(code).not.toMatch(/new Date\(\s*\)/);
  });
});
