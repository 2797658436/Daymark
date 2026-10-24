import { describe, expect, it } from "vitest";

import { EMPTY_WORKSPACE, type CompletionRecordSummary, type ProgressEvent, type Task, type WorkspaceSnapshot } from "./native";
import { buildReview } from "./review";

/**
 * 完成记录在回顾引擎里的只读投影（规格 0007 §6 / M5）。
 *
 * 这一组用例守的是三件事：
 * 1. 投影**只呈现**第四类事实，不参与任何既有指标口径；
 * 2. 已撤回的记录留在明细里，但不进感受聚合；
 * 3. 排序是 `(completedAtUtc, id)`，与渲染顺序同源，不随 Map 迭代顺序漂。
 */

function task(id: string, patch: Partial<Task> = {}): Task {
  return { id, projectId: null, title: id, progress: 100, status: "completed", deadlineLocal: null, estimatedMinutes: null, sortOrder: 0, ...patch };
}

function event(id: string, patch: Partial<ProgressEvent> = {}): ProgressEvent {
  return { id, taskId: "t-1", fromProgress: 75, toProgress: 100, occurredAtUtc: utc("2026-03-07", "09:00"), ...patch };
}

function completion(id: string, patch: Partial<CompletionRecordSummary> = {}): CompletionRecordSummary {
  return { id, taskId: "t-1", progressEventId: "e-1", completedAtUtc: utc("2026-03-07", "09:00"), progressBefore: 75,
    fit: "fit", note: "", tags: [], revertedAtUtc: null, imageCount: 0, ...patch };
}

