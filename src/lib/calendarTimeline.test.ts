import { describe, expect, it } from "vitest";
import { COLLAPSED_GAP_HEIGHT, createCalendarTimeline, defaultSlotSlicesForWeekday } from "./calendarTimeline";

describe("calendar timeline folding", () => {
  it("carries the early slice of an overnight slot into the following weekday", () => {
    const slots = [{ id: "overnight", label: "夜间", start: "22:00", end: "02:00", weekdays: [1] }];
    expect(defaultSlotSlicesForWeekday(slots, 1).map(({ start, end }) => ({ start, end }))).toEqual([{ start: "22:00", end: "24:00" }]);
    expect(defaultSlotSlicesForWeekday(slots, 2).map(({ start, end }) => ({ start, end }))).toEqual([{ start: "00:00", end: "02:00" }]);
    expect(defaultSlotSlicesForWeekday(slots, 0)).toEqual([]);
  });

  it("merges overlapping and cross-midnight default slots before folding their complement", () => {
    const timeline = createCalendarTimeline({
      mode: "defaultSlots",
      slots: [
        { start: "19:00", end: "23:00" },
        { start: "22:00", end: "02:00" },
      ],
      expandedGapKeys: new Set(),
      currentMinute: null,
      pixelsPerHour: 60,
    });

    expect(timeline.gaps).toEqual([{ start: 120, end: 1140, key: "120-1140" }]);
    expect(timeline.totalHeight).toBe(7 * 60 + COLLAPSED_GAP_HEIGHT);
    expect(timeline.positionForRange("01:00", "01:30")).not.toBeNull();
    expect(timeline.positionForRange("10:00", "11:00")).toBeNull();
  });

  it("reveals only the two-hour current window when no default slot exists", () => {
    const timeline = createCalendarTimeline({
      mode: "defaultSlots",
      slots: [],
      expandedGapKeys: new Set(),
      currentMinute: 8 * 60,
      pixelsPerHour: 48,
    });

    expect(timeline.segments.map(({ start, end, collapsed }) => ({ start, end, collapsed }))).toEqual([
      { start: 0, end: 420, collapsed: true },
      { start: 420, end: 540, collapsed: false },
      { start: 540, end: 1440, collapsed: true },
    ]);
    expect(timeline.positionForRange("08:00", "08:30")).not.toBeNull();
    expect(timeline.positionForRange("12:00", "13:00")).toBeNull();
  });

  it("extends the current window enough to keep a long active arrangement visible", () => {
    const timeline = createCalendarTimeline({
      mode: "defaultSlots",
      slots: [],
      expandedGapKeys: new Set(),
      currentMinute: 8 * 60,
      revealedRanges: [{ start: 6 * 60 + 30, end: 8 * 60 + 30 }],
      pixelsPerHour: 48,
    });

    expect(timeline.positionForRange("06:30", "08:30")).not.toBeNull();
    expect(timeline.positionForRange("12:00", "13:00")).toBeNull();
  });

  it("keeps minute and pixel mapping reversible across folded and expanded segments", () => {
    const timeline = createCalendarTimeline({
      mode: "defaultSlots",
      slots: [{ start: "19:00", end: "22:00" }],
      expandedGapKeys: new Set(["0-1140"]),
      currentMinute: null,
      pixelsPerHour: 52,
    });

    for (const minute of [0, 60, 720, 1140, 1320, 1440]) {
      expect(timeline.minuteAtOffset(timeline.offsetAtMinute(minute))).toBeCloseTo(minute, 5);
    }
  });
});
