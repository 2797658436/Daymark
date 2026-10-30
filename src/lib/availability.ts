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
