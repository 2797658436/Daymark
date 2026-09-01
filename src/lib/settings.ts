import { load, type Store } from "@tauri-apps/plugin-store";

export type AppearanceMode = "system" | "light" | "dark";
export type MotionMode = "system" | "reduce" | "full";
export type PageId = "today" | "calendar" | "projects" | "review" | "data" | "appearance";
export type CalendarView = "day" | "week" | "month";
export type CalendarAnchors = Record<CalendarView, string | null>;
export type CalendarZoom = "compact" | "standard" | "detailed";
export type CalendarZoomByView = Record<CalendarView, CalendarZoom>;
export type CalendarScaleByView = Record<CalendarView, number>;
export type CalendarDayMode = "defaultSlots" | "fullDay";
export type StartupSummaryMode = "everyLaunch" | "daily" | "never";
export interface DefaultTimeSlot { id: string; label: string; start: string; end: string; weekdays: number[] }

export interface AppSettings {
  appearance: AppearanceMode;
  motion: MotionMode;
  scale: number;
  lastPage: PageId;
  calendarView: CalendarView;
  calendarAnchors: CalendarAnchors;
  calendarZoom: CalendarZoomByView;
  calendarScale: CalendarScaleByView;
  calendarDayMode: CalendarDayMode;
  showActualRecords: boolean;
  showActualRecordsControl: boolean;
  snapMinutes: "off" | 15 | 30 | 60;
  defaultSessionMinutes: number;
  minimumSessionMinutes: 5 | 10 | 15 | 20 | 30;
  autoScheduleAssist: boolean;
  checkInEnabled: boolean;
  checkInGraceMinutes: 3 | 5 | 10 | 15;
  rescuePromptsEnabled: boolean;
  remindersEnabled: boolean;
  reminderLeadMinutes: number;
  startupSummary: StartupSummaryMode;
  lastStartupSummaryLocalDate: string | null;
  defaultTimeSlots: DefaultTimeSlot[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  appearance: "system",
  motion: "system",
  scale: 100,
  lastPage: "today",
  calendarView: "week",
  calendarAnchors: { day: null, week: null, month: null },
  calendarZoom: { day: "standard", week: "standard", month: "standard" },
  calendarScale: { day: 72, week: 72, month: 120 },
  calendarDayMode: "fullDay",
  showActualRecords: false,
  showActualRecordsControl: true,
  snapMinutes: 15,
  defaultSessionMinutes: 60,
  minimumSessionMinutes: 15,
  autoScheduleAssist: false,
  checkInEnabled: false,
  checkInGraceMinutes: 5,
  rescuePromptsEnabled: true,
  remindersEnabled: false,
  reminderLeadMinutes: 10,
  startupSummary: "never",
  lastStartupSummaryLocalDate: null,
  defaultTimeSlots: [{ id: "evening", label: "晚间专注", start: "19:00", end: "22:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }],
};

export interface SettingsBackend {
  read(): Promise<unknown>;
  write(settings: unknown): Promise<void>;
}

export class SettingsRepository {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly backend: SettingsBackend) {}

  async load(): Promise<AppSettings> {
    return normalizeSettings(await this.backend.read());
  }

  save(settings: AppSettings): Promise<void> {
    const normalized = normalizeSettings(settings);
    const operation = this.writeQueue
      .catch(() => undefined)
      .then(() => this.backend.write(normalized));
    this.writeQueue = operation;
    return operation;
  }

  normalize(value: unknown): AppSettings {
    return normalizeSettings(value);
  }
}

class TauriStoreBackend implements SettingsBackend {
  private storePromise?: Promise<Store>;

  private store() {
    this.storePromise ??= load("settings.json", { autoSave: false });
    return this.storePromise;
  }

  async read() {
    return (await this.store()).get<unknown>("preferences");
  }

  async write(settings: unknown) {
    const store = await this.store();
    await store.set("preferences", settings);
    await store.save();
  }
}

class BrowserSettingsBackend implements SettingsBackend {
  read() {
    const raw = localStorage.getItem("daymark.phase0.preferences");
    return Promise.resolve(raw ? JSON.parse(raw) : undefined);
  }

  write(settings: unknown) {
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify(settings));
    return Promise.resolve();
  }
}

export function createSettingsRepository() {
  const backend = "__TAURI_INTERNALS__" in window ? new TauriStoreBackend() : new BrowserSettingsBackend();
  return new SettingsRepository(backend);
}

function normalizeSettings(value: unknown): AppSettings {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_SETTINGS };
  }
  const candidate = value as Partial<AppSettings>;
  const calendarZoom = normalizeCalendarZoom(candidate.calendarZoom);
  return {
    appearance: isOneOf(candidate.appearance, ["system", "light", "dark"]) ? candidate.appearance : DEFAULT_SETTINGS.appearance,
    motion: isOneOf(candidate.motion, ["system", "reduce", "full"]) ? candidate.motion : DEFAULT_SETTINGS.motion,
    scale: typeof candidate.scale === "number" && candidate.scale >= 100 && candidate.scale <= 200 ? candidate.scale : DEFAULT_SETTINGS.scale,
    lastPage: candidate.lastPage === ("overview" as PageId) ? "today" : isOneOf(candidate.lastPage, ["today", "calendar", "projects", "review", "data", "appearance"]) ? candidate.lastPage : DEFAULT_SETTINGS.lastPage,
    calendarView: isOneOf(candidate.calendarView, ["day", "week", "month"]) ? candidate.calendarView : DEFAULT_SETTINGS.calendarView,
    calendarAnchors: normalizeCalendarAnchors(candidate.calendarAnchors),
    calendarZoom,
    calendarScale: normalizeCalendarScale(candidate.calendarScale, calendarZoom),
    calendarDayMode: isOneOf(candidate.calendarDayMode, ["defaultSlots", "fullDay"] as const) ? candidate.calendarDayMode : DEFAULT_SETTINGS.calendarDayMode,
    showActualRecords: typeof candidate.showActualRecords === "boolean" ? candidate.showActualRecords : DEFAULT_SETTINGS.showActualRecords,
    showActualRecordsControl: typeof candidate.showActualRecordsControl === "boolean" ? candidate.showActualRecordsControl : DEFAULT_SETTINGS.showActualRecordsControl,
    snapMinutes: isOneOf(candidate.snapMinutes, ["off", 15, 30, 60] as const) ? candidate.snapMinutes : DEFAULT_SETTINGS.snapMinutes,
    defaultSessionMinutes: typeof candidate.defaultSessionMinutes === "number" && Number.isInteger(candidate.defaultSessionMinutes) && candidate.defaultSessionMinutes >= 5 && candidate.defaultSessionMinutes <= 240 ? candidate.defaultSessionMinutes : DEFAULT_SETTINGS.defaultSessionMinutes,
    minimumSessionMinutes: isOneOf(candidate.minimumSessionMinutes, [5, 10, 15, 20, 30] as const) ? candidate.minimumSessionMinutes : DEFAULT_SETTINGS.minimumSessionMinutes,
    autoScheduleAssist: typeof candidate.autoScheduleAssist === "boolean" ? candidate.autoScheduleAssist : DEFAULT_SETTINGS.autoScheduleAssist,
    checkInEnabled: typeof candidate.checkInEnabled === "boolean" ? candidate.checkInEnabled : DEFAULT_SETTINGS.checkInEnabled,
    checkInGraceMinutes: isOneOf(candidate.checkInGraceMinutes, [3, 5, 10, 15] as const) ? candidate.checkInGraceMinutes : DEFAULT_SETTINGS.checkInGraceMinutes,
    rescuePromptsEnabled: typeof candidate.rescuePromptsEnabled === "boolean" ? candidate.rescuePromptsEnabled : DEFAULT_SETTINGS.rescuePromptsEnabled,
    remindersEnabled: typeof candidate.remindersEnabled === "boolean" ? candidate.remindersEnabled : DEFAULT_SETTINGS.remindersEnabled,
    reminderLeadMinutes: typeof candidate.reminderLeadMinutes === "number" && candidate.reminderLeadMinutes >= 0 && candidate.reminderLeadMinutes <= 120 ? candidate.reminderLeadMinutes : DEFAULT_SETTINGS.reminderLeadMinutes,
    startupSummary: isOneOf(candidate.startupSummary, ["everyLaunch", "daily", "never"]) ? candidate.startupSummary : DEFAULT_SETTINGS.startupSummary,
    lastStartupSummaryLocalDate: typeof candidate.lastStartupSummaryLocalDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(candidate.lastStartupSummaryLocalDate) ? candidate.lastStartupSummaryLocalDate : null,
    defaultTimeSlots: normalizeTimeSlots(candidate.defaultTimeSlots),
  };
}

