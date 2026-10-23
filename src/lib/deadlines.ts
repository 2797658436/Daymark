import type { Task, TaskStatus, WorkspaceSnapshot } from "./native";
import { createWorkspaceIndex, milestoneReached, projectProgress, projectTasksOf, type WorkspaceIndex } from "./workspaceSelectors";

/**
 * 截止事项投影（阶段 4 P4-06，规格 §6.1 / M10）。
 *
 * 由现有工作区快照派生记录，**不建立截止事项表、不新增 SQLite 字段**：任务用自己的
 * `deadlineLocal`，项目用自己声明的 `deadlineLocal`（不得用子任务最后日期替代），
 * 里程碑用自己的 `targetLocalDate`。本模块是纯投影，不写任何领域事实。
 *
 * 日期运算一律走本地日历（`addLocalDays` / `localDaysBetween` 用 UTC 日历字段做整数
 * 加减），**不除以固定 24 小时**推算天数差 —— 夏令时切换的那一天会差一小时，
 * 按毫秒除法算出来的「未来七天」边界会提前或推后一天。
 */

export type DeadlineKind = "task" | "project" | "milestone";
/**
 * 截止事项的呈现状态。
 *
 * 三种状态是给里程碑的：`open` 未达成、`currentlyReached` 当前已达成、
 * `frozenUnmet` 到期冻结时未达成。任务与项目本身没有「达成」概念（项目也没有完成
 * 字段），它们的过滤由各自的 `status` 与项目筛选承担，因此固定为 `open`。
 */
export type DeadlineState = "open" | "currentlyReached" | "frozenUnmet";
export type DeadlineGroup = "overdue" | "today" | "nextSevenDays" | "later";

export interface DeadlineItem {
  /** `kind + sourceId`；同一个源对象在列表里身份稳定。 */
  key: string;
  kind: DeadlineKind;
  /** 源对象自己的 ID。任务详情仍使用这个原始 ID，不能把派生项当可保存对象。 */
  sourceId: string;
  /** 里程碑与项目为项目 ID，任务为所属项目（独立任务为 null）。 */
  projectId: string | null;
  date: string;
  title: string;
  state: DeadlineState;
}

export interface DeadlineFilter {
  /** 显示哪些类型。 */
  kinds: readonly DeadlineKind[];
  /** `null` 表示全部项目（含独立任务）；否则只显示该项目自己的截止事项。 */
  projectId: string | null;
  /** 任务状态；默认只显示 `active`，可显式加入 `completed` / `paused`。 */
  taskStatuses: readonly TaskStatus[];
  /** 是否显示「当前已达成但未冻结」的里程碑；默认隐藏。 */
  includeReachedMilestones: boolean;
  /** 关键字，匹配标题；只筛选，不改变排序与内容。 */
  query: string;
}

export interface DeadlineGroupBucket {
  group: DeadlineGroup;
  title: string;
  items: DeadlineItem[];
}

export const DEADLINE_KIND_ORDER = ["task", "project", "milestone"] as const;
export const DEADLINE_GROUP_ORDER = ["overdue", "today", "nextSevenDays", "later"] as const;

export const DEADLINE_KIND_LABEL: Record<DeadlineKind, string> = { task: "任务", project: "项目", milestone: "里程碑" };
export const DEADLINE_GROUP_LABEL: Record<DeadlineGroup, string> = { overdue: "已逾期", today: "今天", nextSevenDays: "未来七天", later: "以后" };

export const DEFAULT_DEADLINE_FILTER: DeadlineFilter = {
  kinds: DEADLINE_KIND_ORDER,
  projectId: null,
  taskStatuses: ["active"],
  includeReachedMilestones: false,
  query: "",
};

/** 类型固定顺序：任务 → 项目 → 里程碑（规格 §6.1 的排序第二级）。 */
const KIND_RANK: Record<DeadlineKind, number> = { task: 0, project: 1, milestone: 2 };

/** 由快照直接投影；内部建一次索引，行为与 `buildDeadlineItemsFromIndex` 完全一致。 */
export function buildDeadlineItems(workspace: WorkspaceSnapshot, today: string, filter: DeadlineFilter = DEFAULT_DEADLINE_FILTER): DeadlineItem[] {
  return buildDeadlineItemsFromIndex(createWorkspaceIndex(workspace), today, filter);
}

