import type { Project, ProjectMilestone, Task, WorkspaceSnapshot } from "./native";

export type CalendarSummaryKind = "deadline" | "projectDeadline" | "milestone" | "completed" | "progressed" | "missed";
export type DeadlineUrgency = "overdue" | "today" | "soon" | "later";

export interface CalendarSummaryItem {
  id: string;
  kind: CalendarSummaryKind;
  label: string;
  taskId: string | null;
  projectId: string | null;
  milestoneId: string | null;
  urgency?: DeadlineUrgency;
}

export interface CalendarDaySummary {
  date: string;
  deadlines: Task[];
  projectDeadlines: Project[];
  milestones: ProjectMilestone[];
  completedTasks: Task[];
  progressedTasks: Task[];
  missedTasks: Task[];
  progressDelta: number;
  visible: CalendarSummaryItem[];
  overflowCount: number;
}

export type CalendarMarkerKind = "taskDeadline" | "projectDeadline" | "milestone";

export interface CalendarMarker {
  id: string;
  kind: CalendarMarkerKind;
  label: string;
  urgency: DeadlineUrgency;
  taskId: string | null;
  projectId: string | null;
  milestoneId: string | null;
}

export function calendarDayMarkers(workspace: WorkspaceSnapshot, date: string, today = browserLocalDate(new Date())): CalendarMarker[] {
  const markers: CalendarMarker[] = [
    ...workspace.tasks
      .filter((task) => task.deadlineLocal === date && task.status !== "completed")
      .sort((left, right) => left.sortOrder - right.sortOrder || left.title.localeCompare(right.title))
      .map((task) => ({ id: `deadline:${task.id}`, kind: "taskDeadline" as const, label: task.title, urgency: deadlineUrgency(date, today), taskId: task.id, projectId: null, milestoneId: null })),
    ...workspace.projects
      .filter((project) => project.deadlineLocal === date)
      .sort((left, right) => left.title.localeCompare(right.title))
      .map((project) => ({ id: `projectDeadline:${project.id}`, kind: "projectDeadline" as const, label: project.title, urgency: deadlineUrgency(project.deadlineLocal!, today), taskId: null, projectId: project.id, milestoneId: null })),
    ...workspace.projectMilestones
      .filter((milestone) => milestone.targetLocalDate === date)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.title.localeCompare(right.title))
      .map((milestone) => ({ id: `milestone:${milestone.id}`, kind: "milestone" as const, label: milestone.title, urgency: deadlineUrgency(milestone.targetLocalDate, today), taskId: null, projectId: milestone.projectId, milestoneId: milestone.id })),
  ];
  return markers;
}

export function calendarDaySummary(workspace: WorkspaceSnapshot, date: string, today = browserLocalDate(new Date())): CalendarDaySummary {
  const tasksById = new Map(workspace.tasks.map((task) => [task.id, task]));
  const deadlines = workspace.tasks
    .filter((task) => task.deadlineLocal === date && task.status !== "completed")
    .sort((left, right) => left.sortOrder - right.sortOrder || left.title.localeCompare(right.title));
  const projectDeadlines = workspace.projects
    .filter((project) => project.deadlineLocal === date)
    .sort((left, right) => left.title.localeCompare(right.title));
  const milestones = workspace.projectMilestones
    .filter((milestone) => milestone.targetLocalDate === date)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.title.localeCompare(right.title));
  const events = workspace.progressEvents.filter((event) => localDateFromUtc(event.occurredAtUtc) === date && event.toProgress > event.fromProgress);
  const completedTasks = uniqueTasks(events.filter((event) => event.toProgress === 100).map((event) => tasksById.get(event.taskId)));
  const completedIds = new Set(completedTasks.map((task) => task.id));
  const progressedTasks = uniqueTasks(events.filter((event) => !completedIds.has(event.taskId)).map((event) => tasksById.get(event.taskId)));
  const missedTasks = uniqueTasks(workspace.executionSessions
    .filter((session) => session.localDate === date && session.status === "missed")
    .map((session) => tasksById.get(session.taskId)));
  const progressDelta = events.reduce((sum, event) => sum + event.toProgress - event.fromProgress, 0);
  const items: CalendarSummaryItem[] = [
    ...deadlines.map((task) => ({ id: `deadline:${task.id}`, kind: "deadline" as const, label: task.title, taskId: task.id, projectId: null, milestoneId: null, urgency: deadlineUrgency(date, today) })),
    ...projectDeadlines.map((project) => ({ id: `projectDeadline:${project.id}`, kind: "projectDeadline" as const, label: project.title, taskId: null, projectId: project.id, milestoneId: null, urgency: deadlineUrgency(project.deadlineLocal!, today) })),
    ...milestones.map((milestone) => ({ id: `milestone:${milestone.id}`, kind: "milestone" as const, label: milestone.title, taskId: null, projectId: milestone.projectId, milestoneId: milestone.id, urgency: deadlineUrgency(milestone.targetLocalDate, today) })),
    ...(completedTasks.length ? [{ id: "completed", kind: "completed" as const, label: `完成 ${completedTasks.length} 项`, taskId: null, projectId: null, milestoneId: null }] : []),
    ...(progressedTasks.length ? [{ id: "progressed", kind: "progressed" as const, label: `推进 ${progressedTasks.length} 项 · +${progressDelta}%`, taskId: null, projectId: null, milestoneId: null }] : []),
    ...(missedTasks.length ? [{ id: "missed", kind: "missed" as const, label: `未推进 ${missedTasks.length} 项`, taskId: null, projectId: null, milestoneId: null }] : []),
  ];

  return {
    date,
    deadlines,
    projectDeadlines,
    milestones,
    completedTasks,
    progressedTasks,
    missedTasks,
    progressDelta,
    visible: items.slice(0, 3),
    overflowCount: Math.max(0, items.length - 3),
  };
}

function uniqueTasks(tasks: Array<Task | undefined>) {
  const found = new Map<string, Task>();
  tasks.forEach((task) => { if (task) found.set(task.id, task); });
  return [...found.values()];
}

export function deadlineUrgency(deadline: string, today = browserLocalDate(new Date())): DeadlineUrgency {
  if (deadline < today) return "overdue";
  if (deadline === today) return "today";
  const milliseconds = new Date(`${deadline}T12:00:00`).getTime() - new Date(`${today}T12:00:00`).getTime();
  return milliseconds <= 7 * 86_400_000 ? "soon" : "later";
}

export function deadlineUrgencyLabel(urgency: DeadlineUrgency) {
  return urgency === "overdue" ? "已逾期" : urgency === "today" ? "今天截止" : urgency === "soon" ? "7 天内截止" : "未来截止";
}

function localDateFromUtc(utc: string) {
  const date = new Date(utc);
  return browserLocalDate(date);
}

function browserLocalDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
