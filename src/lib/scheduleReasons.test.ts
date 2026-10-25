import { describe, expect, it } from "vitest";

import { scheduleUnscheduledText } from "./scheduleReasons";
import type { ScheduleUnscheduledReason } from "./scheduling";

/** 六种会真正产出的原因各一条文案；`continuous-unavailable` 是预留位，只验文案存在。 */
const cases: Array<[ScheduleUnscheduledReason, number, string]> = [
  ["below-minimum", 0, "单次时长短于最低有效时长 15 分钟"],
  ["no-slots", 0, "所选范围里没有默认时段"],
  ["no-gap-that-day", 0, "该日没有可用空档"],
  ["fixed-start-busy", 0, "固定开始时间已被占用"],
  ["deadline-no-gap", 0, "截止日期前没有可用空档"],
  ["gaps-too-short", 10, "空档都短于最低有效时长（最长 10 分钟）"],
  ["continuous-unavailable", 0, "需要连续时段（后续阶段）"],
];

describe("unscheduled reason copy", () => {
  for (const [reason, longestGapMinutes, expected] of cases) {
    it(`explains ${reason} without blaming language`, () => {
      expect(scheduleUnscheduledText({ key: "k", reason, longestGapMinutes }, 15)).toBe(expected);
    });
  }

  it("uses the same neutral wording when the engine gave no reason at all", () => {
    expect(scheduleUnscheduledText(undefined, 15)).toBe("当前组合里放不下");
  });

  it("never uses failure or lagging language", () => {
    const all = [...cases.map(([reason, longestGapMinutes]) => scheduleUnscheduledText({ key: "k", reason, longestGapMinutes }, 15)), scheduleUnscheduledText(undefined, 15)];
    expect(all.every((text) => !/失败|落后|逾期.*未完成/.test(text))).toBe(true);
  });
});
