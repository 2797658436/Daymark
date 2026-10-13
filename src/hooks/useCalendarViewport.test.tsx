import { act, render, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CALENDAR_SAMPLE_SETTLE_MS, dragEdgeScrollTop, firstDefaultSlotMinute, initialCalendarMinute, pickTrackForPosition,
  readCalendarPositions, resetCalendarPositions, sampleCalendarPosition, scrollTopForCalendarPosition,
  useCalendarViewport, type CalendarPosition, type CalendarViewportApi, type TrackGeometry,
} from "./useCalendarViewport";
import type { CalendarView, DefaultTimeSlot } from "../lib/settings";

const SLOTS: DefaultTimeSlot[] = [{ id: "evening", label: "晚间专注", start: "19:00", end: "22:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }];
const WEEK = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09"];

function track(date: string, offsetTop: number, height: number, segments: TrackGeometry["segments"] = []): TrackGeometry {
  return { date, offsetTop, height, segments };
}

function addDays(date: string, amount: number) {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + amount);
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 10);
}

beforeEach(() => resetCalendarPositions());

describe("calendar viewport geometry", () => {
  it("samples the viewport centre and restores the exact same scroll offset", () => {
    const tracks = WEEK.map((date) => track(date, 116, 1152));
    const viewport = { top: 0, height: 600, scrollTop: 276 };
    const position = sampleCalendarPosition({ anchorDate: "2026-08-05", view: "week", pointScreenY: 300, viewport, tracks });
    expect(position).not.toBeNull();
    expect(position!.date).toBe("2026-08-05");
    expect(position!.minute).toBeCloseTo(575, 5);
    expect(position!.viewportRatio).toBeCloseTo(0.5, 6);
    const restored = scrollTopForCalendarPosition({ position: position!, viewportHeight: 600, track: tracks[2] });
    expect(restored).toBeCloseTo(276, 6);
  });

  it("takes the middle of a collapsed strip and never needs to expand it", () => {
    const segments = [
      { start: 0, end: 1140, collapsed: true, gapKey: "0-1140", top: 0, height: 44 },
      { start: 1140, end: 1320, collapsed: false, gapKey: null, top: 44, height: 144 },
      { start: 1320, end: 1440, collapsed: true, gapKey: "1320-1440", top: 188, height: 44 },
    ];
    const folded = track("2026-08-05", 400, 232, segments);
    const position = sampleCalendarPosition({
      anchorDate: "2026-08-05", view: "day", pointScreenY: 300, viewport: { top: 0, height: 600, scrollTop: 120 }, tracks: [folded],
    });
    expect(position!.minute).toBe(570);
    // 恢复落在该条的像素中点，再采样仍是同一个分钟 —— 折叠条不产生累计漂移。
    const first = scrollTopForCalendarPosition({ position: position!, viewportHeight: 600, track: folded })!;
    const again = sampleCalendarPosition({
      anchorDate: "2026-08-05", view: "day", pointScreenY: 300, viewport: { top: 0, height: 600, scrollTop: first }, tracks: [folded],
    });
    expect(again!.minute).toBe(570);
    expect(scrollTopForCalendarPosition({ position: again!, viewportHeight: 600, track: folded })).toBeCloseTo(first, 6);
  });

  it("clamps to the track edge when the centre lands on the day separator and still round-trips", () => {
    const tracks = [track("2026-08-05", 320, 1152)];
    const viewport = { top: 0, height: 600, scrollTop: 0 };
    const position = sampleCalendarPosition({ anchorDate: "2026-08-05", view: "day", pointScreenY: 300, viewport, tracks })!;
    expect(position.minute).toBe(0);
    expect(position.viewportRatio).toBeCloseTo(320 / 600, 6);
    expect(scrollTopForCalendarPosition({ position, viewportHeight: 600, track: tracks[0] })).toBeCloseTo(0, 6);
  });

  it("falls back to the current anchor track when the remembered date is not rendered", () => {
    const tracks = WEEK.map((date) => track(date, 116, 1152));
    const position: CalendarPosition = { date: "2026-09-09", minute: 720, viewportRatio: 0.5 };
    expect(pickTrackForPosition(tracks, "2026-08-05", position)?.date).toBe("2026-08-05");
    expect(pickTrackForPosition(tracks, "2026-08-05", { ...position, date: "2026-08-07" })?.date).toBe("2026-08-07");
  });

  it("resolves the priority-6 fallback: today uses now, other days use the first default slot, then 09:00", () => {
    expect(initialCalendarMinute({ isToday: true, nowMinute: 830, slots: SLOTS, weekday: 3 })).toBe(830);
    expect(initialCalendarMinute({ isToday: false, nowMinute: 830, slots: SLOTS, weekday: 3 })).toBe(1140);
    expect(initialCalendarMinute({ isToday: false, nowMinute: 830, slots: [], weekday: 3 })).toBe(540);
    expect(firstDefaultSlotMinute(SLOTS, 3)).toBe(1140);
    expect(firstDefaultSlotMinute([{ id: "late", label: "跨夜", start: "23:00", end: "02:00", weekdays: [3] }], 3)).toBe(1380);
  });

  it("scrolls only inside the drag edge band", () => {
    expect(dragEdgeScrollTop({ currentScrollTop: 300, clientY: 170, viewportTop: 100, viewportBottom: 700 })).toBe(300);
    expect(dragEdgeScrollTop({ currentScrollTop: 300, clientY: 120, viewportTop: 100, viewportBottom: 700 })).toBe(291);
    expect(dragEdgeScrollTop({ currentScrollTop: 300, clientY: 690, viewportTop: 100, viewportBottom: 700 })).toBe(312);
  });
});