/**
 * 与 `buildDeadlineItems` 同一实现，复用调用方已经建好的索引（页面只建一次索引，
 * 不为了投影再扫一遍全量数组）。
 */
export function buildDeadlineItemsFromIndex(index: WorkspaceIndex, today: string, filter: DeadlineFilter = DEFAULT_DEADLINE_FILTER): DeadlineItem[] {
  const kinds = new Set(filter.kinds);
  const statuses = new Set(filter.taskStatuses);
  const query = filter.query.trim().toLowerCase();
  const matches = (title: string) => !query || title.toLowerCase().includes(query);
  const inScope = (projectId: string | null) => filter.projectId === null || projectId === filter.projectId;

  const sortable: Array<{ item: DeadlineItem; sortOrder: number; orderKey: string }> = [];
  const push = (item: DeadlineItem, sortOrder: number, orderKey: string) => {
    if (!matches(item.title)) return;
    sortable.push({ item, sortOrder, orderKey });
  };

  if (kinds.has("task")) {
    for (const task of index.workspace.tasks) {
      // 习惯内部任务不是用户口中的「任务」，不进入普通截止视图；没有截止日期的任务不出现。
      if (task.kind === "habit") continue;
      if (!task.deadlineLocal) continue;
      if (!statuses.has(task.status)) continue;
      if (!inScope(task.projectId)) continue;
      push({ key: `task:${task.id}`, kind: "task", sourceId: task.id, projectId: task.projectId, date: task.deadlineLocal, title: task.title, state: "open" }, task.sortOrder, "");
    }
  }

  if (kinds.has("project")) {
    for (const project of index.workspace.projects) {
      // 只读项目自己声明的截止日期；项目没有完成字段，因此也不因任务达成自动隐藏。
      if (!project.deadlineLocal) continue;
      if (!inScope(project.id)) continue;
      // 项目没有 sortOrder 字段：同一日期下按标题排序，仍由稳定 ID 收尾。
      push({ key: `project:${project.id}`, kind: "project", sourceId: project.id, projectId: project.id, date: project.deadlineLocal, title: project.title, state: "open" }, 0, project.title);
    }
  }

  if (kinds.has("milestone")) {
    for (const milestone of index.workspace.projectMilestones) {
      if (!inScope(milestone.projectId)) continue;
      const state = deadlineStateOf(index, milestone.id);
      // 默认只显示未达成与到期未达成；当前达成项要显式切换才出现。
      if (state === "currentlyReached" && !filter.includeReachedMilestones) continue;
      push({ key: `milestone:${milestone.id}`, kind: "milestone", sourceId: milestone.id, projectId: milestone.projectId, date: milestone.targetLocalDate, title: milestone.title, state }, milestone.sortOrder, "");
    }
  }

  sortable.sort((left, right) => {
    if (left.item.date !== right.item.date) return left.item.date < right.item.date ? -1 : 1;
    const rank = KIND_RANK[left.item.kind] - KIND_RANK[right.item.kind];
    if (rank !== 0) return rank;
    if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
    if (left.orderKey !== right.orderKey) return left.orderKey < right.orderKey ? -1 : 1;
    return compareIds(left.item.sourceId, right.item.sourceId);
  });
  return sortable.map((entry) => entry.item);
}

/**
 * 里程碑的呈现状态：**优先读冻结结果**。
 *
 * 已经冻结的里程碑属于历史记录：到期未达成的结果不因之后推进而改写，也不因为
 * 现在达成而变成「已达成」。只有没有冻结结果的里程碑才按 M7 的同一规则派生当前
 * 是否达成（`milestoneReached`，与项目页共用一套）。
 */
export function deadlineStateOf(index: WorkspaceIndex, milestoneId: string): DeadlineState {
  const outcome = index.outcomesByMilestoneId.get(milestoneId);
  if (outcome) return outcome.reached ? "currentlyReached" : "frozenUnmet";
  const milestone = index.milestonesById.get(milestoneId);
  if (!milestone) return "open";
  const tasks = projectTasksOf(index, milestone.projectId);
  return milestoneReached(milestone, tasks, projectProgress(tasks)) ? "currentlyReached" : "open";
}

/**
 * 日期分组。`nextSevenDays` 是 **tomorrow 至 today+7**，边界用本地日历加法得到，
 * 不用固定 24 小时换算。
 */
