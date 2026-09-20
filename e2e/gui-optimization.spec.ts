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

/**
 * 真实鼠标拖拽的回归护栏。
 *
 * `dragstart` 里把拖拽源改成不可命中（`.is-dragging-source { pointer-events: none }`）
 * 会让 Chromium 在拖拽刚开始时就把整个拖拽取消掉：按下、移动、松手全都没反应，
 * 也就是「日历里的卡片怎么都拖不动」。合成 `dispatchEvent` 的用例发现不了这件事
 * （合成事件不经过浏览器的拖拽循环），所以这里必须走真实指针。
 */
const dragGuard = async (page: import("@playwright/test").Page, action: Promise<unknown>) => {
  // 拖拽被浏览器接手时 Playwright 的 mouse.move 会一直等 CDP 回执；用宿主的定时器兜住
  // （不要用 page.waitForTimeout：拖拽取消时页面侧的等待也可能一起挂住）。
  await Promise.race([action.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 1200))]);
};

test("a real native drag of a scheduled card stays alive across day columns", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    const now = new Date();
    const today = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    const startMinutes = now.getHours() * 60 + Math.floor(now.getMinutes() / 15) * 15;
    const clock = (minutes: number) => `${String(Math.floor((minutes % 1440) / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify({
      lastPage: "calendar", calendarView: "week", calendarAnchors: { day: today, week: today, month: today },
      calendarZoom: { day: "compact", week: "compact", month: "compact" }, calendarScale: { day: 48, week: 48, month: 120 }, showActualRecords: false,
    }));
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify({
      projects: [], progressEvents: [], executionRecords: [], timeBlocks: [], recurringHabits: [], habitOccurrences: [], rescuePromptedSessionIds: [],
      tasks: [{ id: "drag-task", projectId: null, title: "拖动探针", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 45, sessionMinutes: 45, sortOrder: 0, kind: "task" }],
      executionSessions: [{ id: "drag-session", taskId: "drag-task", localDate: today, endLocalDate: today, startLocal: clock(startMinutes), endLocal: clock(startMinutes + 45), timeZone: "local", utcOffsetMinutes: -now.getTimezoneOffset(), status: "scheduled" }],
    }));
  });
  await page.reload();
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __dragSeen: string[] }).__dragSeen = seen;
    for (const type of ["dragstart", "dragenter", "dragover", "drop", "dragend"]) {
      document.addEventListener(type, (event) => {
        const target = event.target as HTMLElement | null;
        seen.push(`${type}@${target?.className ?? ""}`);
      }, true);
    }
  });

  const card = page.locator(".calendar-session", { hasText: "拖动探针" });
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  if (!box) throw new Error("拖动探针卡片必须可见");
  const targetTrack = page.locator(".calendar-day:not(.today) .day-track").first();
  const targetBox = await targetTrack.boundingBox();
  if (!targetBox) throw new Error("目标列必须可见");

  const pressX = box.x + box.width / 2;
  const pressY = box.y + 6;
  await dragGuard(page, page.mouse.move(pressX, pressY));
  await dragGuard(page, page.mouse.down());
  // 小位移：这一步指针仍在卡片上，浏览器在此刻决定「拖起来了」。
  await dragGuard(page, page.mouse.move(pressX + 5, pressY + 3));
  const afterStart = await page.evaluate(() => ({
    seen: (window as unknown as { __dragSeen: string[] }).__dragSeen.slice(),
    sourcePointerEvents: (() => {
      const node = document.querySelector(".calendar-session");
      return node ? getComputedStyle(node).pointerEvents : "missing";
    })(),
  }));
  await dragGuard(page, page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 200));
  const during = await page.evaluate(() => (window as unknown as { __dragSeen: string[] }).__dragSeen.slice());
  await dragGuard(page, page.mouse.up());

  expect(afterStart.seen.some((entry) => entry.startsWith("dragstart@")), `拖拽根本没有开始：${JSON.stringify(afterStart.seen)}`).toBe(true);
  // 关键判据：拖拽被取消时 `dragend` 会在同一个事件循环里紧跟着 `dragstart` 到来
  // （源被设成不可命中，浏览器立刻放弃这次拖拽）。指针都已经移动过了，这时还没有
  // `dragend` 就说明拖拽真的活着 —— 这正是「卡片怎么都拖不动」的判别式。
  expect(afterStart.seen.some((entry) => entry.startsWith("dragend@")), `dragstart 之后拖拽立刻被取消：${JSON.stringify(afterStart.seen)}`).toBe(false);
  expect(during.some((entry) => entry.startsWith("dragstart@")), `拖拽无法活到移动结束：${JSON.stringify(during)}`).toBe(true);
  expect(afterStart.sourcePointerEvents, "拖拽源在拖动期间必须仍然可命中").not.toBe("none");
});

test("the drop indicator never shrinks below the card and glides between slots", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    const now = new Date();
    const today = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    const startMinutes = now.getHours() * 60 + Math.floor(now.getMinutes() / 15) * 15;
    const clock = (minutes: number) => `${String(Math.floor((minutes % 1440) / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify({
      lastPage: "calendar", calendarView: "week", calendarAnchors: { day: today, week: today, month: today },
      calendarZoom: { day: "compact", week: "compact", month: "compact" }, calendarScale: { day: 48, week: 48, month: 120 }, showActualRecords: false,
    }));
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify({
      projects: [], progressEvents: [], executionRecords: [], timeBlocks: [], recurringHabits: [], habitOccurrences: [], rescuePromptedSessionIds: [],
      tasks: [{ id: "short-task", projectId: null, title: "短安排", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 15, sessionMinutes: 15, sortOrder: 0, kind: "task" }],
      executionSessions: [{ id: "short-session", taskId: "short-task", localDate: today, endLocalDate: today, startLocal: clock(startMinutes), endLocal: clock(startMinutes + 15), timeZone: "local", utcOffsetMinutes: -now.getTimezoneOffset(), status: "scheduled" }],
    }));
  });
  await page.reload();

  const card = page.locator(".calendar-session", { hasText: "短安排" });
  await expect(card).toBeVisible();
  const track = page.locator(".calendar-day .day-track").nth(2);
  const trackBox = await track.boundingBox();
  if (!trackBox) throw new Error("目标列必须可见");
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await card.dispatchEvent("dragstart", { dataTransfer: transfer });

  const over = async (clientY: number) => {
    await track.dispatchEvent("dragover", { dataTransfer: transfer, clientX: trackBox.x + 20, clientY });
    await page.waitForTimeout(220);
    return page.locator(".calendar-drag-ghost").boundingBox();
  };
  // 15 分钟安排在紧凑比例下只有 12px：虚线框不得比卡片还矮（用户反馈「太短」）。
  const first = await over(trackBox.y + 200);
  const cardBox = await card.boundingBox();
  expect(first).not.toBeNull();
  expect(cardBox).not.toBeNull();
  expect(first!.height).toBeGreaterThanOrEqual(cardBox!.height);
  expect(first!.height).toBeGreaterThanOrEqual(32);

  // 换一格：虚线框要有过渡（不是瞬移），并且确实移动了。
  const moved = await over(trackBox.y + 480);
  expect(moved).not.toBeNull();
  expect(moved!.y).toBeGreaterThan(first!.y + 100);
  const transition = await page.locator(".calendar-drag-ghost").evaluate((node) => getComputedStyle(node).transitionProperty);
  expect(transition).toContain("top");
  expect(await page.locator(".calendar-drag-ghost").evaluate((node) => getComputedStyle(node).transitionDuration)).not.toBe("0s");
  await transfer.dispose();
});

