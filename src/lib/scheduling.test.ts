import { describe, expect, it } from "vitest";

import { buildSchedulePlan, type ScheduleItem } from "./scheduling";

const slots = [{ id: "evening", label: "晚间", start: "19:00", end: "22:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }];

function task(key: string, targetMinutes: number, extras: Partial<ScheduleItem> = {}): ScheduleItem {
  return { key, taskId: key, title: key, targetMinutes, deadlineLocal: null, priority: "normal", sortOrder: 0, ...extras };
}

describe("automatic scheduling Lite", () => {
  it("orders candidates by deadline and task-pool order without crossing busy time", () => {
    const plan = buildSchedulePlan({
      startDate: "2026-08-03",
      days: 1,
      items: [task("later", 60, { deadlineLocal: "2026-08-10", sortOrder: 0 }), task("urgent", 45, { deadlineLocal: "2026-08-04", sortOrder: 9 })],
      defaultTimeSlots: slots,
      busy: [{ localDate: "2026-08-03", endLocalDate: "2026-08-03", startLocal: "19:30", endLocal: "20:00" }],
      minimumMinutes: 15,
    });

    expect(plan.allocations).toEqual([
      expect.objectContaining({ key: "urgent", localDate: "2026-08-03", startLocal: "20:00", endLocal: "20:45", minutes: 45 }),
      expect.objectContaining({ key: "later", localDate: "2026-08-03", startLocal: "20:45", endLocal: "21:45", minutes: 60 }),
    ]);
  });

  it("uses a shorter viable gap but never one below the minimum", () => {
    const plan = buildSchedulePlan({
      startDate: "2026-08-03",
      days: 1,
      items: [task("chapter", 40)],
      defaultTimeSlots: [{ ...slots[0], start: "19:00", end: "19:25" }],
      busy: [],
      minimumMinutes: 15,
    });

    expect(plan.allocations[0]).toMatchObject({ key: "chapter", minutes: 25, startLocal: "19:00", endLocal: "19:25" });
  });

  it("never emits a second session for the remainder after a partial allocation", () => {
    const plan = buildSchedulePlan({
      startDate: "2026-08-03",
      days: 1,
      items: [task("book", 90)],
      defaultTimeSlots: [
        { ...slots[0], id: "first", start: "19:00", end: "19:30" },
        { ...slots[0], id: "second", start: "20:00", end: "20:30" },
      ],
      busy: [],
      minimumMinutes: 15,
    });

    expect(plan.allocations).toEqual([expect.objectContaining({ key: "book", minutes: 30 })]);
    expect(plan.allocations).toHaveLength(1);
  });

  it("does not count or use a gap below the minimum, even when it fits the target", () => {
    const plan = buildSchedulePlan({
      startDate: "2026-08-03", days: 1, items: [task("tiny", 10)],
      defaultTimeSlots: [{ ...slots[0], start: "19:00", end: "19:10" }], busy: [], minimumMinutes: 15,
    });
    expect(plan).toMatchObject({ allocations: [], unscheduledKeys: ["tiny"], availableMinutes: 0 });
  });

  it("does not emit a session below the minimum when the target itself is shorter", () => {
    const plan = buildSchedulePlan({
      startDate: "2026-08-03", days: 1, items: [task("tiny-target", 10)],
      defaultTimeSlots: [{ ...slots[0], start: "19:00", end: "19:30" }], busy: [], minimumMinutes: 15,
    });
    expect(plan).toMatchObject({ allocations: [], unscheduledKeys: ["tiny-target"], availableMinutes: 30 });
  });

  it("uses priority before task-pool order when deadlines match", () => {
    const plan = buildSchedulePlan({
      startDate: "2026-08-03", days: 1,
      items: [task("low", 30, { priority: "low", sortOrder: 0 }), task("high", 30, { priority: "high", sortOrder: 9 })],
      defaultTimeSlots: slots, busy: [], minimumMinutes: 15,
    });
    expect(plan.allocations.map((item) => item.key)).toEqual(["high", "low"]);
  });

  it("merges overlapping default slots before calculating capacity", () => {
    const plan = buildSchedulePlan({
      startDate: "2026-08-03", days: 1, items: [task("deep", 120), task("short", 60, { sortOrder: 1 })],
      defaultTimeSlots: [
        { ...slots[0], id: "first", start: "19:00", end: "21:00" },
        { ...slots[0], id: "second", start: "20:00", end: "22:00" },
      ], busy: [], minimumMinutes: 15,
    });
    expect(plan.availableMinutes).toBe(180);
    expect(plan.allocations).toEqual([
      expect.objectContaining({ key: "deep", startLocal: "19:00", endLocal: "21:00" }),
      expect.objectContaining({ key: "short", startLocal: "21:00", endLocal: "22:00" }),
    ]);
  });

  it("keeps a dated habit occurrence on its own date and reports unscheduled items", () => {
    const plan = buildSchedulePlan({
      startDate: "2026-08-03",
      days: 2,
      items: [task("habit:2026-08-04", 30, { fixedDate: "2026-08-04" }), task("too-long", 30, { fixedDate: "2026-08-03" })],
      defaultTimeSlots: [{ ...slots[0], start: "19:00", end: "19:30", weekdays: [2] }],
      busy: [],
      minimumMinutes: 15,
    });

    expect(plan.allocations).toEqual([expect.objectContaining({ key: "habit:2026-08-04", localDate: "2026-08-04" })]);
    expect(plan.unscheduledKeys).toEqual(["too-long"]);
  });

  it("honors an occurrence's fixed start while leaving the earlier gap available", () => {
    const plan = buildSchedulePlan({
      startDate: "2026-08-03",
      days: 1,
      items: [
        task("fixed-habit", 30, { fixedDate: "2026-08-03", fixedStartLocal: "20:30", sortOrder: 0 }),
        task("flexible-task", 60, { sortOrder: 1 }),
      ],
      defaultTimeSlots: slots,
      busy: [],
      minimumMinutes: 15,
    });

    expect(plan.allocations).toEqual([
      expect.objectContaining({ key: "fixed-habit", startLocal: "20:30", endLocal: "21:00" }),
      expect.objectContaining({ key: "flexible-task", startLocal: "19:00", endLocal: "20:00" }),
    ]);
  });

  // D1=a（2026-10-24）：逾期任务按窗口首日参与排档。改前这条会红 —— 截止日期早于窗口首日时
  // `eligible` 恒为空，任务永远进 unscheduledKeys。
  it("schedules an overdue task against the first day of the window", () => {
    const plan = buildSchedulePlan({
      startDate: "2026-08-03", days: 2,
      items: [task("overdue", 20, { deadlineLocal: "2026-08-01" })],
      defaultTimeSlots: slots, busy: [], minimumMinutes: 15,
    });

    expect(plan.allocations).toEqual([expect.objectContaining({ key: "overdue", localDate: "2026-08-03", startLocal: "19:00", endLocal: "19:20" })]);
    expect(plan.unscheduled).toEqual([]);
  });

  it("never lets a clamped overdue deadline reach past the first day", () => {
    const plan = buildSchedulePlan({
      startDate: "2026-08-03", days: 2,
      // 首日只有 10 分钟（低于最低有效时长），次日有整段可用：钳制之后仍然不能跨到次日。
      items: [task("overdue", 30, { deadlineLocal: "2026-08-01" })],
      defaultTimeSlots: [{ ...slots[0], start: "19:00", end: "19:50" }],
      busy: [{ localDate: "2026-08-03", endLocalDate: "2026-08-03", startLocal: "19:00", endLocal: "19:40" }],
      minimumMinutes: 15,
    });

    expect(plan.allocations).toEqual([]);
    expect(plan.unscheduled).toEqual([{ key: "overdue", reason: "gaps-too-short", longestGapMinutes: 10 }]);
  });
});

describe("automatic scheduling unscheduled reasons", () => {
  const only = (plan: ReturnType<typeof buildSchedulePlan>) => plan.unscheduled.map((item) => `${item.key}:${item.reason}:${item.longestGapMinutes}`);

  it("reports below-minimum for a target shorter than the minimum effective length", () => {
    const plan = buildSchedulePlan({ startDate: "2026-08-03", days: 1, items: [task("tiny", 10)], defaultTimeSlots: slots, busy: [], minimumMinutes: 15 });
    expect(only(plan)).toEqual(["tiny:below-minimum:0"]);
    // 兼容字段与结构化输出一一对应，顺序一致。
    expect(plan.unscheduledKeys).toEqual(plan.unscheduled.map((item) => item.key));
  });

  it("reports no-slots when no default time slot produces a gap at all", () => {
    const plan = buildSchedulePlan({ startDate: "2026-08-03", days: 7, items: [task("anything", 30)], defaultTimeSlots: [], busy: [], minimumMinutes: 15 });
    expect(only(plan)).toEqual(["anything:no-slots:0"]);
  });

  it("reports no-gap-that-day for a dated occurrence on a day without default slots", () => {
    const plan = buildSchedulePlan({
      startDate: "2026-08-03", days: 2,
      items: [task("habit:2026-08-04", 30, { fixedDate: "2026-08-04" })],
      defaultTimeSlots: [{ ...slots[0], weekdays: [1] }], busy: [], minimumMinutes: 15,
    });
    expect(only(plan)).toEqual(["habit:2026-08-04:no-gap-that-day:0"]);
  });

  it("reports fixed-start-busy when the fixed start falls inside an occupied range", () => {
    const plan = buildSchedulePlan({
      startDate: "2026-08-03", days: 1,
      items: [task("fixed", 30, { fixedDate: "2026-08-03", fixedStartLocal: "20:30" })],
      defaultTimeSlots: slots,
      busy: [{ localDate: "2026-08-03", endLocalDate: "2026-08-03", startLocal: "20:00", endLocal: "21:00" }],
      minimumMinutes: 15,
    });
    expect(only(plan)).toEqual(["fixed:fixed-start-busy:0"]);
  });

  it("reports deadline-no-gap when every gap sits after the deadline day", () => {
    const plan = buildSchedulePlan({
      startDate: "2026-08-03", days: 2,
      items: [task("due-today", 30, { deadlineLocal: "2026-08-03" })],
      defaultTimeSlots: [{ ...slots[0], weekdays: [2] }], busy: [], minimumMinutes: 15,
    });
    expect(only(plan)).toEqual(["due-today:deadline-no-gap:0"]);
  });

  it("reports gaps-too-short with the longest gap it could find", () => {
    const plan = buildSchedulePlan({
      startDate: "2026-08-03", days: 1, items: [task("long", 60)],
      defaultTimeSlots: [{ ...slots[0], start: "19:00", end: "19:10" }], busy: [], minimumMinutes: 15,
    });
    expect(only(plan)).toEqual(["long:gaps-too-short:10"]);
  });
});

describe("automatic scheduling daily budget", () => {
  it("leaves allocation unchanged when no budget is set", () => {
    const base = { startDate: "2026-08-03", days: 1, items: [task("a", 60)], defaultTimeSlots: slots, busy: [], minimumMinutes: 15 };
    expect(buildSchedulePlan(base).allocations).toEqual(buildSchedulePlan({ ...base, dailyBudgetMinutes: null }).allocations);
  });

  it("caps a day at the budget and reports daily-budget-full for the overflow", () => {
    const plan = buildSchedulePlan({
      startDate: "2026-08-03", days: 1,
      items: [task("first", 60, { sortOrder: 0 }), task("second", 60, { sortOrder: 1 })],
      defaultTimeSlots: slots, busy: [], minimumMinutes: 15, dailyBudgetMinutes: 60,
    });
    expect(plan.allocations).toEqual([expect.objectContaining({ key: "first", startLocal: "19:00", endLocal: "20:00", minutes: 60 })]);
    expect(plan.unscheduled).toEqual([{ key: "second", reason: "daily-budget-full", longestGapMinutes: 0 }]);
  });

  it("spills overflow to the next day within the window", () => {
    const plan = buildSchedulePlan({
      startDate: "2026-08-03", days: 2,
      items: [task("first", 60, { sortOrder: 0 }), task("second", 60, { sortOrder: 1 })],
      defaultTimeSlots: slots, busy: [], minimumMinutes: 15, dailyBudgetMinutes: 60,
    });
    expect(plan.allocations).toEqual([
      expect.objectContaining({ key: "first", localDate: "2026-08-03", startLocal: "19:00", endLocal: "20:00" }),
      expect.objectContaining({ key: "second", localDate: "2026-08-04", startLocal: "19:00", endLocal: "20:00" }),
    ]);
  });

  it("reports capacity as the budget-capped sum per day", () => {
    const plan = buildSchedulePlan({
      startDate: "2026-08-03", days: 2, items: [],
      defaultTimeSlots: slots, busy: [], minimumMinutes: 15, dailyBudgetMinutes: 60,
    });
    expect(plan.availableMinutes).toBe(120);
  });

  it("partially fills the remaining budget before closing the day", () => {
    const plan = buildSchedulePlan({
      startDate: "2026-08-03", days: 1, items: [task("big", 90)],
      defaultTimeSlots: slots, busy: [], minimumMinutes: 15, dailyBudgetMinutes: 60,
    });
    expect(plan.allocations).toEqual([expect.objectContaining({ key: "big", minutes: 60, startLocal: "19:00", endLocal: "20:00" })]);
    expect(plan.unscheduled).toEqual([]);
  });
});
