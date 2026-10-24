#!/usr/bin/env node
/**
 * 阶段 4 P4-09 的性能测量脚本（规格 §8 / AC15）。
 *
 * 依据 `docs/specs/0005-phase-4-daily-workflow-and-reliability.md` §8 的三项预算：
 *   1. 搜索输入 → 列表稳定显示      P95 ≤ 200ms
 *   2. 气泡打开                     ≤ 150ms
 *   3. 月回顾计算                   ≤ 100ms（预热后 20 次）
 *
 * 三条硬约束：
 *   - **必须测生产构建**：脚本自己 `npm run build` 之后起 `vite preview`（默认 4174），
 *     绝不用 dev server（HMR + 未压缩模块，数字没有意义）。
 *   - **必须可复现**：样本由 `scripts/fixtures/perf-sample.mjs` 以固定 `--seed`／`--anchor`
 *     产出；脚本把种子、锚点、机器信息与数据规模一起写进结果 JSON。
 *   - **只读边界**：样本只写进浏览器 `localStorage`（预览层两个键），不碰 SQLite／Tauri。
 *
 * 三项预算都在**真实 Chromium + 生产构建**里测用户可感的时延；月回顾另外给一份
 * 「纯引擎计算」的数字（同一份源码用 Vite 的 lib 模式打成 ESM 后在 Node 里跑），
 * 用来区分「算得慢」和「画得慢」—— 这正是规格「先查重复计算」需要的证据。
 *
 * 用法：
 *   node scripts/measure-perf.mjs                                  # 全套，结果落 output/perf-p4-09.json
 *   node scripts/measure-perf.mjs --sample output/perf-sample.json
 *   node scripts/measure-perf.mjs --skip-build                     # 复用已有 dist/
 *   node scripts/measure-perf.mjs --search-runs 40 --month-runs 20 --popover-runs 20
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem, version as osVersion } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "@playwright/test";
import { build as viteBuild } from "vite";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const viteEntry = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));

// ---------------------------------------------------------------- 参数

const DEFAULTS = {
  sample: join(projectRoot, "output", "perf-sample.json"),
  out: join(projectRoot, "output", "perf-p4-09.json"),
  port: 4174,
  searchRuns: 30,
  monthRuns: 20,
  popoverRuns: 20,
  skipBuild: false,
  skipEngine: false,
  sequential: false,
  headed: false,
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (key === "skip-build") { args.skipBuild = true; continue; }
    if (key === "skip-engine") { args.skipEngine = true; continue; }
    if (key === "sequential") { args.sequential = true; continue; }
    if (key === "headed") { args.headed = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) continue;
    i += 1;
    switch (key) {
      case "sample": args.sample = value; break;
      case "out": args.out = value; break;
      case "port": args.port = Number(value); break;
      case "search-runs": args.searchRuns = Number(value); break;
      case "month-runs": args.monthRuns = Number(value); break;
      case "popover-runs": args.popoverRuns = Number(value); break;
      default: throw new Error(`未知参数 --${key}`);
    }
  }
  return args;
}

// ---------------------------------------------------------------- 统计

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (ratio) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1))];
  const round = (value) => Number(value.toFixed(2));
  return {
    runs: sorted.length,
    min: round(sorted[0]),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1]),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    samples: sorted.map(round),
  };
}

function machineInfo() {
  const cpuList = cpus();
  return {
    platform: platform(),
    arch: arch(),
    release: release(),
    osVersion: osVersion(),
    cpuModel: cpuList[0]?.model ?? "unknown",
    cpuCount: cpuList.length,
    totalMemoryGb: Number((totalmem() / 1024 ** 3).toFixed(1)),
    node: process.version,
  };
}

// ---------------------------------------------------------------- 构建

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: projectRoot, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`))));
  });
}

async function buildProduction() {
  console.log("[perf] npm run build（生产构建）…");
  await run(process.execPath, [viteEntry, "build"]);
}

// ---------------------------------------------------------------- 纯引擎计算

/**
 * 用 Vite 的 lib 模式把回顾引擎打成 ESM，再在 Node 里跑纯计算。
 *
 * 这是「同一份源码 + 同一套工具链」的编译产物（Vite 生产构建也走这条 TS→JS 管线），
 * 只用于把「引擎算多久」和「页面画多久」分开。三项预算本身仍以浏览器里的生产构建为准。
 */
