import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useOptionalOverlayHost, type OverlayKind } from "./overlay-host";

/**
 * 紧凑浮层。承担两种语义，由 `kind` 显式声明，不再靠长相推断：
 * - `editor`（默认）：有草稿与保存／取消。经宿主登记为模态，背景 inert、Tab 循环、焦点恢复。
 * - `action`：无草稿，选一个动作即关。非模态，背景仍可交互。
 *
 * 几何（12px 边距、翻转避让、ResizeObserver、视口内滚动）不在本组件内改动范围内：
 * AC01 已通过，属 P4-01 基线。
 */
export function FloatingPanel({ children, label, onClose, wide = false, anchor: suppliedAnchor, anchorElement, busy = false, titleId, kind = "editor", dismissible, closeOnOutsideClick = false, className, style }: {
  children: ReactNode;
  /** 可访问名。`titleId` 存在时改用 `aria-labelledby`，否则回退到 `aria-label`。 */
  label: string;
  /** 用户主动关闭（Esc、外部点击、取消按钮）。 */
  onClose: () => void;
  wide?: boolean;
  anchor?: DOMRect | null;
  /** 锚元素。传入时每次定位都实时取它的 rect，滚动／重排后气泡跟着走。 */
  anchorElement?: HTMLElement | null;
  /** 显式提交态。取代原先靠 `[aria-busy=true]` 查询后代 DOM 的猜法。 */
  busy?: boolean;
  /** 面板内标题元素的 id，用于 `aria-labelledby` 关联。 */
  titleId?: string;
  kind?: OverlayKind;
  /** 默认跟随 `busy`：提交中不可关闭。 */
  dismissible?: boolean;
  /**
   * 点面板外部是否等同于"取消"。默认 false：带草稿的编辑器误点背景不该丢草稿，
   * 只吞事件不关闭（宿主 Esc／取消按钮负责关闭）。单次时间编辑这类轻量操作
   * 可以显式打开，让"点别处"直接取消。
   */
  closeOnOutsideClick?: boolean;
  /** 额外类名。用来收紧宽度（时间选择浮层比编辑气泡窄）。 */
  className?: string;
  /** 覆盖尺寸等几何（例如让气泡和它所属的那一栏同宽）。 */
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [trigger] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const close = useRef(onClose); close.current = onClose;
  const busyRef = useRef(busy); busyRef.current = busy;
  const dismissibleRef = useRef(dismissible ?? !busy);
  dismissibleRef.current = dismissible ?? !busy;
  const outsideClosesRef = useRef(closeOnOutsideClick);
  outsideClosesRef.current = closeOnOutsideClick;

  // 层 id 需要稳定且在 DOM 中真实存在，宿主靠它定位栈顶容器。
  const host = useOptionalOverlayHost();
  const reactId = useId();
  const layerId = `floating-panel-${reactId.replace(/[:]/g, "")}`;
  const isTop = host?.isTop(layerId) ?? true;
  const isTopRef = useRef(isTop);
  isTopRef.current = isTop;

  // 依赖必须落在**稳定的函数**上，不能直接依赖 `host`：
  // 宿主的 context 值随 `layers.length` 每次变化都换新，用它做依赖会让每一层
  // 「注销 → 重注册」，栈顺序在父子之间来回翻（实测两层都以为自己不是栈顶，
  // 于是点外面谁都不关）。`register` / `update` 本身是 useCallback([])，永远稳定。
  const registerOverlay = host?.register;
  const updateOverlay = host?.update;

  useLayoutEffect(() => {
    if (!registerOverlay) return;
    return registerOverlay({
      id: layerId,
      kind,
      dismissible: dismissibleRef.current,
      onDismiss: (reason) => {
        if (!dismissibleRef.current) return;
        if (reason === "escape") close.current();
      },
      returnFocusTo: trigger,
    });
  }, [registerOverlay, layerId, kind, trigger]);

  useEffect(() => {
    updateOverlay?.(layerId, { dismissible: dismissible ?? !busy, kind });
  }, [updateOverlay, layerId, dismissible, busy, kind]);

  useLayoutEffect(() => {
    const panel = ref.current!;
    const place = () => {
      const anchor = anchorElement?.getBoundingClientRect() ?? suppliedAnchor ?? trigger?.getBoundingClientRect();
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
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      // 不在这里直接 focus：关闭的瞬间 `.app-shell` 可能仍带 inert（宿主尚未重渲染），
      // 那时 focus() 会被静默忽略。焦点归还统一由宿主在清掉 inert 之后延迟一帧执行。
    };
  }, [trigger, suppliedAnchor, anchorElement]);

  // 键盘：Esc 交给宿主统一裁决；这里只保留「面板外按 Enter/Space 把焦点拉回本面板」的兜底。
  useLayoutEffect(() => {
    const panel = ref.current!;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") return;
      if (!panel.contains(event.target as Node) && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault(); event.stopPropagation();
        panel.querySelector<HTMLElement>("input, select, textarea, button")?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, []);

  // 非栈顶的浮层不抢指针，避免内层关闭前外层被穿透点击。
  useLayoutEffect(() => {
    if (isTop) return;
    const panel = ref.current!;
    panel.style.pointerEvents = "none";
    return () => { panel.style.pointerEvents = ""; };
  }, [isTop]);

  // 保留 capture 阶段的外部指针守卫：E2E 用 dispatchEvent 验证「不能叠开第二个编辑器」，
  // 而 dispatchEvent 会绕过 pointer-events 与 inert，只靠 inert 挡不住。
  //
  // 默认**只吞不关**：编辑气泡带草稿，误点背景不该丢草稿；关闭只在用户明确表达时
  // 发生（Esc 走宿主、取消按钮、保存完成）。`closeOnOutsideClick` 的单次操作气泡
  // 例外——点别处就是取消。
  useLayoutEffect(() => {
    const panel = ref.current!;
    const outside = (event: MouseEvent) => {
      if (panel.contains(event.target as Node)) return;
      // 只有栈顶才响应「点外面」。否则内层浮层（例如时间选择轮）里的一次点击
      // 会被下层的编辑气泡当成「点在了自己外面」，连带把它关掉。
      if (!isTopRef.current) return;
      event.preventDefault(); event.stopPropagation();
      if (outsideClosesRef.current && dismissibleRef.current && event.type === "pointerdown") close.current();
    };
    window.addEventListener("click", outside, true); window.addEventListener("pointerdown", outside, true); window.addEventListener("pointerup", outside, true);
    return () => { window.removeEventListener("click", outside, true); window.removeEventListener("pointerdown", outside, true); window.removeEventListener("pointerup", outside, true); };
  }, []);

  useLayoutEffect(() => {
    const panel = ref.current!;
    // 主控件可以显式接管初始焦点（例如进度气泡里的滑块），否则落到第一个可聚焦元素。
    (panel.querySelector<HTMLElement>("[data-autofocus]") ?? panel.querySelector<HTMLElement>("input, select, textarea, button"))?.focus({ preventScroll: true });
  }, []);

  const labelled = titleId ? { "aria-labelledby": titleId } : { "aria-label": label };
  return createPortal(
    <div id={layerId} ref={ref} style={style} className={["floating-panel", wide ? "floating-panel-wide" : "", className ?? ""].filter(Boolean).join(" ")} role="dialog" aria-modal={kind === "action" ? undefined : "true"} {...labelled}>{children}</div>,
    document.body,
  );
}
