import type { MilestoneOutcome, ProjectMilestone, Task } from "./native";
import { milestoneReached, milestoneSummary, orderedMilestoneTasks } from "./workspaceSelectors";

/**
 * 项目进度轨（项目页）的派生值。
 *
 * 轨道横轴是**项目加权进度**（projectProgress），里程碑节点是它的路标：
 * - projectProgress 里程碑的目标就是进度百分比，位置精确；
 * - orderedTask 里程碑的位置 = 完成到目标任务时这些有序任务占的权重；
 * - taskCount 里程碑的位置 = 目标任务数 / 总任务数（等权换算，仅作阶段参考）。
 *
 * 后两种是**换算值**，不是项目进度的真实刻度，approximate 会把这件事带到界面
 * （详情图例标“≈”，悬停说明“位置按达成条件换算”）。不要把这里的近似值当作新的
 * 进度口径：项目进度仍然只有 projectProgress 一个来源。
 */

export type ProjectRailState = "reached" | "missed" | "active";

export interface ProjectRailNode {
  milestone: ProjectMilestone;
  /** 0–100，已按轨道轴换算并钳制。 */
  position: number;
  /** 位置是否由达成条件换算而来（非 projectProgress）。 */
  approximate: boolean;
  state: ProjectRailState;
  /** milestoneSummary 的原文；界面不再自己拼条件文案。 */
  summary: string;
}

export interface ProjectRailData {
  /** 项目加权进度，0–100。 */
  progress: number;
  nodes: ProjectRailNode[];
  /** 最早一个尚未达成、也未被冻结为未达成的里程碑。 */
  next: ProjectRailNode | null;
}

const DEFAULT_TASK_MINUTES = 60;

function taskWeight(task: Task) {
  return task.estimatedMinutes ?? DEFAULT_TASK_MINUTES;
}

/** 里程碑在进度轨上的位置；无法换算时返回 null（例如有序目标任务已不在项目里）。 */
export function milestoneRailPosition(milestone: ProjectMilestone, tasks: Task[]): number | null {
  if (milestone.criterionKind === "projectProgress") {
    if (milestone.targetProgress === null) return null;
    return clampPercent(milestone.targetProgress);
  }
  const total = tasks.reduce((sum, task) => sum + taskWeight(task), 0);
  if (total <= 0) return null;
  if (milestone.criterionKind === "taskCount") {
    if (!milestone.targetCount) return null;
    // 等权换算：目标数量占总任务数的比例。完成哪 N 个任务不影响位置，所以只作阶段参考。
    return clampPercent((milestone.targetCount / tasks.length) * 100);
  }
  const ordered = orderedMilestoneTasks(milestone, tasks);
  if (ordered.length === 0) return null;
  const covered = ordered.reduce((sum, task) => sum + taskWeight(task), 0);
  return clampPercent((covered / total) * 100);
}

/**
 * 建整条轨道。outcomes 是冻结结果表：冻结后达成态以快照为准，不再随当前进度改写。
 * 节点按位置升序；next 取尚未达成、也未被冻结为未达成的里程碑里目标日期最早的一个。
 */
export function buildProjectRail({ tasks, milestones, outcomes, progress }: {
  tasks: Task[];
  milestones: ProjectMilestone[];
  outcomes: Map<string, MilestoneOutcome>;
  progress: number;
}): ProjectRailData {
  const nodes: ProjectRailNode[] = [];
  for (const milestone of milestones) {
    const position = milestoneRailPosition(milestone, tasks);
    if (position === null) continue;
    const outcome = outcomes.get(milestone.id);
    const state: ProjectRailState = outcome
      ? (outcome.reached ? "reached" : "missed")
      : milestoneReached(milestone, tasks, progress) ? "reached" : "active";
    nodes.push({
      milestone,
      position,
      approximate: milestone.criterionKind !== "projectProgress",
      state,
      summary: milestoneSummary(milestone, tasks),
    });
  }
  nodes.sort((left, right) => left.position - right.position
    || left.milestone.targetLocalDate.localeCompare(right.milestone.targetLocalDate)
    || left.milestone.sortOrder - right.milestone.sortOrder
    || left.milestone.id.localeCompare(right.milestone.id));
  const next = nodes
    .filter((node) => node.state === "active")
    .sort((left, right) => left.milestone.targetLocalDate.localeCompare(right.milestone.targetLocalDate)
      || left.milestone.sortOrder - right.milestone.sortOrder
      || left.milestone.id.localeCompare(right.milestone.id))[0] ?? null;
  return { progress: clampPercent(progress), nodes, next };
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}