async function buildEngineBundle() {
  const entryPath = join(projectRoot, "output", "perf-engine-entry.ts");
  await writeFile(entryPath, [
    'export { buildReview, buildReviewFromIndex } from "../src/lib/review";',
    'export { createWorkspaceIndex } from "../src/lib/workspaceSelectors";',
    "",
  ].join("\n"), "utf8");
  await viteBuild({
    root: projectRoot,
    configFile: false,
    logLevel: "error",
    build: {
      outDir: "output/perf-engine",
      emptyOutDir: true,
      minify: true,
      lib: { entry: entryPath, formats: ["es"], fileName: () => "engine.mjs" },
    },
  });
  return join(projectRoot, "output", "perf-engine", "engine.mjs");
}

async function measureEngine(sample, runs) {
  const bundlePath = await buildEngineBundle();
  const engine = await import(pathToFileURL(bundlePath).href);
  const index = engine.createWorkspaceIndex(sample.workspace);
  const anchorDate = sample.stats.anchorDate;
  const now = new Date(`${anchorDate}T12:00:00`);
  const warm = 5;

  const bench = (period) => {
    const query = { period, anchorDate, projectId: null };
    for (let i = 0; i < warm; i += 1) engine.buildReviewFromIndex(index, query, now);
    const samples = [];
    for (let i = 0; i < runs; i += 1) {
      const t0 = performance.now();
      engine.buildReviewFromIndex(index, query, now);
      samples.push(performance.now() - t0);
    }
    return summarize(samples);
  };

  const indexBuild = [];
  for (let i = 0; i < 5; i += 1) {
    const t0 = performance.now();
    engine.createWorkspaceIndex(sample.workspace);
    indexBuild.push(performance.now() - t0);
  }

  return {
    note: "同一份源码经 Vite lib 模式（esbuild/rolldown 同一条 TS→JS 管线）打成的 ESM，在 Node 里跑纯计算；不含 React 渲染与 DOM。",
    warmupRuns: warm,
    runs,
    day: bench("day"),
    week: bench("week"),
    month: bench("month"),
    workspaceIndexBuild: summarize(indexBuild),
  };
}

// ---------------------------------------------------------------- 浏览器

