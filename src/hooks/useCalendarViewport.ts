import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import {
  clockMinutes, defaultSlotSlicesForWeekday, segmentMinuteAtOffset, segmentOffsetAtMinute, type TimelineSegment,
} from "../lib/calendarTimeline";
import type { CalendarView, DefaultTimeSlot } from "../lib/settings";

/**
 * 日历滚动仲裁与逻辑浏览位置（阶段 4 / P4-04，对应规格 §5 M9）。
 *
 * 为什么不能跨视图复用 `scrollTop`：日视图有 52px 日期头、折叠区间与三日缓冲，
 * 周视图有吸顶日期头与全天区 —— 同样的像素在不同视图里不是同一个时间。
 * 因此这里保存的是逻辑坐标 `{date, minute, viewportRatio}`，恢复时再用
 * `lib/calendarTimeline` 的分钟／像素映射重新算像素。
 *
 * 本工作包只做**内存**版：位置存在模块级内存里（切页仍在，重启不恢复）。
 * 写入 Store、跨启动恢复与非法偏好回退属于 P4-05。
 */

export interface CalendarPosition {
  /** 合法本地日期。 */
  date: string;
  /** 0 <= minute <= 1440。 */
  minute: number;
  /** 该时刻在可见高度中的比例，0..1。 */
  viewportRatio: number;
}

export interface CalendarPositions {
  day: CalendarPosition | null;
  week: CalendarPosition | null;
}

/** 只有日／周有时间轴坐标；月视图沿用日期锚点并在进入时置顶。 */
export type TimelineView = "day" | "week";

/**
 * 规格 §5.2 的请求优先级：数值越小越先执行。
 *
 * 同一个入口只让一个请求落地；高优先级请求会作废待处理的低优先级请求，
 * 正在进行的拖拽（1）则把所有低优先级请求延后到拖拽结束。
 */
export const CALENDAR_SCROLL_PRIORITY = {
  /** 1. 正在进行的拖拽／拉伸及其边缘自动滚动。 */
  drag: 1,
  /** 2. 用户明确的「回到现在」、目标 session 路由。 */
  reveal: 2,
  /** 3. Ctrl+滚轮的指针时间锚点补偿。 */
  zoomAnchor: 3,
  /** 4. 连续日三日缓冲平移的坐标补偿。 */
  bufferShift: 4,
  /** 5. 进入视图时恢复记忆位置。 */
  restore: 5,
  /** 6. 无记忆且日期包含今天时首次定位当前时间。 */
  initial: 6,
} as const;

export type CalendarScrollReason = keyof typeof CALENDAR_SCROLL_PRIORITY;

/** 用户滚动停止多久后采样为「已停下」的位置。 */
export const CALENDAR_SAMPLE_SETTLE_MS = 300;

/** 边缘自动滚动的触发带宽度，与阶段 3 的实现一致。 */
const DRAG_AUTOSCROLL_EDGE = 56;

/**
 * 同一帧内恢复失败时连续重试的帧数。
 *
 * 这不是「用固定延时猜 DOM 完成」：只要轨道可测量就立刻恢复，超出的部分交给
 * ResizeObserver 在元素真正获得尺寸时再推一次；这里只是给「同一帧里还量不到高度」
 * 留几帧余量，并保证不会出现永久的 rAF 空转。
 */
const MAX_RESTORE_RETRIES = 3;

export interface TrackGeometry {
  date: string;
  /** 轨道在滚动内容中的偏移。 */
  offsetTop: number;
  height: number;
  /** 折叠时间轴的分段；空数组表示整轨按 24 小时线性映射。 */
  segments: TimelineSegment[];
}

export interface ViewportGeometry {
  top: number;
  height: number;
  scrollTop: number;
}

// ---------------------------------------------------------------------------
// 纯换算：不碰 DOM，供 hook 与测试共用
// ---------------------------------------------------------------------------

/**
 * 采样：取采样点（默认视口中心）对应的日期／分钟。
 *
 * 采样点落在折叠条上时取该条时间区间的**中点** —— 折叠条把整段非默认时间压成
 * 44px，按像素内插会随 1px 滚动剧烈跳变；取中点既稳定，也保证恢复时不必展开它。
 * 采样点落在日分隔条／面板头上（中心不在任何轨道内）时，取最近轨道的边缘并把
 * `viewportRatio` 记成该边缘当时的屏幕比例，恢复时能把边缘放回原处。
 */
