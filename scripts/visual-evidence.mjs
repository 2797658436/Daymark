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
 * （`--only calendar --out output/visual-p4-11-before` 与 `…-after`）。P4-12 用同一招拍
 * 实际记录叠加层（`--only actual-record --out output/visual-p4-12-before`），场景里带
 * `crop` 的还会多出一张 `-crop.png` 元素近景；P4-13 起 `crop` 可以是数组（一次说清
 * 「变了哪几处」），第二、三张依次落成 `-crop2.png`、`-crop3.png`。
 *
 * 用法：
 *   node scripts/visual-evidence.mjs                 # 全套（headless）
 *   node scripts/visual-evidence.mjs --skip-build    # 复用已有 dist/
 *   node scripts/visual-evidence.mjs --only review   # 只跑名字含 review 的场景
 *   node scripts/visual-evidence.mjs --only calendar --out output/visual-p4-11-after
 *   node scripts/visual-evidence.mjs --headed        # 只有 headless 不渲染的东西才用
 *       （例如滚动条：headless Chromium 用 overlay，不画 ::-webkit-scrollbar；
 *        一次运行只开一个窗口，所有场景共用同一个 browser，跑完自动关闭）
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
 * 完成记录样本（规格 0007 §9 末段：浅／深色各截完成气泡、今日完成行、回顾感受卡）。
 *
 * 一张一周的样本同时服务三个界面：今日页（「今日完成」三行：已记录／未填写／撤回后回到活动池）、
 * 回顾周视图（「完成感受」三档 + 常见标签 + 口径行）与任务明细（记录行 + 缩略图 + 只读放大）。
 */
function completionWorkspace() {
  const item = (id, title, progress, status, sortOrder, patch = {}) => ({
    id, projectId: null, title, progress, status, deadlineLocal: null, estimatedMinutes: 60, sessionMinutes: 60,
    priority: "normal", sortOrder, kind: "task", ...patch,
  });
  const completedToday = (id, title, sortOrder, before, time) => [
    item(id, title, 100, "completed", sortOrder),
    { id: `ce-${id}`, taskId: id, fromProgress: before, toProgress: 100, occurredAtUtc: anchorAt(ANCHOR_DAY, time) },
  ];
  const [alpha, alphaEvent] = completedToday("c-alpha", "写阶段总结", 0, 75, "09:10");
  const [beta, betaEvent] = completedToday("c-beta", "整理用户反馈", 1, 60, "10:20");
  // 撤回后的真实状态：任务回到 40%、留在活动池里，记录仍然带内容躺在明细里。
  const undone = item("c-open", "撤回过一次的那项", 40, "active", 2);
  return workspace({
    tasks: [
      alpha, beta, undone,
      // 完成了但一个字都没记：今日完成那一行要说「未填写完成记录」。
      item("c-blank", "还没记录的一项", 100, "completed", 3),
      // 进度停在 75%、今天有截止：它就是气泡的那一个锚点（任务池那一行 / 今日页临期卡的进度条）。
      item("c-draft", "还在推进的任务", 75, "active", 4, { deadlineLocal: ANCHOR_DAY }),
      // 上周完成的两项：让「完成感受」的三档都有量。
      item("c-early", "搭好导入脚本", 100, "completed", 5),
      item("c-later", "复核导出格式", 100, "completed", 6),
    ],
    progressEvents: [
      alphaEvent, betaEvent,
      { id: "ce-open", taskId: "c-open", fromProgress: 40, toProgress: 100, occurredAtUtc: anchorAt(ANCHOR_DAY, "11:05") },
      // 撤回写的是**新的**回退事件，上一条 40→100 一个字都不改。
      { id: "ce-open-back", taskId: "c-open", fromProgress: 100, toProgress: 40, occurredAtUtc: anchorAt(ANCHOR_DAY, "11:30") },
      { id: "ce-blank", taskId: "c-blank", fromProgress: 80, toProgress: 100, occurredAtUtc: anchorAt(ANCHOR_DAY, "11:40") },
      { id: "ce-early", taskId: "c-early", fromProgress: 0, toProgress: 100, occurredAtUtc: anchorAt("2026-08-03", "14:00") },
      { id: "ce-later", taskId: "c-later", fromProgress: 55, toProgress: 100, occurredAtUtc: anchorAt("2026-08-06", "09:30") },
    ],
    completionRecords: [
      { id: "cr-1", taskId: "c-alpha", progressEventId: "ce-c-alpha", completedAtUtc: anchorAt(ANCHOR_DAY, "09:10"), progressBefore: 75, fit: "light", note: "一次写完，中途没有分心。下次先把材料收齐再开始。", tags: ["专注", "顺利"], revertedAtUtc: null, imageCount: 2 },
      { id: "cr-2", taskId: "c-beta", progressEventId: "ce-c-beta", completedAtUtc: anchorAt(ANCHOR_DAY, "10:20"), progressBefore: 60, fit: "hard", note: "被两次打断，剩下的部分拖到明天。", tags: ["被打断", "疲惫"], revertedAtUtc: null, imageCount: 1 },
      // 已撤回：内容一个字不删，明细里只读，但不进感受聚合。
      { id: "cr-3", taskId: "c-open", progressEventId: "ce-open", completedAtUtc: anchorAt(ANCHOR_DAY, "11:05"), progressBefore: 40, fit: "light", note: "撤回过一次，内容还在。", tags: ["想继续"], revertedAtUtc: anchorAt(ANCHOR_DAY, "11:30"), imageCount: 0 },
      { id: "cr-4", taskId: "c-early", progressEventId: "ce-early", completedAtUtc: anchorAt("2026-08-03", "14:00"), progressBefore: 0, fit: "fit", note: "", tags: ["有收获"], revertedAtUtc: null, imageCount: 0 },
      { id: "cr-5", taskId: "c-later", progressEventId: "ce-later", completedAtUtc: anchorAt("2026-08-06", "09:30"), progressBefore: 55, fit: "hard", note: "格式对不上，重来了一遍。", tags: ["卡住", "比预计难"], revertedAtUtc: null, imageCount: 0 },
    ],
  });
}

