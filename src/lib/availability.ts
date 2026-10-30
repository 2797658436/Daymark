import type { DefaultTimeSlot } from "./settings";

/** 吸附步长：0 = 不吸附（按 1 分钟），其余为分钟步长。 */
export type AvailabilitySnap = 0 | 15 | 30 | 60;

export interface AvailabilityBlock {
  slotId: string;
  label: string;
  weekday: number;
  start: string;
  end: string;
}

/** 把多星期窗口展开成「每个生效日一段」的渲染块，按星期与开始时间排序。 */
export function availabilityBlocks(slots: DefaultTimeSlot[]): AvailabilityBlock[] {
  return slots
    .flatMap((slot) => slot.weekdays.map((weekday) => ({ slotId: slot.id, label: slot.label, weekday, start: slot.start, end: slot.end })))
    .sort((left, right) => left.weekday - right.weekday || left.start.localeCompare(right.start) || left.end.localeCompare(right.end));
}

/**
 * 在 `weekday` 的 `[start, end)` 追加一段可用窗口。
 *
 * 同段多天合并：起止与已有窗口完全相同时，把该星期并入它的 `weekdays`，而不是再存一段；
 * 否则新增一个只含该天的窗口。`end <= start` 视为无效，原样返回（调用方负责吸附后再传入）。
 */
export function addAvailability(slots: DefaultTimeSlot[], weekday: number, start: string, end: string, makeId: () => string): DefaultTimeSlot[] {
  if (end <= start) return slots;
  const match = slots.find((slot) => slot.start === start && slot.end === end);
  if (match) {
    if (match.weekdays.includes(weekday)) return slots;
    return slots.map((slot) => slot.id === match.id ? { ...slot, weekdays: [...slot.weekdays, weekday].sort((a, b) => a - b) } : slot);
  }
  return [...slots, { id: makeId(), label: "可用时间", start, end, weekdays: [weekday] }];
}

/**
 * 把 `weekday` 的窗口从 `[from.start, from.end)` 移到 `[to.start, to.end)`。
 *
 * 拖动的是「这一天的这一块」，所以多天共享的窗口要先把这个星期拆出去：
 * 原窗口保留其余日期；目标段已存在于别的窗口时并进去（同段多天合并）。
 * 只属于这一天的窗口则原地改起止，保留 id 与自定义名字。
 */
export function moveAvailability(
  slots: DefaultTimeSlot[],
  weekday: number,
  from: { start: string; end: string },
  to: { start: string; end: string },
  makeId: () => string,
): DefaultTimeSlot[] {
  if (from.start === to.start && from.end === to.end) return slots;
  if (to.end <= to.start) return slots;
  const rest = removeAvailability(slots, weekday, from.start, from.end);
  const target = rest.find((slot) => slot.start === to.start && slot.end === to.end);
  if (target) {
    return rest.map((slot) => slot.id === target.id && !slot.weekdays.includes(weekday)
      ? { ...slot, weekdays: [...slot.weekdays, weekday].sort((a, b) => a - b) }
      : slot);
  }
  const source = slots.find((slot) => slot.start === from.start && slot.end === from.end && slot.weekdays.length === 1 && slot.weekdays[0] === weekday);
  if (source) return [...rest, { ...source, start: to.start, end: to.end }];
  return addAvailability(rest, weekday, to.start, to.end, makeId);
}

/** 移除 `weekday` 在 `[start, end)` 的窗口；该窗口的 `weekdays` 清空后窗口本身删除。 */
export function removeAvailability(slots: DefaultTimeSlot[], weekday: number, start: string, end: string): DefaultTimeSlot[] {
  return slots.flatMap((slot) => {
    if (slot.start !== start || slot.end !== end) return [slot];
    const weekdays = slot.weekdays.filter((day) => day !== weekday);
    return weekdays.length ? [{ ...slot, weekdays }] : [];
  });
}

export const AVAILABILITY_PRESETS = [
  { id: "allDay", label: "全天", start: "00:00", end: "23:59" },
  { id: "common", label: "常用 08–23", start: "08:00", end: "23:00" },
  { id: "evening", label: "晚间 19–22", start: "19:00", end: "22:00" },
] as const;
export type AvailabilityPreset = (typeof AVAILABILITY_PRESETS)[number]["id"];

/** 预设 = 一条覆盖整周的窗口（每天同一段，同段多天合并后的形态）。 */
export function presetAvailability(preset: AvailabilityPreset, makeId: () => string): DefaultTimeSlot[] {
  const found = AVAILABILITY_PRESETS.find((item) => item.id === preset);
  if (!found) return [];
  return [{ id: makeId(), label: found.label, start: found.start, end: found.end, weekdays: [0, 1, 2, 3, 4, 5, 6] }];
}