test("pending-review actions open from the card itself instead of on hover", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    const now = new Date();
    const today = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    const clock = (minutes: number) => `${String(Math.floor((minutes % 1440) / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    const ended = now.getHours() * 60 + now.getMinutes() - 90;
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify({
      lastPage: "calendar", calendarView: "week", calendarAnchors: { day: today, week: today, month: today },
      calendarZoom: { day: "compact", week: "compact", month: "compact" }, calendarScale: { day: 48, week: 48, month: 120 }, showActualRecords: false,
    }));
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify({
      projects: [], progressEvents: [], executionRecords: [], timeBlocks: [], recurringHabits: [], habitOccurrences: [], rescuePromptedSessionIds: [],
      tasks: [{ id: "review-task", projectId: null, title: "待回顾入口", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 30, sessionMinutes: 30, sortOrder: 0, kind: "task" }],
      executionSessions: [{ id: "review-session", taskId: "review-task", localDate: today, endLocalDate: today, startLocal: clock(ended), endLocal: clock(ended + 30), timeZone: "local", utcOffsetMinutes: -now.getTimezoneOffset(), status: "scheduled" }],
    }));
  });
  await page.reload();

  const card = page.locator(".calendar-session.pending-review", { hasText: "待回顾入口" });
  await expect(card).toBeVisible();
  const panel = page.getByRole("dialog", { name: "待回顾入口 待回顾操作" });

  // 鼠标扫过去不再是「打开」手势：气泡只在明确点击后才出现。
  await card.hover();
  await expect(panel).toHaveCount(0);

  await card.click({ position: { x: 8, y: 8 } });
  await expect(panel).toBeVisible();
  for (const name of ["更新进度", "继续安排", "本次未推进"]) await expect(panel.getByRole("button", { name })).toBeVisible();

  // Esc 关掉浮层并保持事实不变（没有写入 missed）。
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.locator(".calendar-session.pending-review")).toBeVisible();

  // 「待回顾」状态本身就是键盘入口：聚焦后回车能打开同一套动作。
  const trigger = page.locator(".calendar-session.pending-review button.session-review-trigger");
  await expect(trigger).toHaveCount(1);
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});
