import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

/**
 * 统一的浮层宿主（阶段 4 / P4-02）。
 *
 * 只负责四件事：层级顺序、`.app-shell` 的 inert 归属、Tab 循环与 Esc 的顶层唯一性、焦点所有权。
 * 不承担业务保存、数据库写入、气泡几何计算。
 *
 * 三类语义（按「有没有草稿」划分，而非长相）：
 * - `action`  动作气泡：无草稿，选一个动作即关。非模态，背景仍可交互。
 * - `editor`  编辑气泡：有草稿与保存／取消。紧凑模态，背景 inert。
 * - `confirm` 危险确认：不可逆操作，独立居中模态。背景 inert。
 */
export type OverlayKind = "action" | "editor" | "confirm";

export type OverlayDismissReason = "escape" | "outside";

export interface OverlayHandle {
  id: string;
  kind: OverlayKind;
  /** submitting 期间为 false：Esc、外部点击、取消全部无效。 */
  dismissible: boolean;
  onDismiss: (reason: OverlayDismissReason) => void;
  /** 关闭后把焦点还到哪里；null 表示交给宿主按栈自动处理。 */
  returnFocusTo?: HTMLElement | null;
}

interface OverlayRegistration extends OverlayHandle {
  /** 调用方持有，用于卸载时安全注销。 */
  owner: string;
}

export interface OverlayHostApi {
  /** 注册一层浮层，返回注销函数。 */
  register: (handle: OverlayHandle) => () => void;
  /** 更新已注册层的可取消性与焦点目标，避免每次渲染重新注册。 */
  update: (id: string, patch: Partial<Pick<OverlayHandle, "dismissible" | "returnFocusTo" | "kind">>) => void;
  /** 该层当前是否是栈顶；只有栈顶响应 Esc 与 Tab 约束。 */
  isTop: (id: string) => boolean;
  layerCount: number;
}

const OverlayHostContext = createContext<OverlayHostApi | null>(null);

/**
 * 只有模态层（editor / confirm）才锁背景。动作气泡（action）是非模态的，
 * 打开时背景仍应可交互，因此不参与 inert 计数。
 */
function shellShouldBeInert(layers: OverlayRegistration[]) {
  return layers.some((layer) => layer.kind !== "action");
}

/** 栈中没有模态层时才算「没有浮层」，此时才允许移除 `.app-shell` 的 inert。 */
function syncShellInert(shouldLock: boolean, nextInert: number) {
  const shell = document.querySelector<HTMLElement>(".app-shell");
  if (!shell) return nextInert;
  if (!shouldLock) {
    shell.removeAttribute("inert");
    return 0;
  }
  shell.setAttribute("inert", "");
  return nextInert || 1;
}

/**
 * 焦点安全网：宿主把非顶层浮层的可聚焦元素标记为 inert 之前，先记录当前焦点，
 * 以便顶层关闭后能回到上一层的正确位置。
 */
