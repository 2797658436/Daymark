import { FolderKanban, Pencil, Sparkles, X } from "lucide-react";
import { Children, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "../ui/button";
import { CARRYOVER_REASON_LABEL, formatPercentPoints, formatRecordedMs, formatTaskProgressRange, type ReviewResult, type ReviewTaskDetail } from "../../lib/review";
import type { ExecutionRecord, ExecutionSession, Task } from "../../lib/native";
import type { WorkspaceIndex } from "../../lib/workspaceSelectors";

/**
 * 回顾的下钻明细（阶段 4 P4-08，规格 §7.4「页面和下钻」；2026-10-20 改成气泡）。
 *
 * 点日期／项目／任务后，在**触发元素下方**弹出一个非模态气泡（`FloatingPanel`
 * `kind="action"`）：点空白、点别的板块、Esc 都会关掉它，页面本身不滚动、不位移。
 * 它是只读投影，不承载草稿；「编辑」再叠一层编辑气泡（那是 `kind="editor"`，点外面
 * 只吞不关、只有取消才丢草稿）。
 *
 * 两条边界：
 * - **明细不是可保存对象**：所有内容都来自 `ReviewResult` 的只读投影与稳定索引，动作只把
 *   **原始** `Task`／`Project` 交给 App，不在页面里拼一个可写对象。
 * - **未知引用不崩页面**：源对象已经不在工作区里时显示「来源不可用」，并保留仍然成立的
 *   事实（例如任务没了但它在周期内的数字还在），不抛错、不整页消失。
 *
 * 排版按「一块事实一张卡」组织：数字卡（`dl`）→ 计数卡（胶囊）→ 记录卡（分节列表）。
 * 卡片是 `--bg` 的凹面，和气泡的 `--panel` 拉开层次，避免一列同权重的灰字堆在一起。
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
}

const SESSION_STATUS_LABEL: Record<ExecutionSession["status"], string> = {
  scheduled: "已安排",
  missed: "明确未推进",
  skipped: "已跳过",
  cancelled: "已取消安排",
};

/** 气泡的可访问名：标题优先，来源不可用时退回对象类型。 */
export function reviewDetailLabel(selection: ReviewSelection, index: WorkspaceIndex) {
  if (selection.kind === "date") return `${formatDayLabel(selection.id)} 的明细`;
  if (selection.kind === "task") return `任务「${index.tasksById.get(selection.id)?.title ?? "来源不可用"}」的明细`;
  return `项目「${index.projectsById.get(selection.id)?.title ?? "来源不可用"}」的明细`;
}

export function ReviewDetail({ index, review, selection, projectId, onClose, onEditTask, onArrangeTask, onOpenProject, onProjectId, onOpenTask }: ReviewDetailProps) {
  const task = selection.kind === "task" ? index.tasksById.get(selection.id) : undefined;
  const project = selection.kind === "project" ? index.projectsById.get(selection.id) : undefined;
  const heading = selection.kind === "date" ? `${formatDayLabel(selection.id)} 明细` : selection.kind === "task" ? task?.title ?? "来源不可用" : project?.title ?? "来源不可用";
  /** 副标题只放**卡里没有**的定位信息：任务属于哪个项目。项目与日期的身份已经由标题和卡片说清，
   *  再写一遍（例如「截止 9月30日」和卡里的「项目截止日期」）就是同一句话出现两次。 */
  const subtitle = selection.kind === "task"
    ? (task?.projectId ? index.projectsById.get(task.projectId)?.title ?? "来源不可用" : "独立任务")
    : null;

  const actions = selection.kind === "task" && task
    ? <TaskActions task={task} projectTitle={task.projectId ? index.projectsById.get(task.projectId)?.title : undefined}
      onEditTask={onEditTask} onArrangeTask={onArrangeTask} onOpenProject={onOpenProject} />
    : selection.kind === "project" && project
      ? <ProjectActions projectId={project.id} projectTitle={project.title} scoped={projectId === project.id}
        onProjectId={onProjectId} onOpenProject={onOpenProject} />
      : null;

  // 正文放不下时在底边做一道淡出：气泡高度按「触发元素下方剩多少」定，内容常常比它长，
  // 没有这道提示，被裁在卡片中间的标题会看着像画坏了。
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);
  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    const check = () => setScrollable(node.scrollHeight > node.clientHeight + 2);
    check();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(check) : null;
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [selection]);

  return <div className="review-detail" data-review-detail={selection.kind}>
    <header className="review-detail-head">
      <div className="review-detail-heading">
        <h2 id="review-detail-title">{heading}</h2>
        {subtitle && <p className="review-detail-sub">{subtitle}</p>}
      </div>
      <button type="button" className="icon-action review-detail-close" aria-label="关闭明细" onClick={onClose}><X size={16} /></button>
    </header>

    <div ref={bodyRef} className={scrollable ? "review-detail-body is-scrollable" : "review-detail-body"}>
      {selection.kind === "date" && <DateDetail review={review} index={index} date={selection.id} onOpenTask={onOpenTask} />}
      {selection.kind === "task" && (task
        ? <TaskDetail index={index} detail={review.tasks.find((item) => item.taskId === selection.id)} task={task} onOpenProject={onOpenProject} />
        : <p className="review-notice" role="status">来源不可用：这个任务已经不在工作区里。它在当前周期内的事实也不再出现在明细中，页面其余部分仍然成立。</p>)}
      {selection.kind === "project" && (project
        ? <ProjectDetail review={review} index={index} projectId={project.id} onOpenTask={onOpenTask} />
        : <p className="review-notice" role="status">来源不可用：这个项目已经不在工作区里。页面其余部分仍然成立。</p>)}
    </div>

    {actions && <footer className="review-detail-foot">{actions}</footer>}
  </div>;
}

