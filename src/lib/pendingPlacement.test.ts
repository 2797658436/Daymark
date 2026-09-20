import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { placementSettled, readPendingPlacement, setPendingPlacement, usePendingPlacement } from "./pendingPlacement";
import type { ExecutionSession } from "./native";

const session = (overrides: Partial<ExecutionSession> = {}): ExecutionSession => ({
  id: "session-1", taskId: "task-1", localDate: "2026-08-05", endLocalDate: "2026-08-05",
  startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled",
  ...overrides,
});

const landed = { sessionId: "session-1", localDate: "2026-08-06", endLocalDate: "2026-08-06", startLocal: "14:00", endLocal: "15:00" };

describe("pending placement", () => {
  beforeEach(() => setPendingPlacement(null));

  it("holds the landed position until the workspace catches up", () => {
    setPendingPlacement(landed);
    expect(readPendingPlacement()).toBe(landed);
    // 还没追上：源列那一次的事实仍是旧时间
    expect(placementSettled(landed, [session()])).toBe(false);
    // 只差一个字段也算没追上（写入回来了但值不同 = 仍是旧事实）
    expect(placementSettled(landed, [session({ localDate: "2026-08-06", endLocalDate: "2026-08-06", startLocal: "14:00", endLocal: "15:15" })])).toBe(false);
    expect(placementSettled(landed, [])).toBe(false);
    // 追上了：可以撤掉覆盖显示
    expect(placementSettled(landed, [session({ localDate: "2026-08-06", endLocalDate: "2026-08-06", startLocal: "14:00", endLocal: "15:00" })])).toBe(true);
  });

  it("re-renders both columns from the same store", () => {
    // 源列与目标列是两个并列组件：任一处写入/清除都必须让两边同时看到。
    const source = renderHook(() => usePendingPlacement());
    const target = renderHook(() => usePendingPlacement());
    expect(source.result.current).toBeNull();
    act(() => setPendingPlacement(landed));
    expect(source.result.current).toEqual(landed);
    expect(target.result.current).toEqual(landed);
    act(() => setPendingPlacement(null));
    expect(source.result.current).toBeNull();
    expect(target.result.current).toBeNull();
  });
});
