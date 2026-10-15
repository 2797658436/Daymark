import { describe, expect, it } from "vitest";

import { CALENDAR_SCALE_RANGE, PAGE_IDS, calendarScaleForZoom, DEFAULT_SETTINGS, SettingsRepository, type SettingsBackend } from "./settings";

class MemoryBackend implements SettingsBackend {
  value: unknown;

  async read() {
    return this.value;
  }

  async write(value: unknown) {
    this.value = value;
  }
}

describe("settings persistence", () => {
  it("restores the last page and accessibility preferences after a restart", async () => {
    const backend = new MemoryBackend();
    const firstRun = new SettingsRepository(backend);
    await firstRun.save({
      ...DEFAULT_SETTINGS,
      appearance: "dark",
      motion: "reduce",
      scale: 175,
      lastPage: "appearance",
    });

    const restarted = new SettingsRepository(backend);
    await expect(restarted.load()).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      appearance: "dark",
      motion: "reduce",
      scale: 175,
      lastPage: "appearance",
    });
  });

  it("clamps the draggable task pool width into a sane range and resets invalid values", async () => {
    const backend = new MemoryBackend();
    backend.value = { ...DEFAULT_SETTINGS, taskPoolWidth: 420 };
    await expect(new SettingsRepository(backend).load()).resolves.toMatchObject({ taskPoolWidth: 420 });
    backend.value = { ...DEFAULT_SETTINGS, taskPoolWidth: 9999 };
    await expect(new SettingsRepository(backend).load()).resolves.toMatchObject({ taskPoolWidth: null });
    backend.value = { ...DEFAULT_SETTINGS };
    await expect(new SettingsRepository(backend).load()).resolves.toMatchObject({ taskPoolWidth: null });
  });

  it("falls back safely when stored settings are incomplete or invalid", async () => {
    const backend = new MemoryBackend();
    backend.value = { appearance: "purple", motion: "reduce", scale: 900, lastPage: "missing" };

    await expect(new SettingsRepository(backend).load()).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      motion: "reduce",
    });
  });

  it("persists rapid changes in request order so the newest preference wins", async () => {
    class SlowFirstWriteBackend extends MemoryBackend {
      writes = 0;

      override async write(value: unknown) {
        this.writes += 1;
        if (this.writes === 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        this.value = value;
      }
    }

    const backend = new SlowFirstWriteBackend();
    const repository = new SettingsRepository(backend);
    const at = (minute: number) => ({ ...DEFAULT_SETTINGS, calendarPositions: { day: { date: "2026-08-05", minute, viewportRatio: 0.5 }, week: null } });
    const first = repository.save({ ...at(600), appearance: "dark" });
    const second = repository.save({ ...at(900), appearance: "light" });
    await Promise.all([first, second]);

    // 浏览位置与其它偏好走同一条顺序写入队列：慢的旧写入不能盖掉新的位置。
    expect(backend.value).toMatchObject({ appearance: "light", calendarPositions: { day: { minute: 900 } } });
  });

  it("normalizes preferences returned from a coordinated native restore", () => {
    const backend = new MemoryBackend();
    const repository = new SettingsRepository(backend);

    expect(repository.normalize({
      appearance: "dark",
      motion: "reduce",
      scale: 150,
      lastPage: "data",
      remindersEnabled: true,
      startupSummary: "daily",
      lastStartupSummaryLocalDate: "2026-07-30",
    })).toMatchObject({
      appearance: "dark", scale: 150, lastPage: "data", remindersEnabled: true,
      startupSummary: "daily", lastStartupSummaryLocalDate: "2026-07-30",
    });
  });

  it("does not enable startup summaries when a legacy reminder setting is enabled", () => {
    const repository = new SettingsRepository(new MemoryBackend());
    expect(repository.normalize({ remindersEnabled: true })).toMatchObject({
      remindersEnabled: true,
      startupSummary: "never",
    });
  });

  it("normalizes phase 2 scheduling and rescue preferences", () => {
    const repository = new SettingsRepository(new MemoryBackend());
    expect(repository.normalize({
      defaultSessionMinutes: 45,
      minimumSessionMinutes: 10,
      autoScheduleAssist: true,
      checkInGraceMinutes: 15,
      rescuePromptsEnabled: false,
      lastPage: "review",
    })).toMatchObject({
      defaultSessionMinutes: 45,
      minimumSessionMinutes: 10,
      autoScheduleAssist: true,
      checkInGraceMinutes: 15,
      rescuePromptsEnabled: false,
      lastPage: "review",
    });
    expect(repository.normalize({ defaultSessionMinutes: 0, minimumSessionMinutes: 12, checkInGraceMinutes: 99 }))
      .toMatchObject({ defaultSessionMinutes: 60, minimumSessionMinutes: 15, checkInGraceMinutes: 5 });
  });

  it("accepts turning calendar snapping off and rejects unknown snap values", () => {
    const repository = new SettingsRepository(new MemoryBackend());
    expect(repository.normalize({ snapMinutes: "off" })).toMatchObject({ snapMinutes: "off" });
    expect(repository.normalize({ snapMinutes: 30 })).toMatchObject({ snapMinutes: 30 });
    expect(repository.normalize({ snapMinutes: 7 })).toMatchObject({ snapMinutes: 15 });
  });

  it("normalizes phase 3 calendar view anchors and per-view continuous zoom state", () => {
    const repository = new SettingsRepository(new MemoryBackend());
    expect(repository.normalize({
      calendarView: "month",
      calendarAnchors: { day: "2026-08-05", week: "2026-08-10", month: "2026-09-05" },
      calendarZoom: { day: "detailed", week: "compact", month: "standard" },
      calendarScale: { day: 72, week: 32, month: 90 },
    })).toMatchObject({
      calendarView: "month",
      calendarAnchors: { day: "2026-08-05", week: "2026-08-10", month: "2026-09-05" },
      calendarZoom: { day: "detailed", week: "compact", month: "standard" },
      calendarScale: { day: 72, week: 32, month: 90 },
    });
    expect(repository.normalize({
      calendarView: "agenda",
      calendarAnchors: { day: "not-a-date", week: "2026-08-10" },
      calendarZoom: { day: "huge", week: "compact" },
      calendarScale: { day: 200, week: 12, month: "large" },
    })).toMatchObject({
      calendarView: "week",
      calendarAnchors: { day: null, week: "2026-08-10", month: null },
      calendarZoom: { day: "standard", week: "compact", month: "standard" },
      calendarScale: { day: 72, week: 48, month: 120 },
    });
    expect(repository.normalize({ calendarZoom: { day: "detailed", week: "compact", month: "standard" } }).calendarScale)
      .toEqual({ day: 96, week: 48, month: 120 });
  });

  it("keeps every calendar zoom preset inside the range normalization accepts", () => {
    const repository = new SettingsRepository(new MemoryBackend());
    for (const view of ["day", "week", "month"] as const) {
      for (const zoom of ["compact", "standard", "detailed"] as const) {
        const preset = calendarScaleForZoom(view, zoom);
        const [minimum, maximum] = CALENDAR_SCALE_RANGE[view];
        expect(preset, `${view}/${zoom} 预设必须落在合法区间内`).toBeGreaterThanOrEqual(minimum);
        expect(preset, `${view}/${zoom} 预设必须落在合法区间内`).toBeLessThanOrEqual(maximum);
      }
    }

    // 曾经越界的正是月视图 detailed：预设 160 高于上界 132，而校验失败的回退
    // 又调用同一个预设，于是规范化产出自己判为非法的值。
    expect(calendarScaleForZoom("month", "detailed")).toBe(160);
    expect(repository.normalize({ calendarZoom: { month: "detailed" } }).calendarScale.month).toBe(160);
    expect(repository.normalize({ calendarScale: { month: 160 } }).calendarScale.month).toBe(160);
    // 越界值仍必须回退到当前档位预设（默认 standard = 120）。
    expect(repository.normalize({ calendarScale: { month: 200 } }).calendarScale.month).toBe(120);
  });

  it("keeps the day display mode as a persisted UI preference", () => {
    const repository = new SettingsRepository(new MemoryBackend());
    expect(repository.normalize(undefined).calendarDayMode).toBe("fullDay");
    expect(repository.normalize({ calendarDayMode: "defaultSlots" }).calendarDayMode).toBe("defaultSlots");
    expect(repository.normalize({ calendarDayMode: "collapsed" }).calendarDayMode).toBe("fullDay");
  });

  it("keeps the actual-record overlay opt-in and persists an explicit choice", () => {
    const repository = new SettingsRepository(new MemoryBackend());
    expect(repository.normalize(undefined).showActualRecords).toBe(false);
    expect(repository.normalize({ showActualRecords: true }).showActualRecords).toBe(true);
    expect(repository.normalize({ showActualRecords: "yes" }).showActualRecords).toBe(false);
    expect(repository.normalize(undefined).showActualRecordsControl).toBe(true);
    expect(repository.normalize({ showActualRecordsControl: false }).showActualRecordsControl).toBe(false);
  });

  it("normalizes multiple default time slots with weekdays and keeps invalid ones out", () => {
    const repository = new SettingsRepository(new MemoryBackend());
    const slots = [
      { id: "morning", label: "晨间", start: "07:00", end: "09:00", weekdays: [1, 2, 3, 4, 5] },
      { id: "evening", label: "晚间", start: "19:00", end: "22:00", weekdays: [0, 6] },
    ];
    expect(repository.normalize({ defaultTimeSlots: slots })).toMatchObject({ defaultTimeSlots: slots });
    expect(repository.normalize({ defaultTimeSlots: [{ id: "broken", label: "坏", start: "9:00", end: "09:00", weekdays: [] }] }).defaultTimeSlots)
      .toEqual(DEFAULT_SETTINGS.defaultTimeSlots);
    expect(repository.normalize({ defaultTimeSlots: [] }).defaultTimeSlots).toEqual([]);
  });

  it("accepts day and week browsing positions and falls back per view", () => {
    const repository = new SettingsRepository(new MemoryBackend());
    const day = { date: "2026-08-05", minute: 720, viewportRatio: 0.5 };
    const week = { date: "2026-08-10", minute: 1439.5, viewportRatio: 0 };

    expect(repository.normalize(undefined).calendarPositions).toEqual({ day: null, week: null });
    expect(repository.normalize({ calendarPositions: { day, week } }).calendarPositions).toEqual({ day, week });
    // 未知字段忽略，其余字段照常保留。
    expect(repository.normalize({ calendarPositions: { day: { ...day, extra: "ignored" }, week: null } }).calendarPositions)
      .toEqual({ day, week: null });
    // 一个视图坏了不影响另一个视图。
    expect(repository.normalize({ calendarPositions: { day: { ...day, minute: 1441 }, week } }).calendarPositions)
      .toEqual({ day: null, week });
  });

  it("rejects browsing positions whose fields are not real dates, minutes or ratios", () => {
    const repository = new SettingsRepository(new MemoryBackend());
    const positions = (day: unknown) => repository.normalize({ calendarPositions: { day } }).calendarPositions.day;
    const valid = { date: "2026-08-05", minute: 720, viewportRatio: 0.5 };

    // 日期必须真实存在：只过正则不过日历的值（2 月 30 日、13 月、不补零）一律回退。
    for (const date of ["2026-02-30", "2026-13-01", "2026-8-5", "2026-08-32", "", "today", 20260805]) {
      expect(positions({ ...valid, date }), `日期 ${String(date)} 必须被拒绝`).toBeNull();
    }
    // 分钟必须 finite 且落在 0–1440（含端点），越界与 NaN／Infinity 都回退。
    for (const minute of [-1, 1440.5, Number.NaN, Number.POSITIVE_INFINITY, "720", null]) {
      expect(positions({ ...valid, minute }), `分钟 ${String(minute)} 必须被拒绝`).toBeNull();
    }
    // 比例必须 finite 且落在 0–1。
    for (const viewportRatio of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, "0.5", null]) {
      expect(positions({ ...valid, viewportRatio }), `比例 ${String(viewportRatio)} 必须被拒绝`).toBeNull();
    }
    // 缺字段、整项不是对象时同样回退，不抛错。
    for (const broken of [undefined, null, 42, "day", [], {}, { date: "2026-08-05" }]) {
      expect(positions(broken), `${JSON.stringify(broken)} 必须回退为 null`).toBeNull();
    }
    // 端点值合法。
    expect(positions({ date: "2026-08-05", minute: 0, viewportRatio: 0 })).toEqual({ date: "2026-08-05", minute: 0, viewportRatio: 0 });
    expect(positions({ date: "2026-08-05", minute: 1440, viewportRatio: 1 })).toEqual({ date: "2026-08-05", minute: 1440, viewportRatio: 1 });
  });

  it("keeps the browsing positions identical through save and reload", async () => {
    const backend = new MemoryBackend();
    const day = { date: "2026-08-05", minute: 838.75, viewportRatio: 0.5 };
    const week = { date: "2026-08-10", minute: 1140, viewportRatio: 0.25 };
    await new SettingsRepository(backend).save({ ...DEFAULT_SETTINGS, calendarPositions: { day, week } });

    await expect(new SettingsRepository(backend).load()).resolves.toMatchObject({ calendarPositions: { day, week } });
    // 非法值经一次保存也不得被写回成越界值。
    await new SettingsRepository(backend).save({ ...DEFAULT_SETTINGS, calendarPositions: { day: { ...day, minute: 9000 }, week } });
    await expect(new SettingsRepository(backend).load()).resolves.toMatchObject({ calendarPositions: { day: null, week } });
  });

  /**
   * 阶段 4 P4-08：`reviewPeriod`／`reviewAnchorDate` 现在真的被回顾页读写，因此除了
   * 规范化还要证明「保存 → 重载」恒等：翻页与切周期写进去的值必须原样回来，
   * 非法值经一次保存也不得被写回成越界值（否则页面会拿它去算周期）。
   */
  it("keeps the review period and anchor identical through save and reload", async () => {
    const repository = new SettingsRepository(new MemoryBackend());
    expect(repository.normalize(undefined)).toMatchObject({ reviewPeriod: "week", reviewAnchorDate: null });
    expect(repository.normalize({ reviewPeriod: "month", reviewAnchorDate: "2026-08-05" }))
      .toMatchObject({ reviewPeriod: "month", reviewAnchorDate: "2026-08-05" });
    // 未知周期与非法日期回退默认值；旧设置没有这两个字段时同样安全。
    for (const reviewPeriod of ["quarter", "", null, 7]) {
      expect(repository.normalize({ reviewPeriod })).toMatchObject({ reviewPeriod: "week" });
    }
    for (const reviewAnchorDate of ["2026-02-30", "2026-8-5", "today", 20260805, ""]) {
      expect(repository.normalize({ reviewAnchorDate }), `锚点 ${String(reviewAnchorDate)} 必须回退`).toMatchObject({ reviewAnchorDate: null });
    }

    const backend = new MemoryBackend();
    await new SettingsRepository(backend).save({ ...DEFAULT_SETTINGS, reviewPeriod: "day", reviewAnchorDate: "2026-08-05" });
    await expect(new SettingsRepository(backend).load()).resolves.toMatchObject({ reviewPeriod: "day", reviewAnchorDate: "2026-08-05" });
    // 「回到当前周期」写 null，重载后仍然是 null（= 跟随时钟）。
    await new SettingsRepository(backend).save({ ...DEFAULT_SETTINGS, reviewPeriod: "day", reviewAnchorDate: null });
    await expect(new SettingsRepository(backend).load()).resolves.toMatchObject({ reviewPeriod: "day", reviewAnchorDate: null });
    // 非法值经一次保存也不得被写回。
    await new SettingsRepository(backend).save({ ...DEFAULT_SETTINGS, reviewPeriod: "quarter" as never, reviewAnchorDate: "2026-02-30" });
    await expect(new SettingsRepository(backend).load()).resolves.toMatchObject({ reviewPeriod: "week", reviewAnchorDate: null });
  });

  /**
   * 阶段 4 P4-06 / 规格 §6.2：`PageId` 的合法值有三处来源 —— 类型联合、`lastPage` 的
   * 规范化白名单、`App.tsx` 的导航表。类型与白名单同源于 `PAGE_IDS`，这里逐项证明
   * 白名单真的接受每一个合法页面：只改类型不改白名单会让运行期静默回退到默认页。
   * 第三处（导航表）由 `App.test.tsx` 的「每个入口都可达且跨重启恢复」覆盖。
   */
  it("accepts every declared page id as lastPage and still migrates the legacy overview alias", async () => {
    const repository = new SettingsRepository(new MemoryBackend());
    for (const page of PAGE_IDS) {
      expect(repository.normalize({ ...DEFAULT_SETTINGS, lastPage: page })).toMatchObject({ lastPage: page });
    }
    expect(PAGE_IDS).toContain("deadlines");
    expect(repository.normalize({ ...DEFAULT_SETTINGS, lastPage: "overview" })).toMatchObject({ lastPage: "today" });
    expect(repository.normalize({ ...DEFAULT_SETTINGS, lastPage: "missing" })).toMatchObject({ lastPage: "today" });
  });
});
