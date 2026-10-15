/*
 * 阶段 4 待定口径 —— 点着看用的样本数据
 *
 * 用法（浏览器版，约 20 秒）：
 *   1) npm run dev
 *   2) 浏览器打开 http://127.0.0.1:1420
 *   3) 按 F12 → Console → 把本文件全部内容粘进去 → 回车
 *   4) 按 F5 刷新
 *
 * 为什么用浏览器版：桌面版的设置与数据存在 Tauri Store 文件里，灌样本很麻烦；
 * 浏览器版存在 localStorage，界面与桌面版完全一样。看口径用浏览器版就够。
 *
 * 样本是按「每条待定口径都要能看出来」设计的，对照表见
 * docs/reports/phase-4-decisions-walkthrough.md 的 §0.3。
 * 想清空：F12 → Console → localStorage.clear() → 回车 → F5。
 */
(() => {
  const pad = (n) => String(n).padStart(2, "0");
  const day = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const today = day(0);

  localStorage.setItem("daymark.phase0.preferences", JSON.stringify({
    appearance: "system", motion: "system", scale: 100, lastPage: "deadlines", calendarView: "week",
    snapMinutes: 15, checkInEnabled: true, remindersEnabled: false, reminderLeadMinutes: 10,
    defaultTimeSlots: [{ id: "evening", label: "晚间专注", start: "19:00", end: "22:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }],
  }));

  localStorage.setItem("daymark.phase1.workspace", JSON.stringify({
    // D3：Alpha 与 Beta 的截止日**完全相同**，用来比较同一天里两个项目谁排前面。
    // D2：Rust 入门 这个项目名带关键字，但它下面唯一的任务叫「起步」（标题不含 Rust）。
    projects: [
      { id: "p-alpha", title: "Alpha 计划", deadlineLocal: day(3) },
      { id: "p-beta", title: "Beta 计划", deadlineLocal: day(3) },
      { id: "p-rust", title: "Rust 入门", deadlineLocal: null },
    ],
    // 一条里程碑，让「里程碑」这一类在截止页有内容；未到期，所以是 open。
    projectMilestones: [
      { id: "m-1", projectId: "p-alpha", title: "跑通第一章", targetLocalDate: day(2), sortOrder: 0,
        criterionKind: "taskCount", targetTaskId: null, targetCount: 1, targetProgress: null },
    ],
    milestoneOutcomes: [],
    tasks: [
      // D2：标题里没有 "Rust"，但所属项目名有 —— 搜 Rust 时它出不出现就是那条口径。
      { id: "t-1", projectId: "p-rust", title: "起步", progress: 30, status: "active", deadlineLocal: day(1), estimatedMinutes: 60, sortOrder: 0 },
      // D1：这几条 active 任务是任务池的内容，截止页要不要常驻任务池看的就是它们。
      { id: "t-2", projectId: null, title: "整理会议记录", progress: 0, status: "active", deadlineLocal: day(-1), estimatedMinutes: 30, sortOrder: 1 },
      { id: "t-3", projectId: null, title: "写周报", progress: 100, status: "completed", deadlineLocal: today, estimatedMinutes: 45, sortOrder: 2 },
      { id: "t-4", projectId: null, title: "健身计划", progress: 10, status: "paused", deadlineLocal: day(6), estimatedMinutes: 30, sortOrder: 3 },
      // D4：正好 7 个日历日之后，用来观察「7 天内截止」的判定。
      { id: "t-5", projectId: null, title: "正好七天后的任务", progress: 0, status: "active", deadlineLocal: day(7), estimatedMinutes: 30, sortOrder: 4 },
      // 让「今天」分组也有内容（t-3 已完成，默认被过滤掉）。
      { id: "t-6", projectId: null, title: "今天要交的东西", progress: 40, status: "active", deadlineLocal: today, estimatedMinutes: 20, sortOrder: 5 },
      // 让「以后」分组也有内容。
      { id: "t-7", projectId: null, title: "下个月的整理", progress: 0, status: "active", deadlineLocal: day(20), estimatedMinutes: 90, sortOrder: 6 },
    ],
    // D5：「回到现在」要有意义，日历里得先有一个今天的时间段。
    executionSessions: [
      { id: "s-1", taskId: "t-2", localDate: today, endLocalDate: today, startLocal: "09:00", endLocal: "10:00",
        timeZone: "local", utcOffsetMinutes: -new Date().getTimezoneOffset(), status: "scheduled" },
    ],
    executionRecords: [],
    progressEvents: [],
    timeBlocks: [],
    recurringHabits: [],
    habitOccurrences: [],
    rescuePromptedSessionIds: [],
  }));

  console.log("样本已写入。按 F5 刷新即可。清空：localStorage.clear() 后 F5。");
})();
