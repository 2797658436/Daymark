/**
 * 拖拽负载的影子副本。
 *
 * HTML 规范规定 `dragenter` / `dragover` 期间 `dataTransfer` 处于保护模式：`types` 可读，
 * 但 `getData()` 一律返回空串 —— 只有 `dragstart`（源自己写入的那一刻）和 `drop` 能读到数据。
 *
 * 日历的整套拖拽反馈（跟随的虚线落点卡、插入线、"悬停 0.5 秒以同时安排"提示）都要在
 * `dragover` 里知道"正在拖什么"。只依赖 `getData` 的实现只在合成事件（测试里手搓的
 * `DataTransfer`）里成立，在真实浏览器里拖拽全程没有任何反馈。所以这里另存一份影子副本，
 * `drop` 阶段仍然优先用 `dataTransfer` 的真值。
 */
export interface CalendarDragPayload {
  kind: "task" | "session";
  /** `kind = task` 时是任务 id，`kind = session` 时是执行时段 id。 */
  id: string;
  /** 按下点相对被拖卡片顶部的偏移：落点靠它对齐「抓哪儿跟哪儿」。 */
  grabOffsetY: number;
}

let active: CalendarDragPayload | null = null;

export function beginCalendarDrag(payload: CalendarDragPayload): CalendarDragPayload {
  active = payload;
  return payload;
}

export function endCalendarDrag(): void {
  active = null;
}

export function activeCalendarDrag(): CalendarDragPayload | null {
  return active;
}

/** 保护模式下只能靠 `types` 判断拖的是任务卡还是已排时段，用来决定 `dropEffect`。 */
export function calendarDragTypes(transfer: DataTransfer | null | undefined): { task: boolean; session: boolean } {
  const types = Array.from(transfer?.types ?? []);
  return { task: types.includes("application/x-daymark-task"), session: types.includes("application/x-daymark-session") };
}

/**
 * 拖拽中的两个候选 id。`drop` 阶段 `dataTransfer` 可信，优先用它；
 * 保护模式下回落到影子副本 —— 但只在 `types` 里确实带着日历自己的类型时回落，
 * 否则从窗口外拖进来的文件／文本会借用上一轮的影子副本凭空造出一次排程。
 */
export function calendarDragIds(transfer: DataTransfer | null | undefined): { taskId: string; sessionId: string } {
  const { task, session } = calendarDragTypes(transfer);
  const payload = active;
  const taskId = transfer?.getData("application/x-daymark-task") || (task && payload?.kind === "task" ? payload.id : "");
  const sessionId = transfer?.getData("application/x-daymark-session") || (session && payload?.kind === "session" ? payload.id : "");
  return { taskId, sessionId };
}

export function calendarDragGrabOffset(transfer: DataTransfer | null | undefined): number {
  const fromTransfer = Number(transfer?.getData("application/x-daymark-grab"));
  if (Number.isFinite(fromTransfer) && fromTransfer > 0) return fromTransfer;
  return active?.grabOffsetY ?? 0;
}
