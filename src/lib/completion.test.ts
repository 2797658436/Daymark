import { describe, expect, it } from "vitest";

import {
  COMPLETION_TAGS, checkCompletion, isCompletionPromptTarget, isUnrecordedCompletion,
} from "./completion";
import type { CompletionImage, CompletionRecord } from "./native";

/**
 * 完成记录的规则层（规格 0007 §3.1／§4.3／§5）。
 *
 * 这一份是**纯函数**的口径表：触发条件与校验规则在界面、浏览器替身和 Rust 三处都要同源，
 * 所以先把它们钉在这里。DOM 侧只留一条「开关关掉不弹也不留胶囊」的集成用例 ——
 * 拖动 range 控件的时机依赖 React 首帧之后的那次数据加载渲染，不适合当口径的裁判。
 */

function record(patch: Partial<CompletionRecord> = {}): CompletionRecord {
  return { id: "c-1", taskId: "t-1", progressEventId: "e-1", completedAtUtc: "2026-08-05T09:00:00.000Z",
    progressBefore: 75, fit: "fit", note: "", tags: [], revertedAtUtc: null, ...patch };
}

function image(patch: Partial<CompletionImage> = {}): CompletionImage {
  return { id: "i-1", sortOrder: 0, mime: "image/webp", width: 1600, height: 900, sizeBytes: 20_480,
    dataBase64: "AAECAw==", thumbBase64: "AAECAw==", ...patch };
}

describe("completion prompt trigger", () => {
  /** 触发矩阵：只有「正常的任务、从 <100 升到 100」这一格为真。 */
  const matrix: Array<[string, { kind?: string }, number, number, boolean]> = [
    ["任务池里 75% 推到 100%", { kind: "task" }, 75, 100, true],
    ["从 0% 一次到 100%", { kind: "task" }, 0, 100, true],
    ["已经 100% 再写一次 100%（没有「升到」这个过程）", { kind: "task" }, 100, 100, false],
    ["下调到 100 以下", { kind: "task" }, 100, 60, false],
    ["普通推进，没到 100%", { kind: "task" }, 40, 60, false],
    ["习惯发生项打卡到 100%", { kind: "habit" }, 50, 100, false],
    ["旧数据里 kind 缺失的任务", {}, 75, 100, true],
  ];
  for (const [name, task, from, to, expected] of matrix) {
    it(`${name} → ${expected ? "弹" : "不弹"}气泡`, () => {
      expect(isCompletionPromptTarget(task, from, to)).toBe(expected);
    });
  }

  it("keeps the switch out of the trigger rule", () => {
    // 开关不参与口径：它只决定「这次要不要打扰」，不改变「这是不是一次完成」。
    // 关掉之后完成事实照常写入，事后仍可从「今日完成」补写（§8），所以这里不看偏好。
    expect(isCompletionPromptTarget({ kind: "task" }, 75, 100)).toBe(true);
  });
});

describe("completion record validation", () => {
  it("accepts an empty draft: only the completion itself is mandatory", () => {
    expect(checkCompletion(record({ fit: null }), [])).toBeNull();
  });

  it("rejects a fit outside the three levels", () => {
    expect(checkCompletion(record({ fit: "amazing" as never }), [])).toContain("适应程度");
  });

  it("counts the note after trimming and rejects more than 280 characters", () => {
    expect(checkCompletion(record({ note: "  刚好写完  " }), [])).toBeNull();
    expect(checkCompletion(record({ note: "字".repeat(281) }), [])).toContain("280");
  });

  it("rejects a tag outside the default vocabulary and a duplicated set beyond it", () => {
    expect(checkCompletion(record({ tags: ["心流"] }), [])).toContain("默认词表");
    expect(checkCompletion(record({ tags: [...COMPLETION_TAGS] }), [])).toBeNull();
  });

  it("caps images at three and requires a real size, a known type and non-empty bytes", () => {
    const four = [image({ id: "a" }), image({ id: "b" }), image({ id: "c" }), image({ id: "d" })];
    expect(checkCompletion(record(), four)).toContain("最多 3 张");
    expect(checkCompletion(record(), [image({ mime: "image/gif" })])).toContain("PNG、JPEG 或 WebP");
    expect(checkCompletion(record(), [image({ width: 0 })])).toContain("有效尺寸");
    expect(checkCompletion(record(), [image({ dataBase64: "" })])).toContain("内容为空");
  });
});

describe("unrecorded completions", () => {
  it("marks a 100% event without a record as pending 补写", () => {
    const event = { id: "e-1", taskId: "t-1", toProgress: 100 };
    expect(isUnrecordedCompletion(event, [])).toBe(true);
    expect(isUnrecordedCompletion(event, [record({ progressEventId: "e-1" })])).toBe(false);
    // 不是 100 的事件永远不算「待补写」，哪怕记录里引用了它。
    expect(isUnrecordedCompletion({ id: "e-2", taskId: "t-1", toProgress: 60 }, [record({ progressEventId: "e-2" })])).toBe(false);
  });
});
