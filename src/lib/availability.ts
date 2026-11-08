import type { DefaultTimeSlot, FoldedRange } from "./settings";

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

/**
 * 折叠段的默认值：凌晨与深夜各折一段。
 *
 * 定义在纯函数层，`DEFAULT_SETTINGS.foldedRanges` 直接引用它 —— 设置层再拿一份字面量就会
 * 出现「界面显示默认两段、规范化却回退到另一组值」的分叉。
 */
export const DEFAULT_FOLDED_RANGES: FoldedRange[] = [
  { start: "00:00", end: "06:00" },
  { start: "23:00", end: "24:00" },
];

/** 折叠段的最短长度：与界面「拖到 30 分钟就到底」同一条规则。 */
export const FOLDED_RANGE_MIN_MINUTES = 30;

/**
 * 把折叠段的 "HH:MM" 读成分钟数；"24:00" 是合法输入（= 1440），"24:30" 不是。
 *
 * 手写解析而不是正则：这里只认 `HH:MM` 的**定长**形态（两位小时、两位分钟），
 * 顺手把 `9:00`／`09:0`／`24:30`／`-1:00` 一并挡掉，读写两侧共用这一个入口。
 */
export function foldedMinute(value: unknown): number | null {
  if (typeof value !== "string" || value.length !== 5) return null;
  if (value[2] !== ":") return null;
  const hour = clockDigits(value.slice(0, 2));
  const minute = clockDigits(value.slice(3, 5));
  if (hour === null || minute === null || minute > 59) return null;
  if (hour === 24) return minute === 0 ? 1440 : null;
  if (hour > 24) return null;
  return hour * 60 + minute;
}

/** 两位十进制数字；含任何非数字字符都返回 null。 */
function clockDigits(value: string): number | null {
  if (value.length !== 2) return null;
  for (const character of value) if (character < "0" || character > "9") return null;
  return Number(value);
}

/** 分钟数写回折叠段用的时钟写法；1440 写成 `24:00`，其余补零到 `HH:MM`。 */
export function foldedClock(minute: number): string {
  const clamped = Math.max(0, Math.min(1440, Math.round(minute)));
  if (clamped === 1440) return "24:00";
  const hour = String(Math.floor(clamped / 60)).padStart(2, "0");
  const rest = String(clamped % 60).padStart(2, "0");
  return `${hour}:${rest}`;
}

function cloneFoldedDefaults() {
  return DEFAULT_FOLDED_RANGES.map((range) => ({ ...range }));
}

/**
 * 折叠段规范化：排序 → 合并相接／重叠 → 丢掉短于 30 分钟的段。
 *
 * 四条口径与 `normalizeTimeSlots` 是同一套写法：
 * - 非数组 → 默认两段；
 * - `[]` → **保持空**：一整天不折叠是合法选择，不许静默补默认；
 * - 逐项校验（`HH:MM` 或恰好 `24:00`，且 `end > start`），不合法的那一项丢掉；
 * - 非数组、或整个数组没有一个可用段 → 回退默认两段。
 */
export function normalizeFoldedRanges(input: unknown): FoldedRange[] {
  if (!Array.isArray(input)) return cloneFoldedDefaults();
  if (input.length === 0) return [];
  const parsed: Array<{ start: number; end: number }> = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Partial<FoldedRange>;
    const start = foldedMinute(candidate.start);
    const end = foldedMinute(candidate.end);
    if (start === null || end === null || end <= start) continue;
    parsed.push({ start, end });
  }
  parsed.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of parsed) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  const kept = merged.filter((range) => range.end - range.start >= FOLDED_RANGE_MIN_MINUTES);
  if (!kept.length) return cloneFoldedDefaults();
  return kept.map((range) => ({ start: foldedClock(range.start), end: foldedClock(range.end) }));
}

/** 时间轴的一段：`collapsed` 为真时压成灰带，为假时按 `end - start` 铺开。 */
export interface AvailabilitySegment {
  start: number;
  end: number;
  collapsed: boolean;
}

