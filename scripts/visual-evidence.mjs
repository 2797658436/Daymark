#!/usr/bin/env node
/**
 * 阶段 4 P4-09 的**视觉证据**（规格 §11 末段 / AC14）。
 *
 * 规格要求截图至少覆盖：气泡上下边缘、长课程、截止空／满状态、三种回顾、
 * 设置保存错误、恢复确认；并且「浅／深色 × 100／150／200% × 960／1200 宽度」
 * 的核心路径都要有视觉检查（axe 是自动那半，这个脚本是人工那半）。
 *
 * 三条硬约束与 `measure-perf.mjs` 一致：
 *   - **生产构建**：脚本自己 `npm run build` 后起 `vite preview`（默认 4175），不用 dev server。
 *   - **可复现**：全部场景由脚本内置的固定数据构造，固定时钟（2026-08-05T12:00），
 *     不依赖真实数据库或系统日期。
 *   - **只读边界**：样本只写浏览器 `localStorage`，不碰 SQLite／Tauri。
 *
 * 产出默认落在 `output/visual-p4-09/`（`output/` 是 gitignored 的交付目录，不会被
 * Playwright 的 `test-results/` 清理带走），文件名与规格里的六类一一对应。
 * 用 `--out <dir>` 可以换目录 —— P4-11 就是靠它把日历页的改前／改后截图分开落盘
 * （`--only calendar --out output/visual-p4-11-before` 与 `…-after`）。
 *
 * 用法：
 *   node scripts/visual-evidence.mjs                 # 全套
 *   node scripts/visual-evidence.mjs --skip-build    # 复用已有 dist/
 *   node scripts/visual-evidence.mjs --only review   # 只跑名字含 review 的场景
 *   node scripts/visual-evidence.mjs --only calendar --out output/visual-p4-11-after
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "@playwright/test";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const viteEntry = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const defaultOutputDirectory = join(projectRoot, "output", "visual-p4-09");
let outputDirectory = defaultOutputDirectory;
const preferencesKey = "daymark.phase0.preferences";
const workspaceKey = "daymark.phase1.workspace";

const DEFAULTS = { port: 4175, skipBuild: false, headed: false, only: null, out: defaultOutputDirectory };

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (key === "skip-build") { args.skipBuild = true; continue; }
    if (key === "headed") { args.headed = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) continue;
    i += 1;
    if (key === "port") args.port = Number(value);
    else if (key === "only") args.only = value;
    else if (key === "out") args.out = value;
    else throw new Error(`未知参数 --${key}`);
  }
  return args;
}

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: projectRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`))));
  });
}

async function startPreview(port) {
  const server = spawn(process.execPath, [viteEntry, "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: projectRoot, stdio: ["ignore", "ignore", "inherit"],
  });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return server;
    } catch {
      // still starting
    }
    await delay(250);
  }
  server.kill();
  throw new Error(`vite preview 未能在 20 秒内监听 ${port}`);
}

// ---------------------------------------------------------------- 固定样本

function workspace(overrides = {}) {
  return {
    projects: [], projectMilestones: [], milestoneOutcomes: [], tasks: [], executionSessions: [],
    executionRecords: [], progressEvents: [], timeBlocks: [], recurringHabits: [], habitOccurrences: [],
    rescuePromptedSessionIds: [], ...overrides,
  };
}

const ANCHOR_DAY = "2026-08-05";
const anchorAt = (date, time) => new Date(`${date}T${time}:00`).toISOString();

/** 长课程：一个项目 200 个分 P，前 40 讲已完成、46 讲有进度事件，用来同时验证「长列表」与「最近推进」。 */
function longCourseWorkspace() {
  const flavour = ["起步", "所有权", "生命周期", "错误处理", "并发", "泛型", "trait", "宏"];
  const parts = Array.from({ length: 200 }, (_, index) => {
    const completed = index < 40;
    const started = index >= 40 && index < 46;
    return {
      id: `part-${String(index + 1).padStart(3, "0")}`, projectId: "course-1",
      title: `P${index + 1} ${flavour[index % flavour.length]}`,
      progress: completed ? 100 : started ? 40 : 0,
      status: completed ? "completed" : "active",
      deadlineLocal: null, estimatedMinutes: 25, sessionMinutes: 25, priority: "normal", sortOrder: index, kind: "task",
    };
  });
  return workspace({
    projects: [{ id: "course-1", title: "Rust 系统编程（200 讲）", deadlineLocal: "2026-12-31" }],
    tasks: parts,
    progressEvents: parts.slice(40, 46).map((part, index) => ({
      id: `course-event-${index}`, taskId: part.id, fromProgress: 0, toProgress: 40,
      occurredAtUtc: anchorAt("2026-08-04", `${String(9 + index).padStart(2, "0")}:00`),
    })),
  });
}