/** 打开气泡（规格 §3.1 的两个入口：任务池那一行 / 今日页临期卡的进度条）。 */
async function openCompletionBubble(page, { via = "pool", title = "还在推进的任务" } = {}) {
  if (via === "pool") {
    await page.getByRole("button", { name: `调整进度 ${title}，当前 75%` }).click();
    await page.getByRole("button", { name: `标记 ${title} 已完成` }).click();
  } else {
    const slider = page.getByRole("slider", { name: `${title} 完成度` });
    await slider.fill("100");
    // 拖动结束才提交：程序化 fill 不发 keyup，补一次按键走真实提交分支。
    await slider.press("ArrowRight");
  }
  await page.locator(".completion-panel").waitFor();
}

/**
 * 明细与放大层要真的把图片画出来，所以在场景里现画一张 PNG 再打开明细。
 *
 * 不在夹具里塞一段来历不明的 base64：1×1 的纯色图在只读放大层里就只有 1 个像素，
 * 截图看不出「装得下就原尺寸、装不下等比缩」这条规则到底成不成立。
 * 字节放在同源的第二个键里（快照只有 `imageCount`），应用按需读取，所以 act 里写也来得及。
 */
async function seedCompletionImages(page) {
  await page.evaluate(() => {
    const draw = (width, height) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      context.fillStyle = "#f5d8c2";
      context.fillRect(0, 0, width, height);
      context.fillStyle = "#d2693b";
      context.fillRect(width / 8, height / 8, (width * 3) / 4, (height * 3) / 4);
      context.fillStyle = "#24231f";
      context.fillRect(width / 3, height / 3, width / 3, height / 3);
      return canvas.toDataURL("image/png").split(",")[1];
    };
    const image = (recordId, index, width) => {
      const height = Math.round((width * 9) / 16);
      const data = draw(width, height);
      return { id: `${recordId}-image-${index}`, sortOrder: index, mime: "image/png", width, height, sizeBytes: Math.round(data.length * 0.75), dataBase64: data, thumbBase64: draw(160, 90) };
    };
    localStorage.setItem("daymark.phase1.completionImages", JSON.stringify({
      "cr-1": [image("cr-1", 0, 900), image("cr-1", 1, 640)],
      "cr-2": [image("cr-2", 0, 800)],
    }));
  });
}

