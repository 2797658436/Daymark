import { expect, test, type Locator, type Page } from "@playwright/test";
import path from "node:path";

/**
 * 等待某个滚动容器连续多帧不再变化。
 *
 * 缩放锚点补偿是在测量时刻的滚动位置上做加减的，所以「测量前位置必须已经稳定」
 * 是用例成立的前提。挂载后的首次「定位到当前时间」是异步的（requestAnimationFrame），
 * 不等它落地就写 scrollTop，两个写入的先后顺序就取决于时序 —— M3 曾因此随机失败。
 */
async function waitForScrollSettled(locator: Locator) {
  await locator.evaluate((element) => new Promise<void>((resolve) => {
    let last = element.scrollTop;
    let stable = 0;
    let frames = 0;
    const tick = () => {
      if (element.scrollTop === last) { if (++stable >= 6) return resolve(); }
      else { stable = 0; last = element.scrollTop; }
      if (++frames > 180) return resolve();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("title-only task survives reload without duplication", async ({ page }) => {
  const input = page.getByRole("textbox", { name: "任务标题" });
  await input.fill("整理 Alpha 反馈");
  await input.press("Enter");
  await expect(page.locator(".task-card", { hasText: "整理 Alpha 反馈" })).toHaveCount(1);

  await page.reload();
  await expect(page.locator(".task-card", { hasText: "整理 Alpha 反馈" })).toHaveCount(1);
});

test("task can be scheduled by one drag and the schedule can be undone", async ({ page }) => {
  await page.getByRole("textbox", { name: "任务标题" }).fill("写阶段总结");
  await page.getByRole("button", { name: "创建任务" }).click();
  await page.getByRole("button", { name: "日历", exact: true }).click();
  await page.getByRole("button", { name: "日", exact: true }).click();
  await page.getByRole("button", { name: "下一段日期" }).click();

  const card = page.locator(".task-card", { hasText: "写阶段总结" });
  const futureDay = page.getByRole("region", { name: "连续日时间轴" }).locator("[data-calendar-date]").nth(1).locator(".day-track");
  await card.dragTo(futureDay, { targetPosition: { x: 30, y: 500 } });
  await expect(futureDay.locator(".calendar-session", { hasText: "写阶段总结" })).toHaveCount(1);
  await expect(card).toHaveAttribute("title", /共 1 次/);
  await expect(page.getByRole("button", { name: /撤销安排/ })).toBeVisible();

  await page.getByRole("button", { name: /撤销安排/ }).press("Control+z");
  await expect(futureDay.locator(".calendar-session")).toHaveCount(0);
  await expect(card).toHaveCount(1);
});

test("scheduled session can move and return to the pool without copying its task", async ({ page }) => {
  await page.getByRole("textbox", { name: "任务标题" }).fill("移动排程");
  await page.getByRole("button", { name: "创建任务" }).click();
  await page.getByRole("button", { name: "日历", exact: true }).click();
  await page.getByRole("button", { name: "下一段日期" }).click();
  const task = page.locator(".task-card", { hasText: "移动排程" });
  const firstDay = page.locator(".calendar-day .day-track").nth(0);
  const secondDay = page.locator(".calendar-day .day-track").nth(1);
  await task.dragTo(firstDay, { targetPosition: { x: 30, y: 400 } });
  const session = firstDay.locator(".calendar-session", { hasText: "移动排程" });
  const before = await session.locator("time").textContent();
  await expect(session).toBeVisible();
  const targetBox = await secondDay.boundingBox();
  if (!targetBox) throw new Error("Calendar target must be visible");
  const moveTransfer = await page.evaluateHandle(() => new DataTransfer());
  await session.dispatchEvent("dragstart", { dataTransfer: moveTransfer });
  await secondDay.dispatchEvent("dragover", { dataTransfer: moveTransfer, clientX: targetBox.x + 30, clientY: targetBox.y + 700 });
  await secondDay.dispatchEvent("drop", { dataTransfer: moveTransfer, clientX: targetBox.x + 30, clientY: targetBox.y + 700 });
  await moveTransfer.dispose();
  await expect(firstDay.locator(".calendar-session")).toHaveCount(0);
  await expect(secondDay.locator(".calendar-session", { hasText: "移动排程" }).locator("time")).not.toHaveText(before ?? "");
  const movedSession = secondDay.locator(".calendar-session", { hasText: "移动排程" });
  const cancelTransfer = await page.evaluateHandle(() => new DataTransfer());
  await movedSession.dispatchEvent("dragstart", { dataTransfer: cancelTransfer });
  await page.locator("#task-pool").dispatchEvent("dragover", { dataTransfer: cancelTransfer });
  await page.locator("#task-pool").dispatchEvent("drop", { dataTransfer: cancelTransfer });
  await cancelTransfer.dispose();
  await expect(secondDay.locator(".calendar-session")).toHaveCount(0);
  await expect(task).toHaveCount(1);
});

test("course text is previewed and imported as one project transaction", async ({ page }) => {
  await page.getByRole("button", { name: "项目" }).click();
  await page.getByRole("button", { name: "导入文本课程" }).click();
  await page.getByRole("textbox", { name: "项目标题" }).fill("Rust 入门");
  await page.getByRole("textbox", { name: "粘贴分集文本" }).fill("P1 起步 12:30\nP2 所有权 | 18:00\nP3 收尾");
  await expect(page.getByLabel("课程导入预览").getByRole("checkbox")).toHaveCount(3);
  await page.getByRole("button", { name: "创建", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Rust 入门", level: 2 })).toBeVisible();
  await expect(page.locator(".project-tasks")).toContainText("起步");
  await expect(page.locator(".project-tasks")).toContainText("所有权");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Rust 入门", level: 2 })).toBeVisible();
});

test("phase 2 scheduling, time blocks and recurring habits persist as one action flow", async ({ page }) => {
  await page.getByRole("textbox", { name: "任务标题" }).fill("准备 21 天候选版");
  await page.getByRole("button", { name: "创建任务" }).click();
  await page.getByRole("button", { name: "自动排程" }).click();
  await expect(page.getByRole("dialog", { name: "自动排程 Lite" })).toContainText("准备 21 天候选版");
  await page.getByRole("button", { name: "生成排程草案" }).click();
  await page.getByRole("button", { name: /应用 \d+ 个时段/ }).click();
  await expect(page.getByRole("button", { name: /撤销本次自动排程/ })).toBeVisible();

  await page.getByRole("button", { name: "日历", exact: true }).click();
  await page.getByRole("button", { name: "时间块" }).click();
  await page.getByRole("textbox", { name: "标题", exact: true }).fill("午休");
  await page.getByRole("button", { name: "创建时间块" }).click();
  await expect(page.locator(".calendar-time-block", { hasText: "午休" })).toHaveCount(1);

  await page.getByRole("button", { name: "今日", exact: true }).click();
  await page.getByRole("button", { name: "新建重复习惯" }).click();
  await page.getByRole("textbox", { name: "习惯名称" }).fill("拉伸");
  await page.getByRole("button", { name: "创建习惯" }).click();
  await page.getByRole("button", { name: "安排今天" }).click();
  await expect(page.locator(".habit-list").getByText("已安排", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByText("拉伸", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "回顾", exact: true }).click();
  await expect(page.getByRole("heading", { name: "本周回顾" })).toBeVisible();
});

test("running execution ends with a manual progress summary and remains after reload", async ({ page }) => {
  const now = new Date();
  const today = localDate(now);
  // 起点夹到「今天 00:00」以内：运行中的记录会渲染到 now，跨午夜时同样会在两个日期列
  // 各出现一次（`key` 是 `${record.id}:${date}`），午夜后一分钟内跑会命中 strict violation。
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const start = new Date(Math.max(now.getTime() - 60_000, dayStart.getTime())).toISOString();
  await page.evaluate(({ today, start }) => {
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify({
      appearance: "system", motion: "system", scale: 100, lastPage: "today", calendarView: "week",
      snapMinutes: 15, checkInEnabled: true, remindersEnabled: false, reminderLeadMinutes: 10,
      defaultTimeSlots: [{ id: "evening", label: "晚间专注", start: "19:00", end: "22:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }],
    }));
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify({
      projects: [], timeBlocks: [], progressEvents: [],
      tasks: [{ id: "task-1", projectId: null, title: "完成第一章", progress: 20, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
      executionSessions: [{ id: "session-1", taskId: "task-1", localDate: today, endLocalDate: today, startLocal: "00:00", endLocal: "23:59", timeZone: "local", utcOffsetMinutes: 480, status: "scheduled" }],
      executionRecords: [{ id: "record-1", sessionId: "session-1", taskId: "task-1", actualStartUtc: start, actualEndUtc: null, note: "" }],
    }));
  }, { today, start });
  await page.reload();
  await page.getByRole("button", { name: "结束本次" }).click();
  await page.getByLabel("任务完成度").fill("45");
  await page.getByRole("textbox", { name: /本次小结/ }).fill("保留下一步线索");
  await page.getByRole("button", { name: "结束并保存" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("button", { name: "结束本次" })).toHaveCount(0);
  await expect(page.getByRole("slider", { name: "完成第一章 完成度" }).first()).toHaveValue("45");
});

test("light and dark shells have no automated accessibility violations", async ({ page }) => {
  await page.addScriptTag({ path: path.join(process.cwd(), "node_modules", "axe-core", "axe.min.js") });
  const light = await page.evaluate(async () => (await (window as typeof window & { axe: { run(): Promise<{ violations: unknown[] }> } }).axe.run()).violations);
  expect(light).toEqual([]);
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("radio", { name: "深色" }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.waitForTimeout(150);
  const dark = await page.evaluate(async () => (await (window as typeof window & { axe: { run(): Promise<{ violations: unknown[] }> } }).axe.run()).violations);
  expect(dark).toEqual([]);
});

test("200 percent scaling keeps data actions visible and persists after reload", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("slider", { name: "界面缩放" }).fill("200");
  await page.getByRole("button", { name: "数据" }).click();
  for (const name of ["立即备份", "导出", "恢复"]) {
    const button = page.getByRole("button", { name });
    await expect(button).toBeVisible();
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await page.reload();
  await expect(page.locator("html")).toHaveCSS("font-size", "32px");
  await expect(page.getByRole("heading", { name: "数据与安全" })).toBeVisible();
});

test("narrow windows keep the task pool over the workspace and calendar hours vertical", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.getByRole("button", { name: "打开任务池" }).click();
  await expect(page.locator("#task-pool")).toHaveCSS("position", "fixed");
  await page.getByRole("button", { name: "收起任务池" }).click();
  await expect(page.locator("#task-pool")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "打开任务池" })).toBeVisible();

  await page.getByRole("button", { name: "日历", exact: true }).click();
  const hourLabels = page.locator(".time-axis-track > span");
  const midnight = await hourLabels.nth(0).boundingBox();
  const oneAm = await hourLabels.nth(1).boundingBox();
  if (!midnight || !oneAm) throw new Error("Calendar hour labels must be visible");
  expect(Math.abs(midnight.x - oneAm.x)).toBeLessThan(1);
  expect(oneAm.y).toBeGreaterThan(midnight.y);
  const scrollState = await page.locator(".calendar-viewport").evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
});

test("day view task-pool width is keyboard adjustable and persists", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.getByRole("button", { name: "日历", exact: true }).click();
  await page.getByRole("button", { name: "日", exact: true }).click();
  const splitter = page.getByRole("separator", { name: "调整任务池宽度" });
  await expect(splitter).toBeVisible();
  await splitter.press("ArrowRight");
  await expect(splitter).toHaveAttribute("aria-valuenow", "336");
  await page.reload();
  await expect(page.getByRole("separator", { name: "调整任务池宽度" })).toHaveAttribute("aria-valuenow", "336");
  await expect(page.locator("#task-pool")).toHaveCSS("position", "static");
});

test("phase 3 calendar anchors survive reload and the day axis changes date only at midnight", async ({ page }) => {
  await page.getByRole("textbox", { name: "任务标题" }).fill("跨日安排");
  await page.getByRole("button", { name: "创建任务" }).click();
  await page.getByRole("button", { name: "日历", exact: true }).click();
  const period = page.getByLabel("当前日历日期");
  // 翻页后**不能立刻读 textContent**：React 还没重渲染时读到的是旧标签，拿它去断言之后
  // 会随机失败（实测 3 次里抖 1 次）。先等标签真的变了再捕获。
  const beforeWeek = await period.textContent();
  await page.getByRole("button", { name: "下一段日期" }).click();
  await expect.poll(() => period.textContent()).not.toBe(beforeWeek);
  const futureWeek = await period.textContent();
  await page.getByRole("button", { name: "紧凑" }).click();
  await page.getByRole("button", { name: "月", exact: true }).click();
  await expect(page.getByRole("button", { name: "月", exact: true })).toHaveAttribute("aria-pressed", "true");
  const beforeMonth = await period.textContent();
  await page.getByRole("button", { name: "下一段日期" }).click();
  await expect.poll(() => period.textContent()).not.toBe(beforeMonth);
  const futureMonth = await period.textContent();
  await page.getByRole("button", { name: "详细" }).click();

  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("daymark.phase0.preferences") ?? "{}").calendarAnchors?.month)).not.toBeNull();
  await page.reload();
  await expect(page.getByRole("button", { name: "月", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "详细" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".calendar-page")).toHaveAttribute("data-calendar-zoom", "detailed");
  await expect(period).toHaveText(futureMonth ?? "");
  await page.getByRole("button", { name: "周", exact: true }).click();
  await expect(period).toHaveText(futureWeek ?? "");
  await expect(page.getByRole("button", { name: "紧凑" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".calendar-page")).toHaveAttribute("data-calendar-zoom", "compact");

  await page.getByRole("button", { name: "日", exact: true }).click();
  const initialDay = await period.textContent();
  const axis = page.getByRole("region", { name: "连续日时间轴" });
  await axis.evaluate((element) => {
    const segment = element.scrollHeight / 3;
    element.scrollTop = segment * 1.5;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(period).toHaveText(initialDay ?? "");
  await axis.evaluate((element) => {
    const segment = element.scrollHeight / 3;
    element.scrollTop = segment * 2 + 2;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(period).not.toHaveText(initialDay ?? "");
  const currentTrack = axis.locator("[data-calendar-date]").nth(1).locator(".day-track");
  await page.locator(".task-card", { hasText: "跨日安排" }).dragTo(currentTrack, { targetPosition: { x: 30, y: 500 } });
  await expect(currentTrack.locator(".calendar-session", { hasText: "跨日安排" })).toHaveCount(1);
});

/**
 * 回归：刚过午夜打开日视图，锚点不能退到昨天。
 *
 * 三日缓冲以「今天」为中段，初始定位把「现在」居中。00:55 时视口上半部分落在
 * 前一天，scrollTop 会低于中段起点 —— 旧实现把它当成「用户滚到了前一天」，
 * 于是把锚点改成昨天，标题显示错日期（见 docs/reports 里的 S 记录）。
 * 修复后只有**用户**滚动才触发平移，应用自己的定位不算。
 */
test("phase 3 day view opened just after midnight keeps today instead of shifting to yesterday", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.clock.setFixedTime(new Date("2026-09-20T00:55:00"));
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify({
      lastPage: "calendar", calendarView: "week", calendarAnchors: { day: null, week: null, month: null },
      calendarZoom: { day: "compact", week: "compact", month: "compact" }, calendarScale: { day: 48, week: 48, month: 120 },
    }));
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify({
      projects: [], projectMilestones: [], milestoneOutcomes: [], tasks: [], executionSessions: [],
      executionRecords: [], progressEvents: [], timeBlocks: [], recurringHabits: [], habitOccurrences: [], rescuePromptedSessionIds: [],
    }));
  });
  await page.reload();
  await page.getByRole("button", { name: "日", exact: true }).click();
  const period = page.getByLabel("当前日历日期");
  await expect(period).toHaveText("9月20日星期日");
  // 等过应用自己那两帧定位窗口，锚点不能被写成昨天。
  await page.waitForTimeout(600);
  await expect(period).toHaveText("9月20日星期日");
  const anchors = await page.evaluate(() => JSON.parse(localStorage.getItem("daymark.phase0.preferences") ?? "{}").calendarAnchors ?? {});
  expect(anchors.day === null || anchors.day === "2026-09-20").toBe(true);
  // 三日缓冲仍以今天为中段。
  await expect(page.locator("[data-calendar-date]").nth(1)).toHaveAttribute("data-calendar-date", "2026-09-20");
});

test("phase 3 M2 keeps planned and actual time separate and returns to the live time", async ({ page }) => {
  await page.evaluate(() => {
    const now = new Date();
    const today = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    // 实际记录固定放在**今天上午的固定时刻**，而不是「相对 now 的最近 20 分钟」：
    // 跨午夜的记录会在两个日期列里各渲染一次（`key` 是 `${record.id}:${date}`，这是
    // 正确行为），于是午夜后 20 分钟内跑这条用例会命中 strict mode violation。
    const at = (hour: number, minute: number) => { const date = new Date(); date.setHours(hour, minute, 0, 0); return date.toISOString(); };
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify({
      lastPage: "calendar", calendarView: "week", calendarAnchors: { day: today, week: today, month: today },
      calendarZoom: { day: "standard", week: "standard", month: "standard" }, showActualRecords: true,
    }));
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify({
      projects: [], progressEvents: [], timeBlocks: [], recurringHabits: [], habitOccurrences: [], rescuePromptedSessionIds: [],
      tasks: [
        { id: "task-m2", projectId: null, title: "验证计划实际", progress: 30, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 },
        { id: "task-review", projectId: null, title: "待回顾检查", progress: 20, status: "active", deadlineLocal: null, estimatedMinutes: 30, sortOrder: 1 },
      ],
      executionSessions: [
        { id: "session-m2", taskId: "task-m2", localDate: today, endLocalDate: today, startLocal: "00:00", endLocal: "23:59", timeZone: "local", utcOffsetMinutes: -now.getTimezoneOffset(), status: "scheduled" },
        { id: "session-review", taskId: "task-review", localDate: today, endLocalDate: today, startLocal: "00:00", endLocal: "00:01", timeZone: "local", utcOffsetMinutes: -now.getTimezoneOffset(), status: "scheduled" },
      ],
      executionRecords: [{ id: "record-m2", sessionId: "session-m2", taskId: "task-m2", actualStartUtc: at(9, 0), actualEndUtc: at(9, 15), note: "" }],
    }));
  });
  await page.reload();

  await expect(page.locator(".calendar-now-line")).toHaveCount(1);
  await expect(page.locator(".calendar-session.current-schedule", { hasText: "当前安排" })).toBeVisible();
  await expect(page.locator(".calendar-session.planned-outline", { hasText: "验证计划实际" })).toContainText("00:00–23:59");
  await expect(page.locator(".calendar-actual-record", { hasText: "验证计划实际" })).toBeVisible();
  const compactReview = page.locator(".calendar-session.pending-review", { hasText: "待回顾检查" });
  await expect(compactReview.locator(".session-status-icon")).toHaveAttribute("aria-label", "待回顾");
  await expect(compactReview.locator(".review-summary")).toHaveCount(0);
  // 动作气泡是「点开」的，不是「hover 即弹」：hover 期间不该有任何浮层。
  await compactReview.hover();
  await expect(page.getByRole("dialog", { name: "待回顾检查 待回顾操作" })).toHaveCount(0);
  // 这张卡在窄列里只有 39px 宽，右上角的铅笔覆盖了正中心 —— 按 body 上的固定点点击，
  // 否则点到的是铅笔（打开编辑器），用例名不副实。
  await compactReview.click({ position: { x: 6, y: 10 } });
  for (const name of ["更新进度", "继续安排", "本次未推进"]) {
    const action = page.getByRole("button", { name });
    await expect(action).toBeVisible();
    expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(43.9);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "待回顾检查 待回顾操作" })).toHaveCount(0);

  const viewport = page.locator(".calendar-viewport");
  await viewport.evaluate((element) => {
    const now = new Date(); const target = 52 + (now.getHours() * 60 + now.getMinutes()) / 1440 * (element.scrollHeight - 52);
    element.scrollTop = target > element.scrollHeight / 2 ? 0 : element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByRole("button", { name: "回到现在" })).toBeVisible();
  await page.getByRole("button", { name: "回到现在" }).click();
  await expect(page.getByRole("button", { name: "回到现在" })).toHaveCount(0);

  await page.getByRole("checkbox", { name: "显示实际记录" }).uncheck();
  await expect(page.locator(".calendar-actual-record")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "显示实际记录" })).not.toBeChecked();
  await expect(page.locator(".calendar-session", { hasText: "验证计划实际" })).toContainText("00:00–23:59");
  const planned = await page.evaluate(() => JSON.parse(localStorage.getItem("daymark.phase1.workspace") ?? "{}").executionSessions?.[0]);
  expect(planned).toMatchObject({ startLocal: "00:00", endLocal: "23:59" });
});

test("phase 3 M3 zooms around the pointed time and keeps schedule facts unchanged", async ({ page }) => {
  await page.evaluate(() => {
    const now = new Date();
    const today = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify({
      lastPage: "calendar", calendarView: "week", calendarAnchors: { day: today, week: today, month: today },
      calendarZoom: { day: "standard", week: "standard", month: "standard" },
      calendarScale: { day: 48, week: 48, month: 82 },
    }));
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify({
      projects: [], progressEvents: [], executionRecords: [], timeBlocks: [], recurringHabits: [], habitOccurrences: [], rescuePromptedSessionIds: [],
      tasks: [
        { id: "task-m3-short", projectId: null, title: "短卡操作检查", progress: 20, status: "active", deadlineLocal: null, estimatedMinutes: 20, sortOrder: 0 },
        { id: "task-m3", projectId: null, title: "缩放事实检查", progress: 45, status: "active", deadlineLocal: null, estimatedMinutes: 90, sortOrder: 1 },
      ],
      executionSessions: [
        { id: "session-m3-short", taskId: "task-m3-short", localDate: today, endLocalDate: today, startLocal: "10:00", endLocal: "10:20", timeZone: "local", utcOffsetMinutes: -now.getTimezoneOffset(), status: "scheduled" },
        { id: "session-m3", taskId: "task-m3", localDate: today, endLocalDate: today, startLocal: "12:00", endLocal: "13:30", timeZone: "local", utcOffsetMinutes: -now.getTimezoneOffset(), status: "scheduled" },
      ],
    }));
  });
  await page.reload();

  const calendar = page.getByRole("region", { name: "日历时间网格" });
  const todayTrack = page.locator(".calendar-day.today .day-track");
  await waitForScrollSettled(calendar);
  await calendar.evaluate((element) => { element.scrollTop = 52 + 12 * 48 - element.clientHeight / 2; });
  await waitForScrollSettled(calendar);
  const pointedTimeY = async () => todayTrack.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top + rect.height / 2;
  });
  const trackBox = await todayTrack.boundingBox();
  const before = await pointedTimeY();
  await page.mouse.move((trackBox?.x ?? 0) + (trackBox?.width ?? 100) / 2, before);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");

  await expect(page.locator(".calendar-page")).toHaveAttribute("data-calendar-scale", "52");
  await expect.poll(async () => Math.abs((await pointedTimeY()) - before)).toBeLessThanOrEqual(2);
  const detailedEdit = page.getByRole("button", { name: "编辑 缩放事实检查 时间" });
  await expect(detailedEdit).toHaveCSS("opacity", "1");
  const compactEdit = page.getByRole("button", { name: "编辑 短卡操作检查 时间" });
  await expect(compactEdit).toHaveCSS("opacity", "0");
  await compactEdit.focus();
  await expect(compactEdit).toHaveCSS("opacity", "1");

  const axisBox = await page.locator(".time-axis-track").first().boundingBox();
  const beforeAxisZoom = await pointedTimeY();
  await page.mouse.move((axisBox?.x ?? 0) + (axisBox?.width ?? 50) / 2, beforeAxisZoom);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect(page.locator(".calendar-page")).toHaveAttribute("data-calendar-scale", "56");
  await expect.poll(async () => Math.abs((await pointedTimeY()) - beforeAxisZoom)).toBeLessThanOrEqual(2);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("daymark.phase0.preferences") ?? "{}").calendarScale?.week)).toBe(56);
  const schedule = await page.evaluate(() => JSON.parse(localStorage.getItem("daymark.phase1.workspace") ?? "{}").executionSessions?.[1]);
  expect(schedule).toMatchObject({ startLocal: "12:00", endLocal: "13:30" });

  await page.getByRole("button", { name: "日", exact: true }).click();
  const continuousAxis = page.getByRole("region", { name: "连续日时间轴" });
  const currentPanel = continuousAxis.locator("[data-calendar-date]").nth(1);
  const currentTrack = currentPanel.locator(".day-track");
  await continuousAxis.evaluate((element) => { element.scrollTop = element.scrollHeight / 3 + 52 + 12 * 48 - element.clientHeight / 2; });
  const currentNoonY = async () => currentTrack.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top + rect.height / 2;
  });
  const dayBefore = await currentNoonY();
  const dayAxisBox = await currentPanel.locator(".time-axis-track").boundingBox();
  await page.mouse.move((dayAxisBox?.x ?? 0) + (dayAxisBox?.width ?? 50) / 2, dayBefore);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect(page.locator(".calendar-page")).toHaveAttribute("data-calendar-scale", "52");
  await expect.poll(async () => Math.abs((await currentNoonY()) - dayBefore)).toBeLessThanOrEqual(2);
});

