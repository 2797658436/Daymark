import type { CalendarDayMode, DefaultTimeSlot } from "./settings";

export const COLLAPSED_GAP_HEIGHT = 44;

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

export function createCalendarTimeline({ mode, slots, expandedGapKeys, currentMinute, revealedRanges = [], pixelsPerHour }: {
  mode: CalendarDayMode;
  slots: Array<Pick<DefaultTimeSlot, "start" | "end">>;
  expandedGapKeys: ReadonlySet<string>;
  currentMinute: number | null;
  revealedRanges?: TimelineRange[];
  pixelsPerHour: number;
}): CalendarTimeline {
  const defaultRanges = mode === "fullDay" ? [{ start: 0, end: 1440 }] : mergeRanges(slots.flatMap(slotRanges));
  const gaps = complement(defaultRanges).map((range) => ({ ...range, key: `${range.start}-${range.end}` }));
  const currentRange = currentMinute === null ? [] : [{ start: Math.max(0, currentMinute - 60), end: Math.min(1440, currentMinute + 60) }];
  const temporaryRanges = [...expandedGapKeys].flatMap((key) => {
    const range = timelineRangeFromKey(key);
    return range && gaps.some((gap) => range.start >= gap.start && range.end <= gap.end) ? [range] : [];
  });
  const expandedRanges = mode === "fullDay" ? defaultRanges : mergeRanges([
    ...defaultRanges,
    ...temporaryRanges,
    ...currentRange,
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
    const height = segment.collapsed ? COLLAPSED_GAP_HEIGHT : (segment.end - segment.start) / 60 * pixelsPerHour;
    const positioned = { ...segment, top, height };
    top += height;
    return positioned;
  });

  const offsetAtMinute = (value: number) => {
    const minute = Math.max(0, Math.min(1440, value));
    const segment = segments.find((item) => minute >= item.start && minute <= item.end) ?? segments.at(-1)!;
    if (minute === 1440) return top;
    return segment.top + (minute - segment.start) / Math.max(1, segment.end - segment.start) * segment.height;
  };
  const minuteAtOffset = (value: number) => {
    const offset = Math.max(0, Math.min(top, value));
    const segment = segments.find((item) => offset >= item.top && offset <= item.top + item.height) ?? segments.at(-1)!;
    return segment.start + (offset - segment.top) / Math.max(1, segment.height) * (segment.end - segment.start);
  };
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

function clockMinutes(value: string) {
  if (value === "24:00") return 1440;
  const [hours, minutes] = value.split(":").map(Number);
  return Math.max(0, Math.min(1440, hours * 60 + minutes));
}
