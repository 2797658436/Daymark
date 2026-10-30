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
 * 一天按用途切成的 7 段：网格左侧「显示时段」下拉与折叠条共用这一份定义。
 *
 * 分组不求语义精确（没有统一的「中午」边界），只求**每段都短到值得折起、长到不至于折成碎渣**：
 * 每段 2–6 小时，24 小时恰好铺满、不重叠。
 */
export const AVAILABILITY_BANDS = [
  { id: "dawn", label: "凌晨", start: 0, end: 6 },
  { id: "morning", label: "早上", start: 6, end: 9 },
  { id: "forenoon", label: "上午", start: 9, end: 12 },
  { id: "noon", label: "中午", start: 12, end: 14 },
  { id: "afternoon", label: "下午", start: 14, end: 18 },
  { id: "evening", label: "晚间", start: 18, end: 22 },
  { id: "late", label: "深夜", start: 22, end: 24 },
] as const;

export type AvailabilityBandId = (typeof AVAILABILITY_BANDS)[number]["id"];

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

/** 某个分钟在网格纵向上走到哪：被折起的时段压成一条窄带，不再按小时铺开。 */
export function availabilityOffset(minute: number, hidden: readonly AvailabilityBandId[] = []): AvailabilityOffset {
  const clamped = Math.max(0, Math.min(1440, minute));
  let hours = 0;
  let strips = 0;
  for (const band of AVAILABILITY_BANDS) {
    const from = band.start * 60;
    const to = band.end * 60;
    if (clamped <= from) break;
    const walked = Math.min(clamped, to) - from;
    if (hidden.includes(band.id)) strips += walked / (to - from);
    else hours += walked / 60;
  }
  return { hours, strips };
}

/**
 * 两点之间的纵向差（块的 `top` 与 `height`）。
 *
 * 关键性质：块跨过一个被折起的时段时，差里会多出一条折带、但不出现断口 ——
 * 11:00–13:00 即使 12:00 所在的「中午」折起来了，仍然是一整块。
 */
export function availabilitySpan(start: number, end: number, hidden: readonly AvailabilityBandId[] = []): AvailabilityOffset {
  const from = availabilityOffset(start, hidden);
  const to = availabilityOffset(end, hidden);
  return { hours: to.hours - from.hours, strips: to.strips - from.strips };
}

/** 可见的整点小时（0..23），折起的时段整段不出现。 */
export function availabilityVisibleHours(hidden: readonly AvailabilityBandId[] = []): number[] {
  return AVAILABILITY_BANDS.filter((band) => !hidden.includes(band.id))
    .flatMap((band) => Array.from({ length: band.end - band.start }, (_, index) => band.start + index));
}

/** 折起的时段，按时间顺序；渲染成轨道上的一条窄带。 */
export function availabilityFoldBands(hidden: readonly AvailabilityBandId[] = []) {
  return AVAILABILITY_BANDS.filter((band) => hidden.includes(band.id));
}

/**
 * 指针落在网格的哪个分钟：`ratio` 是 0..1 的纵向比例，`bandWeight` 是折带相对一小时的比例。
 *
 * 与 `availabilityOffset` 严格互逆（同一组重量、同一遍遍历），否则拖动的落点会跟块的画法对不上。
 */
export function availabilityMinuteAt(ratio: number, hidden: readonly AvailabilityBandId[] = [], bandWeight = 0.25): number {
  const totalWeight = AVAILABILITY_BANDS.reduce((sum, band) => sum + (hidden.includes(band.id) ? bandWeight : band.end - band.start), 0);
  const target = Math.max(0, Math.min(1, ratio)) * totalWeight;
  let walked = 0;
  for (const band of AVAILABILITY_BANDS) {
    const weight = hidden.includes(band.id) ? bandWeight : band.end - band.start;
    if (target <= walked + weight) {
      const inside = weight === 0 ? 0 : (target - walked) / weight;
      return (band.start + inside * (band.end - band.start)) * 60;
    }
    walked += weight;
  }
  return 1440;
}