/** 把 0..1440 的分钟吸附到步长；越界先夹到 [0, 1440]。 */
export function snapMinute(minute: number, snap: AvailabilitySnap): number {
  const step = snap === 0 ? 1 : snap;
  return Math.max(0, Math.min(1440, Math.round(minute / step) * step));
}

/**
 * 网格纵向走了多远，用两种重量表达：
 * `hours` = 铺开的小时数（每小时记 1），`strips` = 折起的窄带条数（每条记 1）。
 * 渲染时乘成 `calc(var(--ah) * hours + var(--band) * strips)` —— 折带的高度与小时高度
 * 是两个独立的量，靠这两个计数器分开累计，不能合成一个数。
 */
export interface AvailabilityOffset {
  hours: number;
  strips: number;
}

/** 折起的一整段：连续被隐藏的小时并成一条带子（只在布局里合并，勾选仍然是逐小时的）。 */
export interface AvailabilityFold {
  start: number;
  end: number;
}

/**
 * 把逐小时被隐藏的集合整理成「一段一段」的折带。
 *
 * 勾选列表是一小时一行、不合并；但布局上连着隐藏的 8 个小时如果各占一条 24px 的带子，
 * 就会在本来想省空间的地方反而撑出 192px —— 所以这里把相邻的小时并成**一条**带子。
 */
export function availabilityFolds(hidden: readonly number[]): AvailabilityFold[] {
  const set = new Set(hidden);
  const folds: AvailabilityFold[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    if (!set.has(hour)) continue;
    const last = folds.at(-1);
    if (last && last.end === hour) last.end = hour + 1;
    else folds.push({ start: hour, end: hour + 1 });
  }
  return folds;
}

/** 某个分钟在网格纵向上走到哪：被折起的小时压进折带，不再按小时铺开。 */
export function availabilityOffset(minute: number, hidden: readonly number[] = []): AvailabilityOffset {
  const clamped = Math.max(0, Math.min(1440, minute));
  const set = new Set(hidden);
  let hours = 0;
  for (let hour = 0; hour < 24; hour += 1) {
    const from = hour * 60;
    if (clamped <= from) break;
    if (set.has(hour)) continue;
    hours += (Math.min(clamped, from + 60) - from) / 60;
  }
  let strips = 0;
  for (const fold of availabilityFolds(hidden)) {
    const from = fold.start * 60;
    const to = fold.end * 60;
    if (clamped <= from) break;
    strips += Math.min(1, (clamped - from) / (to - from));
  }
  return { hours, strips };
}

/**
 * 两点之间的纵向差（块的 `top` 与 `height`）。
 *
 * 关键性质：块跨过折带时，差里会多出一条折带、但不出现断口 ——
 * 11:00–13:00 即使 12:00 那一小时折起来了，仍然是一整块。
 */
export function availabilitySpan(start: number, end: number, hidden: readonly number[] = []): AvailabilityOffset {
  const from = availabilityOffset(start, hidden);
  const to = availabilityOffset(end, hidden);
  return { hours: to.hours - from.hours, strips: to.strips - from.strips };
}

/** 可见的整点小时（0..23），折起的整点不出现。 */
export function availabilityVisibleHours(hidden: readonly number[] = []): number[] {
  const set = new Set(hidden);
  return Array.from({ length: 24 }, (_, hour) => hour).filter((hour) => !set.has(hour));
}

/**
 * 指针落在网格的哪个分钟：`ratio` 是 0..1 的纵向比例，`bandWeight` 是折带相对一小时的比例。
 *
 * 与 `availabilityOffset` 严格互逆（同一组重量、同一遍遍历），否则拖动的落点会跟块的画法对不上。
 */
export function availabilityMinuteAt(ratio: number, hidden: readonly number[] = [], bandWeight = 0.25): number {
  const set = new Set(hidden);
  const folds = availabilityFolds(hidden);
  const segments: Array<{ start: number; end: number; weight: number }> = [];
  for (let hour = 0; hour < 24;) {
    if (!set.has(hour)) {
      segments.push({ start: hour * 60, end: (hour + 1) * 60, weight: 1 });
      hour += 1;
      continue;
    }
    const fold = folds.find((item) => item.start === hour)!;
    segments.push({ start: fold.start * 60, end: fold.end * 60, weight: bandWeight });
    hour = fold.end;
  }
  const totalWeight = segments.reduce((sum, segment) => sum + segment.weight, 0);
  const target = Math.max(0, Math.min(1, ratio)) * totalWeight;
  let walked = 0;
  for (const segment of segments) {
    if (target <= walked + segment.weight) {
      const inside = segment.weight === 0 ? 0 : (target - walked) / segment.weight;
      return segment.start + inside * (segment.end - segment.start);
    }
    walked += segment.weight;
  }
  return 1440;
}
