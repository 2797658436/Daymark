import { describe, expect, it } from "vitest";

import {
  addAvailability, addFold, availabilityBlocks, availabilityFolds, availabilityMinuteAt, availabilityOffset, availabilitySegments, availabilitySpan,
  availabilityVisibleHours, foldedClock, foldedMinute, mergeAvailability, moveAvailability, moveFold, normalizeFoldedRanges, presetAvailability, removeAvailability, removeFold, replaceAvailability, snapMinute, type AvailabilitySnap,
} from "./availability";
import { SettingsRepository, type DefaultTimeSlot } from "./settings";

const slot = (over: Partial<DefaultTimeSlot> & { id: string }): DefaultTimeSlot => ({ label: "可用时间", start: "19:00", end: "22:00", weekdays: [1], ...over });
let seq = 0;
const makeId = () => `id-${++seq}`;

describe("availability windows", () => {
  it("expands multi-weekday slots into per-day blocks, sorted by weekday", () => {
    const blocks = availabilityBlocks([slot({ id: "a", weekdays: [3, 1] })]);
    expect(blocks.map((block) => `${block.weekday}:${block.start}`)).toEqual(["1:19:00", "3:19:00"]);
  });

  it("coalesces the same range across days into one window", () => {
    const first = addAvailability([], 1, "08:00", "23:00", makeId);
    const second = addAvailability(first, 2, "08:00", "23:00", makeId);
    expect(second).toHaveLength(1);
    expect(second[0].weekdays).toEqual([1, 2]);
    // 同一天同一段重复添加不产生新窗口。
    expect(addAvailability(second, 1, "08:00", "23:00", makeId)).toEqual(second);
  });

  it("keeps a different range on the same day as its own window", () => {
    const next = addAvailability(addAvailability([], 1, "08:00", "12:00", makeId), 1, "19:00", "22:00", makeId);
    expect(next).toHaveLength(2);
    expect(next.map((value) => value.start)).toEqual(["08:00", "19:00"]);
  });

  it("ignores an empty or reversed range", () => {
    expect(addAvailability([], 1, "12:00", "12:00", makeId)).toEqual([]);
    expect(addAvailability([], 1, "13:00", "12:00", makeId)).toEqual([]);
  });

  it("removes only the requested day and drops the window when no day is left", () => {
    const both = addAvailability(addAvailability([], 1, "08:00", "23:00", makeId), 2, "08:00", "23:00", makeId);
    const oneLeft = removeAvailability(both, 1, "08:00", "23:00");
    expect(oneLeft).toHaveLength(1);
    expect(oneLeft[0].weekdays).toEqual([2]);
    expect(removeAvailability(oneLeft, 2, "08:00", "23:00")).toEqual([]);
  });

  it("moves a single-day window in place, keeping its id and label", () => {
    const before = [slot({ id: "solo", label: "晨间", weekdays: [1] })];
    const after = moveAvailability(before, 1, { start: "19:00", end: "22:00" }, { start: "20:00", end: "23:00" }, makeId);
    expect(after).toEqual([slot({ id: "solo", label: "晨间", start: "20:00", end: "23:00", weekdays: [1] })]);
  });

  it("splits one day out of a shared window when it is dragged", () => {
    const before = [slot({ id: "shared", weekdays: [1, 2] })];
    const after = moveAvailability(before, 1, { start: "19:00", end: "22:00" }, { start: "18:00", end: "21:00" }, makeId);
    expect(after).toHaveLength(2);
    expect(after.find((value) => value.id === "shared")?.weekdays).toEqual([2]);
    expect(after.find((value) => value.id !== "shared")).toMatchObject({ start: "18:00", end: "21:00", weekdays: [1] });
  });

  it("merges into an existing window when dragged onto the same range", () => {
    const before = [slot({ id: "evening", weekdays: [2] }), slot({ id: "morning", start: "08:00", end: "12:00", weekdays: [1] })];
    const after = moveAvailability(before, 2, { start: "19:00", end: "22:00" }, { start: "08:00", end: "12:00" }, makeId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: "morning", weekdays: [1, 2] });
  });

  it("returns the same list when the drag ends where it started or lands backwards", () => {
    const before = [slot({ id: "a" })];
    expect(moveAvailability(before, 1, { start: "19:00", end: "22:00" }, { start: "19:00", end: "22:00" }, makeId)).toBe(before);
    expect(moveAvailability(before, 1, { start: "19:00", end: "22:00" }, { start: "22:00", end: "19:00" }, makeId)).toBe(before);
  });

  it("builds a single all-week preset window", () => {
    const slots = presetAvailability("common", makeId);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ start: "08:00", end: "23:00", weekdays: [0, 1, 2, 3, 4, 5, 6] });
  });

  it("snaps minutes to the step inside [0, 1440]", () => {
    const snap = (minute: number, step: AvailabilitySnap) => snapMinute(minute, step);
    expect(snap(37, 15)).toBe(30);
    expect(snap(38, 15)).toBe(45);
    expect(snap(37, 0)).toBe(37);
    expect(snap(-10, 30)).toBe(0);
    expect(snap(1500, 30)).toBe(1440);
  });
});

