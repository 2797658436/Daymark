import type { DefaultTimeSlot } from "./settings";

export interface ScheduleItem {
  key: string;
  taskId: string;
  title: string;
  targetMinutes: number;
  deadlineLocal: string | null;
  priority: "low" | "normal" | "high";
  sortOrder: number;
  fixedDate?: string;
  fixedStartLocal?: string;
  habitId?: string;
}

export interface BusyInterval {
  localDate: string;
  endLocalDate: string;
  startLocal: string;
  endLocal: string;
}

export interface ScheduleAllocation {
  key: string;
  taskId: string;
  title: string;
  localDate: string;
  startLocal: string;
  endLocal: string;
  minutes: number;
  targetMinutes: number;
  habitId?: string;
}

export interface SchedulePlan {
  allocations: ScheduleAllocation[];
  unscheduledKeys: string[];
  availableMinutes: number;
  usedMinutes: number;
}

interface Gap { date: string; start: number; end: number }

export function buildSchedulePlan(input: {
  startDate: string;
  days: number;
  items: ScheduleItem[];
  defaultTimeSlots: DefaultTimeSlot[];
  busy: BusyInterval[];
  minimumMinutes: number;
}): SchedulePlan {
  const gaps = buildGaps(input.startDate, input.days, input.defaultTimeSlots, input.busy);
  const availableMinutes = gaps.reduce((sum, gap) => sum + (gap.end - gap.start >= input.minimumMinutes ? gap.end - gap.start : 0), 0);
  const allocations: ScheduleAllocation[] = [];
  const unscheduledKeys: string[] = [];
  const ordered = [...input.items].sort((left, right) =>
    (left.deadlineLocal ?? "9999-12-31").localeCompare(right.deadlineLocal ?? "9999-12-31")
      || priorityRank(right.priority) - priorityRank(left.priority)
      || left.sortOrder - right.sortOrder
      || left.key.localeCompare(right.key));

  for (const item of ordered) {
    if (item.targetMinutes < input.minimumMinutes) {
      unscheduledKeys.push(item.key);
      continue;
    }
    const fixedStart = item.fixedStartLocal ? timeToMinutes(item.fixedStartLocal) : null;
    const eligible = gaps
      .map((gap, index) => ({ gap, index, start: fixedStart === null ? gap.start : Math.max(gap.start, fixedStart) }))
      .filter(({ gap, start }) => (!item.fixedDate || gap.date === item.fixedDate)
        && (!item.deadlineLocal || gap.date <= item.deadlineLocal)
        && (fixedStart === null || (gap.start <= fixedStart && gap.end > fixedStart))
        && gap.end - start >= input.minimumMinutes);
    const full = item.targetMinutes >= input.minimumMinutes
      ? eligible.find(({ gap, start }) => gap.end - start >= item.targetMinutes)
      : undefined;
    const partial = [...eligible]
      .filter(({ gap, start }) => gap.end - start >= input.minimumMinutes)
      .sort((left, right) => (right.gap.end - right.start) - (left.gap.end - left.start) || left.gap.date.localeCompare(right.gap.date) || left.start - right.start)[0];
    const selected = full ?? partial;
    if (!selected) {
      unscheduledKeys.push(item.key);
      continue;
    }
    const minutes = Math.min(item.targetMinutes, selected.gap.end - selected.start);
    const start = selected.start;
    const end = start + minutes;
    const remaining: Gap[] = [];
    if (selected.gap.start < start) remaining.push({ ...selected.gap, end: start });
    if (end < selected.gap.end) remaining.push({ ...selected.gap, start: end });
    gaps.splice(selected.index, 1, ...remaining);
    allocations.push({
      key: item.key,
      taskId: item.taskId,
      title: item.title,
      localDate: selected.gap.date,
      startLocal: minutesToTime(start),
      endLocal: minutesToTime(end),
      minutes,
      targetMinutes: item.targetMinutes,
      habitId: item.habitId,
    });
  }

  return { allocations, unscheduledKeys, availableMinutes, usedMinutes: allocations.reduce((sum, allocation) => sum + allocation.minutes, 0) };
}

function priorityRank(priority: ScheduleItem["priority"]) {
  return priority === "high" ? 2 : priority === "normal" ? 1 : 0;
}

function buildGaps(startDate: string, days: number, slots: DefaultTimeSlot[], busy: BusyInterval[]): Gap[] {
  const result: Gap[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDays(startDate, offset);
    const weekday = new Date(`${date}T12:00:00`).getDay();
    const occupied = busy.flatMap((interval) => intervalOnDate(interval, date)).sort((a, b) => a.start - b.start);
    const ranges = mergeRanges(slots.filter((value) => value.weekdays.includes(weekday))
      .map((slot) => ({ start: timeToMinutes(slot.start), end: timeToMinutes(slot.end) }))
      .filter((range) => range.end > range.start));
    for (const range of ranges) {
      let pieces = [range];
      for (const collision of occupied) {
        pieces = pieces.flatMap((piece) => subtract(piece, collision));
      }
      result.push(...pieces.filter((piece) => piece.end > piece.start).map((piece) => ({ date, ...piece })));
    }
  }
  return result.sort((left, right) => left.date.localeCompare(right.date) || left.start - right.start);
}

function mergeRanges(ranges: Array<{ start: number; end: number }>) {
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function intervalOnDate(interval: BusyInterval, date: string) {
  if (date < interval.localDate || date > interval.endLocalDate) return [];
  const start = date === interval.localDate ? timeToMinutes(interval.startLocal) : 0;
  const end = date === interval.endLocalDate ? timeToMinutes(interval.endLocal) : 1440;
  return end > start ? [{ start, end }] : [];
}

function subtract(source: { start: number; end: number }, collision: { start: number; end: number }) {
  if (collision.end <= source.start || collision.start >= source.end) return [source];
  const result: Array<{ start: number; end: number }> = [];
  if (collision.start > source.start) result.push({ start: source.start, end: collision.start });
  if (collision.end < source.end) result.push({ start: collision.end, end: source.end });
  return result;
}

function timeToMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(value: number) {
  const safe = Math.max(0, Math.min(1440, value));
  if (safe === 1440) return "00:00";
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function addDays(date: string, amount: number) {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + amount);
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 10);
}