function DateDetail({ review, index, date, onOpenTask }: { review: ReviewResult; index: WorkspaceIndex; date: string; onOpenTask: (taskId: string, trigger: HTMLElement) => void }) {
  const day = review.days.find((item) => item.date === date);
  if (!day) return <p className="review-notice" role="status">该日期不在当前周期内：查询已经改变，这一天的汇总不再成立。</p>;
  /** 任务还在工作区里时可继续下钻；已经不在时显示「来源不可用」而不是造一个空链接。 */
  const TaskName = ({ taskId }: { taskId: string }) => {
    const title = index.tasksById.get(taskId)?.title ?? null;
    return title
      ? <button type="button" className="review-inline-link" data-review-trigger={`task:${taskId}`} aria-label={`查看任务「${title}」的明细`} onClick={(event) => onOpenTask(taskId, event.currentTarget)}>{title}</button>
      : <span className="review-muted">来源不可用</span>;
  };

  return <>
    <section className="review-detail-card" aria-label="这一天">
      <dl className="review-detail-stats">
        <Fact label="净进度变化" value={formatPercentPoints(day.progressDelta)} />
        <Fact label="实际投入" value={formatRecordedMs(day.recordedMs)} />
        <Fact label="待回顾" value={`${day.pendingReviewCount} 个时段`} />
        <Fact label="明确未推进" value={`${day.notAdvancedCount} 个时段`} />
        <Fact label="跳过／取消" value={`${day.skippedCount} 条`} />
        <Fact label="进行中的执行" value={`${day.runningCount} 条`} />
      </dl>
    </section>

    <section className="review-detail-card" aria-label="记录">
      <Block title="进度事件" empty="这一天没有进度事件。">
        {day.events.map((event) => <li key={event.id}>
          <time>{formatClock(event.occurredAtUtc)}</time>
          <TaskName taskId={event.taskId} />
          <span className="review-detail-value">{event.fromProgress}% → {event.toProgress}%</span>
        </li>)}
      </Block>
      <Block title="实际记录" empty="这一天没有已结束的实际记录；未记录不等于失败。">
        {day.records.map((record) => <li key={record.id}>
          <time>{formatRecordRange(record)}</time>
          <TaskName taskId={record.taskId} />
          <span className="review-detail-row-note">{record.note ? record.note : "没有留下备注"}</span>
        </li>)}
      </Block>
      {day.runningCount > 0 && <p className="review-detail-note">这一天还有 {day.runningCount} 条进行中的执行：它们没有结束时间，不计入已记录投入。</p>}
    </section>
  </>;
}

