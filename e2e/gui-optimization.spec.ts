import { expect, test } from "@playwright/test";

for (const width of [960, 1200]) for (const scale of [100, 150, 200]) {
  test(`GUI settings and creation remain usable at ${width}px / ${scale}%`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await page.goto("/");
    await page.evaluate(({ scale }) => { localStorage.clear(); localStorage.setItem("daymark.phase0.preferences", JSON.stringify({ scale, lastPage: "appearance" })); }, { scale });
    await page.reload();
    await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
    expect(await page.locator("#main-content").evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.getByRole("button", { name: "添加时段" }).click();
    const slot = page.getByRole("dialog", { name: "编辑默认时段" });
    await expect(slot).toBeVisible();
    await slot.getByRole("button", { name: "保存时段" }).scrollIntoViewIfNeeded();
    const rect = await slot.boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(11);
    expect(rect!.y).toBeGreaterThanOrEqual(11);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(width - 11);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(749);
    await slot.getByRole("button", { name: "取消" }).click();
    await page.getByRole("button", { name: "项目", exact: true }).click();
    await page.getByRole("button", { name: "新建项目", exact: true }).click();
    const project = page.getByRole("dialog", { name: "创建项目" });
    await project.getByLabel("项目标题", { exact: true }).fill("气泡验收项目");
    await project.getByRole("button", { name: "创建", exact: true }).click();
    await expect(project).toHaveCount(0);
    await page.getByRole("button", { name: "为 气泡验收项目 新增里程碑" }).click();
    const milestone = page.getByRole("dialog", { name: "里程碑", exact: true });
    await expect(milestone.getByLabel("达成条件")).toHaveValue("projectProgress");
    await milestone.getByLabel("里程碑名称").fill("第一步");
    await milestone.getByLabel("目标日期").fill("2026-12-01");
    await milestone.getByRole("button", { name: "保存里程碑" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/gui-${width}-${scale}.png` });
    await milestone.getByRole("button", { name: "保存里程碑" }).click();
    await expect(milestone).toHaveCount(0);
  });
}

test("draft cancellation never saves and a floating editor blocks a second calendar editor", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear()); await page.reload();
  await page.getByRole("textbox", { name: "任务标题", exact: true }).fill("保留原任务");
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  const trigger = page.getByRole("button", { name: "编辑任务 保留原任务" });
  await trigger.click();
  const editor = page.getByRole("dialog", { name: "编辑任务 保留原任务" });
  await editor.getByLabel("标题", { exact: true }).fill("不应保存");
  await editor.getByLabel("标题", { exact: true }).press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.reload(); await expect(trigger).toBeVisible();
  await page.getByRole("button", { name: "日历", exact: true }).click();
  await page.getByRole("button", { name: "时间块", exact: true }).click();
  const block = page.getByRole("dialog", { name: "添加时间块" });
  await expect(block).toBeVisible();
  const background = page.locator(".day-track").first();
  await background.dispatchEvent("pointerdown", { button: 0, clientX: 200, clientY: 400 });
  await background.dispatchEvent("pointerup", { button: 0, clientX: 200, clientY: 430 });
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await block.getByRole("button", { name: "取消" }).click();
});

test("project task creation and import drafts remain separate", async ({ page }) => {
  await page.goto("/"); await page.evaluate(() => localStorage.clear()); await page.reload();
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page.getByRole("button", { name: "导入文本课程" }).click();
  await page.getByLabel("粘贴分集文本").fill("P1 独立草稿 12:30");
  await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();
  await page.getByRole("button", { name: "B 站链接 Beta" }).click();
  await expect(page.getByLabel("B 站普通视频链接")).toHaveValue("");
  await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();
  await page.getByRole("button", { name: "导入文本课程" }).click();
  await expect(page.getByLabel("粘贴分集文本")).toHaveValue("P1 独立草稿 12:30");
  await page.getByLabel("项目标题", { exact: true }).fill("课程项目");
  await page.getByRole("dialog").getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("button", { name: "添加任务", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加项目任务" });
  await dialog.getByLabel("标题", { exact: true }).fill("追加内容");
  await dialog.getByRole("button", { name: "保存任务" }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".project-tasks")).toContainText("追加内容");
});
