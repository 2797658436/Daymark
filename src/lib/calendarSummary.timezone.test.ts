import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deadlineUrgency } from "./calendarSummary";

/**
 * 阶段 4 D4：日历「7 天内截止」的判定必须按**日历日**，不能按毫秒差。
 *
 * 本机时区是 Asia/Shanghai，没有夏令时 —— 旧实现 `7 * 86_400_000` 在默认时区下
 * 数值恰好正确，缺陷根本不会暴露。这里把进程时区改成 America/New_York：
 *
 * - 2026-11-01 是夏令时结束那天，本地日 **25 小时**。于是「正好 7 个日历日之后」
 *   （2026-10-25 → 2026-11-01）的毫秒差是 `608,400,000 > 604,800,000`，
 *   旧实现会把它错标成「未来截止」，而它应该是「7 天内截止」。
 * - 2026-03-08 是夏令时开始那天，本地日 **23 小时**，反方向同样按日历日算。
 *
 * Vitest 默认按文件隔离进程，改动不外溢到其他测试文件。
 */
const previousTimeZone = process.env.TZ;
beforeAll(() => { process.env.TZ = "America/New_York"; });
afterAll(() => {
  if (previousTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousTimeZone;
});

/** 两个本地正午之间的小时数；夏令时切换周不是 24 的整数倍。 */
const hoursBetween = (from: string, to: string) =>
  (new Date(`${to}T12:00:00`).getTime() - new Date(`${from}T12:00:00`).getTime()) / 3_600_000;

describe("deadline urgency across a daylight-saving transition", () => {
  it("runs in a timezone where the target day really is 25 hours", () => {
    // 时区没生效的话下面的断言会空跑通过，所以先证明这一天确实是 25 小时。
    expect(new Date("2026-10-25T12:00:00").getTimezoneOffset()).toBe(240); // EDT
    expect(new Date("2026-11-01T12:00:00").getTimezoneOffset()).toBe(300); // EST
    expect(hoursBetween("2026-10-31", "2026-11-01")).toBe(25);
  });

  it("counts calendar days rather than elapsed milliseconds", () => {
    // 正好 7 个日历日，但毫秒差是 169 小时 —— 旧实现据此判成「未来截止」。
    expect(hoursBetween("2026-10-25", "2026-11-01")).toBe(169);
    expect(deadlineUrgency("2026-11-01", "2026-10-25")).toBe("soon");

    // 第 8 天仍是「未来截止」。
    expect(deadlineUrgency("2026-11-02", "2026-10-25")).toBe("later");

    // 春季前拨（2026-03-08 是 23 小时）反方向同样按日历日。
    expect(hoursBetween("2026-03-07", "2026-03-14")).toBe(167);
    expect(deadlineUrgency("2026-03-14", "2026-03-07")).toBe("soon");
    expect(deadlineUrgency("2026-03-15", "2026-03-07")).toBe("later");
  });
});