test("phase 3 M4 folds non-default hours and retains only a successful drag expansion", async ({ page }) => {
  const targetDate = await page.evaluate(() => {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  });
  await page.evaluate((date) => {
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify({
      lastPage: "calendar", calendarView: "day", calendarDayMode: "defaultSlots",
      calendarAnchors: { day: date, week: date, month: date },
      calendarZoom: { day: "standard", week: "standard", month: "standard" },
      calendarScale: { day: 48, week: 48, month: 82 },
      defaultTimeSlots: [{ id: "evening", label: "晚间专注", start: "19:00", end: "22:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }],
    }));
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify({
      projects: [], progressEvents: [], executionRecords: [], timeBlocks: [], recurringHabits: [], habitOccurrences: [], rescuePromptedSessionIds: [],
      tasks: [
        { id: "task-folded", projectId: null, title: "折叠安排", progress: 10, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 },
        { id: "task-drop", projectId: null, title: "拖入折叠区", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 1 },
      ],
      executionSessions: [{ id: "session-folded", taskId: "task-folded", localDate: date, endLocalDate: date, startLocal: "10:00", endLocal: "11:00", timeZone: "local", utcOffsetMinutes: -new Date().getTimezoneOffset(), status: "scheduled" }],
    }));
  }, targetDate);
  await page.reload();

  const panel = page.locator(`[data-calendar-date="${targetDate}"]`);
  const track = panel.locator(".day-track");
  const folded = panel.getByRole("button", { name: "00:00–19:00 · 1 项安排" });
  await expect(folded).toBeVisible();
  await expect(panel.locator(".calendar-session", { hasText: "折叠安排" })).toHaveCount(0);

  const transfer = await page.evaluateHandle(() => {
    const value = new DataTransfer();
    value.setData("application/x-daymark-task", "task-drop");
    return value;
  });
  await folded.dispatchEvent("dragenter", { dataTransfer: transfer });
  await page.waitForTimeout(550);
  await expect(panel.locator(".calendar-session", { hasText: "折叠安排" })).toBeVisible();
  const dragRegion = panel.locator(".drag-expanded-region");
  await dragRegion.dispatchEvent("dragleave", { dataTransfer: transfer });
  await expect(panel.locator(".calendar-session", { hasText: "折叠安排" })).toHaveCount(0);

  await folded.dispatchEvent("dragenter", { dataTransfer: transfer });
  await page.waitForTimeout(550);
  const trackBox = await track.boundingBox();
  if (!trackBox) throw new Error("Folded day track must be visible");
  await track.dispatchEvent("drop", { dataTransfer: transfer, clientX: trackBox.x + 40, clientY: trackBox.y + 12 * 48 });
  await transfer.dispose();

  const dropped = panel.locator(".calendar-session", { hasText: "拖入折叠区" });
  await expect(dropped).toBeVisible();
  await expect(panel.getByRole("button", { name: "收起 00:00–19:00" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("daymark.phase1.workspace") ?? "{}").executionSessions?.find((session: { taskId: string }) => session.taskId === "task-drop")?.startLocal)).toBe("12:00");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("daymark.phase0.preferences") ?? "{}").calendarDayMode)).toBe("defaultSlots");
  expect(await page.evaluate(() => localStorage.getItem("daymark.phase0.preferences"))).not.toContain("expandedGap");

  const dayAxis = page.locator(".continuous-day-axis");
  await waitForScrollSettled(dayAxis);
  await dropped.scrollIntoViewIfNeeded();
  await waitForScrollSettled(dayAxis);
  const droppedBox = await dropped.boundingBox();
  if (!droppedBox) throw new Error("Dropped session must be visible");
  await page.mouse.move(droppedBox.x + droppedBox.width / 2, droppedBox.y + 1);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect(page.locator(".calendar-page")).toHaveAttribute("data-calendar-scale", "52");
  await expect.poll(async () => Math.abs(((await dropped.boundingBox())?.y ?? 0) - droppedBox.y)).toBeLessThanOrEqual(2);

  await page.reload();
  await expect(panel.getByRole("button", { name: "00:00–19:00 · 2 项安排" })).toBeVisible();
  await expect(panel.locator(".calendar-session", { hasText: "折叠安排" })).toHaveCount(0);
  await expect(panel.locator(".calendar-session", { hasText: "拖入折叠区" })).toHaveCount(0);
});