describe("availability grid layout", () => {
  it("walks the day in hours when nothing is folded", () => {
    expect(availabilityOffset(0)).toEqual({ hours: 0, strips: 0 });
    expect(availabilityOffset(90)).toEqual({ hours: 1.5, strips: 0 });
    expect(availabilityOffset(1440)).toEqual({ hours: 24, strips: 0 });
  });

  it("counts a folded hour as part of one strip instead of its own hour", () => {
    // 折起 12:00 这一小时：12:00 之后只多了一条折带，13:00 之后再回到按小时铺开。
    expect(availabilityOffset(12 * 60, [12])).toEqual({ hours: 12, strips: 0 });
    expect(availabilityOffset(12 * 60 + 30, [12])).toEqual({ hours: 12, strips: 0.5 });
    expect(availabilityOffset(13 * 60, [12])).toEqual({ hours: 12, strips: 1 });
    expect(availabilityOffset(14 * 60, [12])).toEqual({ hours: 13, strips: 1 });
    expect(availabilityOffset(1440, [12])).toEqual({ hours: 23, strips: 1 });
  });

  it("merges neighbouring folded hours into a single strip for layout only", () => {
    // 勾选仍是逐小时的，布局上相邻的三小时并成一条带子（否则折 8 小时反而撑出 192px）。
    expect(availabilityFolds([12, 13, 14])).toEqual([{ start: 12, end: 15 }]);
    expect(availabilityFolds([14, 12])).toEqual([{ start: 12, end: 13 }, { start: 14, end: 15 }]);
    expect(availabilityOffset(12 * 60, [12, 13, 14])).toEqual({ hours: 12, strips: 0 });
    expect(availabilityOffset(13 * 60, [12, 13, 14]).strips).toBeCloseTo(1 / 3, 6);
    expect(availabilityOffset(15 * 60, [12, 13, 14])).toEqual({ hours: 12, strips: 1 });
    expect(availabilityOffset(1440, [12, 13, 14])).toEqual({ hours: 21, strips: 1 });
  });

  it("keeps a block continuous across a folded hour", () => {
    // 11:00–13:00 正好跨过被折起的 12:00：整块吃到那一条折带，没有断口、也不多出小时。
    expect(availabilitySpan(11 * 60, 13 * 60, [12])).toEqual({ hours: 1, strips: 1 });
    expect(availabilitySpan(13 * 60, 15 * 60, [12])).toEqual({ hours: 2, strips: 0 });
    // 只吃到折带一半的块（11:00–12:30）按比例拿半条带子，两块相接仍是连续的。
    expect(availabilitySpan(11 * 60, 12 * 60 + 30, [12])).toEqual({ hours: 1, strips: 0.5 });
    expect(availabilitySpan(9 * 60, 11 * 60 + 30)).toEqual({ hours: 2.5, strips: 0 });
  });

  it("lists visible hours and folded runs without overlap", () => {
    expect(availabilityVisibleHours()).toHaveLength(24);
    const visible = availabilityVisibleHours([0, 12]);
    expect(visible).toHaveLength(22);
    expect(visible).not.toContain(0);
    expect(visible).not.toContain(12);
    expect(visible).toContain(11);
    expect(visible).toContain(13);
  });

  it("maps a pointer ratio back to the minute it points at", () => {
    // 没有任何折叠时就是一条直线：0.5 → 12:00。
    expect(availabilityMinuteAt(0.5)).toBe(12 * 60);
    expect(availabilityMinuteAt(0)).toBe(0);
    expect(availabilityMinuteAt(1)).toBe(1440);
    // 折起 12:00 后折带占 0.25 小时的重量：13:00 处不再是 0.5。
    const total = 23 + 0.25;
    expect(availabilityMinuteAt(12 / total, [12])).toBeCloseTo(12 * 60, 6);
    expect(availabilityMinuteAt(12.25 / total, [12])).toBeCloseTo(13 * 60, 6);
    // 与 availabilityOffset 互逆：走到 14:00 的比例再换算回来仍是 14:00。
    const offset = availabilityOffset(14 * 60, [12]);
    expect(availabilityMinuteAt((offset.hours + offset.strips * 0.25) / total, [12])).toBeCloseTo(14 * 60, 6);
  });
});

