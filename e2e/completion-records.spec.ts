import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

/**
 * 规格 0007 §9 的完整链路（真实 Chromium，浏览器预览替身落 localStorage）。
 *
 * 覆盖的是单测够不着的那三件事：
 * 1. **图片管线**：canvas 归一化 + base64 + BLOB 落库，jsdom 里没有 canvas，只有这里能证明；
 * 2. **锚定与焦点**：气泡开在刚完成那一行旁边，关掉之后焦点有去处；
 * 3. **跨重启**：保存的记录（含图片）在整页重载后仍然读得回来。
 *
 * 撤回是这条链的终点：进度回到 75%，记录不删，只是变成只读。
 */

const TASK = "整理完成记录链路";

/** 现做一张 PNG：不依赖仓库里的二进制夹具，尺寸与内容都可控（16×10，两个色块）。 */
async function samplePng(page: Page) {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 10;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#d2693b";
    context.fillRect(0, 0, 16, 10);
    context.fillStyle = "#24231f";
    context.fillRect(3, 3, 6, 4);
    return canvas.toDataURL("image/png");
  });
  return { name: "completion.png", mimeType: "image/png", buffer: Buffer.from(dataUrl.split(",")[1], "base64") };
}

/**
 * 真的往图片区丢一次文件：Chromium 里 `DataTransfer` 可以构造，所以拖拽路径不用只停在
 * 「能编译」——`setInputFiles` 走的是文件选择那条分支，覆盖不到 `onDrop` 的过滤与上限。
 */
