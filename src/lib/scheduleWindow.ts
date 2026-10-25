/**
 * 自动排程的窗口口径。
 *
 * 没有哪一个口径在所有日子都对，所以做成可切：
 * - `next7`：今天起 7 个自然日。长度恒定、离得最近的空档先用，对「某天截止」这类约束最可靠，代价是会跨周。
 * - `thisWeek`：今天到本周日。适合「这周快过完了，把剩下的排掉」，代价是周日打开只剩一天。
 * - `nextWeek`：下周一整周。适合周末规划，代价是周一到周四打开时会漏掉本周剩下的日子。
 */
export type ScheduleWindowMode = "next7" | "thisWeek" | "nextWeek";

export interface ScheduleWindow {
  mode: ScheduleWindowMode;
  /** 界面上显示的口径名。 */
  label: string;
  /** 窗口首日（含）。 */
  startDate: string;
  /** 窗口天数；`thisWeek` 会随星期变化。 */
  days: number;
}

const LABELS: Record<ScheduleWindowMode, string> = {
  next7: "未来 7 天",
  thisWeek: "本周剩余",
  nextWeek: "下周",
};

/** 星期序号：0 = 周日 … 6 = 周六（与 `Date#getDay` 一致）。 */
function weekdayOf(date: string) {
  return new Date(`${date}T12:00:00`).getDay();
}

function addDays(date: string, amount: number) {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + amount);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function resolveScheduleWindow(mode: ScheduleWindowMode, today: string): ScheduleWindow {
  const weekday = weekdayOf(today);
  if (mode === "nextWeek") {
    // 周一当天要跳到 7 天后，否则「下周一」会算成今天。
    const daysToNextMonday = weekday === 1 ? 7 : (8 - weekday) % 7;
    return { mode, label: LABELS[mode], startDate: addDays(today, daysToNextMonday), days: 7 };
  }
  if (mode === "thisWeek") {
    const daysToSunday = (7 - weekday) % 7;
    return { mode, label: LABELS[mode], startDate: today, days: daysToSunday + 1 };
  }
  return { mode, label: LABELS[mode], startDate: today, days: 7 };
}

export function windowEndDate(window: ScheduleWindow) {
  return addDays(window.startDate, window.days - 1);
}

/** 窗口是否跨了两个自然周（`next7` 在非周一的日子会跨）。 */
export function windowSpansWeeks(window: ScheduleWindow) {
  const daysToSunday = (7 - weekdayOf(window.startDate)) % 7;
  return window.days - 1 > daysToSunday;
}
