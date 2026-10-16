import type { ExecutionRecord, ExecutionSession, MilestoneOutcome, Project, ProjectMilestone, Task, WorkspaceSnapshot } from "./native";

/**
 * 工作区稳定索引与共享事实选择器（阶段 4 P4-06）。
 *
 * 两件事：
 *
 * 1. **稳定索引**：任务／项目／执行时段／执行记录／里程碑／到期结果按 ID 建 Map，外加
 *    「某时段的执行记录」与「某项目的任务」两张分组表。快照变一次重建一次
 *    （调用方用 `useMemo`／单次构造），列表渲染不再逐行 `Array.find` 扫全量数组。
 * 2. **共享选择器**：把此前散在 `App.tsx` 里的领域判断收敛到一处 —— 「待回顾」的唯一
 *    判断（规格 §7.4 要求月历摘要、今日待回顾与回顾共用）、项目加权进度、里程碑达成
 *    规则（M7 唯一规则，规格 §6.1 要求截止投影复用同一套，不得另写）。
 *
 * 本模块只读投影，不产生副作用、不读取隐式系统时间（`now` 一律由调用方注入），
 * 也不创建任何领域事实。
 */

export interface WorkspaceIndex {
  /** 索引对应的原始快照；派生页面不再各自持有第二份。 */
  workspace: WorkspaceSnapshot;
  tasksById: Map<string, Task>;
  projectsById: Map<string, Project>;
  sessionsById: Map<string, ExecutionSession>;
  recordsById: Map<string, ExecutionRecord>;
  /**
   * 每个执行时段已经产生的实际执行记录。
   *
   * 「待回顾」判断靠它区分「计划结束但没记实际投入」与「已经记过」，因此不按
   * `recordsById` 线性扫描；`sessionId` 为空的记录（直接挂任务的补录）不进入本表。
   */
  recordsBySessionId: Map<string, ExecutionRecord[]>;
  /** 项目 ID → 该项目下的任务（保持快照原顺序）。 */
  tasksByProjectId: Map<string, Task[]>;
  /**
   * 任务 ID → 该任务的计划执行时段（保持快照原顺序）。
   *
   * 任务池此前在**每一行**上 `sessions.some(...)`／`sessions.filter(...)` 扫全量时段，
   * 1,000 任务 × 3,000 时段 就是每次渲染三百万次比较（规格 §8 点名的模式）。有了这张
   * 分组表，每行只看自己的时段，总量降回 O(时段数)。
   */
  sessionsByTaskId: Map<string, ExecutionSession[]>;
  milestonesById: Map<string, ProjectMilestone>;
  milestonesByProjectId: Map<string, ProjectMilestone[]>;
  outcomesByMilestoneId: Map<string, MilestoneOutcome>;
  /** 已经有到期冻结结果的里程碑 ID：冻结后不可改写、不可编辑删除。 */
  frozenMilestoneIds: Set<string>;
}

/** 每次 workspace 快照变更重建一次；不要在渲染每一行时调用。 */
export function createWorkspaceIndex(workspace: WorkspaceSnapshot): WorkspaceIndex {
  const tasksById = new Map<string, Task>();
  const tasksByProjectId = new Map<string, Task[]>();
  for (const task of workspace.tasks) {
    tasksById.set(task.id, task);
    if (task.projectId) {
      const bucket = tasksByProjectId.get(task.projectId);
      if (bucket) bucket.push(task);
      else tasksByProjectId.set(task.projectId, [task]);
    }
  }

  const projectsById = new Map(workspace.projects.map((project) => [project.id, project]));

  const sessionsById = new Map<string, ExecutionSession>();
  const sessionsByTaskId = new Map<string, ExecutionSession[]>();
  for (const session of workspace.executionSessions) {
    sessionsById.set(session.id, session);
    const bucket = sessionsByTaskId.get(session.taskId);
    if (bucket) bucket.push(session);
    else sessionsByTaskId.set(session.taskId, [session]);
  }

  const recordsById = new Map<string, ExecutionRecord>();
  const recordsBySessionId = new Map<string, ExecutionRecord[]>();
  for (const record of workspace.executionRecords) {
    recordsById.set(record.id, record);
    if (!record.sessionId) continue;
    const bucket = recordsBySessionId.get(record.sessionId);
    if (bucket) bucket.push(record);
    else recordsBySessionId.set(record.sessionId, [record]);
  }

  const milestonesById = new Map<string, ProjectMilestone>();
  const milestonesByProjectId = new Map<string, ProjectMilestone[]>();
  for (const milestone of workspace.projectMilestones) {
    milestonesById.set(milestone.id, milestone);
    const bucket = milestonesByProjectId.get(milestone.projectId);
    if (bucket) bucket.push(milestone);
    else milestonesByProjectId.set(milestone.projectId, [milestone]);
  }

  const outcomesByMilestoneId = new Map(workspace.milestoneOutcomes.map((outcome) => [outcome.milestoneId, outcome]));

  return {
    workspace,
    tasksById,
    projectsById,
    sessionsById,
    recordsById,
    recordsBySessionId,
    tasksByProjectId,
    sessionsByTaskId,
    milestonesById,
    milestonesByProjectId,
    outcomesByMilestoneId,
    frozenMilestoneIds: new Set(workspace.milestoneOutcomes.map((outcome) => outcome.milestoneId)),
  };
}

export function projectTasksOf(index: WorkspaceIndex, projectId: string): Task[] {
  return index.tasksByProjectId.get(projectId) ?? [];
}

export function taskTitleOf(index: WorkspaceIndex, taskId: string): string {
  return index.tasksById.get(taskId)?.title ?? "未知任务";
}

