import { FolderKanban, Pencil, Sparkles, X } from "lucide-react";
import type { KeyboardEvent, RefObject } from "react";

import { Button } from "../ui/button";
import { CARRYOVER_REASON_LABEL, formatPercentPoints, formatRecordedMs, formatTaskProgressRange, type ReviewResult, type ReviewTaskDetail } from "../../lib/review";
import type { ExecutionRecord, ExecutionSession, Task } from "../../lib/native";
import type { WorkspaceIndex } from "../../lib/workspaceSelectors";

/**
 * 回顾的页面内明细区（阶段 4 P4-08，规格 §7.4「页面和下钻」）。
 *
 * 点击或键盘激活**日期／项目／任务**后在这里展开：显示原始事件时间、进度变化、实际起止
 * 与已记录备注。它是页面内的区域而不是模态：Tab 可以进出，Esc 关闭，关闭后由调用方
 * 把焦点还给触发元素并恢复打开前的滚动位置（与既有编辑气泡、截止页同一套做法）。
 *
 * 两条边界：
 * - **明细不是可保存对象**：所有内容都来自 `ReviewResult` 的只读投影与稳定索引，行级
 *   动作只把**原始** `Task`／`Project` 交给 App，不在页面里拼一个可写对象。
 * - **未知引用不崩页面**：源对象已经不在工作区里时显示「来源不可用」，并保留仍然成立的
 *   事实（例如任务没了但它在周期内的数字还在），不抛错、不整页消失。
 */

export interface ReviewSelection {
  kind: "date" | "project" | "task";
  /** 原始对象的 ID（日期就是本地日期）。 */
  id: string;
}

export interface ReviewDetailProps {
  index: WorkspaceIndex;
  review: ReviewResult;
  selection: ReviewSelection;
  /** 当前的项目筛选（引擎查询的一部分）；用于在明细里切换「只看这个项目」。 */
  projectId: string | null;
  onClose: () => void;
  onEditTask: (task: Task, anchorElement: HTMLElement) => void;
  onArrangeTask: (task: Task) => void;
  onOpenProject: (projectId: string, milestoneId: string | null) => void;
  onProjectId: (projectId: string | null) => void;
  /** 从某一天的明细继续下钻到任务。 */
  onOpenTask: (taskId: string, trigger: HTMLElement) => void;
  /** 明细区容器（`tabIndex=-1`）；打开时由页面聚焦它，Esc 才能落在自己的处理函数里。 */
  containerRef?: RefObject<HTMLElement | null>;
}

const SESSION_STATUS_LABEL: Record<ExecutionSession["status"], string> = {
  scheduled: "已安排",
  missed: "明确未推进",
  skipped: "已跳过",
  cancelled: "已取消安排",
};


export function ReviewDetail({ index, review, selection, projectId, onClose, onEditTask, onArrangeTask, onOpenProject, onProjectId, onOpenTask, containerRef }: ReviewDetailProps) {
  const task = selection.kind === "task" ? index.tasksById.get(selection.id) : undefined;
  const project = selection.kind === "project" ? index.projectsById.get(selection.id) : undefined;
  const heading = selection.kind === "date" ? `${formatDayLabel(selection.id)} 明细` : selection.kind === "task" ? task?.title ?? "来源不可用" : project?.title ?? "来源不可用";

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    // 明细区不是模态：它只处理落在自己内部（含刚打开时聚焦的容器）的 Esc。
    event.stopPropagation();
    onClose();
  };

  return <section ref={containerRef} className="surface-card review-drilldown" data-review-detail={selection.kind} aria-labelledby="review-detail-title" tabIndex={-1} onKeyDown={handleKeyDown}>
    <div className="section-heading">
      <h2 id="review-detail-title">{heading}</h2>
      <Button aria-label="关闭明细" onClick={onClose}><X size={15} />关闭</Button>
    </div>
    {selection.kind === "date" && <DateDetail review={review} index={index} date={selection.id} onOpenTask={onOpenTask} />}
    {selection.kind === "task" && (task
      ? <TaskDetail index={index} detail={review.tasks.find((item) => item.taskId === selection.id)} task={task} onEditTask={onEditTask} onArrangeTask={onArrangeTask} onOpenProject={onOpenProject} />
      : <p className="review-notice" role="status">来源不可用：这个任务已经不在工作区里。它在当前周期内的事实也不再出现在明细中，页面其余部分仍然成立。</p>)}
    {selection.kind === "project" && (project
      ? <ProjectDetail review={review} index={index} projectId={project.id} projectTitle={project.title} scoped={projectId === project.id} onProjectId={onProjectId} onOpenProject={onOpenProject} />
      : <p className="review-notice" role="status">来源不可用：这个项目已经不在工作区里。页面其余部分仍然成立。</p>)}
  </section>;
}

