import axe from "axe-core";
import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { readCalendarPositions, resetCalendarPositions } from "./hooks/useCalendarViewport";
import { EMPTY_WORKSPACE, type BackupInfo, type CompletionImage, type NativeApi, type WorkspaceSnapshot } from "./lib/native";
import { DEFAULT_SETTINGS, PAGE_IDS, SettingsRepository, type AppSettings, type PageId, type SettingsBackend } from "./lib/settings";

beforeEach(() => { Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 }); });

async function openProject(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(await screen.findByRole("button", { name: "打开项目 " + title }));
  await screen.findByRole("button", { name: "关闭项目详情" });
}

async function openImportMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "导入" }));
}

/** 走 TimeField：打开滚轮 → 选小时 → 选分钟 → Esc 收起（只关滚轮，不动外层表单）。 */
async function chooseTime(user: ReturnType<typeof userEvent.setup>, label: string, hour: string, minute: string) {
  await user.click(screen.getByRole("button", { name: new RegExp(`^${label} `) }));
  const picker = await screen.findByRole("dialog", { name: `选择${label}` });
  await user.click(within(within(picker).getByRole("listbox", { name: "小时" })).getByRole("option", { name: hour }));
  await user.click(within(within(picker).getByRole("listbox", { name: "分钟" })).getByRole("option", { name: minute }));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(picker).not.toBeInTheDocument());
}

const tauriEventCallbacks = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    tauriEventCallbacks.set(name, callback);
    return () => tauriEventCallbacks.delete(name);
  }),
}));

class MemorySettingsBackend implements SettingsBackend {
  value: unknown = DEFAULT_SETTINGS;
  failNextWrite = false;
  async read() { return this.value; }
  async write(value: unknown) { if (this.failNextWrite) { this.failNextWrite = false; throw new Error("disk full"); } this.value = value; }
}

function createNativeApi(initial: WorkspaceSnapshot = structuredClone(EMPTY_WORKSPACE), overrides: Partial<NativeApi> = {}): NativeApi {
  let state = structuredClone(initial);
  const write = (next: WorkspaceSnapshot) => { state = next; return Promise.resolve(structuredClone(state)); };
  return {
    getWorkspace: vi.fn(() => Promise.resolve(structuredClone(state))),
    createTask: vi.fn((task) => write({ ...state, tasks: [...state.tasks, task] })),
    createTaskWithSession: vi.fn((task, session) => write({ ...state, tasks: [...state.tasks, task], executionSessions: [...state.executionSessions, session] })),
    updateTask: vi.fn((task) => write({ ...state, tasks: state.tasks.map((item) => item.id === task.id ? task : item) })),
    createProjectWithTasks: vi.fn((project, tasks) => write({ ...state, projects: [...state.projects, project], tasks: [...state.tasks, ...tasks] })),
    updateProject: vi.fn((project) => write({ ...state, projects: state.projects.map((item) => item.id === project.id ? project : item) })),
    createProjectMilestone: vi.fn((milestone) => write({ ...state, projectMilestones: [...state.projectMilestones, milestone] })),
    updateProjectMilestone: vi.fn((milestone) => write({ ...state, projectMilestones: state.projectMilestones.map((item) => item.id === milestone.id ? milestone : item) })),
    deleteProjectMilestone: vi.fn((id) => write({ ...state, projectMilestones: state.projectMilestones.filter((item) => item.id !== id) })),
    createExecutionSession: vi.fn((session) => write({ ...state, executionSessions: [...state.executionSessions, session] })),
    createExecutionSessions: vi.fn((sessions) => write({ ...state, executionSessions: [...state.executionSessions, ...sessions] })),
    applyScheduleDraft: vi.fn((sessions, occurrences) => write({ ...state, executionSessions: [...state.executionSessions, ...sessions], habitOccurrences: [...state.habitOccurrences, ...occurrences] })),
    updateExecutionSession: vi.fn((session) => write({ ...state, executionSessions: state.executionSessions.map((item) => item.id === session.id ? session : item) })),
    applyExecutionSessionChanges: vi.fn((changes: Parameters<NativeApi["applyExecutionSessionChanges"]>[0]) => write({ ...state,
      executionSessions: [...state.executionSessions.filter((item) => !changes.deleteIds.includes(item.id)).map((item) => changes.update.find((next) => next.id === item.id) ?? item), ...changes.create],
      habitOccurrences: state.habitOccurrences.filter((item) => !item.sessionId || !changes.deleteIds.includes(item.sessionId)),
    })),
    deleteExecutionSession: vi.fn((id) => write({ ...state, executionSessions: state.executionSessions.filter((item) => item.id !== id) })),
    deleteExecutionSessions: vi.fn((ids) => write({ ...state, executionSessions: state.executionSessions.filter((item) => !ids.includes(item.id)), habitOccurrences: state.habitOccurrences.filter((item) => !item.sessionId || !ids.includes(item.sessionId)) })),
    createTimeBlock: vi.fn((block) => write({ ...state, timeBlocks: [...state.timeBlocks, block] })),
    deleteTimeBlock: vi.fn((id) => write({ ...state, timeBlocks: state.timeBlocks.filter((item) => item.id !== id) })),
    updateTimeBlock: vi.fn((block) => write({ ...state, timeBlocks: state.timeBlocks.map((item) => item.id === block.id ? block : item) })),
    createRecurringHabit: vi.fn((habit, backingTask) => write({ ...state, recurringHabits: [...state.recurringHabits, habit], tasks: [...state.tasks, backingTask] })),
    setHabitOccurrence: vi.fn((occurrence) => write({ ...state, habitOccurrences: [...state.habitOccurrences.filter((item) => item.habitId !== occurrence.habitId || item.localDate !== occurrence.localDate), occurrence] })),
    scheduleHabitOccurrence: vi.fn((occurrence, session) => write({ ...state, executionSessions: [...state.executionSessions, session], habitOccurrences: [...state.habitOccurrences, occurrence] })),
    markRescuePrompted: vi.fn((sessionId) => write({ ...state, rescuePromptedSessionIds: state.rescuePromptedSessionIds.includes(sessionId) ? state.rescuePromptedSessionIds : [...state.rescuePromptedSessionIds, sessionId] })),
    fetchBilibiliVideo: vi.fn().mockRejectedValue(new Error("unused")),
    startExecution: vi.fn((record) => write({ ...state, executionRecords: [...state.executionRecords, record] })),
    finishExecution: vi.fn((_id, end, note, event) => write({ ...state,
      executionRecords: state.executionRecords.map((record) => !record.actualEndUtc ? { ...record, actualEndUtc: end, note } : record),
      tasks: state.tasks.map((task) => task.id === event.taskId ? { ...task, progress: event.toProgress } : task),
      progressEvents: [...state.progressEvents, event],
    })),
    applyProgress: vi.fn((event) => write({ ...state, tasks: state.tasks.map((task) => task.id === event.taskId ? { ...task, progress: event.toProgress } : task), progressEvents: [...state.progressEvents, event] })),
    recordCompletion: vi.fn((record, images) => write({ ...state, completionRecords: [...state.completionRecords, { ...record, imageCount: images.length }] })),
    updateCompletion: vi.fn((record, images) => write({ ...state, completionRecords: state.completionRecords.map((item) => item.id === record.id ? { ...record, imageCount: images.length } : item) })),
    revertCompletion: vi.fn((recordId, event) => write({ ...state,
      tasks: state.tasks.map((task) => task.id === event.taskId ? { ...task, progress: event.toProgress, status: "active" as const } : task),
      progressEvents: [...state.progressEvents, event],
      completionRecords: state.completionRecords.map((item) => item.id === recordId ? { ...item, revertedAtUtc: "2026-08-05T12:00:00.000Z" } : item),
    })),
    getCompletionImages: vi.fn(async () => [] as CompletionImage[]),
    showReminder: vi.fn().mockResolvedValue(undefined),
    isAutostartEnabled: vi.fn().mockResolvedValue(false),
    setAutostartEnabled: vi.fn().mockResolvedValue(undefined),
    getDataOverview: vi.fn(async () => ({ schemaVersion: 5, databasePath: "C:\\Daymark\\daymark.db", backupDirectory: "C:\\Daymark\\backups", backupError: null, counts: { projects: state.projects.length, tasks: state.tasks.length, executionSessions: state.executionSessions.length, executionRecords: state.executionRecords.length, progressEvents: state.progressEvents.length, timeBlocks: state.timeBlocks.length }, backups: [] })),
    createDailyBackup: vi.fn().mockResolvedValue({ path: "C:\\Daymark\\backups\\daymark.db", kind: "daily" } satisfies BackupInfo),
    createManualBackup: vi.fn().mockResolvedValue(null), chooseRestoreSource: vi.fn().mockResolvedValue(null),
    inspectBackup: vi.fn().mockRejectedValue(new Error("unused")), restoreBackup: vi.fn().mockRejectedValue(new Error("unused")),
    ...overrides,
  };
}