// ---------------------------------------------------------------------------
// 组件级：滚动仲裁、采样与恢复
// ---------------------------------------------------------------------------

function domRect(top: number, height: number, left = 0, width = 400) {
  return { top, left, bottom: top + height, right: left + width, width, height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

interface TrackSpec { element: HTMLElement; offsetTop: number; height: number; segments?: Array<{ start: number; end: number; top: number; height: number; collapsed: boolean }> }

/** 给 jsdom 装上可预测的纵向布局：轨道位置随 `scrollTop` 变化，和真实滚动一致。 */
function installLayout(scroller: HTMLElement, specs: TrackSpec[], viewportTop = 100, viewportHeight = 600) {
  let scrollTop = 0;
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => viewportHeight });
  Object.defineProperty(scroller, "clientTop", { configurable: true, get: () => 0 });
  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
  vi.spyOn(scroller, "getBoundingClientRect").mockImplementation(() => domRect(viewportTop, viewportHeight));
  for (const spec of specs) {
    spec.element.replaceChildren();
    vi.spyOn(spec.element, "getBoundingClientRect").mockImplementation(() => domRect(viewportTop + spec.offsetTop - scrollTop, spec.height));
    for (const segment of spec.segments ?? []) {
      const node = document.createElement("i");
      node.className = "timeline-map-segment";
      node.dataset.startMinute = String(segment.start);
      node.dataset.endMinute = String(segment.end);
      node.dataset.collapsed = String(segment.collapsed);
      spec.element.append(node);
      vi.spyOn(node, "getBoundingClientRect").mockImplementation(() => domRect(viewportTop + spec.offsetTop + segment.top - scrollTop, segment.height));
    }
  }
  return { read: () => scrollTop };
}

class StubResizeObserver {
  static instances: StubResizeObserver[] = [];
  constructor(private readonly callback: () => void) { StubResizeObserver.instances.push(this); }
  observe() { /* jsdom 没有布局，手动触发 */ }
  disconnect() { StubResizeObserver.instances = StubResizeObserver.instances.filter((item) => item !== this); }
  trigger() { this.callback(); }
}

function fireResize() { for (const instance of [...StubResizeObserver.instances]) instance.trigger(); }

interface HarnessProps {
  view: CalendarView;
  date?: string;
  now?: Date;
  dates?: string[];
  onApi: (api: CalendarViewportApi) => void;
}