/** 夹具用本地墙钟写时间，任意时区的机器上「哪一天」都一致。 */
function utc(date: string, time: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

function workspace(patch: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return { ...structuredClone(EMPTY_WORKSPACE), ...patch };
}

const WEEK = { period: "week" as const, anchorDate: "2026-03-07", projectId: null };
const NOW = new Date(2026, 2, 10, 12, 0);

describe("completion records in the review engine", () => {
  it("projects the period's records onto the day they happened, ordered by time then id", () => {
    const review = buildReview(workspace({
      tasks: [task("t-1"), task("t-2")],
      progressEvents: [event("e-1"), event("e-2", { taskId: "t-2" }), event("e-3", { taskId: "t-2" })],
      completionRecords: [
        completion("c-late", { taskId: "t-2", progressEventId: "e-3", completedAtUtc: utc("2026-03-07", "18:00") }),
        completion("c-early", { progressEventId: "e-1" }),
        // 同一时刻的两条按 id 排，而不是按写入顺序或 Map 迭代顺序。
        completion("c-b", { taskId: "t-2", progressEventId: "e-2", completedAtUtc: utc("2026-03-06", "10:00") }),
        completion("c-a", { taskId: "t-2", progressEventId: "e-2", completedAtUtc: utc("2026-03-06", "10:00") }),
      ],
    }), WEEK, NOW);
    expect(day(review, "2026-03-06").completions.map((item) => item.id)).toEqual(["c-a", "c-b"]);
    expect(day(review, "2026-03-07").completions.map((item) => item.id)).toEqual(["c-early", "c-late"]);
    expect(review.completions.map((item) => item.id)).toEqual(["c-a", "c-b", "c-early", "c-late"]);
    // 任务下钻用的是同一批记录，不另算一遍。
    expect(review.tasks.find((item) => item.taskId === "t-2")?.completions.map((item) => item.id)).toEqual(["c-a", "c-b", "c-late"]);
  });

  it("carries the task title into the projection and degrades to 来源不可用 when the task is gone", () => {
    const review = buildReview(workspace({
      tasks: [task("t-1")],
      progressEvents: [event("e-1")],
      completionRecords: [completion("c-1"), completion("c-2", { id: "c-2", taskId: "t-gone", progressEventId: "e-2" })],
    }), WEEK, NOW);
    // 记录的任务已不在工作区：它不属于任何在算的任务，因此整个不进周期。
    expect(review.completions.map((item) => item.id)).toEqual(["c-1"]);
    expect(review.completions[0].title).toBe("t-1");
  });

  it("keeps a reverted record in the detail but out of the feeling aggregate", () => {
    const review = buildReview(workspace({
      tasks: [task("t-1"), task("t-2"), task("t-3")],
      progressEvents: [event("e-1"), event("e-2", { taskId: "t-2" }), event("e-3", { taskId: "t-3" })],
      completionRecords: [
        completion("c-1", { fit: "light", tags: ["专注"] }),
        completion("c-2", { taskId: "t-2", progressEventId: "e-2", fit: "hard", tags: ["被打断"] }),
        // 撤回的记录：内容（fit／标签／小结）都保留，但不计数。
        completion("c-3", { taskId: "t-3", progressEventId: "e-3", fit: "light", tags: ["专注", "有收获"], revertedAtUtc: utc("2026-03-08", "09:00") }),
      ],
    }), WEEK, NOW);
    expect(review.feeling).toMatchObject({ recordCount: 3, countedCount: 2, revertedCount: 1, fitCounts: { light: 1, fit: 0, hard: 1 } });
    // 次数相同按词表顺序排：专注（第 1 个）在被打断（第 5 个）前面。
    expect(review.feeling.topTags).toEqual([{ tag: "专注", count: 1 }, { tag: "被打断", count: 1 }]);
    expect(review.feeling.topTags.map((item) => item.tag)).not.toContain("有收获");
    expect(review.completions.map((item) => item.id)).toEqual(["c-1", "c-2", "c-3"]);
    expect(review.completions[2].tags).toEqual(["专注", "有收获"]);
    expect(review.days.reduce((sum, day) => sum + day.completions.length, 0)).toBe(3);
    expect(review.notes.join("")).toContain("1 条完成记录被撤回");
  });

  it("counts a record with no fit as a record but not as a feeling", () => {
    const review = buildReview(workspace({
      tasks: [task("t-1")], progressEvents: [event("e-1")],
      completionRecords: [completion("c-1", { fit: null, note: "只做了一次深呼吸" })],
    }), WEEK, NOW);
    expect(review.feeling).toMatchObject({ recordCount: 1, countedCount: 1, fitCounts: { light: 0, fit: 0, hard: 0 } });
  });

  it("does not move any existing metric: a record alone changes neither completion nor input", () => {
    const bare = workspace({ tasks: [task("t-1", { progress: 75, status: "active" })], progressEvents: [event("e-1", { toProgress: 75 })] });
    const without = buildReview(bare, WEEK, NOW);
    const withRecord = buildReview({
      ...structuredClone(bare),
      completionRecords: [completion("c-1", { completedAtUtc: utc("2026-03-07", "09:00") })],
    }, WEEK, NOW);
    // 「曾完成任务数」仍以上面的进度事件为准：补一条记录不会凭空造出一个完成。
    expect(withRecord.progress.completedTaskIds).toEqual(without.progress.completedTaskIds);
    expect(withRecord.actual.recordedMs).toBe(without.actual.recordedMs);
    expect(withRecord.days.map((d) => d.progressDelta)).toEqual(without.days.map((d) => d.progressDelta));
    // 只有新口径多出来：明细与感受。
    expect(without.completions).toEqual([]);
    expect(without.feeling).toMatchObject({ recordCount: 0, countedCount: 0, revertedCount: 0 });
  });

  it("drops records outside the period and outside the project filter", () => {
    const review = buildReview(workspace({
      tasks: [task("t-1", { projectId: "p-1" }), task("t-2", { projectId: "p-2" })],
      projects: [{ id: "p-1", title: "甲", summary: "", status: "active", deadlineLocal: null, sortOrder: 0 } as never],
      progressEvents: [event("e-1", { taskId: "t-1" }), event("e-2", { taskId: "t-2" })],
      completionRecords: [
        completion("c-in", { taskId: "t-1", progressEventId: "e-1" }),
        completion("c-other-project", { taskId: "t-2", progressEventId: "e-2" }),
        completion("c-older", { taskId: "t-1", progressEventId: "e-1", completedAtUtc: utc("2026-02-20", "09:00") }),
      ],
    }), { ...WEEK, projectId: "p-1" }, NOW);
    expect(review.completions.map((item) => item.id)).toEqual(["c-in"]);
  });
});

function day(review: ReturnType<typeof buildReview>, date: string) {
  const entry = review.days.find((item) => item.date === date);
  if (!entry) throw new Error(`周期里没有 ${date}`);
  return entry;
}
