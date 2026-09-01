import { describe, expect, it } from "vitest";

import { habitDatesBetween, habitOccursOn } from "./recurrence";
import type { RecurringHabit } from "./native";

const habit: RecurringHabit = {
  id: "habit-1",
  taskId: "habit-task-1",
  title: "拉伸",
  pattern: "weekdays",
  weekdays: [],
  startDate: "2026-08-01",
  sessionMinutes: 20,
  preferredStartLocal: null,
  status: "active",
};

describe("basic recurring habits", () => {
  it("supports daily, weekdays and selected weekdays", () => {
    expect(habitOccursOn({ ...habit, pattern: "daily" }, "2026-08-02")).toBe(true);
    expect(habitOccursOn(habit, "2026-08-03")).toBe(true);
    expect(habitOccursOn(habit, "2026-08-02")).toBe(false);
    expect(habitOccursOn({ ...habit, pattern: "weekly", weekdays: [2, 4] }, "2026-08-04")).toBe(true);
  });

  it("generates only dates in range and never before the habit starts", () => {
    expect(habitDatesBetween({ ...habit, pattern: "daily", startDate: "2026-08-04" }, "2026-08-02", "2026-08-06"))
      .toEqual(["2026-08-04", "2026-08-05", "2026-08-06"]);
  });
});