/**
 * 日历页样本（P4-11 加）：同一周里同时有截止旗帜、项目截止、里程碑菱形、已排时段、
 * 已结束记录与时间块，好让三种视图的截图都能看出真实信息密度。
 *
 * **不开启** `showActualRecords`：这 4 张图是 P4-11 用来证明「结构重排对视觉零影响」的
 * 基线（逐字节相同），所以保持当时的配置不动。实际记录叠加层的改前／改后对照是 P4-12
 * 的 `actual-record-*` 场景（见下面 `actualRecordWorkspace()`）。
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

/**
 * 实际记录叠加层样本（P4-12 加，P4-13 扩充）。
 *
 * **为什么记录取 1.5 小时（09:00–10:30，108px）**：这一段长度让**两档缩放各自暴露一处**，
 * 改前／改后才有得比 ——
 *   - 100%（行高 22px，内容盒 98px）：三行 66px 放得下 → 改前／改后都显示三行，
 *     差别只在「满饱和橙 vs 淡桃底」；
 *   - 200%（行高 44px）：三行要 132px，超过 98px → 改前 `grid-template-rows` 塌成
 *     `44px 10px 44px`（标题被压成一条缝），改后按优先级隐藏时间行、留下「实际」+ 标题。
 * P4-12 用的是 2 小时（144px）：200% 下三行正好放得下，看不到塌陷。
 *
 * 时间避开 12:00：那是「现在」线的位置，它的时间徽标会正好盖住叠加层的标题行（实测过）。
 *
 * P4-13 在这里多放了**一张「待回顾」时段**（08:00–09:00，只计划、无记录）和**一个时间块**
 * （11:30–12:30）：它们与叠加层同属这一包改到的配色区，放在同一个样本里才能用同一组
 * 改前／改后截图说清「变了哪几处」。P4-12 归档的那 8 张来自**更早的**、没有这两项的样本。
 *
 * 跟进包（2026-10-17）再加**一个 15 分钟的短时间块**（10:45–11:00）：1 小时块的天然高是 72px，
 * 两档缩放都够高，`min-height` 根本不参与；只有短块的天然高（18px）低于下限，才量得到
 * 「px 下限 vs rem 下限」的差别。11:30 那个 1 小时块保留，仍在全页截图里。
 */
