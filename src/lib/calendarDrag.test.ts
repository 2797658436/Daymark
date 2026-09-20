import { beforeEach, describe, expect, it } from "vitest";

import { beginCalendarDrag, calendarDragGrabOffset, calendarDragIds, calendarDragTypes, endCalendarDrag } from "./calendarDrag";

const transfer = (data: Record<string, string>) => ({
  types: Object.keys(data),
  getData: (type: string) => data[type] ?? "",
}) as unknown as DataTransfer;

/** 真实浏览器在 dragenter/dragover 期间就是长这样：types 可读，getData 一律空串。 */
const protectedTransfer = (types: string[]) => ({ types, getData: () => "" }) as unknown as DataTransfer;

describe("calendar drag payload", () => {
  beforeEach(() => endCalendarDrag());

  it("keeps the dragged item readable while dragover hides the data transfer", () => {
    beginCalendarDrag({ kind: "session", id: "session-1", grabOffsetY: 12 });
    expect(calendarDragIds(protectedTransfer(["application/x-daymark-session"]))).toEqual({ taskId: "", sessionId: "session-1" });
    expect(calendarDragGrabOffset(protectedTransfer(["application/x-daymark-session"]))).toBe(12);
  });

  it("prefers real transfer data at drop time", () => {
    beginCalendarDrag({ kind: "session", id: "session-1", grabOffsetY: 12 });
    expect(calendarDragIds(transfer({ "application/x-daymark-session": "session-9" }))).toEqual({ taskId: "", sessionId: "session-9" });
    expect(calendarDragGrabOffset(transfer({ "application/x-daymark-grab": "27" }))).toBe(27);
  });

  it("never lets a foreign drag borrow the shadow copy", () => {
    beginCalendarDrag({ kind: "task", id: "task-1", grabOffsetY: 4 });
    // 从窗口外拖文件进来：types 里没有日历自己的类型，不该凭空造出一次排程。
    expect(calendarDragIds(transfer({ Files: "" }))).toEqual({ taskId: "", sessionId: "" });
    expect(calendarDragIds(protectedTransfer([]))).toEqual({ taskId: "", sessionId: "" });
  });

  it("classifies the dragged kind, and reports nothing for an empty transfer", () => {
    expect(calendarDragTypes(transfer({ "application/x-daymark-session": "s" }))).toEqual({ task: false, session: true });
    expect(calendarDragTypes(transfer({ "application/x-daymark-task": "t" }))).toEqual({ task: true, session: false });
    expect(calendarDragTypes(null)).toEqual({ task: false, session: false });
    expect(calendarDragGrabOffset(null)).toBe(0);
  });
});