function TaskDetail({ index, detail, task, onOpenProject }: {
  index: WorkspaceIndex;
  detail: ReviewTaskDetail | undefined;
  task: Task;
  onOpenProject: (projectId: string, milestoneId: string | null) => void;
}) {
  const executionCounts = detail ? [detail.pendingReviewCount, detail.missedCount, detail.skippedCount] : [];
  return <>
    <section className="review-detail-card" aria-label="本周期">
      {detail
        // 「净进度变化」不单列：它就是区间两端之差，同一句话不写两遍。
        ? <dl className="review-detail-stats">
          <Fact label="周期内进度" value={formatTaskProgressRange(detail)} />
          <Fact label="实际投入" value={formatRecordedMs(detail.recordedMs)} />
          <Fact label="当前完成度" value={`${task.progress}%`} />
        </dl>
        : <p className="review-detail-note">该任务在当前周期内没有事实。</p>}
      <p className="review-detail-note">当前完成度是当前值，不是周期历史。</p>
    </section>

    {detail && <section className="review-detail-card" aria-label="执行">
      {/* 只列非零项：三个「0」说的是同一件事，排成三个胶囊反而占掉一行。 */}
      {executionCounts.length > 0
        ? <ul className="review-detail-chips">
          {detail.pendingReviewCount > 0 && <li>待回顾 <b>{detail.pendingReviewCount}</b></li>}
          {detail.missedCount > 0 && <li>明确未推进 <b>{detail.missedCount}</b></li>}
          {detail.skippedCount > 0 && <li>跳过／取消 <b>{detail.skippedCount}</b></li>}
        </ul>
        : <p className="review-detail-note">本周期没有待回顾、未推进或跳过的时段。</p>}
      {/* 待续是「要不要接着做」的结论，不跟计数混在一排胶囊里 —— 它有自己的标记和原因。 */}
      {detail.carryover
        ? <p className="review-detail-flag-line"><span className="review-detail-flag">待续</span><span>{detail.carryoverReasons.map((reason) => CARRYOVER_REASON_LABEL[reason]).join("；")}</span></p>
        : executionCounts.length > 0 && <p className="review-detail-note">没有待续原因。</p>}
    </section>}

    {detail && <section className="review-detail-card" aria-label="记录">
      <Block title="进度事件" empty="本周期没有进度事件，因此不显示历史起止；不从当前完成度反推。">
        {detail.events.map((event) => <li key={event.id}>
          <time>{formatDateTime(event.occurredAtUtc)}</time>
          <span className="review-detail-value">{event.fromProgress}% → {event.toProgress}%</span>
        </li>)}
      </Block>
      <Block title="计划时段" empty="本周期没有计划时段。">
        {detail.sessions.map((session) => <li key={session.id}>
          <time>{formatDayLabel(session.localDate)} {session.startLocal}–{session.endLocal}</time>
          <span className="review-detail-row-note">{SESSION_STATUS_LABEL[session.status]}{session.status === "missed" && (index.recordsBySessionId.get(session.id)?.length ?? 0) > 0
            ? " · 已补录执行记录（按实际投入计入，不重复记为未推进）" : ""}</span>
        </li>)}
      </Block>
      <Block title="已记录实际" empty="本周期没有已结束的实际记录：显示「未记录」，不写成 0% 执行率。">
        {detail.records.map((record) => <li key={record.id}>
          <time>{formatRecordRange(record)}</time>
          <span className="review-detail-row-note">{record.note ? record.note : "没有留下备注"}</span>
        </li>)}
      </Block>
      {detail.runningRecords.length > 0 && <Block title="进行中" empty="">
        {detail.runningRecords.map((record) => <li key={record.id}>
          <time>开始于 {formatDateTime(record.actualStartUtc)}</time>
          <span className="review-detail-row-note">没有结束时间，不计入已记录投入</span>
        </li>)}
      </Block>}
    </section>}
  </>;
}

