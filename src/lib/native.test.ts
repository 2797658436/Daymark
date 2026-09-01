import { beforeEach, describe, expect, it } from "vitest";

import { createNativeApi, type ProjectMilestone, type TimeBlock } from "./native";

describe("browser preview project constraints", () => {
  beforeEach(() => localStorage.clear());

  it("normalizes a v5 workspace and persists typed milestone CRUD", async () => {
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify({
      projects: [{ id: "project-1", title: "旧项目" }],
      tasks: [{ id: "task-1", projectId: "project-1", title: "第一步", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 30, sortOrder: 0 }],
    }));
    const api = createNativeApi();

    const migrated = await api.getWorkspace();
    expect(migrated.projects[0].deadlineLocal).toBeNull();
    expect(migrated.projectMilestones).toEqual([]);

    await api.updateProject({ ...migrated.projects[0], deadlineLocal: "2026-09-30" });
    const milestone: ProjectMilestone = {
      id: "milestone-1", projectId: "project-1", title: "完成第一步", targetLocalDate: "2026-09-15", sortOrder: 0,
      criterionKind: "orderedTask", targetTaskId: "task-1", targetCount: null, targetProgress: null,
    };
    await api.createProjectMilestone(milestone);
    const updated = await api.updateProjectMilestone({ ...milestone, title: "完成基础阶段" });
    expect(updated.projects[0].deadlineLocal).toBe("2026-09-30");
    expect(updated.projectMilestones[0].title).toBe("完成基础阶段");
    expect((await api.deleteProjectMilestone("milestone-1")).projectMilestones).toEqual([]);
  });

  it("rejects an ordered-task milestone whose task belongs elsewhere", async () => {
    localStorage.setItem("daymark.phase1.workspace", JSON.stringify({
      projects: [{ id: "project-1", title: "项目一" }, { id: "project-2", title: "项目二" }],
      tasks: [{ id: "task-2", projectId: "project-2", title: "别的任务", progress: 0, status: "active", deadlineLocal: null, estimatedMinutes: 30, sortOrder: 0 }],
    }));
    const api = createNativeApi();
    await expect(api.createProjectMilestone({
      id: "bad", projectId: "project-1", title: "错误目标", targetLocalDate: "2026-09-15", sortOrder: 0,
      criterionKind: "orderedTask", targetTaskId: "task-2", targetCount: null, targetProgress: null,
    })).rejects.toThrow("同一项目");
  });

  it("updates a time block's title and interval and rejects invalid edits", async () => {
    const api = createNativeApi();
    const block: TimeBlock = {
      id: "block-1", title: "通勤", localDate: "2026-09-15", endLocalDate: "2026-09-15",
      startLocal: "08:00", endLocal: "08:30", timeZone: "Asia/Shanghai", utcOffsetMinutes: 480,
    };
    await api.createTimeBlock(block);
    const updated = await api.updateTimeBlock({ ...block, title: "晚通勤", startLocal: "18:00", endLocal: "18:30" });
    const stored = updated.timeBlocks.find((item) => item.id === "block-1");
    expect(stored?.title).toBe("晚通勤");
    expect(stored?.startLocal).toBe("18:00");
    expect(stored?.endLocal).toBe("18:30");
    await expect(api.updateTimeBlock({ ...block, id: "ghost" })).rejects.toThrow("未找到");
    await expect(api.updateTimeBlock({ ...block, title: "  " })).rejects.toThrow("标题");
    // 区间错误必须不改 snapshot
    const still = (await api.getWorkspace()).timeBlocks.find((item) => item.id === "block-1");
    expect(still?.title).toBe("晚通勤");
  });
});
