import { describe, expect, it } from "vitest";

import { concurrentLayouts, dropImpact, insertionChanges, placeableSessions, resolveCalendarDrop } from "./calendarPlacement";
import type { ExecutionSession } from "./native";

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
});