function rescueScenario(endLocal = "13:00") {
  const backend = new MemorySettingsBackend();
  backend.value = { ...DEFAULT_SETTINGS, checkInEnabled: true, rescuePromptsEnabled: true, checkInGraceMinutes: 5 };
  const initial: WorkspaceSnapshot = {
    ...structuredClone(EMPTY_WORKSPACE),
    tasks: [{ id: "task-1", projectId: null, title: "恢复行动", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 30, sortOrder: 0 }],
    executionSessions: [{ id: "session-1", taskId: "task-1", localDate: "2026-08-02", endLocalDate: "2026-08-02", startLocal: "11:00", endLocal, timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
  };
  return { backend, native: createNativeApi(initial) };
}

describe("phase 1 manual alpha", () => {
  it("restores the Today page with accessible navigation and task pool", async () => {
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi()} />);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(/\d+月\d+日 星期/);
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeVisible();
    expect(screen.getByRole("complementary", { name: /任务池/ })).toBeVisible();
    const results = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it("renders one timeline, keeps the passed session in place and moves the finished list to the side column", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00"));
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, checkInEnabled: true };
    const task = (id: string, title: string, progress: number, deadlineLocal: string | null, sortOrder: number, status: "active" | "completed" = "active") => ({
      id, projectId: null, title, progress, status, deadlineLocal, estimatedMinutes: 60, sessionMinutes: 60, priority: "normal" as const, sortOrder, kind: "task" as const,
    });
    const initial: WorkspaceSnapshot = {
      ...structuredClone(EMPTY_WORKSPACE),
      tasks: [task("now-task", "正在推进", 65, null, 0), task("review-task", "需要回顾", 30, null, 1), task("due-task", "临期任务", 20, "2026-08-06", 2), task("later-task", "更晚的截止", 0, "2026-09-01", 3), task("done-task", "今天做完", 100, null, 4, "completed")],
      executionSessions: [
        { id: "s-review", taskId: "review-task", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "09:00", endLocal: "10:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
        { id: "s-now", taskId: "now-task", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "11:00", endLocal: "12:30", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
        { id: "s-next", taskId: "due-task", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "14:00", endLocal: "15:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
      ],
      progressEvents: [{ id: "e-done", taskId: "done-task", fromProgress: 80, toProgress: 100, occurredAtUtc: "2026-08-05T10:30:00.000Z" }],
    };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi(initial)} />);
    await screen.findByRole("heading", { name: /8月5日/, level: 1 });

    // 页头不再有事实摘要行：「2 个执行时段 · 1 个待回顾」那种计数已经下放到卡片头。
    expect(document.querySelector(".today-subtitle")).toBeNull();
    expect(document.querySelector(".now-card")).toBeNull();
    expect(screen.queryByRole("heading", { name: "待回顾", level: 2 })).toBeNull();

    const currentRow = document.querySelector<HTMLElement>(".today-row.is-current")!;
    expect(within(currentRow).getByText("正在推进")).toBeVisible();
    // 剩余时间是倒计时（`剩 30:00`），不是「剩 30 分钟」——后者看不出时间在走。
    expect(currentRow).toHaveTextContent("剩 30:00");
    expect(within(currentRow).getByRole("button", { name: "开始" })).toBeVisible();
    // 「现在」不再用 chip 说：整行的橙色底与实心点已经在说。
    expect(currentRow.querySelector(".today-chip.is-now")).toBeNull();

    // 已经过去、还没做完的时段留在时间轴上，不写「未推进」，也不挂「已过」标签。
    const pastRow = document.querySelector<HTMLElement>(".today-row.is-past")!;
    expect(pastRow).toHaveTextContent("需要回顾");
    expect(pastRow.querySelector(".today-chip.is-past")).toBeNull();
    expect(pastRow).not.toHaveTextContent("未推进");
    // 顺延与「去日历改时间」是行尾两个图标按钮：顺延一键完成，悬停靠 `title` 说明。
    expect(within(pastRow).getByRole("button", { name: "把 需要回顾 挪到明天同一时间" })).toHaveAttribute("title", "挪到明天同一时间");
    expect(within(pastRow).getByRole("button", { name: "在日历中查看 需要回顾" })).toHaveAttribute("title", "在日历中查看");

    const due = document.querySelector<HTMLElement>(".today-due")!;
    expect(within(due).getByText("临期任务")).toBeVisible();
    expect(within(due).queryByText("更晚的截止")).not.toBeInTheDocument();
    // 临期条目只写名字与天数，进度控件已经收进气泡里。
    expect(due.querySelector(".progress-control")).toBeNull();

    // 行内进度条本身就是控件：不再有「百分比按钮 + 进度气泡」这道中转。
    const rowSlider = within(currentRow).getByRole("slider", { name: "正在推进 完成度" });
    expect(rowSlider).toHaveValue("65");
    expect(document.querySelector(".today-progress-panel")).toBeNull();
    expect(currentRow.querySelector(".today-pct")).toBeNull();

    const done = document.querySelector<HTMLElement>(".today-done")!;
    expect(within(done).getByText("今天做完")).toBeVisible();

    // 左下角「待续」：只有 review-task 排过期次、今天也没有后续时段。
    const carry = document.querySelector<HTMLElement>(".carry-toggle")!;
    expect(carry).toHaveTextContent("待续");
    expect(carry).toHaveTextContent("1");
    vi.useRealTimers();
  });

  /**
   * 临期气泡的「在轴上查看」= 滚回轴上那一段并亮 4 秒，不是跳去日历。
   * 「编辑任务」收成只带图标的方按钮（还有边框），不再和「在轴上查看」抢一行宽度。
   */
  it("reveals the session on the axis from the due bubble and flashes it for four seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, checkInEnabled: true };
    const initial: WorkspaceSnapshot = {
      ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{
        id: "due-task", projectId: null, title: "临期任务", progress: 20, status: "active", deadlineLocal: "2026-08-06",
        estimatedMinutes: 60, sessionMinutes: 60, priority: "normal", sortOrder: 0, kind: "task",
      }],
      executionSessions: [{
        id: "s-next", taskId: "due-task", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "14:00", endLocal: "15:00",
        timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled",
      }],
    };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi(initial)} />);
    await screen.findByRole("heading", { name: /8月5日/, level: 1 });

    await user.click(screen.getByRole("button", { name: /^临期任务，/ }));
    const bubble = await screen.findByRole("dialog", { name: "临期任务 临期操作" });
    expect(within(bubble).getByRole("button", { name: "编辑任务 临期任务" })).toBeVisible();
    // 编辑右边是「去日历改时间」：同一排三个出口，图标按钮都带悬停说明。
    expect(within(bubble).getByRole("button", { name: "在日历中查看 临期任务" })).toHaveAttribute("title", "在日历中查看");

    const row = document.querySelector<HTMLElement>('[data-session-id="s-next"]')!;
    expect(row).not.toHaveClass("is-flash");
    await user.click(within(bubble).getByRole("button", { name: "在轴上查看" }));
    expect(screen.queryByRole("dialog", { name: "临期任务 临期操作" })).toBeNull();
    expect(row).toHaveClass("is-flash");

    // 4 秒后自己熄灭，不留一个常亮的高亮。
    act(() => { vi.advanceTimersByTime(4100); });
    expect(row).not.toHaveClass("is-flash");
    vi.useRealTimers();
  });

  it("removes the task-pool column on utility pages", async () => {
    const user = userEvent.setup();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi()} />);
    await user.click(await screen.findByRole("button", { name: "数据" }));
    expect(document.querySelector(".app-shell")).toHaveClass("without-task-pool");
    expect(screen.queryByRole("complementary", { name: /任务池/ })).not.toBeInTheDocument();
  });

  it("lets the task pool collapse without removing its tasks", async () => {
    const user = userEvent.setup();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi()} />);
    await user.click(await screen.findByRole("button", { name: "收起任务池" }));
    expect(screen.queryByRole("complementary", { name: /任务池/ })).not.toBeInTheDocument();
    expect(document.querySelector(".app-shell")).toHaveClass("without-task-pool");
    await user.click(screen.getByRole("button", { name: "打开任务池" }));
    expect(screen.getByRole("complementary", { name: /任务池/ })).toBeVisible();
  });

  it("remembers the expanded project and 需要关注 after the pool is closed and reopened", async () => {
    const user = userEvent.setup();
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "Alpha", deadlineLocal: null }],
      tasks: [
        { id: "task-due", projectId: null, title: "临期任务", progress: 0, status: "active", deadlineLocal: isoDaysFromNow(0), estimatedMinutes: 30, sortOrder: 0 },
        { id: "task-a", projectId: "project-1", title: "写大纲", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 30, sortOrder: 1 },
        { id: "task-b", projectId: "project-1", title: "列素材", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 30, sortOrder: 2 },
      ],
    };
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi(initial)} />);
    const projectHeader = () => document.querySelector<HTMLElement>(".project-group-header")!;
    const attention = () => document.querySelector<HTMLDetailsElement>(".attention-pool")!;
    // 默认口径：只有 1 项临期时「需要关注」展开，第一个小项目展开。
    await screen.findByText("需要关注");
    expect(projectHeader()).toHaveAttribute("aria-expanded", "true");
    expect(attention()).toHaveAttribute("open");

    // 手动收起两者，再把整块面板关掉再打开 —— 面板卸载过一轮，仍要是离开时的样子。
    await user.click(projectHeader());
    await user.click(within(attention()).getByText("需要关注"));
    await user.click(screen.getByRole("button", { name: "收起任务池" }));
    await user.click(screen.getByRole("button", { name: "打开任务池" }));

    expect(projectHeader()).toHaveAttribute("aria-expanded", "false");
    expect(attention()).not.toHaveAttribute("open");
  });

  it("renders calendar hours on a dedicated vertical time axis", async () => {
    const user = userEvent.setup();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi()} />);
    await user.click(await screen.findByRole("button", { name: "日历" }));
    expect(document.querySelectorAll(".time-axis-track > span")).toHaveLength(24);
  });

  it("previews a pool drag before writing and lets Alt reverse snapping", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-drag", projectId: null, title: "拖拽任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
    };
    const native = createNativeApi(initial);
    const user = userEvent.setup();
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    await user.click(await screen.findByRole("button", { name: "显示更多日历选项" }));
    expect(await screen.findByRole("button", { name: "吸附 15 分钟" })).toHaveAttribute("aria-pressed", "true");
    // 「显示 ⋯」气泡是模态（背景 inert）：不关掉它，日历里的落点框连 aria 都读不到。
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "日历显示选项" })).not.toBeInTheDocument());
    const row = (await screen.findByText("拖拽任务", { selector: ".task-card strong" })).closest<HTMLElement>(".task-card")!;
    const track = document.querySelector<HTMLElement>('.calendar-day[data-day-date="2026-08-05"] .day-track')!;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 1440, width: 200, height: 1440, toJSON: () => ({}) });

    // B2：池 → 日历走 pointer，新增一次执行时段；拖动中只渲染落点，不写库。
    fireEvent.pointerDown(row, { button: 0, clientX: 30, clientY: 10 });
    fireEvent(window, createEvent.pointerMove(window, { clientX: 30, clientY: 607 }));
    const ghost = screen.getByRole("status", { name: "拖拽排程预览" });
    expect(ghost).toHaveTextContent("松开放置");
    expect(native.applyExecutionSessionChanges).not.toHaveBeenCalled();
    const snappedTop = (ghost as HTMLElement).style.top;

    // Alt 临时反转吸附：607 分钟不再贴到 600，落点框跟着挪。
    const free = createEvent.pointerMove(window, { clientX: 30, clientY: 607 });
    Object.defineProperty(free, "altKey", { value: true });
    fireEvent(window, free);
    expect((screen.getByRole("status", { name: "拖拽排程预览" }) as HTMLElement).style.top).not.toBe(snappedTop);
    expect(native.applyExecutionSessionChanges).not.toHaveBeenCalled();
    fireEvent(window, createEvent.pointerUp(window, { clientX: 30, clientY: 607 }));
  });

  it("starts a pool drag only past the 5px threshold and leaves the row's own buttons alone", async () => {
    // 回归红线：池行的单击／双击／多选与自身按钮不受 pointer 拾起影响（UI-SPEC §90/§91）。
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-gate", projectId: null, title: "阈值任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
    };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi(initial)} />);
    const row = (await screen.findByText("阈值任务", { selector: ".task-card strong" })).closest<HTMLElement>(".task-card")!;
    const track = document.querySelector<HTMLElement>('.calendar-day[data-day-date="2026-08-05"] .day-track')!;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 1440, width: 200, height: 1440, toJSON: () => ({}) });

    // 卡身上的按钮只执行自己的操作。
    const progressButton = screen.getByRole("button", { name: /调整进度 阈值任务/ });
    fireEvent.pointerDown(progressButton, { button: 0, clientX: 30, clientY: 10 });
    fireEvent(window, createEvent.pointerMove(window, { clientX: 30, clientY: 607 }));
    expect(screen.queryByRole("status", { name: "拖拽排程预览" })).not.toBeInTheDocument();
    fireEvent(window, createEvent.pointerUp(window, { clientX: 30, clientY: 607 }));

    // 3px 位移仍在阈值内：停在 picked，不产生落点（click 照常派发）。
    fireEvent.pointerDown(row, { button: 0, clientX: 30, clientY: 10 });
    fireEvent(window, createEvent.pointerMove(window, { clientX: 31, clientY: 12 }));
    expect(document.querySelector(".calendar-page")).toHaveAttribute("data-drag-phase", "picked");
    expect(screen.queryByRole("status", { name: "拖拽排程预览" })).not.toBeInTheDocument();

    // 越过 5px 才进入 dragging，并且开始显示落点。
    fireEvent(window, createEvent.pointerMove(window, { clientX: 30, clientY: 607 }));
    expect(document.querySelector(".calendar-page")).toHaveAttribute("data-drag-phase", "dragging");
    expect(screen.getByRole("status", { name: "拖拽排程预览" })).toBeInTheDocument();
    fireEvent(window, createEvent.pointerUp(window, { clientX: 30, clientY: 607 }));
  });

  it("previews edge insertion from the pool, shifts later sessions, and commits the whole drop once", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [
        { id: "task-drag", projectId: null, title: "插入任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 },
        { id: "task-target", projectId: null, title: "目标任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 1 },
        { id: "task-next", projectId: null, title: "后续任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 2 },
      ],
      executionSessions: [
        { id: "session-target", taskId: "task-target", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
        { id: "session-next", taskId: "task-next", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "11:00", endLocal: "12:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
      ],
    };
    const native = createNativeApi(initial); render(<App settings={new SettingsRepository(backend)} native={native} />);
    const row = (await screen.findByText("插入任务", { selector: ".task-card strong" })).closest<HTMLElement>(".task-card")!;
    const target = (await screen.findByText("目标任务", { selector: ".calendar-session strong" })).closest<HTMLElement>(".calendar-session")!;
    const track = target.closest<HTMLElement>(".day-track")!;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 1440, width: 200, height: 1440, toJSON: () => ({}) });
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ x: 0, y: 600, top: 600, left: 0, right: 200, bottom: 660, width: 200, height: 60, toJSON: () => ({}) });

    fireEvent.pointerDown(row, { button: 0, clientX: 30, clientY: 10 });
    fireEvent(window, createEvent.pointerMove(window, { clientX: 30, clientY: 605 }));
    expect(screen.getByRole("status", { name: "拖拽排程预览" })).toHaveTextContent("插入并后移");
    expect(screen.getByLabelText("插入位置")).toBeVisible();
    expect(native.applyExecutionSessionChanges).not.toHaveBeenCalled();
    fireEvent(window, createEvent.pointerUp(window, { clientX: 30, clientY: 605 }));
    await waitFor(() => expect(native.applyExecutionSessionChanges).toHaveBeenCalledOnce());
    expect(native.applyExecutionSessionChanges).toHaveBeenCalledWith(expect.objectContaining({
      create: [expect.objectContaining({ taskId: "task-drag", startLocal: "10:00" })],
      update: expect.arrayContaining([expect.objectContaining({ id: "session-target", startLocal: "11:00" }), expect.objectContaining({ id: "session-next", startLocal: "12:00" })]),
    }));
  });

  it("switches a pool drop hovered at a card centre to simultaneous scheduling after 500 ms", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const backend = new MemorySettingsBackend(); backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-drag", projectId: null, title: "并行任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 30, sortOrder: 0 }, { id: "task-target", projectId: null, title: "已有任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 1 }],
      executionSessions: [{ id: "session-target", taskId: "task-target", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
    };
    const native = createNativeApi(initial); render(<App settings={new SettingsRepository(backend)} native={native} />);
    try {
      const row = (await screen.findByText("并行任务", { selector: ".task-card strong" })).closest<HTMLElement>(".task-card")!;
      const target = (await screen.findByText("已有任务", { selector: ".calendar-session strong" })).closest<HTMLElement>(".calendar-session")!; const track = target.closest<HTMLElement>(".day-track")!;
      vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 1440, width: 200, height: 1440, toJSON: () => ({}) });
      vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ x: 0, y: 600, top: 600, left: 0, right: 200, bottom: 660, width: 200, height: 60, toJSON: () => ({}) });
      fireEvent.pointerDown(row, { button: 0, clientX: 30, clientY: 10 });
      fireEvent(window, createEvent.pointerMove(window, { clientX: 30, clientY: 630 }));
      expect(screen.getByRole("status", { name: "拖拽排程预览" })).toHaveTextContent("悬停 0.5 秒以同时安排");
      act(() => vi.advanceTimersByTime(500));
      expect(screen.getByRole("status", { name: "拖拽排程预览" })).toHaveClass("overlap");
      // §177：重叠预览期间并排结果提前算出来 —— 两张卡各占一半宽。
      expect(target.style.width).toContain("50%");
      fireEvent(window, createEvent.pointerUp(window, { clientX: 30, clientY: 630 }));
    } finally { vi.useRealTimers(); }
  });

  it("summarizes four overlapping sessions and opens their in-place list", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend(); backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const tasks = Array.from({ length: 4 }, (_, index) => ({ id: `task-${index}`, projectId: null, title: `并行 ${index + 1}`, progress: 0, status: "active" as const, deadlineLocal: null, estimatedMinutes: 60, sortOrder: index }));
    const executionSessions = tasks.map((task, index) => ({ id: `session-${index}`, taskId: task.id, localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" as const }));
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi({ ...structuredClone(EMPTY_WORKSPACE), tasks, executionSessions })} />);
    const summary = await screen.findByRole("button", { name: "另外 2 项" });
    expect(document.querySelectorAll('.calendar-day[data-day-date="2026-08-05"] .calendar-session')).toHaveLength(2);
    await user.click(summary);
    const list = screen.getByRole("region", { name: "同时安排的全部任务" });
    expect(list.querySelectorAll("button")).toHaveLength(4);
  });

  it("opens the three blank-time actions after range selection without writing on blank", async () => {
    const user = userEvent.setup();
    const backend = new MemorySettingsBackend(); backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const native = createNativeApi(); render(<App settings={new SettingsRepository(backend)} native={native} />);
    await screen.findByRole("button", { name: "显示更多日历选项" });
    const track = document.querySelector<HTMLElement>('.calendar-day[data-day-date="2026-08-05"] .day-track')!;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 1440, width: 200, height: 1440, toJSON: () => ({}) });
    const down = createEvent.pointerDown(track, { button: 0, pointerId: 1 }); Object.defineProperties(down, { clientX: { value: 240 }, clientY: { value: 660 } }); fireEvent(track, down);
    const up = createEvent.pointerUp(track, { button: 0, pointerId: 1 }); Object.defineProperties(up, { clientX: { value: 240 }, clientY: { value: 600 } }); fireEvent(track, up);
    const bubble = screen.getByRole("dialog", { name: "空白时段操作" });
    expect(bubble).toHaveTextContent("10:00–11:00");
    // #5：气泡锚在松手点（240, 600）下方 8px，而不是 body 矩形带来的 (12, 12)。
    expect(bubble.style.left).toBe("240px");
    expect(bubble.style.top).toBe("608px");
    expect(screen.getByRole("button", { name: "新建任务" })).toBeVisible();
    expect(screen.getByRole("button", { name: "从任务池安排" })).toBeVisible();
    expect(bubble.querySelector("button:nth-of-type(3)")).toHaveTextContent("时间块");
    expect(native.createTask).not.toHaveBeenCalled(); expect(native.createTimeBlock).not.toHaveBeenCalled(); expect(native.createExecutionSession).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "新建任务" }));
    await user.type(bubble.querySelector("input")!, "原子安排任务");
    await user.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(native.createTaskWithSession).toHaveBeenCalledTimes(1));
    expect(native.createTask).not.toHaveBeenCalled(); expect(native.createExecutionSession).not.toHaveBeenCalled();
  });

  it("filters tasks by project and title inside the blank-time pool picker", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-a", title: "项目甲", deadlineLocal: null }, { id: "project-b", title: "项目乙", deadlineLocal: null }],
      tasks: [
        { id: "task-a", projectId: "project-a", title: "写报告", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 30, sortOrder: 0 },
        { id: "task-b", projectId: "project-b", title: "读书", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 1 },
        { id: "task-c", projectId: null, title: "独立整理", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 45, sortOrder: 2 },
      ],
    };
    const native = createNativeApi(initial); render(<App settings={new SettingsRepository(backend)} native={native} />);
    await screen.findByRole("button", { name: "显示更多日历选项" });
    const track = document.querySelector<HTMLElement>('.calendar-day[data-day-date="2026-08-05"] .day-track')!;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 1440, width: 200, height: 1440, toJSON: () => ({}) });
    fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientX: 240, clientY: 600 });
    fireEvent.pointerUp(track, { button: 0, pointerId: 1, clientX: 240, clientY: 660 });
    const bubble = screen.getByRole("dialog", { name: "空白时段操作" });
    await user.click(within(bubble).getByRole("button", { name: "从任务池安排" }));

    const picker = within(bubble);
    expect(picker.getByRole("button", { name: /写报告/ })).toBeVisible();
    expect(picker.getByRole("button", { name: /读书/ })).toBeVisible();
    expect(picker.getByRole("button", { name: /独立整理/ })).toBeVisible();

    await user.click(picker.getByRole("button", { name: "项目甲" }));
    expect(picker.getByRole("button", { name: /写报告/ })).toBeVisible();
    expect(picker.queryByRole("button", { name: /读书/ })).not.toBeInTheDocument();
    expect(picker.queryByRole("button", { name: /独立整理/ })).not.toBeInTheDocument();

    const search = picker.getByRole("searchbox", { name: "搜索任务" });
    await user.type(search, "读");
    expect(picker.getByText("没有匹配的任务")).toBeVisible();
    await user.click(picker.getByRole("button", { name: "全部" }));
    expect(picker.getByRole("button", { name: /读书/ })).toBeVisible();
    expect(picker.queryByRole("button", { name: /写报告/ })).not.toBeInTheDocument();

    await user.click(picker.getByRole("button", { name: /读书/ }));
    await waitFor(() => expect(native.createExecutionSession).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-b", localDate: "2026-08-05", startLocal: "10:00" })));
  });

  it("renders month view as a fixed six-week grid starting on Monday", async () => {
    const user = userEvent.setup();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi()} />);
    await user.click(await screen.findByRole("button", { name: "日历" }));
    await user.click(screen.getByRole("button", { name: "月" }));
    const monthGrid = screen.getByRole("grid", { name: "月历" });
    expect(screen.getAllByRole("columnheader", { name: /周[一二三四五六日]/ })).toHaveLength(7);
    expect(monthGrid.querySelectorAll('[role="gridcell"]')).toHaveLength(42);
    // 结构回归（P4-11）：`role="grid"` 的直接子元素只能是 `role="row"` —— 表头一行 + 六个日期行；
    // 每行恰好 7 个格子。缺了 row 这一层，axe 会报 aria-required-children／aria-required-parent。
    const rows = monthGrid.querySelectorAll(':scope > [role="row"]');
    expect(rows).toHaveLength(7);
    expect(rows[0].querySelectorAll('[role="columnheader"]')).toHaveLength(7);
    expect(rows[0].querySelectorAll('[role="gridcell"]')).toHaveLength(0);
    for (const row of Array.from(rows).slice(1)) expect(row.querySelectorAll('[role="gridcell"]')).toHaveLength(7);
    // 表头行与日期行都直接挂在 grid 下，中间没有其它非 row 子节点。
    expect(monthGrid.querySelectorAll(":scope > :not([role='row'])")).toHaveLength(0);
  });

  it("shows prioritized month summaries and opens the selected date in a right-side detail panel", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "month", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, month: "2026-08-05" } };
    const tasks = [
      { id: "due", projectId: null, title: "交付报告", progress: 20, status: "active" as const, deadlineLocal: "2026-08-05", estimatedMinutes: 60, sortOrder: 0 },
      { id: "done", projectId: null, title: "完成复盘", progress: 100, status: "completed" as const, deadlineLocal: null, estimatedMinutes: 30, sortOrder: 1 },
    ];
    const progressEvents = [{ id: "done-event", taskId: "done", fromProgress: 80, toProgress: 100, occurredAtUtc: "2026-08-05T12:00:00Z" }];
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi({ ...structuredClone(EMPTY_WORKSPACE), tasks, progressEvents })} />);

    const cell = await screen.findByRole("gridcell", { name: /2026-08-05/ });
    expect(cell).toHaveTextContent("交付报告"); expect(cell).toHaveTextContent("完成 1");
    await user.click(cell);
    const detail = screen.getByRole("complementary", { name: /2026-08-05.*详情/ });
    expect(detail).toHaveTextContent("交付报告"); expect(detail).toHaveTextContent("完成复盘");
    await user.click(screen.getByRole("button", { name: "打开日视图" }));
    expect(screen.getByRole("button", { name: "日" })).toHaveAttribute("aria-pressed", "true");
  });

  it("closes the month detail panel with X, Escape and the same cell", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "month", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, month: "2026-08-05" } };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    const cell = await screen.findByRole("gridcell", { name: /2026-08-05/ });

    await user.click(cell);
    expect(screen.getByRole("complementary", { name: /2026-08-05.*详情/ })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "关闭日期详情" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: /详情/ })).not.toBeInTheDocument());

    await user.click(cell);
    expect(screen.getByRole("complementary", { name: /2026-08-05.*详情/ })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("complementary", { name: /详情/ })).not.toBeInTheDocument());

    await user.click(cell);
    expect(screen.getByRole("complementary", { name: /2026-08-05.*详情/ })).toBeVisible();
    await user.click(cell);
    await waitFor(() => expect(screen.queryByRole("complementary", { name: /详情/ })).not.toBeInTheDocument());
    expect(cell).toHaveAttribute("aria-selected", "false");
  });

  it("keeps the month overflow button opening the detail while the cell is already selected", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "month", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, month: "2026-08-05" } };
    const tasks = Array.from({ length: 3 }, (_, index) => ({ id: `due-${index}`, projectId: null, title: `截止 ${index + 1}`, progress: 0, status: "active" as const, deadlineLocal: "2026-08-05", estimatedMinutes: 30, sortOrder: index }));
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi({ ...structuredClone(EMPTY_WORKSPACE), tasks })} />);
    await user.click(await screen.findByRole("gridcell", { name: /2026-08-05/ }));
    expect(screen.getByRole("complementary", { name: /2026-08-05.*详情/ })).toBeVisible();
    await user.click(screen.getByRole("button", { name: /另外 1 项/ }));
    expect(screen.getByRole("complementary", { name: /2026-08-05.*详情/ })).toBeVisible();
  });

  it("navigates the month grid without selecting until Enter", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "month", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, month: "2026-08-05" } };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    const cell = await screen.findByRole("gridcell", { name: /2026-08-05/ }); cell.focus();

    await user.keyboard("{ArrowRight}{ArrowDown}{ArrowLeft}{ArrowUp}");
    expect(document.activeElement).toHaveAccessibleName(/2026-08-05/);
    expect(screen.queryByRole("complementary", { name: /详情/ })).not.toBeInTheDocument();
    await user.keyboard("{Home}"); expect(document.activeElement).toHaveAccessibleName(/2026-08-03/);
    await user.keyboard("{End}"); expect(document.activeElement).toHaveAccessibleName(/2026-08-09/);
    await user.keyboard("{PageDown}"); await waitFor(() => expect(document.activeElement).toHaveAccessibleName(/2026-09-09/));
    await user.keyboard("{PageUp}"); await waitFor(() => expect(document.activeElement).toHaveAccessibleName(/2026-08-09/)); await user.keyboard("{Enter}");
    expect(screen.getByRole("gridcell", { name: /2026-08-09/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("complementary", { name: /2026-08-09.*详情/ })).toBeVisible();
  });

  it("turns an all-day count chip into a day-view jump without opening a detail panel", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const tasks = Array.from({ length: 4 }, (_, index) => ({ id: `due-${index}`, projectId: null, title: `全天 ${index + 1}`, progress: 0, status: "active" as const, deadlineLocal: "2026-08-05", estimatedMinutes: 30, sortOrder: index }));
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi({ ...structuredClone(EMPTY_WORKSPACE), tasks })} />);

    const allDay = await screen.findByRole("region", { name: "全天标记" });
    expect(allDay.querySelectorAll("[data-all-day-group]")).toHaveLength(1);
    const chip = within(allDay).getByRole("button", { name: /截止 4 项/ });
    // 四天截止仍写在 chip 的提示里：周视图不再有二级名单，但信息面不缩水。
    expect(chip).toHaveAttribute("title", expect.stringContaining("全天 1"));
    await user.click(chip);
    expect(screen.getByRole("button", { name: "日" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("8月5日 周三");
    expect(screen.queryByRole("complementary", { name: /详情/ })).not.toBeInTheDocument();
    expect(document.querySelector(".calendar-date-details")).toBeNull();
  });

  it("shows project deadline and milestone count chips and jumps to the day view", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "毕业设计", deadlineLocal: "2026-08-05" }],
      projectMilestones: [{ id: "ms-1", projectId: "project-1", title: "中期答辩", targetLocalDate: "2026-08-05", sortOrder: 0, criterionKind: "taskCount", targetTaskId: null, targetCount: 2, targetProgress: null }],
      tasks: [{ id: "task-1", projectId: "project-1", title: "写论文", progress: 40, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
    };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi(initial)} />);

    const allDay = await screen.findByRole("region", { name: "全天标记" });
    const projectChip = within(allDay).getByRole("button", { name: /项目截止 1 项/ });
    expect(projectChip).toHaveAttribute("title", expect.stringContaining("毕业设计"));
    // A6：全天区收成一行，排不下的组收进「+N」；完整名单写在提示里。
    const moreChip = within(allDay).getByRole("button", { name: /另外 1 组全天标记/ });
    expect(moreChip).toHaveAttribute("title", expect.stringContaining("中期答辩"));
    await user.click(projectChip);
    expect(screen.getByRole("button", { name: "日" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("8月5日 周三");
    expect(document.querySelector(".calendar-date-details")).toBeNull();
  });

  it("opens the project's day view from a milestone chip in the week all-day row", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "毕业设计", deadlineLocal: null }],
      projectMilestones: [{ id: "ms-1", projectId: "project-1", title: "中期答辩", targetLocalDate: "2026-08-05", sortOrder: 0, criterionKind: "taskCount", targetTaskId: null, targetCount: 2, targetProgress: null }],
    };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi(initial)} />);

    const allDay = await screen.findByRole("region", { name: "全天标记" });
    const milestoneChip = within(allDay).getByRole("button", { name: /里程碑 1 项/ });
    expect(milestoneChip).toHaveAttribute("title", expect.stringContaining("中期答辩"));
    await user.click(milestoneChip);
    expect(screen.getByRole("button", { name: "日" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("8月5日 周三");
    expect(document.querySelector(".calendar-date-details")).toBeNull();
  });

  it("shows project deadline and milestone items in the month cell and opens the project detail", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "month", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, month: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "毕业设计", deadlineLocal: "2026-08-05" }],
      projectMilestones: [{ id: "ms-1", projectId: "project-1", title: "中期答辩", targetLocalDate: "2026-08-05", sortOrder: 0, criterionKind: "taskCount", targetTaskId: null, targetCount: 2, targetProgress: null }],
    };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi(initial)} />);

    const cell = await screen.findByRole("gridcell", { name: /2026-08-05/ });
    expect(cell).toHaveTextContent("毕业设计"); expect(cell).toHaveTextContent("中期答辩");
    await user.click(screen.getByRole("button", { name: /里程碑：中期答辩/ }));
    const detail = screen.getByRole("complementary", { name: /2026-08-05.*详情/ });
    expect(detail).toHaveTextContent("毕业设计");
    expect(detail).toHaveTextContent("今天到期");
  });

  it("moves the week all-day toggle into the date header and removes its row when collapsed", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const tasks = [{ id: "due-1", projectId: null, title: "全天截止", progress: 0, status: "active" as const, deadlineLocal: "2026-08-05", estimatedMinutes: 30, sortOrder: 0 }];
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi({ ...structuredClone(EMPTY_WORKSPACE), tasks })} />);

    const collapse = await screen.findByRole("button", { name: "收起全天标记" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    expect(collapse).toHaveAttribute("aria-controls", "calendar-week-all-day");
    const region = screen.getByRole("region", { name: "全天标记" });
    expect(region).toHaveAttribute("id", "calendar-week-all-day");
    expect(within(region).getByRole("button", { name: /截止 1 项/ })).toBeVisible();

    await user.click(collapse);
    // 收起态不渲染第二行：整段 hidden，既不可访问也不占吸顶高度（C1／#10）。
    expect(document.getElementById("calendar-week-all-day")).toHaveAttribute("hidden");
    expect(screen.getByRole("button", { name: "展开全天标记" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "全天标记" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "展开全天标记" }));
    expect(screen.getByRole("region", { name: "全天标记" })).toBeVisible();
  });

  it("disables the default-slots mode when no default slots exist and renders the day as a full day", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T08:00:00+08:00"));
    try {
      const backend = new MemorySettingsBackend();
      backend.value = {
        ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day", calendarDayMode: "defaultSlots", defaultTimeSlots: [],
        calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, day: "2026-08-05" },
      };
      render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);

      const slotsMode = await screen.findByRole("button", { name: "可用时间" });
      expect(slotsMode).toBeDisabled();
      expect(slotsMode).toHaveAttribute("title", "先在设置里标出可用时间");
      expect(slotsMode).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "全天" })).not.toBeDisabled();
      // 兜底：按 fullDay 渲染，不再整天塌成一条 44px 折叠带；偏好值原样保留。
      expect(document.querySelectorAll(".collapsed-time-gap")).toHaveLength(0);
      await waitFor(() => expect(backend.value).toMatchObject({ calendarDayMode: "defaultSlots", defaultTimeSlots: [] }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps back-to-now visible in day and week views and returns from another day", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T08:00:00+08:00"));
    try {
      const user = userEvent.setup(); const backend = new MemorySettingsBackend();
      backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, day: "2026-08-04" } };
      render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);

      const backToNow = await screen.findByRole("button", { name: "回到现在" });
      expect(backToNow).toBeVisible();
      await user.click(backToNow);
      // 锚点非今天：点击先回今天（显露在真实浏览器里由 viewport.revealNow 完成）。
      await waitFor(() => expect(backend.value).toMatchObject({ calendarAnchors: { day: "2026-08-05" } }));
      expect(screen.getByRole("button", { name: "回到现在" })).toBeVisible();

      await user.click(screen.getByRole("button", { name: "周" }));
      expect(await screen.findByRole("button", { name: "回到现在" })).toBeVisible();
      await user.click(screen.getByRole("button", { name: "月" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "回到现在" })).not.toBeInTheDocument());
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves week header focus with keyboard and opens the day view on Enter", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    const header = await screen.findByRole("button", { name: /打开 2026-08-05/ }); header.focus();
    await user.keyboard("{ArrowRight}{ArrowLeft}{PageDown}");
    await waitFor(() => expect(document.activeElement).toHaveAccessibleName(/打开 2026-08-12/));
    // D17：日期头 Enter 直接进入该日日视图，不再选中列 + 右侧详情。
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "日" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("8月12日 周三");
    expect(document.querySelector(".calendar-date-details")).toBeNull();

    // 回到周视图，键盘创建通道仍走空白气泡（指针单击才是「打开这一天」）。
    await user.click(screen.getByRole("button", { name: "周" }));
    const track = await screen.findByRole("group", { name: "2026-08-12 09:00 空白时间" }); track.focus();
    await user.keyboard("{ArrowDown}"); expect(document.activeElement).toHaveAccessibleName("2026-08-12 09:15 空白时间");
    await user.keyboard("{ArrowUp}"); expect(document.activeElement).toHaveAccessibleName("2026-08-12 09:00 空白时间");
    await user.keyboard("{ArrowRight}"); expect(document.activeElement).toHaveAccessibleName("2026-08-13 09:00 空白时间");
    await user.keyboard("{ArrowLeft}"); expect(document.activeElement).toHaveAccessibleName("2026-08-12 09:00 空白时间");
    expect(screen.queryByRole("dialog", { name: "空白时段操作" })).not.toBeInTheDocument();
    await user.keyboard("{PageDown}"); await waitFor(() => expect(document.activeElement).toHaveAccessibleName("2026-08-19 09:00 空白时间"));
    await user.keyboard("{PageUp}"); await waitFor(() => expect(document.activeElement).toHaveAccessibleName("2026-08-12 09:00 空白时间"));
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "空白时段操作" })).toHaveTextContent("09:15–09:45");
  });

  it("opens a focused week session with Enter", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const task = { id: "keyboard-task", projectId: null, title: "键盘任务", progress: 10, status: "active" as const, deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 };
    const session = { id: "keyboard-session", taskId: task.id, localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" as const };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi({ ...structuredClone(EMPTY_WORKSPACE), tasks: [task], executionSessions: [session] })} />);
    const card = await screen.findByRole("article", { name: /键盘任务/ }); card.focus(); await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "编辑时间：键盘任务" })).toBeVisible();
  });

  it("opens a week date header's day view on a single click", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi()} />);
    await user.click(await screen.findByRole("button", { name: "日历" }));
    const todayHeader = screen.getByRole("button", { name: /打开 2026-08-05/ });
    expect(todayHeader).toHaveTextContent("今天");
    await user.click(todayHeader);
    expect(screen.getByRole("button", { name: "日" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("8月5日 周三");
    expect(document.querySelector(".calendar-date-details")).toBeNull();
    vi.useRealTimers();
  });

  it("opens the day view when clicking blank week space without dragging", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await screen.findByRole("button", { name: "显示更多日历选项" });
    const track = document.querySelector<HTMLElement>('.calendar-day[data-day-date="2026-08-05"] .day-track')!;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 1440, width: 200, height: 1440, toJSON: () => ({}) });
    // 按下与松开落在同一分钟＝单击，不是拖选。
    fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientX: 240, clientY: 600 });
    fireEvent.pointerUp(track, { button: 0, pointerId: 1, clientX: 240, clientY: 600 });
    expect(screen.getByRole("button", { name: "日" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("8月5日 周三");
    expect(screen.queryByRole("dialog", { name: "空白时段操作" })).not.toBeInTheDocument();
    expect(document.querySelector(".calendar-date-details")).toBeNull();
  });

  it("keeps a separate anchor for each calendar view and persists the last view", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const backend = new MemorySettingsBackend();
    const first = render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    try {
      await user.click(await screen.findByRole("button", { name: "日历" }));
      await user.click(screen.getByRole("button", { name: "下一段日期" }));
      expect(screen.getByText("8月10日 — 8月16日")).toBeVisible();
      await user.click(screen.getByRole("button", { name: "月" }));
      await user.click(screen.getByRole("button", { name: "下一段日期" }));
      expect(screen.getByText("2026年9月")).toBeVisible();
      await user.click(screen.getByRole("button", { name: "周" }));
      expect(screen.getByText("8月10日 — 8月16日")).toBeVisible();
      await user.click(screen.getByRole("button", { name: "月" }));
      expect(screen.getByText("2026年9月")).toBeVisible();
      await waitFor(() => expect(backend.value).toMatchObject({ calendarView: "month" }));
      first.unmount();
      render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
      expect(await screen.findByRole("button", { name: "月" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText("2026年9月")).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps and restores an actual zoom level for each calendar view", async () => {
    const user = userEvent.setup();
    const backend = new MemorySettingsBackend();
    const first = render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await user.click(await screen.findByRole("button", { name: "日历" }));
    await user.click(screen.getByRole("button", { name: "紧凑" }));
    expect(document.querySelector(".calendar-page")).toHaveAttribute("data-calendar-zoom", "compact");
    await user.click(screen.getByRole("button", { name: "月" }));
    await user.click(screen.getByRole("button", { name: "详细" }));
    expect(document.querySelector(".calendar-page")).toHaveAttribute("data-calendar-zoom", "detailed");
    await user.click(screen.getByRole("button", { name: "周" }));
    expect(document.querySelector(".calendar-page")).toHaveAttribute("data-calendar-zoom", "compact");
    await user.click(screen.getByRole("button", { name: "月" }));
    await waitFor(() => expect(backend.value).toMatchObject({ calendarZoom: { week: "compact", month: "detailed" } }));
    first.unmount();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    expect(await screen.findByRole("button", { name: "详细" })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".calendar-page")).toHaveAttribute("data-calendar-zoom", "detailed");
  });

  it("uses Ctrl plus wheel for continuous calendar zoom while an ordinary wheel only browses", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week" };
    const native = createNativeApi();
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    const calendar = await screen.findByRole("region", { name: "日历时间网格" });
    const page = document.querySelector(".calendar-page")!;
    expect(page).toHaveAttribute("data-calendar-scale", "84");
    fireEvent.wheel(calendar, { deltaY: -100, ctrlKey: false, clientY: 300 });
    expect(page).toHaveAttribute("data-calendar-scale", "84");
    fireEvent.wheel(calendar, { deltaY: -100, ctrlKey: true, clientY: 300 });
    // 滚轮缩放要量一遍所有日轨的几何（getBoundingClientRect × 7）；全量跑测试时
    // 机器更忙，1s 的默认轮询窗口偶尔不够，这里放宽到 3s。
    await waitFor(() => expect(page).toHaveAttribute("data-calendar-scale", "88"), { timeout: 3000 });
    await waitFor(() => expect(backend.value).toMatchObject({ calendarScale: { week: 88 } }));
    expect(native.updateExecutionSession).not.toHaveBeenCalled();
  });

  it("keeps the calendar card height tier hook while the box owns row visibility", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T08:00:00+08:00"));
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, day: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "发布计划", deadlineLocal: null }],
      tasks: [
        { id: "task-short", projectId: "project-1", title: "短时段", progress: 10, status: "active", deadlineLocal: null, estimatedMinutes: 20, sortOrder: 0 },
        { id: "task-medium", projectId: "project-1", title: "中时段", progress: 40, status: "active", deadlineLocal: null, estimatedMinutes: 45, sortOrder: 1 },
        { id: "task-long", projectId: "project-1", title: "长时段", progress: 70, status: "active", deadlineLocal: null, estimatedMinutes: 90, sortOrder: 2 },
      ],
      executionSessions: [
        { id: "session-short", taskId: "task-short", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "10:20", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
        { id: "session-medium", taskId: "task-medium", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "11:00", endLocal: "11:45", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
        { id: "session-long", taskId: "task-long", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "13:00", endLocal: "14:30", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
      ],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    try {
      const short = (await screen.findByText("短时段", { selector: ".calendar-session strong" })).closest(".calendar-session")!;
      const medium = screen.getByText("中时段", { selector: ".calendar-session strong" }).closest(".calendar-session")!;
      const long = screen.getByText("长时段", { selector: ".calendar-session strong" }).closest(".calendar-session")!;
      // A5：密度只留作「盒子高度档位」钩子（悬停动作条阈值 + 测试）；行都在 DOM 里，
      // 显隐由 `.calendar-session` 的高度容器查询决定（jsdom 不跑布局，因此这里断言契约）。
      expect(short).toHaveAttribute("data-card-density", "compact");
      expect(short.querySelector(".session-time")).toHaveTextContent("10:00–10:20");
      expect(short.querySelector(".session-task-progress")).toBeInTheDocument();
      expect(short.querySelector(".session-meta")).toBeInTheDocument();
      expect(short.querySelector("button[aria-label='编辑 短时段 时间']")).toHaveAttribute("data-action-visibility", "on-demand");
      expect(medium).toHaveAttribute("data-card-density", "standard");
      expect(medium.querySelector(".session-time")).toHaveTextContent("11:00–11:45");
      expect(medium.querySelector(".session-project")).toHaveTextContent("发布计划");
      expect(medium.querySelector("button[aria-label='编辑 中时段 时间']")).toHaveAttribute("data-action-visibility", "on-demand");
      expect(long).toHaveAttribute("data-card-density", "detailed");
      expect(long.querySelector(".session-project")).toHaveTextContent("发布计划");
      expect(long.querySelector(".session-progress-value")).toHaveTextContent("70%");
      expect(long.querySelector("button[aria-label='编辑 长时段 时间']")).toHaveAttribute("data-action-visibility", "visible");
      expect(native.updateExecutionSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("folds non-default day ranges, shows their arrangement count, and keeps expansion temporary", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T08:00:00+08:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const backend = new MemorySettingsBackend();
    backend.value = {
      ...DEFAULT_SETTINGS,
      lastPage: "calendar",
      calendarView: "day",
      calendarDayMode: "defaultSlots",
      calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, day: "2026-08-05" },
      defaultTimeSlots: [{ id: "evening", label: "晚间专注", start: "19:00", end: "22:00", weekdays: [3] }],
    };
    const initial: WorkspaceSnapshot = {
      ...structuredClone(EMPTY_WORKSPACE),
      tasks: [
        { id: "task-current", projectId: null, title: "当前窗口任务", progress: 10, status: "active", deadlineLocal: null, estimatedMinutes: 30, sortOrder: 0 },
        { id: "task-folded", projectId: null, title: "折叠区任务", progress: 20, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 1 },
        { id: "task-drop", projectId: null, title: "拖入折叠区", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 2 },
      ],
      executionSessions: [
        { id: "session-current", taskId: "task-current", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "06:30", endLocal: "08:30", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
        { id: "session-folded", taskId: "task-folded", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
      ],
      timeBlocks: [{ id: "block-folded", title: "会议", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "12:00", endLocal: "13:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480 }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    /**
     * 折叠条在 jsdom 里没有布局：命中判定读的是 `getBoundingClientRect`，所以这里逐元素
     * 打桩（每次重新取当前 DOM 上的那一条 —— 展开／收起会换掉它）。
     */
    const stubRect = (element: Element | null, rect: { top: number; bottom: number; height: number; right?: number }) => {
      if (!element) throw new Error("折叠条必须存在");
      Object.defineProperty(element, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ x: 0, y: rect.top, top: rect.top, left: 0, right: rect.right ?? 200, bottom: rect.bottom, width: 200, height: rect.height, toJSON: () => ({}) }),
      });
    };
    /**
     * 手指要点到「09:00–19:00」那一条：三日缓冲里前一天／后一天也有折叠条，
     * 而同一天还另有一条 00:00–09:00 —— 展开错哪一条都看不到 10:00 的安排。
     */
    const stubGap = () => {
      const gaps = Array.from(document.querySelectorAll<HTMLElement>('[data-calendar-date="2026-08-05"] .collapsed-time-gap'));
      const target = gaps.find((gap) => (gap.dataset.gapKey ?? "").endsWith("-1140"));
      if (!target) throw new Error("09:00–19:00 的折叠条必须存在");
      stubRect(target, { top: 100, bottom: 144, height: 44 });
    };
    try {
      expect(await screen.findByRole("button", { name: "可用时间" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText("当前窗口任务", { selector: ".calendar-session strong" })).toBeVisible();
      expect(screen.queryByText("折叠区任务", { selector: ".calendar-session strong" })).not.toBeInTheDocument();
      const folded = screen.getByRole("button", { name: "09:00–19:00 · 2 项安排" });
      await user.click(folded);
      expect(screen.getByText("折叠区任务", { selector: ".calendar-session strong" })).toBeVisible();
      expect(backend.value).toMatchObject({ calendarDayMode: "defaultSlots" });
      await user.click(screen.getByRole("button", { name: "收起 09:00–19:00" }));
      expect(screen.queryByText("折叠区任务", { selector: ".calendar-session strong" })).not.toBeInTheDocument();

      const row = screen.getByText("拖入折叠区", { selector: ".task-card strong" }).closest<HTMLElement>(".task-card")!;
      stubRect(document.querySelector('[data-calendar-date="2026-08-05"] .day-track'), { top: 0, bottom: 1440, height: 1440 });

      // ① 悬停不足半秒就离开：不展开（计时被取消）。
      stubGap();
      fireEvent.pointerDown(row, { button: 0, clientX: 30, clientY: 10 });
      fireEvent(window, createEvent.pointerMove(window, { clientX: 30, clientY: 120 }));
      act(() => vi.advanceTimersByTime(250));
      fireEvent(window, createEvent.pointerMove(window, { clientX: 600, clientY: 120 }));
      act(() => vi.advanceTimersByTime(300));
      expect(screen.queryByText("折叠区任务", { selector: ".calendar-session strong" })).not.toBeInTheDocument();

      // ② 悬停满半秒：展开；回到折叠条范围外：恢复原状。
      fireEvent(window, createEvent.pointerMove(window, { clientX: 30, clientY: 120 }));
      act(() => vi.advanceTimersByTime(499));
      expect(screen.queryByText("折叠区任务", { selector: ".calendar-session strong" })).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByText("折叠区任务", { selector: ".calendar-session strong" })).toBeVisible();
      fireEvent(window, createEvent.pointerMove(window, { clientX: 600, clientY: 120 }));
      expect(screen.queryByText("折叠区任务", { selector: ".calendar-session strong" })).not.toBeInTheDocument();

      // ③ 再展开一次后松手，但写入失败：临时展开必须撤掉，卡片回到折叠态。
      stubGap();
      fireEvent(window, createEvent.pointerMove(window, { clientX: 30, clientY: 120 }));
      act(() => vi.advanceTimersByTime(500));
      expect(screen.getByText("折叠区任务", { selector: ".calendar-session strong" })).toBeVisible();
      (native.applyExecutionSessionChanges as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("写入失败"));
      fireEvent(window, createEvent.pointerUp(window, { clientX: 30, clientY: 120 }));
      await waitFor(() => expect(screen.queryByText("折叠区任务", { selector: ".calendar-session strong" })).not.toBeInTheDocument());

      await user.click(screen.getByRole("button", { name: "全天" }));
      expect(screen.getByText("折叠区任务", { selector: ".calendar-session strong" })).toBeVisible();
      await waitFor(() => expect(backend.value).toMatchObject({ calendarDayMode: "fullDay" }));
      expect(native.updateExecutionSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // ---------------------------------------------------------------------
  // 日历整改 A4：F05 单条 44px 吸顶日期带 / F08 有效日折叠 / F08③ 前一天带子
  // ---------------------------------------------------------------------

  it("merges the separator and the day header into one sticky band carrying the day's facts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T08:00:00+08:00"));
    const backend = new MemorySettingsBackend();
    backend.value = {
      ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day", calendarDayMode: "fullDay",
      calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, day: "2026-08-05" },
    };
    const initial: WorkspaceSnapshot = {
      ...structuredClone(EMPTY_WORKSPACE),
      tasks: [
        { id: "band-a", projectId: null, title: "带子任务一", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 },
        { id: "band-b", projectId: null, title: "带子任务二", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 10, sortOrder: 1 },
      ],
      executionSessions: [
        { id: "band-session-a", taskId: "band-a", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "09:00", endLocal: "10:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
        { id: "band-session-b", taskId: "band-b", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "20:00", endLocal: "20:10", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
      ],
    };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi(initial)} />);
    try {
      const band = (await screen.findByText("8月5日", { selector: ".calendar-day-band-date" })).closest<HTMLElement>(".calendar-day-band")!;
      expect(band).toBeInTheDocument();
      expect(band).toHaveTextContent("8月5日");
      expect(band.querySelector(".calendar-day-band-date span")).toHaveTextContent("周三");
      expect(band.querySelector(".calendar-day-band-today")).toHaveTextContent("今天");
      // 计数与投入直接来自 calendarDaySummary：70 分钟 ⇒ 1h10m，组件里没有第二套算式。
      expect(band.querySelector(".calendar-day-band-summary")).toHaveTextContent("2 项安排 · 投入 1h10m");
      // 双层吸顶彻底消失：分隔条、日头与时间轴占位块都不该再出现。
      expect(document.querySelector(".continuous-day-separator")).toBeNull();
      expect(document.querySelector(".calendar-day > header")).toBeNull();
      expect(document.querySelector(".day-head-spacer")).toBeNull();
      // 时间轴一侧不再有第二层占位，只保留轨道本身。
      expect(document.querySelector('.continuous-day-panel[data-calendar-date="2026-08-05"] .calendar-day-band')).toBe(band);
    } finally {
      vi.useRealTimers();
    }
  });

  it("folds an empty early morning and late night in full-day mode and re-opens them as a whole day", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T08:00:00+08:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const backend = new MemorySettingsBackend();
    backend.value = {
      ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day", calendarDayMode: "fullDay",
      calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, day: "2026-08-05" },
    };
    const initial: WorkspaceSnapshot = {
      ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "fold-task", projectId: null, title: "有效日任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
      executionSessions: [{ id: "fold-session", taskId: "fold-task", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "09:00", endLocal: "10:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
    };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi(initial)} />);
    try {
      // 三日缓冲里每个空日都会各自折叠，查询必须锁在锚点那一块面板上。
      const panel = (await screen.findByText("8月5日", { selector: ".calendar-day-band-date" })).closest<HTMLElement>(".continuous-day-panel")!;
      const day = within(panel);
      const track = day.getByRole("button", { name: "凌晨 00:00–06:00 · 无安排" }).closest(".day-track")!;
      expect(day.getByRole("button", { name: "深夜 23:00–24:00 · 无安排" })).toBeVisible();
      expect(screen.getByText("有效日任务", { selector: ".calendar-session strong" })).toBeVisible();
      // 06:00–23:00 逐小时 + 两条 44px 折叠带：标准档 168px/小时 ⇒ 17×168 + 88。
      expect(track).toHaveStyle({ height: `${17 * 168 + 44 * 2}px` });
      // 折叠带把凌晨/深夜的时段折进一条带子，但仍是**按钮**：拖拽悬停与点击展开照常。
      expect(track.querySelectorAll('.timeline-map-segment[data-collapsed="true"]')).toHaveLength(2);

      await user.click(day.getByRole("button", { name: "展开整天" }));
      expect(track).toHaveStyle({ height: `${24 * 168}px` });
      expect(track.querySelectorAll('.timeline-map-segment[data-collapsed="true"]')).toHaveLength(0);
      // 展开后必须还能收回去（临时展开不落库，见下一条断言）。
      await user.click(day.getByRole("button", { name: "收起 00:00–06:00" }));
      expect(day.getByRole("button", { name: "凌晨 00:00–06:00 · 无安排" })).toBeVisible();
      expect(backend.value).toMatchObject({ calendarDayMode: "fullDay" });
      expect(JSON.stringify(backend.value)).not.toContain("expandedGap");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the early hours open when the day has work or the clock is inside them", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T02:00:00+08:00"));
    const backend = new MemorySettingsBackend();
    backend.value = {
      ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day", calendarDayMode: "fullDay",
      calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, day: "2026-08-05" },
    };
    const initial: WorkspaceSnapshot = {
      ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "night-task", projectId: null, title: "凌晨任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
      executionSessions: [{ id: "night-session", taskId: "night-task", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "09:00", endLocal: "10:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
    };
    const view = render(<App settings={new SettingsRepository(backend)} native={createNativeApi(initial)} />);
    try {
      const panel = (await screen.findByText("8月5日", { selector: ".calendar-day-band-date" })).closest<HTMLElement>(".continuous-day-panel")!;
      const day = within(panel);
      // 现在 02:00 落在 00:00–06:00 里：凌晨不折叠，只折深夜。
      expect(day.queryByRole("button", { name: "凌晨 00:00–06:00 · 无安排" })).toBeNull();
      const lateNight = day.getByRole("button", { name: "深夜 23:00–24:00 · 无安排" });
      expect(lateNight).toBeVisible();
      expect(lateNight.closest(".day-track")).toHaveStyle({ height: `${23 * 168 + 44}px` });

      // 安排本身落在凌晨：即使「现在」离开，凌晨也必须因为有事而保持展开。
      vi.setSystemTime(new Date("2026-08-05T12:00:00+08:00"));
      view.rerender(<App settings={new SettingsRepository(backend)} native={createNativeApi({
        ...structuredClone(EMPTY_WORKSPACE),
        tasks: initial.tasks,
        executionSessions: [{ ...initial.executionSessions[0], startLocal: "02:00", endLocal: "03:00" }],
      })} />);
      await waitFor(() => expect(day.queryByRole("button", { name: "凌晨 00:00–06:00 · 无安排" })).toBeNull());
      expect(day.getByRole("button", { name: "深夜 23:00–24:00 · 无安排" })).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the buffered previous day as one collapsed band that expands without moving the anchor", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T08:00:00+08:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const backend = new MemorySettingsBackend();
    backend.value = {
      ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day", calendarDayMode: "fullDay",
      calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, day: "2026-08-05" },
    };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    try {
      const previous = (await screen.findByRole("region", { name: "连续日时间轴" })).querySelector<HTMLElement>('.continuous-day-panel[data-calendar-date="2026-08-04"]')!;
      expect(previous).toHaveClass("is-previous-collapsed");
      expect(previous.querySelector(".calendar-day-band")).toHaveClass("is-collapsed");
      // 前一天不再渲染 24 小时网格：整块面板只剩一条带子。
      expect(previous.querySelector(".day-track")).toBeNull();
      expect(previous.querySelector(".calendar-day-band")).toHaveTextContent("8月4日");
      // 带子仍然是「这一天」的归属：aria-label 里带上日期与当日事实。
      expect(previous.querySelector(".calendar-day-band")).toHaveAttribute("aria-label", "前一天 8月4日 星期二 · 无安排");

      await user.click(within(previous).getByRole("button", { name: /展开前一天 8月4日/ }));
      expect(previous).not.toHaveClass("is-previous-collapsed");
      expect(previous.querySelector(".calendar-day-band")).not.toHaveClass("is-collapsed");
      // 展开出来的前一天本身是「空日」，所以它自己也按有效日折叠：17 小时 + 两条折叠带。
      expect(previous.querySelector(".day-track")).toHaveStyle({ height: `${17 * 168 + 44 * 2}px` });
      // 展开是浏览过程里的一次动作：锚点仍是 8月5日，也不写任何偏好。
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("8月5日");
      expect((backend.value as AppSettings).calendarAnchors.day).toBe("2026-08-05");
      expect(JSON.stringify(backend.value)).not.toContain("expandedPrevious");

      // 展开后不回缩：带子上已经没有展开入口。
      expect(within(previous).queryByRole("button", { name: /展开前一天 8月4日/ })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("expands the buffered previous day when the user keeps scrolling up at the top", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T08:00:00+08:00"));
    const backend = new MemorySettingsBackend();
    backend.value = {
      ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day", calendarDayMode: "fullDay",
      calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, day: "2026-08-05" },
    };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    try {
      const axis = await screen.findByRole("region", { name: "连续日时间轴" });
      const previous = axis.querySelector<HTMLElement>('.continuous-day-panel[data-calendar-date="2026-08-04"]')!;
      expect(previous.querySelector(".day-track")).toBeNull();
      // 停在内容顶端的向上手势＝「我要看前一天」：先展开带子，而不是把锚点退一天。
      fireEvent.wheel(axis, { deltaY: -120, ctrlKey: false });
      await waitFor(() => expect(previous.querySelector(".day-track")).not.toBeNull());
      expect((backend.value as AppSettings).calendarAnchors.day).toBe("2026-08-05");
      // 缩放（Ctrl+滚轮）不是向上滚：不得顺手展开前一天。
      fireEvent.wheel(axis, { deltaY: -120, ctrlKey: true });
      expect(previous).not.toHaveClass("is-previous-collapsed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reveals and highlights a folded session opened from another page", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T08:00:00+08:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const backend = new MemorySettingsBackend();
    backend.value = {
      ...DEFAULT_SETTINGS,
      calendarDayMode: "defaultSlots",
      defaultTimeSlots: [{ id: "evening", label: "晚间专注", start: "19:00", end: "22:00", weekdays: [3] }],
    };
    const initial: WorkspaceSnapshot = {
      ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-jump", projectId: null, title: "折叠区跳转", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
      executionSessions: [{ id: "session-jump", taskId: "task-jump", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "21:30", endLocal: "22:30", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
    };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi(initial)} />);
    try {
      await user.click(await screen.findByRole("button", { name: "在日历中查看 折叠区跳转" }));
      expect(screen.getByRole("button", { name: "日" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText("折叠区跳转", { selector: ".calendar-session strong" }).closest(".calendar-session")).toHaveClass("targeted-session");
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes an external session event into the folded day timeline", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T08:00:00+08:00"));
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    const backend = new MemorySettingsBackend();
    backend.value = {
      ...DEFAULT_SETTINGS,
      calendarDayMode: "defaultSlots",
      defaultTimeSlots: [{ id: "evening", label: "晚间专注", start: "19:00", end: "22:00", weekdays: [3] }],
    };
    const initial: WorkspaceSnapshot = {
      ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-event", projectId: null, title: "外部目标", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
      executionSessions: [{ id: "session-event", taskId: "task-event", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "21:30", endLocal: "22:30", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
    };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi(initial)} />);
    try {
      await waitFor(() => expect(tauriEventCallbacks.has("daymark-open-session")).toBe(true));
      act(() => tauriEventCallbacks.get("daymark-open-session")?.({ payload: { sessionId: "session-event" } }));
      expect(await screen.findByText("外部目标", { selector: ".calendar-session strong" })).toBeVisible();
      expect(screen.getByText("外部目标", { selector: ".calendar-session strong" }).closest(".calendar-session")).toHaveClass("targeted-session");
      act(() => tauriEventCallbacks.get("daymark-open-session")?.({ payload: { sessionId: "missing-session" } }));
      expect(screen.getByRole("button", { name: "今日" })).toHaveAttribute("aria-current", "page");
    } finally {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      tauriEventCallbacks.clear();
      vi.useRealTimers();
    }
  });

  it("moves across midnight on the continuous day axis and returns to today", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi()} />);
    try {
      await user.click(await screen.findByRole("button", { name: "日历" }));
      await user.click(screen.getByRole("button", { name: "日" }));
      const axis = screen.getByRole("region", { name: "连续日时间轴" });
      expect(axis.querySelectorAll(".continuous-day-panel[data-calendar-date]")).toHaveLength(3);
      Object.defineProperties(axis, {
        clientHeight: { configurable: true, value: 600 },
        scrollHeight: { configurable: true, value: 3600 },
        scrollTop: { configurable: true, writable: true, value: 1900 },
      });
      fireEvent.scroll(axis);
      await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("8月5日 周三"));
      axis.scrollTop = 3000;
      fireEvent.scroll(axis);
      await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("8月6日 周四"));
      await user.click(screen.getByRole("button", { name: "回到今天" }));
      await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("8月5日 周三"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the current time and distinguishes elapsed schedule time from manual task progress", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00"));
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, day: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-1", projectId: null, title: "整理研究笔记", progress: 40, status: "active", deadlineLocal: null, estimatedMinutes: 120, sortOrder: 0 }],
      executionSessions: [{ id: "session-1", taskId: "task-1", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "11:00", endLocal: "13:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
    };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi(initial)} />);
    try {
      expect(await screen.findByText("当前安排")).toBeVisible();
      expect(screen.getByText("12:00", { selector: ".calendar-now-line time" })).toBeVisible();
      expect(screen.getByRole("progressbar", { name: "整理研究笔记 时间已进行" })).toHaveAttribute("aria-valuenow", "50");
      expect(screen.getByRole("progressbar", { name: "整理研究笔记 任务进度" })).toHaveAttribute("aria-valuenow", "40");
      expect(document.querySelector(".calendar-session.current-schedule")).toHaveTextContent("整理研究笔记");
      // C3／D14：进行中的卡写「剩余 X 分钟」（12:00 → 13:00 是 60 分钟，折成「1 小时」）。
      expect(document.querySelector(".calendar-session.current-schedule .session-remaining")).toHaveTextContent("剩余 1 小时");
      // 全天模式折掉凌晨之后，「已经过去」不再是整天的 50%：折叠带 44px + 06:00→12:00 按 168px/小时。
      expect(document.querySelector(".calendar-past-region")).toHaveAttribute("style", expect.stringContaining(`height: ${44 + (720 - 360) / 60 * 168}px`));
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders two positionally distinct bars and a remaining-time line only on the running session", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00"));
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, day: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [
        { id: "task-now", projectId: null, title: "进行中的任务", progress: 35, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 },
        { id: "task-later", projectId: null, title: "未开始的任务", progress: 80, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 1 },
      ],
      executionSessions: [
        { id: "session-now", taskId: "task-now", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "11:30", endLocal: "12:30", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
        { id: "session-later", taskId: "task-later", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "15:00", endLocal: "16:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
      ],
    };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi(initial)} />);
    try {
      // 任务池里会出现同名标题，先等卡片特有的「时间已进行」进度条出现，再回溯到卡片。
      const runningCard = (await screen.findByRole("progressbar", { name: "进行中的任务 时间已进行" })).closest(".calendar-session") as HTMLElement;
      // C3／D14：进行中的卡两条 bar 各有各的类名与挂载点（卡顶满宽进度帽 + 卡底内缩胶囊），
      // 位置分离由 CSS 承担（jsdom 没有布局），DOM 侧先钉住「两条 bar + 剩余文字」三件套。
      expect(runningCard.querySelector(".session-task-progress")).not.toBeNull();
      expect(runningCard.querySelector(".session-elapsed")).not.toBeNull();
      expect(runningCard.querySelector(".session-remaining")).toHaveTextContent("剩余 30 分钟");
      expect(screen.getByRole("progressbar", { name: "进行中的任务 任务进度" })).toHaveAttribute("aria-valuenow", "35");
      expect(screen.getByRole("progressbar", { name: "进行中的任务 时间已进行" })).toHaveAttribute("aria-valuenow", "50");
      // 未开始的卡只保留任务进度条：没有时间条，也没有剩余时间文字。
      const laterCard = document.querySelector('.calendar-session[data-session-id="session-later"]') as HTMLElement;
      expect(laterCard.querySelector(".session-task-progress")).not.toBeNull();
      expect(laterCard.querySelector(".session-elapsed")).toBeNull();
      expect(laterCard.querySelector(".session-remaining")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("folds the remaining time into hours when the session runs over an hour", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00"));
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, day: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-long", projectId: null, title: "长时段任务", progress: 10, status: "active", deadlineLocal: null, estimatedMinutes: 150, sortOrder: 0 }],
      executionSessions: [{ id: "session-long", taskId: "task-long", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "11:00", endLocal: "13:30", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
    };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi(initial)} />);
    try {
      const card = (await screen.findByRole("progressbar", { name: "长时段任务 时间已进行" })).closest(".calendar-session") as HTMLElement;
      expect(card.querySelector(".session-remaining")).toHaveTextContent("剩余 1 小时 30 分");
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the pending-review actions only on an explicit gesture", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00+08:00"));
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-1", projectId: null, title: "卡片入口", progress: 10, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
      executionSessions: [{ id: "session-1", taskId: "task-1", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "09:00", endLocal: "10:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
    };
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    try {
      const card = await waitFor(() => {
        const node = document.querySelector<HTMLElement>(".calendar-session.pending-review");
        if (!node) throw new Error("待回顾卡片还没渲染");
        return node;
      });
      const panelName = "卡片入口 待回顾操作";
      // hover 不再弹出气泡：鼠标扫过日历不该冒出一堆浮层
      await user.hover(card);
      expect(screen.queryByRole("dialog", { name: panelName })).not.toBeInTheDocument();
      // 键盘路径：聚焦「待回顾」入口按 Enter 打开，Esc 关闭且不写库
      screen.getByRole("button", { name: "待回顾" }).focus();
      await user.keyboard("{Enter}");
      expect(screen.getByRole("dialog", { name: panelName })).toBeVisible();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog", { name: panelName })).not.toBeInTheDocument();
      expect(native.updateExecutionSession).not.toHaveBeenCalled();
      // 点卡片本体（非按钮区域）同样能打开
      await user.click(card);
      expect(screen.getByRole("dialog", { name: panelName })).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an ended unfinished session pending until the user confirms no progress", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00"));
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" }, checkInEnabled: true };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-1", projectId: null, title: "复盘方案", progress: 35, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
      executionSessions: [{ id: "session-1", taskId: "task-1", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
    };
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    try {
      expect(await screen.findByText("待回顾")).toBeVisible();
      expect(screen.getByText("时段已结束 · 当前进度 35%")).toBeVisible();
      // 动作气泡只在用户明确表达时打开：hover 不再弹，点卡片才弹。
      expect(screen.queryByRole("button", { name: "更新进度" })).not.toBeInTheDocument();
      await user.click(document.querySelector(".calendar-session.pending-review") as HTMLElement);
      expect(screen.getByRole("button", { name: "更新进度" })).toBeVisible();
      expect(screen.getByRole("button", { name: "继续安排" })).toBeVisible();
      expect(native.updateExecutionSession).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "更新进度" }));
      const progress = document.querySelector(".session-review-actions")!.querySelector<HTMLInputElement>('input[aria-label="复盘方案 完成度"]')!;
      fireEvent.change(progress, { target: { value: "50" } });
      fireEvent.keyUp(progress);
      await waitFor(() => expect(native.applyProgress).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1", fromProgress: 35, toProgress: 50 })));
      await user.click(screen.getByRole("button", { name: "继续安排" }));
      expect(screen.getByRole("dialog", { name: "继续安排：复盘方案" })).toBeVisible();
      await user.click(screen.getByRole("button", { name: "创建后续安排" }));
      await waitFor(() => expect(native.createExecutionSession).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1", status: "scheduled" })));
      // 选「继续安排」会先把动作气泡关掉；要确认「本次未推进」得重新打开它。
      expect(screen.queryByRole("button", { name: "本次未推进" })).not.toBeInTheDocument();
      await user.click(document.querySelector(".calendar-session.pending-review") as HTMLElement);
      await user.click(screen.getByRole("button", { name: "本次未推进" }));
      await waitFor(() => expect(native.updateExecutionSession).toHaveBeenCalledWith(expect.objectContaining({ id: "session-1", status: "missed" })));
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists the actual-record switch and overlays facts without changing planned times", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00+08:00"));
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-1", projectId: null, title: "实现叠加层", progress: 25, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
      executionSessions: [{ id: "session-1", taskId: "task-1", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
      executionRecords: [{ id: "record-1", sessionId: "session-1", taskId: "task-1", actualStartUtc: "2026-08-05T02:15:00.000Z", actualEndUtc: "2026-08-05T03:30:00.000Z", note: "" }],
    };
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi(initial)} />);
    try {
      expect(document.querySelector(".calendar-actual-record")).not.toBeInTheDocument();
      await user.click(await screen.findByRole("checkbox", { name: "显示实际记录" }));
      expect(await screen.findByLabelText("实际记录：实现叠加层，10:15–11:30")).toBeVisible();
      expect(document.querySelector(".calendar-session.planned-outline")).toHaveTextContent("10:00–11:00");
      await waitFor(() => expect(backend.value).toMatchObject({ showActualRecords: true }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("can hide the actual-record toolbar control without disabling the stored overlay", async () => {
    const today = isoDaysFromNow(0);
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: today }, showActualRecords: true, showActualRecordsControl: false };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-1", projectId: null, title: "隐藏控制入口", progress: 10, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
      executionRecords: [{ id: "record-1", sessionId: null, taskId: "task-1", actualStartUtc: new Date(Date.now() - 60 * 60_000).toISOString(), actualEndUtc: new Date().toISOString(), note: "" }],
    };
    const user = userEvent.setup();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi(initial)} />);
    const recordCards = await screen.findAllByLabelText(/实际记录：隐藏控制入口/);
    expect(recordCards.length).toBeGreaterThan(0);
    expect(recordCards[0]).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "显示实际记录" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(await screen.findByRole("checkbox", { name: /在日历工具栏显示实际记录开关/ })).not.toBeChecked();
  });

  it("keeps the continue-schedule dialog open and explains a creation failure", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00+08:00"));
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-1", projectId: null, title: "处理冲突", progress: 20, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
      executionSessions: [{ id: "session-1", taskId: "task-1", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "09:00", endLocal: "10:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
    };
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const native = createNativeApi(initial, { createExecutionSession: vi.fn(async () => { throw new Error("所选时间与现有安排冲突"); }) });
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    try {
      const reviewCard = await waitFor(() => {
        const card = document.querySelector<HTMLElement>(".calendar-session.pending-review");
        if (!card) throw new Error("待回顾卡片还没渲染");
        return card;
      });
      await user.click(reviewCard);
      await user.click(await screen.findByRole("button", { name: "继续安排" }));
      await user.click(screen.getByRole("button", { name: "创建后续安排" }));
      const dialog = screen.getByRole("dialog", { name: "继续安排：处理冲突" });
      await waitFor(() => expect(dialog.querySelector('[role="alert"]')).toHaveTextContent("所选时间与现有安排冲突"));
      expect(dialog).toBeVisible();
      expect(screen.getByRole("button", { name: "创建后续安排" })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not mark a session current from the viewer timezone or request review while its actual record is running", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00"));
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" }, showActualRecords: true };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-1", projectId: null, title: "跨时区计划", progress: 10, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
      executionSessions: [{ id: "session-1", taskId: "task-1", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "11:00", endLocal: "11:30", timeZone: "UTC", utcOffsetMinutes: 0, status: "scheduled" }],
      executionRecords: [{ id: "record-1", sessionId: "session-1", taskId: "task-1", actualStartUtc: new Date(Date.now() - 15 * 60_000).toISOString(), actualEndUtc: null, note: "" }],
    };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi(initial)} />);
    try {
      expect(await screen.findByLabelText(/实际记录：跨时区计划/)).toBeVisible();
      expect(document.querySelector(".calendar-session.current-schedule")).not.toBeInTheDocument();
      expect(document.querySelector(".calendar-session.pending-review")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates a title-only task through the durable API and keeps one visible card", async () => {
    const user = userEvent.setup(); const native = createNativeApi();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    const input = await screen.findByRole("textbox", { name: "任务标题" });
    await user.type(input, "整理 Alpha 反馈{Enter}");
    expect(await screen.findByText("整理 Alpha 反馈", { selector: ".task-card strong" })).toBeVisible();
    expect(native.createTask).toHaveBeenCalledOnce();
    expect(input).toHaveValue("");
  });

  it("adds deadline and project details after quick capture", async () => {
    const user = userEvent.setup();
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "Alpha", deadlineLocal: null }],
      tasks: [{ id: "task-1", projectId: null, title: "整理反馈", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    const editButton = await screen.findByRole("button", { name: "编辑任务 整理反馈" });
    await user.click(editButton);
    const popover = await waitFor(() => {
      const node = document.querySelector(".task-editor-fields");
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    await user.selectOptions(within(popover).getByRole("combobox", { name: "项目" }), "project-1");
    // 截止日期改成了自绘月历：用「明日」快捷值，避免依赖当前月份。
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const expected = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
    await user.click(within(popover).getByRole("button", { name: "明日" }));
    expect(native.updateTask).not.toHaveBeenCalled();
    await user.click(within(popover).getByRole("button", { name: "保存任务" }));
    await waitFor(() => expect(native.updateTask).toHaveBeenCalledWith(expect.objectContaining({ deadlineLocal: expected })));
  });

  it("keeps changed settings visible and reports an unsaved write", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await user.click(await screen.findByRole("button", { name: "设置" }));
    backend.failNextWrite = true;
    await user.click(screen.getByRole("radio", { name: "深色" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("未保存");
    expect(screen.getByRole("radio", { name: "深色" })).toBeChecked();
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    await user.click(screen.getByRole("button", { name: "重试保存" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(backend.value).toMatchObject({ appearance: "dark" });
  });

  /**
   * AC16「设置慢写顺序」：旧请求的成功**不得**把新请求的状态改成「已保存」。
   *
   * `persist` 用 `saveRevision` 给每次写入编号，只有最新一次的结果允许改保存指示。
   * 这里把后端做成手动放行的闸门：第一次写入（深色）放行后，第二次（浅色）才从队列
   * 里开始写 —— 此刻界面必须仍是「正在保存」。去掉那个编号判断，旧请求返回时就会
   * 抢先写上「已保存到本机」，用户看到的是「写完了」，而最新的偏好其实还在写。
   */
  it("does not let an older settings write report saved while a newer one is still in flight", async () => {
    const user = userEvent.setup();
    class GatedSettingsBackend implements SettingsBackend {
      value: unknown = DEFAULT_SETTINGS;
      writes = 0;
      private gates: Array<() => void> = [];
      async read() { return this.value; }
      write(value: unknown) {
        this.writes += 1;
        this.value = value;
        return new Promise<void>((resolve) => { this.gates.push(resolve); });
      }
      /** 放行当前所有在途写入；队列随后开始的写入会在下一次轮询里被放行。 */
      releaseAll() { this.gates.splice(0).forEach((resolve) => resolve()); }
    }

    const backend = new GatedSettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("radio", { name: "深色" }));
    await user.click(screen.getByRole("radio", { name: "浅色" }));
    // 写入按顺序排队：第一次还挂在后端上，第二次根本还没开始。
    expect(backend.writes).toBe(1);

    // 放行旧请求（深色）：它成功返回，而最新的偏好（浅色）这时才轮到写。
    backend.releaseAll();
    await waitFor(() => expect(backend.writes).toBeGreaterThanOrEqual(2));
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "已保存到本机" })).not.toBeInTheDocument();

    await waitFor(async () => {
      backend.releaseAll();
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      expect(screen.getByRole("button", { name: "已保存到本机" })).toBeInTheDocument();
    });
    expect(backend.value).toMatchObject({ appearance: "light" });
  });

  /**
   * AC16「取消读取不误报」：在系统文件选择器里取消，不是失败。
   *
   * 取消返回 `null`（而不是抛错），既不弹恢复确认，也不能出现任何错误横幅 ——
   * 尤其不能报成「最终数据库提交已取消」这类并不存在的写入结果。
   */
  it("reports no error when the restore source picker is cancelled", async () => {
    const user = userEvent.setup();
    const native = createNativeApi();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "数据" }));
    await user.click(screen.getByRole("button", { name: "恢复" }));

    expect(native.chooseRestoreSource).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "确认恢复备份" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/已取消/)).not.toBeInTheDocument();
  });

  it("keeps restore confirmation keyboard-contained and returns focus on cancel", async () => {
    const user = userEvent.setup();
    const native = createNativeApi(structuredClone(EMPTY_WORKSPACE), {
      chooseRestoreSource: vi.fn().mockResolvedValue("C:\\Downloads\\daymark.db"),
      inspectBackup: vi.fn().mockResolvedValue({ source: "C:\\Downloads\\daymark.db", modifiedAt: new Date().toISOString(), sizeBytes: 1024, projects: 2, tasks: 12 }),
    });
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "数据" }));
    const trigger = screen.getByRole("button", { name: "恢复" });
    await user.click(trigger);
    expect(await screen.findByRole("dialog", { name: "确认恢复备份" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("ends only the running execution and saves its progress summary atomically", async () => {
    const today = isoDaysFromNow(0);
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-1", projectId: null, title: "完成第一章", progress: 20, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
      executionSessions: [{ id: "session-1", taskId: "task-1", localDate: today, endLocalDate: today, startLocal: "09:00", endLocal: "10:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
      executionRecords: [{ id: "record-1", sessionId: "session-1", taskId: "task-1", actualStartUtc: new Date(Date.now() - 60000).toISOString(), actualEndUtc: null, note: "" }],
    };
    const user = userEvent.setup(); const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "结束本次" }));
    expect(screen.getByRole("dialog", { name: /结束本次/ })).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: /本次小结/ }), "继续保持");
    await user.click(screen.getByRole("button", { name: "结束并保存" }));
    await waitFor(() => expect(native.finishExecution).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("previews and atomically applies a seven-day automatic schedule", async () => {
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE), tasks: [{ id: "task-1", projectId: null, title: "准备候选版", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sessionMinutes: 45, priority: "normal", sortOrder: 0, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task" }] };
    const user = userEvent.setup(); const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: /自动排程/ }));
    expect(screen.getByRole("dialog", { name: "自动排程" })).toHaveTextContent("准备候选版");
    await user.click(screen.getByRole("button", { name: "生成排程草案" }));
    await user.click(screen.getByRole("button", { name: /应用 \d+ 个时段/ }));
    await waitFor(() => expect(native.applyScheduleDraft).toHaveBeenCalledOnce());
  });

  it("applies a per-run daily cap from the schedule panel without writing settings", async () => {
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE), tasks: [{ id: "task-cap", projectId: null, title: "长篇写作", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sessionMinutes: 240, priority: "normal", sortOrder: 0, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task" }] };
    const user = userEvent.setup(); const native = createNativeApi(initial); const backend = new MemorySettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    await user.click(await screen.findByRole("button", { name: /自动排程/ }));
    // 不限上限：240 分钟任务在晚间 19:00–22:00 里单次最多拿 180 分钟（部分安排，只显示时长不带日期）。
    expect(await screen.findByText("180/240 分钟")).toBeInTheDocument();
    const cap = screen.getByRole("spinbutton", { name: "每日排程时长上限，留空为不限" });
    await user.clear(cap);
    await user.type(cap, "60{Enter}");
    expect(await screen.findByText("60/240 分钟")).toBeInTheDocument();
    // 本次上限只作用于草案，不写回设置。
    expect((backend.value as typeof DEFAULT_SETTINGS).dailyScheduleBudgetMinutes).toBeNull();
  });

  it("creates a lightweight time block from the blank-time bubble", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const native = createNativeApi(); render(<App settings={new SettingsRepository(backend)} native={native} />);
    await screen.findByRole("button", { name: "显示更多日历选项" });
    const track = document.querySelector<HTMLElement>('.calendar-day[data-day-date="2026-08-05"] .day-track')!;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 1440, width: 200, height: 1440, toJSON: () => ({}) });
    fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientX: 240, clientY: 600 });
    fireEvent.pointerUp(track, { button: 0, pointerId: 1, clientX: 240, clientY: 660 });
    const bubble = screen.getByRole("dialog", { name: "空白时段操作" });
    await user.click(within(bubble).getByRole("button", { name: "时间块" }));

    // 时间块表单与可用时间共用 TimeField；三种时间表单都不再出现原生时间输入。
    expect([...bubble.querySelectorAll("input")].some((input) => input.type === "time")).toBe(false);
    await user.type(within(bubble).getByRole("textbox", { name: "标题" }), "午休");
    expect(within(bubble).getByRole("button", { name: "开始时间 10:00" })).toBeVisible();
    expect(within(bubble).getByRole("button", { name: "结束时间 11:00" })).toBeVisible();
    await user.click(within(bubble).getByRole("button", { name: "1.5 小时" }));
    await user.click(within(bubble).getByRole("button", { name: "创建时间块" }));
    await waitFor(() => expect(native.createTimeBlock).toHaveBeenCalledWith(expect.objectContaining({ title: "午休", localDate: "2026-08-05", startLocal: "10:00", endLocal: "11:30" })));
    expect(screen.getByText("午休")).toBeVisible();
  });

  it("moves a time block's bottom edge to stretch it and commits an update", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, day: "2026-08-05" }, calendarScale: { day: 72, week: 84, month: 120 } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      timeBlocks: [{ id: "block-1", title: "通勤", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480 }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    await screen.findByText("通勤");
    const handle = screen.getByRole("button", { name: "调整 通勤 结束时间" });
    const down = createEvent.pointerDown(handle, { button: 0, clientY: 660 }); fireEvent(handle, down);
    const move = createEvent.pointerMove(window, { clientY: 780, clientX: 100 }); fireEvent(window, move);
    expect(screen.getByRole("status", { name: "时间块时间预览" })).toHaveTextContent("10:00–12:45");
    // 改时长时卡片边界本身就是最终边界，不该再叠一层落点虚线。
    expect(document.querySelector(".calendar-time-block-drop")).toBeNull();
    const up = createEvent.pointerUp(window, { clientY: 780, clientX: 100 }); fireEvent(window, up);
    await waitFor(() => expect(native.updateTimeBlock).toHaveBeenCalledWith(expect.objectContaining({ id: "block-1", startLocal: "10:00", endLocal: "12:45" })));
  });

  it("moves a time block's top edge to change its start while keeping the end fixed", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, day: "2026-08-05" }, calendarScale: { day: 72, week: 84, month: 120 } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      timeBlocks: [{ id: "block-2", title: "会议", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480 }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    await screen.findByText("会议");
    const handle = screen.getByRole("button", { name: "调整 会议 开始时间" });
    const down = createEvent.pointerDown(handle, { button: 0, clientY: 600 }); fireEvent(handle, down);
    const move = createEvent.pointerMove(window, { clientY: 480, clientX: 100 }); fireEvent(window, move);
    expect(screen.getByRole("status", { name: "时间块时间预览" })).toHaveTextContent("08:15–11:00");
    const up = createEvent.pointerUp(window, { clientY: 480, clientX: 100 }); fireEvent(window, up);
    await waitFor(() => expect(native.updateTimeBlock).toHaveBeenCalledWith(expect.objectContaining({ id: "block-2", startLocal: "08:15", endLocal: "11:00" })));
  });

  it("creates a daily habit and schedules today's independent occurrence", async () => {
    const user = userEvent.setup(); const native = createNativeApi();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: /新建重复习惯/ }));
    await screen.findByRole("dialog", { name: "新建重复习惯" });
    // 点空白即取消并丢弃草稿，不写库。
    await user.click(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建重复习惯" })).toBeNull());
    expect(native.createRecurringHabit).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: /新建重复习惯/ }));
    const habitDialog = await screen.findByRole("dialog", { name: "新建重复习惯" });
    await user.type(within(habitDialog).getByRole("textbox", { name: "习惯名称" }), "拉伸");
    await user.click(screen.getByRole("button", { name: "创建习惯" }));
    await waitFor(() => expect(native.createRecurringHabit).toHaveBeenCalledOnce());
    await user.click(await screen.findByRole("button", { name: "安排今天" }));
    await waitFor(() => expect(native.scheduleHabitOccurrence).toHaveBeenCalledOnce());
  });

  it("keeps 单次投入 untouched when the habit form's unit or label text is clicked", async () => {
    const user = userEvent.setup();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi(structuredClone(EMPTY_WORKSPACE))} />);
    await user.click(await screen.findByRole("button", { name: /新建重复习惯/ }));
    const dialog = await screen.findByRole("dialog", { name: "新建重复习惯" });
    const minutes = within(dialog).getByRole("spinbutton", { name: "单次投入" });
    expect(minutes).toHaveValue(30);
    // 「分钟」后缀和左侧标签都在这一行的外框里：点它们只该落到输入框上，
    // 不能被 <label> 的点击激活转给**第一个**可关联元素（也就是减号）。
    await user.click(within(dialog).getByText("分钟"));
    expect(minutes).toHaveValue(30);
    expect(minutes).toHaveFocus();
    await user.click(within(dialog).getByText("单次投入"));
    expect(minutes).toHaveValue(30);
  });

  it("passes 固定开始 through the shared time wheel and can clear it", async () => {
    const user = userEvent.setup();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi(structuredClone(EMPTY_WORKSPACE))} />);
    await user.click(await screen.findByRole("button", { name: /新建重复习惯/ }));
    const dialog = await screen.findByRole("dialog", { name: "新建重复习惯" });
    // 和「可用时间」「设置」用同一个 `TimeField`：不再有原生时间输入。
    expect([...dialog.querySelectorAll("input")].some((input) => input.type === "time")).toBe(false);
    const field = within(dialog).getByRole("button", { name: "固定开始时间 未设置" });
    await user.click(field);
    const picker = await screen.findByRole("dialog", { name: "选择固定开始时间" });
    await user.click(within(within(picker).getByRole("listbox", { name: "小时" })).getByRole("option", { name: "21" }));
    expect(within(dialog).getByRole("button", { name: "固定开始时间 21:00" })).toBeVisible();
    // 可选字段必须留得掉：滚轮打开的浮层底部有「清除」，清完回到「未设置」。
    await user.click(within(picker).getByRole("button", { name: "清除" }));
    expect(within(dialog).getByRole("button", { name: "固定开始时间 未设置" })).toBeVisible();
  });

  it("imports Bilibili public parts only after an editable Beta preview", async () => {
    const user = userEvent.setup();
    const native = createNativeApi(structuredClone(EMPTY_WORKSPACE), { fetchBilibiliVideo: vi.fn().mockResolvedValue({ bvid: "BV1xx411c7mD", title: "公开课程", ownerName: "UP 主", parts: [{ page: 1, title: "第一讲", durationSeconds: 600, sourceKey: "BV1xx411c7mD:1", sourceUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1" }] }) });
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "项目" }));
    await openImportMenu(user);
  await user.click(screen.getByRole("button", { name: "B 站链接 Beta" }));
    await user.type(screen.getByRole("textbox", { name: "B 站普通视频链接" }), "https://www.bilibili.com/video/BV1xx411c7mD");
    await user.click(screen.getByRole("button", { name: "读取公开元数据" }));
    await screen.findByRole("region", { name: "B 站分 P 预览" });
    const partTitle = screen.getByRole("textbox", { name: "编辑第 1 个分 P" });
    expect(partTitle).toHaveValue("第一讲");
    await user.clear(partTitle);
    await user.type(partTitle, "起步");
    await user.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(native.createProjectWithTasks).toHaveBeenCalledWith(expect.objectContaining({ title: "公开课程" }), [expect.objectContaining({ title: "起步", sourceUrl: expect.stringContaining("?p=1"), mediaMinutes: 10 })]));
  });

  it("shows a neutral one-time rescue card after the grace period", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date("2026-08-02T12:00:00"));
    const { backend, native } = rescueScenario(); const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    expect(await screen.findByRole("heading", { name: "恢复行动", level: 2 })).toBeVisible();
    expect(await screen.findByRole("button", { name: "现在开始" })).toBeVisible();
    expect(screen.getByRole("button", { name: "延后 10 分钟" })).toBeVisible();
    expect(screen.getByRole("button", { name: "重新选择时间" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "本次跳过" }));
    await waitFor(() => expect(native.updateExecutionSession).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" })));
    vi.useRealTimers();
  });

  it("can start a recovery even when the original session has already ended", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date("2026-08-02T14:00:00"));
    const { backend, native } = rescueScenario(); const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    await user.click(await screen.findByRole("button", { name: "现在开始" }));
    await waitFor(() => expect(native.startExecution).toHaveBeenCalledOnce());
    vi.useRealTimers();
  });

  it("does not infer a missed fact when start check-in is disabled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date("2026-08-02T14:00:00"));
    const { native } = rescueScenario();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await screen.findByRole("heading", { name: /8月2日/, level: 1 });
    expect(native.updateExecutionSession).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("reschedules a recovery ten minutes from now", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date("2026-08-02T12:00:00"));
    const { backend, native } = rescueScenario(); const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    await user.click(await screen.findByRole("button", { name: "延后 10 分钟" }));
    await waitFor(() => expect(native.updateExecutionSession).toHaveBeenCalledWith(expect.objectContaining({ startLocal: "12:10", status: "scheduled" })));
    vi.useRealTimers();
  });

  it("opens the calendar when recovery needs another time", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date("2026-08-02T14:00:00"));
    const { backend, native } = rescueScenario(); const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    await user.click(await screen.findByRole("button", { name: "重新选择时间" }));
    expect(await screen.findByRole("region", { name: "日历时间网格" })).toBeVisible();
    await waitFor(() => expect(document.querySelector(".calendar-session.pending-review")).toHaveTextContent("恢复行动待回顾"));
    // B1 起卡片移动改 pointer 自绘，不再挂原生 `draggable`；卡片仍可点开待回顾。
    expect(document.querySelector(".calendar-session.pending-review")).toHaveAttribute("data-session-id");
    expect(native.updateExecutionSession).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("collects overdue and upcoming-deadline tasks into a collapsible attention section", async () => {
    const today = isoDaysFromNow(0);
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [
        { id: "task-1", projectId: null, title: "临期任务", progress: 0, status: "active", deadlineLocal: today, estimatedMinutes: 30, sortOrder: 0 },
        { id: "task-2", projectId: null, title: "普通任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 30, sortOrder: 1 },
      ],
    };
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi(initial)} />);
    expect(await screen.findByText("需要关注")).toBeVisible();
    expect(screen.getByText("临期任务", { selector: ".attention-pool strong" })).toBeVisible();
    expect(screen.getAllByText("临期任务", { selector: ".attention-pool strong" })).toHaveLength(1);
    expect(screen.queryByText("临期任务", { selector: ".task-list:not(.attention-list) strong" })).not.toBeInTheDocument();
    expect(screen.getByText("普通任务", { selector: ".task-list strong" })).toBeVisible();
  });
  it("persists the reduced-motion preference while the availability dialog is closed", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("radio", { name: "减少" }));
    await waitFor(() => expect(backend.value).toMatchObject({ motion: "reduce" }));
    // 可用时间改成二级弹窗后，设置行只剩入口；弹窗里的改动不经过这条立即写入。
    expect(screen.getByRole("button", { name: "编辑" })).toBeVisible();
  });

  /**
   * 「可用时间」A3 设计器（2026-11-08）。
   *
   * jsdom 没有真实高度：每一条轨道在用例里显式 stub `getBoundingClientRect`，按
   * 「1px = 1 分钟、top = 0」把 clientY 换算成分钟（设计师的 `minuteIn` 正是这个比例）；
   * 折叠带的时间换算走的是 `60 / 每小时像素`，用每个用例自己的 deltaY 表达。
   */
  async function openAvailability(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.click(screen.getByRole("button", { name: "编辑" }));
    return await screen.findByRole("dialog", { name: /可用时间/ });
  }

  /** 给「展开段」的轨道桩一个高度：top = 0，1px 对应 1 分钟（段起点见各用例注释）。 */
  function stubTrack(segStart: number) {
    const tracks = screen.getAllByRole("group", { name: /可用时间$/ });
    for (const track of tracks) {
      Object.defineProperty(track, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ top: 0, bottom: 1020, left: 0, right: 100, width: 100, height: 1020, x: 0, y: 0, toJSON: () => ({}) }),
      });
    }
    return { yOf: (minute: number) => minute - segStart, tracks };
  }

  function pointerMove(clientY: number) {
    window.dispatchEvent(new PointerEvent("pointermove", { clientY, bubbles: true }));
  }
  function pointerUp(clientY: number) {
    window.dispatchEvent(new PointerEvent("pointerup", { clientY, bubbles: true }));
  }
  const slotsOf = (backend: MemorySettingsBackend) => (backend.value as { defaultTimeSlots: Array<{ start: string; end: string; weekdays: number[] }> }).defaultTimeSlots;
  const foldsOf = (backend: MemorySettingsBackend) => (backend.value as { foldedRanges: Array<{ start: string; end: string }> }).foldedRanges;

  it("adds a one-hour block from the hover chip and only writes it on 完成", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await openAvailability(user);
    // 默认折叠是 00:00–06:00 与 23:00–24:00，唯一展开段是 06:00–23:00。
    const { yOf, tracks } = stubTrack(360);
    // 周一那一列：`.availability-track` 上是 `data-day="1"`（0 = 周日）。
    const monday = document.querySelector<HTMLElement>('.availability-track[data-day="1"]')!;
    expect(monday).toBeTruthy();
    fireEvent.pointerMove(monday, { clientY: yOf(15 * 60) });
    const chip = await screen.findByRole("button", { name: "在周一 15:00 添加 1 小时空闲" });
    await user.click(chip);
    expect(screen.getByRole("group", { name: "周一 15:00–16:00 空闲" })).toBeVisible();
    // 改动只在草稿里：还没点「完成」，库里的 defaultTimeSlots 仍是那一条默认窗口。
    expect(slotsOf(backend)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(slotsOf(backend)).toHaveLength(2));
    expect(slotsOf(backend)).toContainEqual(expect.objectContaining({ start: "15:00", end: "16:00", weekdays: [1] }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /可用时间/ })).toBeNull());
  });

  it("blocks text selection while dragging and leaves no selection behind", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await openAvailability(user);
    const { yOf } = stubTrack(360);
    const mondayBlock = document.querySelector<HTMLElement>('.availability-track[data-day="1"] .availability-slot')!;
    const handle = within(mondayBlock).getByRole("button", { name: "调整 22:00 结束时间" });
    fireEvent.pointerDown(handle, { button: 0, clientY: yOf(22 * 60) });
    pointerMove(yOf(23 * 60));
    // 拖动中：整页进入禁选态（块内时间是真文字，指针扫过会被框成蓝底选区）。
    expect(document.body.dataset.availabilityDragging).toBe("true");
    await waitFor(() => expect(screen.getByRole("group", { name: "周一 19:00–23:00 空闲" })).toBeVisible());
    // 松手后禁选态撤掉，且没有留下任何选区（这才是「拖完不知道怎么办」的那个蓝底）。
    pointerUp(yOf(23 * 60));
    await waitFor(() => expect(document.body.dataset.availabilityDragging).toBeUndefined());
    expect(window.getSelection()?.rangeCount ?? 0).toBe(0);
    await user.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(slotsOf(backend)).toContainEqual(expect.objectContaining({ start: "19:00", end: "23:00", weekdays: [1] })));
  });

  it("previews the new end live while dragging a block edge", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await openAvailability(user);
    const { yOf } = stubTrack(360);
    const mondayBlock = document.querySelector<HTMLElement>('.availability-track[data-day="1"] .availability-slot')!;
    const handle = within(mondayBlock).getByRole("button", { name: "调整 22:00 结束时间" });
    fireEvent.pointerDown(handle, { button: 0, clientY: yOf(22 * 60) });
    // 拖动中（还没松手）：块自己就已经画到 23:00 —— 不能只有指针旁的读数在动。
    pointerMove(yOf(23 * 60));
    await waitFor(() => expect(screen.getByRole("group", { name: "周一 19:00–23:00 空闲" })).toBeVisible());
    expect(screen.getByRole("group", { name: "周一 19:00–23:00 空闲" })).toHaveClass("is-dragging");
    // 其余六天不受影响，也不带 is-dragging。
    expect(screen.getByRole("group", { name: "周二 19:00–22:00 空闲" })).not.toHaveClass("is-dragging");
    // 松手后才落库，且预览与落库值一致；此时「拖动中」样式已经撤掉。
    pointerUp(yOf(23 * 60));
    await waitFor(() => expect(screen.getByRole("group", { name: "周一 19:00–23:00 空闲" })).not.toHaveClass("is-dragging"));
    await user.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(slotsOf(backend)).toContainEqual(expect.objectContaining({ start: "19:00", end: "23:00", weekdays: [1] })));
  });

  it("previews the new range live while dragging a folded band edge", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await openAvailability(user);
    stubTrack(360);
    const band = screen.getByRole("group", { name: "已折叠 00:00–06:00，共 6 小时" });
    const edge = band.querySelector("[data-edge=\"end\"]")!;
    fireEvent.pointerDown(edge, { button: 0, clientY: 0 });
    pointerMove(90);
    // 拖动中：灰带的文案与可访问名已经是新范围（整条轴实时重排）。
    await waitFor(() => expect(screen.getByRole("group", { name: "已折叠 00:00–08:00，共 8 小时" })).toBeVisible());
    expect(screen.getByRole("group", { name: "已折叠 00:00–08:00，共 8 小时" })).toHaveClass("is-dragging");
    pointerUp(90);
    await user.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(foldsOf(backend)).toContainEqual({ start: "00:00", end: "08:00" }));
  });

  it("drags the block bottom edge to change the end time", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await openAvailability(user);
    const { yOf } = stubTrack(360);
    // 默认窗口 19:00–22:00 落在周一到周日（七块同形）：拖**周一**那一块的下沿 22:00 → 23:00。
    const mondayBlock = document.querySelector<HTMLElement>('.availability-track[data-day="1"] .availability-slot')!;
    const handle = within(mondayBlock).getByRole("button", { name: "调整 22:00 结束时间" });
    fireEvent.pointerDown(handle, { button: 0, clientY: yOf(22 * 60) });
    pointerMove(yOf(23 * 60));
    pointerUp(yOf(23 * 60));
    await waitFor(() => expect(screen.getByRole("group", { name: "周一 19:00–23:00 空闲" })).toBeVisible());
    await user.click(screen.getByRole("button", { name: "完成" }));
    // 拖动只作用于周一那一天：它从共享窗口里拆出来，其余六天保持 19:00–22:00。
    await waitFor(() => expect(slotsOf(backend)).toContainEqual(expect.objectContaining({ start: "19:00", end: "23:00", weekdays: [1] })));
    expect(slotsOf(backend)).toContainEqual(expect.objectContaining({ start: "19:00", end: "22:00", weekdays: [0, 2, 3, 4, 5, 6] }));
  });

  it("folds one hour from the gutter 折叠 button and stores it with 完成", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await openAvailability(user);
    stubTrack(360);
    await user.click(screen.getByRole("button", { name: "在 10:00 折叠 1 小时（10:00–11:00）" }));
    expect(screen.getByRole("group", { name: "已折叠 10:00–11:00，共 1 小时" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(foldsOf(backend)).toContainEqual({ start: "10:00", end: "11:00" }));
    // 与默认两段一起存：三条都在。
    expect(foldsOf(backend)).toHaveLength(3);
  });

  it("drags the folded band bottom edge to change its range", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await openAvailability(user);
    stubTrack(360);
    const band = screen.getByRole("group", { name: "已折叠 00:00–06:00，共 6 小时" });
    const edge = band.querySelector("[data-edge=\"end\"]")!;
    fireEvent.pointerDown(edge, { button: 0, clientY: 0 });
    // 每小时 ≈46.4px，90px ≈116 分钟 → 吸附到 120 分钟：00:00–06:00 拉到 00:00–08:00。
    pointerMove(90);
    pointerUp(90);
    await waitFor(() => expect(screen.getByRole("group", { name: "已折叠 00:00–08:00，共 8 小时" })).toBeVisible());
    await user.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(foldsOf(backend)).toContainEqual({ start: "00:00", end: "08:00" }));
  });

  it("unfolds one band with × and keeps the other", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await openAvailability(user);
    stubTrack(360);
    await user.click(screen.getByRole("button", { name: "展开 00:00–06:00（取消折叠）" }));
    expect(screen.queryByRole("group", { name: /已折叠 00:00–06:00/ })).toBeNull();
    expect(screen.getByRole("group", { name: "已折叠 23:00–24:00，共 1 小时" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(foldsOf(backend)).toEqual([{ start: "23:00", end: "24:00" }]));
  });

  it("keeps the hidden head and tail of a block that crosses a folded band", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    // 周一 05:00–09:00 的空闲，00:00–06:00 被折成灰带：看得见的只有 06:00–09:00。
    backend.value = { ...DEFAULT_SETTINGS, defaultTimeSlots: [{ id: "morning", label: "晨间", start: "05:00", end: "09:00", weekdays: [1] }] };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await openAvailability(user);
    // 展开段是 06:00–23:00：把可见片（06:00–09:00）的下沿从 09:00 拖到 08:00。
    stubTrack(360);
    const handle = screen.getByRole("button", { name: "调整 09:00 结束时间" });
    const visible = screen.getByRole("group", { name: "周一 05:00–09:00 空闲" });
    expect(visible).toHaveAttribute("aria-label", "周一 05:00–09:00 空闲");
    fireEvent.pointerDown(handle, { button: 0, clientY: 9 * 60 - 360 });
    pointerMove(8 * 60 - 360);
    pointerUp(8 * 60 - 360);
    await user.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(slotsOf(backend)).toHaveLength(1));
    // 藏在灰带里的 05:00–06:00 一分钟都没丢：它与落回来的可见片首尾相接，合并成 05:00–08:00。
    // （只改看得见的那一片 = 把 06:00–09:00 换成 06:00–08:00；隐藏的头部原样写回。）
    expect(slotsOf(backend)).toEqual([expect.objectContaining({ start: "05:00", end: "08:00", weekdays: [1] })]);
  });

  it("shows the all-folded empty state with a 恢复默认折叠 action", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, foldedRanges: [{ start: "00:00", end: "24:00" }] };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await openAvailability(user);
    expect(screen.getByText(/全部时间都已折叠/)).toBeVisible();
    // 全部折叠时没有展开段（也就没有可聚焦的日轨道），空态给的是「恢复默认折叠」。
    expect(screen.queryAllByRole("group", { name: /^周. 可用时间$/ })).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "恢复默认折叠" }));
    await waitFor(() => expect(screen.queryByText(/全部时间都已折叠/)).toBeNull());
    expect(screen.getAllByRole("group", { name: /^周. 可用时间$/ }).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(foldsOf(backend)).toEqual([{ start: "00:00", end: "06:00" }, { start: "23:00", end: "24:00" }]));
  });

  it("writes both fields on 完成 and never on 取消 or Esc", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await openAvailability(user);
    stubTrack(360);
    await user.click(screen.getByRole("button", { name: "在 10:00 折叠 1 小时（10:00–11:00）" }));
    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /可用时间/ })).toBeNull());
    // 取消：库里一个字都没变（没有多出 10:00–11:00 的折叠，也没有灰带）。
    expect(foldsOf(backend)).toEqual(DEFAULT_SETTINGS.foldedRanges);
    expect(slotsOf(backend)).toEqual(DEFAULT_SETTINGS.defaultTimeSlots);

    await openAvailability(user);
    stubTrack(360);
    await user.click(screen.getByRole("button", { name: "在 11:00 折叠 1 小时（11:00–12:00）" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /可用时间/ })).toBeNull());
    expect(foldsOf(backend)).toEqual(DEFAULT_SETTINGS.foldedRanges);
  });

  it("keeps the draft and the dialog open when the write fails, and retries", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await openAvailability(user);
    stubTrack(360);
    await user.click(screen.getByRole("button", { name: "在 10:00 折叠 1 小时（10:00–11:00）" }));
    backend.failNextWrite = true;
    await user.click(screen.getByRole("button", { name: "完成" }));
    const dialog = screen.getByRole("dialog", { name: /可用时间/ });
    // 侧栏也有一个「未保存」横幅（同样的 role="alert"），所以只认弹窗里那一条。
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("保存失败");
    // 弹窗没关、草稿还在、状态不写「已保存」。
    expect(dialog).toBeVisible();
    expect(screen.getByRole("group", { name: "已折叠 10:00–11:00，共 1 小时" })).toBeVisible();
    expect(screen.queryByText("已保存")).toBeNull();
    // 重试成功后才真正落库并关窗。
    await user.click(within(dialog).getByRole("button", { name: "重试保存" }));
    await waitFor(() => expect(foldsOf(backend)).toContainEqual({ start: "10:00", end: "11:00" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /可用时间/ })).toBeNull());
  });

  it("opens the help bubble on hover and closes it on an outside click", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await openAvailability(user);
    expect(screen.queryByRole("dialog", { name: "操作说明" })).toBeNull();
    fireEvent.pointerEnter(screen.getByRole("button", { name: "操作说明" }).parentElement!);
    const hint = await screen.findByRole("dialog", { name: "操作说明" });
    // 两组各四条，文案照设计稿。
    expect(within(hint).getByText("悬停空白处点「＋」加 1 小时")).toBeVisible();
    expect(within(hint).getByText("拖灰带中部整段平移")).toBeVisible();
    expect(within(hint).getAllByRole("listitem")).toHaveLength(8);
    // 点外面收起（弹窗本身还在）。
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "操作说明" })).toBeNull());
    expect(screen.getByRole("dialog", { name: /可用时间/ })).toBeVisible();
  });

  it("puts 精确添加 and 清空 in the header as icons and drops the ⋯ menu", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await openAvailability(user);
    // 2026-11-08：⋯ 菜单撤掉，两件事各自成为右上角一颗图标按钮。
    expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(screen.queryByText("恢复默认数据")).toBeNull();
    const add = screen.getByRole("button", { name: "精确添加空闲时间" });
    const clear = screen.getByRole("button", { name: "清空本周空闲时间" });
    expect(add).toBeVisible();
    expect(clear).toBeVisible();
    // 添加：直接开面板（不再先进菜单）。
    await user.click(add);
    const panel = screen.getByRole("dialog", { name: "精确添加" });
    expect(panel).toBeVisible();
    expect(add).toHaveAttribute("aria-expanded", "true");
    await user.click(within(panel).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "精确添加" })).toBeNull());
    // 清空：仍然二次确认；确认后草稿清空、按钮失焦不可用，可用「撤销上一步」找回。
    await user.click(clear);
    const confirm = screen.getByRole("dialog", { name: "清空本周空闲时间？" });
    await user.click(within(confirm).getByRole("button", { name: "清空" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: /空闲$/ })).toBeNull());
    expect(screen.getByRole("button", { name: "清空本周空闲时间" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "撤销上一步" }));
    expect(screen.getByRole("group", { name: "周一 19:00–22:00 空闲" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "取消" }));
  });

  it("has no editing bubble on a block and resizes it with the keyboard instead", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await openAvailability(user);
    stubTrack(360);
    const monday = screen.getByRole("group", { name: "周一 19:00–22:00 空闲" });
    // 2026-11-08：块上的铅笔与「编辑可用时间」气泡一起撤掉 —— 起止在画布上直接改，
    // 再没有第二个录入同一份开始／结束时间的表单。
    expect(within(monday).queryByRole("button", { name: /^编辑 周/ })).toBeNull();
    await user.click(monday);
    expect(screen.queryByRole("dialog", { name: "编辑可用时间" })).toBeNull();
    expect(screen.queryByLabelText("开始时间")).toBeNull();
    // 键盘路径：Shift+↓ 把结束推后一个吸附步长（默认 15 分钟），Alt+↓ 把开始也推后。
    monday.focus();
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    await waitFor(() => expect(screen.getByRole("group", { name: "周一 19:00–22:15 空闲" })).toBeVisible());
    screen.getByRole("group", { name: "周一 19:00–22:15 空闲" }).focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() => expect(screen.getByRole("group", { name: "周一 19:15–22:15 空闲" })).toBeVisible());
    await user.click(screen.getByRole("button", { name: "完成" }));
    // 只改周一那一天：它从共享窗口里拆出来，其余六天保持 19:00–22:00，标签原样跟随。
    await waitFor(() => expect(slotsOf(backend)).toContainEqual(expect.objectContaining({ start: "19:15", end: "22:15", weekdays: [1], label: "晚间专注" })));
    expect(slotsOf(backend)).toContainEqual(expect.objectContaining({ start: "19:00", end: "22:00", weekdays: [0, 2, 3, 4, 5, 6] }));
  });

  it("never renders the window name inside a block", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    // 夹具的默认窗口名是自定义的「晚间专注」：从块上消失的正是它。
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await openAvailability(user);
    stubTrack(360);
    expect(screen.queryByText("晚间专注")).toBeNull();
    // 块里只有时间文本（周一到周日七块同形）。
    const monday = screen.getByRole("group", { name: "周一 19:00–22:00 空闲" });
    expect(monday).toHaveTextContent("19:00–22:00");
    expect(monday.textContent).toBe("19:00–22:00");
  });


  it("keeps dependent reminder settings disabled until their parent switch is on", async () => {
    const user = userEvent.setup();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi()} />);
    await user.click(await screen.findByRole("button", { name: "设置" }));

    expect(screen.getByLabelText("开始宽限期")).toBeDisabled();
    expect(screen.getByLabelText("提前分钟数")).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: /记录开始／结束本次/ }));
    expect(screen.getByLabelText("开始宽限期")).toBeEnabled();
    expect(screen.getByLabelText("提前分钟数")).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: /^执行提醒/ }));
    expect(screen.getByLabelText("提前分钟数")).toBeEnabled();
  });

  /**
   * 开机自启动是**系统级开关**：写系统状态（Windows 注册表）而不是 AppSettings，
   * 读取期间不可操作；写入失败时开关留在原状态并给出提示。
   */
  it("toggles launch at startup through the native bridge and reports write failures", async () => {
    const user = userEvent.setup();
    const native = createNativeApi();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "设置" }));

    const toggle = await screen.findByRole("checkbox", { name: "开机自启动" });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).not.toBeChecked();

    await user.click(toggle);
    expect(vi.mocked(native.setAutostartEnabled)).toHaveBeenLastCalledWith(true);
    await waitFor(() => expect(toggle).toBeChecked());

    await user.click(toggle);
    expect(vi.mocked(native.setAutostartEnabled)).toHaveBeenLastCalledWith(false);
    await waitFor(() => expect(toggle).not.toBeChecked());
  });

  it("keeps the startup switch off and shows a message when the system write fails", async () => {
    const user = userEvent.setup();
    const native = createNativeApi(structuredClone(EMPTY_WORKSPACE), {
      setAutostartEnabled: vi.fn().mockRejectedValue(new Error("拒绝访问")),
    });
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "设置" }));

    const toggle = await screen.findByRole("checkbox", { name: "开机自启动" });
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);

    expect(await screen.findByRole("alert")).toHaveTextContent("开启开机自启动失败");
    expect(toggle).not.toBeChecked();
  });

  /**
   * 开始宽限期与最低有效时长从固定档位下拉框改成分钟输入框：保留常用值快捷按钮，
   * 但允许直接键入任意区间内的整数分钟。输入在失焦时提交，和既有的分钟输入控件一致。
   */
  it("edits the start grace period and minimum effective duration as minute inputs", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await user.click(await screen.findByRole("button", { name: "设置" }));

    await user.click(screen.getByRole("checkbox", { name: /记录开始／结束本次/ }));
    const grace = screen.getByLabelText("开始宽限期");
    expect(grace).toHaveAttribute("type", "number");
    expect(grace).toHaveAttribute("min", "1");
    expect(grace).toHaveAttribute("max", "60");
    await user.clear(grace); await user.type(grace, "12"); await user.tab();
    await waitFor(() => expect(backend.value).toMatchObject({ checkInGraceMinutes: 12 }));

    const minimum = screen.getByLabelText("最低有效时长");
    expect(minimum).toHaveAttribute("type", "number");
    expect(minimum).toHaveAttribute("min", "5");
    expect(minimum).toHaveAttribute("max", "240");
    await user.clear(minimum); await user.type(minimum, "25"); await user.tab();
    await waitFor(() => expect(backend.value).toMatchObject({ minimumSessionMinutes: 25 }));

    // 常用值仍然一键可选，不用重新输入。
    const minimumField = minimum.closest(".number-field-wrap") as HTMLElement;
    await user.click(within(minimumField).getByRole("button", { name: "设为 15 分钟" }));
    await waitFor(() => expect(backend.value).toMatchObject({ minimumSessionMinutes: 15 }));
  });

  /** 日视图默认显示改成显式按钮（与日历工具栏的日视图切换同构），不再是下拉框。 */
  it("switches the default day view with explicit buttons instead of a select", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await user.click(await screen.findByRole("button", { name: "设置" }));

    expect(screen.queryByRole("combobox", { name: "日视图默认显示" })).not.toBeInTheDocument();
    const group = screen.getByRole("radiogroup", { name: "日视图默认显示" });
    expect(within(group).getByRole("radio", { name: "全天" })).toBeChecked();

    await user.click(within(group).getByRole("radio", { name: "可用时间" }));
    expect(within(group).getByRole("radio", { name: "可用时间" })).toBeChecked();
    await waitFor(() => expect(backend.value).toMatchObject({ calendarDayMode: "defaultSlots" }));

    await user.click(within(group).getByRole("radio", { name: "全天" }));
    await waitFor(() => expect(backend.value).toMatchObject({ calendarDayMode: "fullDay" }));
  });

  /**
   * 单项重置：只在偏离默认值的那一行出现，点它只还原这一项。
   * 位置固定在控件框外的槽位里，所以「没偏离」的行里不该有可点的重置按钮。
   */
  it("offers a per-row reset only after that row leaves its default", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await user.click(await screen.findByRole("button", { name: "设置" }));

    expect(screen.queryByRole("button", { name: "将「主题」恢复默认" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "将「动态效果」恢复默认" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "深色" }));
    expect(await screen.findByRole("button", { name: "将「主题」恢复默认" })).toBeInTheDocument();
    // 只出现在被改过的那一行。
    expect(screen.queryByRole("button", { name: "将「动态效果」恢复默认" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "将「主题」恢复默认" }));
    const theme = screen.getByRole("radiogroup", { name: "主题" });
    expect(within(theme).getByRole("radio", { name: "跟随系统" })).toBeChecked();
    await waitFor(() => expect(backend.value).toMatchObject({ appearance: "system" }));
    expect(screen.queryByRole("button", { name: "将「主题」恢复默认" })).not.toBeInTheDocument();
  });

  it("turns off calendar snapping", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await user.click(await screen.findByRole("button", { name: "日历" }));
    await user.click(screen.getByRole("button", { name: "显示更多日历选项" }));
    await user.click(screen.getByRole("button", { name: "吸附 15 分钟" }));
    expect(screen.getByRole("button", { name: "吸附已关闭" })).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(backend.value).toMatchObject({ snapMinutes: "off" }));
  });

  it("keeps the calendar status bar compact and restores focus from the display bubble", async () => {
    const user = userEvent.setup();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi()} />);
    await user.click(await screen.findByRole("button", { name: "日历" }));
    expect(screen.getByRole("checkbox", { name: "显示实际记录" })).toBeVisible();
    const trigger = screen.getByRole("button", { name: "显示更多日历选项" });
    await user.click(trigger);
    const panel = await screen.findByRole("dialog", { name: "日历显示选项" });
    // D15：时间块入口已删除，气泡只剩吸附开关与 Alt 提示。
    expect(within(panel).queryByRole("button", { name: "时间块" })).not.toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "吸附 15 分钟" })).toHaveAttribute("aria-pressed", "true");
    expect(panel).toHaveTextContent("拖拽时按 Alt 临时反转吸附");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(panel).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());

    // 月视图没有可显示内容：触发按钮不渲染（D15）。
    await user.click(screen.getByRole("button", { name: "月" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "显示更多日历选项" })).not.toBeInTheDocument());
  });

  it("shows a persistent automatic backup error on the data page", async () => {
    const user = userEvent.setup();
    const native = createNativeApi(structuredClone(EMPTY_WORKSPACE), {
      getDataOverview: vi.fn(async () => ({
        schemaVersion: 5, databasePath: "C:\\Daymark\\daymark.db", backupDirectory: "C:\\Daymark\\backups",
        backupError: "磁盘写入失败", counts: { projects: 0, tasks: 0, executionSessions: 0, executionRecords: 0, progressEvents: 0, timeBlocks: 0 }, backups: [],
      })),
    });
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "数据" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/自动备份未完成：磁盘写入失败/);
  });

  it("edits a session time precisely without snapping", async () => {
    const today = isoDaysFromNow(0);
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-1", projectId: null, title: "深度工作", progress: 40, status: "active", deadlineLocal: null, estimatedMinutes: 90, sortOrder: 0 }],
      executionSessions: [{ id: "session-1", taskId: "task-1", localDate: today, endLocalDate: today, startLocal: "09:00", endLocal: "10:30", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
    };
    const native = createNativeApi(initial); const user = userEvent.setup();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "日历" }));
    await user.click(await screen.findByRole("button", { name: "编辑 深度工作 时间" }));
    await chooseTime(user, "开始时间", "13", "05");
    await chooseTime(user, "结束时间", "14", "20");
    await user.click(screen.getByRole("button", { name: "保存时间" }));
    await waitFor(() => expect(native.updateExecutionSession).toHaveBeenCalledWith(expect.objectContaining({ startLocal: "13:05", endLocal: "14:20", localDate: today, endLocalDate: today })));
  });

  it("allows a session to end after midnight when edited precisely", async () => {
    const today = isoDaysFromNow(0);
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-1", projectId: null, title: "夜猫任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 120, sortOrder: 0 }],
      executionSessions: [{ id: "session-1", taskId: "task-1", localDate: today, endLocalDate: today, startLocal: "22:00", endLocal: "00:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
    };
    const native = createNativeApi(initial); const user = userEvent.setup();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "日历" }));
    await user.click(await screen.findByRole("button", { name: "编辑 夜猫任务 时间" }));
    await chooseTime(user, "开始时间", "23", "00");
    await chooseTime(user, "结束时间", "01", "00");
    await user.click(screen.getByRole("button", { name: "保存时间" }));
    await waitFor(() => expect(native.updateExecutionSession).toHaveBeenCalledWith(expect.objectContaining({ startLocal: "23:00", endLocal: "01:00", localDate: today, endLocalDate: expect.not.stringMatching(today) })));
  });

  it("keeps the Bilibili link and lets the user retry after a fetch failure", async () => {
    const user = userEvent.setup();
    const fetchBilibiliVideo = vi.fn()
      .mockRejectedValueOnce(new Error("网络不可用"))
      .mockResolvedValueOnce({ bvid: "BV1xx411c7mD", title: "公开课程", ownerName: "UP 主", parts: [{ page: 1, title: "第一讲", durationSeconds: 600, sourceKey: "BV1xx411c7mD:1", sourceUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1" }] });
    const native = createNativeApi(structuredClone(EMPTY_WORKSPACE), { fetchBilibiliVideo });
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "项目" }));
    await openImportMenu(user);
  await user.click(screen.getByRole("button", { name: "B 站链接 Beta" }));
    const link = screen.getByRole("textbox", { name: "B 站普通视频链接" });
    await user.type(link, "https://www.bilibili.com/video/BV1xx411c7mD");
    await user.click(screen.getByRole("button", { name: "读取公开元数据" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/网络不可用/);
    expect(link).toHaveValue("https://www.bilibili.com/video/BV1xx411c7mD");
    await user.click(screen.getByRole("button", { name: "读取公开元数据" }));
    await screen.findByRole("region", { name: "B 站分 P 预览" });
    expect(fetchBilibiliVideo).toHaveBeenCalledTimes(2);
  });

  function isoDaysFromNow(days: number) {
    const date = new Date(); date.setDate(date.getDate() + days);
    const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 10);
  }

  it("shows the project deadline chip with urgency and persists project edits", async () => {
    const user = userEvent.setup();
    const yesterday = isoDaysFromNow(-1);
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "Alpha", deadlineLocal: yesterday }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "项目" }));
    expect(await screen.findByText(/已逾期 1 天/)).toBeVisible();
    await openProject(user, "Alpha");
    await user.click(screen.getByRole("button", { name: "编辑项目 Alpha" }));
    const editor = screen.getByRole("dialog", { name: "编辑项目 Alpha" });
    // 项目截止日期与回顾页任务截止日期共用自绘月历，不再出现原生 input[type=date]。
    expect(editor.querySelector('input[type="date"]')).toBeNull();
    const titleInput = screen.getByLabelText("项目标题");
    await user.clear(titleInput); await user.type(titleInput, "Beta");
    await user.click(within(editor).getByRole("button", { name: /^项目截止日期/ }));
    await user.click(screen.getByRole("button", { name: "设为今天" }));
    await user.click(screen.getByRole("button", { name: "保存项目" }));
    await waitFor(() => expect(native.updateProject).toHaveBeenCalledWith(expect.objectContaining({ id: "project-1", title: "Beta", deadlineLocal: isoDaysFromNow(0) })));
  });

  it("keeps the project card compact and shows the last progress date in the footer", async () => {
    const user = userEvent.setup();
    const now = new Date();
    const occurred = new Date(now.getFullYear(), 6, 15, 12, 0, 0);
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "Alpha", deadlineLocal: null }, { id: "project-2", title: "Beta", deadlineLocal: null }],
      tasks: [{ id: "task-1", projectId: "project-1", title: "写大纲", progress: 40, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
      progressEvents: [{ id: "event-1", taskId: "task-1", fromProgress: 0, toProgress: 40, occurredAtUtc: occurred.toISOString() }],
    };
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi(initial)} />);
    await user.click(await screen.findByRole("button", { name: "项目" }));
    await screen.findByRole("heading", { name: "Alpha", level: 2 });

    const alpha = document.querySelector<HTMLElement>('[data-project-card="project-1"]')!;
    // 旧的“任务完成／里程碑／最近推进”三列事实行已移除，避免和上方摘要重复。
    expect(alpha.querySelector(".project-card-facts")).toBeNull();
    // 任务数量用“完成 / 总数”的紧凑分数，不再写“1 个任务 · 0 项完成”。
    expect(alpha.querySelector(".project-card-count")).toHaveTextContent("0 / 1");
    // 右下角只留一个可读日期，而不是“8/4”这种像分数的短格式。
    const alphaRecent = alpha.querySelector<HTMLElement>(".project-card-recent")!;
    expect(alphaRecent).toHaveTextContent("上次推进 7月15日");
    expect(alphaRecent).not.toHaveTextContent("7/15");
    expect(alpha).not.toHaveTextContent("任务完成");

    const beta = document.querySelector<HTMLElement>('[data-project-card="project-2"]')!;
    expect(beta.querySelector<HTMLElement>(".project-card-recent")!).toHaveTextContent("还没有推进");
  });

  it("shows project, task and milestone dates as Chinese month-day expressions", async () => {
    const user = userEvent.setup();
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "Alpha", deadlineLocal: "2027-01-15" }],
      tasks: [{ id: "task-1", projectId: "project-1", title: "写大纲", progress: 0, status: "active", deadlineLocal: "2027-01-12", estimatedMinutes: 60, sortOrder: 0 }],
      projectMilestones: [{ id: "ms-1", projectId: "project-1", title: "第一阶段", targetLocalDate: "2027-01-15", sortOrder: 0, criterionKind: "taskCount", targetTaskId: null, targetCount: 1, targetProgress: null }],
    };
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi(initial)} />);
    await user.click(await screen.findByRole("button", { name: "项目" }));
    const card = await screen.findByRole("heading", { name: "Alpha", level: 2 });
    const cardArticle = card.closest<HTMLElement>("[data-project-card]")!;
    expect(cardArticle).toHaveTextContent("项目截止 1月15日");
    expect(cardArticle).not.toHaveTextContent("1/15");

    await openProject(user, "Alpha");
    const detail = document.getElementById("project-detail")!;
    expect(detail).toHaveTextContent("完成 1 个项目任务 · 1月15日前");
    expect(detail).not.toHaveTextContent("1/15");
    expect(detail).toHaveTextContent("截止 1月12日");
    expect(detail).not.toHaveTextContent("1/12");
  });

  it("filters projects by a 临期项目 chip instead of a switch", async () => {
    const user = userEvent.setup();
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [
        { id: "project-1", title: "Alpha", deadlineLocal: isoDaysFromNow(2) },
        { id: "project-2", title: "Beta", deadlineLocal: isoDaysFromNow(10) },
        { id: "project-3", title: "Gamma", deadlineLocal: null },
      ],
    };
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi(initial)} />);
    await user.click(await screen.findByRole("button", { name: "项目" }));
    await screen.findByRole("heading", { name: "Beta", level: 2 });
    expect(document.querySelector(".project-filters .switch")).toBeNull();

    const filter = screen.getByRole("button", { name: "只看临期项目" });
    expect(filter).toHaveAttribute("aria-pressed", "false");
    expect(filter).toHaveTextContent("临期项目");
    await user.click(filter);
    expect(filter).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("heading", { name: "Beta", level: 2 })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Gamma", level: 2 })).toBeNull();
    expect(screen.getByRole("heading", { name: "Alpha", level: 2 })).toBeVisible();

    await user.click(filter);
    expect(filter).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("heading", { name: "Beta", level: 2 })).toBeVisible();
  });

  it("creates a milestone with an ordered task and shows the reached state", async () => {
    const user = userEvent.setup();
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "Alpha", deadlineLocal: null }],
      tasks: [{ id: "task-1", projectId: "project-1", title: "写大纲", progress: 100, status: "completed", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
      projectMilestones: [{ id: "ms-1", projectId: "project-1", title: "大纲定稿", targetLocalDate: "2026-08-20", sortOrder: 0, criterionKind: "orderedTask", targetTaskId: "task-1", targetCount: null, targetProgress: null }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "项目" }));
    await openProject(user, "Alpha");
    expect((await screen.findAllByText("大纲定稿")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("已达成").length).toBeGreaterThan(0);
    const addMilestone = screen.getByRole("button", { name: "为 Alpha 新增里程碑" });
    // 里程碑入口是纯 + 图标按钮，不占一行文字。
    expect(addMilestone.textContent?.trim()).toBe("");
    expect(addMilestone.querySelector("svg")).not.toBeNull();
    await user.click(addMilestone);
    expect(screen.getByRole("dialog", { name: "里程碑" })).toBeVisible();
    // 编辑里程碑气泡：点空白关闭，不写库。
    await user.click(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "里程碑" })).toBeNull());
    expect(native.createProjectMilestone).not.toHaveBeenCalled();
    await user.click(addMilestone);
    await user.type(screen.getByLabelText("里程碑名称"), "终稿完成");
    // 目标日期用自绘月历（与回顾页任务截止日期同一个 DateField），不再用原生日期输入。
    await user.click(screen.getByRole("button", { name: /^目标日期/ }));
    await user.click(screen.getByRole("button", { name: "设为今天" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "顺序目标任务" }), "task-1");
    await user.click(screen.getByRole("button", { name: "保存里程碑" }));
    await waitFor(() => expect(native.createProjectMilestone).toHaveBeenCalledWith(expect.objectContaining({ title: "终稿完成", criterionKind: "orderedTask", targetTaskId: "task-1" })));
  });

  it("keeps an ordered-task milestone in progress until every preceding task is complete", async () => {
    const user = userEvent.setup();
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "Alpha", deadlineLocal: null }],
      tasks: [
        { id: "task-1", projectId: "project-1", title: "前置任务", progress: 20, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 },
        { id: "task-2", projectId: "project-1", title: "目标任务", progress: 100, status: "completed", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 1 },
      ],
      projectMilestones: [{ id: "ms-1", projectId: "project-1", title: "完成到目标任务", targetLocalDate: isoDaysFromNow(2), sortOrder: 0, criterionKind: "orderedTask", targetTaskId: "task-2", targetCount: null, targetProgress: null }],
    };
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi(initial)} />);
    await user.click(await screen.findByRole("button", { name: "项目" }));
    await openProject(user, "Alpha");
    expect((await screen.findAllByText("完成到目标任务")).length).toBeGreaterThan(0);
    expect(screen.getByText("进行中")).toBeVisible();
  });

  it("edits and deletes a milestone and restores it from the undo toast", async () => {
    const user = userEvent.setup();
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "Alpha", deadlineLocal: null }],
      tasks: [{ id: "task-1", projectId: "project-1", title: "写大纲", progress: 40, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }, { id: "task-2", projectId: "project-1", title: "画分镜", progress: 100, status: "completed", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 1 }],
      projectMilestones: [{ id: "ms-1", projectId: "project-1", title: "两个任务完成", targetLocalDate: "2026-09-01", sortOrder: 0, criterionKind: "taskCount", targetTaskId: null, targetCount: 2, targetProgress: null }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "项目" }));
    await openProject(user, "Alpha");
    await screen.findAllByText("两个任务完成");
    await user.click(screen.getByRole("button", { name: "编辑里程碑 两个任务完成" }));
    const nameInput = screen.getByLabelText("里程碑名称");
    await user.clear(nameInput); await user.type(nameInput, "完成两个任务");
    await user.click(screen.getByRole("button", { name: "保存里程碑" }));
    await waitFor(() => expect(native.updateProjectMilestone).toHaveBeenCalledWith(expect.objectContaining({ id: "ms-1", title: "完成两个任务" })));
    // 删除先出二次确认气泡；点空白取消后不写库。
    await user.click(await screen.findByRole("button", { name: "删除里程碑 完成两个任务" }));
    expect(await screen.findByText("删除里程碑「完成两个任务」？")).toBeVisible();
    // 确认气泡是模态：背景 inert，点空白只取消气泡，不会连带关掉项目抽屉。
    expect(document.querySelector(".app-shell")).toHaveAttribute("inert");
    await user.click(document.body);
    await waitFor(() => expect(screen.queryByText("删除里程碑「完成两个任务」？")).toBeNull());
    expect(document.getElementById("project-detail")).not.toBeNull();
    expect(native.deleteProjectMilestone).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "删除里程碑 完成两个任务" }));
    await user.click(await screen.findByRole("button", { name: "删除" }));
    await waitFor(() => expect(native.deleteProjectMilestone).toHaveBeenCalledWith("ms-1"));
    await user.click(await screen.findByRole("button", { name: /恢复项目里程碑/ }));
    await waitFor(() => expect(native.createProjectMilestone).toHaveBeenCalledWith(expect.objectContaining({ id: "ms-1" })));
  });

  it("shows the frozen outcome of an unreached milestone and offers a continue draft with the remaining target", async () => {
    const user = userEvent.setup();
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "Alpha", deadlineLocal: null }],
      tasks: [{ id: "task-1", projectId: "project-1", title: "写大纲", progress: 100, status: "completed", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }, { id: "task-2", projectId: "project-1", title: "画分镜", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 1 }],
      projectMilestones: [{ id: "ms-1", projectId: "project-1", title: "两个任务完成", targetLocalDate: "2026-08-20", sortOrder: 0, criterionKind: "taskCount", targetTaskId: null, targetCount: 2, targetProgress: null }],
      milestoneOutcomes: [{ id: "outcome-1", milestoneId: "ms-1", projectId: "project-1", title: "两个任务完成", targetLocalDate: "2026-08-20", reached: false, resultText: "完成 1/2，未达成", frozenAtUtc: "2026-08-20T12:00:00Z" }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "项目" }));
    await openProject(user, "Alpha");
    expect(await screen.findByText(/完成 1\/2，未达成/)).toBeVisible();
    expect(screen.getByText("未达成")).toBeVisible();
    expect(screen.queryByRole("button", { name: "编辑里程碑 两个任务完成" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除里程碑 两个任务完成" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "续排里程碑 两个任务完成" }));
    expect(screen.getByRole("heading", { name: "续排里程碑：两个任务完成" })).toBeVisible();
    expect(screen.getByLabelText("完成任务数")).toHaveValue(2);
    await user.click(screen.getByRole("button", { name: "保存续排" }));
    await waitFor(() => expect(native.createProjectMilestone).toHaveBeenCalledWith(expect.objectContaining({ criterionKind: "taskCount", targetCount: 2, projectId: "project-1" })));
  });

  it("keeps a reached milestone without a frozen outcome", async () => {
    const user = userEvent.setup();
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "Alpha", deadlineLocal: null }],
      tasks: [{ id: "task-1", projectId: "project-1", title: "写大纲", progress: 100, status: "completed", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
      projectMilestones: [{ id: "ms-1", projectId: "project-1", title: "大纲定稿", targetLocalDate: "2026-08-20", sortOrder: 0, criterionKind: "orderedTask", targetTaskId: "task-1", targetCount: null, targetProgress: null }],
    };
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi(initial)} />);
    await user.click(await screen.findByRole("button", { name: "项目" }));
    await openProject(user, "Alpha");
    expect((await screen.findAllByText("已达成")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "续排里程碑 大纲定稿" })).not.toBeInTheDocument();
  });

  it("uses the project deadline as a fallback deadline in auto scheduling", async () => {
    const user = userEvent.setup();
    const projectDeadline = isoDaysFromNow(6);
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "Alpha", deadlineLocal: projectDeadline }],
      tasks: [{ id: "task-1", projectId: "project-1", title: "写大纲", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sessionMinutes: 30, priority: "normal", sortOrder: 0, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task" }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: /自动排程/ }));
    const dialog = await screen.findByRole("dialog", { name: "自动排程" });
    const item = await within(dialog).findByText("写大纲");
    // 结果胶囊在行右侧列里、不在 label 内，所以按整行断言。
    expect(item.closest(".schedule-row")).toHaveTextContent(/分钟|放不下/);
    await user.click(screen.getByRole("button", { name: "生成排程草案" }));
    expect(await screen.findByRole("button", { name: /应用 \d+ 个时段/ })).toBeVisible();
    await user.click(screen.getByRole("button", { name: /应用 \d+ 个时段/ }));
    await waitFor(() => expect(native.applyScheduleDraft).toHaveBeenCalled());
    const allocations = (native.applyScheduleDraft as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<{ localDate: string }>;
    expect(allocations.length).toBeGreaterThan(0);
    expect(allocations.every((allocation) => allocation.localDate <= projectDeadline)).toBe(true);
  });

  it("uses the earliest applicable milestone as an auto-scheduling constraint", async () => {
    const user = userEvent.setup();
    const milestoneDate = isoDaysFromNow(0);
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "Alpha", deadlineLocal: isoDaysFromNow(6) }],
      tasks: [
        { id: "task-paused", projectId: "project-1", title: "暂停事项", progress: 0, status: "paused", deadlineLocal: null, estimatedMinutes: null, sessionMinutes: 30, priority: "normal", sortOrder: 0, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task" },
        { id: "task-1", projectId: "project-1", title: "写大纲", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sessionMinutes: 30, priority: "normal", sortOrder: 1, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task" },
      ],
      projectMilestones: [{ id: "ms-1", projectId: "project-1", title: "完成一项", targetLocalDate: milestoneDate, sortOrder: 0, criterionKind: "taskCount", targetTaskId: null, targetCount: 1, targetProgress: null }],
      timeBlocks: [{ id: "block-1", title: "今天不可用", localDate: milestoneDate, endLocalDate: milestoneDate, startLocal: "00:00", endLocal: "23:59", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480 }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: /自动排程/ }));
    const dialog = await screen.findByRole("dialog", { name: "自动排程" });
    // 排不进的项不再混在主列表里：先展开底部折叠，再读它的确定性原因。
    await user.click(within(dialog).getByRole("button", { name: /另有 1 项暂时无法安排/ }));
    expect((await within(dialog).findByText("写大纲")).closest(".schedule-row")).toHaveTextContent("截止日期前没有可用空档");
    expect(screen.getByRole("button", { name: "生成排程草案" })).toBeDisabled();
  });

  it("undoes an applied schedule draft through the toast and removes every session", async () => {
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE), tasks: [{ id: "task-1", projectId: null, title: "准备候选版", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sessionMinutes: 45, priority: "normal", sortOrder: 0, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task" }] };
    const user = userEvent.setup(); const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: /自动排程/ }));
    await user.click(screen.getByRole("button", { name: "生成排程草案" }));
    await user.click(screen.getByRole("button", { name: /应用 \d+ 个时段/ }));
    await waitFor(() => expect(native.applyScheduleDraft).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: /撤销本次自动排程/ }));
    await waitFor(() => expect(native.deleteExecutionSessions).toHaveBeenCalledOnce());
    const sessions = (native.applyScheduleDraft as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<{ id: string }>;
    expect(native.deleteExecutionSessions).toHaveBeenCalledWith(sessions.map((session) => session.id));
  });

  it("shows the undo toast for about five seconds, pauses while hovered, and keeps Ctrl+Z working after it goes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE), tasks: [{ id: "task-1", projectId: null, title: "准备候选版", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sessionMinutes: 45, priority: "normal", sortOrder: 0, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task" }] };
      const native = createNativeApi(initial);
      render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
      await user.click(await screen.findByRole("button", { name: /自动排程/ }));
      await user.click(screen.getByRole("button", { name: "生成排程草案" }));
      await user.click(screen.getByRole("button", { name: /应用 \d+ 个时段/ }));
      const toast = await screen.findByRole("button", { name: /撤销本次自动排程/ });

      // UI-SPEC §188：鼠标悬停在提示上时暂停消失计时。
      await user.hover(toast);
      act(() => vi.advanceTimersByTime(30_000));
      expect(screen.getByRole("button", { name: /撤销本次自动排程/ })).toBeInTheDocument();

      // 移开后重新计时：约 5 秒收起（旧实现从不收起，这条会红）。
      await user.unhover(toast);
      act(() => vi.advanceTimersByTime(4_000));
      expect(screen.getByRole("button", { name: /撤销本次自动排程/ })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1_200));
      expect(screen.queryByRole("button", { name: /撤销本次自动排程/ })).not.toBeInTheDocument();

      // UI-SPEC §188：提示消失后仍可通过 Ctrl+Z 撤销 —— 提示与撤销栈是两件事。
      await user.keyboard("{Control>}z{/Control}");
      await waitFor(() => expect(native.deleteExecutionSessions).toHaveBeenCalledOnce());
    } finally { vi.useRealTimers(); }
  });

  it("moves a time block as a whole by dragging its body", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, day: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      timeBlocks: [{ id: "block-3", title: "午休", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480 }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    const body = await screen.findByText("午休");
    const down = createEvent.pointerDown(body, { button: 0, clientY: 600 }); fireEvent(body, down);
    const move = createEvent.pointerMove(window, { clientY: 696, clientX: 100 }); fireEvent(window, move);
    // 标准档 168px/小时：96px ≈ 34 分钟，吸附 15 分钟 → +30 分钟。
    expect(screen.getByRole("status", { name: "时间块时间预览" })).toHaveTextContent("10:30–11:30");
    // 拖动整块时落点虚线框要出现，且停在吸附后的最终位置（不是跟手的中间像素）。
    expect(document.querySelector(".calendar-time-block-drop")).toBeTruthy();
    const up = createEvent.pointerUp(window, { clientY: 696, clientX: 100 }); fireEvent(window, up);
    await waitFor(() => expect(native.updateTimeBlock).toHaveBeenCalledWith(expect.objectContaining({ id: "block-3", startLocal: "10:30", endLocal: "11:30", localDate: "2026-08-05" })));
  });

  it("drags a time block horizontally into the adjacent day in week view", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      timeBlocks: [{ id: "block-4", title: "例会", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480 }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    await screen.findByText("例会");
    const track = document.querySelector<HTMLElement>('.calendar-day[data-day-date="2026-08-05"] .day-track')!;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 1440, width: 100, height: 1440, toJSON: () => ({}) });
    const body = screen.getByText("例会");
    const down = createEvent.pointerDown(body, { button: 0, clientX: 40, clientY: 600 }); fireEvent(body, down);
    const move = createEvent.pointerMove(window, { clientX: 140, clientY: 600 }); fireEvent(window, move);
    const up = createEvent.pointerUp(window, { clientX: 140, clientY: 600 }); fireEvent(window, up);
    await waitFor(() => expect(native.updateTimeBlock).toHaveBeenCalledWith(expect.objectContaining({ id: "block-4", startLocal: "10:00", endLocal: "11:00", localDate: "2026-08-06", endLocalDate: "2026-08-06" })));
  });

  it("keeps a moved time block at the landed position while the write is still in flight", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" }, calendarScale: { day: 48, week: 48, month: 120 } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      timeBlocks: [{ id: "block-land", title: "落点块", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480 }],
    };
    // 写入一直不返回，正好复现「松手之后、数据回来之前」那段窗口。
    const native = createNativeApi(initial, { updateTimeBlock: vi.fn(() => new Promise<WorkspaceSnapshot>(() => {})) });
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    await screen.findByText("落点块");
    const track = document.querySelector<HTMLElement>('.calendar-day[data-day-date="2026-08-05"] .day-track')!;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 1440, width: 100, height: 1440, toJSON: () => ({}) });
    const body = screen.getByText("落点块");
    fireEvent(body, createEvent.pointerDown(body, { button: 0, clientX: 40, clientY: 600 }));
    fireEvent(window, createEvent.pointerMove(window, { clientX: 40, clientY: 750 }));
    fireEvent(window, createEvent.pointerUp(window, { clientX: 40, clientY: 750 }));

    // 10:00 → 13:15（15 分钟吸附）。松手后卡片必须停在落点，
    // 而不是回落到旧时间再等数据回来跳一下。
    const article = body.closest("article")!;
    expect(parseFloat(article.style.top)).toBeCloseTo((13 * 60 + 15) / 1440 * 100, 3);
  });

  it("renders a cross-day time block landing in the target column while the write is in flight", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" }, calendarScale: { day: 48, week: 48, month: 120 } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      timeBlocks: [{ id: "block-cross", title: "跨列块", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480 }],
    };
    // 写入一直不返回：整段「松手之后、数据回来之前」的窗口都被摊开来看。
    const native = createNativeApi(initial, { updateTimeBlock: vi.fn(() => new Promise<WorkspaceSnapshot>(() => {})) });
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    await screen.findByText("跨列块");
    const sourceTrack = document.querySelector<HTMLElement>('.calendar-day[data-day-date="2026-08-05"] .day-track')!;
    const rect = { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 1440, width: 100, height: 1440, toJSON: () => ({}) };
    vi.spyOn(sourceTrack, "getBoundingClientRect").mockReturnValue(rect);

    const body = screen.getByText("跨列块");
    fireEvent(body, createEvent.pointerDown(body, { button: 0, clientX: 40, clientY: 600 }));
    // 横向位移 50px（半列）：卡片必须**自由跟手**（7 + 50 = 57px），不能被卡在整列格子上。
    fireEvent(window, createEvent.pointerMove(window, { clientX: 90, clientY: 600 }));
    const dragging = body.closest("article") as HTMLElement;
    expect(dragging.style.left).toContain("57px");
    // 落点虚线框则按整列吸附：半列算作下一列（7 + 100 = 107px）。
    expect(document.querySelector<HTMLElement>(".calendar-time-block-drop")!.style.left).toContain("107px");

    fireEvent(window, createEvent.pointerUp(window, { clientX: 90, clientY: 600 }));
    await waitFor(() => expect(native.updateTimeBlock).toHaveBeenCalled());

    // 松手后卡片瞬时收到虚线框里（吸附列 + 吸附时间），不做过渡、也不弹回源列。
    expect(dragging.style.left).toContain("107px");
    expect(dragging).toHaveAttribute("data-landed", "true");
    expect(parseFloat(dragging.style.top)).toBeCloseTo(600 / 1440 * 100, 3);
    expect(parseFloat(dragging.style.height)).toBeCloseTo(60 / 1440 * 100, 3);
  });

  it("moves a session with a pointer, shows the exact readout, and lands it while the write is in flight", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" }, calendarScale: { day: 48, week: 48, month: 120 } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-move", projectId: null, title: "跨列移动", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
      executionSessions: [{ id: "session-move", taskId: "task-move", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
    };
    // 写入一直不返回：整段「松手之后、数据回来之前」的窗口都被摊开来看。
    const native = createNativeApi(initial, { applyExecutionSessionChanges: vi.fn(() => new Promise<WorkspaceSnapshot>(() => {})) });
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    const card = await screen.findByText("跨列移动", { selector: ".calendar-session strong" });
    const source = card.closest<HTMLElement>(".calendar-session")!;
    vi.spyOn(source, "getBoundingClientRect").mockReturnValue({ x: 0, y: 600, top: 600, left: 0, right: 100, bottom: 660, width: 100, height: 60, toJSON: () => ({}) });
    const targetTrack = document.querySelector<HTMLElement>('.calendar-day[data-day-date="2026-08-06"] .day-track')!;
    vi.spyOn(targetTrack, "getBoundingClientRect").mockReturnValue({ x: 200, y: 0, top: 0, left: 200, right: 400, bottom: 1440, width: 200, height: 1440, toJSON: () => ({}) });

    fireEvent(source, createEvent.pointerDown(source, { button: 0, clientX: 50, clientY: 600 }));
    fireEvent(window, createEvent.pointerMove(window, { clientX: 300, clientY: 500 }));
    // 拖动中：真卡两轴跟手 + 贴卡精确读数（4 小时内不 latch）。
    expect(source).toHaveAttribute("data-dragging", "true");
    expect(source.style.transform).toContain("translate(250px, -100px)");
    expect(screen.getByRole("status", { name: "拖动时间预览" })).toHaveTextContent("08:15–09:15 · 60 分钟");
    fireEvent(window, createEvent.pointerUp(window, { clientX: 300, clientY: 500 }));
    await waitFor(() => expect(native.applyExecutionSessionChanges).toHaveBeenCalled());

    // 源列那一份必须让位，否则松手后旧位置继续显示、数据回来才跳走 —— 就是跨列松手的错位动画。
    const sourceColumn = document.querySelector('.calendar-day[data-day-date="2026-08-05"]')!;
    expect(sourceColumn.querySelector(".calendar-session")).toBeNull();
    const landed = document.querySelector<HTMLElement>('.calendar-day[data-day-date="2026-08-06"] .calendar-session')!;
    expect(landed).toHaveClass("is-landed");
    expect(landed).toHaveTextContent("跨列移动");
    // 500 分钟吸附到 495（08:15）并落在目标列，而不是停回旧列旧时间。
    expect(parseFloat(landed.style.top)).toBeCloseTo(495 / 1440 * 100, 3);
    // 提交与预览同口径：落库时间就是预览显示的时间。
    expect(native.applyExecutionSessionChanges).toHaveBeenCalledWith(expect.objectContaining({
      update: [expect.objectContaining({ id: "session-move", localDate: "2026-08-06", startLocal: "08:15", endLocal: "09:15" })],
    }));
  });

  it("converts the pointer through the scrolled track's own top edge", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" }, calendarScale: { day: 48, week: 48, month: 120 } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-scrolled", projectId: null, title: "滚动轨道", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
      executionSessions: [{ id: "session-scrolled", taskId: "task-scrolled", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    const source = (await screen.findByText("滚动轨道", { selector: ".calendar-session strong" })).closest<HTMLElement>(".calendar-session")!;
    const track = document.querySelector<HTMLElement>('.calendar-day[data-day-date="2026-08-05"] .day-track')!;
    // 轨道上半截已滚出视口：clientY 与轨道内偏移差 200px，指针换算是两者的差。
    vi.spyOn(source, "getBoundingClientRect").mockReturnValue({ x: 0, y: 400, top: 400, left: 0, right: 100, bottom: 500, width: 100, height: 100, toJSON: () => ({}) });
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ x: 0, y: -200, top: -200, left: 0, right: 200, bottom: 1240, width: 200, height: 1440, toJSON: () => ({}) });

    fireEvent(source, createEvent.pointerDown(source, { button: 0, clientX: 50, clientY: 404 }));
    fireEvent(window, createEvent.pointerMove(window, { clientX: 50, clientY: 704 }));
    expect(screen.getByRole("status", { name: "拖动时间预览" })).toHaveTextContent("15:00–16:00 · 60 分钟");
    fireEvent(window, createEvent.pointerUp(window, { clientX: 50, clientY: 704 }));
  });

  it("yields real cards during an edge insert and restores them when the pointer leaves", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" }, calendarScale: { day: 48, week: 48, month: 120 } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [
        { id: "task-source", projectId: null, title: "移动源", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 },
        { id: "task-target", projectId: null, title: "目标任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 1 },
        { id: "task-next", projectId: null, title: "后续任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 2 },
      ],
      executionSessions: [
        { id: "session-source", taskId: "task-source", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "14:00", endLocal: "15:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
        { id: "session-target", taskId: "task-target", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
        { id: "session-next", taskId: "task-next", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "11:00", endLocal: "12:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
      ],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    const sourceText = await screen.findByText("移动源", { selector: ".calendar-session strong" });
    const source = sourceText.closest<HTMLElement>(".calendar-session")!;
    const target = screen.getByText("目标任务", { selector: ".calendar-session strong" }).closest<HTMLElement>(".calendar-session")!;
    const next = screen.getByText("后续任务", { selector: ".calendar-session strong" }).closest<HTMLElement>(".calendar-session")!;
    const track = document.querySelector<HTMLElement>('.calendar-day[data-day-date="2026-08-05"] .day-track')!;
    vi.spyOn(source, "getBoundingClientRect").mockReturnValue({ x: 0, y: 840, top: 840, left: 0, right: 100, bottom: 900, width: 100, height: 60, toJSON: () => ({}) });
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ x: 0, y: 600, top: 600, left: 0, right: 100, bottom: 660, width: 100, height: 60, toJSON: () => ({}) });
    vi.spyOn(next, "getBoundingClientRect").mockReturnValue({ x: 0, y: 660, top: 660, left: 0, right: 100, bottom: 720, width: 100, height: 60, toJSON: () => ({}) });
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 1440, width: 200, height: 1440, toJSON: () => ({}) });

    fireEvent(source, createEvent.pointerDown(source, { button: 0, clientX: 50, clientY: 840 }));
    // 目标卡上缘（ratio < .25）→ 插入并后移：目标与后续的真卡在拖动中就移到新位置。
    fireEvent(window, createEvent.pointerMove(window, { clientX: 50, clientY: 605 }));
    expect(screen.getByRole("status", { name: "拖拽排程预览" })).toHaveTextContent("插入并后移");
    expect(target).toHaveAttribute("data-yielding", "true");
    expect(next).toHaveAttribute("data-yielding", "true");
    expect(parseFloat(target.style.top)).toBeCloseTo(660 / 1440 * 100, 3);
    expect(parseFloat(next.style.top)).toBeCloseTo(720 / 1440 * 100, 3);

    // 拖出有效区域：真卡复原，且不写库。
    fireEvent(window, createEvent.pointerMove(window, { clientX: 600, clientY: 100 }));
    expect(target).not.toHaveAttribute("data-yielding");
    expect(parseFloat(target.style.top)).toBeCloseTo(600 / 1440 * 100, 3);
    expect(screen.queryByRole("status", { name: "拖拽排程预览" })).not.toBeInTheDocument();
    fireEvent(window, createEvent.pointerUp(window, { clientX: 600, clientY: 100 }));
    expect(native.applyExecutionSessionChanges).not.toHaveBeenCalled();
  });

  it("commits the same edge insert the preview showed after the target cards yielded", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" }, calendarScale: { day: 48, week: 48, month: 120 } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [
        { id: "task-source", projectId: null, title: "插入源", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 },
        { id: "task-target", projectId: null, title: "插入目标", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 1 },
        { id: "task-next", projectId: null, title: "插入邻位", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 2 },
      ],
      executionSessions: [
        { id: "session-source", taskId: "task-source", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "14:00", endLocal: "15:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
        { id: "session-target", taskId: "task-target", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
        { id: "session-next", taskId: "task-next", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "11:00", endLocal: "12:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
      ],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    const source = (await screen.findByText("插入源", { selector: ".calendar-session strong" })).closest<HTMLElement>(".calendar-session")!;
    const target = screen.getByText("插入目标", { selector: ".calendar-session strong" }).closest<HTMLElement>(".calendar-session")!;
    const track = document.querySelector<HTMLElement>('.calendar-day[data-day-date="2026-08-05"] .day-track')!;
    vi.spyOn(source, "getBoundingClientRect").mockReturnValue({ x: 0, y: 840, top: 840, left: 0, right: 100, bottom: 900, width: 100, height: 60, toJSON: () => ({}) });
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ x: 0, y: 600, top: 600, left: 0, right: 100, bottom: 660, width: 100, height: 60, toJSON: () => ({}) });
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 1440, width: 200, height: 1440, toJSON: () => ({}) });

    fireEvent(source, createEvent.pointerDown(source, { button: 0, clientX: 50, clientY: 840 }));
    fireEvent(window, createEvent.pointerMove(window, { clientX: 50, clientY: 605 }));
    expect(target).toHaveAttribute("data-yielding", "true");
    // 目标卡已被预览推走，指针下只剩虚线框：松手仍要按刚才预览的「插入前」提交。
    fireEvent(window, createEvent.pointerUp(window, { clientX: 50, clientY: 605 }));
    await waitFor(() => expect(native.applyExecutionSessionChanges).toHaveBeenCalled());
    const updates = (native.applyExecutionSessionChanges as ReturnType<typeof vi.fn>).mock.calls[0][0].update;
    expect(updates.map((session: { id: string; startLocal: string }) => [session.id, session.startLocal])).toEqual([
      ["session-source", "10:00"], ["session-target", "11:00"], ["session-next", "12:00"],
    ]);
    expect(screen.getByRole("button", { name: /撤销插入排程/ })).toBeVisible();
  });

  it("commits an overlap when the pointer is released in a card centre before the 500 ms latch", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [
        { id: "task-source", projectId: null, title: "中央源", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 },
        { id: "task-target", projectId: null, title: "中央目标", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 1 },
      ],
      executionSessions: [
        { id: "session-source", taskId: "task-source", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "14:00", endLocal: "15:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
        { id: "session-target", taskId: "task-target", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
      ],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    const source = (await screen.findByText("中央源", { selector: ".calendar-session strong" })).closest<HTMLElement>(".calendar-session")!;
    const target = screen.getByText("中央目标", { selector: ".calendar-session strong" }).closest<HTMLElement>(".calendar-session")!;
    const track = document.querySelector<HTMLElement>('.calendar-day[data-day-date="2026-08-05"] .day-track')!;
    vi.spyOn(source, "getBoundingClientRect").mockReturnValue({ x: 0, y: 840, top: 840, left: 0, right: 100, bottom: 900, width: 100, height: 60, toJSON: () => ({}) });
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ x: 0, y: 600, top: 600, left: 0, right: 100, bottom: 660, width: 100, height: 60, toJSON: () => ({}) });
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 1440, width: 200, height: 1440, toJSON: () => ({}) });

    fireEvent(source, createEvent.pointerDown(source, { button: 0, clientX: 50, clientY: 840 }));
    fireEvent(window, createEvent.pointerMove(window, { clientX: 50, clientY: 630 }));
    // 半秒未到：预览只提示「悬停 0.5 秒以同时安排」。
    expect(screen.getByRole("status", { name: "拖拽排程预览" })).toHaveTextContent("悬停 0.5 秒以同时安排");
    fireEvent(window, createEvent.pointerUp(window, { clientX: 50, clientY: 630 }));
    await waitFor(() => expect(native.applyExecutionSessionChanges).toHaveBeenCalledOnce());
    // D5：中央松手直接按 overlap 提交（不再静默丢弃），目标卡不动。
    // D16／C4：开始时间取**松手时刻**（指针 630 → 10:30，经 15 分钟吸附），不再对齐目标卡起点。
    expect(native.applyExecutionSessionChanges).toHaveBeenCalledWith(expect.objectContaining({
      update: [expect.objectContaining({ id: "session-source", localDate: "2026-08-05", startLocal: "10:30", endLocal: "11:30" })],
    }));
    expect(target.closest(".calendar-session")).not.toBeNull();
  });

  it("drops the second side-by-side card at a staggered minute when the pointer stays in its own lane", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" }, calendarScale: { day: 48, week: 48, month: 120 } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [
        { id: "task-first", projectId: null, title: "并排第一张", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 },
        { id: "task-second", projectId: null, title: "并排第二张", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 1 },
      ],
      executionSessions: [
        { id: "session-first", taskId: "task-first", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
        { id: "session-second", taskId: "task-second", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
      ],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    const first = (await screen.findByText("并排第一张", { selector: ".calendar-session strong" })).closest<HTMLElement>(".calendar-session")!;
    const second = screen.getByText("并排第二张", { selector: ".calendar-session strong" }).closest<HTMLElement>(".calendar-session")!;
    const track = first.closest<HTMLElement>(".day-track")!;
    // 两张卡各占半栏（`concurrentLayouts` 的落库布局写在 `data-lane-*` 上，供命中判横向）。
    expect(first.dataset).toMatchObject({ laneLeft: "0", laneWidth: "50" });
    expect(second.dataset).toMatchObject({ laneLeft: "50", laneWidth: "50" });
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 1440, width: 200, height: 1440, toJSON: () => ({}) });
    vi.spyOn(first, "getBoundingClientRect").mockReturnValue({ x: 0, y: 600, top: 600, left: 0, right: 100, bottom: 660, width: 100, height: 60, toJSON: () => ({}) });
    vi.spyOn(second, "getBoundingClientRect").mockReturnValue({ x: 100, y: 600, top: 600, left: 100, right: 200, bottom: 660, width: 100, height: 60, toJSON: () => ({}) });

    // 抓第二张（右栏），指针纵向穿过第一张的时间区间，但横向一直在自己那一栏。
    fireEvent(second, createEvent.pointerDown(second, { button: 0, clientX: 150, clientY: 600 }));
    fireEvent(window, createEvent.pointerMove(window, { clientX: 150, clientY: 630 }));
    // D16：lane 空白不构成命中 → 自由放置，而不是「同时安排／插入并后移」。
    expect(screen.getByRole("status", { name: "拖拽排程预览" })).toHaveTextContent("松开放置");
    expect(first).not.toHaveAttribute("data-yielding", "true");
    fireEvent(window, createEvent.pointerUp(window, { clientX: 150, clientY: 630 }));
    await waitFor(() => expect(native.applyExecutionSessionChanges).toHaveBeenCalledOnce());
    // 落库 = 松手时刻（经 15 分钟吸附），与第一张错开 30 分钟；没有级联所以只写这一份。
    expect(native.applyExecutionSessionChanges).toHaveBeenCalledWith(expect.objectContaining({
      update: [expect.objectContaining({ id: "session-second", localDate: "2026-08-05", startLocal: "10:30", endLocal: "11:30" })],
      deleteIds: [],
    }));
    expect(document.querySelectorAll('.calendar-day[data-day-date="2026-08-05"] [data-yielding="true"]')).toHaveLength(0);
    await waitFor(() => expect(second.querySelector("time")).toHaveTextContent("10:30–11:30"));
    // 一次手势 = 一个撤销项。
    expect(screen.getByRole("button", { name: /撤销时间修改/ })).toBeInTheDocument();
  });

  it("resizes a session from its bottom handle with the shared pointer session", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" }, calendarScale: { day: 48, week: 48, month: 120 } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-resize", projectId: null, title: "改时长", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
      executionSessions: [{ id: "session-resize", taskId: "task-resize", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    await screen.findByText("改时长", { selector: ".calendar-session strong" });
    expect(document.querySelector(".calendar-page")).toHaveAttribute("data-calendar-scale", "48");
    const handle = screen.getByRole("button", { name: "调整 改时长 时长" });
    const source = handle.closest<HTMLElement>(".calendar-session")!;
    const track = document.querySelector<HTMLElement>('.calendar-day[data-day-date="2026-08-05"] .day-track')!;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 1440, width: 200, height: 1440, toJSON: () => ({}) });

    fireEvent(handle, createEvent.pointerDown(handle, { button: 0, clientY: 600 }));
    // 48px/小时：96px = 120 分钟，吸附 15 分钟 → 180 分钟。
    fireEvent(window, createEvent.pointerMove(window, { clientY: 696 }));
    expect(screen.getByRole("status", { name: "调整时长预览" })).toHaveTextContent("10:00–13:00 · 180 分钟");
    expect(source).toHaveAttribute("data-resizing", "true");
    fireEvent(window, createEvent.pointerUp(window, { clientY: 696 }));
    await waitFor(() => expect(native.updateExecutionSession).toHaveBeenCalledWith(expect.objectContaining({ id: "session-resize", startLocal: "10:00", endLocal: "13:00", localDate: "2026-08-05" })));
  });

  /**
   * 日历整改 B3（F21／D12）：改时长接入让位与确认。
   *
   * 这三条钉住的是「resize 与 move 走同一条让位与确认路」：拖动中后续真卡 `data-yielding`、
   * 侵入时间块只给两个出口、越界取消后一个字段都没动。
   */
  it("yields the following cards while a resize grows through them and commits both in one write", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" }, calendarScale: { day: 48, week: 48, month: 120 } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [
        { id: "task-grow", projectId: null, title: "拉长源", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 },
        { id: "task-follow", projectId: null, title: "拉长邻位", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 1 },
      ],
      executionSessions: [
        { id: "session-grow", taskId: "task-grow", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
        { id: "session-follow", taskId: "task-follow", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "11:00", endLocal: "12:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
      ],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    const handle = await screen.findByRole("button", { name: "调整 拉长源 时长" });
    const follow = screen.getByText("拉长邻位", { selector: ".calendar-session strong" }).closest<HTMLElement>(".calendar-session")!;

    fireEvent(handle, createEvent.pointerDown(handle, { button: 0, clientY: 600 }));
    // 48px/小时 → 48px = 60 分钟：10:00–12:00，原本 11:00 那一项让位到 12:00。
    fireEvent(window, createEvent.pointerMove(window, { clientY: 648 }));
    expect(screen.getByRole("status", { name: "调整时长预览" })).toHaveTextContent("10:00–12:00 · 120 分钟");
    expect(follow).toHaveAttribute("data-yielding", "true");
    expect(parseFloat(follow.style.top)).toBeCloseTo(720 / 1440 * 100, 3);

    fireEvent(window, createEvent.pointerUp(window, { clientY: 648 }));
    await waitFor(() => expect(native.applyExecutionSessionChanges).toHaveBeenCalledOnce());
    // 时长与让位是**一次**写入：分开写会留下「已经变长、后面还没让位」的中间态。
    const updates = (native.applyExecutionSessionChanges as ReturnType<typeof vi.fn>).mock.calls[0][0].update;
    expect(updates.map((session: { id: string; startLocal: string; endLocal: string }) => [session.id, session.startLocal, session.endLocal])).toEqual([
      ["session-grow", "10:00", "12:00"], ["session-follow", "12:00", "13:00"],
    ]);
    expect(screen.getByRole("button", { name: /撤销时间修改/ })).toBeVisible();
  });

  it("asks with exactly two options when a resize would cover a time block", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" }, calendarScale: { day: 48, week: 48, month: 120 } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-block", projectId: null, title: "撞块源", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
      executionSessions: [{ id: "session-block", taskId: "task-block", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
      timeBlocks: [{ id: "block-lunch", title: "午休", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "11:30", endLocal: "12:30", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480 }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    const handle = await screen.findByRole("button", { name: "调整 撞块源 时长" });

    fireEvent(handle, createEvent.pointerDown(handle, { button: 0, clientY: 600 }));
    // 拉到 12:00：区间盖住 11:30–12:30 的午休，但指针始终停在卡片下缘（11:00 附近）。
    fireEvent(window, createEvent.pointerMove(window, { clientY: 648 }));
    fireEvent(window, createEvent.pointerUp(window, { clientY: 648 }));

    const bubble = await screen.findByRole("dialog", { name: "重叠确认" });
    expect(bubble).toHaveTextContent("午休");
    expect(within(bubble).getByRole("button", { name: "仍然安排" })).toBeVisible();
    expect(within(bubble).getByRole("button", { name: "取消" })).toBeVisible();
    // 改时长没有「放到时间块之后」：时长已经由手势定死，整体挪到块后面是另一件事。
    expect(within(bubble).queryByRole("button", { name: "放到时间块之后" })).not.toBeInTheDocument();
    expect(document.querySelector(".calendar-page")).toHaveAttribute("data-drag-phase", "deciding");
    expect(native.updateExecutionSession).not.toHaveBeenCalled();
    expect(native.applyExecutionSessionChanges).not.toHaveBeenCalled();

    fireEvent.click(within(bubble).getByRole("button", { name: "仍然安排" }));
    await waitFor(() => expect(native.updateExecutionSession).toHaveBeenCalledWith(expect.objectContaining({ id: "session-block", startLocal: "10:00", endLocal: "12:00" })));
  });

  it("cancels a resize that would push a session out of the default slots without touching either", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day", calendarDayMode: "defaultSlots", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, day: "2026-08-05" }, calendarScale: { day: 48, week: 48, month: 120 },
      defaultTimeSlots: [{ id: "morning", label: "上午专注", start: "09:00", end: "12:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }] };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [
        { id: "task-slot", projectId: null, title: "越界源", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 },
        { id: "task-slot-next", projectId: null, title: "越界邻位", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 1 },
      ],
      executionSessions: [
        { id: "session-slot", taskId: "task-slot", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
        { id: "session-slot-next", taskId: "task-slot-next", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "11:00", endLocal: "12:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
      ],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    const handle = await screen.findByRole("button", { name: "调整 越界源 时长" });

    fireEvent(handle, createEvent.pointerDown(handle, { button: 0, clientY: 600 }));
    // 拉满可用时间：10:00–12:00 把 11:00 那一项推到 12:00–13:00，落在可用时间之外。
    fireEvent(window, createEvent.pointerMove(window, { clientY: 648 }));
    fireEvent(window, createEvent.pointerUp(window, { clientY: 648 }));

    const bubble = await screen.findByRole("dialog", { name: "越界确认" });
    expect(bubble).toHaveTextContent("会影响 1 项已有安排");
    expect(document.querySelector(".calendar-page")).toHaveAttribute("data-drag-phase", "deciding");

    fireEvent.click(within(bubble).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(document.querySelector(".calendar-page")).toHaveAttribute("data-drag-phase", "idle"));
    // 零副作用：时长、后续时段、库内写入一样都没动（取消不等于「写回去」，是根本没写）。
    expect(native.updateExecutionSession).not.toHaveBeenCalled();
    expect(native.applyExecutionSessionChanges).not.toHaveBeenCalled();
    expect(screen.getByText("越界源", { selector: ".calendar-session strong" }).closest(".calendar-session")!.querySelector("time")).toHaveTextContent("10:00–11:00");
    expect(screen.getByText("越界邻位", { selector: ".calendar-session strong" }).closest(".calendar-session")!.querySelector("time")).toHaveTextContent("11:00–12:00");
  });

  it("deletes a lightweight time block from the calendar", async () => {
    const today = isoDaysFromNow(0);
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      timeBlocks: [{ id: "block-1", title: "午休", localDate: today, endLocalDate: today, startLocal: "12:00", endLocal: "13:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480 }],
    };
    const user = userEvent.setup(); const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "日历" }));
    await user.click(screen.getByRole("button", { name: "删除时间块 午休" }));
    await waitFor(() => expect(native.deleteTimeBlock).toHaveBeenCalledWith("block-1"));
    expect(screen.queryByText("午休")).not.toBeInTheDocument();
  });

  it("does not reschedule a habit date already settled as skipped", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date("2026-08-02T10:00:00"));
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "habit-task", projectId: null, title: "拉伸", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sessionMinutes: 20, priority: "normal", sortOrder: 0, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "habit" }],
      recurringHabits: [{ id: "habit-1", taskId: "habit-task", title: "拉伸", pattern: "daily", weekdays: [], startDate: "2026-08-01", sessionMinutes: 20, preferredStartLocal: null, status: "active" }],
      habitOccurrences: [{ id: "occ-1", habitId: "habit-1", localDate: "2026-08-02", status: "skipped", sessionId: null }],
    };
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime }); const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: /自动排程/ }));
    await user.click(screen.getByRole("button", { name: "生成排程草案" }));
    expect(screen.getByRole("heading", { name: "排程草案" })).toBeVisible();
    // 候选中习惯收成一行，预览仍按日列卡：6 张卡各是一天的「拉伸」，已跳过的 8月2日不在其中。
    const cards = Array.from(document.querySelectorAll(".schedule-card"));
    expect(cards).toHaveLength(6);
    expect(cards.every((card) => card.querySelector("strong")?.textContent === "拉伸")).toBe(true);
    const days = Array.from(document.querySelectorAll(".schedule-day h3")).map((node) => node.textContent ?? "");
    expect(days).toHaveLength(6);
    expect(days.every((label) => !label.includes("8月2日"))).toBe(true);
    vi.useRealTimers();
  });

  it("closes the schedule panel with Escape, discards the selection and returns focus", async () => {
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE), tasks: [{ id: "task-1", projectId: null, title: "写大纲", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sessionMinutes: 30, priority: "normal", sortOrder: 0, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task" }] };
    const native = createNativeApi(initial);
    const user = userEvent.setup();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    const trigger = await screen.findByRole("button", { name: "自动排程" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "自动排程" });
    // 动作气泡不锁背景：任务池在气泡打开期间仍然可点。
    expect(document.querySelector(".app-shell")).not.toHaveAttribute("inert");
    // Tab 能进候选滚动区（axe 的 scrollable-region-focusable 要求它有焦点入口）。
    const region = within(dialog).getByRole("region", { name: "排程候选" });
    expect(region).toHaveAttribute("tabindex", "0");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "自动排程" })).not.toBeInTheDocument());
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    expect(document.activeElement).toBe(trigger);
    // 勾选是纯临时状态：关掉再打开回到推荐组合，不写任何执行时段。
    await user.click(trigger);
    expect(within(await screen.findByRole("dialog", { name: "自动排程" })).getByRole("checkbox", { name: /写大纲/ })).toBeChecked();
    expect(vi.mocked(native.applyScheduleDraft)).not.toHaveBeenCalled();
  });

  it("leads to the default time slot settings when auto scheduling has no slots at all", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, defaultTimeSlots: [] };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE), tasks: [{ id: "task-1", projectId: null, title: "写大纲", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sessionMinutes: 30, priority: "normal", sortOrder: 0, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task" }] };
    const user = userEvent.setup();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi(initial)} />);
    await user.click(await screen.findByRole("button", { name: /自动排程/ }));
    const dialog = await screen.findByRole("dialog", { name: "自动排程" });
    // 零可用时间窗口时不再渲染 13 行假候选，只留一句事实 + 一个设置入口。
    expect(within(dialog).getByText("还没有可用时间")).toBeVisible();
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "去标记可用时间" }));
    expect(await screen.findByRole("heading", { name: "设置", level: 1 })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "自动排程" })).not.toBeInTheDocument();
  });

  it("restores the recommended combination after the selection is cleared", async () => {
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE), tasks: [{ id: "task-1", projectId: null, title: "写大纲", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sessionMinutes: 30, priority: "normal", sortOrder: 0, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task" }] };
    const user = userEvent.setup();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi(initial)} />);
    await user.click(await screen.findByRole("button", { name: /自动排程/ }));
    const dialog = await screen.findByRole("dialog", { name: "自动排程" });
    // 打开时按推荐组合预勾；底栏取消全选后主按钮禁用并给出中性提示。
    expect(within(dialog).getByRole("checkbox", { name: /写大纲/ })).toBeChecked();
    await user.click(within(dialog).getByRole("checkbox", { name: /全选当前筛选的/ }));
    expect(within(dialog).getByRole("checkbox", { name: /写大纲/ })).not.toBeChecked();
    expect(within(dialog).getByRole("button", { name: "生成排程草案" })).toBeDisabled();
    expect(within(dialog).getByText("请先选择至少一个任务")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "恢复推荐" }));
    expect(within(dialog).getByRole("checkbox", { name: /写大纲/ })).toBeChecked();
    expect(within(dialog).getByRole("button", { name: "生成排程草案" })).toBeEnabled();
  });

  it("lists the selected items that can only be partly scheduled, with the reason", async () => {
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE), tasks: [{ id: "task-1", projectId: null, title: "写年度总结", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sessionMinutes: 240, priority: "normal", sortOrder: 0, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task" }] };
    const user = userEvent.setup();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi(initial)} />);
    await user.click(await screen.findByRole("button", { name: /自动排程/ }));
    const dialog = await screen.findByRole("dialog", { name: "自动排程" });
    // 行内结果读当前勾选：240 分钟放不进任何一段空档，只能部分安排。
    expect(within(dialog).getByText(/^\d+\/240 分钟$/)).toBeVisible();
    // 底栏那枚计数不列清单，点一下直接定位到行；原因本来就写在第二行。
    await user.click(within(dialog).getByRole("button", { name: /1 项只能部分安排/ }));
    expect(within(dialog).getByText("还差 60 分钟")).toBeVisible();
    await waitFor(() => expect(within(dialog).getByText("写年度总结").closest(".schedule-row")).toHaveClass("is-flash"));
  });

  it("arranges a whole project from its card with only that project's candidates", async () => {
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "Alpha", deadlineLocal: null }, { id: "project-2", title: "Beta", deadlineLocal: null }],
      tasks: [
        { id: "task-a", projectId: "project-1", title: "写大纲", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sessionMinutes: 30, priority: "normal", sortOrder: 0, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task" },
        { id: "task-b", projectId: "project-2", title: "别处的任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sessionMinutes: 30, priority: "normal", sortOrder: 1, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task" },
      ],
    };
    const native = createNativeApi(initial);
    const user = userEvent.setup();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "项目" }));
    await user.click(await screen.findByRole("button", { name: "安排项目 Alpha" }));
    const dialog = await screen.findByRole("dialog", { name: "自动排程" });
    expect(within(dialog).getByText("写大纲")).toBeVisible();
    expect(within(dialog).queryByText("别处的任务")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "生成排程草案" }));
    await user.click(screen.getByRole("button", { name: /^应用 \d+ 个时段$/ }));
    await waitFor(() => expect(native.applyScheduleDraft).toHaveBeenCalledOnce());
    expect((native.applyScheduleDraft as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual([expect.objectContaining({ taskId: "task-a" })]);
  });

  it("removes a single draft card and applies only the remaining sessions", async () => {
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE), tasks: [
      { id: "task-a", projectId: null, title: "写大纲", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sessionMinutes: 30, priority: "normal", sortOrder: 0, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task" },
      { id: "task-b", projectId: null, title: "整理资料", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sessionMinutes: 30, priority: "normal", sortOrder: 1, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task" },
    ] };
    const native = createNativeApi(initial);
    const user = userEvent.setup();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: /自动排程/ }));
    await user.click(screen.getByRole("button", { name: "生成排程草案" }));
    expect(screen.getByRole("button", { name: /^应用 2 个时段$/ })).toBeVisible();
    // 移除一张卡 = 取消该键勾选，留在预览步；容量与主按钮同步减一。
    await user.click(screen.getByRole("button", { name: "移除 整理资料" }));
    expect(screen.getByRole("button", { name: /^应用 1 个时段$/ })).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^应用 1 个时段$/ }));
    await waitFor(() => expect(native.applyScheduleDraft).toHaveBeenCalledOnce());
    expect((native.applyScheduleDraft as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual([expect.objectContaining({ taskId: "task-a" })]);
  });

  it("keeps one project open at a time in the task pool", async () => {
    const user = userEvent.setup();
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [
        { id: "project-1", title: "四级英语单词", deadlineLocal: null },
        { id: "project-2", title: "写作练习", deadlineLocal: null },
      ],
      tasks: [
        { id: "task-a", projectId: "project-1", title: "使用说明", progress: 100, status: "active", deadlineLocal: null, estimatedMinutes: null, sortOrder: 0, kind: "task" },
        { id: "task-b", projectId: "project-1", title: "视频配套书籍在哪？", progress: 50, status: "active", deadlineLocal: null, estimatedMinutes: null, sortOrder: 1, kind: "task" },
        { id: "task-c", projectId: "project-1", title: "Unit1 Lesson 1", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sortOrder: 2, kind: "task" },
        { id: "task-d", projectId: "project-2", title: "每日一句", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sortOrder: 3, kind: "task" },
      ],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    const first = await screen.findByRole("button", { name: /四级英语单词/ });
    const second = screen.getByRole("button", { name: /写作练习/ });
    // 默认展开第一个小项目，其他项目只显示总览行。
    expect(first).toHaveAttribute("aria-expanded", "true");
    expect(first).toHaveTextContent("3 项");
    expect(second).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("视频配套书籍在哪？")).toBeVisible();
    expect(screen.getByText("使用说明")).toBeVisible();
    expect(screen.getByText("Unit1 Lesson 1")).toBeVisible();
    expect(screen.queryByText("每日一句")).not.toBeInTheDocument();
    // 切换项目：前一个收起，新一个展开。
    await user.click(second);
    expect(second).toHaveAttribute("aria-expanded", "true");
    expect(first).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("视频配套书籍在哪？")).not.toBeInTheDocument();
    expect(screen.getByText("每日一句")).toBeVisible();
    // 再点一次回到项目总览。
    await user.click(second);
    expect(second).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("每日一句")).not.toBeInTheDocument();
  });

  it("keeps a large project folded until the user opens it", async () => {
    const user = userEvent.setup();
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-big", title: "大项目", deadlineLocal: null }],
      tasks: Array.from({ length: 7 }, (_, index) => ({
        id: `big-${index}`, projectId: "project-big", title: `大项目任务 ${index + 1}`, progress: 0, status: "active" as const,
        deadlineLocal: null, estimatedMinutes: null, sortOrder: index, kind: "task" as const,
      })),
    };
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi(initial)} />);
    const header = await screen.findByRole("button", { name: /大项目/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("大项目任务 1")).not.toBeInTheDocument();
    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("大项目任务 1")).toBeVisible();
  });

  it("updates task progress from the compact pool row", async () => {
    const user = userEvent.setup();
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-progress", projectId: null, title: "推进任务", progress: 10, status: "active", deadlineLocal: null, estimatedMinutes: null, sortOrder: 0, kind: "task" }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "调整进度 推进任务，当前 10%" }));
    const dialog = await screen.findByRole("dialog", { name: "调整进度 推进任务" });
    // 任务名只在无障碍名里，气泡本身不重复。
    expect(within(dialog).queryByText("推进任务")).toBeNull();

    const slider = within(dialog).getByRole("slider", { name: "推进任务 完成度" });
    expect(slider).toHaveFocus();
    fireEvent.change(slider, { target: { value: "60" } });
    fireEvent.keyUp(slider);
    await waitFor(() => expect(native.applyProgress).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-progress", toProgress: 60 })));

    // 常用值直接写库，气泡保持打开以便连续调整。
    await user.click(within(dialog).getByRole("button", { name: "25%" }));
    await waitFor(() => expect(native.applyProgress).toHaveBeenCalledWith(expect.objectContaining({ toProgress: 25 })));
    expect(dialog).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: "标记 推进任务 已完成" }));
    await waitFor(() => expect(native.applyProgress).toHaveBeenCalledWith(expect.objectContaining({ toProgress: 100 })));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "调整进度 推进任务" })).toBeNull());
  });

  it("filters the task pool from the overflow menu", async () => {
    const user = userEvent.setup();
    const tomorrow = isoDaysFromNow(1);
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [
        { id: "task-scheduled", projectId: null, title: "已排任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sortOrder: 0, kind: "task" },
        { id: "task-open", projectId: null, title: "未排任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sortOrder: 1, kind: "task" },
      ],
      executionSessions: [{ id: "session-1", taskId: "task-scheduled", localDate: tomorrow, endLocalDate: tomorrow, startLocal: "09:00", endLocal: "10:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
    };
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi(initial)} />);
    expect(await screen.findByText("已排任务")).toBeVisible();
    expect(screen.getByText("未排任务")).toBeVisible();

    // 筛选就在「需要关注」下面那一行，点完立刻生效；不再有 ⋯ 菜单这层中转。
    const filterGroup = screen.getByRole("group", { name: "任务池筛选" });
    await user.click(within(filterGroup).getByRole("button", { name: "未安排" }));
    expect(screen.queryByText("已排任务")).not.toBeInTheDocument();
    expect(screen.getByText("未排任务")).toBeVisible();
    expect(within(filterGroup).getByRole("button", { name: "未安排" })).toHaveAttribute("aria-pressed", "true");

    await user.click(within(filterGroup).getByRole("button", { name: "全部" }));
    expect(screen.getByText("已排任务")).toBeVisible();
    expect(screen.getByText("未排任务")).toBeVisible();
  });

  it("closes the task editor on an outside click without toggling the project group", async () => {
    const user = userEvent.setup();
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "四级英语单词", deadlineLocal: null }],
      tasks: [
        { id: "task-a", projectId: "project-1", title: "使用说明", progress: 100, status: "active", deadlineLocal: null, estimatedMinutes: null, sortOrder: 0, kind: "task" },
        { id: "task-b", projectId: "project-1", title: "视频配套书籍在哪？", progress: 50, status: "active", deadlineLocal: null, estimatedMinutes: null, sortOrder: 1, kind: "task" },
      ],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    const editButton = await screen.findByRole("button", { name: "编辑任务 视频配套书籍在哪？" });
    await user.click(editButton);
    expect(document.querySelector(".task-editor-fields")).not.toBeNull();
    // 点气泡外面的折叠 header：只关气泡，不切换 header 折叠状态。
    // 编辑气泡是模态：背景整块 inert，真实浏览器里点背景不会触发折叠。
    expect(document.querySelector(".app-shell")).toHaveAttribute("inert");
    await user.click(screen.getByRole("button", { name: /四级英语单词/ }));
    await waitFor(() => expect(document.querySelector(".task-editor-fields")).toBeNull());
    expect(document.querySelector(".app-shell")).not.toHaveAttribute("inert");
    expect(native.updateTask).not.toHaveBeenCalled();
  });

  it("updates a project task progress from the inline slider and keeps the precise bubble", async () => {
    const user = userEvent.setup();
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "四级冲刺", deadlineLocal: null }],
      tasks: [{ id: "task-watch", projectId: "project-1", title: "使用说明", progress: 10, status: "active", deadlineLocal: null, estimatedMinutes: null, sortOrder: 0, kind: "task" }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "项目" }));
    await openProject(user, "四级冲刺");

    const slider = screen.getByRole("slider", { name: "使用说明 完成度" });
    fireEvent.change(slider, { target: { value: "55" } });
    fireEvent.keyUp(slider);
    await waitFor(() => expect(native.applyProgress).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-watch", toProgress: 55 })));

    // 百分比仍是打开精确编辑气泡的入口，完成按钮不丢。
    await user.click(screen.getByRole("button", { name: "调整进度 使用说明" }));
    expect(screen.getByRole("button", { name: "标记 使用说明 已完成" })).toBeVisible();
  });

  it("filters unfinished tasks with a chip and keeps the recent jump in the detail footer", async () => {
    const user = userEvent.setup();
    const occurred = new Date();
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "Alpha", deadlineLocal: null }],
      tasks: [
        { id: "task-1", projectId: "project-1", title: "已完成任务", progress: 100, status: "completed", deadlineLocal: null, estimatedMinutes: null, sortOrder: 0, kind: "task" },
        { id: "task-2", projectId: "project-1", title: "未完成任务", progress: 20, status: "active", deadlineLocal: null, estimatedMinutes: null, sortOrder: 1, kind: "task" },
      ],
      progressEvents: [{ id: "event-1", taskId: "task-1", fromProgress: 50, toProgress: 100, occurredAtUtc: occurred.toISOString() }],
    };
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi(initial)} />);
    await user.click(await screen.findByRole("button", { name: "项目" }));
    await openProject(user, "Alpha");

    const filter = screen.getByRole("button", { name: "只看未完成" });
    expect(filter).toHaveAttribute("aria-pressed", "false");
    expect(document.querySelector(".project-detail-section-head .switch")).toBeNull();
    expect(screen.getByRole("button", { name: "编辑任务 已完成任务" })).toBeInTheDocument();

    await user.click(filter);
    expect(screen.getByRole("button", { name: "只看未完成" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "编辑任务 已完成任务" })).toBeNull();
    expect(screen.getByRole("button", { name: "编辑任务 未完成任务" })).toBeInTheDocument();

    // 最近推进是详情级动作，放在固定底栏；它不属于任务区头部。
    const recentJump = screen.getByRole("button", { name: "跳转最近推进" });
    expect(document.querySelector(".project-detail-foot")).toContainElement(recentJump);
    expect(document.querySelector(".project-detail-section-head")).not.toContainElement(recentJump);

    // 最近推进的任务被“只看未完成”藏起来时，点击跳转先恢复列表。
    await user.click(recentJump);
    await waitFor(() => expect(screen.getByRole("button", { name: "编辑任务 已完成任务" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "只看未完成" })).toHaveAttribute("aria-pressed", "false");
  });

  it("marks a project task complete in one click from the project card", async () => {
    const user = userEvent.setup();
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "四级冲刺", deadlineLocal: "2026-09-15" }],
      tasks: [{ id: "task-watch", projectId: "project-1", title: "使用说明", progress: 10, status: "active", deadlineLocal: null, estimatedMinutes: null, sortOrder: 0, kind: "task" }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "项目" }));
    await openProject(user, "四级冲刺");
    await user.click(screen.getByRole("button", { name: "调整进度 使用说明" }));
    const completeButton = screen.getByRole("button", { name: "标记 使用说明 已完成" });
    await user.click(completeButton);
    await waitFor(() => expect(native.applyProgress).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-watch", toProgress: 100 })));
    expect(within(document.getElementById("project-detail")!).getAllByText("100%").length).toBeGreaterThan(0);
  });

  it("opens the project detail as a right drawer and closes it from the scrim or Escape", async () => {
    const user = userEvent.setup();
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "Alpha", deadlineLocal: null }],
      tasks: [{ id: "task-1", projectId: "project-1", title: "写大纲", progress: 20, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0, kind: "task" }],
    };
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi(initial)} />);
    await user.click(await screen.findByRole("button", { name: "项目" }));
    await user.click(await screen.findByRole("button", { name: "打开项目 Alpha" }));
    expect(document.getElementById("project-detail")).not.toBeNull();
    expect(screen.getByRole("button", { name: "关闭项目详情" })).toBeVisible();
    // 抽屉是模态：背后的列表 inert，焦点落在详情标题上。
    expect(document.querySelector(".project-list")).toHaveAttribute("inert");
    await user.click(screen.getByRole("button", { name: "关闭项目详情遮罩" }));
    await waitFor(() => expect(document.getElementById("project-detail")).toBeNull());
    expect(screen.getByRole("button", { name: "打开项目 Alpha" })).toHaveFocus();
    // 再开一次，Esc 也能关。
    await user.click(screen.getByRole("button", { name: "打开项目 Alpha" }));
    expect(document.getElementById("project-detail")).not.toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.getElementById("project-detail")).toBeNull());
  });
});