function actualRecordWorkspace() {
  return workspace({
    tasks: [
      { id: "ar-t1", projectId: null, title: "写开题报告", progress: 40, status: "active", deadlineLocal: null, estimatedMinutes: 60, sessionMinutes: 60, priority: "normal", sortOrder: 0, kind: "task" },
      { id: "ar-t2", projectId: null, title: "看第一章", progress: 20, status: "active", deadlineLocal: null, estimatedMinutes: 30, sessionMinutes: 30, priority: "normal", sortOrder: 1, kind: "task" },
      { id: "ar-t3", projectId: null, title: "整理文献", progress: 60, status: "active", deadlineLocal: null, estimatedMinutes: 60, sessionMinutes: 60, priority: "normal", sortOrder: 2, kind: "task" },
    ],
    executionSessions: [
      { id: "ar-s3", taskId: "ar-t3", localDate: ANCHOR_DAY, endLocalDate: ANCHOR_DAY, startLocal: "08:00", endLocal: "09:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
      { id: "ar-s1", taskId: "ar-t1", localDate: ANCHOR_DAY, endLocalDate: ANCHOR_DAY, startLocal: "09:00", endLocal: "10:30", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
      { id: "ar-s2", taskId: "ar-t2", localDate: ANCHOR_DAY, endLocalDate: ANCHOR_DAY, startLocal: "14:00", endLocal: "15:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "missed" },
    ],
    executionRecords: [
      { id: "ar-r1", sessionId: "ar-s1", taskId: "ar-t1", actualStartUtc: anchorAt(ANCHOR_DAY, "09:00"), actualEndUtc: anchorAt(ANCHOR_DAY, "10:30"), note: "" },
    ],
    // 跟进包（2026-10-17）加：一个**短**时间块（10:45–11:00，15 分钟，天然高 18px）。
    // 1 小时块（11:30–12:30）天然高 72px，两档缩放都不触发 `min-height`，看不出「px 下限」
    // 的问题；短块的天然高只有 18px，才会被 `min-height` 钳住 —— 这才是 §1 要拍的对照。
    // 放在数组首位（日视图按数组顺序渲染），`crop` 里的 `.calendar-time-block`（`first()`）
    // 取到的就是它。
    timeBlocks: [
      { id: "ar-b2", title: "短块", localDate: ANCHOR_DAY, endLocalDate: ANCHOR_DAY, startLocal: "10:45", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480 },
      { id: "ar-b1", title: "组会", localDate: ANCHOR_DAY, endLocalDate: ANCHOR_DAY, startLocal: "11:30", endLocal: "12:30", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480 },
    ],
  });
}

/**
 * 把实际记录叠加层滚进「吸顶头部下方」的可见区，并且**确认它真的在那里**（确认不了就抛错，
 * 免得悄悄拍出一张没有叠加层的全页截图）。
 *
 * 三个坑，都是 P4-12 实测踩到的：
 *   1. 只调 `scrollIntoViewIfNeeded()` 不够 —— 应用进入视图后还会自己定位一次，会把刚滚的
 *      位置覆盖掉；
 *   2. 周视图的日期头 + 全天区是**吸顶**的（`.week-sticky-header`，z-index 12），叠加层
 *      z-index 只有 7 —— 滚到「滚动窗口上三分之一」仍然被它盖住，截图只会拍到一片纯色；
 *   3. 日视图有三块连续日面板，`scroller.querySelector(".continuous-day-separator")` 拿到的是
 *      **第一块**面板的分隔条；叠加层在第二块里，拿它当锚点会一路滚过头。锚点必须取叠加层
 *      **自己那块面板**的分隔条。
 */
const measureActualRecord = (nudge) => {
  const overlay = document.querySelector(".calendar-actual-record");
  if (!overlay) return { ok: false, reason: "no-overlay" };
  let node = overlay.parentElement;
  let scroller = null;
  while (node) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) { scroller = node; break; }
    node = node.parentElement;
  }
  if (!scroller) return { ok: false, reason: "no-scroller" };
  const header = scroller.querySelector(".week-sticky-header")
    // 日视图：真正压在上面的是**日期头**（`top: 40px`，在 40px 高的分隔条下面），
    // 不是分隔条。P4-12 只避让了分隔条，于是叠加层的顶行（「实际」标签）一直被日期头
    // 盖着 —— 近景截图的头几十像素拍到的其实是日期头。P4-13 起以日期头为准。
    ?? overlay.closest(".continuous-day-panel")?.querySelector(".calendar-day > header")
    ?? overlay.closest(".continuous-day-panel")?.querySelector(".continuous-day-separator")
    ?? null;
  const scrollerRect = scroller.getBoundingClientRect();
  const safeTop = header ? header.getBoundingClientRect().bottom : scrollerRect.top;
  const rect = overlay.getBoundingClientRect();
  const ok = rect.top >= safeTop + 8 && rect.bottom <= scrollerRect.bottom - 8;
  if (!ok && nudge) scroller.scrollTop += rect.top - safeTop - 24;
  return {
    ok, reason: header ? (scroller.querySelector(".week-sticky-header") ? "week-header" : "day-separator") : "scroller-top",
    overlayTop: Math.round(rect.top), overlayBottom: Math.round(rect.bottom),
    safeTop: Math.round(safeTop), scrollerBottom: Math.round(scrollerRect.bottom),
    scrollTop: Math.round(scroller.scrollTop),
  };
};

async function frameActualRecord(page) {
  let last = { ok: false, reason: "not-run" };
  for (let attempt = 0; attempt < 12; attempt += 1) {
    last = await page.evaluate(measureActualRecord, true);
    await page.waitForTimeout(300);
    if (last.ok) {
      const confirm = await page.evaluate(measureActualRecord, false);
      if (confirm.ok) return confirm;
      last = confirm;
    }
  }
  throw new Error(`实际记录叠加层没能滚进可见区（${JSON.stringify(last)}）`);
}

/**
 * P4-13 §1 的取景：把**日视图的吸顶日期头**（含「今天」药丸）与一段实际记录同时留在视口里，
 * 并且让记录**压在吸顶头部带下方** —— 这样「谁画在上面」才会出现在这一张图里。
 *
 * 与 `frameActualRecord` 相反：那个是把叠加层滚到吸顶头**下面**的空白区（为了拍清楚字形），
 * 这个是把叠加层滚到吸顶头**底下**（为了拍遮挡）。收敛重试的理由同上：应用进入视图后还会
 * 自己定位一次，一次设置不一定生效。
 */
const measureTodayPill = (nudge) => {
  const scroller = document.querySelector(".continuous-day-axis");
  const day = scroller?.querySelector(".calendar-day.today");
  const header = day?.querySelector("header");
  const overlay = day?.closest(".continuous-day-panel")?.querySelector(".calendar-actual-record")
    ?? scroller?.querySelector(".calendar-actual-record");
  if (!scroller || !day || !header || !overlay) return { ok: false, reason: "missing-element" };
  const scrollerRect = scroller.getBoundingClientRect();
  const headerRect = header.getBoundingClientRect();
  const overlayRect = overlay.getBoundingClientRect();
  const headerInView = headerRect.top >= scrollerRect.top - 1 && headerRect.bottom <= scrollerRect.bottom;
  const overlaps = overlayRect.top < headerRect.bottom && overlayRect.bottom > headerRect.top;
  if (!(headerInView && overlaps) && nudge) scroller.scrollTop += (overlayRect.top - scrollerRect.top) - 50;
  return {
    ok: headerInView && overlaps,
    overlayTop: Math.round(overlayRect.top), headerTop: Math.round(headerRect.top),
    headerBottom: Math.round(headerRect.bottom), scrollerTop: Math.round(scrollerRect.top),
    scrollTop: Math.round(scroller.scrollTop),
  };
};

async function frameTodayPill(page) {
  let last = { ok: false, reason: "not-run" };
  for (let attempt = 0; attempt < 12; attempt += 1) {
    last = await page.evaluate(measureTodayPill, true);
    await page.waitForTimeout(300);
    if (last.ok) {
      const confirm = await page.evaluate(measureTodayPill, false);
      if (confirm.ok) return confirm;
      last = confirm;
    }
  }
  throw new Error(`吸顶日期头与实际记录没能同时取到（${JSON.stringify(last)}）`);
}

// ---------------------------------------------------------------- 场景

/**
 * 把某个元素滚到**吸顶头下方的安全区**再拍近景。
 *
 * `locator.screenshot()` 只保证元素「在视口里」，滚动量取最小 —— 在日历里这就意味着它常常
 * 正好停在吸顶日期头**底下**，近景的上半截拍到的是吸顶头（P4-13 实测：计划卡与时间块的近景
 * 都被日期头压掉了一半）。目标本身就是吸顶头时跳过（那时它已经在正确的位置上）。
 */
async function frameBelowHeader(locator) {
  await locator.evaluate((element) => {
    let scroller = element.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!scroller) return;
    const panel = element.closest(".continuous-day-panel");
    const header = scroller.querySelector(".week-sticky-header")
      ?? panel?.querySelector(".calendar-day > header")
      ?? panel?.querySelector(".continuous-day-separator")
      ?? null;
    if (!header || header === element || header.contains(element)) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const safeTop = Math.max(scrollerRect.top, header.getBoundingClientRect().bottom);
    const rect = element.getBoundingClientRect();
    if (rect.top < safeTop + 8) scroller.scrollTop += rect.top - safeTop - 8;
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function capture(browser, name, seed, act, crop) {
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
    // `crop`：再拍一张目标元素的近景。小色块（实际记录叠加层只有 24–72px 高）在全页
    // 截图里只有几个像素高，看不出文字，近景才是「改前白字 / 改后深字」的直接证据。
    // P4-13 起可以传数组：一组改前／改后要同时说清「变了哪几处」时，一次跑完更省事
    // （第一张沿用 P4-12 的 `-crop.png` 名字，其余依次是 `-crop2.png`、`-crop3.png`）。
    const crops = crop === undefined ? [] : Array.isArray(crop) ? crop : [crop];
    for (const [index, selector] of crops.entries()) {
      const suffix = index === 0 ? "-crop" : `-crop${index + 1}`;
      const target = page.locator(selector).first();
      await frameBelowHeader(target);
      await target.screenshot({ path: join(outputDirectory, `${name}${suffix}.png`) });
      console.log(`[visual] ${name}${suffix}.png`);
    }
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
        await page.getByRole("heading", { name: "8月3日 — 8月9日", level: 1 }).waitFor();
        await page.getByRole("group", { name: "回顾周期" }).getByRole("button", { name: "日" }).click();
        // 日视图自 P4-08 之后不再有 `.review-charts`（投入去向与任务明细合成一张合并卡），
        // P4-15 又把那张合并卡拆掉、把圆环收进 `.review-tasks` —— 等 `.review-tasks`，
        // 日／周／月三种周期都有这个容器。
        await page.locator(".review-tasks").waitFor();
      },
    },
    {
      name: "review-week",
      seed: { port, clock, preferences: preference({ lastPage: "review" }), workspace: reviewWorkspace() },
      act: async (page) => {
        await page.getByRole("heading", { name: "8月3日 — 8月9日", level: 1 }).waitFor();
        await page.locator(".review-charts").waitFor();
      },
    },
    {
      name: "review-month",
      seed: { port, clock, preferences: preference({ lastPage: "review" }), workspace: reviewWorkspace() },
      act: async (page) => {
        await page.getByRole("heading", { name: "8月3日 — 8月9日", level: 1 }).waitFor();
        await page.getByRole("group", { name: "回顾周期" }).getByRole("button", { name: "月" }).click();
        await page.getByRole("heading", { name: "2026年8月", level: 1 }).waitFor();
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
        await page.getByRole("heading", { name: "8月3日 — 8月9日", level: 1 }).waitFor();
        await page.getByRole("group", { name: "回顾周期" }).getByRole("button", { name: "月" }).click();
        await page.getByRole("heading", { name: "2026年8月", level: 1 }).waitFor();
      },
    })),
    // P4-12：实际记录叠加层的改前／改后对照。开启「显示实际记录」，浅／深各一张全页 +
    // 一张叠加层近景。宽度用 1200：960 宽时右侧任务池会变成覆盖面板压住日历。
    //
    // **只拍日视图**：200% 缩放下周视图的可见时间窗只有约 140px 高（日期头 + 全天区吸顶占了
    // 一多半），而 2 小时的叠加层有 144px —— 放不下。日视图的可视窗口宽得多，三行文字都能
    // 完整渲染，是「白字 → 深字」最直接的对照。
    //
    // P4-13：`scale` 改成**场景参数**（100／200 各一组，不再硬编码 200），并一次多拍两张近景
    // ——「待回顾」计划卡（§3 的去强调）与时间块（§5 的起止时间字色）。改前那组要先
    // `git checkout HEAD -- src/styles.css`（跑完立刻从备份拷回来）。
    ...["day"].flatMap((view) => ["light", "dark"].flatMap((appearance) => [100, 200].map((scale) => ({
      name: `actual-record-${view}-1200-${scale}-${appearance}`,
      crop: [".calendar-actual-record", ".calendar-session.planned-outline", ".calendar-time-block"],
      seed: {
        // 900 高而不是 P4-12 的 760：200% 缩放下日视图的可视窗口只有约 216px，
        // 2 小时的叠加层（144px）放不进「日期头下方的安全区」；加高窗口才能让改前／改后
        // 两组用同一套取景（取景必须一致，否则截图不可比）。
        port, clock, viewport: { width: 1200, height: 900 },
        preferences: preference({
          lastPage: "calendar", calendarView: view, appearance, scale, showActualRecords: true,
          calendarAnchors: { day: ANCHOR_DAY, week: ANCHOR_DAY, month: ANCHOR_DAY },
          calendarZoom: { day: "standard", week: "standard", month: "standard" },
        }),
        workspace: actualRecordWorkspace(),
      },
      act: async (page) => {
        await page.getByRole("heading", { name: "日历", level: 1 }).waitFor();
        await page.getByRole("button", { name: view === "week" ? "周" : "日", exact: true }).click();
        await page.locator(view === "week" ? ".week-calendar-main" : ".continuous-day-axis").waitFor();
        await frameActualRecord(page);
      },
    })))),
    // P4-13 §1：日视图吸顶日期头（含「今天」药丸）与实际记录**同时**入镜，且记录压在吸顶头
    // 底下 —— 改前药丸被盖住、改后药丸在最上面。近景取日期头本身。
    ...["day"].flatMap((view) => ["light", "dark"].flatMap((appearance) => [100, 200].map((scale) => ({
      name: `today-pill-${view}-1200-${scale}-${appearance}`,
      crop: ".calendar-day.today > header",
      seed: {
        // 900 高而不是 P4-12 的 760：200% 缩放下日视图的可视窗口只有约 216px，
        // 2 小时的叠加层（144px）放不进「日期头下方的安全区」；加高窗口才能让改前／改后
        // 两组用同一套取景（取景必须一致，否则截图不可比）。
        port, clock, viewport: { width: 1200, height: 900 },
        preferences: preference({
          lastPage: "calendar", calendarView: view, appearance, scale, showActualRecords: true,
          calendarAnchors: { day: ANCHOR_DAY, week: ANCHOR_DAY, month: ANCHOR_DAY },
          calendarZoom: { day: "standard", week: "standard", month: "standard" },
        }),
        workspace: actualRecordWorkspace(),
      },
      act: async (page) => {
        await page.getByRole("heading", { name: "日历", level: 1 }).waitFor();
        await page.getByRole("button", { name: view === "week" ? "周" : "日", exact: true }).click();
        await page.locator(view === "week" ? ".week-calendar-main" : ".continuous-day-axis").waitFor();
        await frameTodayPill(page);
      },
    })))),

    // 规格 0007 §9：完成记录三类界面 × 浅／深色，外加 960×640 + 200% 那一组。
    // 气泡一律拍两张：全页看它与锚点行的关系，近景看控件本身（三档、瓦片、动作条）。
    ...["light", "dark"].flatMap((appearance) => [
      {
        name: `completion-bubble-${appearance}`,
        crop: ".completion-panel",
        seed: {
          port, clock, preferences: preference({ lastPage: "today", appearance }), workspace: completionWorkspace(),
        },
        // 从任务池那一行开：气泡锚在它旁边，那行在气泡期间留在原地显示完成态。
        act: async (page) => openCompletionBubble(page),
      },
      {
        name: `completion-today-rows-${appearance}`,
        crop: ".today-completed",
        seed: {
          port, clock, viewport: { width: 1200, height: 900 }, preferences: preference({ lastPage: "today", appearance }), workspace: completionWorkspace(),
        },
        act: async (page) => {
          await page.getByText(/今日完成 \d+ 项/).click();
          await page.locator(".today-completed-row").first().waitFor();
        },
      },
      {
        name: `completion-review-${appearance}`,
        crop: ".review-feeling",
        seed: { port, clock, preferences: preference({ lastPage: "review", appearance }), workspace: completionWorkspace() },
        act: async (page) => {
          await page.getByRole("heading", { name: "8月3日 — 8月9日", level: 1 }).waitFor();
          // 感受卡在最后一节：不滚进视野就截图，拍到的只是它上面那一段明细。
          await page.locator(".review-feeling").scrollIntoViewIfNeeded();
        },
      },
      // 960×640 + 200%：最窄视口配上最大根字号，检查气泡不裁字、动作条仍在窗口内。
      // 入口换成今日页临期卡的进度条 —— 960 宽时任务池是覆盖面板，压住的就是这块。
      {
        name: `completion-bubble-960-200-${appearance}`,
        crop: ".completion-panel",
        seed: {
          port, clock, viewport: { width: 960, height: 640 },
          preferences: preference({ lastPage: "today", appearance, scale: 200 }),
          workspace: completionWorkspace(),
        },
        act: async (page) => openCompletionBubble(page, { via: "today", title: "还在推进的任务" }),
      },
      // 今日完成那一行是「标题 + 事实」两段都带省略的：200% 下先挤掉谁，只有这里看得见。
      {
        name: `completion-today-rows-960-200-${appearance}`,
        crop: ".today-completed",
        seed: {
          port, clock, viewport: { width: 960, height: 640 },
          preferences: preference({ lastPage: "today", appearance, scale: 200 }), workspace: completionWorkspace(),
        },
        act: async (page) => {
          await page.getByText(/今日完成 \d+ 项/).click();
          await page.locator(".today-completed-row").first().waitFor();
        },
      },
    ]),
    // 选中态单独一张：三档各带图标，选中还要再加尾部对勾 —— 要看清「图标 ≠ 选中」。
    {
      name: "completion-bubble-selected",
      crop: ".completion-fits",
      seed: { port, clock, preferences: preference({ lastPage: "today", appearance: "light" }), workspace: completionWorkspace() },
      act: async (page) => {
        await openCompletionBubble(page);
        await page.locator(".completion-panel").getByRole("button", { name: "合适" }).click();
      },
    },
    // 明细里的记录行与只读放大层：各补一张浅色近景（这两块不随主题改结构）。
    ...[
      { name: "completion-review-detail", crop: ".review-detail", act: async (page) => { await page.getByRole("button", { name: "查看任务「写阶段总结」的明细" }).click(); await page.locator(".review-completion-thumb").first().waitFor(); } },
      { name: "completion-image-viewer", crop: ".review-image-viewer", act: async (page) => { await page.getByRole("button", { name: "查看任务「写阶段总结」的明细" }).click(); await page.getByRole("button", { name: "放大查看第 1 张完成图片" }).click(); await page.locator(".review-image-viewer").waitFor(); } },
    ].map((scene) => ({
      ...scene,
      seed: { port, clock, preferences: preference({ lastPage: "review", appearance: "light" }), workspace: completionWorkspace() },
      act: async (page) => {
        await page.getByRole("heading", { name: "8月3日 — 8月9日", level: 1 }).waitFor();
        await seedCompletionImages(page);
        await scene.act(page);
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
      await capture(browser, scenario.name, scenario.seed, scenario.act, scenario.crop);
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
