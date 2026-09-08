import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** A nonmodal editor: measure after every content resize, keep the trigger's focus. */
export function FloatingPanel({ children, label, onClose, wide = false, anchor: suppliedAnchor }: { children: ReactNode; label: string; onClose: () => void; wide?: boolean; anchor?: DOMRect | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [trigger] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {
    const panel = ref.current!;
    const place = () => {
      const anchor = suppliedAnchor ?? trigger?.getBoundingClientRect();
      const rect = panel.getBoundingClientRect();
      const left = anchor?.left ?? (window.innerWidth - rect.width) / 2;
      let top = (anchor?.bottom ?? 48) + 8;
      if (top + rect.height > window.innerHeight - 12) top = (anchor?.top ?? window.innerHeight) - rect.height - 8;
      panel.style.left = `${Math.max(12, Math.min(left, window.innerWidth - rect.width - 12))}px`;
      panel.style.top = `${Math.max(12, Math.min(top, window.innerHeight - rect.height - 12))}px`;
    };
    place();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    observer?.observe(panel);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (!panel.querySelector("[aria-busy=true]")) close.current();
      } else if (!panel.contains(event.target as Node) && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault(); event.stopPropagation();
        panel.querySelector<HTMLElement>("input, select, textarea, button")?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("keydown", escape, true);
    // Keep an unfinished draft and avoid opening a second editor behind it.
    const outside = (event: MouseEvent) => { if (!panel.contains(event.target as Node)) { event.preventDefault(); event.stopPropagation(); } };
    window.addEventListener("click", outside, true); window.addEventListener("pointerdown", outside, true); window.addEventListener("pointerup", outside, true);
    panel.querySelector<HTMLElement>("input, select, textarea, button")?.focus({ preventScroll: true });
    return () => { observer?.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); window.removeEventListener("keydown", escape, true); window.removeEventListener("click", outside, true); window.removeEventListener("pointerdown", outside, true); window.removeEventListener("pointerup", outside, true); if (trigger?.isConnected) trigger.focus({ preventScroll: true }); };
  }, [trigger, suppliedAnchor]);
  return createPortal(<div ref={ref} className={`floating-panel${wide ? " floating-panel-wide" : ""}`} role="dialog" aria-label={label}>{children}</div>, document.body);
}
