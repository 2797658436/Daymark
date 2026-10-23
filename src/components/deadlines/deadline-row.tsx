import { Check, Diamond, Flag, FolderKanban, Pencil, RotateCcw, Sparkles, Target } from "lucide-react";

import { Button } from "../ui/button";
import {
  DEADLINE_KIND_LABEL, deadlineDistanceLabel, deadlineStateLabel, formatDeadlineDate, formatDeadlineWeekday, taskStatusLabel, type DeadlineItem,
} from "../../lib/deadlines";
import { milestoneSummary, projectTaskCounts, projectTasksOf, type WorkspaceIndex } from "../../lib/workspaceSelectors";
import type { ProjectMilestone, Task } from "../../lib/native";

/**
 * 截止事项的一行（阶段 4 P4-06，规格 §6.2「页面与动作」）。
 *
 * 行级动作只发出意图，具体编辑器由 `App` 提供：
 * - 任务：复用**既有编辑气泡**（`TaskEditorFields`）与「预选任务的排程入口」
 *   （`AutoScheduleDialog` 的 `initialTaskId`）。这里不复制任何编辑表单。
 * - 项目：定位项目。里程碑：定位项目内具体目标；**冻结目标只有查看／续排**。
 *
 * 暂停对象不能被重新安排，因此不提供排程入口。任务详情始终使用原始 `sourceId`，
 * 派生的 `DeadlineItem` 不是可保存对象。
 */

const KIND_ICON = { task: Check, project: Flag, milestone: Diamond } as const;

export interface DeadlineRowProps {
  index: WorkspaceIndex;
  item: DeadlineItem;
  today: string;
  focused: boolean;
  onFocus: (key: string) => void;
  onEditTask: (task: Task, anchorElement: HTMLElement) => void;
  onArrangeTask: (task: Task) => void;
  onOpenProject: (projectId: string, milestoneId: string | null) => void;
  onContinueMilestone: (milestone: ProjectMilestone) => void;
}

export function DeadlineRow({ index, item, today, focused, onFocus, onEditTask, onArrangeTask, onOpenProject, onContinueMilestone }: DeadlineRowProps) {
  const task = item.kind === "task" ? index.tasksById.get(item.sourceId) : undefined;
  const project = item.kind === "project" ? index.projectsById.get(item.sourceId) : undefined;
  const milestone = item.kind === "milestone" ? index.milestonesById.get(item.sourceId) : undefined;
  const outcome = item.kind === "milestone" ? index.outcomesByMilestoneId.get(item.sourceId) : undefined;
  const sourceMissing = (item.kind === "task" && !task) || (item.kind === "project" && !project) || (item.kind === "milestone" && !milestone);
  const Icon = KIND_ICON[item.kind];

  return <article
    className={focused ? "deadline-row focused" : "deadline-row"}
    data-deadline-key={item.key}
    data-deadline-kind={item.kind}
    data-deadline-state={item.state}
    tabIndex={-1}
    onFocus={() => onFocus(item.key)}
  >
    <div className="deadline-row-main">
      <span className={`deadline-kind ${item.kind}`}><Icon size={13} aria-hidden="true" />{DEADLINE_KIND_LABEL[item.kind]}</span>
      <strong className="deadline-title">{item.title}</strong>
      <span className="deadline-date">{formatDeadlineWeekday(item.date)} {formatDeadlineDate(item.date)} · {deadlineDistanceLabel(item.date, today)}</span>
      <span className="deadline-detail">{sourceMissing ? "来源不可用" : detailOf()}</span>
      {item.kind === "milestone" && <span className={`deadline-state ${item.state}`}>{deadlineStateLabel(item.state)}</span>}
    </div>
    <div className="deadline-actions">
      {sourceMissing ? <span className="muted-chip">来源不可用</span> : actionsOf()}
    </div>
  </article>;

  function detailOf() {
    if (task) return taskStatusLabel(task);
    if (project) {
      // 项目没有完成字段：只说明当前任务完成情况，不声称项目历史上完成。
      const counts = projectTaskCounts(index, project.id);
      return `当前任务 ${counts.completed}/${counts.total} 已完成`;
    }
    if (milestone) {
      if (outcome) return `${outcome.resultText} · ${formatDeadlineDate(outcome.targetLocalDate)}到期冻结`;
      return milestoneSummary(milestone, projectTasksOf(index, milestone.projectId));
    }
    return "";
  }

  function actionsOf() {
    if (task) {
      return <>
        <Button aria-label={`编辑任务 ${task.title}`} onClick={(event) => onEditTask(task, event.currentTarget)}><Pencil size={14} />编辑</Button>
        {task.status === "active"
          ? <Button variant="primary" aria-label={`安排任务 ${task.title}`} onClick={() => onArrangeTask(task)}><Sparkles size={14} />安排</Button>
          : <span className="muted-chip">{task.status === "paused" ? "已暂停，不能重新安排" : "已完成"}</span>}
      </>;
    }
    if (project) {
      return <Button aria-label={`定位项目 ${project.title}`} onClick={() => onOpenProject(project.id, null)}><FolderKanban size={14} />定位项目</Button>;
    }
    if (milestone) {
      return <>
        <Button aria-label={`定位里程碑 ${milestone.title}`} onClick={() => onOpenProject(milestone.projectId, milestone.id)}><Target size={14} />定位目标</Button>
        {/* 冻结未达成属于历史记录：只有查看与续排，不能改写旧结果。 */}
        {outcome && !outcome.reached && <Button aria-label={`续排里程碑 ${milestone.title}`} onClick={() => onContinueMilestone(milestone)}><RotateCcw size={14} />续排</Button>}
      </>;
    }
    return null;
  }
}