it("keeps a failed habit draft and prevents duplicate submission while saving", async () => {
  const user = userEvent.setup();
  let rejectSave!: (reason: Error) => void;
  const createRecurringHabit = vi.fn(() => new Promise<WorkspaceSnapshot>((_resolve, reject) => { rejectSave = reject; }));
  render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi(structuredClone(EMPTY_WORKSPACE), { createRecurringHabit })} />);
  await user.click(await screen.findByRole("button", { name: "新建重复习惯" }));
  const dialog = screen.getByRole("dialog", { name: "新建重复习惯" });
  await user.type(within(dialog).getByLabelText("习惯名称"), "每天阅读");
  const save = within(dialog).getByRole("button", { name: "创建习惯" });
  // 表单可保存性依赖草稿状态；机器忙时它比 user.type 晚一拍落地，直接点会落在禁用态上。
  await waitFor(() => expect(save).toBeEnabled());
  await user.click(save); await user.click(save);
  expect(createRecurringHabit).toHaveBeenCalledTimes(1);
  expect(within(dialog).getByRole("button", { name: "取消" })).toBeDisabled();
  await user.keyboard("{Escape}"); expect(dialog).toBeInTheDocument();
  await act(async () => rejectSave(new Error("写入失败")));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("写入失败");
  expect(within(dialog).getByLabelText("习惯名称")).toHaveValue("每天阅读");
  expect(save).toBeEnabled();
});