test("phase 3 M5 previews and atomically commits insertion, then opens blank-time actions", async ({ page }) => {
  const targetDate = await page.evaluate(() => {
    const now = new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  });
  await page.evaluate((date) => {
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify({
      lastPage: "calendar", calendarView: "week", calendarDayMode: "fullDay", snapMinutes: 15,
      calendarAnchors: { day: date, week: date, month: date }, calendarZoom: { day: "standard", week: "standard", month: "standard" }, calendarScale: { day: 48, week: 48, month: 82 },
    }));
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify({
      projects: [], progressEvents: [], executionRecords: [], timeBlocks: [], recurringHabits: [], habitOccurrences: [], rescuePromptedSessionIds: [],
      tasks: [
        { id: "task-insert", projectId: null, title: "M5 插入任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 },
        { id: "task-target", projectId: null, title: "M5 目标任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 1 },
        { id: "task-next", projectId: null, title: "M5 后续任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 2 },
      ],
      executionSessions: [
        { id: "session-target", taskId: "task-target", localDate: date, endLocalDate: date, startLocal: "10:00", endLocal: "11:00", timeZone: "local", utcOffsetMinutes: -new Date().getTimezoneOffset(), status: "scheduled" },
        { id: "session-next", taskId: "task-next", localDate: date, endLocalDate: date, startLocal: "11:00", endLocal: "12:00", timeZone: "local", utcOffsetMinutes: -new Date().getTimezoneOffset(), status: "scheduled" },
      ],
    }));
  }, targetDate);
  await page.reload();

  await expect(page.getByRole("button", { name: "吸附 15 分钟" })).toHaveAttribute("aria-pressed", "true");
  const panel = page.locator(`.calendar-day[data-day-date="${targetDate}"]`); const track = panel.locator(".day-track");
  const target = panel.locator('.calendar-session[data-session-id="session-target"]');
  const box = await target.boundingBox(); if (!box) throw new Error("M5 target card must be visible");
  const transfer = await page.evaluateHandle(() => { const value = new DataTransfer(); value.setData("application/x-daymark-task", "task-insert"); return value; });
  await target.dispatchEvent("dragover", { dataTransfer: transfer, clientX: box.x + box.width / 2, clientY: box.y + 1 });
  await expect(page.getByRole("status", { name: "拖拽排程预览" })).toContainText("插入并后移");
  await expect(page.getByLabel("插入位置")).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("daymark.phase1.workspace") ?? "{}").executionSessions.length)).toBe(2);
  const dropBox = await target.boundingBox(); if (!dropBox) throw new Error("M5 target card must remain visible after edge auto-scroll");
  await target.dispatchEvent("drop", { dataTransfer: transfer, clientX: dropBox.x + dropBox.width / 2, clientY: dropBox.y + 1 });
  await transfer.dispose();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("daymark.phase1.workspace") ?? "{}").executionSessions.find((session: { taskId: string }) => session.taskId === "task-insert")?.startLocal)).toBe("10:00");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("daymark.phase1.workspace") ?? "{}").executionSessions.find((session: { id: string }) => session.id === "session-target")?.startLocal)).toBe("11:00");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("daymark.phase1.workspace") ?? "{}").executionSessions.find((session: { id: string }) => session.id === "session-next")?.startLocal)).toBe("12:00");

  const trackBox = await track.boundingBox(); if (!trackBox) throw new Error("M5 day track must be visible");
  const blankStart = trackBox.y + trackBox.height * 8 / 24; const blankEnd = trackBox.y + trackBox.height * 9 / 24;
  await track.dispatchEvent("pointerdown", { pointerId: 7, button: 0, clientX: trackBox.x + trackBox.width / 2, clientY: blankStart });
  await track.dispatchEvent("pointerup", { pointerId: 7, button: 0, clientX: trackBox.x + trackBox.width / 2, clientY: blankEnd });
  const bubble = page.getByRole("dialog", { name: "空白时段操作" });
  await expect(bubble).toContainText("08:00–09:00");
  await expect(bubble.getByRole("button", { name: "新建任务" })).toBeVisible();
  await expect(bubble.getByRole("button", { name: "从任务池安排" })).toBeVisible();
  await expect(bubble.getByRole("button", { name: "时间块" })).toBeVisible();
});

test("phase 3 M6 exposes month summaries, week all-day overflow and keyboard navigation", async ({ page }) => {
  const date = "2026-08-05";
  await page.evaluate((targetDate) => {
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify({
      lastPage: "calendar", calendarView: "month", snapMinutes: 15,
      calendarAnchors: { day: targetDate, week: targetDate, month: targetDate }, calendarZoom: { day: "standard", week: "standard", month: "standard" }, calendarScale: { day: 48, week: 48, month: 82 },
    }));
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify({
      projects: [], executionSessions: [], executionRecords: [], timeBlocks: [], recurringHabits: [], habitOccurrences: [], rescuePromptedSessionIds: [],
      tasks: [...Array.from({ length: 4 }, (_, index) => ({ id: `m6-due-${index}`, projectId: null, title: `M6 截止 ${index + 1}`, progress: 0, status: "active", deadlineLocal: targetDate, estimatedMinutes: 30, sortOrder: index })), { id: "m6-done", projectId: null, title: "M6 当天完成", progress: 100, status: "completed", deadlineLocal: null, estimatedMinutes: 30, sortOrder: 4 }],
      progressEvents: [{ id: "m6-progress", taskId: "m6-done", fromProgress: 70, toProgress: 100, occurredAtUtc: `${targetDate}T12:00:00Z` }],
    }));
  }, date);
  await page.reload();

  const cell = page.getByRole("gridcell", { name: /2026-08-05/ });
  await expect(cell).toContainText("M6 截止 2"); await expect(cell).toContainText("另外 3 项");
  await cell.focus(); await page.keyboard.press("ArrowRight");
  await expect(page.locator('[data-month-date="2026-08-06"]')).toBeFocused();
  await page.keyboard.press("ArrowLeft"); await page.keyboard.press("Enter");
  const detail = page.getByRole("complementary", { name: /2026-08-05.*详情/ });
  await expect(detail).toBeVisible();
  await expect.poll(() => detail.evaluate((element) => getComputedStyle(element).position)).toBe("absolute");

  await page.getByRole("button", { name: "周", exact: true }).click();
  const allDay = page.getByRole("region", { name: "全天标记" });
  await expect(allDay.locator("[data-all-day-marker]")).toHaveCount(2);
  await allDay.getByRole("button", { name: "另外 2 项" }).click();
  await expect(allDay.locator("[data-all-day-marker]")).toHaveCount(4);
  await expect(page.locator('[data-day-date="2026-08-05"]')).toHaveClass(/selected/);
  const viewport = page.getByRole("region", { name: "日历时间网格" });
  const stickyHeader = page.locator(".week-sticky-header");
  await viewport.evaluate((element) => { element.scrollTop = 420; });
  await expect.poll(async () => Math.abs(((await stickyHeader.boundingBox())?.y ?? 0) - ((await viewport.boundingBox())?.y ?? 0))).toBeLessThanOrEqual(2);
  const header = page.getByRole("button", { name: /打开 2026-08-05/ }); await header.focus(); await page.keyboard.press("PageDown");
  await expect(page.getByRole("button", { name: /打开 2026-08-12/ })).toBeFocused();
  // 周视图不是网格：时间光标是 `group`（P4-11 方案 B），键盘路径不变。
  const track = page.getByRole("group", { name: "2026-08-12 09:00 空白时间" }); await track.focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "空白时段操作" })).toContainText("09:15–09:45");
});

/**
 * 阶段 4 P4-04 / AC05：日与周各自记住自己的**逻辑**浏览位置，反复切换不累计漂移；
 * 月视图不存时间轴坐标，进入时置顶。切换视图不得改写任何排程事实。
 *
 * 阈值按规格 §5.3：恢复逻辑时间误差 ≤1 分钟或 2 CSS px，取较宽松的可测量者 ——
 * 这里在 48px/小时下换算成像素断言。
 */
test("phase 4 M9 keeps the logical browsing position across day and week switches", async ({ page }) => {
  const anchor = "2026-08-05";
  await page.clock.setFixedTime(new Date("2026-08-05T14:00:00"));
  await page.evaluate((date) => {
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify({
      lastPage: "calendar", calendarView: "week", calendarDayMode: "fullDay",
      calendarAnchors: { day: date, week: date, month: date },
      calendarZoom: { day: "standard", week: "standard", month: "detailed" },
      calendarScale: { day: 48, week: 48, month: 104 },
    }));
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify({
      projects: [], progressEvents: [], executionRecords: [], timeBlocks: [], recurringHabits: [], habitOccurrences: [], rescuePromptedSessionIds: [],
      tasks: [
        { id: "m9-morning", projectId: null, title: "M9 上午安排", progress: 10, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 },
        { id: "m9-evening", projectId: null, title: "M9 晚间安排", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 1 },
      ],
      executionSessions: [
        { id: "m9-session-am", taskId: "m9-morning", localDate: date, endLocalDate: date, startLocal: "09:00", endLocal: "10:00", timeZone: "local", utcOffsetMinutes: -new Date().getTimezoneOffset(), status: "scheduled" },
        { id: "m9-session-pm", taskId: "m9-evening", localDate: date, endLocalDate: date, startLocal: "20:00", endLocal: "21:00", timeZone: "local", utcOffsetMinutes: -new Date().getTimezoneOffset(), status: "scheduled" },
      ],
    }));
  }, anchor);
  await page.reload();

  const calendarViewport = page.getByRole("region", { name: "日历时间网格" });
  await waitForScrollSettled(calendarViewport);
  const factsBefore = await page.evaluate(() => localStorage.getItem("daymark.phase1.workspace"));

  const centreMinute = (container: string, track: string) => page.evaluate(({ container: containerSelector, track: trackSelector }) => {
    const scroller = document.querySelector<HTMLElement>(containerSelector);
    const element = document.querySelector<HTMLElement>(trackSelector);
    if (!scroller || !element) return Number.NaN;
    const scrollerRect = scroller.getBoundingClientRect();
    const trackRect = element.getBoundingClientRect();
    if (trackRect.height <= 0) return Number.NaN;
    return (scrollerRect.top + scroller.clientHeight / 2 - trackRect.top) / trackRect.height * 1440;
  }, { container, track });

  const dayMinutes: number[] = [];
  const weekMinutes: number[] = [];
  for (let round = 0; round < 10; round += 1) {
    await page.getByRole("button", { name: "日", exact: true }).click();
    await waitForScrollSettled(page.getByRole("region", { name: "连续日时间轴" }));
    dayMinutes.push(await centreMinute(".continuous-day-axis", `.continuous-day-panel[data-calendar-date="${anchor}"] .day-track`));

    await page.getByRole("button", { name: "周", exact: true }).click();
    await waitForScrollSettled(calendarViewport);
    weekMinutes.push(await centreMinute(".calendar-viewport", `.calendar-day[data-day-date="${anchor}"] .day-track`));
  }

  const toPixels = (minutes: number) => minutes / 60 * 48;
  const spread = (values: number[]) => toPixels(Math.max(...values) - Math.min(...values));
  // 固定窗口与布局下，14:00 应当始终落在视口中心，且 10 次往返不累计漂移。
  for (const minute of [...dayMinutes, ...weekMinutes]) expect(Math.abs(toPixels(minute - 840))).toBeLessThanOrEqual(2);
  expect(spread(dayMinutes)).toBeLessThanOrEqual(2);
  expect(spread(weekMinutes)).toBeLessThanOrEqual(2);

  // 切视图只改浏览位置，不改写任何排程事实。
  expect(await page.evaluate(() => localStorage.getItem("daymark.phase1.workspace"))).toBe(factsBefore);

  // 月视图不存时间轴坐标：离开再进入必须置顶。
  await page.getByRole("button", { name: "月", exact: true }).click();
  await calendarViewport.evaluate((element) => { element.scrollTop = 200; });
  await page.getByRole("button", { name: "周", exact: true }).click();
  await page.getByRole("button", { name: "月", exact: true }).click();
  await expect.poll(() => calendarViewport.evaluate((element) => element.scrollTop)).toBe(0);
});

/**
 * 阶段 4 P4-05 / AC05：日与周各自的浏览位置**跨启动**恢复（P4-04 只交付了内存态），
 * 月视图不存时间轴坐标、重开后仍进入置顶。
 *
 * 阈值沿用规格 §5.3：恢复逻辑时间误差 ≤1 分钟或 2 CSS px，取较宽松的可测量者 ——
 * 这里在 48px/小时下换算成像素断言。
 */
