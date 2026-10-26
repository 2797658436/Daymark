import { addLocalDays } from "./deadlines";
import type { ExecutionSession } from "./native";

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

export function insertionChanges(sessions: ExecutionSession[], sourceId: string, targetId: string, edge: "before" | "after", sourceDuration: number): SessionPlacementChange[] {
  const target = sessions.find((session) => session.id === targetId);
  if (!target) return [];
  const targetStart = clockMinutes(target.startLocal);
  const targetEnd = targetStart + sessionMinutes(target);
  const insertionStart = edge === "before" ? targetStart : targetEnd;
  let cursor = insertionStart + sourceDuration;
  const candidates = sessions
    .filter((session) => session.id !== sourceId && clockMinutes(session.startLocal) >= (edge === "before" ? targetStart : targetEnd))
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
