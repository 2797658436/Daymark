import { useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * 拖动／改时长时贴着卡片的浮动时间读数。
 *
 * 时间块与已排卡片此前各写了一份**逐字相同**的定位逻辑（越界翻转、8px 贴边、
 * 190px 预留、`is-above` 翻转），只有文案不同。这里只留一份。
 *
 * `followKey` 每次拖拽更新都要变（用实时分钟数即可）：读数要跟着卡片走，所以必须
 * 每一步重新量锚点，而不是只在开始时量一次。
 *
 * 渲染进 `document.body` 的 portal：`left/top` 是按**视口坐标**算的，而日历里有三层
 * 会截获 `position: fixed` 的包含块 —— `.calendar-viewport`（`container-type: inline-size`）、
 * `.calendar-session`／`.calendar-time-block`（`container-type: size`）以及拖动中跟手卡的
 * `transform`。留在卡片里，读数就会按「卡片内的坐标」摆放（实测偏到 851/676，卡片在 425/310）。
 *
 * 改时长时卡片高度是**过渡**过去的：`followKey` 连续变化时量到的是过渡起点附近的高度，
 * 停手后会停在卡片内部（实测读数落在卡片 15:30 的位置上）。所以再听一次 `transitionend`，
 * 等卡片真正长到落点后重量一次。用事件而不是逐帧轮询，jsdom 里不会触发，单测无需包 act。
 */
export function DragTimePreview({ active, anchorRef, label, followKey, children }: {
  active: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  /** 可访问名，例如「时间块时间预览」。 */
  label: string;
  /** 变化即重新量锚点；传实时分钟数之类每步都变的值。 */
  followKey: string | number | null;
  children: ReactNode;
}) {
  const [box, setBox] = useState<null | { left: number; top: number; above: boolean }>(null);
  /** 锚点自身的几何变了（过渡结束）：加一，让下面的 effect 重量一次。 */
  const [revision, setRevision] = useState(0);
  useLayoutEffect(() => {
    if (!active) { setBox(null); return; }
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
    const viewportHeight = typeof window === "undefined" ? 768 : window.innerHeight;
    const above = rect.bottom + 46 > viewportHeight;
    setBox({ left: Math.max(8, Math.min(viewportWidth - 190, rect.left)), top: above ? rect.top - 7 : rect.bottom + 7, above });
  }, [active, anchorRef, followKey, revision]);
  useEffect(() => {
    if (!active) return;
    const node = anchorRef.current;
    if (!node) return;
    const remeasure = (event: TransitionEvent) => { if (event.target === node) setRevision((value) => value + 1); };
    node.addEventListener("transitionend", remeasure);
    return () => node.removeEventListener("transitionend", remeasure);
  }, [active, anchorRef]);
  if (!box || typeof document === "undefined") return null;
  return createPortal(<div className={`drag-time-preview${box.above ? " is-above" : ""}`} role="status" aria-label={label} style={{ left: `${box.left}px`, top: `${box.top}px` }}>{children}</div>, document.body);
}