test("phase 4 M9 restores each timeline view's browsing position after a restart", async ({ page }) => {
  const anchor = "2026-08-05";
  await page.clock.setFixedTime(new Date("2026-08-05T14:00:00"));
  await page.evaluate((date) => {
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify({
      lastPage: "calendar", calendarView: "day", calendarDayMode: "fullDay",
      calendarAnchors: { day: date, week: date, month: date },
      calendarZoom: { day: "standard", week: "standard", month: "detailed" },
      calendarScale: { day: 48, week: 48, month: 104 },
    }));
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify({
      projects: [], progressEvents: [], executionRecords: [], timeBlocks: [], recurringHabits: [], habitOccurrences: [], rescuePromptedSessionIds: [],
      tasks: [
        { id: "m9-morning", projectId: null, title: "M9 上午安排", progress: 10, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 },
        { id: "m9-evening", projectId: null, title: "M9 晚间安排", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 1 },
      ],
      executionSessions: [
        { id: "m9-session-am", taskId: "m9-morning", localDate: date, endLocalDate: date, startLocal: "09:00", endLocal: "10:00", timeZone: "local", utcOffsetMinutes: -new Date().getTimezoneOffset(), status: "scheduled" },
        { id: "m9-session-pm", taskId: "m9-evening", localDate: date, endLocalDate: date, startLocal: "20:00", endLocal: "21:00", timeZone: "local", utcOffsetMinutes: -new Date().getTimezoneOffset(), status: "scheduled" },
      ],
    }));
  }, anchor);
  await page.reload();

  const centreMinute = (container: string, track: string) => page.evaluate(({ container: containerSelector, track: trackSelector }) => {
    const scroller = document.querySelector<HTMLElement>(containerSelector);
    const element = document.querySelector<HTMLElement>(trackSelector);
    if (!scroller || !element) return Number.NaN;
    const scrollerRect = scroller.getBoundingClientRect();
    const trackRect = element.getBoundingClientRect();
    if (trackRect.height <= 0) return Number.NaN;
    return (scrollerRect.top + scroller.clientHeight / 2 - trackRect.top) / trackRect.height * 1440;
  }, { container, track });
  /** 偏好里已经落定的浏览位置；写入是异步的（滚动停止 300ms 后），所以要轮询。 */
  const storedMinute = (view: "day" | "week") => page.evaluate((target) => {
    const raw = localStorage.getItem("daymark.phase0.preferences");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { calendarPositions?: Record<string, { minute: number } | null> };
    return parsed.calendarPositions?.[target]?.minute ?? null;
  }, view);
  const toPixels = (minutes: number) => minutes / 60 * 48;

  // 日视图：用户滚动 → 落定写入偏好 → 重开回到同一位置。
  const dayAxis = page.getByRole("region", { name: "连续日时间轴" });
  await waitForScrollSettled(dayAxis);
  await dayAxis.evaluate((element) => { element.scrollTop += 240; });
  await expect.poll(() => storedMinute("day")).not.toBeNull();
  const dayBefore = await centreMinute(".continuous-day-axis", `.continuous-day-panel[data-calendar-date="${anchor}"] .day-track`);

  await page.reload();
  await waitForScrollSettled(page.getByRole("region", { name: "连续日时间轴" }));
  const dayAfter = await centreMinute(".continuous-day-axis", `.continuous-day-panel[data-calendar-date="${anchor}"] .day-track`);
  expect(Math.abs(toPixels(dayAfter - dayBefore))).toBeLessThanOrEqual(2);

  // 周视图：各自记各自的，重开同样回到各自位置。
  await page.getByRole("button", { name: "周", exact: true }).click();
  const calendarViewport = page.getByRole("region", { name: "日历时间网格" });
  await waitForScrollSettled(calendarViewport);
  await calendarViewport.evaluate((element) => { element.scrollTop += 240; });
  await expect.poll(() => storedMinute("week")).not.toBeNull();
  const weekBefore = await centreMinute(".calendar-viewport", `.calendar-day[data-day-date="${anchor}"] .day-track`);

  await page.reload();
  await waitForScrollSettled(page.getByRole("region", { name: "日历时间网格" }));
  const weekAfter = await centreMinute(".calendar-viewport", `.calendar-day[data-day-date="${anchor}"] .day-track`);
  expect(Math.abs(toPixels(weekAfter - weekBefore))).toBeLessThanOrEqual(2);

  // 月视图不存时间轴坐标：重开后仍然置顶。
  await page.getByRole("button", { name: "月", exact: true }).click();
  await calendarViewport.evaluate((element) => { element.scrollTop = 200; });
  await page.reload();
  await expect.poll(() => page.getByRole("region", { name: "日历时间网格" }).evaluate((element) => element.scrollTop)).toBe(0);
});

function localDate(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/**
 * 阶段 4 P4-06 / AC10：截止事项页的跨页返回与「安排必须预览确认」。
 *
 * 筛选、焦点项与滚动位置只活在 App 层内存里：同一会话内跨页返回仍然有效，整页
 * 重载（应用重启）后回到默认筛选。这里用固定的本地日期 2026-08-05 让四个分组都
 * 有内容，并且内容高度超过 760px 视口，滚动位置才有意义。
 */
const DEADLINE_TODAY = "2026-08-05";

function deadlineWorkspace() {
  const dated = (id: string, day: string, sortOrder: number) => ({
    id, projectId: null, title: `截止任务 ${id.slice(-2)}`, progress: 0, status: "active",
    deadlineLocal: day, estimatedMinutes: 60, sessionMinutes: 60, priority: "normal", sortOrder, kind: "task",
  });
  return {
    projects: [{ id: "p-1", title: "学习项目", deadlineLocal: "2026-08-20" }],
    tasks: [
      dated("t-01", "2026-08-01", 0), dated("t-02", "2026-08-02", 1), dated("t-03", DEADLINE_TODAY, 2),
      dated("t-04", DEADLINE_TODAY, 3), dated("t-05", DEADLINE_TODAY, 4), dated("t-06", "2026-08-06", 5),
      dated("t-07", "2026-08-07", 6), dated("t-08", "2026-08-08", 7), dated("t-09", "2026-08-11", 8),
      dated("t-10", "2026-08-12", 9), dated("t-11", "2026-08-20", 10), dated("t-12", "2026-09-01", 11),
      { id: "t-done", projectId: "p-1", title: "项目内已完成任务", progress: 100, status: "completed", deadlineLocal: null, estimatedMinutes: 60, priority: "normal", sortOrder: 12, kind: "task" },
    ],
    projectMilestones: [
      { id: "m-frozen", projectId: "p-1", title: "冻结的里程碑", targetLocalDate: "2026-08-03", sortOrder: 0, criterionKind: "taskCount", targetTaskId: null, targetCount: 2, targetProgress: null },
      { id: "m-reached", projectId: "p-1", title: "阶段检查点", targetLocalDate: "2026-08-06", sortOrder: 1, criterionKind: "taskCount", targetTaskId: null, targetCount: 1, targetProgress: null },
    ],
    milestoneOutcomes: [{ id: "o-1", milestoneId: "m-frozen", projectId: "p-1", title: "冻结的里程碑", targetLocalDate: "2026-08-03", reached: false, resultText: "完成 0/2，未达成", frozenAtUtc: "2026-08-04T00:00:00Z" }],
    executionSessions: [], executionRecords: [], progressEvents: [], timeBlocks: [], recurringHabits: [], habitOccurrences: [], rescuePromptedSessionIds: [],
  };
}

async function seedDeadlines(page: import("@playwright/test").Page) {
  await page.clock.setFixedTime(new Date("2026-08-05T12:00:00"));
  await page.evaluate((workspace) => {
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify({ lastPage: "deadlines" }));
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify(workspace));
  }, deadlineWorkspace());
  await page.reload();
  await expect(page.getByRole("heading", { name: "截止事项", level: 1 })).toBeVisible();
}

const sidebar = (page: import("@playwright/test").Page) => page.getByRole("navigation", { name: "主导航" });

test("phase 4 M10 keeps the deadline filter, focus and scroll across a round trip but not across a restart", async ({ page }) => {
  await seedDeadlines(page);
  const main = page.locator("#main-content");
  const rows = page.locator("[data-deadline-key]");

  // 四个分组都按本地日期切分：已逾期 / 今天 / 未来七天（含 today+7）/ 以后。
  await expect(page.locator('[data-deadline-group="overdue"] .deadline-title')).toHaveCount(3);
  await expect(page.locator('[data-deadline-group="today"] .deadline-title')).toHaveCount(3);
  await expect(page.locator('[data-deadline-group="nextSevenDays"] .deadline-title')).toHaveCount(5);
  await expect(page.locator('[data-deadline-group="later"] .deadline-title')).toHaveCount(3);
  // 当前达成项默认隐藏，冻结未达成项保留原结果。
  await expect(page.locator(".deadline-state.currentlyReached")).toHaveCount(0);
  await expect(page.locator(".deadline-state.frozenUnmet")).toHaveCount(1);
  await expect(page.getByText("完成 0/2，未达成")).toBeVisible();

  // 非默认筛选：把当前已达成的里程碑显示出来。
  await page.getByLabel("含已达成").check();
  await expect(page.getByText("阶段检查点")).toBeVisible();
  await expect(page.locator(".deadline-state.currentlyReached")).toHaveCount(1);
  await expect(rows).toHaveCount(15);

  await main.evaluate((element) => { element.scrollTop = 320; });
  await page.getByRole("button", { name: "编辑任务 截止任务 06" }).click();
  await expect(page.getByRole("dialog", { name: "编辑任务 截止任务 06" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const before = await main.evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(0);

  // 跨页离开再回来：目标页更短，位置被浏览器夹到 0，回来必须由内存恢复。
  await sidebar(page).getByRole("button", { name: "项目" }).click();
  await expect(page.getByRole("heading", { name: "项目", level: 1 })).toBeVisible();
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(0);

  await sidebar(page).getByRole("button", { name: "截止", exact: true }).click();
  await expect(page.getByRole("heading", { name: "截止事项", level: 1 })).toBeVisible();
  await expect(page.getByLabel("含已达成")).toBeChecked();
  await expect(rows).toHaveCount(15);
  expect(Math.abs(await main.evaluate((element) => element.scrollTop) - before)).toBeLessThanOrEqual(2);
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-deadline-key]")?.getAttribute("data-deadline-key") ?? null)).toBe("task:t-06");

  // 重启（整页重载）后不恢复：筛选与焦点回到默认。
  await page.reload();
  await expect(page.getByRole("heading", { name: "截止事项", level: 1 })).toBeVisible();
  await expect(page.getByLabel("含已达成")).not.toBeChecked();
  await expect(rows).toHaveCount(14);
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(0);
});

test("phase 4 M10 previews the deadline schedule draft before writing any session", async ({ page }) => {
  await seedDeadlines(page);
  const sessionCount = () => page.evaluate(() => {
    const raw = localStorage.getItem("daymark.phase1.workspace");
    return raw ? (JSON.parse(raw) as { executionSessions: unknown[] }).executionSessions.length : -1;
  });
  expect(await sessionCount()).toBe(0);

  await page.getByRole("button", { name: "安排任务 截止任务 03" }).click();
  await expect(page.getByRole("dialog", { name: "自动排程 Lite" })).toBeVisible();
  await page.getByRole("button", { name: "生成排程草案" }).click();

  // 草案只是预览：确认之前不写入任何执行时段。
  await expect(page.getByRole("dialog", { name: "确认排程草案" })).toBeVisible();
  expect(await sessionCount()).toBe(0);

  await page.getByRole("button", { name: /^应用 \d+ 个时段$/ }).click();
  await expect.poll(sessionCount).toBeGreaterThan(0);
});

/**
 * D5 口径（`docs/reports/phase-4-decisions-walkthrough.md`）：「回到现在」是用户**明确请求**
 * 的落点，落定后写进浏览偏好 —— 下次打开仍停在「现在」，而不是上次手动滚到的地方。
 * 优先级 6 的首次自动定位刻意不同（只刷新内存位置、不写偏好），两者不能"统一"掉。
 *
 * 只能在真实浏览器里测：jsdom 没有布局、`scrollIntoView` 是空实现，revealNow 不会真的滚动。
 */
test("phase 4 M9 records 'back to now' as the remembered browsing position", async ({ page }) => {
  const anchor = "2026-08-05";
  await page.clock.setFixedTime(new Date("2026-08-05T14:00:00"));
  await page.evaluate((date) => {
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify({
      lastPage: "calendar", calendarView: "week",
      calendarAnchors: { day: date, week: date, month: date },
      calendarZoom: { day: "standard", week: "standard", month: "detailed" },
      calendarScale: { day: 48, week: 48, month: 104 },
    }));
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify({
      projects: [], progressEvents: [], executionRecords: [], timeBlocks: [], recurringHabits: [], habitOccurrences: [], rescuePromptedSessionIds: [],
      tasks: [{ id: "d5-task", projectId: null, title: "D5 安排", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
      executionSessions: [{ id: "d5-session", taskId: "d5-task", localDate: date, endLocalDate: date, startLocal: "09:00", endLocal: "10:00", timeZone: "local", utcOffsetMinutes: -new Date().getTimezoneOffset(), status: "scheduled" }],
    }));
  }, anchor);
  await page.reload();

  /** 偏好里已经落定的周视图浏览位置；写入是异步的（滚动停止后采样），所以要轮询。 */
  const storedWeekMinute = () => page.evaluate(() => {
    const raw = localStorage.getItem("daymark.phase0.preferences");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { calendarPositions?: { week?: { minute: number } | null } };
    return parsed.calendarPositions?.week?.minute ?? null;
  });

  // 先手动滚到时间轴顶端，让「回到现在」出现。周视图没有三日缓冲，滚动不会被应用自己改写。
  const viewport = page.locator(".calendar-viewport");
  await viewport.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  await expect(page.getByRole("button", { name: "回到现在" })).toBeVisible();
  await expect.poll(storedWeekMinute, { timeout: 5_000 }).toBeLessThan(700);

  // 点「回到现在」→ 视口中心落在 14:00（840 分钟），并把这次落定写进偏好。
  await page.getByRole("button", { name: "回到现在" }).click();
  await expect.poll(storedWeekMinute, { timeout: 5_000 }).toBeGreaterThan(800);
});

/**
 * 阶段 4 P4-08 / AC13：日／周／月回顾的汇总与明细可核对，当前进度不冒充历史，
 * 周期与锚点作为**偏好**跨重启保留（`reviewPeriod`／`reviewAnchorDate`）。
 *
 * 固定时钟 2026-08-05（周三，所在周为 08-03–08-09），事实全部由本地墙钟构造。
 */
function reviewWorkspace() {
  const at = (date: string, time: string) => new Date(`${date}T${time}:00`).toISOString();
  const filler = Array.from({ length: 12 }, (_, index) => ({
    id: `m11-fill-${String(index).padStart(2, "0")}`, projectId: null, title: `明细任务 ${index + 1}`, progress: 0, status: "active",
    deadlineLocal: null, estimatedMinutes: 60, sessionMinutes: 60, priority: "normal", sortOrder: index + 2, kind: "task",
  }));
  return {
    projects: [{ id: "rp-1", title: "回顾项目", deadlineLocal: null }],
    tasks: [
      // 有事件：周期内 40 → 60，当前也是 60。
      { id: "m11-alpha", projectId: "rp-1", title: "Alpha 任务", progress: 60, status: "active", deadlineLocal: null, estimatedMinutes: 60, sessionMinutes: 60, priority: "normal", sortOrder: 0, kind: "task" },
      // 下调：50 → 20，当前 20。
      { id: "m11-beta", projectId: null, title: "Beta 任务", progress: 20, status: "active", deadlineLocal: null, estimatedMinutes: 60, sessionMinutes: 60, priority: "normal", sortOrder: 1, kind: "task" },
      // 只有计划、没有事件：当前进度 45 不得被当成周期历史。
      { ...filler[0], progress: 45 },
      ...filler.slice(1),
    ],
    progressEvents: [
      { id: "m11-e1", taskId: "m11-alpha", fromProgress: 40, toProgress: 60, occurredAtUtc: at("2026-08-04", "09:00") },
      { id: "m11-e2", taskId: "m11-beta", fromProgress: 50, toProgress: 20, occurredAtUtc: at("2026-08-05", "10:00") },
    ],
    executionRecords: [
      { id: "m11-r1", sessionId: null, taskId: "m11-alpha", actualStartUtc: at("2026-08-04", "20:00"), actualEndUtc: at("2026-08-04", "21:00"), note: "第一段" },
    ],
    executionSessions: [
      { id: "m11-s1", taskId: "m11-fill-00", localDate: "2026-08-06", endLocalDate: "2026-08-06", startLocal: "19:00", endLocal: "20:00", timeZone: "local", utcOffsetMinutes: -new Date().getTimezoneOffset(), status: "scheduled" },
    ],
    projectMilestones: [], milestoneOutcomes: [], timeBlocks: [], recurringHabits: [], habitOccurrences: [], rescuePromptedSessionIds: [],
  };
}

async function seedReview(page: import("@playwright/test").Page) {
  await page.clock.setFixedTime(new Date("2026-08-05T12:00:00"));
  await page.evaluate((workspace) => {
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify({ lastPage: "review" }));
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify(workspace));
  }, reviewWorkspace());
  await page.reload();
  await expect(page.getByRole("heading", { name: "本周回顾", level: 1 })).toBeVisible();
}