export function OverlayHostProvider({ children }: { children: ReactNode }) {
  const [layers, setLayers] = useState<OverlayRegistration[]>([]);
  const inertDepth = useRef(0);
  const focusBeforeOpen = useRef<HTMLElement | null>(null);
  const layersRef = useRef(layers);
  layersRef.current = layers;

  const register = useCallback((handle: OverlayHandle) => {
    if (layersRef.current.length === 0) {
      const active = document.activeElement;
      focusBeforeOpen.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    const owner = `${handle.id}:${Math.random().toString(36).slice(2, 8)}`;
    setLayers((current) => [...current, { ...handle, owner }]);
    let alive = true;
    return () => {
      if (!alive) return;
      alive = false;
      setLayers((current) => current.filter((layer) => layer.owner !== owner));
    };
  }, []);

  const update = useCallback((id: string, patch: Partial<Pick<OverlayHandle, "dismissible" | "returnFocusTo" | "kind">>) => {
    setLayers((current) => current.map((layer) => (layer.id === id ? { ...layer, ...patch } : layer)));
  }, []);

  const top = layers.at(-1) ?? null;

  const isTop = useCallback((id: string) => layersRef.current.at(-1)?.id === id, []);

  useEffect(() => {
    inertDepth.current = syncShellInert(shellShouldBeInert(layers), inertDepth.current);
  }, [layers]);

  // 卸载时兜底清掉 inert，避免宿主本身被整块卸载后背景永久不可交互。
  useEffect(() => () => { document.querySelector<HTMLElement>(".app-shell")?.removeAttribute("inert"); }, []);

  /**
   * 焦点归还的唯一执行点。
   *
   * 关闭浮层的组件**不能**在卸载清理里直接 focus：那一刻 `.app-shell` 可能还带着 inert
   * （宿主尚未重渲染，React 的清理顺序早于我们的 effect），`focus()` 会被浏览器静默忽略，
   * 焦点最终掉到 body。所以由宿主在「inert 已清掉」之后延迟一帧再还。
   */
  const pendingReturn = useRef<HTMLElement | null>(null);
  const previousCount = useRef(0);
  useEffect(() => {
    const grew = layers.length > previousCount.current;
    previousCount.current = layers.length;
    if (layers.length === 0) {
      // 栈空了：inert 已在上面那个 effect 里移除，这一帧可以安全地还焦点了。
      const target = pendingReturn.current ?? focusBeforeOpen.current;
      pendingReturn.current = null;
      focusBeforeOpen.current = null;
      if (target?.isConnected) requestAnimationFrame(() => target.focus({ preventScroll: true }));
      return;
    }
    const explicit = top?.returnFocusTo;
    if (grew && top) {
      requestAnimationFrame(() => {
        const container = document.getElementById(top.id);
        const auto = container?.querySelector<HTMLElement>("[autofocus]") ?? container?.querySelector<HTMLElement>("button, input, textarea, select");
        auto?.focus({ preventScroll: true });
      });
      return;
    }
    if (explicit && explicit.isConnected) requestAnimationFrame(() => explicit.focus({ preventScroll: true }));
  }, [layers.length, top]);

  // 记录「刚关掉的那一层想把焦点还给谁」，供栈清空后使用。
  const lastTopRef = useRef<OverlayRegistration | null>(null);
  const topForReturn = layers.at(-1) ?? null;
  useEffect(() => {
    if (topForReturn) lastTopRef.current = topForReturn;
  }, [topForReturn]);
  useEffect(() => {
    const removed = lastTopRef.current;
    return () => { if (removed?.returnFocusTo) pendingReturn.current = removed.returnFocusTo; };
  }, [layers.length]);

  // Esc 与 Tab 只作用于栈顶，彻底消除「关内层解除外层保护」与「两个浮层同时抢键」。
  const topId = top?.id ?? null;
  useEffect(() => {
    if (!topId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const currentTop = layersRef.current.at(-1);
      if (!currentTop || currentTop.id !== topId) return;
      if (event.key === "Escape") {
        if (!currentTop.dismissible) return;
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
        currentTop.onDismiss("escape");
        return;
      }
      if (event.key !== "Tab" || currentTop.kind === "action") return;
      const controls = Array.from(document.getElementById(currentTop.id)?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      ) ?? []).filter((element) => element.offsetParent !== null || element === document.activeElement);
      if (!controls.length) return;
      const first = controls[0]; const last = controls.at(-1)!;
      const active = document.activeElement as HTMLElement | null;
      const inside = active ? controls.includes(active) : false;
      if (!inside) { event.preventDefault(); first.focus({ preventScroll: true }); return; }
      if (event.shiftKey && active === first) { event.preventDefault(); last.focus({ preventScroll: true }); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus({ preventScroll: true }); }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [topId]);

  const api = useMemo<OverlayHostApi>(() => ({ register, update, isTop, layerCount: layers.length }), [register, update, isTop, layers.length]);

  return <OverlayHostContext.Provider value={api}>{children}</OverlayHostContext.Provider>;
}

/** 把焦点安全地移出背景：仅在栈非空且目标仍在文档内时执行。 */
export function restoreFocus(target: HTMLElement | null) {
  if (target?.isConnected) requestAnimationFrame(() => target.focus({ preventScroll: true }));
}

/**
 * 兼容入口：把一个「自带 backdrop 的居中模态」接入宿主。
 *
 * 替代原先的 `useModalBehavior` —— 后者的清理逻辑无条件移除 `.app-shell` 的 inert，
 * 两个浮层叠开时关掉内层会连带解除外层的背景保护。现在 inert 由宿主按栈引用计数，
 * 这里只声明语义与生命周期。
 */
export function useOverlayLayer(id: string, options: { kind: OverlayKind; dismissible: boolean; onDismiss: () => void; containerRef?: RefObject<HTMLElement | null> }) {
  const host = useOptionalOverlayHost();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const dismiss = useRef(options.onDismiss);
  dismiss.current = options.onDismiss;

  useEffect(() => {
    if (!host) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const unregister = host.register({
      id,
      kind: optionsRef.current.kind,
      dismissible: optionsRef.current.dismissible,
      returnFocusTo: null,
      onDismiss: () => dismiss.current(),
    });
    return () => {
      unregister();
      restoreFocus(previousFocus);
    };
  }, [host, id]);

  useEffect(() => {
    host?.update(id, { dismissible: options.dismissible, kind: options.kind });
  }, [host, id, options.dismissible, options.kind]);

  return host?.isTop(id) ?? true;
}

export function useOverlayHost(): OverlayHostApi {
  const host = useContext(OverlayHostContext);
  if (!host) throw new Error("useOverlayHost 必须在 OverlayHostProvider 内使用");
  return host;
}

/** 只读查询，供不在 Provider 内但需要知道「是否是栈顶」的非交互场景使用。 */
export function useOptionalOverlayHost(): OverlayHostApi | null {
  return useContext(OverlayHostContext);
}
