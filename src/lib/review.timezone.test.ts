import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EMPTY_WORKSPACE, type ExecutionRecord, type Task, type WorkspaceSnapshot } from "./native";
import { buildReview, type ReviewResult } from "./review";

/**
 * 阶段 4 P4-07 / AC11：跨午夜与**夏令时**投入（纯函数固定时间样本）。
 *
 * 本机时区是 Asia/Shanghai，没有夏令时 —— 「日界 = 起始 + 固定 86_400_000 毫秒」这种
 * 缺陷在默认时区下数值恰好正确，无法被证伪。这里把进程时区改成 America/New_York
 * （2026-03-08 是 23 小时的本地日），让那个缺陷真的暴露出来；Vitest 默认按文件隔离
 * 进程，改动不会外溢到其他测试文件。
 */

const previousTimeZone = process.env.TZ;
beforeAll(() => { process.env.TZ = "America/New_York"; });
afterAll(() => {
  if (previousTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousTimeZone;
});

function task(id: string, patch: Partial<Task> = {}): Task {
  return { id, projectId: null, title: id, progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sortOrder: 0, ...patch };
}

function record(id: string, startMs: number, endMs: number): ExecutionRecord {
  return { id, sessionId: null, taskId: "t-1", actualStartUtc: new Date(startMs).toISOString(), actualEndUtc: new Date(endMs).toISOString(), note: "" };
}

function workspace(patch: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return { ...structuredClone(EMPTY_WORKSPACE), ...patch };
}

function dayOf(review: ReviewResult, date: string) {
  const day = review.days.find((entry) => entry.date === date);
  if (!day) throw new Error(`周期里没有 ${date}`);
  return day;
}

describe("daylight-saving local day windows", () => {
  it("uses the real 23-hour local day and never spills the next day's first hour backwards", () => {
    const dayStart = new Date(2026, 2, 8).getTime();
    const nextDayStart = new Date(2026, 2, 9).getTime();
    // 先证明时区真的生效，否则这个文件会在 UTC+8 下静默空跑。
    expect((nextDayStart - dayStart) / 3_600_000).toBe(23);

    const from = new Date(2026, 2, 9, 0, 0).getTime();
    const to = new Date(2026, 2, 9, 2, 0).getTime();
    const review = buildReview(workspace({
      tasks: [task("t-1")],
      executionRecords: [
        record("r-whole", dayStart, nextDayStart),
        record("r-next", from, to),
      ],
    }), { period: "month", anchorDate: "2026-03-08", projectId: null }, new Date(2026, 2, 12, 12, 0));

    expect(dayOf(review, "2026-03-08").recordedMs).toBe(nextDayStart - dayStart);
    expect(dayOf(review, "2026-03-09").recordedMs).toBe(to - from);
    expect(review.actual.recordedMs).toBe(nextDayStart - dayStart + (to - from));
    expect(review.actual.overlapping).toBe(false);
  });

  it("counts the real elapsed time across the spring-forward gap instead of the wall-clock difference", () => {
    // 本地 2026-03-08 01:00 → 03:30：墙上时钟差 150 分钟，真实经过 90 分钟（02:00–03:00 不存在）。
    const from = new Date(2026, 2, 8, 1, 0).getTime();
    const to = new Date(2026, 2, 8, 3, 30).getTime();
    expect((to - from) / 60_000).toBe(90);

    const review = buildReview(workspace({
      tasks: [task("t-1")],
      executionRecords: [record("r-1", from, to)],
    }), { period: "day", anchorDate: "2026-03-08", projectId: null }, new Date(2026, 2, 10, 12, 0));
    expect(review.actual.recordedMinutes).toBe(90);
  });
});
