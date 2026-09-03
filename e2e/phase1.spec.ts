import { expect, test } from "@playwright/test";
import path from "node:path";

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
  await card.locator(".task-row-top").dragTo(futureDay, { targetPosition: { x: 30, y: 500 } });
  await expect(futureDay.locator(".calendar-session", { hasText: "写阶段总结" })).toHaveCount(1);
  await expect(card).toContainText("共 1 次");
  await expect(page.getByRole("button", { name: /撤销安排/ })).toBeVisible();

  await page.keyboard.press("Control+z");
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
  await task.locator(".task-row-top").dragTo(firstDay, { targetPosition: { x: 30, y: 400 } });
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
  await page.getByRole("button", { name: "应用全部" }).click();
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
  await page.getByRole("button", { name: "7 天回顾" }).click();
  await expect(page.getByRole("heading", { name: "最近 7 天回顾" })).toBeVisible();
});

test("running execution ends with a manual progress summary and remains after reload", async ({ page }) => {
  const now = new Date();
  const today = localDate(now);
  const start = new Date(now.getTime() - 60_000).toISOString();
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
  const dark = await page.evaluate(async () => (await (window as typeof window & { axe: { run(): Promise<{ violations: unknown[] }> } }).axe.run()).violations);
  expect(dark).toEqual([]);
});

test("200 percent scaling keeps data actions visible and persists after reload", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByLabel(/界面缩放/).fill("200");
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

test("phase 3 calendar anchors survive reload and the day axis changes date only at midnight", async ({ page }) => {
  await page.getByRole("textbox", { name: "任务标题" }).fill("跨日安排");
  await page.getByRole("button", { name: "创建任务" }).click();
  await page.getByRole("button", { name: "日历", exact: true }).click();
  const period = page.getByLabel("当前日历日期");
  await page.getByRole("button", { name: "下一段日期" }).click();
  const futureWeek = await period.textContent();
  await page.getByRole("button", { name: "紧凑" }).click();
  await page.getByRole("button", { name: "月", exact: true }).click();
  await page.getByRole("button", { name: "下一段日期" }).click();
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
  await page.locator(".task-card", { hasText: "跨日安排" }).locator(".task-row-top").dragTo(currentTrack, { targetPosition: { x: 30, y: 500 } });
  await expect(currentTrack.locator(".calendar-session", { hasText: "跨日安排" })).toHaveCount(1);
});

test("phase 3 M2 keeps planned and actual time separate and returns to the live time", async ({ page }) => {
  await page.evaluate(() => {
    const now = new Date();
    const today = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
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
      executionRecords: [{ id: "record-m2", sessionId: "session-m2", taskId: "task-m2", actualStartUtc: new Date(now.getTime() - 20 * 60_000).toISOString(), actualEndUtc: new Date(now.getTime() - 5 * 60_000).toISOString(), note: "" }],
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
  await compactReview.hover();
  for (const name of ["更新进度", "继续安排", "本次未推进"]) {
    const action = page.getByRole("button", { name });
    await expect(action).toBeVisible();
    expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(43.9);
  }

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
  await calendar.evaluate((element) => { element.scrollTop = 52 + 12 * 48 - element.clientHeight / 2; });
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

  await dropped.scrollIntoViewIfNeeded();
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
  await expect(cell).toContainText("M6 截止 2"); await expect(cell).toContainText("另外 2 项");
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
  const track = page.getByRole("gridcell", { name: "2026-08-12 09:00 空白时间" }); await track.focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "空白时段操作" })).toContainText("09:15–09:45");
});

function localDate(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}
