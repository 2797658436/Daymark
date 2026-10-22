import { expect, test } from "@playwright/test";

/**
 * 回顾页的极端用例（2026-10-20）。
 *
 * 背景：标题由用户自己写，可以长到没有空格（URL、英文长串），任务与项目数量也没有上限。
 * 之前 `.review-tasks` 的隐式 auto 轨道会被「无空格长标题」的 min-content 顶宽，
 * 200% 缩放下整页横向滚动 900 多像素；日视图左栏还会被长任务列表拉成一张空白巨卡。
 *
 * 这里守两条**用眼睛才看得出来**的规矩：
 * 1. 任何长度、任何缩放下 `#main-content` 都不产生横向滚动；
 * 2. 被截断的名字都带 `title`（悬停能看到完整文本），而不是被静默裁掉。
 */

const TODAY = "2026-10-20";
const LONG_CN = "把整个数据平台从单体架构迁移到微服务并保证迁移期间零停机同时补齐监控告警与回滚预案";
const LONG_NO_SPACE = "SupercalifragilisticexpialidociousProjectWithoutAnySpacesAtAll0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LONG_URL = "https://example.com/a/very/long/path/that/never/breaks/anywhere/at/all?query=abcdefghijklmnopqrstuvwxyz0123456789&another=parameter";

function at(date: string, time: string) {
  return new Date(`${date}T${time}:00`).toISOString();
}

/** 一个「什么都不友好」的工作区：无空格长串、超长中文、emoji、URL、超长备注。 */
function extremesWorkspace() {
  const titles = [LONG_CN, LONG_NO_SPACE, LONG_URL, "🎯 目标冲刺：每天三小时深度工作不掉链子，周末也要复盘一次 ✨", "短", "a"];
  const projects = titles.map((title, index) => ({ id: `xp-${index}`, title, deadlineLocal: index === 0 ? "2026-10-29" : null }));
  const tasks = titles.map((title, index) => ({
    id: `xt-${index}`, projectId: `xp-${index}`, title,
    progress: 10 + index * 10, status: "active", deadlineLocal: null,
    estimatedMinutes: 60, sessionMinutes: null, priority: "normal", sortOrder: index, kind: "task",
  }));
  return {
    projects,
    projectMilestones: [{
      id: "xm-1", projectId: "xp-0", title: `${LONG_CN}的第一个阶段里程碑`,
      targetLocalDate: "2026-10-19", sortOrder: 0,
      criterionKind: "taskCount", targetTaskId: null, targetCount: 3, targetProgress: null,
    }],
    milestoneOutcomes: [{
      id: "xo-1", milestoneId: "xm-1", projectId: "xp-0", title: `${LONG_CN}的第一个阶段里程碑`,
      targetLocalDate: "2026-10-19", reached: false,
      resultText: "完成 1/3，还差两项：把回滚预案演练一次，并且把演练结果写进迁移手册的附录里，让值班同学照着做就行",
      frozenAtUtc: at("2026-10-19", "00:00"),
    }],
    tasks,
    executionSessions: [],
    executionRecords: tasks.map((task, index) => ({
      id: `xr-${index}`, sessionId: null, taskId: task.id,
      actualStartUtc: at("2026-10-19", "09:00"), actualEndUtc: at("2026-10-19", "10:30"),
      note: index === 0
        ? "这一段备注写得很长，用来确认备注换行时不会把日期列挤窄，也不会把气泡顶出视口，所以这里故意写了很多很多很多很多很多很多很多很多很多很多很多字。"
        : "",
    })),
    progressEvents: tasks.map((task, index) => ({
      id: `xe-${index}`, taskId: task.id, fromProgress: 10, toProgress: 10 + index * 10,
      occurredAtUtc: at("2026-10-19", "10:00"),
    })),
    timeBlocks: [], recurringHabits: [], habitOccurrences: [], rescuePromptedSessionIds: [],
  };
}