export function sampleCalendarPosition(input: {
  anchorDate: string;
  view: TimelineView;
  pointScreenY: number;
  viewport: ViewportGeometry;
  tracks: TrackGeometry[];
}): CalendarPosition | null {
  const { anchorDate, view, pointScreenY, viewport, tracks } = input;
  if (viewport.height <= 0 || tracks.length === 0) return null;
  const pointContentY = pointScreenY - viewport.top + viewport.scrollTop;
  const track = pickTrack(tracks, view, anchorDate, pointContentY);
  if (!track || track.height <= 0) return null;
  const bottom = track.offsetTop + track.height;
  const clampedContentY = Math.min(Math.max(pointContentY, track.offsetTop), bottom);
  const clampedScreenY = clampedContentY - viewport.scrollTop + viewport.top;
  const local = clampedContentY - track.offsetTop;
  const minute = track.segments.length > 0
    ? minuteInSegments(track.segments, track.height, local)
    : Math.min(Math.max(local / track.height, 0), 1) * 1440;
  return {
    date: track.date,
    minute,
    viewportRatio: clamp01((clampedScreenY - viewport.top) / viewport.height),
  };
}

/** 恢复：把逻辑坐标换算回 `scrollTop`。像素一律由 `calendarTimeline` 的映射产出。 */
export function scrollTopForCalendarPosition(input: { position: CalendarPosition; viewportHeight: number; track: TrackGeometry }): number | null {
  const { position, viewportHeight, track } = input;
  if (viewportHeight <= 0 || track.height <= 0 || !Number.isFinite(position.minute)) return null;
  const minute = Math.min(Math.max(position.minute, 0), 1440);
  const offset = track.segments.length > 0
    ? segmentOffsetAtMinute(track.segments, track.height, minute)
    : minute / 1440 * track.height;
  const ratio = Number.isFinite(position.viewportRatio) ? clamp01(position.viewportRatio) : 0.5;
  const next = track.offsetTop + offset - ratio * viewportHeight;
  return Number.isFinite(next) ? next : null;
}

/**
 * 选恢复用的轨道：优先记忆里的日期；该日期不在当前周／不在三日缓冲里时，
 * 退回到当前锚点日并保留原 `minute`（规格 §5.2）。
 */
export function pickTrackForPosition(tracks: TrackGeometry[], anchorDate: string, position: CalendarPosition): TrackGeometry | null {
  return tracks.find((track) => track.date === position.date) ?? tracks.find((track) => track.date === anchorDate) ?? null;
}

/** 该星期首个默认时段的开始分钟；没有可用时段返回 null。 */
export function firstDefaultSlotMinute(slots: DefaultTimeSlot[], weekday: number): number | null {
  const starts = defaultSlotSlicesForWeekday(slots, weekday).map((slot) => clockMinutes(slot.start));
  return starts.length > 0 ? Math.min(...starts) : null;
}

/** 优先级 6 的落点：今天定位「现在」；非今天回退日首个默认时段，无时段时 09:00。 */
export function initialCalendarMinute(input: { isToday: boolean; nowMinute: number; slots: DefaultTimeSlot[]; weekday: number }): number {
  if (input.isToday) return Math.min(Math.max(input.nowMinute, 0), 1440);
  return firstDefaultSlotMinute(input.slots, input.weekday) ?? 540;
}

/**
 * 优先级 1 的边缘自动滚动：拖拽悬停在滚动容器上下边缘时每帧推进的 `scrollTop`。
 *
 * 拖拽期间位置由拖拽自己拥有，其它恢复请求会被延后（见 `CALENDAR_SCROLL_PRIORITY`）。
 */
export function dragEdgeScrollTop(input: {
  currentScrollTop: number; clientY: number; viewportTop: number; viewportBottom: number; edge?: number;
}): number {
  const edge = input.edge ?? DRAG_AUTOSCROLL_EDGE;
  if (input.clientY < input.viewportTop + edge) return input.currentScrollTop - Math.ceil((input.viewportTop + edge - input.clientY) / 4);
  if (input.clientY > input.viewportBottom - edge) return input.currentScrollTop + Math.ceil((input.clientY - (input.viewportBottom - edge)) / 4);
  return input.currentScrollTop;
}

