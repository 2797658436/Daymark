import { createContext, useCallback, useContext, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";

import { dragEdgeScrollVelocity } from "./useCalendarViewport";
import { clockMinutes, segmentMinuteAtOffset, segmentOffsetAtMinute, type TimelineSegment } from "../lib/calendarTimeline";
import {
  resolveCalendarDrop, sessionMinutes,
  type CalendarDropIntent, type CalendarDropMode, type SessionPlacementChange,
} from "../lib/calendarPlacement";
import type { ExecutionSession, Task } from "../lib/native";
import type { AppSettings } from "../lib/settings";
import { snapDelta, snapMinutesFor, snapTo } from "../lib/timelineDrag";

/**
 * 日历拖拽的唯一状态机（B1 建、B2 收口）。
 *
 * `idle → picked(按下，未过 5px) → dragging(跟手) → landing(写入中) | deciding(等确认) → idle`。
 * 三条来源共用它：**移动已排卡片**（`beginMove`）、**拖底边改时长**（`beginResize`）、
 * **任务池 → 日历新增一次时段**（`beginCreate`，UI-SPEC §67 的两种语义之一）。
 * 落点与后移只由 `resolveCalendarDrop` 算一次，预览和提交读同一份结果（评估 F09／F04，D5）。
 *
 * B2 起全仓没有 HTML5 DnD：清理在松手/取消时同步完成，不再有 `dragend`／`drop` 兜底，
 * 也不需要「保护模式里的影子副本」（`src/lib/calendarDrag.ts` 已删除）。
 *
 * `deciding` 是「已经松手、但要用户先确认」的一段（§187 跨默认时段/跨天、§185 时间块）。
 * 它不是提交：气泡里点确认才进 `landing`，取消直接回 `idle`，副作用一次都没发生。
 */

export type DragSessionPhase = "idle" | "picked" | "dragging" | "landing" | "deciding";
/** `move`/`resize` 作用在已有时段上，`create` 从任务池新增一次时段。 */
export type DragSessionKind = "move" | "resize" | "create";

export interface DragSessionSource {
  /** 被移动的时段 id；从任务池新建时为空串（还没有时段）。 */
  sessionId: string;
  taskId: string;
  /** 源日期；新建时为空串。 */
  date: string;
  startMinute: number;
  duration: number;
  /** 按下点到源卡片顶部的像素距离：落点按「抓哪儿跟哪儿」对齐。 */
  grabOffsetY: number;
  cardHeight: number;
}

export interface DragSessionPreview {
  kind: DragSessionKind;
  date: string;
  startMinute: number;
  duration: number;
  mode: CalendarDropMode;
  targetSessionId: string;
  targetRatio: number | null;
  latched: boolean;
  shifted: SessionPlacementChange[];
  /** 指针落在折叠条上时的 gap key（日视图悬停展开用）；否则 null。 */
  collapsedGapKey: string | null;
  /** 指针落在时间块上时的块 id（§185/186）；否则 null。 */
  blockId: string | null;
}

/** 松手前需要用户拍板的一次落点（跨时段/跨天确认、时间块三选项）。 */
export interface DragDecision {
  kind: "boundary" | "block";
  /** boundary 的两种来由；block 固定为 `block`。 */
  reason: "outside-slots" | "cross-day" | "block";
  /** 气泡锚点（松手时的视口坐标）。 */
  anchor: { x: number; y: number };
  /** 受影响时段数量。 */
  count: number;
  /** 受影响时段落到的新日期（boundary 用；去重升序）。 */
  dates: string[];
  /** 时间块标题（block 用）。 */
  blockTitle: string;
  /** 确认后的落点。 */
  intent: CalendarDropIntent;
  /** 「放到时间块之后」的落点（只有 block 有）。 */
  afterIntent: CalendarDropIntent | null;
}

export interface DragSessionState {
  phase: DragSessionPhase;
  source: DragSessionSource | null;
  preview: DragSessionPreview | null;
  delta: { x: number; y: number };
  kind: DragSessionKind | null;
  /** 指针正在任务池上（拖回池落区，§191）。 */
  overPool: boolean;
  decision: DragDecision | null;
}

export interface DragSessionApi extends DragSessionState {
  /** 当前被抓时段的 id；idle 或从池新建时为 null。 */
  sourceId: string | null;
  /** 当前被抓任务的 id；idle 时为 null。 */
  sourceTaskId: string | null;
  /** 成功提交的次数：列组件据此判断「这次 session 结束是提交还是取消」。 */
  commitCount: number;
  beginMove: (event: ReactPointerEvent<HTMLElement>, session: ExecutionSession) => void;
  beginResize: (event: ReactPointerEvent<HTMLElement>, session: ExecutionSession) => void;
  beginCreate: (event: ReactPointerEvent<HTMLElement>, task: Task) => void;
  /** 拖动结束后的那一次 click 不该再打开待回顾气泡。 */
  suppressClick: (sessionId: string) => boolean;
  cancel: () => void;
  confirmDecision: () => void;
  chooseAfterBlock: () => void;
  dismissDecision: () => void;
}

export interface UseDragSessionOptions {
  rootRef: RefObject<HTMLElement | null>;
  snapMinutes: AppSettings["snapMinutes"];
  /** 当前视图每小时像素，用于改时长的分钟换算。 */
  hourHeight: number;
  /** 某一天参与落点的时段（必须与提交同一套集合）。 */
  sessionsFor: (date: string) => ExecutionSession[];
  onCommit: (intent: CalendarDropIntent) => Promise<void>;
  onResize: (session: ExecutionSession, duration: number) => Promise<void>;
  /** 拖到任务池上松手 = 取消本次安排（§191）。 */
  onCancelSession?: (session: ExecutionSession) => Promise<void>;
  /** 进入 dragging：滚动仲裁把低优先级请求延后。 */
  onDragStart?: () => void;
  /** 松手/取消：恢复滚动仲裁。 */
  onDragEnd?: () => void;
  /**
   * 松手时问一次「这次落点要不要先确认」。
   *
   * 业务规则（哪些算越界、时间块三选项各落在哪）留在 App；状态机只负责在返回非空时
   * 停在 `deciding` 并把它交给气泡，返回 null 就直接提交。
   */
  buildDecision?: (input: { intent: CalendarDropIntent; preview: DragSessionPreview; point: { x: number; y: number } }) => DragDecision | null;
}

const DRAG_THRESHOLD_PX = 5;
const OVERLAP_LATCH_MS = 500;
const CLICK_SUPPRESS_MS = 400;

const initialState: DragSessionState = {
  phase: "idle", source: null, preview: null, delta: { x: 0, y: 0 }, kind: null, overPool: false, decision: null,
};

interface GestureHandlers {
  move: (event: PointerEvent) => void;
  up: (event: PointerEvent) => void;
  cancel: () => void;
  key: (event: KeyboardEvent) => void;
  blur: () => void;
}

interface Gesture {
  session: ExecutionSession | null;
  taskId: string;
  source: DragSessionSource;
  kind: DragSessionKind;
  pointerId: number | null;
  element: HTMLElement;
  originX: number;
  originY: number;
  lastX: number;
  lastY: number;
  lastAltKey: boolean;
  started: boolean;
  dragEnded: boolean;
  committed: boolean;
  preview: DragSessionPreview | null;
  /** 指针在任务池上（只在 move 时有意义）。 */
  overPool: boolean;
  decision: DragDecision | null;
  latchTimer: number | null;
  pendingLatchTargetId: string | null;
  latchedTargetId: string | null;
  handlers: GestureHandlers;
}

/** 轨道内像素 → 分钟：与 `calendarTimeline` 的分段映射共用同一公式。 */
function minuteAtTrackOffset(track: HTMLElement, offset: number): number {
  const rect = track.getBoundingClientRect();
  if (rect.height <= 0) return 0;
  const segments: TimelineSegment[] = Array.from(track.querySelectorAll<HTMLElement>(".timeline-map-segment")).map((segment) => ({
    start: Number(segment.dataset.startMinute),
    end: Number(segment.dataset.endMinute),
    collapsed: segment.dataset.collapsed === "true",
    gapKey: null,
    top: parseFloat(segment.style.top) || 0,
    height: parseFloat(segment.style.height) || 0,
  }));
  if (segments.length === 0) return Math.max(0, Math.min(rect.height, offset)) / rect.height * 1440;
  return segmentMinuteAtOffset(segments, rect.height, offset);
}

/** 指针下最近的日轨道；几何判定不依赖 `elementFromPoint`，jsdom 里也能测。 */
function trackAtPoint(root: HTMLElement, x: number, y: number): HTMLElement | null {
  const tracks = Array.from(root.querySelectorAll<HTMLElement>(".day-track"));
  for (const track of tracks) {
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return track;
  }
  return null;
}

/** 轨道内某分钟的纵向像素偏移：与 `minuteAtTrackOffset` 读同一份分段。 */
function offsetForMinute(track: HTMLElement, minute: number): number {
  const rect = track.getBoundingClientRect();
  const segments: TimelineSegment[] = Array.from(track.querySelectorAll<HTMLElement>(".timeline-map-segment")).map((segment) => ({
    start: Number(segment.dataset.startMinute),
    end: Number(segment.dataset.endMinute),
    collapsed: segment.dataset.collapsed === "true",
    gapKey: null,
    top: parseFloat(segment.style.top) || 0,
    height: parseFloat(segment.style.height) || 0,
  }));
  if (segments.length === 0) return Math.max(0, Math.min(1440, minute)) / 1440 * rect.height;
  return segmentOffsetAtMinute(segments, rect.height, minute);
}

/**
 * 指针下的目标卡片（排除拖拽源与落点副本）。
 *
 * 命中判定读**原计划几何**而不是卡片当前 DOM 位置：插入预览会把目标卡真的往后挪（§171），
 * 若按挪动后的位置判定，指针停在原上缘时目标就从指针下消失 —— 预览会在「插入」和「放置」
 * 之间闪，松手重算又会得到与预览不同的落点。原计划几何只由当天时段与轨道分段决定，
 * 拖动中保持不动，预览与提交才会落在同一张卡上。
 *
 * 横向同理**只看整列**：横向决定的是「哪一列」，不是「哪一张卡」。B2 的重叠预演（§177）
 * 会按松手后的结果把同组的卡提前分成并排栏，若仍按卡片当前的 `rect.left/right` 判定，
 * 指针停在列中央时反而落到「预览栏」之外、目标卡从指针下消失 —— 预览显示「同时安排」，
 * 松手却按 `place` 落库（实测差 30 分钟）。并行组里指针真的压着哪一张仍然优先。
 */
function sessionAtPoint(track: HTMLElement, x: number, y: number, sourceId: string, sessions: ExecutionSession[]): { sessionId: string; ratio: number } | null {
  const trackRect = track.getBoundingClientRect();
  if (trackRect.width <= 0 || trackRect.height <= 0) return null;
  if (x < trackRect.left || x > trackRect.right) return null;
  let best: { sessionId: string; ratio: number; area: number; onPointer: boolean } | null = null;
  for (const card of Array.from(track.querySelectorAll<HTMLElement>(".calendar-session"))) {
    const sessionId = card.dataset.sessionId ?? "";
    if (!sessionId || sessionId === sourceId) continue;
    if (card.classList.contains("is-dragging-source") || card.classList.contains("is-landed")) continue;
    const session = sessions.find((item) => item.id === sessionId);
    const rect = card.getBoundingClientRect();
    if (!session || rect.height <= 0) continue;
    const start = clockMinutes(session.startLocal);
    const top = trackRect.top + offsetForMinute(track, start);
    const height = Math.max(offsetForMinute(track, start + sessionMinutes(session)) - offsetForMinute(track, start), rect.height);
    if (height <= 0 || y < top || y > top + height) continue;
    const candidate = { sessionId, ratio: (y - top) / height, area: rect.width * height, onPointer: x >= rect.left && x <= rect.right };
    if (!best) { best = candidate; continue; }
    if (candidate.onPointer !== best.onPointer) { if (candidate.onPointer) best = candidate; continue; }
    if (candidate.area < best.area) best = candidate;
  }
  return best ? { sessionId: best.sessionId, ratio: best.ratio } : null;
}

/** 指针下的时间块（§185/186：块参与落点命中）。 */
function blockAtPoint(track: HTMLElement, x: number, y: number): string | null {
  for (const element of Array.from(track.querySelectorAll<HTMLElement>(".calendar-time-block"))) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return element.dataset.blockId ?? "";
  }
  return null;
}