/** 任务是否已完成：显式 `completed` 或手动完成度到 100。项目与里程碑规则共用这一条。 */
export function isTaskCompleted(task: Task): boolean {
  return task.status === "completed" || task.progress >= 100;
}

/**
 * 「待回顾」的**唯一**判断（阶段 4 P4-06 收敛，规格 §7.4）。
 *
 * 计划时段已经结束、任务仍未完成、该时段还没有任何实际执行记录 —— 三者同时成立才算
 * 待回顾。它只描述「现在需要用户回顾一次已过去的安排」，不写 `missed`，也不代表任务
 * 失败：时间经过本身不会改变任何事实。
 *
 * `sessionRecords` 只传该时段自己的记录（`WorkspaceIndex.recordsBySessionId`）。
 */
export function isPendingReview(session: ExecutionSession, task: Task | undefined, sessionRecords: readonly ExecutionRecord[], now: Date) {
  if (session.status !== "scheduled" || !task) return false;
  if (!sessionEnded(session, now)) return false;
  if (isTaskCompleted(task)) return false;
  return sessionRecords.length === 0;
}

/** 同一判断的索引版本；今日页与后续回顾页都从这里取，避免各写一份。 */
export function isPendingReviewIn(index: WorkspaceIndex, session: ExecutionSession, now: Date) {
  return isPendingReview(session, index.tasksById.get(session.taskId), index.recordsBySessionId.get(session.id) ?? [], now);
}

export function pendingReviewSessions(index: WorkspaceIndex, now: Date): ExecutionSession[] {
  return index.workspace.executionSessions.filter((session) => isPendingReviewIn(index, session, now));
}

function sessionEnded(session: ExecutionSession, now: Date) {
  return localSessionEnd(session) <= now.getTime();
}

function localSessionEnd(session: ExecutionSession) {
  if (session.utcOffsetMinutes === null) return new Date(`${session.endLocalDate}T${session.endLocal}:00`).getTime();
  const [year, month, day] = session.endLocalDate.split("-").map(Number);
  const [hour, minute] = session.endLocal.split(":").map(Number);
  return Date.UTC(year, month - 1, day, hour, minute) - session.utcOffsetMinutes * 60_000;
}

/**
 * 项目进度：所有任务完成度的**耗时加权**结果（CONTEXT.md「项目进度」）。
 * 预计耗时缺失按 60 分钟计，与既有实现一致。
 */
export function projectProgress(tasks: Task[]): number {
  const weighted = tasks.reduce((sum, task) => sum + task.progress * (task.estimatedMinutes ?? 60), 0);
  const total = tasks.reduce((sum, task) => sum + (task.estimatedMinutes ?? 60), 0);
  return total ? Math.round(weighted / total) : 0;
}

/** 项目任务计数；项目本身没有完成字段，截止视图只显示「当前任务 N/N 已完成」。 */
export function projectTaskCounts(index: WorkspaceIndex, projectId: string) {
  const tasks = projectTasksOf(index, projectId);
  return { total: tasks.length, completed: tasks.filter(isTaskCompleted).length };
}

/**
 * 有序任务里程碑覆盖的范围：目标任务以及项目排序中位于它之前的全部任务。
 * 目标任务已经不在项目里时返回空数组（无法证明达成）。
 */
export function orderedMilestoneTasks(milestone: ProjectMilestone, tasks: Task[]): Task[] {
  if (milestone.criterionKind !== "orderedTask") return [];
  const ordered = [...tasks].sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  const targetIndex = ordered.findIndex((task) => task.id === milestone.targetTaskId);
  return targetIndex < 0 ? [] : ordered.slice(0, targetIndex + 1);
}

/**
 * 里程碑**当前**是否达成 —— M7 的唯一规则（规格 0004「M7.4 Acceptance Criteria」）。
 *
 * - `orderedTask`：目标任务及排序在它之前的任务是否全部完成；前置任务未完成时，
 *   即使目标任务已完成也仍视为未达成。
 * - `taskCount`：项目已完成任务数量是否达到目标。
 * - `projectProgress`：耗时加权项目进度是否达到目标。
 *
 * 它只回答「现在怎么样」。到期冻结的历史结果不在这里改写，见 `deadlines.ts`。
 */
export function milestoneReached(milestone: ProjectMilestone, tasks: Task[], weighted: number): boolean {
  if (milestone.criterionKind === "orderedTask") {
    const ordered = orderedMilestoneTasks(milestone, tasks);
    return ordered.length > 0 && ordered.every(isTaskCompleted);
  }
  if (milestone.criterionKind === "taskCount") return tasks.filter(isTaskCompleted).length >= milestone.targetCount;
  return weighted >= milestone.targetProgress;
}

/** 索引版本：按项目取任务与加权进度后走同一条规则。 */
export function milestoneReachedNow(index: WorkspaceIndex, milestone: ProjectMilestone): boolean {
  const tasks = projectTasksOf(index, milestone.projectId);
  return milestoneReached(milestone, tasks, projectProgress(tasks));
}

/** 里程碑达成条件的可读摘要；冻结后由到期结果文本取代。 */
export function milestoneSummary(milestone: ProjectMilestone, tasks: Task[]) {
  const task = milestone.targetTaskId ? tasks.find((item) => item.id === milestone.targetTaskId) : null;
  const goal = milestone.criterionKind === "orderedTask" ? `按顺序完成至「${task?.title ?? "任务已不在项目中"}」`
    : milestone.criterionKind === "taskCount" ? `完成 ${milestone.targetCount} 个项目任务`
      : `项目加权进度达到 ${milestone.targetProgress}%`;
  return `${goal} · ${formatShortLocalDate(milestone.targetLocalDate)} 前`;
}

function formatShortLocalDate(date: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(`${date}T12:00:00`));
}
