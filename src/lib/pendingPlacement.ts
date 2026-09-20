import { useSyncExternalStore } from "react";

import type { ExecutionSession } from "./native";

/**
 * 松手之后、写入回来之前，那次放置应该出现在哪里。
 *
 * 卡片走的是原生 HTML5 拖拽：松手那一刻 workspace 还是旧数据，源列会继续把这一份
 * 画在旧时间上，等写入回来才「跳」到目标列 —— 就是跨列松手时的错位动画。
 * 时间块那边靠组件内的 `landed` 覆盖解决同一问题，但卡片的源列与目标列是两个并列的
 * 兄弟组件，只能靠一份共享状态：目标列按落点先画一份，源列把同一份藏起来。
 *
 * 写入失败、或 workspace 追上落点时清除；一清除，源列自动恢复显示。
 */
export interface PendingPlacement {
  sessionId: string;
  localDate: string;
  endLocalDate: string;
  startLocal: string;
  endLocal: string;
}

let pending: PendingPlacement | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setPendingPlacement(next: PendingPlacement | null): void {
  if (pending === next) return;
  pending = next;
  for (const listener of listeners) listener();
}

export function readPendingPlacement(): PendingPlacement | null {
  return pending;
}

/** 供组件读取；列与列之间共享同一份，任一处清除都会让两边同时重渲染。 */
export function usePendingPlacement(): PendingPlacement | null {
  return useSyncExternalStore(subscribe, readPendingPlacement, readPendingPlacement);
}

/** workspace 是否已经追上这次落点 —— 追上就该撤掉覆盖显示。 */
export function placementSettled(placement: PendingPlacement, sessions: ExecutionSession[]): boolean {
  const session = sessions.find((item) => item.id === placement.sessionId);
  return Boolean(session
    && session.localDate === placement.localDate
    && session.endLocalDate === placement.endLocalDate
    && session.startLocal === placement.startLocal
    && session.endLocal === placement.endLocal);
}