function DateDetail({ review, index, date, onOpenTask }: { review: ReviewResult; index: WorkspaceIndex; date: string; onOpenTask: (taskId: string, trigger: HTMLElement) => void }) {
  const day = review.days.find((item) => item.date === date);
  if (!day) return <p className="review-notice" role="status">该日期不在当前周期内：查询已经改变，这一天的汇总不再成立。</p>;
  /** 任务还在工作区里时可继续下钻；已经不在时显示「来源不可用」而不是造一个空链接。 */
  const nameOf = (taskId: string) => index.tasksById.get(taskId)?.title ?? null;
  const TaskName = ({ taskId }: { taskId: string }) => {
    const title = nameOf(taskId);
    return title
      ? <button type="button" className="review-inline-link" data-review-trigger={`task:${taskId}`} aria-label={`查看任务「${title}」的明细`} onClick={(event) => onOpenTask(taskId, event.currentTarget)}>{title}</button>
      : <span className="review-muted">来源不可用</span>;
  };

  return <>
    <dl className="review-detail-facts">
      <Fact label="净进度变化" value={formatPercentPoints(day.progressDelta)} />
      <Fact label="实际投入" value={formatRecordedMs(day.recordedMs)} />
      <Fact label="待回顾" value={`${day.pendingReviewCount} 个时段`} />
      <Fact label="明确未推进" value={`${day.notAdvancedCount} 个时段`} />
      <Fact label="跳过／取消安排" value={`${day.skippedCount} 条`} />
      <Fact label="进行中的执行" value={`${day.runningCount} 条`} />
    </dl>
    <h3>进度事件</h3>
    {day.events.length > 0
      ? <ul className="review-detail-list">{day.events.map((event) => <li key={event.id}>
        <time>{formatClock(event.occurredAtUtc)}</time><TaskName taskId={event.taskId} />
        <span>{event.fromProgress}% → {event.toProgress}%</span>
      </li>)}</ul>
      : <p className="review-muted">这一天没有进度事件。</p>}
    <h3>实际记录</h3>
    {day.records.length > 0
      ? <ul className="review-detail-list">{day.records.map((record) => <li key={record.id}>
        <time>{formatRecordRange(record)}</time><TaskName taskId={record.taskId} />
        <span>{record.note ? record.note : "没有留下备注"}</span>
      </li>)}</ul>
      : <p className="review-muted">这一天没有已结束的实际记录；未记录不等于失败。</p>}
    {day.runningCount > 0 && <p className="review-muted">这一天还有 {day.runningCount} 条进行中的执行：它们没有结束时间，不计入已记录投入。</p>}
  </>;
}

