import { Check, Eraser, ListFilter, RotateCcw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { Button } from "../ui/button";
import { DeadlineRow } from "./deadline-row";
import {
  DEADLINE_KIND_LABEL, DEADLINE_KIND_ORDER, DEFAULT_DEADLINE_FILTER, buildDeadlineItemsFromIndex, deadlineGroupOf, deadlineItemSourceExists,
  groupDeadlineItems, isDefaultDeadlineFilter, localDateOf, type DeadlineFilter, type DeadlineKind,
} from "../../lib/deadlines";
import type { WorkspaceIndex } from "../../lib/workspaceSelectors";
import type { ProjectMilestone, Task, TaskStatus } from "../../lib/native";

/**
 * 截止事项页面（阶段 4 P4-06，规格 §6 M10 / §3 导航原则）。
 *
 * 只做「集中查看 + 筛选 + 行级入口」，不复制任何编辑表单：任务走既有编辑气泡与
 * 预选任务的排程入口，项目与里程碑只定位。页面本身是无状态投影，除了两种空状态
 * 之外不持有业务状态。
 *
 * 筛选／焦点项／滚动位置**只放 App 层内存**：同一会话内跨页返回仍然有效，应用重启
 * 后不恢复；它们不写 Tauri Store，也不与搜索文本一并保存（规格 §6.2）。
 */

const TASK_STATUS_OPTIONS: Array<{ value: TaskStatus; label: string }> = [
  { value: "active", label: "进行中" },
  { value: "completed", label: "已完成" },
  { value: "paused", label: "已暂停" },
];

export interface DeadlinesPageProps {
  index: WorkspaceIndex;
  filter: DeadlineFilter;
  onFilterChange: (filter: DeadlineFilter) => void;
  /** 当前焦点项（`DeadlineItem.key`）；返回列表时用它恢复焦点。 */
  focusKey: string | null;
  onFocusKey: (key: string | null) => void;
  /** 列表滚动容器（应用主内容区）与它的滚动位置；位置只放 App 层内存。 */
  scrollRef: RefObject<HTMLElement | null>;
  scrollTop: RefObject<number>;
  onEditTask: (task: Task, anchorElement: HTMLElement) => void;
  onArrangeTask: (task: Task) => void;
  onOpenProject: (projectId: string, milestoneId: string | null) => void;
  onContinueMilestone: (milestone: ProjectMilestone) => void;
}

export function DeadlinesPage({ index, filter, onFilterChange, focusKey, onFocusKey, scrollRef, scrollTop, onEditTask, onArrangeTask, onOpenProject, onContinueMilestone }: DeadlinesPageProps) {
  const now = useCurrentTime();
  const today = localDateOf(now);
  const items = useMemo(() => buildDeadlineItemsFromIndex(index, today, filter), [index, today, filter]);
  const groups = useMemo(() => groupDeadlineItems(items, today), [items, today]);
  const overdueCount = items.filter((item) => deadlineGroupOf(item.date, today) === "overdue").length;
  const filterActive = !isDefaultDeadlineFilter(filter);
  const [staleNotice, setStaleNotice] = useState<string | null>(null);

  // 返回列表时源对象已经不存在：按当前数据刷新（列表本来就从快照重新派生）并给出中性提示。
  useEffect(() => {
    if (!focusKey || deadlineItemSourceExists(index, focusKey)) return;
    setStaleNotice("上次查看的对象已经不存在，列表已按当前数据刷新。");
    onFocusKey(null);
  }, [focusKey, index, onFocusKey]);

  // 进入页面先落滚动位置，再以 preventScroll 恢复焦点 —— 顺序反了的话聚焦会把列表拽走。
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const container = scrollRef.current;
    if (container) container.scrollTop = scrollTop.current;
    if (!focusKey) return;
    const rows = Array.from(container?.querySelectorAll<HTMLElement>("[data-deadline-key]") ?? []);
    rows.find((row) => row.dataset.deadlineKey === focusKey)?.focus({ preventScroll: true });
    // 只在挂载时恢复一次；之后的滚动与焦点变化由用户驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 滚动位置只在内存里跟手记录：不写 Store，也不触发 React 重渲染。
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const record = () => { scrollTop.current = container.scrollTop; };
    container.addEventListener("scroll", record, { passive: true });
    return () => container.removeEventListener("scroll", record);
  }, [scrollRef, scrollTop]);

  const patchFilter = (patch: Partial<DeadlineFilter>) => onFilterChange({ ...filter, ...patch });
  const toggleKind = (kind: DeadlineKind) => patchFilter({
    kinds: filter.kinds.includes(kind)
      ? filter.kinds.filter((value) => value !== kind)
      : DEADLINE_KIND_ORDER.filter((value) => value === kind || filter.kinds.includes(value)),
  });
  const toggleTaskStatus = (status: TaskStatus) => patchFilter({
    taskStatuses: filter.taskStatuses.includes(status)
      ? filter.taskStatuses.filter((value) => value !== status)
      : TASK_STATUS_OPTIONS.map((option) => option.value).filter((value) => value === status || filter.taskStatuses.includes(value)),
  });

  return <section className="page-stack deadlines-page" aria-labelledby="deadlines-title">
    <header className="page-header">
      <div><span className="eyebrow">任务截止 · 项目截止 · 里程碑</span><h1 id="deadlines-title">截止事项</h1></div>
      <div className="header-actions"><div className="summary-pills"><span>{items.length} 项</span><span>{overdueCount} 项已逾期</span></div></div>
    </header>

    <div className="deadline-filters" role="group" aria-label="截止事项筛选">
      {/* 2×2 网格：第一列是「筛什么」（上行 chips、下行字段），第二列是动作（清除 / 开关）。
          两行共用第一列，宽度由 chips 决定；下行「项目」用 flex:1 撑满，右边缘自然与「已暂停」对齐。 */}
      <div className="deadline-filter-main">
        <div className="deadline-chip-group" role="group" aria-label="按类型筛选">
          <span className="deadline-filter-label">类型</span>
          {DEADLINE_KIND_ORDER.map((kind) => <button key={kind} type="button" className="filter-chip" aria-pressed={filter.kinds.includes(kind)} onClick={() => toggleKind(kind)}>{DEADLINE_KIND_LABEL[kind]}</button>)}
        </div>
        <div className="deadline-chip-group" role="group" aria-label="按状态筛选">
          <span className="deadline-filter-label">状态</span>
          {TASK_STATUS_OPTIONS.map((option) => <button key={option.value} type="button" className="filter-chip" aria-pressed={filter.taskStatuses.includes(option.value)} onClick={() => toggleTaskStatus(option.value)}>{option.label}</button>)}
        </div>
      </div>
      <Button disabled={!filterActive} onClick={() => onFilterChange(DEFAULT_DEADLINE_FILTER)}><Eraser size={15} />清除筛选</Button>
      <div className="deadline-filter-main">
        <label className="deadline-field deadline-field-grow">搜索
          <input aria-label="按标题搜索" placeholder="输入关键字" value={filter.query} onChange={(event) => patchFilter({ query: event.target.value })} />
        </label>
        <label className="deadline-field">项目
          <select aria-label="按项目筛选" value={filter.projectId ?? ""} onChange={(event) => patchFilter({ projectId: event.target.value || null })}>
            <option value="">全部项目</option>
            {index.workspace.projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
          </select>
        </label>
      </div>
      <label className="deadline-switch"><input type="checkbox" className="switch" checked={filter.includeReachedMilestones} onChange={(event) => patchFilter({ includeReachedMilestones: event.target.checked })} />含已达成</label>
    </div>

    {staleNotice && <p className="deadline-notice" role="status"><RotateCcw size={15} aria-hidden="true" />{staleNotice}</p>}

    {groups.map((bucket) => <section key={bucket.group} className="deadline-group" data-deadline-group={bucket.group} aria-labelledby={`deadline-group-${bucket.group}`}>
      <div className="section-heading"><h2 id={`deadline-group-${bucket.group}`}>{bucket.title}</h2><span>{bucket.items.length} 项</span></div>
      <div className="deadline-rows">
        {bucket.items.map((item) => <DeadlineRow key={item.key} index={index} item={item} today={today} focused={item.key === focusKey}
          onFocus={onFocusKey} onEditTask={onEditTask} onArrangeTask={onArrangeTask} onOpenProject={onOpenProject} onContinueMilestone={onContinueMilestone} />)}
      </div>
    </section>)}

    {/* 「无数据」与「筛选无匹配」是两种不同空状态：前者没有可清的东西，后者提供清除筛选。 */}
    {items.length === 0 && (filterActive
      ? <DeadlineEmpty icon={<ListFilter />} title="筛选没有匹配" text="当前筛选条件下没有截止事项。清除筛选即可看到全部内容。"
        action={<Button onClick={() => onFilterChange(DEFAULT_DEADLINE_FILTER)}><X size={15} />清除筛选</Button>} />
      : <DeadlineEmpty icon={<Check />} title="没有截止事项" text="任务、项目和里程碑都还没有设置截止日期；设置之后它们会集中出现在这里。" />)}
  </section>;
}

/** 与 `App.tsx` 的 `EmptyState` 同一套类名；页面是独立模块，不反向依赖应用壳。 */
function DeadlineEmpty({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><span>{icon}</span><strong>{title}</strong><p>{text}</p>{action}</div>;
}

/** 分组边界会随时间推移改变，页面自己按 30 秒节拍取本地日期。 */
function useCurrentTime() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(timer); }, []);
  return now;
}