/** 截止事项「满状态」：四个分组都有内容，并且列表高度超过视口（滚动位置才有意义）。 */
function deadlinesWorkspace() {
  const dated = (id, day, sortOrder) => ({
    id, projectId: null, title: `截止任务 ${id.slice(-2)}`, progress: 0, status: "active",
    deadlineLocal: day, estimatedMinutes: 60, sessionMinutes: 60, priority: "normal", sortOrder, kind: "task",
  });
  return workspace({
    projects: [{ id: "p-1", title: "学习项目", deadlineLocal: "2026-08-20" }],
    tasks: [
      dated("t-01", "2026-08-01", 0), dated("t-02", "2026-08-02", 1), dated("t-03", ANCHOR_DAY, 2),
      dated("t-04", ANCHOR_DAY, 3), dated("t-05", ANCHOR_DAY, 4), dated("t-06", "2026-08-06", 5),
      dated("t-07", "2026-08-07", 6), dated("t-08", "2026-08-08", 7), dated("t-09", "2026-08-11", 8),
      dated("t-10", "2026-08-12", 9), dated("t-11", "2026-08-20", 10), dated("t-12", "2026-09-01", 11),
      dated("t-13", "2026-09-04", 12), dated("t-14", "2026-09-08", 13),
      { id: "t-done", projectId: "p-1", title: "项目内已完成任务", progress: 100, status: "completed", deadlineLocal: null, estimatedMinutes: 60, priority: "normal", sortOrder: 14, kind: "task" },
    ],
    projectMilestones: [
      { id: "m-frozen", projectId: "p-1", title: "冻结的里程碑", targetLocalDate: "2026-08-03", sortOrder: 0, criterionKind: "taskCount", targetTaskId: null, targetCount: 2, targetProgress: null },
      { id: "m-reached", projectId: "p-1", title: "阶段检查点", targetLocalDate: "2026-08-06", sortOrder: 1, criterionKind: "taskCount", targetTaskId: null, targetCount: 1, targetProgress: null },
    ],
    milestoneOutcomes: [{ id: "o-1", milestoneId: "m-frozen", projectId: "p-1", title: "冻结的里程碑", targetLocalDate: "2026-08-03", reached: false, resultText: "完成 0/2，未达成", frozenAtUtc: "2026-08-04T00:00:00Z" }],
  });
}

/** 回顾页样本：周期内既有投入也有进度变化，还有「只有计划没有事件」的任务。 */
function reviewWorkspace() {
  const filler = Array.from({ length: 12 }, (_, index) => ({
    id: `fill-${String(index).padStart(2, "0")}`, projectId: null, title: `明细任务 ${index + 1}`, progress: 0, status: "active",
    deadlineLocal: null, estimatedMinutes: 60, sessionMinutes: 60, priority: "normal", sortOrder: index + 2, kind: "task",
  }));
  return workspace({
    projects: [{ id: "rp-1", title: "回顾项目", deadlineLocal: null }],
    tasks: [
      { id: "alpha", projectId: "rp-1", title: "Alpha 任务", progress: 60, status: "active", deadlineLocal: null, estimatedMinutes: 60, sessionMinutes: 60, priority: "normal", sortOrder: 0, kind: "task" },
      { id: "beta", projectId: null, title: "Beta 任务", progress: 20, status: "active", deadlineLocal: null, estimatedMinutes: 60, sessionMinutes: 60, priority: "normal", sortOrder: 1, kind: "task" },
      { ...filler[0], progress: 45 },
      ...filler.slice(1),
    ],
    progressEvents: [
      { id: "e1", taskId: "alpha", fromProgress: 40, toProgress: 60, occurredAtUtc: anchorAt("2026-08-04", "09:00") },
      { id: "e2", taskId: "beta", fromProgress: 50, toProgress: 20, occurredAtUtc: anchorAt(ANCHOR_DAY, "10:00") },
      { id: "e3", taskId: "alpha", fromProgress: 20, toProgress: 40, occurredAtUtc: anchorAt("2026-08-03", "09:00") },
    ],
    executionRecords: [
      { id: "r1", sessionId: null, taskId: "alpha", actualStartUtc: anchorAt("2026-08-04", "20:00"), actualEndUtc: anchorAt("2026-08-04", "21:00"), note: "第一段" },
      { id: "r2", sessionId: null, taskId: "beta", actualStartUtc: anchorAt("2026-08-05", "09:00"), actualEndUtc: anchorAt("2026-08-05", "09:30"), note: "" },
    ],
    executionSessions: [
      { id: "s1", taskId: "fill-00", localDate: "2026-08-06", endLocalDate: "2026-08-06", startLocal: "19:00", endLocal: "20:00", timeZone: "local", utcOffsetMinutes: -new Date().getTimezoneOffset(), status: "scheduled" },
    ],
  });
}

