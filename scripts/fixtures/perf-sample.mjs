#!/usr/bin/env node
/**
 * 阶段 4 P4-01 的可重复性能样本生成器。
 *
 * 依据 `docs/specs/0005-phase-4-daily-workflow-and-reliability.md` §8：
 *   100 项课程、1,000 项任务、10,000 条混合历史记录，固定随机种子与测试机器信息。
 *
 * 特性：
 *   - 纯确定性：同一个 `--seed` + 同一个 `--anchor` 必然产出字节级相同的 JSON。
 *   - 自校验：默认跑一组领域不变量检查，任何一条不成立即非零退出。
 *   - 只读边界：本脚本不连接 SQLite / Tauri / 备份协议，只产出浏览器预览层可用的快照 JSON。
 *
 * 用法：
 *   node scripts/fixtures/perf-sample.mjs                                   # 打印统计，不落盘
 *   node scripts/fixtures/perf-sample.mjs --out perf-sample.json            # 落盘
 *   node scripts/fixtures/perf-sample.mjs --anchor 2026-09-10 --seed 1      # 完全冻结
 *   node scripts/fixtures/perf-sample.mjs --courses 20 --tasks 100 --history 500
 *
 * 产出 JSON 结构：
 *   { generatedAt, machine, args, stats, preferences, workspace }
 *
 * 灌进浏览器预览层（E2E / 手工验收）：
 *   const s = require("./perf-sample.json");
 *   localStorage.setItem("daymark.phase1.workspace", JSON.stringify(s.workspace));
 *   localStorage.setItem("daymark.phase0.preferences", JSON.stringify(s.preferences));
 *
 * 注意：`machine` 与 `generatedAt` 不参与确定性比较；比较产物时只比对 `workspace` 与 `stats`。
 */

import { createHash } from "node:crypto";
import { cpus, totalmem, platform, arch, release, version as osVersion } from "node:os";
import { writeFileSync } from "node:fs";

// ---------------------------------------------------------------- 参数

const DEFAULTS = {
  seed: 20260910,
  courses: 100,
  tasks: 1000,
  history: 10000,
  anchor: null, // null => 用运行时的本地今天
  windowDays: 180,
  out: null,
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (key === "no-validate") { args.validate = false; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) continue;
    i += 1;
    switch (key) {
      case "seed": args.seed = Number(value); break;
      case "courses": args.courses = Number(value); break;
      case "tasks": args.tasks = Number(value); break;
      case "history": args.history = Number(value); break;
      case "window": args.windowDays = Number(value); break;
      case "anchor": args.anchor = value; break;
      case "out": args.out = value; break;
      default: throw new Error(`未知参数 --${key}`);
    }
  }
  if (args.validate === undefined) args.validate = true;
  for (const key of ["seed", "courses", "tasks", "history", "windowDays"]) {
    if (!Number.isFinite(args[key]) || args[key] < 0) throw new Error(`--${key} 必须是非负有限数，收到 ${args[key]}`);
  }
  return args;
}

// ---------------------------------------------------------------- 确定性随机

