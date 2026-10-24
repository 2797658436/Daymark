import { ChevronDown, Check, CircleCheck, ImagePlus, Mountain, RotateCcw, Wind, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../ui/button";
import { FloatingPanel } from "../ui/floating-panel";
import {
  COMPLETION_FITS, COMPLETION_FIT_LABEL, COMPLETION_IMAGE_LIMIT, COMPLETION_TAGS,
  completionThumbSrc, encodeCompletionImage,
} from "../../lib/completion";
import type { CompletionFit, CompletionImage, CompletionRecord, Task } from "../../lib/native";

/**
 * 「完成记录」气泡（规格 0007 §3.1–§3.2）。
 *
 * 任务到达 100% 后在**它自己的锚点**旁打开，不居中、不重复任务标题：锚定行已经提供了
 * 上下文。`kind="editor"` 语义（背景 inert、Esc 关闭、点外部只吞不关）由浮层宿主负责，
 * 这里只管采集：适应程度、小结、感受标签、图片，外加「撤回完成」。
 *
 * 三条不可破坏的约定：
 * - 采集与查看分离：缩略图**不在气泡里放大**，查看统一在回顾页的只读浮层。
 * - 带草稿时误点背景不丢内容；关闭只在用户明确表达时发生（Esc／关闭按钮再确认一次）。
 * - 图片只进草稿态，保存时随记录整体落库；移除不影响已存内容。
 */

/** 气泡服务的这一次完成：可以是刚发生的，也可以是事后补写或编辑已存记录。 */
export interface CompletionTarget {
  taskId: string;
  progressEventId: string;
  completedAtUtc: string;
  progressBefore: number;
  /** 已存在的记录；为 `null` 时这次填写会新建一条。 */
  record: CompletionRecord | null;
  imageCount: number;
  anchorElement: HTMLElement | null;
  /** 锚元素可能随列表卸载（任务池里刚完成的那一行），因此同时保存捕获的矩形。 */
  anchorRect: DOMRect | null;
}

const CLOCK_FORMAT = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });
const DAY_FORMAT = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" });
/**
 * 三档适应程度各带一个图标：风（轻松）、圈内勾（合适）、山（吃力）。
 *
 * 图标是装饰（`aria-hidden`），可访问名仍然只有「轻松／合适／吃力」三个字；
 * 选中另有一个尾部对勾，所以「这一档被选了」不靠图标或颜色单独表达。
 */
const COMPLETION_FIT_ICON = { light: Wind, fit: CircleCheck, hard: Mountain } as const;

interface Draft {
  fit: CompletionFit | null;
  note: string;
  tags: string[];
  images: CompletionImage[];
}