function ProjectDetail({ review, index, projectId, onOpenTask }: {
  review: ReviewResult;
  index: WorkspaceIndex;
  projectId: string;
  onOpenTask: (taskId: string, trigger: HTMLElement) => void;
}) {
  // 明细只列出引擎已经算好的行：不在页面里对任务再求一次和，避免长出第二套口径。
  const tasks = review.tasks.filter((detail) => detail.projectId === projectId);
  const milestones = review.milestones.filter((milestone) => milestone.projectId === projectId);

  return <>
    <section className="review-detail-card" aria-label="这个项目">
      <dl className="review-detail-stats">
        <Fact label="周期内有事实的任务" value={`${tasks.length} 项`} />
        <Fact label="周期内到期的里程碑" value={`${milestones.length} 个`} />
        <Fact label="项目截止日期" value={index.projectsById.get(projectId)?.deadlineLocal ?? "未设置"} />
      </dl>
    </section>

    <section className="review-detail-card" aria-label="任务">
      <Block title="任务" empty="这个项目在本周期内没有任务事实。">
        {tasks.map((detail) => <li key={detail.taskId} className="review-detail-stack" data-review-detail-task={detail.taskId}>
          {index.tasksById.get(detail.taskId)
            ? <button type="button" className="review-inline-link review-detail-stack-title" data-review-trigger={`task:${detail.taskId}`} aria-label={`查看任务「${detail.title}」的明细`} onClick={(event) => onOpenTask(detail.taskId, event.currentTarget)}>{detail.title}</button>
            : <strong className="review-detail-stack-title">{detail.title}</strong>}
          <span className="review-detail-row-note">{formatTaskProgressRange(detail)} · 投入 {formatRecordedMs(detail.recordedMs)}{detail.carryover ? " · 待续" : ""}</span>
        </li>)}
      </Block>
    </section>

    <section className="review-detail-card" aria-label="里程碑">
      <Block title="里程碑" empty="这个项目在本周期内没有到期里程碑。">
        {milestones.map((milestone) => <li key={milestone.milestoneId} className="review-detail-stack">
          <strong className="review-detail-stack-title">{milestone.title}</strong>
          <span className="review-detail-row-note">{milestone.frozen ? `${formatDayLabel(milestone.targetLocalDate)} · ` : ""}{milestone.reached ? "达成" : "未达成"}{milestone.frozen ? "（到期冻结，后续推进不改写这个结果）" : ""} · {milestone.resultText}</span>
        </li>)}
      </Block>
    </section>
  </>;
}

function TaskActions({ task, projectTitle, onEditTask, onArrangeTask, onOpenProject }: {
  task: Task;
  projectTitle: string | undefined;
  onEditTask: (task: Task, anchorElement: HTMLElement) => void;
  onArrangeTask: (task: Task) => void;
  onOpenProject: (projectId: string, milestoneId: string | null) => void;
}) {
  return <>
    <Button aria-label={`编辑任务 ${task.title}`} onClick={(event) => onEditTask(task, event.currentTarget)}><Pencil size={14} />编辑</Button>
    {task.status === "active"
      ? <Button variant="primary" aria-label={`安排任务 ${task.title}`} onClick={() => onArrangeTask(task)}><Sparkles size={14} />安排</Button>
      : <span className="muted-chip">{task.status === "paused" ? "已暂停，不能重新安排" : "已完成"}</span>}
    {task.projectId && <Button aria-label={`定位项目 ${projectTitle ?? "来源不可用"}`} onClick={() => onOpenProject(task.projectId!, null)}><FolderKanban size={14} />定位项目</Button>}
  </>;
}

function ProjectActions({ projectId, projectTitle, scoped, onProjectId, onOpenProject }: {
  projectId: string;
  projectTitle: string;
  scoped: boolean;
  onProjectId: (projectId: string | null) => void;
  onOpenProject: (projectId: string, milestoneId: string | null) => void;
}) {
  return <>
    {scoped
      ? <Button onClick={() => onProjectId(null)}>清除项目筛选</Button>
      : <Button variant="primary" onClick={() => onProjectId(projectId)}>只看这个项目</Button>}
    <Button aria-label={`定位项目 ${projectTitle}`} onClick={() => onOpenProject(projectId, null)}><FolderKanban size={14} />定位项目</Button>
  </>;
}

/** 一块带小标题的记录区：有内容就排成列表，没有就留一句说明（不留空块）。 */
function Block({ title, empty, children }: { title: string; empty: string; children?: ReactNode }) {
  const items = Children.toArray(children);
  return <div className="review-detail-block">
    <h3 className="review-detail-block-title">{title}</h3>
    {items.length > 0 ? <ul className="review-detail-list">{children}</ul> : <p className="review-detail-empty">{empty}</p>}
  </div>;
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