function TaskDetail({ index, detail, task, onEditTask, onArrangeTask, onOpenProject }: {
  index: WorkspaceIndex;
  detail: ReviewTaskDetail | undefined;
  task: Task;
  onEditTask: (task: Task, anchorElement: HTMLElement) => void;
  onArrangeTask: (task: Task) => void;
  onOpenProject: (projectId: string, milestoneId: string | null) => void;
}) {
  const project = task.projectId ? index.projectsById.get(task.projectId) : undefined;

  return <>
    {detail
      ? <dl className="review-detail-facts">
        <Fact label="周期内进度" value={formatTaskProgressRange(detail)} />
        <Fact label="净进度变化" value={formatPercentPoints(detail.netDelta)} />
        <Fact label="当前完成度" value={`${task.progress}%（当前值，不是周期历史）`} />
        <Fact label="实际投入" value={formatRecordedMs(detail.recordedMs)} />
        <Fact label="待回顾" value={`${detail.pendingReviewCount} 个时段`} />
        <Fact label="明确未推进" value={`${detail.missedCount} 个时段`} />
        <Fact label="跳过／取消安排" value={`${detail.skippedCount} 条`} />
        <Fact label="待续" value={detail.carryover ? `是 · ${detail.carryoverReasons.map((reason) => CARRYOVER_REASON_LABEL[reason]).join("；")}` : "否"} />
      </dl>
      : <p className="review-notice" role="status">该任务在当前周期内没有事实。当前完成度 {task.progress}% 是**当前值**，不是这一周期的历史。</p>}

    <h3>进度事件</h3>
    {detail && detail.events.length > 0
      ? <ul className="review-detail-list">{detail.events.map((event) => <li key={event.id}>
        <time>{formatDateTime(event.occurredAtUtc)}</time>
        <span>{event.fromProgress}% → {event.toProgress}%</span>
      </li>)}</ul>
      : <p className="review-muted">本周期没有进度事件，因此不显示历史起止；不从当前完成度反推。</p>}

    <h3>计划时段</h3>
    {detail && detail.sessions.length > 0
      ? <ul className="review-detail-list">{detail.sessions.map((session) => <li key={session.id}>
        <time>{formatDayLabel(session.localDate)} {session.startLocal}–{session.endLocal}</time>
        <span>{SESSION_STATUS_LABEL[session.status]}{session.status === "missed" && (index.recordsBySessionId.get(session.id)?.length ?? 0) > 0
          ? " · 已补录执行记录（按实际投入计入，不重复记为未推进）" : ""}</span>
      </li>)}</ul>
      : <p className="review-muted">本周期没有计划时段。</p>}

    <h3>已记录实际</h3>
    {detail && detail.records.length > 0
      ? <ul className="review-detail-list">{detail.records.map((record) => <li key={record.id}>
        <time>{formatRecordRange(record)}</time>
        <span>{record.note ? record.note : "没有留下备注"}</span>
      </li>)}</ul>
      : <p className="review-muted">本周期没有已结束的实际记录：显示「未记录」，不写成 0% 执行率。</p>}
    {detail && detail.runningRecords.length > 0 && <ul className="review-detail-list">{detail.runningRecords.map((record) => <li key={record.id}>
      <time>开始于 {formatDateTime(record.actualStartUtc)}</time><span>进行中，不计入已记录投入</span>
    </li>)}</ul>}

    <div className="review-detail-actions">
      <Button aria-label={`编辑任务 ${task.title}`} onClick={(event) => onEditTask(task, event.currentTarget)}><Pencil size={14} />编辑</Button>
      {task.status === "active"
        ? <Button variant="primary" aria-label={`安排任务 ${task.title}`} onClick={() => onArrangeTask(task)}><Sparkles size={14} />安排</Button>
        : <span className="muted-chip">{task.status === "paused" ? "已暂停，不能重新安排" : "已完成"}</span>}
      {task.projectId && <Button aria-label={`定位项目 ${project?.title ?? "来源不可用"}`} onClick={() => onOpenProject(task.projectId!, null)}><FolderKanban size={14} />定位项目</Button>}
    </div>
  </>;
}

