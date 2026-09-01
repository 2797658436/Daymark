import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, SettingsRepository, type SettingsBackend } from "./settings";

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
    const first = repository.save({ ...DEFAULT_SETTINGS, appearance: "dark" });
    const second = repository.save({ ...DEFAULT_SETTINGS, appearance: "light" });
    await Promise.all([first, second]);

    expect(backend.value).toMatchObject({ appearance: "light" });
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
});
