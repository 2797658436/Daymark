import { describe, expect, it } from "vitest";
import { resolveScheduleWindow, windowEndDate, windowSpansWeeks } from "./scheduleWindow";

// 2026-08-05 是周三，2026-08-03 是周一，2026-08-09 是周日。
const WEDNESDAY = "2026-08-05";
const MONDAY = "2026-08-03";
const SUNDAY = "2026-08-09";

describe("schedule window", () => {
  it("keeps a rolling 7-day window that starts today", () => {
    const window = resolveScheduleWindow("next7", WEDNESDAY);
    expect(window.startDate).toBe(WEDNESDAY);
    expect(window.days).toBe(7);
    expect(windowEndDate(window)).toBe("2026-08-11");
  });

  it("shrinks this-week to the remaining days including today", () => {
    expect(resolveScheduleWindow("thisWeek", WEDNESDAY)).toMatchObject({ startDate: WEDNESDAY, days: 5 });
    expect(resolveScheduleWindow("thisWeek", MONDAY)).toMatchObject({ startDate: MONDAY, days: 7 });
    // 周日只剩今天这一天 —— 这正是这个口径不设为默认的原因。
    expect(resolveScheduleWindow("thisWeek", SUNDAY)).toMatchObject({ startDate: SUNDAY, days: 1 });
  });

  it("always starts next-week on a Monday and covers a full week", () => {
    const wednesday = resolveScheduleWindow("nextWeek", WEDNESDAY);
    expect(wednesday.startDate).toBe("2026-08-10");
    expect(new Date(`${wednesday.startDate}T12:00:00`).getDay()).toBe(1);
    expect(wednesday.days).toBe(7);
    expect(windowEndDate(wednesday)).toBe("2026-08-16");

    // 周日打开时「下周一」就是明天。
    expect(resolveScheduleWindow("nextWeek", SUNDAY).startDate).toBe("2026-08-10");
    // 周一打开时必须跳过今天，否则会排成「本周」。
    expect(resolveScheduleWindow("nextWeek", MONDAY).startDate).toBe("2026-08-10");
  });

  it("reports whether the window crosses a week boundary", () => {
    expect(windowSpansWeeks(resolveScheduleWindow("next7", WEDNESDAY))).toBe(true);
    expect(windowSpansWeeks(resolveScheduleWindow("next7", MONDAY))).toBe(false);
    expect(windowSpansWeeks(resolveScheduleWindow("thisWeek", WEDNESDAY))).toBe(false);
    expect(windowSpansWeeks(resolveScheduleWindow("nextWeek", WEDNESDAY))).toBe(false);
  });
});