/**
 * 把 `[0, 1440]` 与折叠段求差，得到交替的展开段／折叠段。
 *
 * 折叠只改变**画法**，不改变时间连续性：段与段首尾相接、合起来正好覆盖一整天。
 */
export function availabilitySegments(folds: unknown): AvailabilitySegment[] {
  const normalized = normalizeFoldedRanges(folds);
  const segments: AvailabilitySegment[] = [];
  let cursor = 0;
  for (const range of normalized) {
    const start = foldedMinute(range.start)!;
    const end = foldedMinute(range.end)!;
    if (start > cursor) segments.push({ start: cursor, end: start, collapsed: false });
    segments.push({ start, end, collapsed: true });
    cursor = Math.max(cursor, end);
  }
  if (cursor < 1440) segments.push({ start: cursor, end: 1440, collapsed: false });
  return segments;
}

/** 折叠段的分钟区间；任一端读不出来就是 null（调用方原样返回规范化副本）。 */
function foldMinutes(range: { start: string; end: string } | null | undefined) {
  if (!range) return null;
  const start = foldedMinute(range.start);
  const end = foldedMinute(range.end);
  if (start === null || end === null) return null;
  return { start, end };
}

/** 新增一段折叠；短于 30 分钟的输入不产生新段（只返回规范化后的副本）。 */
export function addFold(folds: FoldedRange[], start: string, end: string): FoldedRange[] {
  const from = foldedMinute(start);
  const to = foldedMinute(end);
  if (from === null || to === null || to - from < FOLDED_RANGE_MIN_MINUTES) return normalizeFoldedRanges(folds);
  return normalizeFoldedRanges([...folds, { start: foldedClock(from), end: foldedClock(to) }]);
}

/** 把一段折叠整体移到别处（时长不变）；贴到别的折叠段上由规范化合并。 */
export function moveFold(folds: FoldedRange[], from: FoldedRange, to: FoldedRange): FoldedRange[] {
  const origin = foldMinutes(from);
  const target = foldMinutes(to);
  if (!origin || !target) return normalizeFoldedRanges(folds);
  if (origin.start === target.start && origin.end === target.end) return normalizeFoldedRanges(folds);
  const rest = folds.filter((range) => {
    const current = foldMinutes(range);
    return !(current && current.start === origin.start && current.end === origin.end);
  });
  return normalizeFoldedRanges([...rest, { start: foldedClock(target.start), end: foldedClock(target.end) }]);
}

/** 展开一段折叠（= 删掉这条折叠）。 */
export function removeFold(folds: FoldedRange[], range: FoldedRange): FoldedRange[] {
  const target = foldMinutes(range);
  if (!target) return normalizeFoldedRanges(folds);
  return normalizeFoldedRanges(folds.filter((item) => {
    const current = foldMinutes(item);
    return !(current && current.start === target.start && current.end === target.end);
  }));
}