const preference = (overrides = {}) => ({ motion: "full", scale: 100, ...overrides });

/**
 * 日历页样本（P4-11 加）：同一周里同时有截止旗帜、项目截止、里程碑菱形、已排时段、
 * 已结束记录与时间块，好让三种视图的截图都能看出真实信息密度。
 *
 * **不开启** `showActualRecords`：实际记录叠加层的白字配 accent 底色对比度只有 2.82，
 * 是 P4-11 探针记录的既有缺陷（修它要改配色，超出 P4-11 的边界），截图不必把它拍进来。
 */
function calendarWorkspace() {
  return workspace({
    projects: [
      { id: "cal-p1", title: "毕业设计", deadlineLocal: "2026-08-07" },
      { id: "cal-p2", title: "课程学习", deadlineLocal: "2026-08-20" },
    ],
    projectMilestones: [
      { id: "cal-ms1", projectId: "cal-p1", title: "中期答辩", targetLocalDate: "2026-08-05", sortOrder: 0, criterionKind: "taskCount", targetTaskId: null, targetCount: 2, targetProgress: null },
      { id: "cal-ms2", projectId: "cal-p2", title: "第一章", targetLocalDate: "2026-08-06", sortOrder: 1, criterionKind: "taskCount", targetTaskId: null, targetCount: 1, targetProgress: null },
    ],
    tasks: [
      { id: "cal-t1", projectId: "cal-p1", title: "写开题报告", progress: 40, status: "active", deadlineLocal: "2026-08-05", estimatedMinutes: 60, sessionMinutes: 60, priority: "high", sortOrder: 0, kind: "task" },
      { id: "cal-t2", projectId: "cal-p1", title: "整理文献", progress: 100, status: "completed", deadlineLocal: null, estimatedMinutes: 45, sessionMinutes: 45, priority: "normal", sortOrder: 1, kind: "task" },
      { id: "cal-t3", projectId: "cal-p2", title: "看第一章", progress: 20, status: "active", deadlineLocal: "2026-08-06", estimatedMinutes: 30, sessionMinutes: 30, priority: "normal", sortOrder: 2, kind: "task" },
      { id: "cal-t4", projectId: null, title: "跑步", progress: 0, status: "active", deadlineLocal: "2026-08-04", estimatedMinutes: 30, sessionMinutes: 30, priority: "low", sortOrder: 3, kind: "task" },
    ],
    executionSessions: [
      { id: "cal-s1", taskId: "cal-t1", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "09:00", endLocal: "10:30", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
      { id: "cal-s2", taskId: "cal-t3", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "14:00", endLocal: "15:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "missed" },
      { id: "cal-s3", taskId: "cal-t2", localDate: "2026-08-06", endLocalDate: "2026-08-06", startLocal: "20:00", endLocal: "21:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
      { id: "cal-s4", taskId: "cal-t1", localDate: "2026-08-07", endLocalDate: "2026-08-07", startLocal: "09:00", endLocal: "10:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
    ],
    executionRecords: [{ id: "cal-r1", sessionId: null, taskId: "cal-t3", actualStartUtc: anchorAt("2026-08-04", "20:00"), actualEndUtc: anchorAt("2026-08-04", "20:30"), note: "" }],
    progressEvents: [
      { id: "cal-e1", taskId: "cal-t2", fromProgress: 60, toProgress: 100, occurredAtUtc: anchorAt("2026-08-05", "11:00") },
      { id: "cal-e2", taskId: "cal-t1", fromProgress: 20, toProgress: 40, occurredAtUtc: anchorAt("2026-08-04", "09:00") },
    ],
    timeBlocks: [{ id: "cal-b1", title: "组会", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "16:00", endLocal: "17:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480 }],
  });
}

// ---------------------------------------------------------------- 场景

async function capture(browser, name, seed, act) {
  const context = await browser.newContext({ viewport: seed.viewport ?? { width: 1200, height: 760 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    if (seed.beforeGoto) await seed.beforeGoto(page);
    await page.addInitScript(({ preferences, workspace: snapshot }) => {
      localStorage.setItem("daymark.phase0.preferences", JSON.stringify(preferences));
      localStorage.setItem("daymark.phase1.workspace", JSON.stringify(snapshot));
    }, { preferences: seed.preferences, workspace: seed.workspace });
    await page.goto(`http://127.0.0.1:${seed.port ?? 4175}/`);
    await page.waitForSelector("main#main-content");
    if (seed.clock) {
      await page.clock.setFixedTime(new Date(seed.clock));
      await page.reload();
      await page.waitForSelector("main#main-content");
    }
    await act(page);
    // 主题与背景色带 CSS 过渡（`.12s` 一类）：`act` 刚改完状态就截图会拍到过渡中的
    // 中间帧（浅色页面 + 已经落定的深色横幅）。等一小段时间让过渡走完再截。
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outputDirectory, `${name}.png`) });
    console.log(`[visual] ${name}.png`);
  } finally {
    await context.close();
  }
}

function scenarios(port) {
  const clock = `${ANCHOR_DAY}T12:00:00`;
  const deadlines = deadlinesWorkspace();
  const fullDeadlines = { ...deadlines, tasks: deadlines.tasks.filter((task) => task.deadlineLocal) };

  return [
    {
      name: "deadlines-empty",
      seed: { port, clock, preferences: preference({ lastPage: "deadlines" }), workspace: workspace() },
      act: async (page) => {
        await page.getByRole("heading", { name: "截止事项", level: 1 }).waitFor();
        await page.getByRole("heading", { name: /没有截止事项|还没有/ }).first().waitFor().catch(() => {});
      },
    },
    {
      name: "deadlines-full",
      seed: { port, clock, preferences: preference({ lastPage: "deadlines" }), workspace: deadlines },
      act: async (page) => {
        await page.locator('[data-deadline-group="overdue"]').waitFor();
      },
    },
    {
      name: "popover-top",
      seed: { port, clock, preferences: preference({ lastPage: "deadlines" }), workspace: deadlines },
      act: async (page) => {
        const main = page.locator("#main-content");
        await page.locator("[data-deadline-key]").first().waitFor();
        await main.evaluate((element) => { element.scrollTop = 0; });
        await page.getByRole("button", { name: /^编辑任务 截止任务 01$/ }).click();
        await page.locator('[role="dialog"]').waitFor();
      },
    },
    {
      name: "popover-bottom",
      seed: { port, clock, preferences: preference({ lastPage: "deadlines" }), workspace: deadlines },
      act: async (page) => {
        const main = page.locator("#main-content");
        await page.locator("[data-deadline-key]").first().waitFor();
        await main.evaluate((element) => { element.scrollTop = element.scrollHeight; });
        await page.getByRole("button", { name: /^编辑任务 截止任务 14$/ }).click();
        await page.locator('[role="dialog"]').waitFor();
      },
    },
    {
      name: "long-course",
      seed: { port, clock, preferences: preference({ lastPage: "projects" }), workspace: longCourseWorkspace() },
      act: async (page) => {
        await page.getByRole("heading", { name: "Rust 系统编程（200 讲）", level: 2 }).waitFor();
      },
    },
    {
      name: "review-day",
      seed: { port, clock, preferences: preference({ lastPage: "review" }), workspace: reviewWorkspace() },
      act: async (page) => {
        await page.getByRole("heading", { name: "本周回顾", level: 1 }).waitFor();
        await page.getByRole("group", { name: "回顾周期" }).getByRole("button", { name: "日" }).click();
        await page.locator(".review-charts").waitFor();
      },
    },
    {
      name: "review-week",
      seed: { port, clock, preferences: preference({ lastPage: "review" }), workspace: reviewWorkspace() },
      act: async (page) => {
        await page.getByRole("heading", { name: "本周回顾", level: 1 }).waitFor();
        await page.locator(".review-charts").waitFor();
      },
    },
    {
      name: "review-month",
      seed: { port, clock, preferences: preference({ lastPage: "review" }), workspace: reviewWorkspace() },
      act: async (page) => {
        await page.getByRole("heading", { name: "本周回顾", level: 1 }).waitFor();
        await page.getByRole("group", { name: "回顾周期" }).getByRole("button", { name: "月" }).click();
        await page.getByRole("heading", { name: "2026年8月回顾", level: 1 }).waitFor();
      },
    },
    {
      name: "settings-save-error",
      seed: {
        port, clock, preferences: preference({ lastPage: "appearance" }), workspace: workspace(),
        beforeGoto: async (page) => {
          // 只让偏好写入失败：其它 localStorage 写入照常，避免把应用启动也弄坏。
          await page.addInitScript(() => {
            const original = Storage.prototype.setItem;
            Storage.prototype.setItem = function setItem(key, value) {
              if (key === "daymark.phase0.preferences" && window.__failPreferenceWrites) throw new Error("磁盘空间不足");
              return original.call(this, key, value);
            };
          });
        },
      },
      act: async (page) => {
        await page.getByRole("heading", { name: "设置", level: 1 }).waitFor();
        await page.evaluate(() => { window.__failPreferenceWrites = true; });
        await page.getByRole("radio", { name: "深色" }).check();
        await page.getByRole("alert").waitFor();
        await page.evaluate(() => { window.__failPreferenceWrites = false; });
      },
    },
    {
      name: "restore-confirm",
      seed: { port, clock, preferences: preference({ lastPage: "data" }), workspace: deadlines },
      act: async (page) => {
        await page.getByRole("heading", { name: "数据与安全" }).waitFor();
        await page.getByRole("button", { name: "立即备份" }).click();
        const preview = page.getByRole("button", { name: "检查并预览" });
        await preview.waitFor();
        await preview.click();
        await page.getByRole("dialog", { name: "确认恢复备份" }).waitFor();
      },
    },
    // 日历页（P4-11 加）：改的是月／周的 ARIA 结构，视觉必须**一点不变**，所以
    // 这两个场景要能逐像素对比改前／改后（见 docs/reports/phase-4-p4-11-implementation.md）。
    ...[
      { name: "calendar-week-1200", view: "week", width: 1200, selector: ".week-calendar-main" },
      { name: "calendar-month-1200", view: "month", width: 1200, selector: ".month-calendar" },
      { name: "calendar-week-960", view: "week", width: 960, selector: ".week-calendar-main" },
      { name: "calendar-month-960", view: "month", width: 960, selector: ".month-calendar" },
    ].map(({ name, view, width, selector }) => ({
      name,
      seed: {
        port, clock, viewport: { width, height: 760 },
        preferences: preference({
          lastPage: "calendar", calendarView: view,
          calendarAnchors: { day: ANCHOR_DAY, week: ANCHOR_DAY, month: ANCHOR_DAY },
          calendarZoom: { day: "standard", week: "standard", month: "standard" },
          calendarScale: { day: 48, week: 48, month: 82 },
        }),
        workspace: calendarWorkspace(),
      },
      act: async (page) => {
        await page.getByRole("heading", { name: "日历", level: 1 }).waitFor();
        await page.getByRole("button", { name: view === "week" ? "周" : "月", exact: true }).click();
        await page.locator(selector).waitFor();
      },
    })),
    ...[
      { name: "zoom-960-200-light", width: 960, scale: 200, appearance: "light" },
      { name: "zoom-960-200-dark", width: 960, scale: 200, appearance: "dark" },
      { name: "zoom-1200-200-light", width: 1200, scale: 200, appearance: "light" },
      { name: "zoom-1200-150-dark", width: 1200, scale: 150, appearance: "dark" },
    ].map(({ name, width, scale, appearance }) => ({
      name,
      seed: {
        port, clock, viewport: { width, height: 760 },
        preferences: preference({ lastPage: "review", scale, appearance }),
        workspace: reviewWorkspace(),
      },
      act: async (page) => {
        await page.getByRole("heading", { name: "本周回顾", level: 1 }).waitFor();
        await page.getByRole("group", { name: "回顾周期" }).getByRole("button", { name: "月" }).click();
        await page.getByRole("heading", { name: "2026年8月回顾", level: 1 }).waitFor();
      },
    })),
  ];
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const args = parseArgs(process.argv.slice(2));
  outputDirectory = args.out;
  await mkdir(outputDirectory, { recursive: true });
  if (!args.skipBuild) {
    console.log("[visual] npm run build（生产构建）…");
    await run(process.execPath, [viteEntry, "build"]);
  }

  const server = await startPreview(args.port);
  let browser;
  const written = [];
  try {
    browser = await chromium.launch({ headless: !args.headed });
    for (const scenario of scenarios(args.port)) {
      if (args.only && !scenario.name.includes(args.only)) continue;
      await capture(browser, scenario.name, scenario.seed, scenario.act);
      written.push(scenario.name);
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
    await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(3_000)]);
  }

  console.log(`\n=== 视觉证据（生产构建 + 真实 Chromium）===`);
  console.log(`共 ${written.length} 张，位于 ${outputDirectory}：`);
  for (const name of written) console.log(`  ${name}.png`);
}

await main();