it("submits a project import once and keeps the draft when the write fails", async () => {
  const user = userEvent.setup();
  let rejectSave!: (reason: Error) => void;
  const createProjectWithTasks = vi.fn(() => new Promise<WorkspaceSnapshot>((_resolve, reject) => { rejectSave = reject; }));
  render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi(structuredClone(EMPTY_WORKSPACE), { createProjectWithTasks })} />);
  await user.click(await screen.findByRole("button", { name: "项目" }));
  await user.click(screen.getByRole("button", { name: "新建项目" }));
  const dialog = screen.getByRole("dialog", { name: "创建项目" });
  await user.type(within(dialog).getByLabelText("项目标题"), "慢请求项目");
  const save = within(dialog).getByRole("button", { name: "创建" });

  // 连点只发一次请求，且提交期间取消被禁用（Esc 由浮层宿主拦住，另有专门用例）。
  await user.click(save); await user.click(save);
  expect(createProjectWithTasks).toHaveBeenCalledTimes(1);
  expect(within(dialog).getByRole("button", { name: "取消" })).toBeDisabled();

  await act(async () => rejectSave(new Error("写入失败")));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("写入失败");
  expect(within(dialog).getByLabelText("项目标题")).toHaveValue("慢请求项目");
  expect(save).toBeEnabled();
});

