import type { CompletionFit, CompletionImage, CompletionRecord } from "./native";

/**
 * 完成记录的规则与图片管线（规格 0007 §4.3 与 §5）。
 *
 * 词表、字数与图片上限在这里只写一份：气泡的即时校验、浏览器预览替身和 Rust 写入校验
 * 必须同源，否则界面放行的值会被后端拒绝，用户看到的是「保存失败」而不是自己的错误。
 */

/** 感受标签的默认词表，沿用 UI 规范既有的八个词。 */
export const COMPLETION_TAGS = [
  "专注", "顺利", "有收获", "比预计难", "被打断", "疲惫", "卡住", "想继续",
] as const;
export const COMPLETION_FITS: CompletionFit[] = ["light", "fit", "hard"];
export const COMPLETION_FIT_LABEL: Record<CompletionFit, string> = {
  light: "轻松",
  fit: "合适",
  hard: "吃力",
};
export const COMPLETION_NOTE_LIMIT = 280;
export const COMPLETION_IMAGE_LIMIT = 3;
/** 单张图片压缩后的字节上限（2 MiB）。 */
export const COMPLETION_IMAGE_BYTES_LIMIT = 2 * 1024 * 1024;
export const COMPLETION_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
/** 全图最长边与缩略图最长边（规格 §5.2）。 */
export const COMPLETION_IMAGE_MAX_EDGE = 1600;
export const COMPLETION_IMAGE_THUMB_EDGE = 160;

/**
 * 写入前的统一校验；返回可直接呈现的中文错误，`null` 表示通过。
 *
 * `note` 与 `tags` 的清洗结果同时返回：落库的是去首尾空白的小结与去重后的标签，
 * 界面预览的内容必须和后端存下的一致。
 */
export function checkCompletion(record: CompletionRecord, images: readonly CompletionImage[]) {
  if (record.fit !== null && !COMPLETION_FITS.includes(record.fit)) return "适应程度只能是轻松、合适或吃力";
  if (record.note.trim().length > COMPLETION_NOTE_LIMIT) return `完成小结不能超过 ${COMPLETION_NOTE_LIMIT} 字`;
  const tags = new Set(record.tags);
  if (tags.size > COMPLETION_TAGS.length) return `感受标签最多选择 ${COMPLETION_TAGS.length} 个`;
  for (const tag of record.tags) {
    if (!(COMPLETION_TAGS as readonly string[]).includes(tag)) return "感受标签只能出自默认词表";
  }
  if (images.length > COMPLETION_IMAGE_LIMIT) return `完成图片最多 ${COMPLETION_IMAGE_LIMIT} 张`;
  for (const image of images) {
    if (!(COMPLETION_IMAGE_MIME_TYPES as readonly string[]).includes(image.mime)) return "完成图片只能是 PNG、JPEG 或 WebP";
    if (image.width <= 0 || image.height <= 0) return "完成图片必须记录有效尺寸";
    if (image.dataBase64.length === 0 || image.thumbBase64.length === 0) return "完成图片内容为空";
  }
  return null;
}

/** 已完成但还没有记录的完成事件（今日页与气泡共用同一份判断）。 */
export function isUnrecordedCompletion(event: { id: string; taskId: string; toProgress: number }, records: readonly CompletionRecord[]) {
  return event.toProgress === 100 && !records.some((record) => record.progressEventId === event.id);
}

/**
 * 完成气泡的触发口径（规格 0007 §3.1）：这是一次**真正的**「升到 100」，而且不是习惯发生项。
 *
 * 口径只写这一份：任务池／今日／日历／回顾的进度提交与「结束本次」对话框都调它。
 * 两处各写一遍的话，其中一处漏掉 `kind` 或 `fromProgress` 判断，用户就会在习惯打卡或
 * 重复标记完成时被弹一次气泡。
 */
export function isCompletionPromptTarget(task: { kind?: string }, fromProgress: number, toProgress: number) {
  return toProgress === 100 && fromProgress < 100 && task.kind !== "habit";
}

export function completionImageSrc(image: Pick<CompletionImage, "mime" | "dataBase64">) {
  return `data:${image.mime};base64,${image.dataBase64}`;
}

export function completionThumbSrc(image: Pick<CompletionImage, "mime" | "thumbBase64">) {
  return `data:${image.mime};base64,${image.thumbBase64}`;
}

/** 采集结果：要么是一张可入库的图片，要么是可以在图片区就地说明的原因。 */
export type CompletionImageResult =
  | { ok: true; image: CompletionImage }
  | { ok: false; reason: "tooLarge" | "unreadable" };

/**
 * 把剪贴板／拖拽／文件选择拿到的图片归一化后再入库（规格 §5.2）。
 *
 * 编码优先 WebP 0.85，编码器不支持时回退 JPEG 0.87；缩略图与全图同源同格式，
 * 列表渲染只取缩略图。压缩后仍超过 2 MiB 的图片被拒绝，由调用方就地提示。
 */
export async function encodeCompletionImage(source: Blob, id: string): Promise<CompletionImageResult> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const full = await drawScaled(bitmap, COMPLETION_IMAGE_MAX_EDGE, "image/webp", 0.85, "image/jpeg", 0.87);
    if (!full || full.blob.size > COMPLETION_IMAGE_BYTES_LIMIT) return { ok: false, reason: "tooLarge" };
    const thumb = await drawScaled(bitmap, COMPLETION_IMAGE_THUMB_EDGE, full.mime === "image/webp" ? "image/webp" : "image/jpeg", full.mime === "image/webp" ? 0.8 : 0.8);
    if (!thumb) return { ok: false, reason: "unreadable" };
    return {
      ok: true,
      image: {
        id,
        sortOrder: 0,
        mime: full.mime,
        width: full.width,
        height: full.height,
        sizeBytes: full.blob.size,
        dataBase64: await toBase64(full.blob),
        thumbBase64: await toBase64(thumb.blob),
      },
    };
  } finally {
    bitmap.close();
  }
}

/** 按最长边等比缩放绘制并编码；首选格式编码失败时退回备选格式。 */
async function drawScaled(bitmap: ImageBitmap, maxEdge: number, preferredMime: string, quality: number, fallbackMime = "image/jpeg", fallbackQuality = 0.87) {
  const ratio = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * ratio));
  const height = Math.max(1, Math.round(bitmap.height * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, width, height);
  const blob = (await canvasToBlob(canvas, preferredMime, quality)) ?? (await canvasToBlob(canvas, fallbackMime, fallbackQuality));
  if (!blob) return null;
  return { blob, mime: blob.type || preferredMime, width, height };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob && blob.size > 0 ? blob : null), type, quality));
}

/** 分块转二进制串再 btoa：一次 `String.fromCharCode(...bytes)` 会在 MB 级图片上爆栈。 */
async function toBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
