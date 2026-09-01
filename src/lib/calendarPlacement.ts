import type { ExecutionSession } from "./native";

export type CalendarDropMode = "place" | "insert-before" | "insert-after" | "overlap";

export interface SessionPlacementChange {
  session: ExecutionSession;
  startMinute: number;
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

export function concurrentLayouts(sessions: ExecutionSession[]): Map<string, ConcurrentLayout> {
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
    const laneCount = laneEnds.length; const width = laneCount >= 4 ? 50 : 100 / laneCount;
    const hiddenCount = assigned.filter((item) => item.lane >= 2).length;
    const summarySessionId = assigned.find((item) => item.lane === 1)?.session.id;
    assigned.forEach(({ session, lane }, index) => output.set(session.id, { left: laneCount >= 4 && lane >= 2 ? 100 : lane * width, width, hidden: laneCount >= 4 && lane >= 2, hiddenCount: session.id === summarySessionId ? hiddenCount : 0, groupId, totalCount: laneCount, showCount: laneCount > 1 && index === 0 }));
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
