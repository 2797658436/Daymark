import type { CalendarDayMode, DefaultTimeSlot } from "./settings";

/**
 * 折叠条在 100% 界面缩放下的基准高度。
 *
 * A6 起由 `preferences.scale` 推出唯一来源（`collapsedGapHeight`），CSS 与映射共用
 * 同一个像素值；不再追求 rem 纯度 —— 44px 与 2.75rem 在 200% 下会分叉成 44 与 88。
 */
export const COLLAPSED_GAP_HEIGHT = 44;

export function collapsedGapHeight(scale: number) {
  return Math.round(COLLAPSED_GAP_HEIGHT * scale / 100);
}

/**
 * 全天模式的「有效日」折叠边界：凌晨与深夜。只有该段完全没有安排／时间块／记录、
 * 当前时间也不在其中时才折成 44px 带；用户仍可通过折叠条或「展开整天」临时展开。
 */
export const FULL_DAY_FOLD_RANGES = [
  { start: 0, end: 360, key: "0-360" },
  { start: 1380, end: 1440, key: "1380-1440" },
] as const;

export interface TimelineRange {
  start: number;
  end: number;
}

export interface TimelineGap extends TimelineRange {
  key: string;
}

export interface TimelineSegment extends TimelineRange {
  collapsed: boolean;
  gapKey: string | null;
  top: number;
  height: number;
}

export interface CalendarTimeline {
  totalHeight: number;
  gaps: TimelineGap[];
  segments: TimelineSegment[];
  offsetAtMinute: (minute: number) => number;
  minuteAtOffset: (offset: number) => number;
  positionForRange: (start: string, end: string) => { top: string; height: string } | null;
}

export function defaultSlotSlicesForWeekday(slots: DefaultTimeSlot[], weekday: number): DefaultTimeSlot[] {
  const previousWeekday = (weekday + 6) % 7;
  return slots.flatMap((slot) => {
    const start = clockMinutes(slot.start); const end = clockMinutes(slot.end);
    if (end > start) return slot.weekdays.includes(weekday) ? [{ ...slot, weekdays: [...slot.weekdays] }] : [];
    if (end === start) return [];
    const slices: DefaultTimeSlot[] = [];
    if (slot.weekdays.includes(weekday)) slices.push({ ...slot, id: `${slot.id}:late`, end: "24:00", weekdays: [...slot.weekdays] });
    if (slot.weekdays.includes(previousWeekday)) slices.push({ ...slot, id: `${slot.id}:early`, start: "00:00", weekdays: [...slot.weekdays] });
    return slices;
  });
}

export function timelineRangeFromKey(key: string): TimelineRange | null {
  const match = /^(\d+)-(\d+)$/.exec(key); if (!match) return null;
  const start = Number(match[1]); const end = Number(match[2]);
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= 1440 && end > start ? { start, end } : null;
}

/**
 * 折叠时间轴的分钟 → 轨道内像素。
 *
 * `createCalendarTimeline` 的 `offsetAtMinute` 与它同源：M9 的浏览位置恢复必须用同一套换算，
 * 不能在滚动代码里再写一份。折叠分段也按同一公式内插（折叠段的 `height` 就是压缩后的高度）。
 */
export function segmentOffsetAtMinute(segments: TimelineSegment[], totalHeight: number, minute: number): number {
  const value = Math.max(0, Math.min(1440, minute));
  const segment = segments.find((item) => value >= item.start && value <= item.end) ?? segments.at(-1)!;
  if (value === 1440) return totalHeight;
  return segment.top + (value - segment.start) / Math.max(1, segment.end - segment.start) * segment.height;
}

/** 轨道内像素 → 分钟，与 `minuteAtOffset` 同源。 */
export function segmentMinuteAtOffset(segments: TimelineSegment[], totalHeight: number, offset: number): number {
  const value = Math.max(0, Math.min(totalHeight, offset));
  const segment = segments.find((item) => value >= item.top && value <= item.top + item.height) ?? segments.at(-1)!;
  return segment.start + (value - segment.top) / Math.max(1, segment.height) * (segment.end - segment.start);
}

/** `HH:MM`（含 `24:00`）→ 分钟，0–1440。 */
export function clockMinutes(value: string) {
  if (value === "24:00") return 1440;
  const [hours, minutes] = value.split(":").map(Number);
  return Math.max(0, Math.min(1440, hours * 60 + minutes));
}

/** 全天模式的有效日：把没有内容、当前时间也不在其中的凌晨／深夜从 24 小时里减掉。 */
export function fullDayEffectiveRanges({ occupiedRanges, currentMinute }: {
  occupiedRanges: TimelineRange[];
  currentMinute: number | null;
}): TimelineRange[] {
  let ranges: TimelineRange[] = [{ start: 0, end: 1440 }];
  for (const fold of FULL_DAY_FOLD_RANGES) {
    const occupied = occupiedRanges.some((range) => range.start < fold.end && range.end > fold.start);
    const nowInside = currentMinute !== null && currentMinute >= fold.start && currentMinute < fold.end;
    if (occupied || nowInside) continue;
    ranges = ranges.flatMap((range) => subtractRange(range, fold));
  }
  return ranges;
}