function Harness({ view, date = "2026-08-05", now = new Date("2026-08-05T14:00:00"), dates = WEEK, onApi }: HarnessProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const api = useCalendarViewport({ view, date, now, scale: 48, slots: SLOTS, dates, rootRef });
  useEffect(() => { onApi(api); });
  if (view === "day") {
    return <div ref={rootRef}><div className="continuous-day-axis">
      {[addDays(date, -1), date, addDays(date, 1)].map((panelDate) => (
        <section key={panelDate} className="continuous-day-panel" data-calendar-date={panelDate}>
          <div className="continuous-day-separator" />
          <div className="calendar-grid day"><div className="calendar-day" data-day-date={panelDate}><div className="day-track" /></div></div>
        </section>
      ))}
    </div></div>;
  }
  if (view === "week") {
    return <div ref={rootRef}><div className="calendar-viewport">
      {dates.map((weekDate) => <div key={weekDate} className="calendar-day" data-day-date={weekDate}><div className="day-track" /></div>)}
    </div></div>;
  }
  return <div ref={rootRef}><div className="calendar-viewport"><div className="month-calendar" /></div></div>;
}

function daySpecs(root: ParentNode): TrackSpec[] {
  return Array.from(root.querySelectorAll<HTMLElement>(".continuous-day-panel")).map((panel, index) => ({
    element: panel.querySelector<HTMLElement>(".day-track")!,
    offsetTop: index * 1244 + 40,
    height: 1152,
  }));
}

function weekSpecs(root: ParentNode): TrackSpec[] {
  return Array.from(root.querySelectorAll<HTMLElement>(".calendar-day")).map((day) => ({
    element: day.querySelector<HTMLElement>(".day-track")!,
    offsetTop: 116,
    height: 1152,
  }));
}

async function nextFrame() {
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
}

