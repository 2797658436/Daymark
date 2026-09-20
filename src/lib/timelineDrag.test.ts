import { describe, expect, it } from "vitest";

import { DRAG_TARGET_MIN_PX, snapDelta, snapMinutesFor, snapTo } from "./timelineDrag";

describe("timeline drag maths", () => {
  it("uses the configured snap and lets Alt invert it", () => {
    expect(snapMinutesFor(15, false)).toBe(15);
    expect(snapMinutesFor(30, false)).toBe(30);
    // 开着吸附时按 Alt → 自由（1 分钟）
    expect(snapMinutesFor(15, true)).toBe(1);
    // 关着吸附时按 Alt → 15 分钟
    expect(snapMinutesFor("off", true)).toBe(15);
    expect(snapMinutesFor("off", false)).toBe(1);
  });

  it("snaps to the nearest grid line and clamps into range", () => {
    expect(snapTo(607, 15, 0, 1439)).toBe(600);
    expect(snapTo(608, 15, 0, 1439)).toBe(615);
    expect(snapTo(-40, 15, 0, 1439)).toBe(0);
    expect(snapTo(2000, 15, 0, 1439)).toBe(1439);
  });

  it("snaps a delta to the nearest grid line without clamping it to the day", () => {
    expect(snapDelta(37, 15)).toBe(30);
    expect(snapDelta(45, 15)).toBe(45);
    expect(snapDelta(-37, 15)).toBe(-30);
  });

  it("keeps the drop indicator at least as tall as a card", () => {
    // 卡片自身 min-height：时间块 28px、卡片 25px。短安排按真实时长画会只有 12–24px。
    expect(DRAG_TARGET_MIN_PX).toBeGreaterThanOrEqual(28);
  });
});