it("keeps each import mode's draft after cancelling the panel", async () => {
  const user = userEvent.setup();
  render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi()} />);
  await user.click(await screen.findByRole("button", { name: "项目" }));

  await openImportMenu(user);
  await user.click(screen.getByRole("button", { name: "文本课程" }));
  await user.type(within(screen.getByRole("dialog")).getByLabelText("粘贴分集文本"), "P1 独立草稿 12:30");
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));

  // 另一种模式不能带上一种模式的草稿。
  await openImportMenu(user);
  await user.click(screen.getByRole("button", { name: "B 站链接 Beta" }));
  expect(within(screen.getByRole("dialog")).getByLabelText("B 站普通视频链接")).toHaveValue("");
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));

  // 取消保留草稿 —— 规格 §4.1 的显式例外。
  await openImportMenu(user);
  await user.click(screen.getByRole("button", { name: "文本课程" }));
  expect(within(screen.getByRole("dialog")).getByLabelText("粘贴分集文本")).toHaveValue("P1 独立草稿 12:30");
});

// ---------------------------------------------------------------------------
// 阶段 4 P4-04：日历滚动仲裁与逻辑浏览位置（内存版）
// ---------------------------------------------------------------------------

function fakeRect(top: number, height: number, width = 400) {
  return { top, left: 0, bottom: top + height, right: width, width, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

/** 给日视图的连续轴装上可预测布局：轨道屏幕位置随 `scrollTop` 变化。 */
function stubDayAxisLayout(axis: HTMLElement, viewportTop = 100, viewportHeight = 600) {
  let scrollTop = 0;
  Object.defineProperty(axis, "clientHeight", { configurable: true, get: () => viewportHeight });
  Object.defineProperty(axis, "clientTop", { configurable: true, get: () => 0 });
  Object.defineProperty(axis, "scrollTop", { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; } });
  vi.spyOn(axis, "getBoundingClientRect").mockImplementation(() => fakeRect(viewportTop, viewportHeight));
  let panelTop = 0;
  Array.from(axis.querySelectorAll<HTMLElement>(".continuous-day-panel")).forEach((panel) => {
    const band = panel.querySelector<HTMLElement>(".calendar-day-band");
    // 闭包按引用读 `panelTop`，循环结束后所有轨道都会落到同一个偏移；
    // 每个元素必须各自捕获自己的起点。
    const bandTop = panelTop;
    if (band) vi.spyOn(band, "getBoundingClientRect").mockImplementation(() => fakeRect(viewportTop + bandTop - scrollTop, 44));
    panelTop += 44;
    const track = panel.querySelector<HTMLElement>(".day-track");
    if (track) {
      // 这套用例验证的是滚动仲裁与位置恢复，不是折叠映射；移除分段让采样按线性 24 小时走，
      // 折叠条的映射由 calendarTimeline.test.ts 与 M4 覆盖。
      track.querySelectorAll(".timeline-map-segment").forEach((segment) => segment.remove());
      const trackTop = panelTop;
      vi.spyOn(track, "getBoundingClientRect").mockImplementation(() => fakeRect(viewportTop + trackTop - scrollTop, 1152));
      panelTop += 1152;
    }
    panelTop += 2;
  });
  return { read: () => scrollTop };
}

class ImmediateResizeObserver {
  constructor(private readonly callback: () => void) { /* 只需让恢复在尺寸变化时再推一次 */ }
  observe() { this.callback(); }
  disconnect() { /* no-op */ }
}

/** 由测试显式触发的 ResizeObserver：让「等可测量布局」这条路径可控。 */
class TriggerableResizeObserver {
  static instances: TriggerableResizeObserver[] = [];
  constructor(private readonly callback: () => void) { TriggerableResizeObserver.instances.push(this); }
  observe() { /* 由测试触发 */ }
  disconnect() { TriggerableResizeObserver.instances = TriggerableResizeObserver.instances.filter((item) => item !== this); }
  trigger() { this.callback(); }
}

function fireResize() { for (const instance of [...TriggerableResizeObserver.instances]) instance.trigger(); }

describe("phase 4 P4-04 calendar viewport arbitration", () => {
  beforeEach(() => { resetCalendarPositions(); });

  it("marks folded timeline segments so the sampled minute stays stable", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T08:00:00+08:00"));
    const backend = new MemorySettingsBackend();
    backend.value = {
      ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day", calendarDayMode: "defaultSlots",
      calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, day: "2026-08-05" },
      defaultTimeSlots: [{ id: "evening", label: "晚间专注", start: "19:00", end: "22:00", weekdays: [3] }],
    };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    try {
      await screen.findByRole("button", { name: "可用时间" });
      const segments = Array.from(document.querySelectorAll<HTMLElement>('.continuous-day-panel[data-calendar-date="2026-08-05"] .timeline-map-segment'));
      expect(segments.length).toBeGreaterThan(0);
      // 折叠条必须自报折叠，否则采样会按像素内插，1px 滚动就能把分钟甩出几小时。
      expect(segments.some((segment) => segment.dataset.collapsed === "true")).toBe(true);
      expect(segments.some((segment) => segment.dataset.collapsed === "false")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the app's own programmatic positioning out of preferences", async () => {
    TriggerableResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", TriggerableResizeObserver);
    try {
      const backend = new MemorySettingsBackend();
      backend.value = {
        ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day",
        calendarAnchors: { day: "2026-08-05", week: "2026-08-05", month: "2026-08-05" },
      };
      render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
      await screen.findByRole("button", { name: "日" });
      const axis = document.querySelector<HTMLElement>(".continuous-day-axis")!;
      const layout = stubDayAxisLayout(axis);
      // 进入日视图的首次定位（非今天 → 该日首个可用时间窗口 19:00）是一次程序性滚动。
      act(() => { fireResize(); });
      await waitFor(() => expect(layout.read()).toBeGreaterThan(0));
      act(() => { axis.dispatchEvent(new Event("scroll")); });
      await new Promise((resolve) => setTimeout(resolve, 360));

      // 内存位置会被程序性滚动刷新（它记录的就是视图实际所在的位置）……
      expect(readCalendarPositions().day?.date).toBe("2026-08-05");
      expect(readCalendarPositions().day?.minute).toBeCloseTo(1140, 3);
      // ……但偏好里不出现任何浏览位置。
      expect((backend.value as AppSettings).calendarPositions).toEqual({ day: null, week: null });
    } finally {
      vi.unstubAllGlobals();
      TriggerableResizeObserver.instances = [];
      resetCalendarPositions();
    }
  });

  it("writes a user-scrolled browsing position into preferences and restores it on the next launch", async () => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
    try {
      const backend = new MemorySettingsBackend();
      backend.value = {
        ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day",
        calendarAnchors: { day: "2026-08-05", week: "2026-08-05", month: "2026-08-05" },
      };
      const first = render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
      await screen.findByRole("button", { name: "日" });
      const axis = document.querySelector<HTMLElement>(".continuous-day-axis")!;
      stubDayAxisLayout(axis);
      act(() => { axis.scrollTop = 366; axis.dispatchEvent(new Event("scroll")); });
      // 固定等 360ms 在机器忙时会读到还没落库的偏好；等条件成立再断言，断言值不变。
      await waitFor(() => expect((backend.value as AppSettings).calendarPositions.day).not.toBeNull());

      // 用户滚动停止 300ms 后的采样值经同一条顺序写入落到偏好里。
      expect((backend.value as AppSettings).calendarPositions.day).toEqual({ date: "2026-08-05", minute: 720, viewportRatio: 0.5 });

      // 模拟退出重开：内存清空，只有偏好留下。
      first.unmount();
      resetCalendarPositions();
      render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
      await screen.findByRole("button", { name: "日" });
      const restored = stubDayAxisLayout(document.querySelector<HTMLElement>(".continuous-day-axis")!);
      await waitFor(() => expect(restored.read()).toBeCloseTo(366, 0));
    } finally {
      vi.unstubAllGlobals();
      resetCalendarPositions();
    }
  });

  it("aligns the in-memory browsing position with a coordinated restore instead of the pre-restore value", async () => {
    try {
      const backend = new MemorySettingsBackend();
      backend.value = {
        ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day",
        calendarAnchors: { day: "2026-08-05", week: "2026-08-05", month: "2026-08-05" },
      };
      const first = render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
      await screen.findByRole("button", { name: "日" });
      stubDayAxisLayout(document.querySelector<HTMLElement>(".continuous-day-axis")!);
      const axis = document.querySelector<HTMLElement>(".continuous-day-axis")!;
      act(() => { axis.scrollTop = 366; axis.dispatchEvent(new Event("scroll")); });
      await waitFor(() => expect(readCalendarPositions().day).not.toBeNull(), { timeout: 3000 });
      expect(readCalendarPositions().day?.minute).toBe(720);
      first.unmount();

      // 协调恢复把 Tauri Store 里的偏好换成备份快照；不 reload 也要让内存跟着换，
      // 不能残留恢复前的位置（App 载入时用偏好播种内存）。
      backend.value = {
        ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day",
        calendarAnchors: { day: "2026-08-06", week: "2026-08-06", month: "2026-08-06" },
        calendarPositions: { day: { date: "2026-08-06", minute: 300, viewportRatio: 0.25 }, week: null },
      };
      render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
      await screen.findByRole("button", { name: "日" });
      await waitFor(() => expect(readCalendarPositions().day).toEqual({ date: "2026-08-06", minute: 300, viewportRatio: 0.25 }), { timeout: 3000 });
    } finally {
      resetCalendarPositions();
    }
  });

  it("restores the day browsing position after a round trip through the week view", async () => {
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);
    try {
      const user = userEvent.setup();
      const backend = new MemorySettingsBackend();
      backend.value = {
        ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day",
        calendarAnchors: { day: "2026-08-05", week: "2026-08-05", month: "2026-08-05" },
      };
      render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
      await screen.findByRole("button", { name: "日" });
      const axis = document.querySelector<HTMLElement>(".continuous-day-axis")!;
      const layout = stubDayAxisLayout(axis);
      act(() => { axis.scrollTop = 500; axis.dispatchEvent(new Event("scroll")); });
      // 落定防抖 300ms + 采样是异步的：固定等 360ms 在机器忙时还没跑完，`day` 仍是 null，
      // 重负载下会随机红（单独跑与重跑都过）。等条件成立再读，断言值不变。
      await waitFor(() => expect(readCalendarPositions().day).not.toBeNull(), { timeout: 3000 });
      const remembered = readCalendarPositions().day;
      expect(remembered?.minute).toBeCloseTo((500 + 300 - 90) / 1152 * 1440, 3);

      await user.click(screen.getByRole("button", { name: "周" }));
      await user.click(screen.getByRole("button", { name: "日" }));
      const restoredAxis = document.querySelector<HTMLElement>(".continuous-day-axis")!;
      const restored = stubDayAxisLayout(restoredAxis);
      // 没有记忆时这里会落到「首次定位」（今天→现在），恢复记忆后必须回到用户离开的位置。
      await waitFor(() => expect(restored.read()).toBeCloseTo(500, 0));
    } finally {
      vi.unstubAllGlobals();
      resetCalendarPositions();
    }
  });
});