const PREFERENCES = {
  appearance: "light", motion: "full", scale: 100, lastPage: "review",
  calendarView: "week", calendarAnchors: { day: TODAY, week: TODAY, month: TODAY },
  calendarZoom: { day: "standard", week: "standard", month: "standard" },
  calendarScale: { day: 72, week: 72, month: 120 }, calendarPositions: { day: null, week: null },
  calendarDayMode: "fullDay", showActualRecords: false, showActualRecordsControl: true, taskPoolWidth: 320,
  snapMinutes: 15, defaultSessionMinutes: 60, minimumSessionMinutes: 15, autoScheduleAssist: false,
  checkInEnabled: false, checkInGraceMinutes: 5, rescuePromptsEnabled: true, remindersEnabled: false,
  reminderLeadMinutes: 10, startupSummary: "never", lastStartupSummaryLocalDate: null,
  reviewPeriod: "week", reviewAnchorDate: null, defaultTimeSlots: [],
};

async function seed(page: import("@playwright/test").Page, patch: Record<string, unknown>) {
  await page.goto("/");
  await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00`));
  await page.evaluate(({ workspace, prefs }) => {
    localStorage.clear();
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify(workspace));
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify(prefs));
  }, { workspace: extremesWorkspace(), prefs: { ...PREFERENCES, ...patch } });
  await page.reload();
  await expect(page.locator(".review-page")).toBeVisible();
}

/** 主内容区不许横向滚动：横向滚动说明有东西把页面顶宽了（用户只能左右拖着看）。 */
async function expectNoHorizontalScroll(page: import("@playwright/test").Page) {
  const overflow = await page.locator("#main-content").evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test("review page survives extreme titles at 200% scale without horizontal scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 760 });
  await seed(page, { scale: 200 });
  await expect(page.getByRole("heading", { name: "10月19日 — 10月25日", level: 1 })).toBeVisible();
  await expectNoHorizontalScroll(page);

  // 任务区的每一处截断都要能悬停看全文：项目卡头、任务行、投入去向图例。
  const groupTitles = page.locator(".review-task-group-head h3 .review-inline-link");
  expect(await groupTitles.count()).toBeGreaterThan(0);
  for (const title of await groupTitles.all()) {
    const text = (await title.textContent()) ?? "";
    expect(await title.getAttribute("title")).toBe(text);
  }
  const rowTitles = page.locator(".review-detail-title .review-inline-link");
  expect(await rowTitles.count()).toBeGreaterThan(0);
  for (const title of await rowTitles.all()) {
    const text = (await title.textContent()) ?? "";
    expect(await title.getAttribute("title")).toBe(text);
  }
  const legendNames = page.locator(".review-split-name");
  expect(await legendNames.count()).toBeGreaterThan(0);
  for (const name of await legendNames.all()) {
    expect(await name.getAttribute("title")).not.toBeNull();
  }

  // 下钻气泡：标题同样限行 + 带完整文本，并且不把页面顶宽。
  await page.locator(".review-detail-title .review-inline-link").first().click();
  const panel = page.locator(".review-detail-panel");
  await expect(panel).toBeVisible();
  const heading = panel.locator("#review-detail-title");
  expect(await heading.getAttribute("title")).toBe(await heading.textContent());
  await expectNoHorizontalScroll(page);
  const box = await panel.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(961);
});

test("a single project with many long tasks keeps the day-view split card compact", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 760 });
  await seed(page, { scale: 100, reviewPeriod: "day", reviewAnchorDate: "2026-10-19" });
  await expectNoHorizontalScroll(page);

  // 日视图的左栏（投入去向）按内容定高：不能被右边几十行任务拉成一张空白巨卡。
  const split = page.locator(".review-tasks-body > .review-split");
  const tasks = page.locator(".review-tasks-body .review-task-main");
  await expect(split).toBeVisible();
  const splitBox = (await split.boundingBox())!;
  const tasksBox = (await tasks.boundingBox())!;
  expect(splitBox.height).toBeLessThan(tasksBox.height);
  expect(splitBox.height).toBeLessThan(760);
});