function minuteInSegments(segments: TimelineSegment[], totalHeight: number, localOffset: number): number {
  const hit = segments.find((segment) => localOffset >= segment.top && localOffset <= segment.top + segment.height) ?? segments.at(-1)!;
  if (hit.collapsed) return (hit.start + hit.end) / 2;
  return segmentMinuteAtOffset(segments, totalHeight, localOffset);
}

function pickTrack(tracks: TrackGeometry[], view: TimelineView, anchorDate: string, pointContentY: number): TrackGeometry | null {
  if (view === "week") return tracks.find((track) => track.date === anchorDate) ?? tracks[0] ?? null;
  const inside = tracks.find((track) => pointContentY >= track.offsetTop && pointContentY <= track.offsetTop + track.height);
  if (inside) return inside;
  return tracks.reduce((best, candidate) => trackDistance(candidate, pointContentY) < trackDistance(best, pointContentY) ? candidate : best, tracks[0]);
}

function trackDistance(track: TrackGeometry, pointContentY: number) {
  if (pointContentY < track.offsetTop) return track.offsetTop - pointContentY;
  if (pointContentY > track.offsetTop + track.height) return pointContentY - (track.offsetTop + track.height);
  return 0;
}

function clamp01(value: number) {
  return Math.min(Math.max(value, 0), 1);
}

// ---------------------------------------------------------------------------
// 内存记忆：App 层（模块级）保存，切页仍在，重启不恢复
// ---------------------------------------------------------------------------

const calendarPositions: CalendarPositions = { day: null, week: null };

export function readCalendarPositions(): CalendarPositions {
  return { day: calendarPositions.day, week: calendarPositions.week };
}

