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

test("the month grid keeps all seven columns visible when the day details are open", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify({
      lastPage: "calendar", calendarView: "month",
      calendarAnchors: { day: "2026-09-15", week: "2026-09-15", month: "2026-09-15" },
      calendarZoom: { day: "standard", week: "standard", month: "standard" },
      calendarScale: { day: 48, week: 48, month: 120 },
    }));
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify({
      projects: [], tasks: [{ id: "month-task", projectId: null, title: "月视图排程", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
      progressEvents: [], executionRecords: [], timeBlocks: [], recurringHabits: [], habitOccurrences: [], rescuePromptedSessionIds: [],
      executionSessions: [{ id: "month-session", taskId: "month-task", localDate: "2026-09-15", endLocalDate: "2026-09-15", startLocal: "19:00", endLocal: "20:00", timeZone: "local", utcOffsetMinutes: 0, status: "scheduled" }],
    }));
  });
  await page.reload();

  const headers = page.locator('.month-calendar [role="columnheader"]');
  await expect(headers).toHaveCount(7);
  // 排程结果必须出现在月历格子里，而不是只在右侧详情里看得到。
  const cell = page.getByRole("gridcell", { name: /2026-09-15/ });
  await expect(cell).toContainText("安排 1 项 · 19:00 起");
  await cell.click();
  const detail = page.getByRole("complementary", { name: /2026-09-15.*详情/ });
  await expect(detail).toBeVisible();

  // 详情面板在窄容器下是覆盖层：它绝不能盖住月历的任何一列 —— 这正是
  // 「排程之后月视图看不到周六周日」的现象。逐列断言右边缘都落在面板左侧之内。
  const detailBox = await detail.boundingBox();
  const covered: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    const box = await headers.nth(index).boundingBox();
    const name = (await headers.nth(index).innerText()).trim();
    if (!box || box.x + box.width > detailBox!.x + 1) covered.push(`${name}(${Math.round((box?.x ?? 0) + (box?.width ?? 0))} > ${Math.round(detailBox!.x)})`);
  }
  expect(covered, "被详情面板盖住的列").toEqual([]);
});

test("an editor bubble traps Tab, survives a composing Escape and restores focus", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear()); await page.reload();
  await page.getByRole("textbox", { name: "任务标题", exact: true }).fill("焦点收敛检查");
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  const trigger = page.getByRole("button", { name: "编辑任务 焦点收敛检查" });
  await trigger.click();
  const editor = page.getByRole("dialog", { name: "编辑任务 焦点收敛检查" });
  await expect(editor).toBeVisible();

  // AC02：连续 Tab／Shift+Tab 绕行多圈，焦点始终留在气泡内（宿主的循环，而不是只靠 inert）。
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    expect(await editor.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Shift+Tab");
  expect(await editor.evaluate((node) => node.contains(document.activeElement))).toBe(true);

  // AC02：输入法组合期间的 Escape 属于输入法，不能关掉编辑器（规格 §4.3）。
  await editor.locator("input").first().evaluate((node) => {
    node.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true }));
  });
  await expect(editor).toBeVisible();

  // 组合结束后的普通 Escape 恢复原语义，并把焦点还给触发按钮。
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(trigger).toBeFocused();
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
