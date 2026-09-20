import type { AppSettings } from "./settings";

/**
 * 拖拽／缩放共用的时间换算核心。
 *
 * 这些规则此前在四个地方各写了一份（时间块整块拖动、时间块改上／下边、卡片改时长、
 * 拖拽落点预览），语义完全相同却分散在 `App.tsx` 里。抽出来只此一份，
 * 阶段 5 把卡片拖动也换成 pointer 之后，第三处调用者直接复用同一套。
 */

/**
 * 当前生效的吸附粒度（分钟）。
 *
 * `Alt` 反转当前设置：开着吸附时按 `Alt` 变成自由（1 分钟），关着吸附时按 `Alt`
 * 变成 15 分钟。`Ctrl` 不参与 —— 它已经被日历缩放占用。
 */
export function snapMinutesFor(setting: AppSettings["snapMinutes"], altKey: boolean): number {
  if (altKey) return setting === "off" ? 15 : 1;
  return setting === "off" ? 1 : setting;
}

/** 按粒度吸附（四舍五入到最近的格线），并钳制到 `[min, max]`。 */
export function snapTo(minutes: number, snap: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(minutes / snap) * snap));
}

/** 吸附到格线但不做「自由跟手」：用于改时长／改边这类边界本身就是落点的场景。 */
export function snapDelta(deltaMinutes: number, snap: number): number {
  return Math.round(deltaMinutes / snap) * snap;
}

/**
 * 落点指示框（虚线框）的最小高度，单位像素。
 *
 * 指示框按真实时长画，但卡片自身有 `min-height`（时间块 28px、卡片 25px）：
 * 15–30 分钟的短安排在紧凑比例下只有 12–24px，虚线框会比卡片还矮 ——
 * 看上去"太短"，也不像一个能对准的落点。统一抬到卡片之上。
 */
export const DRAG_TARGET_MIN_PX = 32;
