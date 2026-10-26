import { addLocalDays } from "./deadlines";
import type { ExecutionSession, TimeBlock } from "./native";

export type CalendarDropMode = "place" | "insert-before" | "insert-after" | "overlap";

export interface SessionPlacementChange {
  session: ExecutionSession;
  startMinute: number;
}

/** 拖拽落点：预览与提交共用这一份描述。 */
export interface CalendarDropIntent {
  date: string;
  startMinute: number;
  taskId: string;
  sessionId: string;
  mode: CalendarDropMode;
  targetSessionId: string;
  /** 指针在目标卡内的纵向比例；null 表示调用方已经决定了 `mode`（例如原生拖拽的旧路径）。 */
  targetRatio?: number | null;
}

export interface ConcurrentLayout {
  left: number;
  width: number;
  hidden: boolean;
  hiddenCount: number;
  groupId: string;
  totalCount: number;
  showCount: boolean;
}

export function sessionMinutes(session: ExecutionSession) {
  const start = clockMinutes(session.startLocal); let end = clockMinutes(session.endLocal);
  if (session.endLocalDate !== session.localDate || end <= start) end += 1440;
  return end - start;
}

/**
 * 让位的唯一级联算法：从 `fromMinute` 起按顺序排一遍，凡是起点落在「已占用窗口」里、
 * 或者与前面刚被推后的时段相撞的，就顺次后移。
 *
 * 插入（`insertionChanges`）与改时长（`resizeChanges`）共用这一份 —— 两条通道各写一遍
 * 级联正是 F21 之前的状态：改时长不动别人，拉长压住后续安排时毫无反应。
 */
function cascadeChanges(sessions: ExecutionSession[], sourceId: string, fromMinute: number, occupiedUntil: number): SessionPlacementChange[] {
  let cursor = occupiedUntil;
  const candidates = sessions
    .filter((session) => session.id !== sourceId && clockMinutes(session.startLocal) >= fromMinute)
    .sort((a, b) => clockMinutes(a.startLocal) - clockMinutes(b.startLocal));
  const changes: SessionPlacementChange[] = [];
  for (const session of candidates) {
    const start = clockMinutes(session.startLocal);
    if (start >= cursor) { cursor = start + sessionMinutes(session); continue; }
    changes.push({ session, startMinute: cursor });
    cursor += sessionMinutes(session);
  }
  return changes;
}

export function insertionChanges(sessions: ExecutionSession[], sourceId: string, targetId: string, edge: "before" | "after", sourceDuration: number): SessionPlacementChange[] {
  const target = sessions.find((session) => session.id === targetId);
  if (!target) return [];
  const targetStart = clockMinutes(target.startLocal);
  const targetEnd = targetStart + sessionMinutes(target);
  const insertionStart = edge === "before" ? targetStart : targetEnd;
  return cascadeChanges(sessions, sourceId, insertionStart, insertionStart + sourceDuration);
}

/**
 * 改时长的让位（UI-SPEC §197）：向下拉长时同列后续时段实时后退，向上缩短只释放空档。
 *
 * 判据是「新结束分钟越过了谁」——只有原本在**旧结束之后**开始的时段才可能被让位。
 * 与源时段并排（起点早于旧结束）的其它安排一概不动：否则一次拉长会把同时进行的那一项
 * 也推走，缩短时更会把并排项整体后移，直接违反 §198。
 */
export function resizeChanges(input: {
  /** 当天参与落点的时段（与提交同一套集合，见 `placeableSessions`）。 */
  sessions: ExecutionSession[];
  /** 正在改时长的那一份；旧时长由它自己给出，不需要调用方另算。 */
  session: ExecutionSession;
  /** 源时段的开始分钟（改时长不动开始时间）。 */
  startMinute: number;
  /** 拖出来的新时长（分钟）。 */
  duration: number;
}): SessionPlacementChange[] {
  const previousEnd = input.startMinute + sessionMinutes(input.session);
  return cascadeChanges(input.sessions, input.session.id, previousEnd, input.startMinute + input.duration);
}

