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

/**
 * 一项排不进当前组合的**确定性原因**。界面只翻译这几种，不自己猜。
 * `continuous-unavailable` 是给「单个任务需要连续时段」预留的一位（2026-10-24 D4=a
 * 定为后续阶段）：本轮既没有字段也没有算法分支，所以**永远不会产出**它，
 * 留着是为了 schema 落地时直接接上、不用改调用方的分支。
 */
export type ScheduleUnscheduledReason =
  | "below-minimum"
  | "no-slots"
  | "no-gap-that-day"
  | "fixed-start-busy"
  | "deadline-no-gap"
  | "gaps-too-short"
  | "continuous-unavailable";

export interface ScheduleUnscheduledItem {
  key: string;
  reason: ScheduleUnscheduledReason;
  /** 该任务在当前约束下最长的一段可用空档（分钟）；与空档无关的原因记 0。 */
  longestGapMinutes: number;
}

export interface SchedulePlan {
  allocations: ScheduleAllocation[];
  /** 兼容字段：只要排不进就出现在这里，顺序与 `unscheduled` 一致。 */
  unscheduledKeys: string[];
  unscheduled: ScheduleUnscheduledItem[];
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
  const unscheduled: ScheduleUnscheduledItem[] = [];
  const ordered = [...input.items].sort((left, right) =>
    (left.deadlineLocal ?? "9999-12-31").localeCompare(right.deadlineLocal ?? "9999-12-31")
      || priorityRank(right.priority) - priorityRank(left.priority)
      || left.sortOrder - right.sortOrder
      || left.key.localeCompare(right.key));

  for (const item of ordered) {
    // D1=a（2026-10-24）：截止日期早于窗口首日的任务按**窗口首日**参与排档。
    // 否则逾期任务的 `eligible` 恒为空，等于「已逾期 = 永久不可安排」——那正好是
    // 防拖延工具最该接住的一批。只钳制参与过滤的截止值，排序口径仍用原始截止日期。
    const deadline = item.deadlineLocal && item.deadlineLocal < input.startDate ? input.startDate : item.deadlineLocal;
    if (item.targetMinutes < input.minimumMinutes) {
      unscheduledKeys.push(item.key);
      unscheduled.push({ key: item.key, reason: "below-minimum", longestGapMinutes: 0 });
      continue;
    }
    const fixedStart = item.fixedStartLocal ? timeToMinutes(item.fixedStartLocal) : null;
    const eligible = gaps
      .map((gap, index) => ({ gap, index, start: fixedStart === null ? gap.start : Math.max(gap.start, fixedStart) }))
      .filter(({ gap, start }) => (!item.fixedDate || gap.date === item.fixedDate)
        && (!deadline || gap.date <= deadline)
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
      unscheduled.push(explainUnscheduled(item, { deadline, fixedStart, gaps }));
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

  return { allocations, unscheduledKeys, unscheduled, availableMinutes, usedMinutes: allocations.reduce((sum, allocation) => sum + allocation.minutes, 0) };
}

/**
 * 把「排不进」翻译成一个确定性原因。
 *
 * 判定顺序刻意与上面那段过滤条件一一对应：先排除与空档无关的原因（时长、没有空档、
 * 固定日期没有空档），再按固定开始时间／截止日期收窄，最后才是「空档都太短」。
 * 走到最后一条分支时 `eligible` 必然为空但空档确实存在，所以唯一诚实的说法是空档不够长。
 */
function explainUnscheduled(item: ScheduleItem, context: {
  deadline: string | null;
  fixedStart: number | null;
  gaps: Gap[];
}): ScheduleUnscheduledItem {
  const { deadline, fixedStart, gaps } = context;
  if (!gaps.length) return { key: item.key, reason: "no-slots", longestGapMinutes: 0 };
  const dayGaps = item.fixedDate ? gaps.filter((gap) => gap.date === item.fixedDate) : gaps;
  if (!dayGaps.length) return { key: item.key, reason: "no-gap-that-day", longestGapMinutes: 0 };
  const deadlineGaps = deadline ? dayGaps.filter((gap) => gap.date <= deadline) : dayGaps;
  if (!deadlineGaps.length) return { key: item.key, reason: "deadline-no-gap", longestGapMinutes: 0 };
  if (fixedStart === null) {
    return { key: item.key, reason: "gaps-too-short", longestGapMinutes: Math.max(...deadlineGaps.map((gap) => gap.end - gap.start)) };
  }
  const around = deadlineGaps.filter((gap) => gap.start <= fixedStart && gap.end > fixedStart);
  if (!around.length) return { key: item.key, reason: "fixed-start-busy", longestGapMinutes: 0 };
  // 走到这里说明上面那段过滤同样没选中任何空档，而固定开始时间确实落在一段空档里 ——
  // 唯一还成立的原因就是这段空档短于最低有效时长。
  return { key: item.key, reason: "gaps-too-short", longestGapMinutes: Math.max(...around.map((gap) => gap.end - Math.max(gap.start, fixedStart))) };
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