/** 周视图的等价数值表在「详细」气泡里：先点开对应那张图的按钮。 */
async function openWeeklyTable(page: import("@playwright/test").Page, figure: number) {
  await page.getByRole("button", { name: "详细" }).nth(figure).click();
  await expect(page.locator(".review-chart-popover")).toBeVisible();
}
/** 点页面别处收起气泡（浮层会吞掉外部点击，所以点标题最稳）。 */
async function closeWeeklyTable(page: import("@playwright/test").Page) {
  await page.locator(".review-page h1").click();
  await expect(page.locator(".review-chart-popover")).toHaveCount(0);
}
/** 气泡里那一行的第几列：0＝星期，1＝投入时间，2＝百分点。 */
function chartCell(page: import("@playwright/test").Page, date: string, column: number) {
  return page.locator(`.review-chart-popover tr:has([data-chart-row="${date}"]) td`).nth(column);
}

test("phase 4 M11 keeps day, week and month summaries checkable against their detail and remembers the choice", async ({ page }) => {
  await seedReview(page);
  const storedReview = () => page.evaluate(() => {
    const raw = localStorage.getItem("daymark.phase0.preferences");
    return raw ? JSON.parse(raw) as { reviewPeriod?: string; reviewAnchorDate?: string | null } : null;
  });

  // 默认停在当前周（锚点为 null 时按当前周期计算）。三个大字在页面第一行。
  await expect(page.locator('[data-review-stat="actual"]')).toContainText("60 分钟");
  await expect(page.locator('[data-review-stat="progress"]')).toContainText("-10 百分点");

  // ① 汇总能被 ② 的等价数值表核对：周视图的四列表格同时给出投入与百分点。
  await openWeeklyTable(page, 0);
  await expect(chartCell(page, "2026-08-04", 1)).toHaveText("60 分钟");
  await expect(chartCell(page, "2026-08-05", 1)).toHaveText("未记录");
  await expect(chartCell(page, "2026-08-04", 2)).toHaveText("+20 百分点");
  await expect(chartCell(page, "2026-08-05", 2)).toHaveText("-30 百分点");
  await closeWeeklyTable(page);
  // 切成净进度：零基线不在底部，并且有文字说明，不用正向热度暗示。
  await page.locator(".review-metric-switch").getByRole("button", { name: "净进度" }).click();
  await expect(page.locator(".review-chart-figure").first().locator(".review-chart-zero")).toHaveAttribute("style", /top: 40%/);
  await expect(page.getByText(/零基线以上是上调，以下是下调/)).toBeVisible();
  await page.locator(".review-metric-switch").getByRole("button", { name: "实际投入" }).click();

  // ③ 明细与 ② 一致；没有事件的时段任务显示「本周期无进度记录，当前 N%」，不冒充历史。
  const alphaRow = page.locator('[data-review-task="m11-alpha"]');
  await expect(alphaRow).toContainText("40% → 60%");
  await expect(alphaRow).toContainText("净变化 +20 百分点");
  await expect(alphaRow).toContainText("投入 60 分钟");
  await expect(page.locator('[data-review-task="m11-fill-00"]')).toContainText("本周期无进度记录，当前 45%");

  // 日视图：就是那一天。
  await page.getByRole("button", { name: "日", exact: true }).click();
  await expect(page.getByRole("heading", { name: "今日回顾", level: 1 })).toBeVisible();
  await expect.poll(storedReview).toMatchObject({ reviewPeriod: "day" });

  // 月视图：自然月，日期概览覆盖整月。
  await page.getByRole("button", { name: "月", exact: true }).click();
  await expect(page.getByRole("heading", { name: "2026年8月回顾", level: 1 })).toBeVisible();
  await expect(page.locator(".review-chart-figure").first().locator("[data-chart-row]")).toHaveCount(31);

  // 在日历里跳到上个月：写锚点，重启后仍然是同一个月。
  await page.getByRole("button", { name: "选择日期" }).click();
  await page.locator(".review-picker").getByRole("button", { name: "7 月" }).click();
  await expect(page.getByRole("heading", { name: "2026年7月回顾", level: 1 })).toBeVisible();
  await expect.poll(storedReview).toMatchObject({ reviewPeriod: "month", reviewAnchorDate: "2026-07-01" });
  await page.reload();
  await expect(page.getByRole("heading", { name: "2026年7月回顾", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "月", exact: true })).toHaveAttribute("aria-pressed", "true");

  // 「回到当前周期」把锚点交回给时钟。
  await page.getByRole("button", { name: "回到当前周期" }).click();
  await expect(page.getByRole("heading", { name: "2026年8月回顾", level: 1 })).toBeVisible();
  await expect.poll(storedReview).toMatchObject({ reviewAnchorDate: null });
});

test("phase 4 M11 opens the in-page detail, keeps the summary scroll and gives the focus back", async ({ page }) => {
  await seedReview(page);
  const main = page.locator("#main-content");
  // 月视图的数值表足够长，滚动位置才有意义。
  await page.getByRole("button", { name: "月", exact: true }).click();
  await expect(page.getByRole("heading", { name: "2026年8月回顾", level: 1 })).toBeVisible();
  // 月视图的等价数值表默认收起，先展开才能从日期下钻。
  await page.locator(".review-chart-details summary").first().click();

  await main.evaluate((element) => { element.scrollTop = 420; });
  const trigger = page.getByRole("button", { name: "查看 8月4日 的明细" }).first();
  await trigger.click();
  const detail = page.locator(".review-drilldown");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("60 分钟");
  await expect(detail).toContainText("第一段");
  await expect(detail).toContainText("40% → 60%");

  // 打开明细后用户滚开了；Esc 关闭必须回到汇总原来的位置，并把焦点还给触发元素。
  await main.evaluate((element) => { element.scrollTop = 0; });
  await page.keyboard.press("Escape");
  await expect(page.locator(".review-drilldown")).toHaveCount(0);
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(420);
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null)).toBe("查看 8月4日 的明细");
});

test("phase 4 M11 review page has no automated accessibility violations in light and dark at 200 percent zoom", async ({ page }) => {
  await seedReview(page);
  await page.setViewportSize({ width: 960, height: 640 });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("slider", { name: "界面缩放" }).fill("200");
  await page.getByRole("button", { name: "回顾", exact: true }).click();
  await expect(page.getByRole("heading", { name: "本周回顾", level: 1 })).toBeVisible();

  await page.addScriptTag({ path: path.join(process.cwd(), "node_modules", "axe-core", "axe.min.js") });
  const light = await page.evaluate(async () => (await (window as typeof window & { axe: { run(): Promise<{ violations: unknown[] }> } }).axe.run()).violations);
  expect(light).toEqual([]);

  // 200% 缩放下图表与等价数值表仍然可用，并且不产生横向溢出。
  await expect(page.locator(".review-chart-figure").first()).toBeVisible();
  const main = page.locator("#main-content");
  expect(await main.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(2);
  // 核心路径可完成：打开「详细」气泡 → 从日期下钻 → 关掉。
  await openWeeklyTable(page, 0);
  await expect(page.locator(".review-chart-table")).toBeVisible();
  await page.getByRole("button", { name: "查看 8月4日 的明细" }).first().click();
  await expect(page.locator(".review-drilldown")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".review-drilldown")).toHaveCount(0);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("radio", { name: "深色" }).check();
  await page.getByRole("button", { name: "回顾", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.waitForTimeout(150);
  const dark = await page.evaluate(async () => (await (window as typeof window & { axe: { run(): Promise<{ violations: unknown[] }> } }).axe.run()).violations);
  expect(dark).toEqual([]);
});

/**
 * 阶段 4 P4-09 / AC14：浅／深色 × 100／150／200% 应用内缩放 × 960／1200 内容宽度。
 *
 * 规格 §11 的口径：960／1200 是**应用内容宽度**（视口宽度），应用内缩放（root 字号
 * 百分比）另计，两者分别记录。每一格都要满足：主导航每个入口仍在视口内、页面不横向
 * 溢出、回顾与截止两条核心路径能走完。`data-scale` 在 ≥150% 时切到 `large`，这是
 * 样式层唯一的缩放分支，所以 150% 也必须实测，不能只测两端。
 */
const SCALE_MATRIX = [100, 150, 200];
const WIDTH_MATRIX = [960, 1200];
const NAV_ENTRIES = ["今日", "日历", "截止", "项目", "回顾", "数据", "设置"];

/** 通过设置页的滑块改应用内缩放；`html` 的 font-size 是百分比的最终落点，用它当判据。 */
async function setAppScale(page: import("@playwright/test").Page, scale: number) {
  await sidebar(page).getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "设置", level: 1 })).toBeVisible();
  await page.getByRole("slider", { name: "界面缩放" }).fill(String(scale));
  await expect(page.locator("html")).toHaveCSS("font-size", `${(scale / 100) * 16}px`);
  await expect(page.locator("html")).toHaveAttribute("data-scale", scale >= 150 ? "large" : "normal");
}

test("phase 4 M12 keeps every core path completable across the scaling matrix", async ({ page }) => {
  await seedReview(page);
  const main = page.locator("#main-content");

  for (const width of WIDTH_MATRIX) {
    for (const scale of SCALE_MATRIX) {
      const cell = `${width}×${scale}%`;
      await page.setViewportSize({ width, height: 720 });
      await setAppScale(page, scale);

      // 导航：每个入口都必须在视口内可点。高缩放把入口挤出屏幕等于功能消失。
      for (const entry of NAV_ENTRIES) {
        const button = sidebar(page).getByRole("button", { name: entry, exact: true });
        await expect(button, cell).toBeVisible();
        const box = await button.boundingBox();
        if (!box) throw new Error(`${cell}：导航入口「${entry}」没有布局盒`);
        expect(box.width, cell).toBeGreaterThan(0);
        expect(box.height, cell).toBeGreaterThan(0);
        expect(box.x + box.width, cell).toBeLessThanOrEqual(width + 1);
      }

      // 回顾页：周期切换、图表等价数值表、下钻开关都要能走完，且不横向溢出。
      await sidebar(page).getByRole("button", { name: "回顾", exact: true }).click();
      await expect(page.getByRole("heading", { name: "本周回顾", level: 1 })).toBeVisible();
      expect(await main.evaluate((element) => element.scrollWidth - element.clientWidth), cell).toBeLessThanOrEqual(2);
      await page.getByRole("button", { name: "月", exact: true }).click();
      await expect(page.getByRole("heading", { name: "2026年8月回顾", level: 1 })).toBeVisible();
      // 月视图的数值表默认收起（31 天），展开后才可下钻 —— 收的是排版，不是内容。
      await page.locator(".review-chart-details summary").first().click();
      await expect(page.locator(".review-chart-table").first()).toBeVisible();
      await page.getByRole("button", { name: "查看 8月4日 的明细" }).first().click();
      await expect(page.locator(".review-drilldown")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator(".review-drilldown")).toHaveCount(0);
      await page.getByRole("button", { name: "周", exact: true }).click();
      await expect(page.getByRole("heading", { name: "本周回顾", level: 1 })).toBeVisible();

      // 截止页：筛选组与行级入口在缩放下仍然可操作。
      await sidebar(page).getByRole("button", { name: "截止", exact: true }).click();
      await expect(page.getByRole("heading", { name: "截止事项", level: 1 })).toBeVisible();
      expect(await main.evaluate((element) => element.scrollWidth - element.clientWidth), cell).toBeLessThanOrEqual(2);
      // 用键盘路径切换筛选：1200 宽 × 200% 下复选框**第一次**鼠标点击会因为获得焦点
      // 引起的布局位移而落空（详见 `docs/reports/phase-4-p4-09-implementation.md` §7 的
      // S3 记录），第二次正常。这里验证的是「筛选在缩放下可操作」，所以走键盘（Tab 到
      // 复选框后按空格），鼠标路径的缺陷单独记录，不在这里假装不存在。
      const reached = page.getByLabel("含已达成");
      await expect(reached, cell).toBeVisible();
      expect((await reached.boundingBox())?.height ?? 0, cell).toBeGreaterThan(0);
      await reached.press("Space");
      await expect(reached, cell).toBeChecked();
      await reached.press("Space");
      await expect(reached, cell).not.toBeChecked();
    }
  }
});