describe("useCalendarViewport", () => {
  beforeEach(() => { StubResizeObserver.instances = []; vi.stubGlobal("ResizeObserver", StubResizeObserver); });

  it("restores the remembered position when the view is entered again", async () => {
    let api!: CalendarViewportApi;
    const first = render(<Harness view="week" onApi={(value) => { api = value; }} />);
    const scroller = first.container.querySelector<HTMLElement>(".calendar-viewport")!;
    const layout = installLayout(scroller, weekSpecs(first.container));
    act(() => { scroller.scrollTop = 400; scroller.dispatchEvent(new Event("scroll")); });
    await new Promise((resolve) => setTimeout(resolve, CALENDAR_SAMPLE_SETTLE_MS + 60));
    expect(readCalendarPositions().week?.minute).toBeCloseTo((400 + 300 - 116) / 1152 * 1440, 3);
    act(() => { api.flush(); });
    first.unmount();

    const second = render(<Harness view="week" onApi={() => undefined} />);
    const restored = second.container.querySelector<HTMLElement>(".calendar-viewport")!;
    const restoredLayout = installLayout(restored, weekSpecs(second.container));
    await waitFor(() => expect(restoredLayout.read()).toBeCloseTo(400, 0));
  });

  it("waits for a measurable track instead of guessing with a fixed delay", async () => {
    render(<Harness view="week" onApi={() => undefined} />);
    const scroller = document.querySelector<HTMLElement>(".calendar-viewport")!;
    // 还没有布局：不能恢复，也不能把「未测量」当成「已到位」。
    for (let index = 0; index < 8; index += 1) await nextFrame();
    expect(scroller.scrollTop).toBe(0);
    const layout = installLayout(scroller, weekSpecs(document));
    for (let index = 0; index < 4; index += 1) await nextFrame();
    // 光有布局、没有尺寸事件也不猜：只有轨道真正可测量时才落地。
    expect(layout.read()).toBe(0);
    act(() => { fireResize(); });
    await waitFor(() => expect(layout.read()).toBeGreaterThan(0));
    expect(layout.read()).toBeCloseTo(116 + 840 / 1440 * 1152 - 300, 0);
  });

  it("lets any user scroll cancel a pending restore", async () => {
    render(<Harness view="week" onApi={() => undefined} />);
    const scroller = document.querySelector<HTMLElement>(".calendar-viewport")!;
    for (let index = 0; index < 8; index += 1) await nextFrame();
    const layout = installLayout(scroller, weekSpecs(document));
    act(() => { scroller.scrollTop = 900; scroller.dispatchEvent(new Event("scroll")); });
    act(() => { fireResize(); });
    await nextFrame(); await nextFrame();
    expect(layout.read()).toBe(900);
  });

  it("defers a lower-priority restore until the drag ends", async () => {
    render(<Harness view="week" onApi={() => undefined} />);
    const scroller = document.querySelector<HTMLElement>(".calendar-viewport")!;
    for (let index = 0; index < 8; index += 1) await nextFrame();
    const layout = installLayout(scroller, weekSpecs(document));
    act(() => { window.dispatchEvent(new Event("dragstart")); });
    act(() => { fireResize(); });
    await nextFrame(); await nextFrame();
    expect(layout.read()).toBe(0);
    act(() => { window.dispatchEvent(new Event("dragend")); });
    await waitFor(() => expect(layout.read()).toBeGreaterThan(0));
  });

  it("does not treat the app's own programmatic positioning as a user scroll", async () => {
    const holder: { api: CalendarViewportApi | null } = { api: null };
    render(<Harness view="week" onApi={(value) => { holder.api = value; }} />);
    const scroller = document.querySelector<HTMLElement>(".calendar-viewport")!;
    for (let index = 0; index < 8; index += 1) await nextFrame();
    const layout = installLayout(scroller, weekSpecs(document));
    // 视图切换时子组件会把三日缓冲重新定位（layout effect 里写 scrollTop）。
    // 这次 scroll 事件不是用户滚动，不能作废「进入视图恢复」。
    act(() => { scroller.scrollTop = 116; holder.api!.noteProgrammaticPosition(); scroller.dispatchEvent(new Event("scroll")); });
    act(() => { fireResize(); });
    await waitFor(() => expect(layout.read()).toBeGreaterThan(116));
  });

  it("only re-anchors the visible time when the viewport size really changed", async () => {
    render(<Harness view="week" onApi={() => undefined} />);
    const scroller = document.querySelector<HTMLElement>(".calendar-viewport")!;
    for (let index = 0; index < 8; index += 1) await nextFrame();
    const layout = installLayout(scroller, weekSpecs(document));
    act(() => { fireResize(); });
    await waitFor(() => expect(layout.read()).toBeGreaterThan(0));
    const initial = layout.read();
    act(() => { scroller.dispatchEvent(new Event("scroll")); });
    act(() => { scroller.scrollTop = initial + 240; });
    // 重新观察／内容变化都不算尺寸变化：拿上一次采样的位置重算会把视图拽回旧时刻。
    act(() => { fireResize(); });
    await nextFrame(); await nextFrame();
    expect(layout.read()).toBe(initial + 240);
  });

  it("increments the generation on every view and date change", async () => {
    const holder: { api: CalendarViewportApi | null } = { api: null };
    const onApi = (value: CalendarViewportApi) => { holder.api = value; };
    const view = render(<Harness view="week" date="2026-08-05" onApi={onApi} />);
    const start = holder.api!.readGeneration();
    view.rerender(<Harness view="week" date="2026-08-06" onApi={onApi} />);
    expect(holder.api!.readGeneration()).toBe(start + 1);
    view.rerender(<Harness view="day" date="2026-08-06" onApi={onApi} />);
    expect(holder.api!.readGeneration()).toBe(start + 2);
    view.rerender(<Harness view="day" date="2026-08-07" onApi={onApi} />);
    expect(holder.api!.readGeneration()).toBe(start + 3);
  });

  it("keeps no timeline coordinate for the month view", async () => {
    const view = render(<Harness view="month" date="2026-08-05" onApi={() => undefined} />);
    const scroller = view.container.querySelector<HTMLElement>(".calendar-viewport")!;
    installLayout(scroller, []);
    act(() => { scroller.scrollTop = 120; scroller.dispatchEvent(new Event("scroll")); });
    await new Promise((resolve) => setTimeout(resolve, CALENDAR_SAMPLE_SETTLE_MS + 60));
    expect(readCalendarPositions()).toEqual({ day: null, week: null });
  });
});