/**
 * 阶段 4 P4-06 / M10：截止事项页、导航入口与 PageId 三处一致。
 *
 * 三处合法值来源：`settings.ts` 的 `PageId`（由 `PAGE_IDS` 派生）、`normalizeSettings`
 * 的 `lastPage` 白名单（直接读 `PAGE_IDS`）、以及 `App.tsx` 的导航表。前两处由
 * `settings.test.ts` 覆盖，这里逐项证明**导航表**也完整：入口点得到、落库不被静默
 * 回退、重启后仍停在原页。
 */
describe("phase 4 P4-06 deadline view", () => {
  const NAVIGATION: Array<[PageId, string, string | RegExp]> = [
    ["today", "今日", /\d+月\d+日 星期/],
    ["calendar", "日历", "8月3日 — 8月9日"],
    ["deadlines", "截止", "截止事项"],
    ["projects", "项目", "项目"],
    ["review", "回顾", "8月3日 — 8月9日"],
    ["data", "数据", "数据与安全"],
    ["appearance", "设置", "设置"],
  ];

  function deadlineScenario(): WorkspaceSnapshot {
    return {
      ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "p-1", title: "学习项目", deadlineLocal: "2026-08-20" }],
      projectMilestones: [{ id: "m-1", projectId: "p-1", title: "第一阶段", targetLocalDate: "2026-08-04", sortOrder: 0, criterionKind: "taskCount", targetTaskId: null, targetCount: 2, targetProgress: null }],
      milestoneOutcomes: [{ id: "o-1", milestoneId: "m-1", projectId: "p-1", title: "第一阶段", targetLocalDate: "2026-08-04", reached: false, resultText: "完成 0/2，未达成", frozenAtUtc: "2026-08-05T00:00:00Z" }],
      tasks: [
        { id: "t-alpha", projectId: null, title: "Alpha 任务", progress: 0, status: "active", deadlineLocal: "2026-08-05", estimatedMinutes: 60, sessionMinutes: 60, priority: "normal", sortOrder: 0, kind: "task" },
        { id: "t-beta", projectId: "p-1", title: "Beta 任务", progress: 0, status: "active", deadlineLocal: "2026-08-06", estimatedMinutes: 60, priority: "normal", sortOrder: 1, kind: "task" },
      ],
    };
  }

  function openDeadlines(backend: MemorySettingsBackend, native = createNativeApi(deadlineScenario())) {
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "deadlines" };
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    return native;
  }

  const deadlineRows = () => Array.from(document.querySelectorAll("[data-deadline-key]")).map((row) => row.getAttribute("data-deadline-key"));

  it("keeps every navigation entry reachable, legal and restorable", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const backend = new MemorySettingsBackend();
    const native = createNativeApi();
    const first = render(<App settings={new SettingsRepository(backend)} native={native} />);
    try {
      // 导航表必须覆盖每一个合法页面 ID，否则会出现点不到或点了被回退的入口。
      expect(NAVIGATION.map(([id]) => id)).toEqual([...PAGE_IDS]);
      const navigation = await screen.findByRole("navigation", { name: "主导航" });
      for (const [id, label, heading] of NAVIGATION) {
        await user.click(within(navigation).getByRole("button", { name: label }));
        expect(await screen.findByRole("heading", { name: heading, level: 1 })).toBeVisible();
        expect(backend.value).toMatchObject({ lastPage: id });
      }
      first.unmount();
      // 重启后停在最后访问的页面；这里换成新增的截止页再验一次。
      await new SettingsRepository(backend).save({ ...DEFAULT_SETTINGS, lastPage: "deadlines" });
      render(<App settings={new SettingsRepository(backend)} native={native} />);
      expect(await screen.findByRole("heading", { name: "截止事项", level: 1 })).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the deadline filter and focus across a same-session round trip but not across a restart", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const backend = new MemorySettingsBackend();
    const native = createNativeApi(deadlineScenario());
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "deadlines" };
    const first = render(<App settings={new SettingsRepository(backend)} native={native} />);
    try {
      await screen.findByRole("heading", { name: "截止事项", level: 1 });
      // 排序是日期升序 → 类型（任务／项目／里程碑）→ sortOrder → 稳定 ID。
      expect(deadlineRows()).toEqual(["milestone:m-1", "task:t-alpha", "task:t-beta", "project:p-1"]);

      // 关掉「任务」类型：这是本轮要跨页保留的筛选。
      await user.click(screen.getByRole("button", { name: "任务" }));
      expect(deadlineRows()).toEqual(["milestone:m-1", "project:p-1"]);

      await user.click(screen.getByRole("button", { name: /^定位项目/ }));
      expect(await screen.findByRole("heading", { name: "项目", level: 1 })).toBeVisible();

      await user.click(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: "截止" }));
      await screen.findByRole("heading", { name: "截止事项", level: 1 });
      expect(screen.getByRole("button", { name: "任务" })).toHaveAttribute("aria-pressed", "false");
      expect(deadlineRows()).toEqual(["milestone:m-1", "project:p-1"]);
      expect(document.activeElement).toBe(document.querySelector('[data-deadline-key="project:p-1"]'));

      // 重启不恢复：筛选与焦点只活在 App 层内存里。
      first.unmount();
      render(<App settings={new SettingsRepository(backend)} native={native} />);
      await screen.findByRole("heading", { name: "截止事项", level: 1 });
      expect(screen.getByRole("button", { name: "任务" })).toHaveAttribute("aria-pressed", "true");
      expect(deadlineRows()).toEqual(["milestone:m-1", "task:t-alpha", "task:t-beta", "project:p-1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("previews the schedule draft from the deadline row before writing any session", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const backend = new MemorySettingsBackend();
    const native = openDeadlines(backend);
    try {
      await screen.findByRole("heading", { name: "截止事项", level: 1 });
      await user.click(screen.getByRole("button", { name: /^安排任务 Alpha 任务/ }));

      const candidates = await screen.findByRole("dialog", { name: "自动排程" });
      // 预选只影响候选勾选，不会写任何执行时段。
      expect(vi.mocked(native.applyScheduleDraft)).not.toHaveBeenCalled();
      await user.click(within(candidates).getByRole("button", { name: "生成排程草案" }));

      const preview = await screen.findByRole("dialog", { name: "排程草案" });
      expect(vi.mocked(native.applyScheduleDraft)).not.toHaveBeenCalled();
      await user.click(within(preview).getByRole("button", { name: /^应用 \d+ 个时段$/ }));
      await waitFor(() => expect(vi.mocked(native.applyScheduleDraft)).toHaveBeenCalledTimes(1));
      expect(vi.mocked(native.applyScheduleDraft).mock.calls[0][0]).toHaveLength(1);
      expect(vi.mocked(native.applyScheduleDraft).mock.calls[0][0][0]).toMatchObject({ taskId: "t-alpha" });
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * 阶段 4 P4-08 / AC13：回顾页的周期偏好与下钻状态。
 *
 * 周期与锚点是**偏好**（写进 SettingsRepository，跨重启保留）；项目筛选与明细选择只活在
 * App 层内存里（同会话跨页返回有效，重启不恢复）—— 与 P4-06 截止页同一套归属规则。
 */
describe("phase 4 P4-08 review periods and drill-down", () => {
  function reviewScenario(): WorkspaceSnapshot {
    return {
      ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "p-1", title: "学习项目", deadlineLocal: null }],
      tasks: [
        { id: "t-alpha", projectId: "p-1", title: "Alpha 任务", progress: 60, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0, kind: "task" },
        { id: "t-beta", projectId: null, title: "Beta 任务", progress: 20, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 1, kind: "task" },
      ],
      progressEvents: [{ id: "e-1", taskId: "t-alpha", fromProgress: 40, toProgress: 60, occurredAtUtc: new Date(2026, 7, 4, 9, 0).toISOString() }],
      executionRecords: [{ id: "r-1", sessionId: null, taskId: "t-alpha", actualStartUtc: new Date(2026, 7, 4, 20, 0).toISOString(), actualEndUtc: new Date(2026, 7, 4, 21, 0).toISOString(), note: "第一段" }],
    };
  }

  it("writes the review period and anchor through the settings repository and restores them after a restart", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "review" };
    const first = render(<App settings={new SettingsRepository(backend)} native={createNativeApi(reviewScenario())} />);
    try {
      // 锚点为 null 时按「当前周期」计算：默认停在当前周。
      expect(await screen.findByRole("heading", { name: "8月3日 — 8月9日", level: 1 })).toBeVisible();

      await user.click(screen.getByRole("button", { name: "月" }));
      // 不再用左右箭头：点「选择日期」在日历里跳到上个月。
      await user.click(screen.getByRole("button", { name: "选择日期" }));
      await user.click(within(document.querySelector<HTMLElement>(".review-picker")!).getByRole("button", { name: "7 月" }));
      await waitFor(() => expect(backend.value).toMatchObject({ reviewPeriod: "month", reviewAnchorDate: "2026-07-01" }));
      expect(screen.getByRole("heading", { name: "2026年7月", level: 1 })).toBeVisible();

      first.unmount();
      render(<App settings={new SettingsRepository(backend)} native={createNativeApi(reviewScenario())} />);
      expect(await screen.findByRole("heading", { name: "2026年7月", level: 1 })).toBeVisible();
      expect(screen.getByRole("button", { name: "月" })).toHaveAttribute("aria-pressed", "true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the project scope across a same-session round trip and drops the detail bubble on navigation", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "review" };
    const native = createNativeApi(reviewScenario());
    const first = render(<App settings={new SettingsRepository(backend)} native={native} />);
    const navigation = () => within(screen.getByRole("navigation", { name: "主导航" }));
    try {
      await screen.findByRole("heading", { name: "8月3日 — 8月9日", level: 1 });
      // 项目下钻：明细区先看项目，再把它设成引擎查询的一部分。
      // 项目名下钻现在有两个入口（圆环图例、项目卡头），点卡头那一个。
      await user.click(within(document.querySelector<HTMLElement>(".review-task-group-head")!).getByRole("button", { name: "查看项目「学习项目」的明细" }));
      await user.click(within(document.querySelector<HTMLElement>(".review-detail")!).getByRole("button", { name: "只看这个项目" }));
      expect(await screen.findByText("仅统计项目：学习项目")).toBeVisible();

      // 任务下钻：明细区显示原始事件时间、进度变化与实际记录备注。
      await user.click(within(document.querySelector<HTMLElement>(".review-tasks")!).getByRole("button", { name: "查看任务「Alpha 任务」的明细" }));
      const detail = document.querySelector<HTMLElement>(".review-detail")!;
      expect(detail.textContent).toContain("40% → 60%");
      expect(detail.textContent).toContain("第一段");

      // 同会话跨页返回：项目筛选还在；明细是气泡，点别的板块（这里是主导航）就关掉了，
      // 不跟着换页 —— 气泡的意义是「看完就消失」，不是常驻的区域。
      await user.click(navigation().getByRole("button", { name: "项目" }));
      await screen.findByRole("heading", { name: "项目", level: 1 });
      expect(document.querySelector(".review-detail")).toBeNull();
      await user.click(navigation().getByRole("button", { name: "回顾" }));
      await screen.findByRole("heading", { name: "8月3日 — 8月9日", level: 1 });
      expect(screen.getByText("仅统计项目：学习项目")).toBeVisible();
      expect(document.querySelector(".review-detail")).toBeNull();

      // 重启（整页重载）后不恢复：项目筛选与明细选择只活在 App 层内存里。
      first.unmount();
      render(<App settings={new SettingsRepository(backend)} native={native} />);
      await screen.findByRole("heading", { name: "8月3日 — 8月9日", level: 1 });
      expect(screen.queryByText("仅统计项目：学习项目")).toBeNull();
      expect(document.querySelector(".review-detail")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * 规格 0007：完成记录（完成签到）。
 *
 * 这一组用例盯的是**触发口径**与**事实边界**：
 * - 只有「正常的任务、从 <100 升到 100、提交成功」才弹气泡；习惯与关闭开关都不弹；
 * - 记录只引用进度事件；撤回写一条回退事件，而不是改写上一条历史；
 * - 事后入口（今日完成行、回顾明细）永远可用，与那个开关无关。
 *
 * 一律用假时钟钉在 2026-08-05 正午：「今日完成」「完成于 …」和提示胶囊都要跟「今天」比。
 */
describe("completion records", () => {
  /** 注入的「现在」是本地墙钟 2026-08-05 12:00，夹具里的时刻同样按本地墙钟写。 */
  const at = (hour: number, minute = 0) => new Date(2026, 7, 5, hour, minute).toISOString();

  function taskFixture(patch: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
    return {
      ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "t-1", projectId: null, title: "写周报", progress: 75, status: "active", deadlineLocal: null, estimatedMinutes: 30, sortOrder: 0, kind: "task" }],
      ...patch,
    };
  }

  /** 任务池进度气泡 → 标记完成（最常用的 100% 入口）。 */
  async function markComplete(user: ReturnType<typeof userEvent.setup>, title = "写周报") {
    await user.click(await screen.findByRole("button", { name: `调整进度 ${title}，当前 75%` }));
    await user.click(screen.getByRole("button", { name: `标记 ${title} 已完成` }));
  }

  /**
   * 取出右列「今天完成」里的那一行：它是补写／编辑的事后入口。
   *
   * 2026-10-28 起完成项从时间轴卡底部的折叠区移到右列（与临期同宽），直接列出、不再折叠，
   * 所以这里不再需要先点开 summary。`user` 参数保留，调用点不受影响。
   */
  async function openTodayRow(_user: ReturnType<typeof userEvent.setup>, title = "写周报") {
    await screen.findByRole("heading", { name: "今天完成", level: 2 });
    return within(document.querySelector<HTMLElement>(".today-done")!).getByRole("button", { name: new RegExp(`^${title}`) });
  }

  const bubble = () => screen.findByRole("dialog", { name: "完成记录：写周报" });

  it("asks for a completion record right after a normal task reaches 100%", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const native = createNativeApi(taskFixture());
    try {
      render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
      await markComplete(user);

      const panel = await bubble();
      expect(within(panel).getByRole("heading", { name: "已完成" })).toBeVisible();
      // 事实行只说这次完成本身：进度跳变 + 时刻。任务名不重复，锚定行已经给了上下文。
      expect(panel.querySelector(".completion-heading")?.textContent).toContain("75% → 100%");
      expect(panel.querySelector(".completion-heading")?.textContent).toContain("今天 12:00");
      // 适应程度不预选：三档都是未按下，用户可以一个都不选就保存。
      for (const label of ["轻松", "合适", "吃力"]) {
        expect(within(panel).getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "false");
      }
      const revert = within(panel).getByRole("button", { name: /^撤回完成/ });
      expect(revert.textContent).toContain("回到 75%");
      expect(within(panel).getByRole("button", { name: "保存记录" })).toBeVisible();
      // 采集与查看分离：气泡里没有放大入口。
      expect(within(panel).queryByRole("button", { name: /放大查看/ })).toBeNull();
      // 此刻只写了进度事实，记录还没落库。
      await waitFor(() => expect(native.applyProgress).toHaveBeenCalledWith(expect.objectContaining({ taskId: "t-1", toProgress: 100 })));
      expect(native.recordCompletion).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still opens 补写 from the today row when the prompt is off, and saves the draft fields", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, completionRecordPrompt: false };
    const native = createNativeApi(taskFixture());
    try {
      render(<App settings={new SettingsRepository(backend)} native={native} />);
      await markComplete(user);
      await waitFor(() => expect(native.applyProgress).toHaveBeenCalledWith(expect.objectContaining({ toProgress: 100 })));
      // 完成事实照常写入，事后入口不受开关影响。
      const row = await openTodayRow(user);
      // 右列只放任务名，事实文案（完成于 / 未填写完成记录 / 图片数）收进 title。
      expect(row.getAttribute("title")).toContain("未填写完成记录");

      await user.click(row);
      const panel = await bubble();
      expect(within(panel).getByRole("heading", { name: "已完成" })).toBeVisible();
      await user.click(within(panel).getByRole("button", { name: "合适" }));
      await user.click(within(panel).getByRole("button", { name: "感受标签" }));
      await user.click(within(panel).getByRole("button", { name: "专注" }));
      await user.type(within(panel).getByRole("textbox"), "一次写完，没有分心");
      await user.click(within(panel).getByRole("button", { name: "保存记录" }));

      await waitFor(() => expect(native.recordCompletion).toHaveBeenCalledTimes(1));
      const [record, images] = vi.mocked(native.recordCompletion).mock.calls[0];
      expect(record).toMatchObject({ taskId: "t-1", progressBefore: 75, fit: "fit", note: "一次写完，没有分心", tags: ["专注"], revertedAtUtc: null });
      expect(record.progressEventId).toBeTypeOf("string");
      // 完成时刻就是那次进度事件的时刻（本地今天），不是保存时刻。
      expect(String(record.completedAtUtc).startsWith("2026-08-05")).toBe(true);
      expect(images).toEqual([]);
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "完成记录：写周报" })).toBeNull());
      // 今天完成行只写任务名，记录内容（适应程度 / 感受标签 / 小结）收进 title。
      expect((await openTodayRow(user)).getAttribute("title")).toContain("合适");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a 补写 entry behind when the draft is abandoned", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const native = createNativeApi(taskFixture());
    try {
      render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
      await markComplete(user);
      const panel = await bubble();
      // 带草稿时误点关闭不丢内容：先要一次明确的放弃。
      await user.type(within(panel).getByRole("textbox"), "还没想好");
      await user.click(within(panel).getByRole("button", { name: "关闭完成记录" }));
      expect(within(panel).getByRole("group", { name: "放弃确认" })).toBeVisible();
      await user.click(within(panel).getByRole("button", { name: "继续填写" }));
      expect(within(panel).getByRole("textbox")).toHaveValue("还没想好");

      await user.click(within(panel).getByRole("button", { name: "关闭完成记录" }));
      await user.click(within(panel).getByRole("button", { name: "放弃" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "完成记录：写周报" })).toBeNull());
      expect(native.recordCompletion).not.toHaveBeenCalled();
      const toast = document.querySelector<HTMLElement>(".completion-toast");
      expect(toast?.textContent).toContain("还没记录");
      // 提示胶囊是活区，动作是里面那个真按钮：点它把同一个目标重新打开。
      await user.click(within(toast!).getByRole("button", { name: "补写" }));
      expect(await bubble()).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reverts the completion through a rollback event and keeps the record content", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const native = createNativeApi(taskFixture());
    try {
      render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
      await markComplete(user);
      const panel = await bubble();
      await user.type(within(panel).getByRole("textbox"), "先记下，回头再改");
      await user.click(within(panel).getByRole("button", { name: "保存记录" }));
      await waitFor(() => expect(native.recordCompletion).toHaveBeenCalledTimes(1));
      const recordId = vi.mocked(native.recordCompletion).mock.calls[0][0].id as string;

      // 事后从「今日完成」进编辑态：标题与保存按钮都换成「修改」。
      await user.click(await openTodayRow(user));
      const editor = await bubble();
      expect(within(editor).getByRole("heading", { name: "编辑完成记录" })).toBeVisible();
      expect(within(editor).getByRole("textbox")).toHaveValue("先记下，回头再改");
      expect(within(editor).getByRole("button", { name: "保存修改" })).toBeVisible();

      await user.click(within(editor).getByRole("button", { name: /^撤回完成/ }));
      await waitFor(() => expect(native.revertCompletion).toHaveBeenCalledWith(recordId,
        expect.objectContaining({ taskId: "t-1", fromProgress: 100, toProgress: 75 })));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "完成记录：写周报" })).toBeNull());
      expect(document.querySelector(".completion-toast")?.textContent).toContain("已撤回完成，进度回到 75%");
      // 内容不删：记录仍在快照里，只是带上撤回时刻。
      await waitFor(async () => expect(await native.getWorkspace()).toMatchObject({
        completionRecords: [{ id: recordId, note: "先记下，回头再改", revertedAtUtc: "2026-08-05T12:00:00.000Z" }],
      }));
      // 任务回到 75%，「今日完成」里那一行因此消失 —— 不冒充一次完成。
      expect(screen.queryByText("今日完成 1 项")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists completion records in the review detail and zooms an image read-only", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "review" };
    const image: CompletionImage = { id: "img-1", sortOrder: 0, mime: "image/webp", width: 1600, height: 900, sizeBytes: 20_480, dataBase64: "AAECAw==", thumbBase64: "AAECAw==" };
    const native = createNativeApi(taskFixture({
      tasks: [{ id: "t-1", projectId: null, title: "写周报", progress: 100, status: "completed", deadlineLocal: null, estimatedMinutes: 30, sortOrder: 0, kind: "task" }],
      progressEvents: [{ id: "e-1", taskId: "t-1", fromProgress: 75, toProgress: 100, occurredAtUtc: at(9) }],
      completionRecords: [{ id: "c-1", taskId: "t-1", progressEventId: "e-1", completedAtUtc: at(9), progressBefore: 75, fit: "light", note: "一小时写完", tags: ["专注"], revertedAtUtc: null, imageCount: 1 }],
    }), { getCompletionImages: vi.fn(async () => [image]) });
    try {
      render(<App settings={new SettingsRepository(backend)} native={native} />);
      await screen.findByRole("heading", { name: "8月3日 — 8月9日", level: 1 });
      // 周视图的「完成感受」卡：三档分布 + 常见标签 + 口径行；它不取图片字节。
      const feeling = document.querySelector<HTMLElement>(".review-feeling");
      expect(feeling?.textContent).toContain("完成感受");
      expect(feeling?.textContent).toContain("轻松");
      expect(feeling?.textContent).toContain("1 条完成记录");
      expect(native.getCompletionImages).not.toHaveBeenCalled();

      await user.click(within(document.querySelector<HTMLElement>(".review-tasks")!).getByRole("button", { name: "查看任务「写周报」的明细" }));
      const detail = document.querySelector<HTMLElement>(".review-detail")!;
      expect(detail.textContent).toContain("一小时写完");
      expect(detail.textContent).toContain("专注");
      // 图片按需取字节：明细打开后才为这一条记录请求一次。
      const thumb = await within(detail).findByRole("button", { name: "放大查看第 1 张完成图片" });
      await waitFor(() => expect(native.getCompletionImages).toHaveBeenCalledWith("c-1"));

      await user.click(thumb);
      const viewer = await screen.findByRole("dialog", { name: "放大查看完成图片：写周报 第 1 张" });
      expect(within(viewer).getByRole("img").getAttribute("src")).toContain("data:image/webp;base64,AAECAw==");
      expect(viewer.textContent).toContain("只读查看");
      // 只读：浮层里没有任何动作按钮（另存为／编辑都不给）。
      expect(within(viewer).queryAllByRole("button")).toHaveLength(0);

      // Esc 只关最顶层：放大层收起，明细气泡还在。
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "放大查看完成图片：写周报 第 1 张" })).toBeNull());
      expect(document.querySelector(".review-detail")).not.toBeNull();
      expect(native.revertCompletion).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
