import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 编辑会话（阶段 4 / P4-02，对应规格 §4.2 契约与 §4.3 状态转换）。
 *
 * 只依赖调用方传入的 `onSave`，不引入新的保存协议。
 *
 * 保证的行为：
 * 1. 提交时**同步**锁 `submitting`，再发一次请求；连点保存／Enter／Esc／取消在
 *    submitting 期间全部无效，且不关闭。
 * 2. 请求闭包捕获 `key`；结果返回时若当前会话 `key` 不同，**丢弃结果** ——
 *    不关闭，也不覆盖另一个对象的编辑器。
 * 3. 成功用返回快照关闭并显露保存对象；失败转 `error`，草稿原样保留、可重试。
 * 4. `取消` 与 `Esc` 走同一个「明确放弃」路径；未提交修改不写库。
 */

export type EditorPhase = "editing" | "submitting" | "error";

export type CloseReason = "cancel" | "escape" | "saved";

/**
 * 活动编辑会话注册表。
 *
 * 破坏性动作（恢复备份、整页重载）必须先问这里：有未提交草稿就返回，
 * 有提交中的请求就等待 —— 对应规格 §4.3 表末两行。注册表只存摘要，
 * 不持有草稿数据，避免把业务状态泄漏到模块作用域。
 */
interface ActiveSessionSummary { dirty: boolean; busy: boolean }
const activeSessions = new Map<string, ActiveSessionSummary>();

/** 存在未提交草稿（有改动且尚未落库）。 */
export function hasUncommittedEditorDraft() {
  for (const session of activeSessions.values()) if (session.dirty) return true;
  return false;
}

/** 存在正在提交的会话；此时破坏性动作必须等待。 */
export function hasSubmittingEditor() {
  for (const session of activeSessions.values()) if (session.busy) return true;
  return false;
}

/** 仅供测试：清空注册表，避免用例间串味。 */
export function resetEditorSessionRegistry() {
  activeSessions.clear();
}

export interface EditorSession<T> {
  /** 会话的身份。切换编辑对象时必须变化，用来识别「过期结果」。 */
  key: string;
  /** 打开时的原始值，用于判断是否有改动以及回退。 */
  initial: T;
  draft: T;
  phase: EditorPhase;
  error: string | null;
  /** 打开编辑器的触发元素，关闭后焦点归还给它。 */
  trigger: HTMLElement | null;
}

export interface UseEditorSessionOptions<T> {
  /** 会话身份；变化即视为编辑了另一个对象，旧请求结果会被丢弃。 */
  key: string;
  /** 初始草稿值（只在首次挂载时读取）。 */
  initial: T;
  /** 提交。抛错即进入 error 阶段，草稿保留。 */
  onSave: (draft: T) => Promise<void>;
  /** 关闭回调，携带关闭原因；`saved` 表示已成功落库。 */
  onClose: (reason: CloseReason) => void;
  /** 乐观判定：为 false 时保存按钮应禁用。 */
  canSave?: (draft: T) => boolean;
  /**
   * 会话阶段变化通知。用于让外层容器（如 `FloatingPanel` 的 `busy` prop）
   * 知道现在处于 submitting，从而在提交期间拦住 Esc 与外部点击。
   */
  onPhaseChange?: (phase: EditorPhase) => void;
}

export interface EditorSessionApi<T> {
  draft: T;
  setDraft: (next: T) => void;
  patchDraft: (patch: Partial<T>) => void;
  resetDraft: () => void;
  phase: EditorPhase;
  error: string | null;
  /** submitting 期间为 true：取消／Esc／外部点击都应被忽略。 */
  busy: boolean;
  dirty: boolean;
  canSave: boolean;
  /** 提交。重复调用在 submitting 期间直接返回。 */
  save: () => Promise<void>;
  /** 明确放弃：未提交修改不写库。 */
  cancel: () => void;
}