/** mulberry32：小、快、可重复。同一 seed 永远给出同一序列。 */
function createRng(seed) {
  let state = (seed >>> 0) || 1;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeHelpers(rng) {
  const int = (min, max) => min + Math.floor(rng() * (max - min + 1));
  const pick = (items) => items[Math.floor(rng() * items.length)];
  const chance = (probability) => rng() < probability;
  const weighted = (pairs) => {
    const total = pairs.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = rng() * total;
    for (const [value, weight] of pairs) { roll -= weight; if (roll <= 0) return value; }
    return pairs[pairs.length - 1][0];
  };
  /** 用同一条序列的整数抽样时避免浮点误差：直接取整。 */
  const intFrom = (min, max) => int(min, max);
  return { int, intFrom, pick, chance, weighted };
}

// ---------------------------------------------------------------- 日期与时间

const pad = (value, width = 2) => String(value).padStart(width, "0");

function toUtcDate(localDate) {
  const [year, month, day] = localDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function fromUtcDate(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** 日历加减，不用固定毫秒数（避免夏令时/月末误差）。 */
function addDays(localDate, amount) {
  const date = toUtcDate(localDate);
  date.setUTCDate(date.getUTCDate() + amount);
  return fromUtcDate(date);
}

function isLocalDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function clock(minutes) {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}

/** 本地日期 + 本地分钟 -> RFC 3339 UTC 字符串。offsetMinutes 为本地相对 UTC 的分钟数。 */
function utcInstant(localDate, localMinutes, offsetMinutes) {
  const base = toUtcDate(localDate).getTime();
  const instant = base + localMinutes * 60_000 - offsetMinutes * 60_000;
  return new Date(instant).toISOString();
}

function localToday() {
  const now = new Date();
  return fromUtcDate(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}

// ---------------------------------------------------------------- 样本规模

/** 把 history 总数按固定比例拆成五类历史记录，余数补给第一类以保证总数精确。 */
function historyBreakdown(total) {
  const shares = [
    ["progressEvents", 0.50],
    ["executionSessions", 0.30],
    ["executionRecords", 0.15],
    ["timeBlocks", 0.03],
    ["habitOccurrences", 0.02],
  ];
  const counts = {};
  let assigned = 0;
  for (const [name, share] of shares) {
    counts[name] = Math.floor(total * share);
    assigned += counts[name];
  }
  counts.progressEvents += total - assigned;
  return counts;
}

const COURSE_PREFIXES = ["基础", "进阶", "实战", "专题", "精读", "快速上手", "系统课", "案例拆解"];
const COURSE_TOPICS = ["数据结构", "配色原理", "剪辑节奏", "前端工程", "SQL 调优", "运镜构图", "排版规范", "提示词工程", "音频处理", "产品复盘"];
const TASK_VERBS = ["阅读", "练习", "整理笔记", "复现", "对比", "总结", "动手实现", "复盘"];
const BLOCK_TITLES = ["通勤", "午休", "会议", "家务", "运动", "外出"];
const HABIT_TITLES = ["晨跑", "背单词", "手绘练习", "写日记", "拉伸", "读书"];
const NOTE_SAMPLES = ["", "状态一般", "比预期快", "被打断两次", "顺手记下来", "注意力不错"];

// ---------------------------------------------------------------- 生成

export function buildPerfSample(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const anchor = config.anchor ?? localToday();
  if (!isLocalDate(anchor)) throw new Error(`anchor 不是合法本地日期: ${anchor}`);

  const rng = createRng(config.seed);
  const { int, pick, chance, weighted } = makeHelpers(rng);
  const offset = 480; // 固定 +08:00，保证产物确定
  const windowStart = addDays(anchor, -config.windowDays);

  const workspace = {
    projects: [],
    projectMilestones: [],
    milestoneOutcomes: [],
    tasks: [],
    executionSessions: [],
    executionRecords: [],
    progressEvents: [],
    timeBlocks: [],
    recurringHabits: [],
    habitOccurrences: [],
    rescuePromptedSessionIds: [],
  };

  // ---- 课程（项目）+ 任务 ----
  const courseCount = Math.max(0, Math.floor(config.courses));
  // 习惯会生成内部任务（kind=habit），先从总预算里扣除，保证 stats.counts.tasks === --tasks
  const habitCount = Math.min(8, Math.max(3, Math.floor(courseCount / 20)), Math.floor(config.tasks));
  const taskBudget = Math.max(0, Math.floor(config.tasks) - habitCount);
  const perCourse = courseCount > 0 ? Math.max(1, Math.floor(taskBudget / courseCount)) : 0;

  for (let index = 0; index < courseCount; index += 1) {
    const projectId = `course-${pad(index, 4)}`;
    const title = `${pick(COURSE_PREFIXES)}${pick(COURSE_TOPICS)} · ${pad(index + 1, 3)}`;
    const hasDeadline = chance(0.45);
    workspace.projects.push({
      id: projectId,
      title,
      deadlineLocal: hasDeadline ? addDays(anchor, int(-30, 60)) : null,
    });

    const episodes = Math.min(perCourse, taskBudget - workspace.tasks.length);
    for (let episode = 0; episode < episodes; episode += 1) {
      const taskId = `task-${pad(workspace.tasks.length, 5)}`;
      const target = weighted([[0, 18], [25, 16], [50, 20], [75, 16], [100, 30]]);
      workspace.tasks.push({
        id: taskId,
        projectId,
        title: `P${pad(episode + 1, 2)} ${pick(TASK_VERBS)}${pick(COURSE_TOPICS).slice(0, 4)}`,
        progress: target,
        status: target === 100 ? "completed" : chance(0.05) ? "paused" : "active",
        deadlineLocal: chance(0.30) ? addDays(anchor, int(-45, 45)) : null,
        estimatedMinutes: pick([15, 20, 30, 45, 60, 90, 120]),
        sessionMinutes: pick([15, 25, 30, 45, 60]),
        priority: pick(["low", "normal", "normal", "high"]),
        sortOrder: episode,
        sourceUrl: chance(0.5) ? `https://www.bilibili.com/video/BV1${pad(int(0, 99999), 5)}` : null,
        sourceKey: chance(0.5) ? `P${episode + 1}` : null,
        mediaMinutes: chance(0.6) ? pick([8, 12, 18, 25, 40]) : null,
        kind: "task",
      });
    }
  }

  // 预算有剩余时补成独立任务（不归属项目）
  while (workspace.tasks.length < taskBudget) {
    const target = weighted([[0, 25], [50, 25], [100, 25], [75, 25]]);
    workspace.tasks.push({
      id: `task-${pad(workspace.tasks.length, 5)}`,
      projectId: null,
      title: `${pick(TASK_VERBS)}${pick(COURSE_TOPICS)}`,
      progress: target,
      status: target === 100 ? "completed" : "active",
      deadlineLocal: chance(0.25) ? addDays(anchor, int(-20, 30)) : null,
      estimatedMinutes: pick([20, 30, 60]),
      sessionMinutes: pick([20, 30, 60]),
      priority: "normal",
      sortOrder: workspace.tasks.length,
      kind: "task",
    });
  }

  // ---- 习惯（含内部任务，用于验证 M10 的过滤规则）----
  for (let index = 0; index < habitCount; index += 1) {
    const taskId = `habit-task-${pad(index, 3)}`;
    const habitId = `habit-${pad(index, 3)}`;
    const pattern = pick(["daily", "weekdays", "weekly"]);
    workspace.tasks.push({
      id: taskId,
      projectId: null,
      title: HABIT_TITLES[index % HABIT_TITLES.length],
      progress: 0,
      status: "active",
      deadlineLocal: null,
      estimatedMinutes: pick([15, 20, 30]),
      sessionMinutes: pick([15, 20, 30]),
      priority: "normal",
      sortOrder: 9000 + index,
      kind: "habit",
    });
    workspace.recurringHabits.push({
      id: habitId,
      taskId,
      title: HABIT_TITLES[index % HABIT_TITLES.length],
      pattern,
      weekdays: pattern === "weekdays" ? [1, 2, 3, 4, 5] : pattern === "weekly" ? [index % 7] : [0, 1, 2, 3, 4, 5, 6],
      startDate: addDays(anchor, -int(30, config.windowDays)),
      sessionMinutes: pick([15, 20, 30]),
      preferredStartLocal: chance(0.5) ? clock(int(6 * 60, 21 * 60)) : null,
      status: chance(0.85) ? "active" : "paused",
    });
  }

  // ---- 金额拆分 ----
  const breakdown = historyBreakdown(Math.max(0, Math.floor(config.history)));

  // ---- 进度事件：每条任务一条时间递增的链条 ----
  // 关键约束：同一条任务的事件时间必须严格递增，否则全局按时间排序后链条会断裂。
  const chainBudget = breakdown.progressEvents;
  const lastDayByTask = new Map();
  for (const task of workspace.tasks) {
    if (workspace.progressEvents.length >= chainBudget) break;
    const chain = [];
    let current = 0;
    let day = rng() < 0.5 ? windowStart : addDays(anchor, -int(1, config.windowDays));
    const stopAt = task.progress;
    let guard = 0;
    while (current !== stopAt && guard < 12) {
      guard += 1;
      const step = int(10, 40);
      let next = Math.min(100, current + step);
      if (chain.length === 0 && stopAt === 0) break;
      if (next > stopAt && stopAt > current) next = stopAt;
      chain.push({ from: current, to: next, day });
      day = addDays(day, int(1, 9));
      current = next;
    }
    // 偶尔来一次下调，用于验证"净进度可为负"
    if (chain.length > 1 && chance(0.12)) {
      const from = chain[chain.length - 1].to;
      const to = Math.max(0, from - int(10, 30));
      chain.push({ from, to, day: addDays(day, int(1, 5)) });
      task.progress = to;
      task.status = to === 100 ? "completed" : "active";
    }
    for (const step of chain) {
      if (workspace.progressEvents.length >= chainBudget) break;
      workspace.progressEvents.push({
        id: `pe-${pad(workspace.progressEvents.length, 6)}`,
        taskId: task.id,
        fromProgress: step.from,
        toProgress: step.to,
        occurredAtUtc: utcInstant(step.day, int(7 * 60, 22 * 60), offset),
      });
      lastDayByTask.set(task.id, step.day);
    }
  }

  // 链条不够就补：对已有任务再追加一轮"微调"，始终维持 from == 上一条的 to，
  // 且日期必须晚于该任务上一次使用的日期，保证全局排序后同任务事件仍按发生顺序排列。
  let filler = 0;
  while (workspace.progressEvents.length < chainBudget && workspace.tasks.length > 0) {
    const task = workspace.tasks[filler % workspace.tasks.length];
    filler += 1;
    const previous = workspace.progressEvents.filter((event) => event.taskId === task.id).at(-1);
    const from = previous ? previous.toProgress : 0;
    const to = from >= 100 ? Math.max(0, from - int(5, 20)) : Math.min(100, from + int(5, 20));
    const day = addDays(lastDayByTask.get(task.id) ?? windowStart, int(1, 5));
    lastDayByTask.set(task.id, day);
    workspace.progressEvents.push({
      id: `pe-${pad(workspace.progressEvents.length, 6)}`,
      taskId: task.id,
      fromProgress: from,
      toProgress: to,
      occurredAtUtc: utcInstant(day, int(7 * 60, 22 * 60), offset),
    });
  }
  workspace.progressEvents.length = chainBudget;

  // 每类事件按发生时间排列，让"同刻先后不可证明"的情形只出现在相邻同刻
  workspace.progressEvents.sort((a, b) => a.occurredAtUtc.localeCompare(b.occurredAtUtc) || a.id.localeCompare(b.id));

  // 任务最终进度必须等于自己最后一条事件的 toProgress
  const lastEventByTask = new Map();
  for (const event of workspace.progressEvents) lastEventByTask.set(event.taskId, event);
  for (const task of workspace.tasks) {
    const last = lastEventByTask.get(task.id);
    if (!last) continue;
    task.progress = last.toProgress;
    if (task.kind !== "habit") task.status = last.toProgress === 100 ? "completed" : task.status === "paused" ? "paused" : "active";
  }

  // ---- 执行时段 ----
  const sessionBudget = breakdown.executionSessions;
  for (let index = 0; index < sessionBudget; index += 1) {
    const task = pick(workspace.tasks);
    const inFuture = chance(0.12);
    const localDate = inFuture ? addDays(anchor, int(1, 30)) : addDays(anchor, -int(0, config.windowDays));
    const crossMidnight = chance(0.06);
    // 跨午夜必须真的越过 00:00：开始压到 22:30 之后，结束落在次日 00:10–01:40。
    // 同日时把开始限制在 21:00 前，保证 endLocal 严格大于 startLocal 且不溢出到第二天。
    const startMinute = crossMidnight ? 1440 - int(20, 90) : int(6 * 60, 21 * 60);
    const endMinute = crossMidnight ? int(10, 100) : startMinute + pick([15, 20, 30, 45, 60, 90, 120]);
    const status = inFuture
      ? "scheduled"
      : task.status === "completed"
        ? pick(["scheduled", "scheduled", "skipped"])
        : weighted([["scheduled", 55], ["missed", 25], ["cancelled", 12], ["skipped", 8]]);
    workspace.executionSessions.push({
      id: `session-${pad(index, 5)}`,
      taskId: task.id,
      localDate,
      endLocalDate: crossMidnight ? addDays(localDate, 1) : localDate,
      startLocal: clock(startMinute),
      endLocal: clock(endMinute),
      timeZone: "Asia/Shanghai",
      utcOffsetMinutes: chance(0.05) ? null : offset,
      status,
    });
  }

  // ---- 实际执行记录：关联过去已完成/未完成的时段，最多留一条未结束 ----
  const recordBudget = breakdown.executionRecords;
  const pastSessions = workspace.executionSessions.filter((session) => session.localDate <= anchor);
  let openRecordUsed = false;
  for (let index = 0; index < recordBudget; index += 1) {
    const session = pastSessions.length ? pick(pastSessions) : null;
    const task = session ? workspace.tasks.find((item) => item.id === session.taskId) ?? pick(workspace.tasks) : pick(workspace.tasks);
    const localDate = session ? session.localDate : addDays(anchor, -int(0, config.windowDays));
    const [startHour, startMin] = (session ? session.startLocal : clock(int(6 * 60, 22 * 60))).split(":").map(Number);
    const startMinutes = startHour * 60 + startMin + int(-20, 20);
    const duration = pick([10, 15, 25, 40, 60, 90]);
    const isOpen = !openRecordUsed && chance(0.02);
    if (isOpen) openRecordUsed = true;
    workspace.executionRecords.push({
      id: `record-${pad(index, 5)}`,
      sessionId: session ? session.id : null,
      taskId: task.id,
      actualStartUtc: utcInstant(localDate, startMinutes, offset),
      actualEndUtc: isOpen ? null : utcInstant(localDate, startMinutes + duration, offset),
      note: pick(NOTE_SAMPLES),
    });
  }

  // ---- 时间块 ----
  for (let index = 0; index < breakdown.timeBlocks; index += 1) {
    const localDate = addDays(anchor, -int(0, config.windowDays));
    const crossMidnight = chance(0.05);
    // 与执行时段同规则：跨午夜必须真的越过 00:00
    const startMinute = crossMidnight ? 1440 - int(20, 120) : int(5 * 60, 20 * 60);
    const endMinute = crossMidnight ? int(10, 150) : startMinute + pick([15, 30, 45, 60, 120, 240]);
    workspace.timeBlocks.push({
      id: `block-${pad(index, 4)}`,
      title: pick(BLOCK_TITLES),
      localDate,
      endLocalDate: crossMidnight ? addDays(localDate, 1) : localDate,
      startLocal: clock(startMinute),
      endLocal: clock(endMinute),
      timeZone: "Asia/Shanghai",
      utcOffsetMinutes: offset,
    });
  }

  // ---- 习惯发生项 ----
  for (let index = 0; index < breakdown.habitOccurrences; index += 1) {
    const habit = pick(workspace.recurringHabits);
    const localDate = addDays(anchor, -int(0, config.windowDays));
    const status = weighted([["scheduled", 40], ["completed", 45], ["skipped", 15]]);
    const linked = status !== "skipped" && chance(0.7)
      ? `session-${pad(int(0, Math.max(0, sessionBudget - 1)), 5)}`
      : null;
    workspace.habitOccurrences.push({
      id: `occ-${pad(index, 4)}`,
      habitId: habit.id,
      localDate,
      status,
      sessionId: linked,
    });
  }

  // ---- 里程碑与到期结果快照 ----
  for (const project of workspace.projects) {
    if (!chance(0.6)) continue;
    const milestones = int(1, 3);
    for (let index = 0; index < milestones; index += 1) {
      const targetLocalDate = addDays(anchor, int(-90, 90));
      const criterion = weighted([["projectProgress", 60], ["orderedTask", 25], ["taskCount", 15]]);
      const projectTasks = workspace.tasks.filter((task) => task.projectId === project.id);
      if (criterion === "orderedTask" && projectTasks.length === 0) continue;
      workspace.projectMilestones.push(criterion === "orderedTask"
        ? { id: `ms-${project.id}-${index}`, projectId: project.id, title: `${project.title} 阶段 ${index + 1}`, targetLocalDate, sortOrder: index, criterionKind: "orderedTask", targetTaskId: projectTasks[projectTasks.length - 1].id, targetCount: null, targetProgress: null }
        : criterion === "taskCount"
          ? { id: `ms-${project.id}-${index}`, projectId: project.id, title: `${project.title} 阶段 ${index + 1}`, targetLocalDate, sortOrder: index, criterionKind: "taskCount", targetTaskId: null, targetCount: Math.max(1, int(1, 5)), targetProgress: null }
          : { id: `ms-${project.id}-${index}`, projectId: project.id, title: `${project.title} 阶段 ${index + 1}`, targetLocalDate, sortOrder: index, criterionKind: "projectProgress", targetTaskId: null, targetCount: null, targetProgress: int(20, 90) });
    }
  }

  for (const milestone of workspace.projectMilestones) {
    if (milestone.targetLocalDate >= anchor) continue; // 未到期不冻结
    const reached = chance(0.5);
    workspace.milestoneOutcomes.push({
      id: `outcome-${milestone.id}`,
      milestoneId: milestone.id,
      projectId: milestone.projectId,
      title: milestone.title,
      targetLocalDate: milestone.targetLocalDate,
      reached,
      resultText: reached ? "到期时已达成" : "到期时未达成",
      frozenAtUtc: utcInstant(milestone.targetLocalDate, 23 * 60 + 59, offset),
    });
  }

  // ---- 挽救提示事实 ----
  for (const session of workspace.executionSessions) {
    if (workspace.rescuePromptedSessionIds.length >= 25) break;
    if (session.localDate < anchor && session.status === "scheduled" && chance(0.03)) {
      workspace.rescuePromptedSessionIds.push(session.id);
    }
  }

  const stats = {
    anchorDate: anchor,
    windowStart,
    windowDays: config.windowDays,
    counts: {
      projects: workspace.projects.length,
      courses: courseCount,
      tasks: workspace.tasks.length,
      tasksInProjects: workspace.tasks.filter((task) => task.projectId !== null).length,
      tasksStandalone: workspace.tasks.filter((task) => task.projectId === null && task.kind !== "habit").length,
      habitTasks: workspace.tasks.filter((task) => task.kind === "habit").length,
      projectMilestones: workspace.projectMilestones.length,
      milestoneOutcomes: workspace.milestoneOutcomes.length,
      executionSessions: workspace.executionSessions.length,
      executionRecords: workspace.executionRecords.length,
      openExecutionRecords: workspace.executionRecords.filter((record) => record.actualEndUtc === null).length,
      progressEvents: workspace.progressEvents.length,
      timeBlocks: workspace.timeBlocks.length,
      recurringHabits: workspace.recurringHabits.length,
      habitOccurrences: workspace.habitOccurrences.length,
      rescuePromptedSessionIds: workspace.rescuePromptedSessionIds.length,
      historyTotal:
        workspace.executionSessions.length +
        workspace.executionRecords.length +
        workspace.progressEvents.length +
        workspace.timeBlocks.length +
        workspace.habitOccurrences.length,
    },
  };

  const preferences = {
    appearance: "system",
    motion: "full",
    scale: 100,
    lastPage: "calendar",
    calendarView: "week",
    calendarAnchors: { day: anchor, week: anchor, month: anchor },
    calendarZoom: { day: "standard", week: "standard", month: "standard" },
    calendarScale: { day: 48, week: 48, month: 82 },
    calendarDayMode: "fullDay",
    showActualRecords: true,
    showActualRecordsControl: true,
    taskPoolWidth: null,
    snapMinutes: 15,
    defaultSessionMinutes: 60,
    minimumSessionMinutes: 15,
    autoScheduleAssist: false,
    checkInEnabled: false,
    checkInGraceMinutes: 5,
    rescuePromptsEnabled: true,
    remindersEnabled: false,
    reminderLeadMinutes: 10,
    startupSummary: "never",
    lastStartupSummaryLocalDate: null,
    defaultTimeSlots: [{ id: "evening", label: "晚间专注", start: "19:00", end: "22:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }],
  };

  return { workspace, preferences, stats };
}

// ---------------------------------------------------------------- 自校验

/**
 * 领域不变量检查。产物要能被应用与测试安全消费，就必须先满足这些前提。
 * 返回问题数组；空数组表示全部通过。
 */
export function validateSample(workspace) {
  const problems = [];
  const fail = (message) => problems.push(message);
  const taskIds = new Set(workspace.tasks.map((task) => task.id));
  const sessionIds = new Set(workspace.executionSessions.map((session) => session.id));
  const habitIds = new Set(workspace.recurringHabits.map((habit) => habit.id));
  const projectIds = new Set(workspace.projects.map((project) => project.id));
  const milestoneIds = new Set(workspace.projectMilestones.map((milestone) => milestone.id));

  const duplicate = (items, label) => {
    const seen = new Set();
    for (const item of items) {
      if (seen.has(item.id)) fail(`${label} 存在重复 id: ${item.id}`);
      seen.add(item.id);
    }
  };
  duplicate(workspace.projects, "projects");
  duplicate(workspace.tasks, "tasks");
  duplicate(workspace.executionSessions, "executionSessions");
  duplicate(workspace.executionRecords, "executionRecords");
  duplicate(workspace.progressEvents, "progressEvents");
  duplicate(workspace.timeBlocks, "timeBlocks");
  duplicate(workspace.recurringHabits, "recurringHabits");
  duplicate(workspace.habitOccurrences, "habitOccurrences");
  duplicate(workspace.projectMilestones, "projectMilestones");

  const dateFields = [
    [workspace.projects, ["deadlineLocal"], "project"],
    [workspace.tasks, ["deadlineLocal"], "task"],
    [workspace.executionSessions, ["localDate", "endLocalDate"], "session"],
    [workspace.timeBlocks, ["localDate", "endLocalDate"], "timeBlock"],
    [workspace.recurringHabits, ["startDate"], "habit"],
    [workspace.habitOccurrences, ["localDate"], "occurrence"],
    [workspace.projectMilestones, ["targetLocalDate"], "milestone"],
  ];
  for (const [items, fields, label] of dateFields) {
    for (const item of items) {
      for (const field of fields) {
        const value = item[field];
        if (value === null || value === undefined) continue;
        if (!isLocalDate(value)) fail(`${label} ${item.id}.${field} 不是合法本地日期: ${value}`);
      }
    }
  }

  const clockFields = [
    [workspace.executionSessions, ["startLocal", "endLocal"], "session"],
    [workspace.timeBlocks, ["startLocal", "endLocal"], "timeBlock"],
  ];
  for (const [items, fields, label] of clockFields) {
    for (const item of items) {
      for (const field of fields) {
        if (!/^\d{2}:\d{2}$/.test(item[field] ?? "")) fail(`${label} ${item.id}.${field} 不是合法时钟: ${item[field]}`);
      }
    }
  }

  for (const task of workspace.tasks) {
    if (!Number.isInteger(task.progress) || task.progress < 0 || task.progress > 100) {
      fail(`task ${task.id} progress 越界: ${task.progress}`);
    }
    if (task.projectId !== null && !projectIds.has(task.projectId)) fail(`task ${task.id} 指向不存在的项目 ${task.projectId}`);
    if (task.progress === 100 && task.status !== "completed") fail(`task ${task.id} progress=100 但 status=${task.status}`);
    if (task.progress !== 100 && task.status === "completed") fail(`task ${task.id} status=completed 但 progress=${task.progress}`);
  }

  /** 跨日规则：跨午夜必须写成"次日 + endLocal 小于 startLocal"，同日必须 endLocal 大于 startLocal。 */
  const checkSpan = (item, label) => {
    const nextDay = item.endLocalDate !== item.localDate;
    if (nextDay && item.endLocalDate !== addDays(item.localDate, 1)) {
      fail(`${label} ${item.id} 跨日但 endLocalDate 不是次日本地日期: ${item.localDate} -> ${item.endLocalDate}`);
    }
    if (nextDay && item.endLocal >= item.startLocal) {
      fail(`${label} ${item.id} 跨午夜但 endLocal(${item.endLocal}) >= startLocal(${item.startLocal})`);
    }
    if (!nextDay && item.endLocal <= item.startLocal) {
      fail(`${label} ${item.id} 同日但 endLocal(${item.endLocal}) <= startLocal(${item.startLocal})`);
    }
  };

  for (const session of workspace.executionSessions) {
    if (!taskIds.has(session.taskId)) fail(`session ${session.id} 指向不存在的任务 ${session.taskId}`);
    const offset = session.utcOffsetMinutes;
    if (offset !== null && (!Number.isInteger(offset) || offset < -840 || offset > 840)) {
      fail(`session ${session.id} utcOffsetMinutes 越界: ${offset}`);
    }
    checkSpan(session, "session");
  }
  for (const block of workspace.timeBlocks) checkSpan(block, "timeBlock");

  const open = workspace.executionRecords.filter((record) => record.actualEndUtc === null);
  if (open.length > 1) fail(`存在 ${open.length} 条未结束执行记录，最多允许 1 条`);
  for (const record of workspace.executionRecords) {
    if (!taskIds.has(record.taskId)) fail(`record ${record.id} 指向不存在的任务 ${record.taskId}`);
    if (record.sessionId !== null && !sessionIds.has(record.sessionId)) fail(`record ${record.id} 指向不存在的时段 ${record.sessionId}`);
    if (!/Z$/.test(record.actualStartUtc)) fail(`record ${record.id} actualStartUtc 不是 Z 结尾的 RFC 3339: ${record.actualStartUtc}`);
    if (record.actualEndUtc !== null) {
      if (!/Z$/.test(record.actualEndUtc)) fail(`record ${record.id} actualEndUtc 不是 Z 结尾的 RFC 3339`);
      if (record.actualEndUtc <= record.actualStartUtc) fail(`record ${record.id} 结束不晚于开始`);
    }
  }

  const lastByTask = new Map();
  for (const event of workspace.progressEvents) {
    if (!taskIds.has(event.taskId)) fail(`progressEvent ${event.id} 指向不存在的任务 ${event.taskId}`);
    if (event.fromProgress < 0 || event.fromProgress > 100 || event.toProgress < 0 || event.toProgress > 100) {
      fail(`progressEvent ${event.id} 进度越界: ${event.fromProgress}->${event.toProgress}`);
    }
    if (!/Z$/.test(event.occurredAtUtc)) fail(`progressEvent ${event.id} occurredAtUtc 不是 Z 结尾的 RFC 3339`);
    const previous = lastByTask.get(event.taskId);
    if (previous && previous.toProgress !== event.fromProgress) {
      fail(`progressEvent ${event.id} 链条断裂: 上一条 to=${previous.toProgress} 但本条 from=${event.fromProgress}`);
    }
    lastByTask.set(event.taskId, event);
  }
  for (const task of workspace.tasks) {
    const last = lastByTask.get(task.id);
    if (last && last.toProgress !== task.progress) {
      fail(`task ${task.id} 当前进度 ${task.progress} 与最后一条事件 to=${last.toProgress} 不一致`);
    }
  }

  for (const milestone of workspace.projectMilestones) {
    const kinds = [milestone.criterionKind === "orderedTask", milestone.criterionKind === "taskCount", milestone.criterionKind === "projectProgress"];
    if (kinds.filter(Boolean).length !== 1) fail(`milestone ${milestone.id} 达成条件不是恰好一种`);
    if (!projectIds.has(milestone.projectId)) fail(`milestone ${milestone.id} 指向不存在的项目`);
    if (milestone.criterionKind === "orderedTask" && !taskIds.has(milestone.targetTaskId)) {
      fail(`milestone ${milestone.id} 的目标任务不存在`);
    }
  }

  const outcomeMilestones = new Set();
  for (const outcome of workspace.milestoneOutcomes) {
    if (!milestoneIds.has(outcome.milestoneId)) fail(`outcome ${outcome.id} 指向不存在的里程碑`);
    if (outcomeMilestones.has(outcome.milestoneId)) fail(`里程碑 ${outcome.milestoneId} 有多条到期结果`);
    outcomeMilestones.add(outcome.milestoneId);
  }

  for (const habit of workspace.recurringHabits) {
    if (!taskIds.has(habit.taskId)) fail(`habit ${habit.id} 指向不存在的任务`);
    const internal = workspace.tasks.find((task) => task.id === habit.taskId);
    if (internal && internal.kind !== "habit") fail(`habit ${habit.id} 的内部任务 kind 不是 habit`);
  }
  for (const occurrence of workspace.habitOccurrences) {
    if (!habitIds.has(occurrence.habitId)) fail(`occurrence ${occurrence.id} 指向不存在的习惯`);
    if (occurrence.sessionId !== null && !sessionIds.has(occurrence.sessionId)) {
      fail(`occurrence ${occurrence.id} 指向不存在的时段 ${occurrence.sessionId}`);
    }
  }

  for (const id of workspace.rescuePromptedSessionIds) {
    if (!sessionIds.has(id)) fail(`rescuePromptedSessionIds 含不存在的时段 ${id}`);
  }

  return problems;
}

// ---------------------------------------------------------------- CLI

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { workspace, preferences, stats } = buildPerfSample(args);

  const problems = args.validate ? validateSample(workspace) : [];
  const canonical = JSON.stringify(workspace);
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 16);

  console.log("=== Daymark 性能样本（P4-01 可重复样本）===");
  console.log(`seed=${args.seed}  anchor=${stats.anchorDate}  window=${stats.windowStart}..${stats.anchorDate}（${stats.windowDays} 天）`);
  console.log(`workspace sha256(前16位)=${digest}  bytes=${canonical.length}`);
  console.log("");
  console.log("对象数量：");
  for (const [key, value] of Object.entries(stats.counts)) {
    console.log(`  ${key.padEnd(26)} ${value}`);
  }
  console.log("");
  console.log("本机信息（不参与确定性比较）：");
  for (const [key, value] of Object.entries(machineInfo())) console.log(`  ${key.padEnd(14)} ${value}`);
  console.log("");
  if (args.validate) {
    if (problems.length === 0) {
      console.log("自校验：通过（全部不变量成立）");
    } else {
      console.log(`自校验：失败，共 ${problems.length} 条`);
      for (const problem of problems.slice(0, 20)) console.log(`  - ${problem}`);
      process.exitCode = 1;
    }
  } else {
    console.log("自校验：已跳过（--no-validate）");
  }

  if (args.out) {
    const payload = {
      generatedAt: new Date().toISOString(),
      machine: machineInfo(),
      args,
      stats,
      preferences,
      workspace,
    };
    writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`\n已写出：${args.out}`);
  } else {
    console.log("\n（未指定 --out，未落盘）");
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("perf-sample.mjs")) {
  main();
}