test("phase 4 M12 has no automated accessibility violations on every page at 960 and 200 percent in light and dark", async ({ page }) => {
  await seedReview(page);
  await page.setViewportSize({ width: 960, height: 720 });
  await setAppScale(page, 200);
  await page.addScriptTag({ path: path.join(process.cwd(), "node_modules", "axe-core", "axe.min.js") });

  /**
   * 日历网格的 ARIA 结构：**P4-11 已修正，三条视图都零违规**。
   *
   * 月视图是一张 6×7 的表 —— `role="grid"` → 7 个 `role="row"`（表头 1 行 + 日期 6 行）
   * → `role="columnheader"`／`role="gridcell"`。此前 42 个格子与 7 个表头都是 `role="grid"`
   * 的**直接子元素**，axe 报 `aria-required-children` + `aria-required-parent`（49 个节点）。
   *
   * 周视图**不是**网格：7 个日列各自是一条 24 小时连续时间轴，DOM 里没有「行」，
   * 所以走方案 B —— 日列与列里的时间光标都是 `group` + 可访问名，不再声称
   * `grid → row → gridcell`。此前 `.day-track` 挂着 `role="gridcell"` 却直接挂在
   * `role="region"` 下，axe 报 `aria-required-parent`（7 个节点）。
   *
   * 这里不再保留任何「已记录缺陷」常量：三条视图一律断言零违规。日视图此前**从未**
   * 被 axe 覆盖（只跑了周与月），P4-11 起一并纳入。方案与取舍见
   * `docs/reports/phase-4-p4-11-implementation.md`。
   */
  const CALENDAR_VIEWS = [["日", "continuous-day-axis"], ["周", "week-calendar-main"], ["月", "month-calendar"]] as const;
  const violationIds = () => page.evaluate(async () => {
    const result = await (window as typeof window & { axe: { run(): Promise<{ violations: Array<{ id: string }> }> } }).axe.run();
    return Array.from(new Set(result.violations.map((violation) => violation.id))).sort();
  });

  for (const theme of ["浅色", "深色"] as const) {
    await sidebar(page).getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("radio", { name: theme }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme === "深色" ? "dark" : "light");
    await page.waitForTimeout(150);
    for (const entry of NAV_ENTRIES) {
      await sidebar(page).getByRole("button", { name: entry, exact: true }).click();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      if (entry !== "日历") {
        expect(await violationIds(), `${theme} · ${entry}`).toEqual([]);
        continue;
      }
      // 视图是**持久化偏好**：上一轮切到「月」之后，这一轮进来还是月视图。
      // 三种形态要分别断言，所以每次都显式切换（日 → 周 → 月）。
      for (const [label, selector] of CALENDAR_VIEWS) {
        await page.getByRole("button", { name: label, exact: true }).click();
        await expect(page.locator(`.${selector}`)).toBeVisible();
        expect(await violationIds(), `${theme} · 日历（${label}）`).toEqual([]);
      }
    }
  }
});

/**
 * P4-11：日历页在**有状态图标、全天标记与时间块**时同样零违规。
 *
 * P4-09 的逐页 axe 用例跑在回顾样本上，日历里没有 `missed` 时段，也就不会渲染
 * `.session-status-icon`。而那张卡片在 960×200% 下每列不足 100px，容器查询会把状态文字
 * 隐藏，于是纯展示的 `<span aria-label>` 触发 `aria-prohibited-attr`（wcag2a／4.1.2）——
 * 名字被丢弃，状态反而彻底读不到。P4-11 删掉了那个多余的 `aria-label`（状态本来就写在
 * 卡片自己的可访问名里），这条用例把「有状态图标」这一态钉住。
 *
 * **本用例不开启「显示实际记录」**：实际记录叠加层（`.calendar-actual-record`）的对比度缺陷
 * 已由 **P4-12** 修掉，并由下面那条专门的用例覆盖（它会显式开启这一项）。这里保持不开启，
 * 是为了让这条用例只回答「状态图标／全天标记／时间块」这一组问题。
 */
function calendarAxeWorkspace() {
  const session = (id: string, taskId: string, date: string, startLocal: string, endLocal: string, status: string) => ({
    id, taskId, localDate: date, endLocalDate: date, startLocal, endLocal, timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status,
  });
  return {
    projects: [{ id: "p-1", title: "毕业设计", deadlineLocal: "2026-08-05" }, { id: "p-2", title: "课程学习", deadlineLocal: "2026-08-20" }],
    projectMilestones: [
      { id: "ms-1", projectId: "p-1", title: "中期答辩", targetLocalDate: "2026-08-05", sortOrder: 0, criterionKind: "taskCount", targetTaskId: null, targetCount: 2, targetProgress: null },
      { id: "ms-2", projectId: "p-2", title: "第一章", targetLocalDate: "2026-08-07", sortOrder: 1, criterionKind: "taskCount", targetTaskId: null, targetCount: 1, targetProgress: null },
    ],
    milestoneOutcomes: [],
    tasks: [
      { id: "t-1", projectId: "p-1", title: "写开题报告", progress: 40, status: "active", deadlineLocal: "2026-08-05", estimatedMinutes: 60, sessionMinutes: 60, priority: "high", sortOrder: 0, kind: "task" },
      { id: "t-2", projectId: "p-1", title: "整理文献", progress: 100, status: "completed", deadlineLocal: null, estimatedMinutes: 45, sessionMinutes: 45, priority: "normal", sortOrder: 1, kind: "task" },
      { id: "t-3", projectId: "p-2", title: "看第一章", progress: 20, status: "active", deadlineLocal: "2026-08-06", estimatedMinutes: 30, sessionMinutes: 30, priority: "normal", sortOrder: 2, kind: "task" },
    ],
    // `missed` 时段会渲染「本次未推进」状态图标 —— 正是 P4-09 的样本缺的那一态。
    executionSessions: [
      session("s-1", "t-1", "2026-08-05", "09:00", "10:30", "scheduled"),
      session("s-2", "t-3", "2026-08-05", "14:00", "15:00", "missed"),
      session("s-3", "t-2", "2026-08-06", "20:00", "21:00", "scheduled"),
    ],
    executionRecords: [], progressEvents: [], recurringHabits: [], habitOccurrences: [], rescuePromptedSessionIds: [],
    timeBlocks: [{ id: "b-1", title: "组会", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "16:00", endLocal: "17:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480 }],
  };
}

test("phase 4 M12 keeps the calendar page clean with session status icons and all-day markers", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-08-05T12:00:00"));
  await page.evaluate((workspace) => {
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify({
      lastPage: "calendar", calendarView: "week",
      calendarAnchors: { day: "2026-08-05", week: "2026-08-05", month: "2026-08-05" },
    }));
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify(workspace));
  }, calendarAxeWorkspace());
  await page.reload();
  await page.setViewportSize({ width: 960, height: 720 });
  await setAppScale(page, 200);
  await page.addScriptTag({ path: path.join(process.cwd(), "node_modules", "axe-core", "axe.min.js") });

  const violationIds = () => page.evaluate(async () => {
    const result = await (window as typeof window & { axe: { run(): Promise<{ violations: Array<{ id: string }> }> } }).axe.run();
    return Array.from(new Set(result.violations.map((violation) => violation.id))).sort();
  });

  for (const theme of ["浅色", "深色"] as const) {
    await sidebar(page).getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("radio", { name: theme }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme === "深色" ? "dark" : "light");
    await page.waitForTimeout(150);
    await sidebar(page).getByRole("button", { name: "日历", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // 状态图标必须真的出现过，否则这条用例是空跑。
    await page.getByRole("button", { name: "周", exact: true }).click();
    await expect(page.locator(".week-calendar-main")).toBeVisible();
    await expect(page.locator(".session-status-icon").first()).toBeVisible();
    for (const [label, selector] of [["日", "continuous-day-axis"], ["周", "week-calendar-main"], ["月", "month-calendar"]] as const) {
      await page.getByRole("button", { name: label, exact: true }).click();
      await expect(page.locator(`.${selector}`)).toBeVisible();
      expect(await violationIds(), `${theme} · 日历（${label}）· 状态图标`).toEqual([]);
    }
  }
});

/**
 * P4-12：实际记录叠加层（`.calendar-actual-record`）的文字对比度。
 *
 * **缺陷**：浅色主题下叠加层用 `color: var(--action-text)`（白字）压在
 * `color-mix(in srgb, var(--accent) 82%, var(--panel))` 这个**被稀释过的**底上 —— 混色后底色是
 * `#da845e`，白字实测对比度 **2.82**（< 4.5:1；字号 23.04px、字重 600，不属于大字号豁免）。
 * `--action-text` 本来是给**实色** `--action` 按钮配的，用在这里是设计 token 配错了对象。
 * 修法与实测见 `docs/reports/phase-4-p4-12-implementation.md`。
 *
 * **本用例显式开启「显示实际记录」**（P4-09 的夹具没开这一项，所以这条缺陷从 AC14 眼里溜过去了），
 * 并且断言顺序是：
 *   1. 叠加层**真的渲染出来了**（夹具里必须真的有已结束的 `executionRecords`）；
 *   2. 它**真的在屏幕上**（`toBeInViewport`，按 IntersectionObserver 算，会扣掉祖先滚动容器的裁剪）；
 *   3. `strong` 的实测对比度（前景 vs 叠加层底色）**≥ 4.5:1** —— 也就是报告里那个 2.82；
 *   4. axe **确实评估过**叠加层（节点进过四个桶之一）；
 *   5. 最后才断言整页零违规。
 *
 * 第 2、4 步一步都不能省。`color-contrast` 是「检查**已渲染且在屏幕上**的元素」的规则：
 *   - 元素没渲染（P4-09 的夹具）→ 规则不跑；
 *   - 元素渲染了但滚出视口 → 规则**同样**不跑，节点连 violations／incomplete／passes／inapplicable
 *     四个桶都不进（P4-12 实测：960×200% 下日视图的可视窗口只有约 3 小时，叠加层默认在窗口外）。
 * 两种情形用例都会**假绿**，这正是 P4-09 漏掉这条缺陷的机制。
 *
 * 第 3 步是必要的补充：叠加层里的文字**经常被 axe 判成 `incomplete`**（「背景色无法确定：被另一个
 * 元素盖住」）—— `incomplete` 既不算通过也不算违规，所以「axe 零违规」并不等于「标题这条真的被量过了」。
 * 直接按 WCAG 公式算一次比值（与 axe 同一套口径）才能确定地钉住报告里的元素。
 *
 * **夹具里的时段都不是「待回顾」**，因此不会渲染 `.review-summary`。这不是为了让用例变绿：
 * 那个元素在 `opacity: .62` 的 `.planned-outline` 卡片（只在开启「显示实际记录」时出现）里
 * 有**另一条独立的**对比度问题（浅色实测 2.48、暗色 3.88），成因是整卡降透明度、而不是本包要修的
 * accent 底色，按本包边界记录在 `docs/reports/phase-4-p4-12-implementation.md`，不在这里顺手改。
 */
function calendarActualRecordWorkspace() {
  const session = (id: string, taskId: string, date: string, startLocal: string, endLocal: string, status: string) => ({
    id, taskId, localDate: date, endLocalDate: date, startLocal, endLocal, timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status,
  });
  /**
   * 记录时间用**本地墙钟**换算成 UTC。叠加层按 `new Date(actualStartUtc)` 的本地时刻落位，
   * 直接写 `…Z` 会让「11:30 那条记录在不在可视窗口里」随跑测机器的时区变化。
   *
   * 长度取 **30 分钟**：配合下面 48px/小时的 `calendarScale`，叠加层正好 24px ≤ 28px，
   * 容器查询把「实际」和时间行隐藏，只剩标题 —— 也就是 P4-11 §7.1 实测到 2.82 的那个
   * **同一个**状态，断言和报告里的元素、字号（23.04px）逐项对得上。
   */
  const at = (date: string, time: string) => new Date(`${date}T${time}:00`).toISOString();
  return {
    ...calendarAxeWorkspace(),
    executionSessions: [
      session("ar-s1", "t-1", "2026-08-05", "11:30", "12:00", "scheduled"),
      session("ar-s2", "t-3", "2026-08-05", "14:00", "15:00", "missed"),
      session("ar-s3", "t-2", "2026-08-06", "20:00", "21:00", "scheduled"),
    ],
    executionRecords: [
      { id: "ar-r1", sessionId: "ar-s1", taskId: "t-1", actualStartUtc: at("2026-08-05", "11:30"), actualEndUtc: at("2026-08-05", "12:00"), note: "" },
    ],
  };
}

test("phase 4 M12 keeps the calendar page clean with the actual-record overlay", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-08-05T12:00:00"));
  await page.evaluate((workspace) => {
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify({
      lastPage: "calendar", calendarView: "week", showActualRecords: true,
      // 48px/小时（与 P4-11 的探针一致）→ 30 分钟的记录 = 24px 高的叠加层，只剩标题那一行。
      calendarScale: { day: 48, week: 48, month: 82 },
      calendarAnchors: { day: "2026-08-05", week: "2026-08-05", month: "2026-08-05" },
    }));
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify(workspace));
  }, calendarActualRecordWorkspace());
  await page.reload();
  await page.setViewportSize({ width: 960, height: 720 });
  await setAppScale(page, 200);
  await page.addScriptTag({ path: path.join(process.cwd(), "node_modules", "axe-core", "axe.min.js") });

  /**
   * 两件事一起看：
   *
   * 1. **axe**：违规 id、以及「叠加层的文字到底有没有被评估过」。`color-contrast` 通过时节点落在
   *    `passes` 里；元素不在屏幕上时它哪个桶都不进。
   * 2. **实测对比度**：直接按 WCAG 的相对亮度公式，用 `getComputedStyle` 解析出来的前景色
   *    （`strong`）与底色（叠加层）算一次比值。为什么不能只靠 axe —— 叠加层里的文字**经常被
   *    axe 判成 `incomplete`**（「背景色无法确定：被另一个元素盖住」），而 `incomplete` 既不是
   *    通过也不是违规。也就是说：axe 说「零违规」并不等于「标题这条真的被量过了」。
   *    这里算出来的比值与 axe 自己的口径完全一致（同一套公式），但不受它的重叠启发式影响，
   *    所以它能**确定地**钉住报告里的那个元素。
   */
  const audit = () => page.evaluate(async () => {
    type AxeRule = { id: string; nodes: Array<{ target: string[] }> };
    const axe = (window as unknown as { axe: { run(): Promise<{ violations: AxeRule[]; incomplete: AxeRule[]; passes: AxeRule[]; inapplicable: AxeRule[] }> } }).axe;
    const outcome = await axe.run();
    const targetsIn = (bucket: AxeRule[]) => bucket
      .filter((entry) => entry.id === "color-contrast")
      .flatMap((entry) => entry.nodes.map((node) => node.target.join(" ")));

    /** 用 canvas 把任意颜色写法（含 `color(srgb …)`）归一成 0–255 三元组。 */
    const toRgb = (color: string) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1; canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("拿不到 2d context");
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b] as [number, number, number];
    };
    const luminance = (rgb: [number, number, number]) => {
      const channel = (value: number) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
    };
    const overlay = document.querySelector(".calendar-actual-record");
    const strong = overlay?.querySelector("strong");
    let contrast: { ratio: number; foreground: string; background: string } | null = null;
    if (overlay && strong) {
      const foreground = getComputedStyle(strong).color;
      const background = getComputedStyle(overlay).backgroundColor;
      const [high, low] = luminance(toRgb(foreground)) > luminance(toRgb(background))
        ? [luminance(toRgb(foreground)), luminance(toRgb(background))]
        : [luminance(toRgb(background)), luminance(toRgb(foreground))];
      contrast = { ratio: (high + 0.05) / (low + 0.05), foreground, background };
    }

    return {
      violationIds: Array.from(new Set(outcome.violations.map((violation) => violation.id))).sort(),
      overlayEvaluated: [
        ...targetsIn(outcome.violations), ...targetsIn(outcome.incomplete),
        ...targetsIn(outcome.passes), ...targetsIn(outcome.inapplicable),
      ].some((target) => target.includes("calendar-actual-record")),
      contrast,
    };
  });

  for (const theme of ["浅色", "深色"] as const) {
    await sidebar(page).getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("radio", { name: theme }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme === "深色" ? "dark" : "light");
    await page.waitForTimeout(150);
    await sidebar(page).getByRole("button", { name: "日历", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    for (const [label, selector] of [["日", "continuous-day-axis"], ["周", "week-calendar-main"], ["月", "month-calendar"]] as const) {
      await page.getByRole("button", { name: label, exact: true }).click();
      await expect(page.locator(`.${selector}`)).toBeVisible();
      const overlay = page.locator(".calendar-actual-record").first();
      if (label === "月") {
        // 月视图**按设计**不渲染实际记录叠加层（工具栏在月视图里根本不显示那个开关），
        // 所以这里没有可测的对比度 —— 断言它确实不存在，免得把「没渲染」误当成「达标」。
        await expect(page.locator(".calendar-actual-record"), `${theme} · 日历（月）· 按设计不渲染叠加层`).toHaveCount(0);
      } else {
        await expect(overlay, `${theme} · 日历（${label}）· 叠加层必须真的渲染出来`).toBeVisible();
        // 滚动容器（日视图约 3 小时高、周视图约 5 小时高）默认停在「现在」附近，记录时间不同
        // 就可能整条落在窗口外。这里显式滚进来，再用 IntersectionObserver 口径的
        // `toBeInViewport` 断言它**真的**在屏幕上 —— 元素不在屏幕上，下面的 axe 断言就是空跑。
        await overlay.scrollIntoViewIfNeeded();
        await expect(overlay, `${theme} · 日历（${label}）· 叠加层必须真的在屏幕上，否则 axe 不会评估它`).toBeInViewport({ ratio: 0.9 });
      }
      const result = await audit();
      if (label !== "月") {
        // 报告里的那条缺陷是 `.calendar-actual-record > strong`（白字压在 `#da845e` 上，2.82）。
        // 这里量的是同一个东西：`strong` 的前景色 vs 叠加层的底色。
        if (!result.contrast) throw new Error(`${theme} · 日历（${label}）· 拿不到叠加层的实测对比度`);
        expect(
          result.contrast.ratio,
          `${theme} · 日历（${label}）· 实际记录标题对比度（前景 ${result.contrast.foreground} / 底色 ${result.contrast.background}）`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(result.overlayEvaluated, `${theme} · 日历（${label}）· axe 必须真的评估过叠加层`).toBe(true);
      }
      expect(result.violationIds, `${theme} · 日历（${label}）· 实际记录叠加层`).toEqual([]);
    }
  }
});

/**
 * P4-13 的日历样本：**同时**有「待回顾」计划卡、实际记录叠加层、时间块与 `missed` 时段。
 *
 * P4-12 的 `calendarActualRecordWorkspace()` 刻意**不含**「待回顾」—— 那一态带着
 * `.planned-outline` 的整卡 `opacity: .62` 缺陷（P4-12 §6.2），当时不修也就不测。
 * P4-13 把它修掉了（换成显式去强调色），所以这一包必须把它测上：夹具里真的有
 * `.pending-review` 与 `.calendar-time-block`，断言才不是空跑（P4-09 的教训）。
 *
 * 时段安排：
 *   - `s-4` 07:00–08:30（t-3，进行中、**没有**执行记录）→ 待回顾 → `.pending-review` + `.planned-outline`
 *   - `s-1` 09:00–10:30（t-1，**有**一条已结束记录）→ 叠加层渲染
 *   - `s-2` 14:00–15:00（`missed`）→ 状态图标
 *   - 时间块 16:00–17:00
 */
function calendarDeemphasisedWorkspace() {
  const at = (date: string, time: string) => new Date(`${date}T${time}:00`).toISOString();
  const base = calendarAxeWorkspace();
  return {
    ...base,
    executionSessions: [
      ...base.executionSessions,
      { id: "s-4", taskId: "t-3", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "07:00", endLocal: "08:30", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
    ],
    executionRecords: [
      { id: "ar-r1", sessionId: "s-1", taskId: "t-1", actualStartUtc: at("2026-08-05", "09:00"), actualEndUtc: at("2026-08-05", "10:30"), note: "" },
    ],
  };
}

/**
 * 把某个元素滚进**吸顶头下方的安全区**（`scrollIntoViewIfNeeded()` 那种「最小滚动」会把它
 * 停在吸顶头底下，近景／axe 都拍不到它）。两个方向都要处理：元素在安全区**上方**就往下滚，
 * 在安全区**下方**（960×200% 下日视图只有约 3 小时窗口，下午的时段经常只露出三分之一）就往上滚。
 *
 * 循环到不动为止：日视图是三日缓冲，滚动可能触发应用自己的重新定位。
 */
async function scrollIntoCalendarSafeArea(page: Page, locator: Locator) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const moved = await locator.evaluate((element) => {
      let scroller = element.parentElement;
      while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
      if (!scroller) return 0;
      const panel = element.closest(".continuous-day-panel");
      const header = scroller.querySelector(".week-sticky-header")
        ?? panel?.querySelector(".calendar-day > header")
        ?? panel?.querySelector(".continuous-day-separator")
        ?? null;
      if (!header || header === element || header.contains(element)) return 0;
      // 960×200% 下整页会比窗口高：只滚内层容器的话，元素仍然落在窗口之外
      // （toBeInViewport 与 axe 都按**窗口**算）。先让浏览器把元素连同所有祖先滚到窗口里。
      const inWindow = element.getBoundingClientRect();
      if (inWindow.top < 0 || inWindow.bottom > window.innerHeight) element.scrollIntoView({ block: "center" });
      const scrollerRect = scroller.getBoundingClientRect();
      const safeTop = Math.max(scrollerRect.top, header.getBoundingClientRect().bottom) + 8;
      const safeBottom = scrollerRect.bottom - 8;
      const rect = element.getBoundingClientRect();
      let delta = 0;
      if (rect.top < safeTop) delta = rect.top - safeTop;
      else if (rect.bottom > safeBottom) delta = Math.min(rect.bottom - safeBottom, rect.top - safeTop);
      if (!delta) return 0;
      scroller.scrollTop += delta;
      return Math.round(delta);
    });
    if (!moved) return;
    await page.waitForTimeout(200);
  }
}

