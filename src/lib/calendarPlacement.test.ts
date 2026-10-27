import { describe, expect, it } from "vitest";

import { blockOverlapping, concurrentLayouts, dropImpact, insertionChanges, laneXSpan, placeableSessions, resolveCalendarDrop, resizeChanges, sessionHitAtPoint, type SessionHitCard } from "./calendarPlacement";
import type { ExecutionSession, TimeBlock } from "./native";

const session = (id: string, startLocal: string, endLocal: string): ExecutionSession => ({ id, taskId: `task-${id}`, localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal, endLocal, timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" });

describe("calendar placement", () => {
  it("previews insertion by pushing every colliding later session without changing duration", () => {
    const changes = insertionChanges([
      session("target", "10:00", "11:00"),
      session("next", "11:15", "12:00"),
      session("later", "12:00", "12:30"),
    ], "new", "target", "before", 30);
    expect(changes.map((change) => [change.session.id, change.startMinute])).toEqual([["target", 630], ["next", 690], ["later", 735]]);
  });

  it("uses equal columns for two or three overlaps and summarizes four or more", () => {
    const two = concurrentLayouts([session("a", "10:00", "11:00"), session("b", "10:15", "10:45")]);
    expect(two.get("a")).toMatchObject({ left: 0, width: 50, hidden: false });
    expect(two.get("b")).toMatchObject({ left: 50, width: 50, hidden: false });
    const three = concurrentLayouts([session("a", "10:00", "11:00"), session("b", "10:00", "11:00"), session("c", "10:00", "11:00")]);
    expect(three.get("c")).toMatchObject({ left: 200 / 3, width: 100 / 3, hidden: false });
    const four = concurrentLayouts([session("a", "10:00", "11:00"), session("b", "10:00", "11:00"), session("c", "10:00", "11:00"), session("d", "10:00", "11:00")]);
    expect(four.get("b")).toMatchObject({ hidden: false, hiddenCount: 2 });
    expect(four.get("c")).toMatchObject({ hidden: true });
    const chain = concurrentLayouts([session("a", "10:00", "11:00"), session("b", "10:30", "11:30"), session("c", "11:00", "12:00"), session("d", "11:30", "12:30")]);
    expect(chain.get("a")).toMatchObject({ width: 50, hidden: false, hiddenCount: 0 });
    expect(chain.get("c")).toMatchObject({ width: 50, hidden: false, hiddenCount: 0 });
  });

  it("summarizes the third lane when the side-by-side limit is two", () => {
    const sessions = [session("a", "10:00", "11:00"), session("b", "10:00", "11:00"), session("c", "10:00", "11:00")];
    const narrow = concurrentLayouts(sessions, 2);
    expect(narrow.get("a")).toMatchObject({ left: 0, width: 50, hidden: false });
    expect(narrow.get("b")).toMatchObject({ left: 50, width: 50, hidden: false, hiddenCount: 1, totalCount: 3 });
    expect(narrow.get("c")).toMatchObject({ hidden: true, width: 50 });
    const two = concurrentLayouts([session("a", "10:00", "11:00"), session("b", "10:00", "11:00")], 2);
    expect(two.get("b")).toMatchObject({ left: 50, hidden: false, hiddenCount: 0 });
    const four = concurrentLayouts([session("a", "10:00", "11:00"), session("b", "10:00", "11:00"), session("c", "10:00", "11:00"), session("d", "10:00", "11:00")], 2);
    expect(four.get("b")).toMatchObject({ hiddenCount: 2 });
    expect(four.get("c")).toMatchObject({ hidden: true });
  });

  it("keeps preview and commit on one input set: only scheduled|missed of that day", () => {
    const sessions = [
      session("scheduled", "10:00", "11:00"),
      { ...session("missed", "11:00", "12:00"), status: "missed" as const },
      { ...session("cancelled", "12:00", "13:00"), status: "cancelled" as const },
      { ...session("other-day", "10:00", "11:00"), localDate: "2026-08-06" },
    ];
    expect(placeableSessions(sessions, "2026-08-05").map((item) => item.id)).toEqual(["scheduled", "missed"]);
  });

  it("previews place in the middle but commits overlap (D5), and resolves both edges identically", () => {
    const sessions = [session("target", "10:00", "11:00"), session("next", "11:00", "12:00")];
    const base = { sessions, sourceSessionId: "source", sourceDuration: 60, pointerMinute: 600, targetSessionId: "target" };
    // 拖动中中央：停在 place，只提示「悬停半秒」。
    expect(resolveCalendarDrop({ ...base, targetRatio: .5, commit: false })).toMatchObject({ mode: "place", startMinute: 600, shifted: [] });
    // 松手：没有 latch 也按 overlap 提交，目标卡不动（F04/D5）。
    expect(resolveCalendarDrop({ ...base, targetRatio: .5, commit: true })).toMatchObject({ mode: "overlap", startMinute: 600, shifted: [] });
    // 边缘两路：预览与提交同口径，后移集合完全一致。
    const before = resolveCalendarDrop({ ...base, targetRatio: .1, commit: false });
    const committed = resolveCalendarDrop({ ...base, targetRatio: .1, commit: true });
    expect(before).toMatchObject({ mode: "insert-before", startMinute: 600 });
    expect(committed).toEqual(before);
    expect(before.shifted.map((change) => [change.session.id, change.startMinute])).toEqual([["target", 660], ["next", 720]]);
    expect(resolveCalendarDrop({ ...base, targetRatio: .9, commit: true })).toMatchObject({ mode: "insert-after", startMinute: 660 });
  });

  it("commits a centre overlap at the released minute, not at the target's start (D16)", () => {
    const sessions = [session("target", "10:00", "11:00"), session("next", "11:00", "12:00")];
    // 指针落在目标卡中央（ratio .5）但松手时刻是 10:30：并排的第二张要能被拖到部分错开的位置。
    const centre = { sessions, sourceSessionId: "source", sourceDuration: 60, pointerMinute: 630, targetSessionId: "target", targetRatio: .5 };
    // 拖动中（未闩锁）仍是 place，落点已经等于松手分钟 —— 预览与提交同一个位置。
    expect(resolveCalendarDrop({ ...centre, commit: false })).toMatchObject({ mode: "place", startMinute: 630, shifted: [] });
    // 半秒闩锁：只是把读数确认成「同时安排」，落点跟手，不再跳到目标起点。
    expect(resolveCalendarDrop({ ...centre, overlapLatched: true, commit: false })).toMatchObject({ mode: "overlap", startMinute: 630, shifted: [] });
    // 松手：mode 与 startMinute 与预览同口径（D5 的「不静默丢弃」保持不变）。
    expect(resolveCalendarDrop({ ...centre, commit: true })).toMatchObject({ mode: "overlap", startMinute: 630, targetSessionId: "target", shifted: [] });
    // 调用方已决定 overlap 而没给 ratio（旧入口）：同一条规则，取指针分钟。
    expect(resolveCalendarDrop({ ...centre, targetRatio: null, requestedMode: "overlap", commit: true })).toMatchObject({ mode: "overlap", startMinute: 630 });
  });

  it("hits a card only inside its own side-by-side lane, so the gutter between lanes places freely", () => {
    const track = { left: 0, width: 200 };
    // 两张并排：各占半栏，栏间让出 4px 描边（与渲染的 `calc(...% + 4px)` 同口径）。
    const laneOf = (percent: number) => laneXSpan(track, { left: percent, width: 50 });
    expect(laneOf(0)).toEqual({ left: 4, right: 96 });
    expect(laneOf(50)).toEqual({ left: 104, right: 196 });
    const cards: SessionHitCard[] = [
      { sessionId: "left", top: 600, height: 60, ...laneOf(0) },
      { sessionId: "right", top: 600, height: 60, ...laneOf(50) },
    ];
    // 拖右栏那一张时它是源卡、不参与命中（`sessionAtPoint` 排除源），候选只剩左栏。
    const others = [cards[0]];
    // 纵向与左栏那张交叠，但横向在右栏里 → 不构成命中（这就是「错开时间」的入口）。
    expect(sessionHitAtPoint(others, 150, 630)).toBeNull();
    // 栏间 8px 空白同样不构成命中。
    expect(sessionHitAtPoint(others, 100, 630)).toBeNull();
    // 压在某张卡的栏里才命中，ratio 按纵向原计划几何算。
    expect(sessionHitAtPoint(cards, 50, 630)).toEqual({ sessionId: "left", ratio: .5 });
    expect(sessionHitAtPoint([cards[1]], 150, 630)).toEqual({ sessionId: "right", ratio: .5 });
    // 没有并排布局时整栏可用（单卡列），保留既有的边缘插入命中面。
    const single = laneXSpan(track, null);
    expect(single).toEqual({ left: 4, right: 196 });
    const only = sessionHitAtPoint([{ sessionId: "only", top: 600, height: 60, ...single }], 190, 605);
    expect(only?.sessionId).toBe("only");
    expect(only?.ratio).toBeCloseTo(5 / 60, 4);
    // 无命中 → 调用方走 place：自由分钟 + 既有吸附语义。
    expect(resolveCalendarDrop({
      sessions: [session("left", "10:00", "11:00")], sourceSessionId: "right", sourceDuration: 60, pointerMinute: 630, targetSessionId: "",
    })).toMatchObject({ mode: "place", startMinute: 630, targetSessionId: "", shifted: [] });
  });

  it("only reports a boundary impact when the insertion pushes something out of the day or the default slots", () => {
    const ranges = [{ start: 1140, end: 1320 }];
    // 没有后移 → 不打扰用户（§188「没有跨时段的普通插入直接提交」）。
    expect(dropImpact({ date: "2026-08-05", shifted: [], defaultRanges: ranges })).toBeNull();
    // 后移但仍在默认时段内 → 也不确认。
    expect(dropImpact({ date: "2026-08-05", shifted: [{ session: session("a", "19:00", "19:30"), startMinute: 1200 }], defaultRanges: ranges })).toBeNull();
    // 被推出默认时段 → 记下受影响项。
    const outside = dropImpact({ date: "2026-08-05", shifted: [{ session: session("a", "19:30", "20:00"), startMinute: 1320 }], defaultRanges: ranges });
    expect(outside).toMatchObject({ reason: "outside-slots", dates: [] });
    expect(outside?.affected.map((change) => change.session.id)).toEqual(["a"]);
    // 被推到第二天 → 记下新日期（且原因优先报「跨天」）。
    const across = dropImpact({ date: "2026-08-05", shifted: [{ session: session("a", "23:00", "23:30"), startMinute: 1440 }], defaultRanges: [] });
    expect(across).toMatchObject({ reason: "cross-day", dates: ["2026-08-06"] });
    // 没有配置默认时段时不存在「越界」，只判跨天。
    expect(dropImpact({ date: "2026-08-05", shifted: [{ session: session("a", "10:00", "11:00"), startMinute: 600 }], defaultRanges: [] })).toBeNull();
  });

  it("pushes later sessions when a resize grows, but leaves shrinking and parallel runs alone", () => {
    const source = session("source", "10:00", "11:00");
    const sessions = [source, session("next", "11:00", "12:00"), session("later", "12:00", "12:30"), session("parallel", "10:00", "11:00")];
    // 拉长到 11:30：原本 11:00–12:00 那一项整体让到 11:30，12:00 那一项顺次接在它后面；
    // 并排那一项（同样起始 10:00）不动 —— 它从来没有落在被延长的那一段里（§198 的反面）。
    const grown = resizeChanges({ sessions, session: source, startMinute: 600, duration: 90 });
    expect(grown.map((change) => [change.session.id, change.startMinute])).toEqual([["next", 690], ["later", 750]]);
    // 拉长到原来一样长 / 缩短：一个都不动，只释放空档（§198）。
    expect(resizeChanges({ sessions, session: source, startMinute: 600, duration: 60 })).toEqual([]);
    expect(resizeChanges({ sessions, session: source, startMinute: 600, duration: 30 })).toEqual([]);
    // 拉长到 12:00 正好压住 next 的起点：它让到 12:00，后面的 later 顺延。
    expect(resizeChanges({ sessions, session: source, startMinute: 600, duration: 120 }).map((change) => [change.session.id, change.startMinute])).toEqual([["next", 720], ["later", 780]]);
  });

  it("finds the time block a resize covers even when the pointer sits on the bottom handle", () => {
    const block = (id: string, startLocal: string, endLocal: string, localDate = "2026-08-05"): TimeBlock => ({ id, title: id, localDate, endLocalDate: localDate, startLocal, endLocal, timeZone: "Asia/Shanghai", utcOffsetMinutes: 480 });
    const blocks = [block("lunch", "11:30", "12:30"), block("next-day", "11:30", "12:30", "2026-08-06"), block("midnight", "23:30", "00:30")];
    // 10:00–12:00 盖住午休；10:00–11:00 不碰它。
    expect(blockOverlapping({ blocks, date: "2026-08-05", startMinute: 600, duration: 120 })?.id).toBe("lunch");
    expect(blockOverlapping({ blocks, date: "2026-08-05", startMinute: 600, duration: 60 })).toBeNull();
    // 只看预览所在的那一天。
    expect(blockOverlapping({ blocks, date: "2026-08-06", startMinute: 600, duration: 120 })?.id).toBe("next-day");
    // 跨午夜的块按 24 小时算结尾。
    expect(blockOverlapping({ blocks, date: "2026-08-05", startMinute: 1380, duration: 60 })?.id).toBe("midnight");
  });
});