/**
 * 改时长是否侵入时间块（UI-SPEC §189 后半）。
 *
 * 看的是**拉长后的区间**覆盖了哪个块，而不是指针位置：拖底边时指针一直停在卡片下缘，
 * 时间块却可能在卡片中段，按指针判会整个漏掉。移动／池路径仍用指针命中（`blockId`），
 * 因为那里「落点」本身就是指针。
 */
export function blockOverlapping(input: {
  blocks: TimeBlock[];
  date: string;
  startMinute: number;
  duration: number;
}): TimeBlock | null {
  const start = input.startMinute;
  const end = input.startMinute + input.duration;
  for (const block of input.blocks) {
    if (block.localDate !== input.date) continue;
    const blockStart = clockMinutes(block.startLocal);
    const blockEndRaw = clockMinutes(block.endLocal);
    const blockEnd = blockEndRaw <= blockStart ? blockEndRaw + 1440 : blockEndRaw;
    if (blockStart < end && blockEnd > start) return block;
  }
  return null;
}

/**
 * 同一天里参与落点计算与提交的时段集合。
 *
 * 预览与提交必须读同一份：以前预览用全部时段、提交只取 `scheduled|missed`，
 * 两套集合不一致时预览与落库会不同（评估 F09）。取消/跳过/完成的历史不参与让位。
 */
export function placeableSessions(sessions: ExecutionSession[], date: string): ExecutionSession[] {
  return sessions.filter((session) => session.localDate === date && (session.status === "scheduled" || session.status === "missed"));
}

export interface CalendarDropResolution {
  startMinute: number;
  mode: CalendarDropMode;
  targetSessionId: string;
  shifted: SessionPlacementChange[];
}

/**
 * 落点与后移的唯一算法：拖动预览、松手提交、原生拖拽的 drop 都走这里。
 *
 * `commit = true` 表示这次是松手：卡片中央一律按 overlap 提交（D5），不再静默丢弃；
 * 拖动中的预览仍停在 `place`，用来提示「悬停半秒」。边缘插入在两种情况下语义一致。
 */
export function resolveCalendarDrop(input: {
  sessions: ExecutionSession[];
  sourceSessionId: string;
  sourceDuration: number;
  pointerMinute: number;
  targetSessionId?: string;
  targetRatio?: number | null;
  requestedMode?: CalendarDropMode;
  overlapLatched?: boolean;
  commit?: boolean;
}): CalendarDropResolution {
  const target = input.targetSessionId
    ? input.sessions.find((session) => session.id === input.targetSessionId && session.id !== input.sourceSessionId) ?? null
    : null;
  let mode: CalendarDropMode = input.requestedMode ?? "place";
  let startMinute = input.pointerMinute;
  const ratio = input.targetRatio ?? null;
  if (!target) {
    mode = "place";
  } else {
    const targetStart = clockMinutes(target.startLocal);
    if (ratio !== null && Number.isFinite(ratio)) {
      if (ratio < .25) { mode = "insert-before"; startMinute = targetStart; }
      else if (ratio > .75) { mode = "insert-after"; startMinute = targetStart + sessionMinutes(target); }
      else if (input.overlapLatched || input.commit) { mode = "overlap"; startMinute = targetStart; }
      else { mode = "place"; startMinute = input.pointerMinute; }
    } else if (mode === "insert-before") startMinute = targetStart;
    else if (mode === "insert-after") startMinute = targetStart + sessionMinutes(target);
    else if (mode === "overlap") startMinute = targetStart;
  }
  const shifted = target && (mode === "insert-before" || mode === "insert-after")
    ? insertionChanges(input.sessions, input.sourceSessionId, target.id, mode === "insert-before" ? "before" : "after", input.sourceDuration)
    : [];
  return { startMinute, mode, targetSessionId: target?.id ?? "", shifted };
}