/**
 * 命中测试：**「谁画在最上面」只能这样量**。
 *
 * `toBeVisible()` 查不出遮挡 —— 被盖住的元素照样「可见」。`document.elementFromPoint`
 * 才回答「这一点上最上面的是谁」。
 *
 * ⚠️ 实际记录叠加层平时是 `pointer-events: none`，命中测试会**直接跳过它**（P4-13 实测：
 * 不打开它时 `elementFromPoint` 在药丸中心返回药丸，缺陷明明还在）。所以这里临时把它的
 * `pointer-events` 打开再问一次 —— 只改样式，不动产品代码，也不影响绘制顺序。
 */
const hitTestAtCenterOf = ({ pointSelector, containerSelector, forceOverlayHit }: { pointSelector: string; containerSelector: string; forceOverlayHit: boolean }) => {
  const describe = (element: Element | null) => element
    ? `${element.tagName.toLowerCase()}.${(element.className || "").toString().split(" ").filter(Boolean).join(".")}`
    : null;
  const target = document.querySelector(pointSelector);
  if (!target) return { ok: false, reason: `找不到 ${pointSelector}` };
  const rect = target.getBoundingClientRect();
  const point = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  const overlay = document.querySelector<HTMLElement>(".calendar-actual-record");
  const restore = overlay ? overlay.style.pointerEvents : null;
  if (overlay && forceOverlayHit) overlay.style.pointerEvents = "auto";
  const hit = document.elementFromPoint(point.x, point.y);
  const stack = document.elementsFromPoint(point.x, point.y).slice(0, 5).map(describe);
  if (overlay && restore !== null) overlay.style.pointerEvents = restore;
  const container = document.querySelector(containerSelector);
  return {
    ok: true, point, inViewport: point.y >= 0 && point.y <= window.innerHeight,
    hit: describe(hit), container: describe(container),
    inside: Boolean(container && hit && container.contains(hit)), stack,
  };
};

/** 逐元素量对比度：把「祖先整卡 opacity」也算进来（只读 `color` 会假绿，见 P4-12 §6.2）。 */
const measureCalendarContrast = (targets: Array<{ label: string; selector: string }>) => {
  const toRgba = (color: string) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "#000000";
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  };
  const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
    const channel = (value: number) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const over = (front: { r: number; g: number; b: number }, back: { r: number; g: number; b: number }, alpha: number) => ({
    r: front.r * alpha + back.r * (1 - alpha),
    g: front.g * alpha + back.g * (1 - alpha),
    b: front.b * alpha + back.b * (1 - alpha),
  });
  return targets.map(({ label, selector }) => {
    const element = document.querySelector(selector);
    if (!element) return { label, selector, found: false, opacity: 1, ratio: 0, threshold: 0, fontSize: "", fontWeight: "" };
    const style = getComputedStyle(element);
    // 文字所在的那一层不透明底（最近的卡片）与路径上的 opacity 乘积
    let opacity = Number(style.opacity);
    let surface: { r: number; g: number; b: number } | null = null;
    for (let node = element.parentElement; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity);
      if (surface === null) {
        const background = toRgba(getComputedStyle(node).backgroundColor);
        if (background.a > 0.95) surface = background;
      }
    }
    // 卡片背后的底（找不到就当白底）
    let backdrop = { r: 255, g: 255, b: 255 };
    let cursor = element.parentElement;
    while (cursor && toRgba(getComputedStyle(cursor).backgroundColor).a <= 0.95) cursor = cursor.parentElement;
    for (cursor = cursor?.parentElement ?? null; cursor; cursor = cursor.parentElement) {
      const background = toRgba(getComputedStyle(cursor).backgroundColor);
      if (background.a > 0.95) { backdrop = background; break; }
    }
    if (!surface) surface = backdrop;
    const textColor = toRgba(style.color);
    const textInGroup = textColor.a < 1 ? over(textColor, surface, textColor.a) : textColor;
    const surfaceRendered = over(surface, backdrop, opacity);
    const textRendered = over(textInGroup, backdrop, opacity);
    const [high, low] = luminance(textRendered) > luminance(surfaceRendered)
      ? [luminance(textRendered), luminance(surfaceRendered)]
      : [luminance(surfaceRendered), luminance(textRendered)];
    const size = Number.parseFloat(style.fontSize);
    const weight = Number(style.fontWeight);
    const largeText = size >= 24 || (size >= 18.66 && weight >= 700);
    return {
      label, selector, found: true, opacity,
      ratio: Math.round(((high + 0.05) / (low + 0.05)) * 1000) / 1000,
      threshold: largeText ? 3 : 4.5,
      fontSize: style.fontSize, fontWeight: style.fontWeight,
    };
  });
};

/** 这一包改到的每一处配色；`mustExist` 的那几条在对应视图／轮次里必须真的渲染出来。 */
const CALENDAR_CONTRAST_TARGETS = [
  { label: "实际记录叠加层 · 标题", selector: ".calendar-actual-record strong", mustExist: true },
  { label: "待回顾计划卡 · 标题", selector: ".calendar-session.pending-review strong", mustExist: true },
  { label: "待回顾计划卡 · 起止时间", selector: ".calendar-session.pending-review .session-time", mustExist: false },
  { label: "待回顾计划卡 · 状态标签", selector: ".calendar-session.pending-review .session-review-trigger > span", mustExist: false },
  { label: "待回顾计划卡 · 进度值", selector: ".calendar-session.pending-review .session-progress-value", mustExist: false },
  { label: "待回顾计划卡 · 回顾摘要", selector: ".calendar-session.pending-review .review-summary", mustExist: false },
  { label: "时间块 · 起止时间", selector: ".calendar-time-block time", mustExist: false },
] as const;

