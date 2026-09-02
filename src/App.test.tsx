import axe from "axe-core";
import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import App from "./App";
import { EMPTY_WORKSPACE, type BackupInfo, type NativeApi, type WorkspaceSnapshot } from "./lib/native";
import { DEFAULT_SETTINGS, SettingsRepository, type SettingsBackend } from "./lib/settings";

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
    showReminder: vi.fn().mockResolvedValue(undefined),
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
    expect(await screen.findByRole("heading", { name: "今天从下一步开始", level: 1 })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeVisible();
    expect(screen.getByRole("complementary", { name: /任务池/ })).toBeVisible();
    const results = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations).toEqual([]);
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

  it("renders calendar hours on a dedicated vertical time axis", async () => {
    const user = userEvent.setup();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi()} />);
    await user.click(await screen.findByRole("button", { name: "日历" }));
    expect(document.querySelectorAll(".time-axis-track > span")).toHaveLength(24);
  });

  it("previews an exact dragged task before writing and lets Alt reverse snapping", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-drag", projectId: null, title: "拖拽任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    expect(await screen.findByRole("button", { name: "吸附 15 分钟" })).toHaveAttribute("aria-pressed", "true");
    const track = document.querySelector<HTMLElement>('.calendar-day[data-day-date="2026-08-05"] .day-track')!;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 1440, width: 200, height: 1440, toJSON: () => ({}) });
    const dataTransfer = { types: ["application/x-daymark-task"], dropEffect: "none", getData: (type: string) => type === "application/x-daymark-task" ? "task-drag" : "" };
    const snapped = createEvent.dragOver(track, { dataTransfer }); Object.defineProperty(snapped, "clientY", { value: 607 }); fireEvent(track, snapped);
    expect(screen.getByRole("status", { name: "拖拽排程预览" })).toHaveTextContent("松开放置");
    expect(native.createExecutionSession).not.toHaveBeenCalled();
    const free = createEvent.dragOver(track, { dataTransfer }); Object.defineProperties(free, { clientY: { value: 607 }, altKey: { value: true } }); fireEvent(track, free);
    expect(screen.getByRole("status", { name: "拖拽排程预览" })).toBeVisible();
    expect(native.createExecutionSession).not.toHaveBeenCalled();
  });

  it("previews edge insertion, shifts later sessions, and commits the whole drop once", async () => {
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
    const target = (await screen.findByText("目标任务", { selector: ".calendar-session strong" })).closest<HTMLElement>(".calendar-session")!;
    const track = target.closest<HTMLElement>(".day-track")!;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 1440, width: 200, height: 1440, toJSON: () => ({}) });
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ x: 0, y: 600, top: 600, left: 0, right: 200, bottom: 660, width: 200, height: 60, toJSON: () => ({}) });
    const dataTransfer = { types: ["application/x-daymark-task"], dropEffect: "none", getData: (type: string) => type === "application/x-daymark-task" ? "task-drag" : "" };
    const over = createEvent.dragOver(target, { dataTransfer }); Object.defineProperty(over, "clientY", { value: 605 }); fireEvent(target, over);
    expect(screen.getByRole("status", { name: "拖拽排程预览" })).toHaveTextContent("插入并后移");
    expect(screen.getByLabelText("插入位置")).toBeVisible();
    expect(native.applyExecutionSessionChanges).not.toHaveBeenCalled();
    const drop = createEvent.drop(target, { dataTransfer }); Object.defineProperty(drop, "clientY", { value: 605 }); fireEvent(target, drop);
    await waitFor(() => expect(native.applyExecutionSessionChanges).toHaveBeenCalledOnce());
    expect(native.applyExecutionSessionChanges).toHaveBeenCalledWith(expect.objectContaining({
      create: [expect.objectContaining({ taskId: "task-drag", startLocal: "10:00" })],
      update: expect.arrayContaining([expect.objectContaining({ id: "session-target", startLocal: "11:00" }), expect.objectContaining({ id: "session-next", startLocal: "12:00" })]),
    }));
  });

  it("switches a center hover to simultaneous scheduling after 500 ms", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const backend = new MemorySettingsBackend(); backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-drag", projectId: null, title: "并行任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 30, sortOrder: 0 }, { id: "task-target", projectId: null, title: "已有任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 1 }],
      executionSessions: [{ id: "session-target", taskId: "task-target", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
    };
    const native = createNativeApi(initial); render(<App settings={new SettingsRepository(backend)} native={native} />);
    try {
      const target = (await screen.findByText("已有任务", { selector: ".calendar-session strong" })).closest<HTMLElement>(".calendar-session")!; const track = target.closest<HTMLElement>(".day-track")!;
      vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 1440, width: 200, height: 1440, toJSON: () => ({}) });
      vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ x: 0, y: 600, top: 600, left: 0, right: 200, bottom: 660, width: 200, height: 60, toJSON: () => ({}) });
      const dataTransfer = { types: ["application/x-daymark-task"], dropEffect: "none", getData: (type: string) => type === "application/x-daymark-task" ? "task-drag" : "" };
      const over = createEvent.dragOver(target, { dataTransfer }); Object.defineProperty(over, "clientY", { value: 630 }); fireEvent(target, over);
      expect(screen.getByRole("status", { name: "拖拽排程预览" })).not.toHaveClass("overlap");
      act(() => vi.advanceTimersByTime(500));
      expect(screen.getByRole("status", { name: "拖拽排程预览" })).toHaveClass("overlap");
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
    await screen.findByRole("button", { name: "吸附 15 分钟" });
    const track = document.querySelector<HTMLElement>('.calendar-day[data-day-date="2026-08-05"] .day-track')!;
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 1440, width: 200, height: 1440, toJSON: () => ({}) });
    const down = createEvent.pointerDown(track, { button: 0, pointerId: 1 }); Object.defineProperty(down, "clientY", { value: 660 }); fireEvent(track, down);
    const up = createEvent.pointerUp(track, { button: 0, pointerId: 1 }); Object.defineProperty(up, "clientY", { value: 600 }); fireEvent(track, up);
    const bubble = screen.getByRole("dialog", { name: "空白时段操作" });
    expect(bubble).toHaveTextContent("10:00–11:00");
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

  it("renders month view as a fixed six-week grid starting on Monday", async () => {
    const user = userEvent.setup();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi()} />);
    await user.click(await screen.findByRole("button", { name: "日历" }));
    await user.click(screen.getByRole("button", { name: "月" }));
    const monthGrid = screen.getByRole("grid", { name: "月历" });
    expect(screen.getAllByRole("columnheader", { name: /周[一二三四五六日]/ })).toHaveLength(7);
    expect(monthGrid.querySelectorAll('[role="gridcell"]')).toHaveLength(42);
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
    expect(cell).toHaveTextContent("交付报告"); expect(cell).toHaveTextContent("完成 1 项");
    await user.click(cell);
    const detail = screen.getByRole("complementary", { name: /2026-08-05.*详情/ });
    expect(detail).toHaveTextContent("交付报告"); expect(detail).toHaveTextContent("完成复盘");
    await user.click(screen.getByRole("button", { name: "打开日视图" }));
    expect(screen.getByRole("button", { name: "日" })).toHaveAttribute("aria-pressed", "true");
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

  it("shows two all-day deadline rows in week view and expands the overflow in place", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const tasks = Array.from({ length: 4 }, (_, index) => ({ id: `due-${index}`, projectId: null, title: `全天 ${index + 1}`, progress: 0, status: "active" as const, deadlineLocal: "2026-08-05", estimatedMinutes: 30, sortOrder: index }));
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi({ ...structuredClone(EMPTY_WORKSPACE), tasks })} />);

    const allDay = await screen.findByRole("region", { name: "全天标记" });
    expect(allDay.querySelectorAll("[data-all-day-marker]")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "另外 2 项" }));
    expect(allDay.querySelectorAll("[data-all-day-marker]")).toHaveLength(4);
    await user.click(screen.getByRole("button", { name: /：全天 1/ }));
    expect(screen.getByRole("complementary", { name: /2026-08-05.*详情/ })).toHaveTextContent("全天 1");
    expect(screen.getByRole("gridcell", { name: /2026-08-05 09:00 空白时间/ })).toHaveAttribute("aria-selected", "true");
  });

  it("shows project deadline flag and milestone diamond in week all-day and opens the project detail", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "毕业设计", deadlineLocal: "2026-08-05" }],
      projectMilestones: [{ id: "ms-1", projectId: "project-1", title: "中期答辩", targetLocalDate: "2026-08-05", sortOrder: 0, criterionKind: "taskCount", targetTaskId: null, targetCount: 2, targetProgress: null }],
      tasks: [{ id: "task-1", projectId: "project-1", title: "写论文", progress: 40, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
    };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi(initial)} />);

    const allDay = await screen.findByRole("region", { name: "全天标记" });
    expect(allDay.querySelector('[data-marker-kind="projectDeadline"]')).toHaveTextContent("项目截止 · 毕业设计");
    expect(allDay.querySelector('[data-marker-kind="milestone"]')).toHaveTextContent("中期答辩");
    await user.click(screen.getByRole("button", { name: /项目截止 毕业设计/ }));
    const detail = screen.getByRole("complementary", { name: /2026-08-05.*详情/ });
    expect(detail).toHaveTextContent("毕业设计");
    expect(detail).toHaveTextContent("中期答辩");
    expect(detail).toHaveTextContent("项目截止");
  });

  it("opens the project detail from a milestone in the week all-day area", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "毕业设计", deadlineLocal: null }],
      projectMilestones: [{ id: "ms-1", projectId: "project-1", title: "中期答辩", targetLocalDate: "2026-08-05", sortOrder: 0, criterionKind: "taskCount", targetTaskId: null, targetCount: 2, targetProgress: null }],
    };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi(initial)} />);

    const allDay = await screen.findByRole("region", { name: "全天标记" });
    await user.click(screen.getByRole("button", { name: /里程碑：中期答辩/ }));
    const detail = screen.getByRole("complementary", { name: /2026-08-05.*详情/ });
    expect(detail).toHaveTextContent("毕业设计");
    expect(detail).toHaveTextContent("今天到期");
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

  it("moves week header and time-grid focus with keyboard without creating until Enter", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: "2026-08-05" } };
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    const header = await screen.findByRole("button", { name: /打开 2026-08-05/ }); header.focus();
    await user.keyboard("{ArrowRight}{ArrowLeft}{PageDown}");
    await waitFor(() => expect(document.activeElement).toHaveAccessibleName(/打开 2026-08-12/));

    const track = screen.getByRole("gridcell", { name: "2026-08-12 09:00 空白时间" }); track.focus();
    await user.keyboard("{ArrowDown}"); expect(document.activeElement).toHaveAccessibleName("2026-08-12 09:15 空白时间");
    await user.keyboard("{ArrowRight}"); expect(document.activeElement).toHaveAccessibleName("2026-08-13 09:15 空白时间");
    expect(screen.queryByRole("dialog", { name: "空白时段操作" })).not.toBeInTheDocument();
    await user.keyboard("{PageUp}"); await waitFor(() => expect(document.activeElement).toHaveAccessibleName("2026-08-06 09:15 空白时间"));
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

  it("opens a week date header in day view and marks today with text", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-05T12:00:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={createNativeApi()} />);
    await user.click(await screen.findByRole("button", { name: "日历" }));
    const todayHeader = screen.getByRole("button", { name: /打开.*8月5日.*日视图/ });
    expect(todayHeader).toHaveTextContent("今天");
    await user.click(todayHeader);
    expect(screen.getByRole("button", { name: "日" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("当前日历日期")).toHaveTextContent(/8月5日.*星期三/);
    vi.useRealTimers();
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
      expect(screen.getByText("8/10 — 8/16")).toBeVisible();
      await user.click(screen.getByRole("button", { name: "月" }));
      await user.click(screen.getByRole("button", { name: "下一段日期" }));
      expect(screen.getByText("2026年9月")).toBeVisible();
      await user.click(screen.getByRole("button", { name: "周" }));
      expect(screen.getByText("8/10 — 8/16")).toBeVisible();
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
    expect(page).toHaveAttribute("data-calendar-scale", "72");
    fireEvent.wheel(calendar, { deltaY: -100, ctrlKey: false, clientY: 300 });
    expect(page).toHaveAttribute("data-calendar-scale", "72");
    fireEvent.wheel(calendar, { deltaY: -100, ctrlKey: true, clientY: 300 });
    await waitFor(() => expect(page).toHaveAttribute("data-calendar-scale", "76"));
    await waitFor(() => expect(backend.value).toMatchObject({ calendarScale: { week: 76 } }));
    expect(native.updateExecutionSession).not.toHaveBeenCalled();
  });

  it("adapts calendar card information to the available height without changing schedule facts", async () => {
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
      expect(short).toHaveAttribute("data-card-density", "compact");
      expect(short.querySelector(".session-time")).not.toBeInTheDocument();
      expect(short.querySelector(".session-task-progress")).not.toBeInTheDocument();
      expect(short.querySelector("button[aria-label='编辑 短时段 时间']")).toHaveAttribute("data-action-visibility", "on-demand");
      expect(medium).toHaveAttribute("data-card-density", "standard");
      expect(medium.querySelector(".session-time")).toHaveTextContent("11:00–11:45");
      expect(medium.querySelector(".session-task-progress")).toBeInTheDocument();
      expect(medium.querySelector(".session-project")).not.toBeInTheDocument();
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
      ],
      executionSessions: [
        { id: "session-current", taskId: "task-current", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "06:30", endLocal: "08:30", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
        { id: "session-folded", taskId: "task-folded", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" },
      ],
      timeBlocks: [{ id: "block-folded", title: "会议", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "12:00", endLocal: "13:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480 }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    try {
      expect(await screen.findByRole("button", { name: "默认时段" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText("当前窗口任务", { selector: ".calendar-session strong" })).toBeVisible();
      expect(screen.queryByText("折叠区任务", { selector: ".calendar-session strong" })).not.toBeInTheDocument();
      const folded = screen.getByRole("button", { name: "09:00–19:00 · 2 项安排" });
      await user.click(folded);
      expect(screen.getByText("折叠区任务", { selector: ".calendar-session strong" })).toBeVisible();
      expect(backend.value).toMatchObject({ calendarDayMode: "defaultSlots" });
      await user.click(screen.getByRole("button", { name: "收起 09:00–19:00" }));
      expect(screen.queryByText("折叠区任务", { selector: ".calendar-session strong" })).not.toBeInTheDocument();
      fireEvent.dragEnter(screen.getByRole("button", { name: "09:00–19:00 · 2 项安排" }));
      act(() => vi.advanceTimersByTime(250));
      fireEvent.dragLeave(screen.getByRole("button", { name: "09:00–19:00 · 2 项安排" }));
      act(() => vi.advanceTimersByTime(300));
      expect(screen.queryByText("折叠区任务", { selector: ".calendar-session strong" })).not.toBeInTheDocument();
      fireEvent.dragEnter(screen.getByRole("button", { name: "09:00–19:00 · 2 项安排" }));
      act(() => vi.advanceTimersByTime(499));
      expect(screen.queryByText("折叠区任务", { selector: ".calendar-session strong" })).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByText("折叠区任务", { selector: ".calendar-session strong" })).toBeVisible();
      fireEvent.dragEnd(window);
      expect(screen.queryByText("折叠区任务", { selector: ".calendar-session strong" })).not.toBeInTheDocument();
      fireEvent.dragEnter(screen.getByRole("button", { name: "09:00–19:00 · 2 项安排" }));
      act(() => vi.advanceTimersByTime(500));
      (native.applyExecutionSessionChanges as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("写入失败"));
      const track = document.querySelector<HTMLElement>('[data-calendar-date="2026-08-05"] .day-track');
      expect(track).not.toBeNull();
      fireEvent.drop(track!, { clientY: 100, dataTransfer: { getData: (type: string) => type === "application/x-daymark-task" ? "task-folded" : "" } });
      await waitFor(() => expect(screen.queryByText("折叠区任务", { selector: ".calendar-session strong" })).not.toBeInTheDocument());
      await user.click(screen.getByRole("button", { name: "全天" }));
      expect(screen.getByText("折叠区任务", { selector: ".calendar-session strong" })).toBeVisible();
      await waitFor(() => expect(backend.value).toMatchObject({ calendarDayMode: "fullDay" }));
      expect(native.updateExecutionSession).not.toHaveBeenCalled();
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
      await waitFor(() => expect(screen.getByLabelText("当前日历日期")).toHaveTextContent(/8月5日.*星期三/));
      axis.scrollTop = 3000;
      fireEvent.scroll(axis);
      await waitFor(() => expect(screen.getByLabelText("当前日历日期")).toHaveTextContent(/8月6日.*星期四/));
      await user.click(screen.getByRole("button", { name: "回到今天" }));
      await waitFor(() => expect(screen.getByLabelText("当前日历日期")).toHaveTextContent(/8月5日.*星期三/));
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
      expect(screen.getByRole("progressbar", { name: "整理研究笔记 本时段已过去" })).toHaveAttribute("aria-valuenow", "50");
      expect(screen.getByRole("progressbar", { name: "整理研究笔记 手动任务进度" })).toHaveAttribute("aria-valuenow", "40");
      expect(document.querySelector(".calendar-session.current-schedule")).toHaveTextContent("整理研究笔记");
      expect(document.querySelector(".calendar-past-region")).toHaveAttribute("style", expect.stringContaining("50%"));
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
    const today = new Date().toISOString().slice(0, 10);
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "week", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, week: today }, showActualRecords: true, showActualRecordsControl: false };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-1", projectId: null, title: "隐藏控制入口", progress: 10, status: "active", deadlineLocal: null, estimatedMinutes: 60, sortOrder: 0 }],
      executionRecords: [{ id: "record-1", sessionId: null, taskId: "task-1", actualStartUtc: new Date(Date.now() - 60 * 60_000).toISOString(), actualEndUtc: new Date().toISOString(), note: "" }],
    };
    const user = userEvent.setup();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi(initial)} />);
    expect(await screen.findByLabelText(/实际记录：隐藏控制入口/)).toBeVisible();
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
    await user.click(await screen.findByText("编辑任务信息"));
    await user.selectOptions(screen.getByRole("combobox", { name: "项目" }), "project-1");
    await user.type(screen.getByLabelText("截止日期"), "2026-08-02");
    await waitFor(() => expect(native.updateTask).toHaveBeenCalled());
    expect(native.updateTask).toHaveBeenLastCalledWith(expect.objectContaining({ deadlineLocal: "2026-08-02" }));
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
    const today = new Date().toISOString().slice(0, 10);
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
    expect(screen.getByRole("dialog", { name: "自动排程 Lite" })).toHaveTextContent("准备候选版");
    await user.click(screen.getByRole("button", { name: "生成排程草案" }));
    await user.click(screen.getByRole("button", { name: "应用全部" }));
    await waitFor(() => expect(native.applyScheduleDraft).toHaveBeenCalledOnce());
  });

  it("creates a lightweight time block from the calendar", async () => {
    const user = userEvent.setup(); const native = createNativeApi();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "日历" }));
    await user.click(screen.getByRole("button", { name: "时间块" }));
    await user.type(screen.getByRole("textbox", { name: "标题" }), "午休");
    await user.click(screen.getByRole("button", { name: "创建时间块" }));
    await waitFor(() => expect(native.createTimeBlock).toHaveBeenCalledWith(expect.objectContaining({ title: "午休" })));
    expect(screen.getByText("午休")).toBeVisible();
  });

  it("moves a time block's bottom edge to stretch it and commits an update", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, day: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      timeBlocks: [{ id: "block-1", title: "通勤", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480 }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    await screen.findByText("通勤");
    const handle = screen.getByRole("button", { name: "调整 通勤 结束时间" });
    const down = createEvent.pointerDown(handle, { button: 0, clientY: 660 }); fireEvent(handle, down);
    const move = createEvent.pointerMove(window, { clientY: 780, clientX: 100 }); fireEvent(window, move);
    expect(screen.getByRole("status", { name: "调整时间块时长预览" })).toHaveTextContent("10:00–12:45");
    const up = createEvent.pointerUp(window, { clientY: 780, clientX: 100 }); fireEvent(window, up);
    await waitFor(() => expect(native.updateTimeBlock).toHaveBeenCalledWith(expect.objectContaining({ id: "block-1", startLocal: "10:00", endLocal: "12:45" })));
  });

  it("moves a time block's top edge to change its start while keeping the end fixed", async () => {
    const backend = new MemorySettingsBackend();
    backend.value = { ...DEFAULT_SETTINGS, lastPage: "calendar", calendarView: "day", calendarAnchors: { ...DEFAULT_SETTINGS.calendarAnchors, day: "2026-08-05" } };
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      timeBlocks: [{ id: "block-2", title: "会议", localDate: "2026-08-05", endLocalDate: "2026-08-05", startLocal: "10:00", endLocal: "11:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480 }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(backend)} native={native} />);
    await screen.findByText("会议");
    const handle = screen.getByRole("button", { name: "调整 会议 开始时间" });
    const down = createEvent.pointerDown(handle, { button: 0, clientY: 600 }); fireEvent(handle, down);
    const move = createEvent.pointerMove(window, { clientY: 480, clientX: 100 }); fireEvent(window, move);
    expect(screen.getByRole("status", { name: "调整时间块时长预览" })).toHaveTextContent("08:15–11:00");
    const up = createEvent.pointerUp(window, { clientY: 480, clientX: 100 }); fireEvent(window, up);
    await waitFor(() => expect(native.updateTimeBlock).toHaveBeenCalledWith(expect.objectContaining({ id: "block-2", startLocal: "08:15", endLocal: "11:00" })));
  });

  it("creates a daily habit and schedules today's independent occurrence", async () => {
    const user = userEvent.setup(); const native = createNativeApi();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: /新建重复习惯/ }));
    await user.type(screen.getByRole("textbox", { name: "习惯名称" }), "拉伸");
    await user.click(screen.getByRole("button", { name: "创建习惯" }));
    await waitFor(() => expect(native.createRecurringHabit).toHaveBeenCalledOnce());
    await user.click(await screen.findByRole("button", { name: "安排今天" }));
    await waitFor(() => expect(native.scheduleHabitOccurrence).toHaveBeenCalledOnce());
  });

  it("imports Bilibili public parts only after an editable Beta preview", async () => {
    const user = userEvent.setup();
    const native = createNativeApi(structuredClone(EMPTY_WORKSPACE), { fetchBilibiliVideo: vi.fn().mockResolvedValue({ bvid: "BV1xx411c7mD", title: "公开课程", ownerName: "UP 主", parts: [{ page: 1, title: "第一讲", durationSeconds: 600, sourceKey: "BV1xx411c7mD:1", sourceUrl: "https://www.bilibili.com/video/BV1xx411c7mD?p=1" }] }) });
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "项目" }));
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
    await screen.findByRole("heading", { name: "今天从下一步开始", level: 1 });
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
    expect(await screen.findByRole("heading", { name: "日历", level: 1 })).toBeVisible();
    await waitFor(() => expect(document.querySelector(".calendar-session.pending-review")).toHaveTextContent("恢复行动待回顾"));
    expect(document.querySelector(".calendar-session.pending-review")).toHaveAttribute("draggable", "true");
    expect(native.updateExecutionSession).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("collects overdue and upcoming-deadline tasks into a collapsible attention section", async () => {
    const today = new Date().toISOString().slice(0, 10);
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

  it("edits motion and adds an extra default time slot with weekdays", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await user.click(await screen.findByRole("button", { name: "设置" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "动态效果" }), "reduce");
    await user.click(screen.getByRole("button", { name: /添加时段/ }));
    expect(screen.getAllByRole("group", { name: /时段/ })).toHaveLength(2);
    const weekdayBoxes = screen.getAllByRole("checkbox", { name: "一" });
    await user.click(weekdayBoxes[0]);
    await waitFor(() => expect(backend.value).toMatchObject({ motion: "reduce" }));
    await waitFor(() => expect((backend.value as { defaultTimeSlots: Array<{ weekdays: number[] }> }).defaultTimeSlots).toHaveLength(2));
    expect((backend.value as { defaultTimeSlots: Array<{ weekdays: number[] }> }).defaultTimeSlots[0].weekdays).not.toContain(1);
  });

  it("turns off calendar snapping", async () => {
    const user = userEvent.setup(); const backend = new MemorySettingsBackend();
    render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
    await user.click(await screen.findByRole("button", { name: "日历" }));
    await user.click(screen.getByRole("button", { name: "吸附 15 分钟" }));
    expect(screen.getByRole("button", { name: "吸附已关闭" })).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(backend.value).toMatchObject({ snapMinutes: "off" }));
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
    const today = new Date().toISOString().slice(0, 10);
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-1", projectId: null, title: "深度工作", progress: 40, status: "active", deadlineLocal: null, estimatedMinutes: 90, sortOrder: 0 }],
      executionSessions: [{ id: "session-1", taskId: "task-1", localDate: today, endLocalDate: today, startLocal: "09:00", endLocal: "10:30", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
    };
    const native = createNativeApi(initial); const user = userEvent.setup();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "日历" }));
    await user.click(await screen.findByRole("button", { name: "编辑 深度工作 时间" }));
    const startInput = screen.getByLabelText("开始");
    await user.clear(startInput); await user.type(startInput, "13:07");
    const endInput = screen.getByLabelText("结束");
    await user.clear(endInput); await user.type(endInput, "14:19");
    await user.click(screen.getByRole("button", { name: "保存时间" }));
    await waitFor(() => expect(native.updateExecutionSession).toHaveBeenCalledWith(expect.objectContaining({ startLocal: "13:07", endLocal: "14:19", localDate: today, endLocalDate: today })));
  });

  it("allows a session to end after midnight when edited precisely", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      tasks: [{ id: "task-1", projectId: null, title: "夜猫任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 120, sortOrder: 0 }],
      executionSessions: [{ id: "session-1", taskId: "task-1", localDate: today, endLocalDate: today, startLocal: "22:00", endLocal: "00:00", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480, status: "scheduled" }],
    };
    const native = createNativeApi(initial); const user = userEvent.setup();
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: "日历" }));
    await user.click(await screen.findByRole("button", { name: "编辑 夜猫任务 时间" }));
    const startInput = screen.getByLabelText("开始");
    await user.clear(startInput); await user.type(startInput, "23:00");
    const endInput = screen.getByLabelText("结束");
    await user.clear(endInput); await user.type(endInput, "01:00");
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
    await user.click(screen.getByRole("button", { name: "编辑项目 Alpha" }));
    const titleInput = screen.getByLabelText("项目标题");
    await user.clear(titleInput); await user.type(titleInput, "Beta");
    await user.click(screen.getByRole("button", { name: "保存项目" }));
    await waitFor(() => expect(native.updateProject).toHaveBeenCalledWith(expect.objectContaining({ id: "project-1", title: "Beta", deadlineLocal: yesterday })));
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
    expect(await screen.findByText("大纲定稿")).toBeVisible();
    expect(screen.getByText("已达成")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "为 Alpha 新增里程碑" }));
    await user.type(screen.getByLabelText("里程碑名称"), "终稿完成");
    await user.type(screen.getByLabelText("目标日期"), "2026-09-10");
    await user.selectOptions(screen.getByRole("combobox", { name: "目标任务" }), "task-1");
    await user.click(screen.getByRole("button", { name: "保存里程碑" }));
    await waitFor(() => expect(native.createProjectMilestone).toHaveBeenCalledWith(expect.objectContaining({ title: "终稿完成", criterionKind: "orderedTask", targetTaskId: "task-1" })));
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
    await screen.findByText("两个任务完成");
    await user.click(screen.getByRole("button", { name: "编辑里程碑 两个任务完成" }));
    const nameInput = screen.getByLabelText("里程碑名称");
    await user.clear(nameInput); await user.type(nameInput, "完成两个任务");
    await user.click(screen.getByRole("button", { name: "保存里程碑" }));
    await waitFor(() => expect(native.updateProjectMilestone).toHaveBeenCalledWith(expect.objectContaining({ id: "ms-1", title: "完成两个任务" })));
    await user.click(await screen.findByRole("button", { name: "删除里程碑 完成两个任务" }));
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
    expect(await screen.findByText(/完成 1\/2，未达成/)).toBeVisible();
    expect(screen.getByText("未达成")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "续排里程碑 两个任务完成" }));
    expect(screen.getByRole("heading", { name: "续排里程碑：两个任务完成" })).toBeVisible();
    expect(screen.getByLabelText("完成任务数（项目内共 2 个）")).toHaveValue(1);
    await user.click(screen.getByRole("button", { name: "保存续排" }));
    await waitFor(() => expect(native.createProjectMilestone).toHaveBeenCalledWith(expect.objectContaining({ criterionKind: "taskCount", targetCount: 1, projectId: "project-1" })));
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
    expect(await screen.findByText("已达成")).toBeVisible();
    expect(screen.queryByRole("button", { name: "续排里程碑 大纲定稿" })).not.toBeInTheDocument();
  });

  it("uses the project deadline as a fallback deadline in auto scheduling", async () => {
    const user = userEvent.setup();
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "Alpha", deadlineLocal: "2026-09-05" }],
      tasks: [{ id: "task-1", projectId: "project-1", title: "写大纲", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sessionMinutes: 30, priority: "normal", sortOrder: 0, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task" }],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: /自动排程/ }));
    const dialog = await screen.findByRole("dialog", { name: "自动排程 Lite" });
    const item = await within(dialog).findByText("写大纲");
    expect(item.closest("label")).toHaveTextContent(/可安排|放不下/);
    await user.click(screen.getByRole("button", { name: "生成排程草案" }));
    expect(await screen.findByRole("button", { name: "应用全部" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "应用全部" }));
    await waitFor(() => expect(native.applyScheduleDraft).toHaveBeenCalled());
    const allocations = (native.applyScheduleDraft as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<{ localDate: string }>;
    expect(allocations.length).toBeGreaterThan(0);
    expect(allocations.every((allocation) => allocation.localDate <= "2026-09-05")).toBe(true);
  });

  it("undoes an applied schedule draft through the toast and removes every session", async () => {
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE), tasks: [{ id: "task-1", projectId: null, title: "准备候选版", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sessionMinutes: 45, priority: "normal", sortOrder: 0, sourceUrl: null, sourceKey: null, mediaMinutes: null, kind: "task" }] };
    const user = userEvent.setup(); const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    await user.click(await screen.findByRole("button", { name: /自动排程/ }));
    await user.click(screen.getByRole("button", { name: "生成排程草案" }));
    await user.click(screen.getByRole("button", { name: "应用全部" }));
    await waitFor(() => expect(native.applyScheduleDraft).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: /撤销本次自动排程/ }));
    await waitFor(() => expect(native.deleteExecutionSessions).toHaveBeenCalledOnce());
    const sessions = (native.applyScheduleDraft as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<{ id: string }>;
    expect(native.deleteExecutionSessions).toHaveBeenCalledWith(sessions.map((session) => session.id));
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
    expect(screen.getByRole("status", { name: "调整时间块时长预览" })).toHaveTextContent("11:15–12:15");
    const up = createEvent.pointerUp(window, { clientY: 696, clientX: 100 }); fireEvent(window, up);
    await waitFor(() => expect(native.updateTimeBlock).toHaveBeenCalledWith(expect.objectContaining({ id: "block-3", startLocal: "11:15", endLocal: "12:15", localDate: "2026-08-05" })));
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

  it("deletes a lightweight time block from the calendar", async () => {
    const today = new Date().toISOString().slice(0, 10);
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
    expect(screen.getByRole("heading", { name: "确认排程草案" })).toBeVisible();
    const previewTitles = Array.from(document.querySelectorAll(".schedule-preview strong")).map((node) => node.textContent ?? "");
    const stretchTitles = previewTitles.filter((title) => title.startsWith("拉伸 ·"));
    expect(stretchTitles.length).toBe(6);
    expect(stretchTitles.every((title) => !title.includes("8/2"))).toBe(true);
    vi.useRealTimers();
  });

  it("collapses project groups in the task pool and reveals the next unfinished task", async () => {
    const user = userEvent.setup();
    const initial: WorkspaceSnapshot = { ...structuredClone(EMPTY_WORKSPACE),
      projects: [{ id: "project-1", title: "四级英语单词", deadlineLocal: null }],
      tasks: [
        { id: "task-a", projectId: "project-1", title: "使用说明", progress: 100, status: "active", deadlineLocal: null, estimatedMinutes: null, sortOrder: 0, kind: "task" },
        { id: "task-b", projectId: "project-1", title: "视频配套书籍在哪？", progress: 50, status: "active", deadlineLocal: null, estimatedMinutes: null, sortOrder: 1, kind: "task" },
        { id: "task-c", projectId: "project-1", title: "Unit1 Lesson 1", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: null, sortOrder: 2, kind: "task" },
      ],
    };
    const native = createNativeApi(initial);
    render(<App settings={new SettingsRepository(new MemorySettingsBackend())} native={native} />);
    const header = await screen.findByRole("button", { name: /四级英语单词/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    // 默认折叠：只显示第一个未完成任务
    expect(screen.getByText("视频配套书籍在哪？")).toBeVisible();
    expect(screen.queryByText("Unit1 Lesson 1")).not.toBeInTheDocument();
    expect(screen.queryByText("使用说明")).not.toBeInTheDocument();
    // 点击展开：全部任务可见
    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Unit1 Lesson 1")).toBeVisible();
    expect(screen.getByText("使用说明")).toBeVisible();
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
    const projectCard = document.querySelector<HTMLElement>(".project-card")!;
    const completeButton = within(projectCard).getByRole("button", { name: "标记 使用说明 已完成" });
    await user.click(completeButton);
    await waitFor(() => expect(native.applyProgress).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-watch", toProgress: 100 })));
    expect(within(projectCard).getAllByText("100%").length).toBeGreaterThan(0);
  });
});