async function dropImages(page: Page, zone: ReturnType<Page["locator"]>, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  const payload = files.map((file) => ({ name: file.name, mimeType: file.mimeType, base64: file.buffer.toString("base64") }));
  await zone.evaluate((element, items) => {
    const transfer = new DataTransfer();
    for (const item of items) {
      const bytes = Uint8Array.from(atob(item.base64), (character) => character.charCodeAt(0));
      transfer.items.add(new File([bytes], item.name, { type: item.mimeType }));
    }
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, payload);
}

/** 「今日完成」是一个 details：只在收起状态时点开它，重复点会把它折回去。 */
async function expandTodayCompleted(page: Page) {
  if (await page.locator(".today-completed-row").first().isVisible().catch(() => false)) return;
  await page.getByText(/今日完成 \d+ 项/).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("completes a task, records it with an image, and reverts it back to 75%", async ({ page }) => {
  // ① 建任务并推进到 75%：这是「升到 100」之前的起点。
  const title = page.getByRole("textbox", { name: "任务标题" });
  await title.fill(TASK);
  await title.press("Enter");
  const row = page.locator(".task-card", { hasText: TASK });
  await expect(row).toHaveCount(1);

  await page.getByRole("button", { name: `调整进度 ${TASK}，当前 0%` }).click();
  await page.getByRole("button", { name: "75%", exact: true }).click();
  await expect(row).toHaveText(/75/);
  await page.getByRole("button", { name: `关闭进度编辑` }).click();

  // ② 升到 100%：完成记录气泡开在这一行旁边。
  await page.getByRole("button", { name: `调整进度 ${TASK}，当前 75%` }).click();
  await page.getByRole("button", { name: `标记 ${TASK} 已完成` }).click();
  const bubble = page.getByRole("dialog", { name: `完成记录：${TASK}` });
  await expect(bubble).toBeVisible();
  await expect(bubble.locator(".completion-heading")).toContainText("75% → 100%");
  // 三档都不预选。
  await expect(bubble.getByRole("button", { name: "合适" })).toHaveAttribute("aria-pressed", "false");

  // ③ 采集：适应程度 + 小结 + 标签 + 一张图片。
  await bubble.getByRole("button", { name: "合适" }).click();
  await expect(bubble.getByRole("button", { name: "合适" })).toHaveAttribute("aria-pressed", "true");
  await bubble.getByRole("button", { name: "感受标签" }).click();
  await bubble.getByRole("button", { name: "专注" }).click();
  await bubble.getByRole("textbox").fill("一次写完，中途没有分心。");
  await expect(bubble.locator(".completion-counter")).toHaveText("12/280");

  await bubble.locator(".completion-images input[type=file]").setInputFiles(await samplePng(page));
  await expect(bubble.getByRole("img", { name: "第 1 张完成图片" })).toBeVisible();
  // 拖拽走同一个入口：两张一起进来，凑满上限后「粘贴图片」瓦片自己消失。
  const png = await samplePng(page);
  await dropImages(page, bubble.locator(".completion-images"), [png, png]);
  await expect(bubble.locator(".completion-thumb")).toHaveCount(3);
  await expect(bubble.locator(".completion-image-add")).toHaveCount(0);
  // 满了以后再拖入：不入库，就地说明原因。
  await dropImages(page, bubble.locator(".completion-images"), [png]);
  await expect(bubble.locator(".completion-thumb")).toHaveCount(3);
  await expect(bubble.locator(".completion-image-error")).toContainText("最多 3 张");
  // 移除一张，入口重新出现。
  await bubble.getByRole("button", { name: "移除第 3 张图片" }).click();
  await expect(bubble.locator(".completion-thumb")).toHaveCount(2);
  await expect(bubble.locator(".completion-image-add")).toBeVisible();

  // ④ 保存。
  await bubble.getByRole("button", { name: "保存记录" }).click();
  await expect(bubble).toHaveCount(0);
  await expect(page.locator(".completion-toast")).toContainText("完成记录已保存");

  const stored = await page.evaluate(() => {
    const snapshot = JSON.parse(localStorage.getItem("daymark.phase1.workspace") ?? "{}") as { completionRecords: Record<string, unknown>[] };
    const images = JSON.parse(localStorage.getItem("daymark.phase1.completionImages") ?? "{}") as Record<string, { mime: string; width: number }[]>;
    return { record: snapshot.completionRecords[0] ?? null, images };
  });
  expect(stored.record).toMatchObject({ taskId: expect.any(String), progressBefore: 75, fit: "fit", note: "一次写完，中途没有分心。", tags: ["专注"], imageCount: 2, revertedAtUtc: null });
  // 图片真的经过压缩管线：mime 是编码器给的 webp/jpeg，而不是原始的 png。
  const images = Object.values(stored.images)[0];
  expect(images).toHaveLength(2);
  expect(["image/webp", "image/jpeg"]).toContain(images[0].mime);

  // ⑤ 跨重启：今日完成那一行把记录摊开在事实位上。
  await page.reload();
  await page.getByText(/今日完成 1 项/).click();
  const todayRow = page.locator(".today-completed-row", { hasText: TASK });
  await expect(todayRow).toContainText("合适");
  await expect(todayRow).toContainText("2 张图片");

  // ⑥ 事后编辑 → 撤回：进度回到 75%，内容保留但只读。
  await todayRow.click();
  const editor = page.getByRole("dialog", { name: `完成记录：${TASK}` });
  await expect(editor.getByRole("heading", { name: "编辑完成记录" })).toBeVisible();
  await expect(editor.getByRole("textbox")).toHaveValue("一次写完，中途没有分心。");
  // 已保存的图片在采集界面只报数量，不铺开查看。
  await expect(editor.locator(".completion-existing")).toHaveText("2 张已保存");
  await editor.getByRole("button", { name: /^撤回完成/ }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator(".completion-toast")).toContainText("已撤回完成，进度回到 75%");

  await expect(page.locator(".task-card", { hasText: TASK })).toHaveText(/75/);
  await expect(page.getByText(/今日完成 1 项/)).toHaveCount(0);
  const after = await page.evaluate(() => {
    const snapshot = JSON.parse(localStorage.getItem("daymark.phase1.workspace") ?? "{}") as { completionRecords: Record<string, unknown>[]; progressEvents: { fromProgress: number; toProgress: number }[] };
    return { record: snapshot.completionRecords[0] ?? null, events: snapshot.progressEvents.slice(-2) };
  });
  // 撤回写一条**新的**回退事件（100 → 75），而不是改掉上一条；内容一个字没删。
  expect(after.events.map((event) => [event.fromProgress, event.toProgress])).toEqual([[75, 100], [100, 75]]);
  expect(after.record).toMatchObject({ note: "一次写完，中途没有分心。", imageCount: 2 });
  expect(after.record!.revertedAtUtc).toBeTruthy();
});

test("stays silent with the prompt off, and 补写 from the today row still works", async ({ page }) => {
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("checkbox", { name: "完成后询问记录" }).click();
  await page.getByRole("button", { name: "今日" }).click();

  const title = page.getByRole("textbox", { name: "任务标题" });
  await title.fill("关掉开关也能补写");
  await title.press("Enter");
  await page.getByRole("button", { name: "调整进度 关掉开关也能补写，当前 0%" }).click();
  await page.getByRole("button", { name: "标记 关掉开关也能补写 已完成" }).click();
  await expect(page.getByRole("dialog", { name: /^完成记录：/ })).toHaveCount(0);
  await expect(page.locator(".completion-toast")).toHaveCount(0);

  await page.getByText(/今日完成 1 项/).click();
  await expect(page.locator(".today-completed-row", { hasText: "关掉开关也能补写" })).toContainText("未填写完成记录");
  await page.locator(".today-completed-row", { hasText: "关掉开关也能补写" }).click();
  const bubble = page.getByRole("dialog", { name: "完成记录：关掉开关也能补写" });
  await expect(bubble.getByRole("heading", { name: "已完成" })).toBeVisible();
  await bubble.getByRole("button", { name: "吃力" }).click();
  await bubble.getByRole("button", { name: "保存记录" }).click();
  await expect(bubble).toHaveCount(0);
  await page.reload();
  await page.getByText(/今日完成 1 项/).click();
  await expect(page.locator(".today-completed-row", { hasText: "关掉开关也能补写" })).toContainText("吃力");
});

test("does not stack a second bubble and keeps the just-completed row as the anchor", async ({ page }) => {
  for (const name of ["先完成的一项", "后完成的一项"]) {
    await page.getByRole("textbox", { name: "任务标题" }).fill(name);
    await page.getByRole("textbox", { name: "任务标题" }).press("Enter");
  }
  await page.getByRole("button", { name: "调整进度 先完成的一项，当前 0%" }).click();
  await page.getByRole("button", { name: "标记 先完成的一项 已完成" }).click();
  const first = page.getByRole("dialog", { name: "完成记录：先完成的一项" });
  await expect(first).toBeVisible();
  // 气泡开着时背景是 inert 的：第二个任务点不到，也就叠不出第二个气泡（同一时刻只有一个）。
  await expect(page.locator(".app-shell")).toHaveAttribute("inert", "");

  // 带草稿时误点背景不丢内容：气泡仍在，草稿仍在。
  await first.getByRole("textbox").fill("还没写完");
  await page.locator(".app-shell").click({ position: { x: 4, y: 300 }, force: true });
  await expect(first.getByRole("textbox")).toHaveValue("还没写完");

  // Esc 关闭会先要一次明确的放弃。
  await page.keyboard.press("Escape");
  await expect(first.getByRole("group", { name: "放弃确认" })).toBeVisible();
  await first.getByRole("button", { name: "放弃" }).click();
  await expect(first).toHaveCount(0);
  // 关掉之后留下「补写」提示，焦点归还给宿主。
  await expect(page.locator(".completion-toast")).toContainText("还没记录");
  await expect(page.locator(".app-shell")).not.toHaveAttribute("inert", "");
});

/**
 * 新增的三个界面过一遍 axe：完成气泡（采集态与编辑态）、今日完成行、回顾明细。
 *
 * 逐页那份 M12 用例只跑页面本体，浮层与气泡不在里面 —— 而规格 0007 新增长的就是这几块。
 * 浅／深各跑一遍：深色主题的对比度是另一套数（`--accent-soft` 在深色里是深褐底）。
 */
test("keeps the completion surfaces free of automated accessibility violations", async ({ page }) => {
  await page.addScriptTag({ path: path.join(process.cwd(), "node_modules", "axe-core", "axe.min.js") });
  const violations = () => page.evaluate(async () => {
    const result = await (window as unknown as { axe: { run(): Promise<{ violations: { id: string; nodes: unknown[] }[] }> } }).axe.run();
    return result.violations.map((violation) => `${violation.id}×${violation.nodes.length}`);
  });
  const violationDetails = () => page.evaluate(async () => {
    const result = await (window as unknown as { axe: { run(): Promise<{ violations: { id: string; help: string; nodes: { html: string; target: string[] }[] }[] }> } }).axe.run();
    return JSON.stringify(result.violations.map((violation) => ({
      id: violation.id, help: violation.help, nodes: violation.nodes.map((node) => ({ html: node.html.slice(0, 160), target: node.target })),
    })), null, 1);
  });
  const title = "无障碍检查的一项";
  await page.getByRole("textbox", { name: "任务标题" }).fill(title);
  await page.getByRole("textbox", { name: "任务标题" }).press("Enter");

  for (const theme of ["浅色", "深色"] as const) {
    await page.getByRole("button", { name: "设置" }).click();
    await page.getByRole("radio", { name: theme }).check();
    await page.getByRole("button", { name: "今日" }).click();

    const bubble = page.getByRole("dialog", { name: `完成记录：${title}` });
    if (theme === "浅色") {
      await page.getByRole("button", { name: `调整进度 ${title}，当前 0%` }).click();
      await page.getByRole("button", { name: `标记 ${title} 已完成` }).click();
      await expect(bubble).toBeVisible();
      expect(await violations(), await violationDetails()).toEqual([]);
      await bubble.getByRole("button", { name: "合适" }).click();
      await bubble.getByRole("button", { name: "感受标签" }).click();
      await bubble.getByRole("button", { name: "专注" }).click();
      await bubble.getByRole("textbox").fill("检查用的一条小结。");
      expect(await violations(), await violationDetails()).toEqual([]);
      await bubble.getByRole("button", { name: "保存记录" }).click();
      await expect(bubble).toHaveCount(0);
    } else {
      // 深色这一轮走事后入口：同一份内容在编辑态再过一次（已存图片只有数量，不铺开）。
      await expandTodayCompleted(page);
      await page.locator(".today-completed-row", { hasText: title }).click();
      await expect(bubble.getByRole("heading", { name: "编辑完成记录" })).toBeVisible();
      expect(await violations(), await violationDetails()).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(bubble).toHaveCount(0);
    }

    // 今日完成那一行（展开态）。
    // 先等淡出结束：那 160ms 里整行是半透明的，axe 会拍到动画中间帧的对比度而不是任何一个稳定态。
    await expandTodayCompleted(page);
    await expect(page.locator(".today-completed-row", { hasText: title })).toBeVisible();
    await expect(page.locator(".task-card.is-leaving")).toHaveCount(0);
    expect(await violations(), await violationDetails()).toEqual([]);

    // 回顾明细里的完成记录行。
    await page.getByRole("button", { name: "回顾" }).click();
    await page.getByRole("button", { name: `查看任务「${title}」的明细` }).click();
    await expect(page.locator(".review-completion")).toHaveCount(1);
    expect(await violations(), await violationDetails()).toEqual([]);
    // 明细是气泡：换页就关掉，不留到下一个界面。
    await page.getByRole("button", { name: "今日" }).click();
    await expect(page.locator(".review-detail")).toHaveCount(0);
  }
});