/**
 * P4-13 §1：**吸顶日期头不能被轨道内容盖住**。
 *
 * 缺陷（用户报的「实际记录盖住『今天』药丸」，2026-09-02 `54c621b` 起就有）：日视图的
 * `.calendar-day > header` 是 `z-index: 4`，而轨道里的内容从 5 一路排到 10
 * （当前安排 5／待回顾 6／实际记录 7／当前时间线 8／折叠区间 9／展开按钮 10）—— 4 被全体压住。
 * 周视图的吸顶头是 12 所以没事，只有日视图那一档给低了。
 *
 * 判据必须是**命中测试**：`toBeVisible()` 查不出遮挡。日视图与周视图各覆盖
 * 「有叠加层／无叠加层」两种状态；月视图没有吸顶头（表头是普通网格行），只做一次
 * 「表头行仍可命中」的冒烟断言。
 */
test("phase 4 M13 keeps the sticky calendar headers above the track content", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-08-05T12:00:00"));
  await page.evaluate((workspace) => {
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify({
      lastPage: "calendar", calendarView: "day", showActualRecords: true,
      calendarScale: { day: 48, week: 48, month: 82 },
      calendarAnchors: { day: "2026-08-05", week: "2026-08-05", month: "2026-08-05" },
    }));
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify(workspace));
  }, calendarDeemphasisedWorkspace());
  await page.reload();
  await page.setViewportSize({ width: 1200, height: 800 });

  for (const scale of [100, 200] as const) {
    await setAppScale(page, scale);
    await sidebar(page).getByRole("button", { name: "日历", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // ---- 日视图：09:00 那一段（有计划、也有实际记录）滚到吸顶日期头底下 ----
    await page.getByRole("button", { name: "日", exact: true }).click();
    await expect(page.locator(".continuous-day-axis")).toBeVisible();
    const daySession = page.locator('.calendar-day.today .calendar-session[data-session-id="s-1"]');
    await expect(daySession, `${scale}% · 日视图 · 夹具里 09:00 那一段必须真的渲染出来`).toBeVisible();
    // 让叠加层与卡片都压在吸顶头部带里（头部带在滚动容器顶部往下 40–92px）
    await page.locator(".continuous-day-axis").evaluate((scroller) => { scroller.scrollTop = 0; });
    await scrollIntoCalendarSafeArea(page, page.locator(".calendar-actual-record").first());
    await page.locator(".continuous-day-axis").evaluate((scroller) => {
      const overlay = document.querySelector(".calendar-actual-record");
      if (!overlay) return;
      const scrollerRect = scroller.getBoundingClientRect();
      scroller.scrollTop += (overlay.getBoundingClientRect().top - scrollerRect.top) - 50;
    });
    await page.waitForTimeout(400);

    for (const state of ["有叠加层", "无叠加层"] as const) {
      if (state === "无叠加层") {
        await page.getByRole("checkbox", { name: "显示实际记录" }).uncheck();
        await page.waitForTimeout(400);
      }
      for (const forceOverlayHit of [false, true]) {
        const result = await page.evaluate(hitTestAtCenterOf, {
          pointSelector: ".calendar-day.today .today-number", containerSelector: ".calendar-day.today > header", forceOverlayHit,
        });
        const hint = `${scale}% · 日视图 · ${state}${forceOverlayHit ? "（叠加层 pointer-events 临时打开）" : ""}`;
        expect(result.ok, `${hint} · 找不到「今天」药丸：${result.reason ?? ""}`).toBe(true);
        expect(result.inViewport, `${hint} · 药丸中心必须落在视口里`).toBe(true);
        expect(result.inside, `${hint} · 药丸中心命中的是 ${result.hit}，而不是日期头 ${result.container}；堆叠顺序 ${JSON.stringify(result.stack)}`).toBe(true);
      }
    }
    await page.getByRole("checkbox", { name: "显示实际记录" }).check();
    await page.waitForTimeout(300);

    // ---- 周视图：09:00 那一段滚到周吸顶头底下 ----
    await page.getByRole("button", { name: "周", exact: true }).click();
    await expect(page.locator(".week-calendar-main")).toBeVisible();
    await page.locator(".calendar-viewport").evaluate((scroller) => {
      const card = document.querySelector(".calendar-session");
      if (!card) return;
      scroller.scrollTop += (card.getBoundingClientRect().top - scroller.getBoundingClientRect().top) - 20;
    });
    await page.waitForTimeout(400);
    const weekResult = await page.evaluate(hitTestAtCenterOf, {
      pointSelector: ".week-sticky-header .week-date-headers button", containerSelector: ".week-sticky-header", forceOverlayHit: true,
    });
    expect(weekResult.ok, `${scale}% · 周视图 · 找不到吸顶头里的日期按钮`).toBe(true);
    expect(weekResult.inViewport, `${scale}% · 周视图 · 日期按钮中心必须落在视口里`).toBe(true);
    expect(weekResult.inside, `${scale}% · 周视图 · 日期按钮中心命中的是 ${weekResult.hit}，而不是吸顶头；堆叠顺序 ${JSON.stringify(weekResult.stack)}`).toBe(true);

    // ---- 月视图：没有吸顶头（表头是普通网格行），只断言表头行仍可命中 ----
    await page.getByRole("button", { name: "月", exact: true }).click();
    await expect(page.locator(".month-calendar")).toBeVisible();
    const monthResult = await page.evaluate(hitTestAtCenterOf, {
      pointSelector: '.month-calendar [role="columnheader"]', containerSelector: ".month-calendar", forceOverlayHit: false,
    });
    expect(monthResult.ok, `${scale}% · 月视图 · 找不到表头行`).toBe(true);
    expect(monthResult.inside, `${scale}% · 月视图 · 表头行被 ${monthResult.hit} 盖住了；堆叠顺序 ${JSON.stringify(monthResult.stack)}`).toBe(true);
  }
});

/**
 * P4-13 §2／§3／§4／§5：开启「显示实际记录」后，日历页在 960×200% 的浅／深两色下零违规，
 * 并且这一包改到的**每一处**配色都给出实测比值。
 *
 * 与 P4-12 那条 `actual-record overlay` 用例的关系：那条只盯叠加层（夹具刻意不含「待回顾」，
 * 因为当时 `.planned-outline` 的整卡 `opacity: .62` 是另一条独立缺陷）。P4-13 把它修掉了，
 * 于是这条用例的夹具里**真的有** `.pending-review` 与 `.calendar-time-block`。
 *
 * 两条硬约束（§10 与 P4-12 §3）在这里都照做：
 *   ① `color-contrast` 只评估**已渲染且在屏幕上**的元素 —— 每一轮都先断言这一轮的焦点元素
 *      `toBeVisible()` + `toBeInViewport()`，再跑 axe；否则「零违规」可能只是「没看过」。
 *   ② 元素**没渲染**（夹具太穷）时规则同样不跑 —— 所以夹具里必须有待回顾时段、时间块与
 *      `missed` 时段（P4-09 的教训）。
 * 另外每一轮都按 WCAG 公式自己算一次比值（axe 常把叠加层里的文字判成 `incomplete`：
 * 「背景色无法确定，被别的元素盖住」—— `incomplete` 既不是通过也不是违规）。
 *
 * **第二轮起是「滚到有内容的时段」**：P4-12 §6.1 记着「axe 不评估屏幕外的元素」，
 * 而 960×200% 下日视图的可视窗口只有约 3 小时 —— 不加滚动轮，日历下半天的状态永远不会
 * 被检查。月视图同样滚到底部再跑一次（6 行日期在 200% 下远超视口）。
 */
test("phase 4 M13 keeps the calendar page clean with the de-emphasised plan, the actual record and the time block", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-08-05T12:00:00"));
  await page.evaluate((workspace) => {
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify({
      lastPage: "calendar", calendarView: "week", showActualRecords: true,
      calendarScale: { day: 48, week: 48, month: 82 },
      calendarAnchors: { day: "2026-08-05", week: "2026-08-05", month: "2026-08-05" },
    }));
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify(workspace));
  }, calendarDeemphasisedWorkspace());
  await page.reload();
  await page.setViewportSize({ width: 960, height: 720 });
  await setAppScale(page, 200);
  await page.addScriptTag({ path: path.join(process.cwd(), "node_modules", "axe-core", "axe.min.js") });

  const axeAudit = () => page.evaluate(async () => {
    type AxeRule = { id: string; nodes: Array<{ target: string[] }> };
    const outcome = await (window as unknown as { axe: { run(): Promise<{ violations: AxeRule[]; incomplete: AxeRule[]; passes: AxeRule[]; inapplicable: AxeRule[] }> } }).axe.run();
    const targetsIn = (bucket: AxeRule[]) => bucket
      .filter((entry) => entry.id === "color-contrast")
      .flatMap((entry) => entry.nodes.map((node) => node.target.join(" ")));
    const seen = [
      ...targetsIn(outcome.violations), ...targetsIn(outcome.incomplete),
      ...targetsIn(outcome.passes), ...targetsIn(outcome.inapplicable),
    ];
    return {
      violationIds: Array.from(new Set(outcome.violations.map((violation) => violation.id))).sort(),
      overlayEvaluated: seen.some((target) => target.includes("calendar-actual-record")),
      planEvaluated: seen.some((target) => target.includes("pending-review")),
      timeBlockEvaluated: seen.some((target) => target.includes("calendar-time-block")),
    };
  });

  const VIEWS = [
    { label: "日", selector: ".continuous-day-axis" },
    { label: "周", selector: ".week-calendar-main" },
    { label: "月", selector: ".month-calendar" },
  ] as const;
  /**
   * 每一轮都**先滚到一段有内容的时段**再断言：960×200% 下日视图只有约 3 小时的可视窗口，
   * 「初始位置」本身就会漏掉大半天。日／周的每一轮都用 `scrollBelowStickyHeader` 把焦点元素
   * 放到吸顶头下方的安全区（`scrollIntoViewIfNeeded` 那种最小滚动会把它停在吸顶头底下）；
   * 月视图没有吸顶头，直接滚到底部。
   */
  const ROUNDS = {
    日: [
      { label: "滚到 14:00（未推进 + 现在线）", focus: ".calendar-session.missed", evaluated: [] },
      { label: "滚到 07:00（计划卡 + 实际记录）", focus: ".calendar-session.pending-review", evaluated: ["overlay", "plan"] },
      { label: "滚到 16:00（时间块）", focus: ".calendar-time-block", evaluated: ["timeBlock"] },
    ],
    周: [
      { label: "滚到 16:00（时间块）", focus: ".calendar-time-block", evaluated: ["timeBlock"] },
      { label: "滚到 07:00（计划卡 + 实际记录）", focus: ".calendar-session.pending-review", evaluated: ["overlay", "plan"] },
    ],
    月: [
      { label: "初始位置（上半月）", focus: '.month-calendar [role="gridcell"]', evaluated: [] },
      { label: "滚到底部（下半月）", focus: '.month-calendar [role="gridcell"]', evaluated: [] },
    ],
  } as const;

  for (const theme of ["浅色", "深色"] as const) {
    await sidebar(page).getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("radio", { name: theme }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme === "深色" ? "dark" : "light");
    await sidebar(page).getByRole("button", { name: "日历", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    for (const view of VIEWS) {
      // 视图是持久化偏好：每次都要显式切回去。
      await page.getByRole("button", { name: view.label, exact: true }).click();
      await expect(page.locator(`.${view.selector.slice(1)}`)).toBeVisible();
      await page.waitForTimeout(200);

      for (const [index, round] of ROUNDS[view.label].entries()) {
        const hint = `${theme} · 日历（${view.label}）· ${round.label}`;
        if (view.label === "月") {
          if (index > 0) await page.locator(".calendar-viewport").evaluate((scroller) => {
            scroller.scrollTop = scroller.scrollHeight;
            // 200% 下整页比窗口高：容器本身也要挪进窗口，否则格子仍在窗口外。
            scroller.scrollIntoView({ block: "nearest" });
          });
        } else {
          const focus = page.locator(round.focus).first();
          await expect(focus, `${hint} · 这一轮的焦点元素必须存在`).toBeVisible();
          await scrollIntoCalendarSafeArea(page, focus);
        }
        await page.waitForTimeout(300);
        // 硬约束 ①：先证明这一轮真的把内容放进了屏幕，再谈「零违规」。
        // 月视图滚到底部那一轮要看的是**最后一行**的格子（`first()` 在上半月的第 1 行）。
        const focus = view.label === "月" && index > 0 ? page.locator(round.focus).last() : page.locator(round.focus).first();
        await expect(focus, `${hint} · 焦点元素必须真的渲染出来`).toBeVisible();
        await expect(focus, `${hint} · 焦点元素必须在屏幕上，否则 axe 根本不会评估它`).toBeInViewport({ ratio: 0.5 });
        // 要断言「axe 评估过叠加层」，就得先让它进屏幕：叠加层和焦点卡不在同一列时，
        // 只滚焦点卡是够不到它的。放在焦点断言**之后**，免得这次滚动把焦点卡顶出去。
        if ((round.evaluated as readonly string[]).includes("overlay")) {
          const overlay = page.locator(".calendar-actual-record").first();
          if (await overlay.count()) {
            await scrollIntoCalendarSafeArea(page, overlay);
            await page.waitForTimeout(200);
          }
        }

        const rows = await page.evaluate(measureCalendarContrast, CALENDAR_CONTRAST_TARGETS.map((target) => ({ label: target.label, selector: target.selector })));
        for (const row of rows) {
          if (!row.found) continue;
          expect(row.ratio, `${hint} · ${row.label}（opacity×${Math.round(row.opacity * 1000) / 1000}，${row.fontSize}/${row.fontWeight}）`)
            .toBeGreaterThanOrEqual(row.threshold);
        }
        const audited = await axeAudit();
        // 只断言这一轮**真的把元素放进了屏幕**的那几项：「零违规」不等于「量过了」，
        // 反过来也不该要求 axe 评估屏幕外的元素（它本来就看不见）。
        if ((round.evaluated as readonly string[]).includes("overlay")) {
          expect(audited.overlayEvaluated, `${hint} · axe 必须真的评估过实际记录叠加层`).toBe(true);
        }
        if ((round.evaluated as readonly string[]).includes("plan")) {
          expect(audited.planEvaluated, `${hint} · axe 必须真的评估过待回顾计划卡`).toBe(true);
        }
        if ((round.evaluated as readonly string[]).includes("timeBlock")) {
          expect(audited.timeBlockEvaluated, `${hint} · axe 必须真的评估过时间块`).toBe(true);
        }
        expect(audited.violationIds, `${hint} · 开启「显示实际记录」后的日历页`).toEqual([]);
      }
    }
  }
});