export interface DropImpact {
  /** 被推到默认时段之外、或被推到新日期的时段。 */
  affected: SessionPlacementChange[];
  /** 受影响时段落到的新日期（去重、升序）。 */
  dates: string[];
  reason: "outside-slots" | "cross-day";
}

/**
 * 跨默认时段／跨天判定的唯一出处（UI-SPEC §187/§188）。
 *
 * 只看**被插入推后的时段**：用户自己把卡片放到非默认时段里是可见的落点（预览框就在那儿），
 * 不该再弹一次确认；需要确认的是「插入顺手把别人推出了原来的时段」这类**看不见的连带后果**。
 * 没有配置默认时段时不存在「越界」这回事，只判跨天。
 */
export function dropImpact(input: {
  date: string;
  shifted: SessionPlacementChange[];
  /** 该日的默认时段（分钟区间；跨午夜的时段已由 `defaultSlotSlicesForWeekday` 切好）。 */
  defaultRanges: Array<{ start: number; end: number }>;
}): DropImpact | null {
  if (input.shifted.length === 0) return null;
  const affected: SessionPlacementChange[] = [];
  const dates = new Set<string>();
  let crossDay = false;
  for (const change of input.shifted) {
    const start = change.startMinute;
    const end = start + sessionMinutes(change.session);
    const crossesDay = start >= 1440 || end > 1440;
    const outsideSlots = input.defaultRanges.length > 0
      && !input.defaultRanges.some((range) => start >= range.start && end <= range.end);
    if (!crossesDay && !outsideSlots) continue;
    affected.push(change);
    if (crossesDay) {
      crossDay = true;
      dates.add(addLocalDays(input.date, Math.floor(start / 1440)));
      dates.add(addLocalDays(input.date, Math.floor((Math.max(start, end) - 1) / 1440)));
    }
  }
  if (affected.length === 0) return null;
  return { affected, dates: [...dates].sort(), reason: crossDay ? "cross-day" : "outside-slots" };
}

export function concurrentLayouts(sessions: ExecutionSession[], maxSideBySide = 3): Map<string, ConcurrentLayout> {
  const sorted = [...sessions].sort((a, b) => clockMinutes(a.startLocal) - clockMinutes(b.startLocal) || a.id.localeCompare(b.id));
  const output = new Map<string, ConcurrentLayout>();
  let group: ExecutionSession[] = []; let groupEnd = -1;
  const flush = () => {
    if (!group.length) return;
    const groupId = group.map((session) => session.id).join(":");
    const laneEnds: number[] = [];
    const assigned = group.map((session) => {
      const start = clockMinutes(session.startLocal); const end = start + sessionMinutes(session);
      let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start); if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = end;
      return { session, lane };
    });
    const laneCount = laneEnds.length;
    // 超过上限才收成汇总卡；汇总态固定展示前两项（与「4 项以上」的既有规则一致）。
    const collapsed = laneCount > maxSideBySide;
    const visibleLanes = collapsed ? Math.min(2, maxSideBySide) : laneCount;
    const width = 100 / visibleLanes;
    const hiddenCount = assigned.filter((item) => item.lane >= visibleLanes).length;
    const summarySessionId = assigned.find((item) => item.lane === visibleLanes - 1)?.session.id;
    assigned.forEach(({ session, lane }, index) => output.set(session.id, { left: lane >= visibleLanes ? 100 : lane * width, width, hidden: lane >= visibleLanes, hiddenCount: session.id === summarySessionId ? hiddenCount : 0, groupId, totalCount: laneCount, showCount: laneCount > 1 && index === 0 }));
    group = []; groupEnd = -1;
  };
  for (const session of sorted) {
    const start = clockMinutes(session.startLocal); const end = start + sessionMinutes(session);
    if (group.length && start >= groupEnd) flush();
    group.push(session); groupEnd = Math.max(groupEnd, end);
  }
  flush();
  return output;
}

function clockMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}