async function startPreview(port) {
  const server = spawn(process.execPath, [viteEntry, "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: projectRoot,
    stdio: ["ignore", "ignore", "inherit"],
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

/**
 * 注入到页面里的测量原语。
 *
 * 「列表稳定显示」的判据是**最后一次 DOM 变动发生的时刻**，不是「连续 N 帧没变动之后」
 * 的时刻 —— 后者会叠加一个固定的人工下限（3 帧 ≈ 50ms），把真实时延淹没掉。
 * 这里的做法：用 MutationObserver 记录最后一次变动的时间戳，等它之后约 1.5 帧仍无新变动
 * 再收口，但**上报的是最后一次变动的时间戳**（此时最终 DOM 已就位，同一帧内绘制）。
 */
function installPerfHelpers() {
  window.__perf = {
    observe(target) {
      let last = null;
      const observer = new MutationObserver(() => { last = performance.now(); });
      observer.observe(target, { childList: true, subtree: true, characterData: true, attributes: true });
      return { observer, get last() { return last; }, reset() { last = null; } };
    },
    settle(watch, maxFrames) {
      return new Promise((resolve) => {
        let frame = 0;
        const tick = () => {
          frame += 1;
          if ((watch.last !== null && performance.now() - watch.last >= 24) || frame > maxFrames) {
            watch.observer.disconnect();
            resolve(watch.last ?? performance.now());
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    },
  };
}

async function seedAndOpen(page, sample, baseUrl) {
  await page.addInitScript(({ workspace, preferences }) => {
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify(workspace));
    localStorage.setItem("daymark.phase0.preferences", JSON.stringify(preferences));
  }, { workspace: sample.workspace, preferences: sample.preferences });
  await page.goto(baseUrl);
  await page.waitForSelector("#task-pool, main#main-content", { timeout: 60_000 });
  // 等应用首屏稳定（快照加载 + 索引建立 + 首屏渲染）。
  await page.waitForFunction(() => document.querySelectorAll(".task-card, .project-card, .review-page, .deadlines-page").length > 0, null, { timeout: 60_000 });
}

/**
 * 每一项预算都在**全新的页面**上测：搜索会把项目页铺满 1,000 个任务行，气泡会把任务池
 * 渲染出来，如果复用同一个页面，后测的项目就带着前一项留下的 DOM 与 GC 压力，读数会
 * 系统性偏高（实测月回顾因此从 ~60ms 变成 ~120ms）。每项独立起页，读数才互不污染。
 */
async function onFreshPage(context, sample, baseUrl, task) {
  const page = await context.newPage();
  try {
    await seedAndOpen(page, sample, baseUrl);
    return await task(page);
  } finally {
    await page.close();
  }
}

async function measureSearch(page, queries, runs) {
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page.waitForSelector('input[aria-label="搜索项目任务"]');
  await page.evaluate(installPerfHelpers);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const samples = [];
  const skipped = [];
  let previous = ""; // 输入框初值是空串（taskQuery 的初始 state）
  for (let i = 0; i < runs; i += 1) {
    let query = queries[i % queries.length];
    // 与当前值相同的查询不会触发重渲染 → 观察不到任何 DOM 变动，样本没有意义。
    if (query === previous) query = queries[(i + 1) % queries.length];
    previous = query;
    const ms = await page.evaluate(async ({ query }) => {
      const input = document.querySelector('input[aria-label="搜索项目任务"]');
      const container = document.querySelector(".project-grid");
      const watch = window.__perf.observe(container);
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      const t0 = performance.now();
      setValue.call(input, query);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const settled = await window.__perf.settle(watch, 400);
      return { ms: settled - t0, mutated: watch.last !== null };
    }, { query });
    if (ms.mutated) samples.push(ms.ms); else skipped.push(query);
  }
  return { ...summarize(samples), skipped };
}

async function measurePopover(page, runs) {
  await page.getByRole("button", { name: "日历", exact: true }).click();
  await page.waitForSelector("#task-pool");
  // 项目优先后任务行只在展开的项目里渲染；大项目默认收起，先展开第一个再测编辑气泡。
  if (await page.locator("#task-pool [data-editor-anchor]").count() === 0) {
    const firstProject = page.locator("#task-pool .project-group-header").first();
    if (await firstProject.count()) await firstProject.click();
  }
  await page.waitForSelector("#task-pool [data-editor-anchor]");
  await page.evaluate(installPerfHelpers);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const samples = [];
  const labels = [];
  for (let i = 0; i < runs; i += 1) {
    const result = await page.evaluate(async (index) => {
      const buttons = Array.from(document.querySelectorAll("#task-pool [data-editor-anchor]"));
      if (buttons.length === 0) return { ms: null, label: null };
      const button = buttons[index % buttons.length];
      const label = button.getAttribute("aria-label");
      const watch = window.__perf.observe(document.body);
      const t0 = performance.now();
      button.click();
      const settled = await window.__perf.settle(watch, 200);
      const dialog = document.querySelector('[role="dialog"]');
      return { ms: settled - t0, label, visible: Boolean(dialog && dialog.getBoundingClientRect().height > 0) };
    }, i);
    if (result.ms !== null && result.visible) { samples.push(result.ms); labels.push(result.label); }
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="dialog"]', { state: "detached" });
  }
  return { ...summarize(samples), targets: labels.length };
}

async function measureMonthReview(page, runs) {
  await page.getByRole("button", { name: "回顾", exact: true }).click();
  await page.waitForSelector(".review-page");
  const period = page.getByRole("group", { name: "回顾周期" });
  await period.getByRole("button", { name: "月" }).click();
  await page.waitForSelector(".review-page .review-charts, .review-page .empty-state");
  for (let i = 0; i < 3; i += 1) {
    await period.getByRole("button", { name: "日" }).click();
    await period.getByRole("button", { name: "月" }).click();
  }
  await page.evaluate(installPerfHelpers);

  const samples = [];
  const switchTo = (label) => page.evaluate((label) => {
    const group = document.querySelector('[role="group"][aria-label="回顾周期"]');
    Array.from(group.querySelectorAll("button")).find((button) => button.textContent.trim() === label)?.click();
  }, label);

  for (let i = 0; i < runs; i += 1) {
    await switchTo("日");
    await page.waitForTimeout(30);
    const ms = await page.evaluate(async () => {
      const container = document.querySelector(".review-page");
      const group = document.querySelector('[role="group"][aria-label="回顾周期"]');
      const target = Array.from(group.querySelectorAll("button")).find((button) => button.textContent.trim() === "月");
      const watch = window.__perf.observe(container);
      const t0 = performance.now();
      target.click();
      const settled = await window.__perf.settle(watch, 200);
      return settled - t0;
    });
    samples.push(ms);
  }
  return summarize(samples);
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.sample)) {
    throw new Error(`找不到性能样本 ${args.sample}；先运行 node scripts/fixtures/perf-sample.mjs --out ${args.sample} --anchor 2026-10-16 --seed 20260910`);
  }
  const sample = JSON.parse(await readFile(args.sample, "utf8"));

  if (!args.skipBuild) await buildProduction();

  const engine = args.skipEngine ? null : await measureEngine(sample, args.monthRuns);

  const server = await startPreview(args.port);
  let browser;
  let browserResults;
  try {
    browser = await chromium.launch({ headless: !args.headed });
    const context = await browser.newContext({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 1 });
    const baseUrl = `http://127.0.0.1:${args.port}/`;

    // 检索用的确定性查询串：包含空串（最重，全部任务都渲染）与几个命中片段。
    const queries = ["", "课", "任务", "第", "章", "练", "Rust", "数据", "3", "作业"];
    let search; let popover; let monthReview;
    if (args.sequential) {
      // 单项全部在同一个页面上连着测：后测的项目带着前一项留下的 DOM 与堆压力。
      // 作为「最坏情况」对照，不作为预算判据（预算要求预热后的稳态）。
      const page = await context.newPage();
      await seedAndOpen(page, sample, baseUrl);
      search = await measureSearch(page, queries, args.searchRuns);
      popover = await measurePopover(page, args.popoverRuns);
      monthReview = await measureMonthReview(page, args.monthRuns);
      await page.close();
    } else {
      search = await onFreshPage(context, sample, baseUrl, (page) => measureSearch(page, queries, args.searchRuns));
      popover = await onFreshPage(context, sample, baseUrl, (page) => measurePopover(page, args.popoverRuns));
      monthReview = await onFreshPage(context, sample, baseUrl, (page) => measureMonthReview(page, args.monthRuns));
    }
    browserResults = { search, popover, monthReview, queries };
    await context.close();
  } finally {
    if (browser) await browser.close();
    server.kill();
    await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(3_000)]);
  }

  const budgets = {
    searchStableP95: 200,
    popoverOpenMax: 150,
    monthReviewMax: 100,
  };
  const verdict = {
    searchStableP95: browserResults.search.p95 <= budgets.searchStableP95,
    popoverOpenMax: browserResults.popover.max <= budgets.popoverOpenMax,
    monthReviewMax: browserResults.monthReview.max <= budgets.monthReviewMax,
  };

  const payload = {
    generatedAt: new Date().toISOString(),
    machine: machineInfo(),
    mode: args.sequential ? "sequential（三项同一页面，最坏情况对照）" : "isolated（每项独立页面，预算判据）",
    sample: {
      path: args.sample,
      seed: sample.args?.seed ?? null,
      anchor: sample.stats?.anchorDate ?? null,
      windowStart: sample.stats?.windowStart ?? null,
      windowDays: sample.stats?.windowDays ?? null,
      counts: sample.stats?.counts ?? null,
      // 与 fixture 打印的口径一致：对 workspace 的 JSON 取 sha256 前 16 位。
      workspaceSha256Prefix16: createHash("sha256").update(JSON.stringify(sample.workspace)).digest("hex").slice(0, 16),
      workspaceBytes: JSON.stringify(sample.workspace).length,
    },
    budgets,
    verdict,
    browser: browserResults,
    engine,
  };

  await mkdir(join(projectRoot, "output"), { recursive: true });
  await writeFile(args.out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log("\n=== P4-09 性能测量（生产构建 + 真实 Chromium）===");
  console.log(`机器：${payload.machine.cpuModel} / ${payload.machine.cpuCount} 核 / ${payload.machine.totalMemoryGb} GB / ${payload.machine.platform} ${payload.machine.release}`);
  console.log(`样本：seed=${payload.sample.seed} anchor=${payload.sample.anchor} 课程 ${payload.sample.counts?.courses} / 任务 ${payload.sample.counts?.tasks} / 历史 ${payload.sample.counts?.historyTotal}`);
  const line = (name, s, budget, ok) => console.log(`  ${name.padEnd(22)} p50 ${String(s.p50).padStart(7)}ms  p95 ${String(s.p95).padStart(7)}ms  max ${String(s.max).padStart(7)}ms  （预算 ${budget}ms）${ok ? " ✓" : " ✗"}`);
  line("搜索→列表稳定", browserResults.search, budgets.searchStableP95, verdict.searchStableP95);
  line("气泡打开", browserResults.popover, budgets.popoverOpenMax, verdict.popoverOpenMax);
  line("月回顾（页面显示）", browserResults.monthReview, budgets.monthReviewMax, verdict.monthReviewMax);
  if (engine) {
    console.log(`  月回顾（纯引擎计算）  p50 ${engine.month.p50}ms  p95 ${engine.month.p95}ms  max ${engine.month.max}ms`);
    console.log(`  周／日（纯引擎计算）  week p50 ${engine.week.p50}ms  day p50 ${engine.day.p50}ms`);
  }
  console.log(`\n结果已写出：${args.out}`);
  process.exitCode = Object.values(verdict).every(Boolean) ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