/** 仅供测试：清空内存浏览位置，避免用例之间串味。 */
export function resetCalendarPositions() {
  calendarPositions.day = null;
  calendarPositions.week = null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface ZoomAnchorMeasurement {
  scroller: HTMLElement;
  date: string | null;
  anchorRatio: number | null;
  anchorMinute: number | null;
  clientY: number;
  pointerOffset: number;
  contentRatio: number | null;
}

export interface CalendarViewportApi {
  /** 当前 generation；视图／日期每变一次递增。 */
  readGeneration: () => number;
  /** 采样并写入当前视图的内存位置。切页、卸载前调用。 */
  flush: () => void;
  /** 优先级 2：把「现在」带回视野中央。 */
  revealNow: () => void;
  /** 优先级 2：把某个执行时段带回视野中央（跨页目标显露）。 */
  revealSession: (sessionId: string) => void;
  /** 优先级 3：记录缩放前的指针锚点（在写入新比例之前调用）。 */
  captureZoomAnchor: (measurement: ZoomAnchorMeasurement) => void;
  /** 优先级 4：应用自己刚程序化写入过位置（三日缓冲平移等），这次 scroll 不是用户滚动。 */
  noteProgrammaticPosition: () => void;
  /** 只读：当前内存中的逻辑位置。 */
  positions: () => CalendarPositions;
}

export interface UseCalendarViewportOptions {
  view: CalendarView;
  /** 当前日期锚点。 */
  date: string;
  now: Date;
  /** 当前视图的纵向比例（每小时像素），用于缩放锚点补偿的触发时机。 */
  scale: number;
  /** 默认时段，用于优先级 6 的回退落点。 */
  slots: DefaultTimeSlot[];
  /** 当前周（周视图）的 7 个本地日期，用于判断「日期是否包含今天」。 */
  dates: string[];
  rootRef: RefObject<HTMLElement | null>;
}

export function useCalendarViewport(options: UseCalendarViewportOptions): CalendarViewportApi {
  const { view, date, scale, slots, dates, rootRef } = options;
  const viewRef = useRef(view); viewRef.current = view;
  const dateRef = useRef(date); dateRef.current = date;
  const nowRef = useRef(options.now); nowRef.current = options.now;
  const slotsRef = useRef(slots); slotsRef.current = slots;
  const datesRef = useRef(dates); datesRef.current = dates;

  const generationRef = useRef(0);
  /** 最近一次采样到的位置；切页／卸载时用它刷新内存。 */
  const latestRef = useRef<null | { view: TimelineView; position: CalendarPosition }>(null);
  const pendingRef = useRef<null | { reason: CalendarScrollReason; generation: number; apply: () => boolean; frames: number }>(null);
  const frameRef = useRef<number | null>(null);
  const detachRef = useRef<null | (() => void)>(null);
  const draggingRef = useRef(false);
  const settleRef = useRef<number | null>(null);
  const zoomAnchorRef = useRef<ZoomAnchorMeasurement | null>(null);
  /** 应用自己刚写过的程序化滚动位置：只有落在这个位置上的 scroll 事件才算「不是用户滚动」。 */
  const programmaticTopRef = useRef<number | null>(null);

  const priorityOf = (reason: CalendarScrollReason) => CALENDAR_SCROLL_PRIORITY[reason];

  const scrollerFor = useCallback((target: TimelineView): HTMLElement | null => {
    const root = rootRef.current;
    if (!root) return null;
    return root.querySelector<HTMLElement>(target === "day" ? ".continuous-day-axis" : ".calendar-viewport");
  }, [rootRef]);

  const sampleNow = useCallback((target: TimelineView, anchorDate: string): CalendarPosition | null => {
    const root = rootRef.current;
    const scroller = scrollerFor(target);
    if (!root || !scroller) return null;
    const viewport = measureViewport(scroller);
    if (viewport.height <= 0) return null;
    const tracks = measureTracks(root, target, viewport);
    if (tracks.length === 0) return null;
    return sampleCalendarPosition({ anchorDate, view: target, pointScreenY: viewport.top + viewport.height / 2, viewport, tracks });
  }, [rootRef, scrollerFor]);

  const commitLatest = useCallback((target: TimelineView) => {
    const latest = latestRef.current;
    if (latest && latest.view === target) calendarPositions[target] = latest.position;
  }, []);

  const cancelPending = useCallback(() => {
    detachRef.current?.();
    detachRef.current = null;
    pendingRef.current = null;
    if (frameRef.current !== null) { cancelAnimationFrame(frameRef.current); frameRef.current = null; }
  }, []);

  const pump = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const intent = pendingRef.current;
      if (!intent) return;
      // 过期的 animation frame 一律 no-op：视图／日期已经换过，位置属于旧视图。
      if (intent.generation !== generationRef.current) { cancelPending(); return; }
      // 拖拽拥有控制权：低优先级请求延后到 dragend。
      if (draggingRef.current && priorityOf(intent.reason) > CALENDAR_SCROLL_PRIORITY.drag) return;
      // 落地前先解除待处理标记：它自己的滚动事件不能被当成「用户滚动」而取消。
      pendingRef.current = null;
      if (intent.apply()) {
        detachRef.current?.();
        detachRef.current = null;
        return;
      }
      // 布局尚未测量：保持待处理，先补几帧，再交给 ResizeObserver。
      pendingRef.current = intent;
      intent.frames += 1;
      if (intent.frames <= MAX_RESTORE_RETRIES) pump();
    });
  }, [cancelPending]);

  const queue = useCallback((reason: CalendarScrollReason, apply: () => boolean) => {
    const generation = generationRef.current;
    const existing = pendingRef.current;
    if (existing && existing.generation === generation && priorityOf(existing.reason) < priorityOf(reason)) return;
    cancelPending();
    const intent = { reason, generation, apply, frames: 0 };
    pendingRef.current = intent;
    // 「进入视图恢复」与「首次定位」让位于任何先发生的滚动：用户拖动、键盘滚动或
    // 程序化写入都比一次迟到的自动定位更权威（阶段 3 的 108px 位移就是这类争抢）。
    // 唯一例外是应用自己刚写下的那个位置（`noteProgrammaticPosition`）：日视图进入时
    // 会把三日缓冲重新定位到中段，那次 scroll 事件不是用户意图，不能作废恢复。
    if (reason === "restore" || reason === "initial") {
      const scroller = scrollerFor(viewRef.current as TimelineView);
      if (scroller) {
        const onScroll = () => {
          const written = programmaticTopRef.current;
          if (written !== null && Math.abs(scroller.scrollTop - written) < 1) return;
          if (pendingRef.current === intent) cancelPending();
        };
        scroller.addEventListener("scroll", onScroll, { passive: true });
        detachRef.current = () => scroller.removeEventListener("scroll", onScroll);
      }
    }
    pump();
  }, [cancelPending, pump, scrollerFor]);

  const applyPosition = useCallback((position: CalendarPosition, target: TimelineView, anchorDate: string, options?: { resetHorizontal?: boolean }): boolean => {
    const root = rootRef.current;
    const scroller = scrollerFor(target);
    if (!root || !scroller) return true;          // 视图没渲染：没有可恢复的东西
    const viewport = measureViewport(scroller);
    if (viewport.height <= 0) return false;       // 布局尚未测量：下一帧／等 ResizeObserver
    const tracks = measureTracks(root, target, viewport);
    const track = pickTrackForPosition(tracks, anchorDate, position);
    if (!track) return true;                      // 没有轨道可对齐：不空转
    if (track.height <= 0) return false;
    const next = scrollTopForCalendarPosition({ position, viewportHeight: viewport.height, track });
    if (next === null) return true;
    scroller.scrollTop = next;
    if (options?.resetHorizontal) scroller.scrollLeft = 0;
    return true;
  }, [rootRef, scrollerFor]);

  // 每次视图／日期变更递增 generation，并把离开前的最后一次内存值刷新下来。
  // 顺序很重要：它必须排在下面的恢复 effect 之前，先作废旧请求再排新请求。
  const transitionKey = `${view}:${date}`;
  const transitionRef = useRef(transitionKey);
  useLayoutEffect(() => {
    if (transitionRef.current === transitionKey) return;
    const previous = transitionRef.current.slice(0, transitionRef.current.indexOf(":")) as CalendarView;
    if (previous === "day" || previous === "week") commitLatest(previous);
    transitionRef.current = transitionKey;
    generationRef.current += 1;
    cancelPending();
  }, [cancelPending, commitLatest, transitionKey]);

  const initialPositionFor = useCallback((target: TimelineView): CalendarPosition | null => {
    const anchorDate = dateRef.current;
    const today = localDateOf(nowRef.current);
    const isToday = target === "day" ? anchorDate === today : datesRef.current.includes(today);
    const nowDate = nowRef.current;
    const minute = initialCalendarMinute({
      isToday,
      nowMinute: nowDate.getHours() * 60 + nowDate.getMinutes(),
      slots: slotsRef.current,
      weekday: weekdayOf(anchorDate),
    });
    return { date: anchorDate, minute, viewportRatio: 0.5 };
  }, []);

  // 进入视图：有记忆就恢复，没有记忆才做首次定位（今天→现在／其它→首个默认时段）。
  // 只在视图变化时执行；日期变化（含三日缓冲平移）不在这里插手。
  useLayoutEffect(() => {
    if (view !== "day" && view !== "week") return;
    const remembered = calendarPositions[view];
    if (remembered) {
      queue("restore", () => applyPosition(remembered, view, dateRef.current));
      return;
    }
    const initial = initialPositionFor(view);
    if (initial) queue("initial", () => applyPosition(initial, view, dateRef.current, { resetHorizontal: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // 缩放补偿（优先级 3）是同步的：延后一帧会让指针下的时间先跳一下再回来。
  // 它一旦落地就拥有控制权，待处理的恢复／首次定位全部作废。
  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    if (!anchor) return;
    zoomAnchorRef.current = null;
    const pending = pendingRef.current;
    if (pending && priorityOf(pending.reason) > CALENDAR_SCROLL_PRIORITY.zoomAnchor) cancelPending();
    compensateZoomAnchor(anchor, rootRef.current);
  }, [cancelPending, rootRef, scale]);

  // 用户滚动：采样当前位置。滚动停止 300ms 后写成「已停下」的内存值；
  // 程序性滚动不写偏好（本工作包根本不写 Store），内存值只在下一次采样时刷新。
  useEffect(() => {
    if (view !== "day" && view !== "week") return;
    const scroller = scrollerFor(view);
    if (!scroller) return;
    const target: TimelineView = view;
    const onScroll = () => {
      const sampled = sampleNow(target, dateRef.current);
      if (sampled) latestRef.current = { view: target, position: sampled };
      if (settleRef.current !== null) window.clearTimeout(settleRef.current);
      settleRef.current = window.setTimeout(() => {
        settleRef.current = null;
        const settled = sampleNow(target, dateRef.current);
        if (settled) { calendarPositions[target] = settled; latestRef.current = { view: target, position: settled }; }
      }, CALENDAR_SAMPLE_SETTLE_MS);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (settleRef.current !== null) { window.clearTimeout(settleRef.current); settleRef.current = null; }
    };
  }, [sampleNow, scrollerFor, view]);

  // 尺寸变化：以时间保持为准，不要求旧像素相同。
  // generation 变化时重新订阅，所以过期的 ResizeObserver 回调永远不会改到新视图。
  //
  // 只有**视口尺寸真的变了**才重新落位。重新订阅时的首次回调、内容高度变化
  // （折叠展开等）都不算尺寸变化：拿上一次采样的逻辑位置去重算，会在日视图里把
  // 前一天的时刻对到视口中央 —— 那会直接触发一次反向的三日缓冲平移。
  useEffect(() => {
    if (view !== "day" && view !== "week") return;
    const scroller = scrollerFor(view);
    if (!scroller || typeof ResizeObserver !== "function") return;
    const generation = generationRef.current;
    let previousSize = `${scroller.clientWidth}x${scroller.clientHeight}`;
    const observer = new ResizeObserver(() => {
      if (generation !== generationRef.current) return;
      const size = `${scroller.clientWidth}x${scroller.clientHeight}`;
      const resized = size !== previousSize;
      previousSize = size;
      if (pendingRef.current) { pump(); return; }
      if (!resized) return;
      const latest = latestRef.current;
      if (!latest || latest.view !== view) return;
      applyPosition(latest.position, view, dateRef.current);
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [applyPosition, date, pump, scrollerFor, view]);

  // 拖拽期间（优先级 1）所有低优先级请求延后，dragend／drop 后重新判断。
  useEffect(() => {
    const start = () => { draggingRef.current = true; };
    const end = () => { draggingRef.current = false; pump(); };
    window.addEventListener("dragstart", start);
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("dragstart", start);
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
    };
  }, [pump]);

  // 卸载（切页）时刷新最后一次内存值。
  useEffect(() => () => {
    const current = viewRef.current;
    if (current === "day" || current === "week") commitLatest(current);
  }, [commitLatest]);

  useEffect(() => cancelPending, [cancelPending]);

  const flush = useCallback(() => {
    const current = viewRef.current;
    if (current !== "day" && current !== "week") return;
    const sampled = sampleNow(current, dateRef.current);
    if (sampled) { calendarPositions[current] = sampled; latestRef.current = { view: current, position: sampled }; return; }
    commitLatest(current);
  }, [commitLatest, sampleNow]);

  const revealNow = useCallback(() => {
    queue("reveal", () => {
      const root = rootRef.current;
      const marker = root?.querySelector<HTMLElement>("[data-now-marker]");
      if (!marker) return true;                   // 今天不在当前视图：没有可显露的对象
      marker.scrollIntoView?.({ behavior: "smooth", block: "center" });
      return true;
    });
  }, [queue, rootRef]);

  const revealSession = useCallback((sessionId: string) => {
    queue("reveal", () => {
      const root = rootRef.current;
      const element = root?.querySelector<HTMLElement>(`.calendar-session[data-session-id="${sessionId}"]`);
      if (!element) return true;
      element.scrollIntoView?.({ behavior: "smooth", block: "center" });
      return true;
    });
  }, [queue, rootRef]);

  const captureZoomAnchor = useCallback((measurement: ZoomAnchorMeasurement) => { zoomAnchorRef.current = measurement; }, []);

  /**
   * 应用自己刚刚程序化写入过滚动位置（日视图进入、三日缓冲平移、点「上一段／下一段」）。
   *
   * 这次写入会在下一个渲染帧产生一个 `scroll` 事件，但它不代表用户滚动；不区分的话
   * 「进入视图恢复」会被自己的定位当成「用户已经接管」而取消 —— 日视图进入时的
   * 三日缓冲重定位正是这种情况。
   *
   * 它同时是优先级 4 的落点：平移直接由日视图写位置，所以同代里不会再排一个
   * 与之争抢的恢复请求（日期变化本来也不会排队恢复）。
   */
  const noteProgrammaticPosition = useCallback(() => {
    const scroller = scrollerFor(viewRef.current as TimelineView);
    programmaticTopRef.current = scroller ? scroller.scrollTop : null;
    // 浏览器的同一个渲染帧里先派发 scroll 事件、再跑 rAF 回调；两帧足以覆盖
    // 「写入发生在 rAF 回调内、事件被推迟到下一帧」的情况。
    requestAnimationFrame(() => requestAnimationFrame(() => { programmaticTopRef.current = null; }));
  }, [scrollerFor]);

  const readGeneration = useCallback(() => generationRef.current, []);

  return {
    readGeneration,
    flush,
    revealNow,
    revealSession,
    captureZoomAnchor,
    noteProgrammaticPosition,
    positions: readCalendarPositions,
  };
}

/** 缩放锚点补偿：与阶段 3 相同的三分支（折叠段比例 → 整轨比例 → 内容比例）。 */
function compensateZoomAnchor(anchor: ZoomAnchorMeasurement, root: HTMLElement | null) {
  if (!root) return;
  const nextTrack = anchor.date ? root.querySelector<HTMLElement>(`.calendar-day[data-day-date="${anchor.date}"] .day-track`) : null;
  if (nextTrack && anchor.anchorMinute !== null) {
    const nextSegment = Array.from(nextTrack.querySelectorAll<HTMLElement>(".timeline-map-segment")).find((segment) => {
      const start = Number(segment.dataset.startMinute);
      const end = Number(segment.dataset.endMinute);
      return anchor.anchorMinute! >= start && anchor.anchorMinute! <= end;
    });
    if (nextSegment) {
      const start = Number(nextSegment.dataset.startMinute);
      const end = Number(nextSegment.dataset.endMinute);
      const rect = nextSegment.getBoundingClientRect();
      const ratio = (anchor.anchorMinute - start) / Math.max(1, end - start);
      anchor.scroller.scrollTop += rect.top + ratio * rect.height - anchor.clientY;
      return;
    }
  }
  if (nextTrack && anchor.anchorRatio !== null) {
    const nextRect = nextTrack.getBoundingClientRect();
    anchor.scroller.scrollTop += nextRect.top + anchor.anchorRatio * nextRect.height - anchor.clientY;
    return;
  }
  if (anchor.contentRatio !== null) {
    anchor.scroller.scrollTop = anchor.contentRatio * anchor.scroller.scrollHeight - anchor.pointerOffset;
  }
}

function measureViewport(scroller: HTMLElement): ViewportGeometry {
  const rect = scroller.getBoundingClientRect();
  return { top: rect.top + scroller.clientTop, height: scroller.clientHeight, scrollTop: scroller.scrollTop };
}

/** 读出当前视图里所有可采样轨道的几何：内容偏移 + 高度 + 折叠分段。 */
function measureTracks(root: HTMLElement, target: TimelineView, viewport: ViewportGeometry): TrackGeometry[] {
  const containers = Array.from(root.querySelectorAll<HTMLElement>(target === "day" ? ".continuous-day-panel" : ".calendar-day"));
  const tracks: TrackGeometry[] = [];
  for (const container of containers) {
    const trackDate = target === "day" ? container.dataset.calendarDate : container.dataset.dayDate;
    const track = container.querySelector<HTMLElement>(".day-track");
    if (!trackDate || !track) continue;
    const rect = track.getBoundingClientRect();
    if (rect.height <= 0) continue;
    tracks.push({
      date: trackDate,
      offsetTop: rect.top - viewport.top + viewport.scrollTop,
      height: rect.height,
      segments: readSegments(track, rect.top),
    });
  }
  return tracks;
}

function readSegments(track: HTMLElement, trackTop: number): TimelineSegment[] {
  return Array.from(track.querySelectorAll<HTMLElement>(".timeline-map-segment")).flatMap((element) => {
    const start = Number(element.dataset.startMinute);
    const end = Number(element.dataset.endMinute);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    const rect = element.getBoundingClientRect();
    return [{
      start, end,
      collapsed: element.dataset.collapsed === "true",
      gapKey: null,
      top: rect.top - trackTop,
      height: rect.height,
    }];
  });
}

function localDateOf(value: Date) {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 10);
}

function weekdayOf(date: string) {
  return new Date(`${date}T12:00:00`).getDay();
}