function normalizeCalendarAnchors(value: unknown): CalendarAnchors {
  const candidate = value && typeof value === "object" ? value as Partial<CalendarAnchors> : {};
  const valid = (date: unknown) => isLocalDate(date) ? date : null;
  return { day: valid(candidate.day), week: valid(candidate.week), month: valid(candidate.month) };
}

function normalizeCalendarZoom(value: unknown): CalendarZoomByView {
  const candidate = value && typeof value === "object" ? value as Partial<CalendarZoomByView> : {};
  const valid = (zoom: unknown): CalendarZoom => isOneOf(zoom, ["compact", "standard", "detailed"] as const) ? zoom : "standard";
  return { day: valid(candidate.day), week: valid(candidate.week), month: valid(candidate.month) };
}

function normalizeCalendarScale(value: unknown, zoom: CalendarZoomByView): CalendarScaleByView {
  const candidate = value && typeof value === "object" ? value as Partial<CalendarScaleByView> : {};
  const valid = (view: CalendarView, scale: unknown) => {
    const [minimum, maximum] = view === "month" ? [52, 132] : [28, 96];
    return typeof scale === "number" && Number.isFinite(scale) && scale >= minimum && scale <= maximum
      ? Math.round(scale)
      : calendarScaleForZoom(view, zoom[view]);
  };
  return { day: valid("day", candidate.day), week: valid("week", candidate.week), month: valid("month", candidate.month) };
}

export function calendarScaleForZoom(view: CalendarView, zoom: CalendarZoom) {
  if (view === "month") return zoom === "compact" ? 80 : zoom === "detailed" ? 160 : 120;
  return zoom === "compact" ? 48 : zoom === "detailed" ? 96 : 72;
}

function isLocalDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number); const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function normalizeTimeSlots(value: unknown): DefaultTimeSlot[] {
  if (!Array.isArray(value)) return DEFAULT_SETTINGS.defaultTimeSlots.map((slot) => ({ ...slot, weekdays: [...slot.weekdays] }));
  if (value.length === 0) return [];
  const valid = value.filter((slot): slot is DefaultTimeSlot => Boolean(slot && typeof slot === "object" && typeof slot.id === "string" && typeof slot.label === "string" && /^\d{2}:\d{2}$/.test(slot.start) && /^\d{2}:\d{2}$/.test(slot.end) && Array.isArray(slot.weekdays)));
  return valid.length ? valid.map((slot) => ({ ...slot, weekdays: slot.weekdays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6) })) : DEFAULT_SETTINGS.defaultTimeSlots.map((slot) => ({ ...slot, weekdays: [...slot.weekdays] }));
}

function isOneOf<T>(value: unknown, options: readonly T[]): value is T {
  return options.includes(value as T);
}