/** 指针下的折叠条（日视图拖拽悬停展开，§128）。 */
function gapKeyAtPoint(track: HTMLElement, x: number, y: number): string | null {
  for (const element of Array.from(track.querySelectorAll<HTMLElement>(".collapsed-time-gap"))) {
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0) continue;
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return element.dataset.gapKey ?? null;
  }
  return null;
}

function pointInTaskPool(x: number, y: number): boolean {
  const pool = typeof document === "undefined" ? null : document.getElementById("task-pool");
  const rect = pool?.getBoundingClientRect();
  return Boolean(rect && rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
}

/** 日历自己的滚动容器：日视图是连续轴，周视图是网格视口。 */
function calendarScroller(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>(".continuous-day-axis") ?? root.querySelector<HTMLElement>(".calendar-viewport");
}

export function useDragSession(options: UseDragSessionOptions): DragSessionApi {
  const optionsRef = useRef(options); optionsRef.current = options;
  const [state, setState] = useState<DragSessionState>(initialState);
  const [commitCount, setCommitCount] = useState(0);
  const gestureRef = useRef<Gesture | null>(null);
  const mountedRef = useRef(true);
  const suppressRef = useRef<null | { sessionId: string; until: number }>(null);
  const scrollFrameRef = useRef<number | null>(null);

  const clearLatchTimer = useCallback((gesture: Gesture) => {
    if (gesture.latchTimer !== null) window.clearTimeout(gesture.latchTimer);
    gesture.latchTimer = null;
    gesture.pendingLatchTargetId = null;
  }, []);

  const publish = useCallback((gesture: Gesture, preview: DragSessionPreview | null, phase: DragSessionPhase) => {
    if (!mountedRef.current) return;
    const delta = { x: gesture.lastX - gesture.originX, y: gesture.lastY - gesture.originY };
    setState((current) => ({
      ...current,
      phase,
      source: gesture.source,
      kind: gesture.kind,
      preview,
      overPool: gesture.overPool,
      delta: current.delta.x === delta.x && current.delta.y === delta.y ? current.delta : delta,
    }));
  }, []);

  /** 算一次落点。`commit` 时卡片中央直接按 overlap（D5），拖动中则停在 place 并提示半秒。 */
  const computePreview = useCallback((gesture: Gesture, x: number, y: number, altKey: boolean, commit: boolean): DragSessionPreview | null => {
    const { source, kind } = gesture;
    if (kind === "resize") {
      const snap = snapMinutesFor(optionsRef.current.snapMinutes, altKey);
      const pixelsPerMinute = optionsRef.current.hourHeight / 60;
      const deltaMinutes = (y - gesture.originY) / pixelsPerMinute;
      const duration = Math.max(snap, Math.min(1440, source.duration + snapDelta(deltaMinutes, snap)));
      return {
        kind, date: source.date, startMinute: source.startMinute, duration,
        mode: "place", targetSessionId: "", targetRatio: null, latched: false, shifted: [],
        collapsedGapKey: null, blockId: null,
      };
    }
    const root = optionsRef.current.rootRef.current;
    const track = root ? trackAtPoint(root, x, y) : null;
    if (!root || !track) {
      clearLatchTimer(gesture);
      gesture.latchedTargetId = null;
      return null;
    }
    const date = track.closest<HTMLElement>(".calendar-day")?.dataset.dayDate ?? "";
    // 指针是视口坐标，轨道可能在滚动容器里（尤其日视图的连续轴）：先减掉轨道自身的上沿。
    const rawMinute = minuteAtTrackOffset(track, y - source.grabOffsetY - track.getBoundingClientRect().top);
    const snap = snapMinutesFor(optionsRef.current.snapMinutes, altKey);
    const pointerMinute = snapTo(rawMinute, snap, 0, 1439);
    const sessions = optionsRef.current.sessionsFor(date);
    const target = sessionAtPoint(track, x, y, source.sessionId, sessions);
    const center = target !== null && target.ratio >= .25 && target.ratio <= .75;
    if (!commit) {
      if (center && target) {
        if (gesture.latchedTargetId !== target.sessionId && gesture.pendingLatchTargetId !== target.sessionId) {
          clearLatchTimer(gesture);
          gesture.pendingLatchTargetId = target.sessionId;
          const targetId = target.sessionId;
          gesture.latchTimer = window.setTimeout(() => {
            const current = gestureRef.current;
            if (!current || current !== gesture || !current.started || current.pendingLatchTargetId !== targetId) return;
            current.latchedTargetId = targetId;
            clearLatchTimer(current);
            const preview = computePreview(current, current.lastX, current.lastY, current.lastAltKey, false);
            current.preview = preview;
            publish(current, preview, "dragging");
          }, OVERLAP_LATCH_MS);
        }
      } else {
        clearLatchTimer(gesture);
        gesture.latchedTargetId = null;
      }
    }
    const latched = Boolean(target && gesture.latchedTargetId === target.sessionId);
    const blockId = blockAtPoint(track, x, y);
    const resolution = resolveCalendarDrop({
      sessions,
      sourceSessionId: source.sessionId,
      sourceDuration: source.duration,
      pointerMinute,
      targetSessionId: target?.sessionId ?? "",
      targetRatio: target?.ratio ?? null,
      overlapLatched: latched,
      commit,
    });
    return {
      kind, date, startMinute: resolution.startMinute, duration: source.duration,
      mode: blockId ? "overlap" : resolution.mode,
      targetSessionId: resolution.targetSessionId,
      targetRatio: target?.ratio ?? null, latched, shifted: resolution.shifted,
      collapsedGapKey: gapKeyAtPoint(track, x, y),
      blockId,
    };
  }, [clearLatchTimer, publish]);

  const stopEdgeScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) { cancelAnimationFrame(scrollFrameRef.current); scrollFrameRef.current = null; }
  }, []);

  /**
   * 边缘自动滚动（§197）：拖拽期间一条 rAF 循环，指针在触发带里就按速度推进滚动，
   * 回到中央自然停（速度 0，循环继续但不写 `scrollTop`）。滚动之后重新算一次落点，
   * 否则「内容动了、虚线框没动」，松手位置会与预览不一致。
   */
  const startEdgeScroll = useCallback((gesture: Gesture) => {
    stopEdgeScroll();
    if (typeof requestAnimationFrame !== "function") return;
    const step = () => {
      scrollFrameRef.current = null;
      const current = gestureRef.current;
      if (!current || current !== gesture || !current.started || current.decision) return;
      const root = optionsRef.current.rootRef.current;
      const scroller = root ? calendarScroller(root) : null;
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      // 指针不在日历视口里（例如拖到任务池上）时一律不滚：只看 clientY 会让「拖到池子上」
      // 因为落在视口上边缘的触发带里而一路把日历往上卷（E2E 实测过）。
      const insideViewport = gesture.lastX >= rect.left && gesture.lastX <= rect.right
        && gesture.lastY >= rect.top && gesture.lastY <= rect.bottom;
      const velocity = insideViewport
        ? dragEdgeScrollVelocity({ clientY: gesture.lastY, viewportTop: rect.top, viewportBottom: rect.bottom })
        : 0;
      if (velocity !== 0) {
        const before = scroller.scrollTop;
        scroller.scrollTop = before + velocity;
        if (scroller.scrollTop !== before) {
          const preview = computePreview(gesture, gesture.lastX, gesture.lastY, gesture.lastAltKey, false);
          gesture.preview = preview;
          publish(gesture, preview, "dragging");
        }
      }
      scrollFrameRef.current = requestAnimationFrame(step);
    };
    scrollFrameRef.current = requestAnimationFrame(step);
  }, [computePreview, publish, stopEdgeScroll]);

  const detachGesture = useCallback((gesture: Gesture) => {
    window.removeEventListener("pointermove", gesture.handlers.move);
    window.removeEventListener("pointerup", gesture.handlers.up);
    window.removeEventListener("pointercancel", gesture.handlers.cancel);
    window.removeEventListener("keydown", gesture.handlers.key, true);
    window.removeEventListener("blur", gesture.handlers.blur);
  }, []);

  const finish = useCallback((gesture: Gesture) => {
    detachGesture(gesture);
    if (gestureRef.current === gesture) gestureRef.current = null;
    clearLatchTimer(gesture);
    stopEdgeScroll();
    if (typeof document !== "undefined") delete document.body.dataset.calendarDragging;
    try {
      if (gesture.pointerId !== null && gesture.element.hasPointerCapture?.(gesture.pointerId)) gesture.element.releasePointerCapture(gesture.pointerId);
    } catch { /* element may already be gone */ }
    if (gesture.committed) setCommitCount((value) => value + 1);
    if (mountedRef.current) setState(initialState);
  }, [clearLatchTimer, detachGesture, stopEdgeScroll]);

  const endViewportDrag = useCallback((gesture: Gesture) => {
    if (gesture.dragEnded) return;
    gesture.dragEnded = true;
    optionsRef.current.onDragEnd?.();
  }, []);

  const cancelGesture = useCallback(() => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    detachGesture(gesture);
    if (gesture.started) {
      endViewportDrag(gesture);
      if (gesture.source.sessionId) suppressRef.current = { sessionId: gesture.source.sessionId, until: Date.now() + CLICK_SUPPRESS_MS };
    }
    finish(gesture);
  }, [detachGesture, endViewportDrag, finish]);

  const commitIntent = useCallback((gesture: Gesture, intent: CalendarDropIntent) => {
    gesture.decision = null;
    gesture.committed = true;
    setState((current) => ({ ...current, phase: "landing", preview: null, decision: null, overPool: false }));
    void optionsRef.current.onCommit(intent)
      .catch(() => { gesture.committed = false; })
      .finally(() => finish(gesture));
  }, [finish]);

  const begin = useCallback((event: ReactPointerEvent<HTMLElement>, input: {
    kind: DragSessionKind;
    session?: ExecutionSession;
    task?: Task;
  }) => {
    if (gestureRef.current || event.button !== 0) return;
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    const grabOffsetY = rect.height > 0 ? Math.max(0, Math.min(rect.height, event.clientY - rect.top)) : 0;
    const kind = input.kind;
    const session = input.session ?? null;
    const task = input.task ?? null;
    if (kind === "create" && !task) return;
    if (kind !== "create" && !session) return;
    const duration = session
      ? sessionMinutes(session)
      : Math.max(5, task?.sessionMinutes ?? task?.estimatedMinutes ?? 60);
    const source: DragSessionSource = {
      sessionId: session?.id ?? "",
      taskId: session?.taskId ?? task!.id,
      date: session?.localDate ?? "",
      startMinute: session ? clockMinutes(session.startLocal) : 0,
      duration,
      grabOffsetY,
      cardHeight: rect.height,
    };
    const handlers: GestureHandlers = { move: () => undefined, up: () => undefined, cancel: () => undefined, key: () => undefined, blur: () => undefined };
    const gesture: Gesture = {
      session, taskId: source.taskId, source, kind,
      pointerId: typeof event.pointerId === "number" ? event.pointerId : null,
      element,
      originX: event.clientX, originY: event.clientY,
      lastX: event.clientX, lastY: event.clientY, lastAltKey: event.altKey,
      started: false, dragEnded: false, committed: false, preview: null, overPool: false, decision: null,
      latchTimer: null, pendingLatchTargetId: null, latchedTargetId: null,
      handlers,
    };

    handlers.move = (next: PointerEvent) => {
      if (gestureRef.current !== gesture) return;
      if (gesture.pointerId !== null && next.pointerId !== gesture.pointerId) return;
      gesture.lastX = next.clientX; gesture.lastY = next.clientY; gesture.lastAltKey = next.altKey;
      if (!gesture.started) {
        if (Math.hypot(gesture.lastX - gesture.originX, gesture.lastY - gesture.originY) < DRAG_THRESHOLD_PX) return;
        gesture.started = true;
        document.body.dataset.calendarDragging = "true";
        optionsRef.current.onDragStart?.();
        startEdgeScroll(gesture);
      }
      if (next.cancelable) next.preventDefault();
      // 只有「移动已排卡片」才有拖回池的语义；从池拖出的卡片回到池上什么都不做。
      gesture.overPool = kind === "move" && pointInTaskPool(gesture.lastX, gesture.lastY);
      const preview = computePreview(gesture, gesture.lastX, gesture.lastY, gesture.lastAltKey, false);
      gesture.preview = preview;
      publish(gesture, preview, "dragging");
    };
    handlers.up = (next: PointerEvent) => {
      if (gestureRef.current !== gesture) return;
      if (gesture.pointerId !== null && next.pointerId !== gesture.pointerId) return;
      detachGesture(gesture);
      if (!gesture.started) { finish(gesture); return; }
      endViewportDrag(gesture);
      stopEdgeScroll();
      gesture.lastX = next.clientX; gesture.lastY = next.clientY; gesture.lastAltKey = next.altKey;
      if (gesture.source.sessionId) suppressRef.current = { sessionId: gesture.source.sessionId, until: Date.now() + CLICK_SUPPRESS_MS };
      if (kind === "move" && gesture.session && pointInTaskPool(next.clientX, next.clientY)) {
        gesture.committed = true;
        setState((current) => ({ ...current, phase: "landing", preview: null, delta: { x: 0, y: 0 }, overPool: false }));
        void optionsRef.current.onCancelSession?.(gesture.session)
          .catch(() => { gesture.committed = false; })
          .finally(() => finish(gesture));
        return;
      }
      const preview = computePreview(gesture, gesture.lastX, gesture.lastY, gesture.lastAltKey, true);
      if (!preview) { finish(gesture); return; }
      if (kind === "resize") {
        if (!gesture.session) { finish(gesture); return; }
        gesture.committed = true;
        setState((current) => ({ ...current, phase: "landing", preview, delta: { x: 0, y: 0 }, overPool: false }));
        void optionsRef.current.onResize(gesture.session, preview.duration)
          .catch(() => { gesture.committed = false; })
          .finally(() => finish(gesture));
        return;
      }
      const intent: CalendarDropIntent = {
        date: preview.date,
        startMinute: preview.startMinute,
        taskId: gesture.source.taskId,
        sessionId: gesture.source.sessionId,
        mode: preview.mode,
        targetSessionId: preview.targetSessionId,
        targetRatio: preview.targetRatio,
      };
      const decision = optionsRef.current.buildDecision?.({ intent, preview, point: { x: gesture.lastX, y: gesture.lastY } }) ?? null;
      if (decision) {
        // 停在 deciding：一次副作用都还没发生，气泡确认后才走同一条 commitIntent。
        gesture.decision = decision;
        setState((current) => ({ ...current, phase: "deciding", preview, decision, overPool: false }));
        return;
      }
      commitIntent(gesture, intent);
    };
    handlers.cancel = () => { if (gestureRef.current === gesture) cancelGesture(); };
    handlers.blur = () => { if (gestureRef.current === gesture) cancelGesture(); };
    handlers.key = (next: KeyboardEvent) => {
      if (gestureRef.current !== gesture || next.key !== "Escape") return;
      next.preventDefault();
      next.stopPropagation();
      cancelGesture();
    };

    gestureRef.current = gesture;
    setState({ phase: "picked", source, preview: null, delta: { x: 0, y: 0 }, kind, overPool: false, decision: null });
    try { element.setPointerCapture?.(event.pointerId); } catch { /* synthetic pointers need no capture */ }
    window.addEventListener("pointermove", handlers.move, { passive: false });
    window.addEventListener("pointerup", handlers.up);
    window.addEventListener("pointercancel", handlers.cancel);
    window.addEventListener("keydown", handlers.key, true);
    window.addEventListener("blur", handlers.blur);
  }, [cancelGesture, commitIntent, computePreview, detachGesture, endViewportDrag, finish, publish, startEdgeScroll, stopEdgeScroll]);

  /**
   * 拖拽期间禁止选中文本。pointer 通道没有 HTML5 DnD 的默认行为兜底，
   * 从日历卡片横穿到任务池时浏览器会顺手把整页文字框成蓝色（B2 截图里抓到过）。
   * 5px 阈值前可能已经选了一点，所以顺手清一次选区。
   */
  useEffect(() => {
    if (state.phase === "idle") return;
    document.body.dataset.calendarDragging = "true";
    window.getSelection()?.removeAllRanges();
    return () => { delete document.body.dataset.calendarDragging; };
  }, [state.phase]);

  const beginMove = useCallback((event: ReactPointerEvent<HTMLElement>, session: ExecutionSession) => begin(event, { kind: "move", session }), [begin]);
  const beginResize = useCallback((event: ReactPointerEvent<HTMLElement>, session: ExecutionSession) => begin(event, { kind: "resize", session }), [begin]);
  const beginCreate = useCallback((event: ReactPointerEvent<HTMLElement>, task: Task) => begin(event, { kind: "create", task }), [begin]);

  const confirmDecision = useCallback(() => {
    const gesture = gestureRef.current;
    const decision = gesture?.decision;
    if (!gesture || !decision) return;
    commitIntent(gesture, decision.intent);
  }, [commitIntent]);

  const chooseAfterBlock = useCallback(() => {
    const gesture = gestureRef.current;
    const decision = gesture?.decision;
    if (!gesture || !decision?.afterIntent) return;
    commitIntent(gesture, decision.afterIntent);
  }, [commitIntent]);

  const dismissDecision = useCallback(() => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gesture.decision = null;
    finish(gesture);
  }, [finish]);

  const suppressClick = useCallback((sessionId: string) => {
    const entry = suppressRef.current;
    if (!entry || entry.sessionId !== sessionId) return false;
    if (Date.now() > entry.until) { suppressRef.current = null; return false; }
    suppressRef.current = null;
    return true;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const gesture = gestureRef.current;
      stopEdgeScroll();
      if (gesture) {
        detachGesture(gesture);
        clearLatchTimer(gesture);
        if (typeof document !== "undefined") delete document.body.dataset.calendarDragging;
        gestureRef.current = null;
      }
    };
  }, [clearLatchTimer, detachGesture, stopEdgeScroll]);

  return {
    ...state,
    sourceId: state.source?.sessionId || null,
    sourceTaskId: state.source?.taskId ?? null,
    commitCount,
    beginMove, beginResize, beginCreate,
    suppressClick, cancel: cancelGesture,
    confirmDecision, chooseAfterBlock, dismissDecision,
  };
}

const noopDragSession: DragSessionApi = {
  ...initialState,
  sourceId: null,
  sourceTaskId: null,
  commitCount: 0,
  beginMove: () => undefined,
  beginResize: () => undefined,
  beginCreate: () => undefined,
  suppressClick: () => false,
  cancel: () => undefined,
  confirmDecision: () => undefined,
  chooseAfterBlock: () => undefined,
  dismissDecision: () => undefined,
};

const DragSessionContext = createContext<DragSessionApi>(noopDragSession);

export function DragSessionProvider({ value, children }: { value: DragSessionApi; children: ReactNode }) {
  return <DragSessionContext.Provider value={value}>{children}</DragSessionContext.Provider>;
}

/** 组件树里读同一次拖拽；没有 Provider 时退化为空操作（组件单测不必包一层）。 */
export function useDragSessionContext(): DragSessionApi {
  return useContext(DragSessionContext);
}