export function CompletionBubble({ task, target, onDismiss, onSave, onRevert, onSaved, onOpenExisting }: {
  task: Task;
  target: CompletionTarget;
  /** 用户放弃或完成填写；`skipped` 表示没有保存任何内容就离开。 */
  onDismiss: (skipped: boolean) => void;
  onSave: (record: CompletionRecord, images: CompletionImage[]) => Promise<void>;
  onRevert: () => Promise<void>;
  /** 保存成功后回调，用于关闭气泡并给出底部提示链。 */
  onSaved: (record: CompletionRecord) => void;
  /** 后端报告「这次完成已经记录过了」：改为编辑已有记录，不弹错误横幅。 */
  onOpenExisting: () => void;
}) {
  const initial = useMemo<Draft>(() => ({
    fit: target.record?.fit ?? null,
    note: target.record?.note ?? "",
    tags: target.record?.tags ?? [],
    images: [],
  }), [target]);
  const [draft, setDraft] = useState<Draft>(initial);
  const [tagsOpen, setTagsOpen] = useState(target.record ? target.record.tags.length > 0 : false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  /** 已存记录的缩略图是懒加载的：气泡只给数量，不在采集界面铺开查看。 */
  const fileInput = useRef<HTMLInputElement>(null);

  const dirty = draft.fit !== initial.fit || draft.note !== initial.note
    || draft.tags.length !== initial.tags.length || draft.tags.some((tag, index) => initial.tags[index] !== tag)
    || draft.images.length > 0;

  const close = () => {
    if (dirty && !confirmDiscard) { setConfirmDiscard(true); return; }
    onDismiss(!dirty);
  };

  // 剪贴板粘贴：只在粘贴内容里有图片时接管，纯文本粘贴仍照常进小结输入框（规格 §5.1）。
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = imageFiles(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      void addImages(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  const addImages = async (files: File[]) => {
    setImageError(null);
    const room = COMPLETION_IMAGE_LIMIT - draft.images.length - target.imageCount;
    if (room <= 0) { setImageError(`每条完成记录最多 ${COMPLETION_IMAGE_LIMIT} 张图片`); return; }
    const accepted: CompletionImage[] = [];
    for (const file of files.slice(0, room)) {
      const result = await encodeCompletionImage(file, crypto.randomUUID());
      if (result.ok) accepted.push(result.image);
      else setImageError(result.reason === "tooLarge" ? "这张图压缩后仍超过 2 MB，未添加" : "这张图读不出来，未添加");
    }
    if (accepted.length) {
      setDraft((current) => ({ ...current, images: [...current.images, ...accepted].slice(0, COMPLETION_IMAGE_LIMIT) }));
    }
  };

  const record = (): CompletionRecord => ({
    id: target.record?.id ?? crypto.randomUUID(),
    taskId: target.taskId,
    progressEventId: target.progressEventId,
    completedAtUtc: target.completedAtUtc,
    progressBefore: target.progressBefore,
    fit: draft.fit,
    note: draft.note.trim(),
    tags: [...new Set(draft.tags)],
    revertedAtUtc: null,
  });

  const save = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const next = record();
      await onSave(next, draft.images.map((image, index) => ({ ...image, sortOrder: index })));
      onSaved(next);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      // 同一个完成事件已有记录：转到编辑态，而不是把用户的内容挂在错误横幅上。
      if (message.includes("已经记录过了")) { onOpenExisting(); setBusy(false); return; }
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const revert = async () => {
    if (busy) return;
    // 撤回可逆且保留内容，因此不二次确认。
    setBusy(true); setError(null);
    try { await onRevert(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const toggleTag = (tag: string) => setDraft((current) => ({
    ...current,
    tags: current.tags.includes(tag) ? current.tags.filter((item) => item !== tag) : [...current.tags, tag],
  }));

  const thumbCount = draft.images.length;
  return <FloatingPanel className="completion-panel" label={`完成记录：${task.title}`} busy={busy} onClose={close}
    anchorElement={target.anchorElement} anchor={target.anchorRect} kind="editor">
    <div className="completion-bubble">
      <header className="completion-head">
        <span className="completion-mark" aria-hidden="true"><Check size={14} /></span>
        <div className="completion-heading">
          <h2>{target.record ? "编辑完成记录" : "已完成"}</h2>
          <p>{target.progressBefore}% → 100% · {completionWhen(target.completedAtUtc)}</p>
        </div>
        <button type="button" className="icon-action completion-close" aria-label="关闭完成记录" onClick={close}><X size={16} /></button>
      </header>

      <div className="completion-body">
        <div className="completion-field">
          <span className="completion-field-label" id={`completion-fit-label-${task.id}`}>适应程度</span>
          <div className="completion-fits" role="group" aria-labelledby={`completion-fit-label-${task.id}`}>
            {COMPLETION_FITS.map((fit) => {
              const selected = draft.fit === fit;
              const focused = selected || (draft.fit === null && fit === "fit");
              const Icon = COMPLETION_FIT_ICON[fit];
              return <button key={fit} type="button" data-autofocus={focused ? "" : undefined}
                className={selected ? "completion-fit is-selected" : "completion-fit"} aria-pressed={selected}
                onClick={() => setDraft((current) => ({ ...current, fit: current.fit === fit ? null : fit }))}>
                <Icon size={14} aria-hidden="true" />
                {COMPLETION_FIT_LABEL[fit]}
                {selected && <Check size={13} aria-hidden="true" />}
              </button>;
            })}
          </div>
        </div>

        <label className="completion-field completion-note-field">
          <span className="completion-field-label">完成小结<span className="completion-counter">{draft.note.trim().length}/280</span></span>
          <textarea rows={3} maxLength={280} value={draft.note} placeholder="这次是怎么完成的？下次要注意什么？"
            onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} />
        </label>

        <div className="completion-field">
          <button type="button" className="completion-disclosure" aria-expanded={tagsOpen} onClick={() => setTagsOpen((open) => !open)}>
            <ChevronDown size={13} aria-hidden="true" />
            <span>感受标签{draft.tags.length > 0 ? ` · 已选 ${draft.tags.length}` : ""}</span>
          </button>
          {tagsOpen && <div className="completion-tags" role="group" aria-label="感受标签">
            {COMPLETION_TAGS.map((tag) => {
              const selected = draft.tags.includes(tag);
              return <button key={tag} type="button" className={selected ? "completion-tag is-selected" : "completion-tag"}
                aria-pressed={selected} onClick={() => toggleTag(tag)}>{selected && <Check size={11} aria-hidden="true" />}{tag}</button>;
            })}
          </div>}
        </div>

        <div className={thumbCount + target.imageCount > 0 ? "completion-images has-images" : "completion-images"}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
          onDrop={(event) => {
            event.preventDefault();
            void addImages(Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/")));
          }}>
          <span className="completion-field-label">完成图片<span className="completion-images-hint">粘贴、拖入或选择，最多 {COMPLETION_IMAGE_LIMIT} 张</span></span>
          <div className="completion-thumbs">
            {draft.images.map((image, index) => <span className="completion-thumb" key={image.id}>
              <img src={completionThumbSrc(image)} alt={`第 ${target.imageCount + index + 1} 张完成图片`} width={68} height={68} />
              <button type="button" className="completion-thumb-remove" aria-label={`移除第 ${target.imageCount + index + 1} 张图片`}
                onClick={() => setDraft((current) => ({ ...current, images: current.images.filter((item) => item.id !== image.id) }))}>
                <X size={12} aria-hidden="true" />
              </button>
            </span>)}
            {target.imageCount > 0 && <span className="completion-existing">{target.imageCount} 张已保存</span>}
            {target.imageCount + draft.images.length < COMPLETION_IMAGE_LIMIT && <button type="button" className="completion-image-add" onClick={() => fileInput.current?.click()}>
              <ImagePlus size={15} aria-hidden="true" /><span>粘贴图片</span>
            </button>}
            <input ref={fileInput} type="file" accept="image/*" multiple hidden
              onChange={(event) => { void addImages(Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/"))); event.target.value = ""; }} />
          </div>
          {imageError && <p className="completion-image-error" role="status">{imageError}</p>}
        </div>

        {error && <p className="completion-error" role="alert">{error}</p>}
        {confirmDiscard && <div className="completion-discard" role="group" aria-label="放弃确认">
          <span>放弃这次填写？</span>
          <Button variant="quiet" onClick={() => setConfirmDiscard(false)}>继续填写</Button>
          <Button variant="quiet" onClick={() => onDismiss(true)}>放弃</Button>
        </div>}
      </div>

      <footer className="completion-foot">
        <button type="button" className="completion-revert" disabled={busy} onClick={() => void revert()}>
          <RotateCcw size={13} aria-hidden="true" />
          <span>撤回完成</span>
          <small>回到 {target.progressBefore}%</small>
        </button>
        <Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? "正在保存…" : target.record ? "保存修改" : "保存记录"}</Button>
      </footer>
    </div>
  </FloatingPanel>;
}

/** 剪贴板里有没有图片项；没有就完全不接管这次粘贴。 */
function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile());
  return files.filter((file): file is File => file !== null);
}

/** 事实行里的时间：当天写「今天 14:32」，其余写「8月5日 14:32」。 */
function completionWhen(value: string) {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "时间未知";
  const clock = CLOCK_FORMAT.format(at);
  const today = new Date();
  const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
  return `${sameDay ? "今天" : DAY_FORMAT.format(at)} ${clock}`;
}
