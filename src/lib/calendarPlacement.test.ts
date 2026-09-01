import { describe, expect, it } from "vitest";

import { concurrentLayouts, insertionChanges } from "./calendarPlacement";
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
    const four = concurrentLayouts([session("a", "10:00", "11:00"), session("b", "10:00", "11:00"), session("c", "10:00", "11:00"), session("d", "10:00", "11:00")]);
    expect(four.get("b")).toMatchObject({ hidden: false, hiddenCount: 2 });
    expect(four.get("c")).toMatchObject({ hidden: true });
    const chain = concurrentLayouts([session("a", "10:00", "11:00"), session("b", "10:30", "11:30"), session("c", "11:00", "12:00"), session("d", "11:30", "12:30")]);
    expect(chain.get("a")).toMatchObject({ width: 50, hidden: false, hiddenCount: 0 });
    expect(chain.get("c")).toMatchObject({ width: 50, hidden: false, hiddenCount: 0 });
  });
});
