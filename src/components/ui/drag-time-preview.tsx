import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";

/**
 * 拖动／改时长时贴着卡片的浮动时间读数。
 *
 * 时间块与已排卡片此前各写了一份**逐字相同**的定位逻辑（越界翻转、8px 贴边、
 * 190px 预留、`is-above` 翻转），只有文案不同。这里只留一份。
 *
 * `followKey` 每次拖拽更新都要变（用实时分钟数即可）：读数要跟着卡片走，所以必须
 * 每一步重新量锚点，而不是只在开始时量一次。
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
  useLayoutEffect(() => {
    if (!active) { setBox(null); return; }
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
    const viewportHeight = typeof window === "undefined" ? 768 : window.innerHeight;
    const above = rect.bottom + 46 > viewportHeight;
    setBox({ left: Math.max(8, Math.min(viewportWidth - 190, rect.left)), top: above ? rect.top - 7 : rect.bottom + 7, above });
  }, [active, anchorRef, followKey]);
  if (!box) return null;
  return <div className={`drag-time-preview${box.above ? " is-above" : ""}`} role="status" aria-label={label} style={{ left: `${box.left}px`, top: `${box.top}px` }}>{children}</div>;
}