describe("folded ranges", () => {
  const folds = (...ranges: Array<[string, string]>) => ranges.map(([start, end]) => ({ start, end }));

  it("sorts by start and merges touching or overlapping ranges", () => {
    expect(normalizeFoldedRanges(folds(["23:00", "24:00"], ["00:00", "06:00"])))
      .toEqual(folds(["00:00", "06:00"], ["23:00", "24:00"]));
    // 相接（06:00 紧接 07:00）与重叠（07:30 落在 07:00–08:00 里）都并成一段。
    expect(normalizeFoldedRanges(folds(["07:00", "08:00"], ["06:00", "07:00"])))
      .toEqual(folds(["06:00", "08:00"]));
    expect(normalizeFoldedRanges(folds(["07:00", "09:00"], ["07:30", "08:00"])))
      .toEqual(folds(["07:00", "09:00"]));
  });

  it("drops ranges shorter than thirty minutes and falls back to the default when nothing is left", () => {
    expect(normalizeFoldedRanges(folds(["00:00", "05:30"], ["10:00", "10:29"])))
      .toEqual(folds(["00:00", "05:30"]));
    // 全部非法（太短）：与「非数组」走同一条回退路径。
    expect(normalizeFoldedRanges(folds(["10:00", "10:15"]))).toEqual(folds(["00:00", "06:00"], ["23:00", "24:00"]));
  });

  it("rejects malformed clocks but accepts 24:00 as the only out-of-range value", () => {
    expect(foldedMinute("24:00")).toBe(1440);
    expect(foldedMinute("24:30")).toBeNull();
    expect(foldedMinute("9:00")).toBeNull();
    expect(foldedMinute("09:0")).toBeNull();
    expect(foldedMinute("23:60")).toBeNull();
    expect(foldedMinute("25:00")).toBeNull();
    expect(normalizeFoldedRanges(folds(["23:00", "24:30"], ["08:00", "09:00"])))
      .toEqual(folds(["08:00", "09:00"]));
    // end 不晚于 start 的项直接丢弃。
    expect(normalizeFoldedRanges(folds(["09:00", "09:00"], ["08:00", "07:00"], ["10:00", "12:00"])))
      .toEqual(folds(["10:00", "12:00"]));
  });

  it("keeps an explicitly empty list and falls back only for missing or unusable input", () => {
    // [] = 一整天不折叠，合法；不许静默补默认。
    expect(normalizeFoldedRanges([])).toEqual([]);
    expect(normalizeFoldedRanges(undefined)).toEqual(folds(["00:00", "06:00"], ["23:00", "24:00"]));
    expect(normalizeFoldedRanges("00:00-06:00")).toEqual(folds(["00:00", "06:00"], ["23:00", "24:00"]));
    expect(normalizeFoldedRanges([null, 42, {}])).toEqual(folds(["00:00", "06:00"], ["23:00", "24:00"]));
    // 缺字段的老设置（`{}`）落到同一处默认值，不抛错。
    expect(new SettingsRepository({ read: async () => ({}), write: async () => undefined }).normalize({}).foldedRanges)
      .toEqual(folds(["00:00", "06:00"], ["23:00", "24:00"]));
  });

  it("writes 1440 back as 24:00 and every other boundary as HH:MM", () => {
    expect(foldedClock(1440)).toBe("24:00");
    expect(foldedClock(1439)).toBe("23:59");
    expect(foldedClock(0)).toBe("00:00");
    expect(foldedClock(90)).toBe("01:30");
    expect(normalizeFoldedRanges(folds(["22:00", "23:59"]))).toEqual(folds(["22:00", "23:59"]));
  });

  it("splits the day into the four segment shapes", () => {
    // 零折叠：整天一段展开段。
    expect(availabilitySegments([])).toEqual([{ start: 0, end: 1440, collapsed: false }]);
    // 首段折叠（默认值）：00–06 灰带 + 06–23 展开 + 23–24 灰带，首尾相接覆盖整天。
    expect(availabilitySegments(folds(["00:00", "06:00"], ["23:00", "24:00"]))).toEqual([
      { start: 0, end: 360, collapsed: true },
      { start: 360, end: 1380, collapsed: false },
      { start: 1380, end: 1440, collapsed: true },
    ]);
    // 中间折叠：11–13 夹在两段展开段之间。
    expect(availabilitySegments(folds(["11:00", "13:00"]))).toEqual([
      { start: 0, end: 660, collapsed: false },
      { start: 660, end: 780, collapsed: true },
      { start: 780, end: 1440, collapsed: false },
    ]);
    // 全折叠：只剩一段，没有展开段（界面据此给空态）。
    expect(availabilitySegments(folds(["00:00", "24:00"]))).toEqual([{ start: 0, end: 1440, collapsed: true }]);
  });

  it("adds, moves and removes folds without touching the input array", () => {
    const before = folds(["00:00", "06:00"]);
    const added = addFold(before, "12:00", "13:00");
    expect(added).toEqual(folds(["00:00", "06:00"], ["12:00", "13:00"]));
    expect(before).toEqual(folds(["00:00", "06:00"]));
    // 短于 30 分钟不新增。
    expect(addFold(before, "12:00", "12:15")).toEqual(before);
    // 平移：时长不变，贴到相邻段由规范化合并。
    expect(moveFold(added, { start: "12:00", end: "13:00" }, { start: "13:00", end: "14:00" }))
      .toEqual(folds(["00:00", "06:00"], ["13:00", "14:00"]));
    // 落到 00:00–06:00 这段灰带里 → 整段并入，只剩那一条。
    expect(moveFold(added, { start: "12:00", end: "13:00" }, { start: "05:00", end: "06:00" }))
      .toEqual(folds(["00:00", "06:00"]));
    // 展开：删掉这一段，其余保留；最后一段删掉后剩空数组（不补默认）。
    expect(removeFold(added, { start: "12:00", end: "13:00" })).toEqual(folds(["00:00", "06:00"]));
    expect(removeFold(before, { start: "00:00", end: "06:00" })).toEqual([]);
  });

  it("merges adjacent blocks on the same day and keeps shared windows per weekday", () => {
    const merged = mergeAvailability([
      { id: "a", label: "可用时间", start: "09:00", end: "10:00", weekdays: [1, 2] },
      { id: "b", label: "可用时间", start: "10:00", end: "11:00", weekdays: [1] },
      { id: "c", label: "可用时间", start: "14:00", end: "15:00", weekdays: [2] },
    ]);
    // 同一天相接的两块并成一段；另一个星期仍保留自己那一段（列表按起止升序）。
    expect(merged.map((slot) => `${slot.start}-${slot.end}:${slot.weekdays.join("")}`))
      .toEqual(["09:00-10:00:2", "09:00-11:00:1", "14:00-15:00:2"]);
  });

  it("rewrites only the visible slice of a block that runs into a folded band", () => {
    const slots: DefaultTimeSlot[] = [{ id: "one", label: "晨间", start: "05:00", end: "09:00", weekdays: [1] }];
    const makeId = () => "fresh";
    // 周一 05:00–09:00 的空闲，00–06 被折成灰带：看得见的是 06:00–09:00。
    // 把可见片拖成 07:00–08:00：藏在灰带里的 05:00–06:00 必须原样写回（不能跟着一起消失）。
    expect(replaceAvailability(slots, 1, { start: "05:00", end: "09:00" }, { start: "07:00", end: "08:00" }, { start: 360, end: 540 }, makeId)
      .map((slot) => `${slot.start}-${slot.end}:${slot.label}`))
      .toEqual(["05:00-06:00:晨间", "07:00-08:00:晨间"]);
    // 可见片落到紧贴灰带边界的 06:00–08:00 时，首尾相接 → 合并成 05:00–08:00，一分钟都没被删掉。
    expect(replaceAvailability(slots, 1, { start: "05:00", end: "09:00" }, { start: "06:00", end: "08:00" }, { start: 360, end: 540 }, makeId)
      .map((slot) => `${slot.start}-${slot.end}`))
      .toEqual(["05:00-08:00"]);
    // 另一头扎进 23:00–24:00 的灰带时同理：23:00–23:59 的尾巴不被这次拖动改掉。
    const tail: DefaultTimeSlot[] = [{ id: "two", label: "夜间", start: "21:00", end: "23:59", weekdays: [3] }];
    expect(replaceAvailability(tail, 3, { start: "21:00", end: "23:59" }, { start: "21:00", end: "22:00" }, { start: 1260, end: 1380 }, makeId)
      .map((slot) => `${slot.start}-${slot.end}:${slot.label}`))
      .toEqual(["21:00-22:00:夜间", "23:00-23:59:夜间"]);
  });
});
