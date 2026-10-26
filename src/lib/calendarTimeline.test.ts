import { describe, expect, it } from "vitest";
import { COLLAPSED_GAP_HEIGHT, collapsedGapHeight, createCalendarTimeline, defaultSlotSlicesForWeekday, fullDayEffectiveRanges } from "./calendarTimeline";

describe("calendar timeline folding", () => {
  it("derives the collapsed band height from the UI scale and uses it in the mapping", () => {
    expect(collapsedGapHeight(100)).toBe(44);
    expect(collapsedGapHeight(150)).toBe(66);
    expect(collapsedGapHeight(200)).toBe(88);
    const timeline = createCalendarTimeline({
      mode: "defaultSlots",
      slots: [],
      expandedGapKeys: new Set(),
      currentMinute: null,
      pixelsPerHour: 84,
      collapsedGapPx: collapsedGapHeight(200),
    });
    // 全天都折叠成一条带：高度与映射必须用同一个值，不能再出现 44 对 88。
    expect(timeline.totalHeight).toBe(88);
    expect(timeline.offsetAtMinute(720)).toBe(44);
  });

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

  it("folds the empty early and late hours of a full day and keeps the middle linear", () => {
    const ranges = fullDayEffectiveRanges({ occupiedRanges: [], currentMinute: 12 * 60 });
    expect(ranges).toEqual([{ start: 360, end: 1380 }]);
    const timeline = createCalendarTimeline({
      mode: "fullDay", slots: [], expandedGapKeys: new Set(), currentMinute: null,
      fullDayRanges: ranges, pixelsPerHour: 84,
    });
    expect(timeline.gaps.map((gap) => gap.key)).toEqual(["0-360", "1380-1440"]);
    expect(timeline.segments.map(({ start, end, collapsed }) => ({ start, end, collapsed }))).toEqual([
      { start: 0, end: 360, collapsed: true },
      { start: 360, end: 1380, collapsed: false },
      { start: 1380, end: 1440, collapsed: true },
    ]);
    expect(timeline.totalHeight).toBe(17 * 84 + COLLAPSED_GAP_HEIGHT * 2);
    expect(timeline.positionForRange("05:00", "06:00")).toBeNull();
    expect(timeline.positionForRange("12:00", "13:00")).not.toBeNull();
  });

  it("keeps an early or late range open when it has content or the current time", () => {
    expect(fullDayEffectiveRanges({ occupiedRanges: [{ start: 120, end: 300 }], currentMinute: 12 * 60 }))
      .toEqual([{ start: 0, end: 1380 }]);
    expect(fullDayEffectiveRanges({ occupiedRanges: [], currentMinute: 23 * 60 + 30 }))
      .toEqual([{ start: 360, end: 1440 }]);
    expect(fullDayEffectiveRanges({ occupiedRanges: [{ start: 23 * 60, end: 24 * 60 }], currentMinute: 12 * 60 }))
      .toEqual([{ start: 360, end: 1440 }]);
  });

  it("lets the whole-day expansion entry reveal both effective-day folds temporarily", () => {
    const timeline = createCalendarTimeline({
      mode: "fullDay", slots: [], expandedGapKeys: new Set(["0-360", "1380-1440"]), currentMinute: null,
      fullDayRanges: fullDayEffectiveRanges({ occupiedRanges: [], currentMinute: 12 * 60 }), pixelsPerHour: 60,
    });
    expect(timeline.segments.every((segment) => !segment.collapsed)).toBe(true);
    expect(timeline.totalHeight).toBe(1440);
    expect(timeline.positionForRange("02:00", "03:00")).not.toBeNull();
  });

  it("does not change the default-slot mode when a full-day range is supplied", () => {
    const timeline = createCalendarTimeline({
      mode: "defaultSlots",
      slots: [{ start: "19:00", end: "22:00" }],
      expandedGapKeys: new Set(),
      currentMinute: null,
      fullDayRanges: [{ start: 360, end: 1380 }],
      pixelsPerHour: 60,
    });
    expect(timeline.gaps.map((gap) => gap.key)).toEqual(["0-1140", "1320-1440"]);
  });
});
