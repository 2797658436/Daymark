import { describe, expect, it } from "vitest";

import {
  addAvailability, availabilityBlocks, availabilityFoldBands, availabilityMinuteAt, availabilityOffset, availabilitySpan,
  availabilityVisibleHours, moveAvailability, presetAvailability, removeAvailability, snapMinute, type AvailabilitySnap,
} from "./availability";
import type { DefaultTimeSlot } from "./settings";

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

  it("counts a folded band as one strip instead of its hours", () => {
    // 折起「中午 12–14」：12:00 之后只多了一条折带，14:00 之后再回到按小时铺开。
    expect(availabilityOffset(12 * 60, ["noon"])).toEqual({ hours: 12, strips: 0 });
    expect(availabilityOffset(13 * 60, ["noon"])).toEqual({ hours: 12, strips: 0.5 });
    expect(availabilityOffset(14 * 60, ["noon"])).toEqual({ hours: 12, strips: 1 });
    expect(availabilityOffset(15 * 60, ["noon"])).toEqual({ hours: 13, strips: 1 });
    expect(availabilityOffset(1440, ["noon"])).toEqual({ hours: 22, strips: 1 });
  });

  it("keeps a block continuous across a folded band", () => {
    // 11:00–13:00 跨过被折起的 12:00：整块吃到折带的**上半截**（中午是 12–14 两小时），
    // 没有断口、也不多出小时；13:00–15:00 再接上，两块在折带里紧挨着，读起来仍是连续的。
    expect(availabilitySpan(11 * 60, 13 * 60, ["noon"])).toEqual({ hours: 1, strips: 0.5 });
    expect(availabilitySpan(13 * 60, 15 * 60, ["noon"])).toEqual({ hours: 1, strips: 0.5 });
    expect(availabilitySpan(9 * 60, 11 * 60 + 30)).toEqual({ hours: 2.5, strips: 0 });
  });

  it("lists visible hours and folded bands without overlap", () => {
    expect(availabilityVisibleHours()).toHaveLength(24);
    const visible = availabilityVisibleHours(["dawn", "noon"]);
    expect(visible).toEqual([6, 7, 8, 9, 10, 11, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
    expect(availabilityFoldBands(["noon", "dawn"]).map((band) => band.id)).toEqual(["dawn", "noon"]);
  });

  it("maps a pointer ratio back to the minute it points at", () => {
    // 没有任何折叠时就是一条直线：0.5 → 12:00。
    expect(availabilityMinuteAt(0.5)).toBe(12 * 60);
    expect(availabilityMinuteAt(0)).toBe(0);
    expect(availabilityMinuteAt(1)).toBe(1440);
    // 折起「中午」后，折带占 0.25 小时的重量：14:00 处不再是 0.5。
    const total = 22 + 0.25;
    expect(availabilityMinuteAt(12 / total, ["noon"])).toBeCloseTo(12 * 60, 6);
    expect(availabilityMinuteAt((12 + 0.25) / total, ["noon"])).toBeCloseTo(14 * 60, 6);
    // 与 availabilityOffset 互逆：走到 15:00 的比例再换算回来仍是 15:00。
    const offset = availabilityOffset(15 * 60, ["noon"]);
    expect(availabilityMinuteAt((offset.hours + offset.strips * 0.25) / total, ["noon"])).toBeCloseTo(15 * 60, 6);
  });
});