function ProjectDetail({ review, index, projectId, projectTitle, scoped, onProjectId, onOpenProject }: {
  review: ReviewResult;
  index: WorkspaceIndex;
  projectId: string;
  projectTitle: string;
  scoped: boolean;
  onProjectId: (projectId: string | null) => void;
  onOpenProject: (projectId: string, milestoneId: string | null) => void;
}) {
  // 明细只列出引擎已经算好的行：不在页面里对任务再求一次和，避免长出第二套口径。
  const tasks = review.tasks.filter((detail) => detail.projectId === projectId);
  const milestones = review.milestones.filter((milestone) => milestone.projectId === projectId);

  return <>
    <dl className="review-detail-facts">
      <Fact label="周期内有事实的任务" value={`${tasks.length} 项`} />
      <Fact label="周期内到期的里程碑" value={`${milestones.length} 个`} />
      <Fact label="项目截止日期" value={index.projectsById.get(projectId)?.deadlineLocal ?? "未设置"} />
    </dl>

    <h3>任务</h3>
    {tasks.length > 0
      ? <ul className="review-detail-list">{tasks.map((detail) => <li key={detail.taskId} data-review-detail-task={detail.taskId}>
        <strong>{detail.title}</strong>
        <span>{formatTaskProgressRange(detail)}</span>
        <span>净变化 {formatPercentPoints(detail.netDelta)}</span>
        <span>投入 {formatRecordedMs(detail.recordedMs)}</span>
        {detail.carryover && <span className="muted-chip">待续</span>}
      </li>)}</ul>
      : <p className="review-muted">这个项目在本周期内没有任务事实。</p>}

    <h3>里程碑</h3>
    {milestones.length > 0
      ? <ul className="review-detail-list">{milestones.map((milestone) => <li key={milestone.milestoneId}>
        <strong>{milestone.title}</strong>
        <span>{formatDayLabel(milestone.targetLocalDate)}</span>
        <span>{milestone.reached ? "达成" : "未达成"}{milestone.frozen ? "（到期冻结，后续推进不改写这个结果）" : "（当前达成情况）"}</span>
        <span>{milestone.resultText}</span>
      </li>)}</ul>
      : <p className="review-muted">这个项目在本周期内没有到期里程碑。</p>}

    <div className="review-detail-actions">
      {scoped
        ? <Button onClick={() => onProjectId(null)}>清除项目筛选</Button>
        : <Button variant="primary" onClick={() => onProjectId(projectId)}>只看这个项目</Button>}
      <Button aria-label={`定位项目 ${projectTitle}`} onClick={() => onOpenProject(projectId, null)}><FolderKanban size={14} />定位项目</Button>
    </div>
  </>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

/**
 * 模块级复用格式化器：`Intl.DateTimeFormat` 的**构造**很贵（每次几十微秒），而月回顾一次
 * 渲染要调 `formatDayLabel` 约 200 次（两张数值表的 62 个日期 + 待回顾 61 + 里程碑 12 +
 * 未推进 73 + 标题）。此前每次调用都新建一个实例，等于每帧重算同一个派生值 —— 规格 §8
 * 点名的模式。
 */
const DAY_LABEL_FORMAT = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" });
const CLOCK_FORMAT = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });

/** 本地日期的短标签：`8 月 5 日`。 */
export function formatDayLabel(date: string) {
  return DAY_LABEL_FORMAT.format(new Date(`${date}T12:00:00`));
}

function formatClock(iso: string) {
  return CLOCK_FORMAT.format(new Date(iso));
}

function formatDateTime(iso: string) {
  return `${DAY_LABEL_FORMAT.format(new Date(iso))} ${formatClock(iso)}`;
}

/** 实际起止：跨午夜时把结束侧的日期也写出来，不靠读者自己推断。 */
function formatRecordRange(record: ExecutionRecord) {
  const start = formatDateTime(record.actualStartUtc);
  if (!record.actualEndUtc) return `${start} 起 · 进行中`;
  const endDate = DAY_LABEL_FORMAT.format(new Date(record.actualEndUtc));
  const sameDay = endDate === DAY_LABEL_FORMAT.format(new Date(record.actualStartUtc));
  return `${start} — ${sameDay ? "" : `${endDate} `}${formatClock(record.actualEndUtc)}`;
}