function subtractRange(range: TimelineRange, cut: TimelineRange): TimelineRange[] {
  if (cut.end <= range.start || cut.start >= range.end) return [range];
  const pieces: TimelineRange[] = [];
  if (range.start < cut.start) pieces.push({ start: range.start, end: cut.start });
  if (cut.end < range.end) pieces.push({ start: cut.end, end: range.end });
  return pieces;
}

export function createCalendarTimeline({ mode, slots, expandedGapKeys, currentMinute, revealedRanges = [], fullDayRanges, pixelsPerHour, collapsedGapPx = COLLAPSED_GAP_HEIGHT }: {
  mode: CalendarDayMode;
  slots: Array<Pick<DefaultTimeSlot, "start" | "end">>;
  expandedGapKeys: ReadonlySet<string>;
  currentMinute: number | null;
  revealedRanges?: TimelineRange[];
  /** 全天模式的有效日范围；缺省为完整 24 小时。默认时段模式不读取它。 */
  fullDayRanges?: TimelineRange[];
  pixelsPerHour: number;
  /** 折叠条高度；由界面缩放推出的单一来源，缺省 = 100% 的 44px。 */
  collapsedGapPx?: number;
}): CalendarTimeline {
  const defaultRanges = mode === "fullDay" ? (fullDayRanges ?? [{ start: 0, end: 1440 }]) : mergeRanges(slots.flatMap(slotRanges));
  const gaps = complement(defaultRanges).map((range) => ({ ...range, key: `${range.start}-${range.end}` }));
  const currentRange = currentMinute === null ? [] : [{ start: Math.max(0, currentMinute - 60), end: Math.min(1440, currentMinute + 60) }];
  const temporaryRanges = [...expandedGapKeys].flatMap((key) => {
    const range = timelineRangeFromKey(key);
    return range && gaps.some((gap) => range.start >= gap.start && range.end <= gap.end) ? [range] : [];
  });
  const expandedRanges = mergeRanges([
    ...defaultRanges,
    ...temporaryRanges,
    ...(mode === "defaultSlots" ? currentRange : []),
    ...revealedRanges,
  ]);
  const rawSegments: Array<Omit<TimelineSegment, "top" | "height">> = [];
  let cursor = 0;
  for (const range of expandedRanges) {
    if (range.start > cursor) rawSegments.push({ start: cursor, end: range.start, collapsed: true, gapKey: gapContaining(gaps, cursor) ? `${cursor}-${range.start}` : null });
    if (range.end > range.start) rawSegments.push({ start: range.start, end: range.end, collapsed: false, gapKey: gapContaining(gaps, (range.start + range.end) / 2)?.key ?? null });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < 1440) rawSegments.push({ start: cursor, end: 1440, collapsed: true, gapKey: gapContaining(gaps, cursor) ? `${cursor}-1440` : null });
  if (rawSegments.length === 0) rawSegments.push({ start: 0, end: 1440, collapsed: true, gapKey: gaps[0]?.key ?? "0-1440" });

  let top = 0;
  const segments = rawSegments.map((segment) => {
    const height = segment.collapsed ? collapsedGapPx : (segment.end - segment.start) / 60 * pixelsPerHour;
    const positioned = { ...segment, top, height };
    top += height;
    return positioned;
  });

  const offsetAtMinute = (value: number) => segmentOffsetAtMinute(segments, top, value);
  const minuteAtOffset = (value: number) => segmentMinuteAtOffset(segments, top, value);
  const positionForRange = (start: string, end: string) => {
    const startMinute = clockMinutes(start); let endMinute = clockMinutes(end);
    if (endMinute <= startMinute) endMinute = 1440;
    const overlapping = segments.filter((segment) => segment.start < endMinute && segment.end > startMinute);
    if (overlapping.length === 0 || overlapping.some((segment) => segment.collapsed)) return null;
    return { top: `${offsetAtMinute(startMinute)}px`, height: `${Math.max(offsetAtMinute(endMinute) - offsetAtMinute(startMinute), 1)}px` };
  };

  return { totalHeight: top, gaps, segments, offsetAtMinute, minuteAtOffset, positionForRange };
}

function slotRanges(slot: Pick<DefaultTimeSlot, "start" | "end">): TimelineRange[] {
  const start = clockMinutes(slot.start); const end = clockMinutes(slot.end);
  if (end > start) return [{ start, end }];
  if (end === start) return [];
  return [{ start, end: 1440 }, { start: 0, end }];
}

function mergeRanges(ranges: TimelineRange[]) {
  const ordered = ranges.filter((range) => range.end > range.start).sort((a, b) => a.start - b.start);
  const merged: TimelineRange[] = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function complement(ranges: TimelineRange[]) {
  const gaps: TimelineRange[] = []; let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) gaps.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < 1440) gaps.push({ start: cursor, end: 1440 });
  return gaps;
}

function gapContaining(gaps: TimelineGap[], minute: number) {
  return gaps.find((gap) => minute >= gap.start && minute < gap.end);
}