export function useEditorSession<T>(options: UseEditorSessionOptions<T>): EditorSessionApi<T> {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [draft, setDraftState] = useState<T>(options.initial);
  const [phase, setPhaseState] = useState<EditorPhase>("editing");
  const [error, setError] = useState<string | null>(null);

  // 同步的提交闸门：state 更新是异步的，双击保存必须靠 ref 挡住。
  const submitting = useRef(false);
  const closed = useRef(false);
  /** 当前活跃会话的 key；结果返回时用它判断是否已过期。 */
  const activeKey = useRef(options.key);
  activeKey.current = options.key;
  /** 最新草稿；save 的闭包靠它取到提交那一刻的值。 */
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const initialRef = useRef(options.initial);
  initialRef.current = options.initial;

  // 登记到活动会话注册表，供破坏性动作（恢复备份、整页重载）查询。
  const instanceId = useRef(`editor-session-${Math.random().toString(36).slice(2, 10)}`);
  const dirtyNow = draft !== initialRef.current;
  useEffect(() => {
    const registryId = instanceId.current;
    activeSessions.set(registryId, { dirty: dirtyNow, busy: phase === "submitting" });
    return () => { activeSessions.delete(registryId); };
  }, [dirtyNow, phase]);

  // 会话身份变化 = 编辑另一个对象：重置草稿与状态，并解除提交闸门。
  // 没有这一步，切换对象会带着上一个对象的草稿和 submitting 锁。
  const sessionKeyRef = useRef(options.key);
  if (sessionKeyRef.current !== options.key) {
    sessionKeyRef.current = options.key;
    submitting.current = false;
    closed.current = false;
    if (draft !== options.initial) setDraftState(options.initial);
    if (phase !== "editing") setPhaseState("editing");
    if (error !== null) setError(null);
  }

  /** 编辑动作意味着离开错误态，回到 editing；其它阶段保持不变。 */
  const setPhaseIfError = useCallback(() => {
    setPhaseState((current) => {
      if (current === "error") optionsRef.current.onPhaseChange?.("editing");
      return current === "error" ? "editing" : current;
    });
  }, []);

  const setPhase = useCallback((next: EditorPhase) => {
    setPhaseState(next);
    optionsRef.current.onPhaseChange?.(next);
  }, []);


  const setDraft = useCallback((next: T) => {
    setError(null);
    setPhaseIfError();
    setDraftState(next);
  }, []);

  const patchDraft = useCallback((patch: Partial<T>) => {
    setError(null);
    setPhaseIfError();
    setDraftState((current) => ({ ...current, ...patch }));
  }, []);

  const resetDraft = useCallback(() => {
    setError(null);
    setPhase("editing");
    setDraftState(optionsRef.current.initial);
  }, []);

  const cancel = useCallback(() => {
    if (submitting.current) return;   // 提交中不可取消
    if (closed.current) return;
    closed.current = true;
    optionsRef.current.onClose("cancel");
  }, []);

  const save = useCallback(async () => {
    if (submitting.current) return;   // 连点保存／Enter 只发一次请求
    const api = optionsRef.current;
    if (api.canSave && !api.canSave(draftRef.current)) return;
    submitting.current = true;
    setPhase("submitting");
    setError(null);
    const sessionKeyAtDispatch = activeKey.current;
    const payload = draftRef.current;
    try {
      await api.onSave(payload);
      // 结果返回时若会话已换成另一个对象，丢弃结果：既不关闭也不覆盖。
      if (activeKey.current !== sessionKeyAtDispatch) return;
      submitting.current = false;
      if (closed.current) return;
      closed.current = true;
      // 先解除提交态再关闭：外层容器据此解除 Esc／点击封锁，避免关闭瞬间仍被锁住。
      setPhase("editing");
      optionsRef.current.onClose("saved");
    } catch (reason) {
      if (activeKey.current !== sessionKeyAtDispatch) return;
      submitting.current = false;
      setPhase("error");
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  return {
    draft,
    setDraft,
    patchDraft,
    resetDraft,
    phase,
    error,
    busy: phase === "submitting",
    dirty: draft !== initialRef.current,
    canSave: options.canSave ? options.canSave(draft) : true,
    save,
    cancel,
  };
}
