import type { WorkspaceSnapshot } from "./native";

export interface ReviewDay {
  date: string;
  progressDelta: number;
  actualMinutes: number;
  missedCount: number;
  skippedCount: number;
}

export function buildSevenDayReview(workspace: WorkspaceSnapshot, endDate: string) {
  const dates = Array.from({ length: 7 }, (_, index) => addDays(endDate, index - 6));
  const days: ReviewDay[] = dates.map((date) => ({ date, progressDelta: 0, actualMinutes: 0, missedCount: 0, skippedCount: 0 }));
  const byDate = new Map(days.map((day) => [day.date, day]));
  const progressedTaskIds: string[] = [];
  const completedTaskIds: string[] = [];

  for (const event of workspace.progressEvents) {
    const day = byDate.get(localDate(new Date(event.occurredAtUtc)));
    if (!day) continue;
    day.progressDelta += event.toProgress - event.fromProgress;
    if (!progressedTaskIds.includes(event.taskId)) progressedTaskIds.push(event.taskId);
    if (event.toProgress === 100 && !completedTaskIds.includes(event.taskId)) completedTaskIds.push(event.taskId);
  }
  for (const record of workspace.executionRecords) {
    if (!record.actualEndUtc) continue;
    const day = byDate.get(localDate(new Date(record.actualStartUtc)));
    if (day) day.actualMinutes += Math.max(0, Math.round((new Date(record.actualEndUtc).getTime() - new Date(record.actualStartUtc).getTime()) / 60_000));
  }
  for (const session of workspace.executionSessions) {
    const day = byDate.get(session.localDate);
    if (!day) continue;
    const recovered = workspace.executionRecords.some((record) => record.sessionId === session.id);
    if (session.status === "missed" && !recovered) day.missedCount += 1;
    if (session.status === "skipped" || session.status === "cancelled") day.skippedCount += 1;
  }
  for (const occurrence of workspace.habitOccurrences) {
    const day = byDate.get(occurrence.localDate);
    if (day && occurrence.status === "skipped" && !occurrence.sessionId) day.skippedCount += 1;
  }
  const carryoverTaskIds = workspace.tasks
    .filter((task) => task.status === "active" && (
      workspace.executionSessions.some((session) => session.taskId === task.id && byDate.has(session.localDate) && (session.status === "missed" || session.status === "skipped" || session.status === "cancelled"))
      || workspace.recurringHabits.some((habit) => habit.taskId === task.id && workspace.habitOccurrences.some((occurrence) => occurrence.habitId === habit.id && byDate.has(occurrence.localDate) && occurrence.status === "skipped"))
    ))
    .map((task) => task.id);
  return { startDate: dates[0], endDate, days, progressedTaskIds, completedTaskIds, carryoverTaskIds };
}

function localDate(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function addDays(date: string, amount: number) {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + amount);
  return localDate(value);
}