export function deadlineGroupOf(date: string, today: string): DeadlineGroup {
  if (date < today) return "overdue";
  if (date === today) return "today";
  if (date <= addLocalDays(today, 7)) return "nextSevenDays";
  return "later";
}

/** 按分组顺序切分已经排好序的列表；空分组不返回。 */
export function groupDeadlineItems(items: readonly DeadlineItem[], today: string): DeadlineGroupBucket[] {
  const buckets = new Map<DeadlineGroup, DeadlineItem[]>();
  for (const item of items) {
    const group = deadlineGroupOf(item.date, today);
    const bucket = buckets.get(group);
    if (bucket) bucket.push(item);
    else buckets.set(group, [item]);
  }
  return DEADLINE_GROUP_ORDER.filter((group) => buckets.has(group))
    .map((group) => ({ group, title: DEADLINE_GROUP_LABEL[group], items: buckets.get(group)! }));
}

/** 是否等于默认筛选（用于区分「无数据」与「筛选无匹配」两种空状态）。 */
export function isDefaultDeadlineFilter(filter: DeadlineFilter): boolean {
  return filter.projectId === null
    && !filter.includeReachedMilestones
    && filter.query.trim() === ""
    && sameValues(filter.kinds, DEADLINE_KIND_ORDER)
    && sameValues(filter.taskStatuses, ["active"] as const);
}

/** 源对象是否还在工作区里：返回列表时用它判断焦点项是否已经失效。 */
export function deadlineItemSourceExists(index: WorkspaceIndex, key: string): boolean {
  const separator = key.indexOf(":");
  if (separator <= 0) return false;
  const kind = key.slice(0, separator);
  const sourceId = key.slice(separator + 1);
  if (kind === "task") return index.tasksById.has(sourceId);
  if (kind === "project") return index.projectsById.has(sourceId);
  if (kind === "milestone") return index.milestonesById.has(sourceId);
  return false;
}

export function deadlineStateLabel(state: DeadlineState): string {
  return state === "currentlyReached" ? "当前已达成" : state === "frozenUnmet" ? "到期未达成" : "进行中";
}

/**
 * 是否是**真实有效**的本地日期：`2026-02-30` 只过格式不过日历，必须拒绝。
 *
 * 与 `settings.ts` 的规范化同一条判据（按 UTC 日历字段回读比对），放在这里是为了
 * 让只读投影（`deadlines.ts`／`review.ts`）共用一份，而不是各写一份正则。
 */
export function isLocalDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

/** 本地日历加法：按 UTC 日历字段做整数加减，跨月跨年与夏令时都安全。 */
export function addLocalDays(date: string, amount: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + amount));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** 两个本地日期之间的整天数；只比较日历字段，不经过本地时区。 */
export function localDaysBetween(from: string, to: string): number {
  return Math.round((utcMidnight(to) - utcMidnight(from)) / 86_400_000);
}

/**
 * 本地日历**月**加减：先归到目标月的 1 日再按整数月偏移，日号超过目标月长度时收敛到
 * 月末（`2026-01-31` +1 → `2026-02-28`）。
 *
 * 回顾页翻月用它，而不是 `setMonth()`：后者在 1 月 31 日 +1 个月时会先溢出到 3 月 3 日
 * 再回退，得到的是「最近 30 天」式的月份，而不是自然月。与 `addLocalDays` 同源，
 * 只做日历字段的整数运算。
 */
export function addLocalMonths(date: string, amount: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + amount, 1));
  const targetYear = shifted.getUTCFullYear();
  const targetMonth = shifted.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return `${targetYear}-${pad(targetMonth)}-${pad(Math.min(day, lastDay))}`;
}

export function localDateOf(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export function formatDeadlineDate(date: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(new Date(`${date}T12:00:00`));
}

export function formatDeadlineWeekday(date: string): string {
  return new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(new Date(`${date}T12:00:00`));
}

export function deadlineDistanceLabel(date: string, today: string): string {
  const days = localDaysBetween(today, date);
  return days < 0 ? `逾期 ${Math.abs(days)} 天` : days === 0 ? "今天到期" : days === 1 ? "明天到期" : `还有 ${days} 天`;
}

export function taskStatusLabel(task: Task): string {
  return task.status === "completed" ? "已完成" : task.status === "paused" ? "已暂停" : `进度 ${task.progress}%`;
}

function sameValues(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && right.every((value) => left.includes(value));
}

function compareIds(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function utcMidnight(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}