/** 时钟读成分钟；非法返回 null（`24:00` 在这里也算非法：窗口起止只能是 00:00–23:59）。 */
function slotMinutes(value: string): number | null {
  if (typeof value !== "string" || value.length !== 5 || value[2] !== ":") return null;
  const hour = clockDigits(value.slice(0, 2));
  const minute = clockDigits(value.slice(3, 5));
  if (hour === null || minute === null || hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * 同一天里首尾相接或重叠的窗口并成一段（A3「松手后不留首尾相接的两块」）。
 *
 * 逐星期处理，再按「起止 + 名称」重新组装：完全同段同名的多天仍合成一条窗口（`weekdays` 共享），
 * 与 `addAvailability` 的存储形态一致。返回新数组，不就地改。
 */
export function mergeAvailability(slots: DefaultTimeSlot[]): DefaultTimeSlot[] {
  const byWeekday = new Map<number, Array<{ start: number; end: number; label: string }>>();
  for (const slot of slots) {
    const start = slotMinutes(slot.start);
    const end = slotMinutes(slot.end);
    if (start === null || end === null || end <= start) continue;
    for (const weekday of slot.weekdays) {
      const list = byWeekday.get(weekday) ?? [];
      list.push({ start, end, label: slot.label });
      byWeekday.set(weekday, list);
    }
  }
  const buckets = new Map<string, { start: string; end: string; label: string; weekdays: number[] }>();
  for (const [weekday, list] of byWeekday) {
    list.sort((left, right) => left.start - right.start || left.end - right.end);
    const merged: Array<{ start: number; end: number; label: string }> = [];
    for (const item of list) {
      const last = merged.at(-1);
      if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
      else merged.push({ ...item });
    }
    for (const item of merged) {
      const start = foldedClock(item.start);
      const end = foldedClock(item.end);
      const key = `${start}|${end}|${item.label}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.weekdays.push(weekday);
      else buckets.set(key, { start, end, label: item.label, weekdays: [weekday] });
    }
  }
  return [...buckets.values()]
    .sort((left, right) => left.start.localeCompare(right.start) || left.end.localeCompare(right.end) || left.label.localeCompare(right.label))
    .map((bucket) => ({ id: `merge-${bucket.start}-${bucket.end}-${bucket.label}`, label: bucket.label, start: bucket.start, end: bucket.end, weekdays: [...bucket.weekdays].sort((left, right) => left - right) }));
}

/**
 * 把某一天的 `origin` 换成 `next`，但**只动看得见的那一片** `visible`。
 *
 * A3 的折叠把一天压成「展开段 + 灰带」交替：一块空闲可能一头扎进灰带里。拖动只能改
 * 露在外面的那一片，藏在灰带里的首尾必须原样写回 —— 否则拖一次就把看不见的部分悄悄
 * 删掉（设计稿里修过的数据丢失 bug）。原窗口的名称跟着三段走。
 */
export function replaceAvailability(
  slots: DefaultTimeSlot[],
  weekday: number,
  origin: { start: string; end: string },
  next: { start: string; end: string },
  visible: { start: number; end: number },
  makeId: () => string,
): DefaultTimeSlot[] {
  const originStart = slotMinutes(origin.start);
  const originEnd = slotMinutes(origin.end);
  if (originStart === null || originEnd === null || originEnd <= originStart) return slots;
  const label = slots.find((slot) => slot.start === origin.start && slot.end === origin.end && slot.weekdays.includes(weekday))?.label ?? "可用时间";
  // 新建的这几段都沿用原窗口的名字：`addAvailability` 只会写「可用时间」，这里补回标签，
  // 否则拖动一次就把用户起的名字（例如「晨间阅读」）换掉了。
  const created = new Set<string>();
  const nextId = () => { const id = makeId(); created.add(id); return id; };
  let result = removeAvailability(slots, weekday, origin.start, origin.end);
  const headEnd = Math.max(originStart, Math.min(originEnd, visible.start));
  if (headEnd > originStart) result = addAvailability(result, weekday, foldedClock(originStart), foldedClock(headEnd), nextId);
  const tailStart = Math.min(originEnd, Math.max(originStart, visible.end));
  if (originEnd > tailStart) result = addAvailability(result, weekday, foldedClock(tailStart), foldedClock(originEnd), nextId);
  const current = unfoldedRange(next);
  if (current) result = addAvailability(result, weekday, current.start, current.end, nextId);
  return mergeAvailability(result.map((slot) => created.has(slot.id) ? { ...slot, label } : slot));
}

/** 窗口起止的合法化：`23:59` 是窗口允许的最后分钟，`24:00` 折回 `23:59`。 */
function unfoldedRange(range: { start: string; end: string }) {
  const start = slotMinutes(range.start);
  const end = slotMinutes(range.end);
  if (start === null || end === null || end <= start) return null;
  return { start: foldedClock(start), end: foldedClock(end) };
}

