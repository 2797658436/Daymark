import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ProjectMilestone } from "../../lib/native";
import type { ProjectRailData } from "../../lib/projectRail";
import { ProjectRail } from "./project-rail";

function milestone(overrides: Partial<ProjectMilestone> = {}): ProjectMilestone {
  return {
    id: "m-1", projectId: "p-1", title: "完成基础篇", targetLocalDate: "2026-09-01", sortOrder: 0,
    criterionKind: "projectProgress", targetTaskId: null, targetCount: null, targetProgress: 50,
    ...overrides,
  } as ProjectMilestone;
}

function rail(position: number, overrides: Partial<ProjectRailData> = {}): ProjectRailData {
  const node = { milestone: milestone(), position, approximate: false, state: "active" as const, summary: "" };
  return { progress: 40, nodes: [node], next: node, ...overrides };
}

describe("project rail", () => {
  it("anchors the next milestone under its node and flips alignment near the rail edges", () => {
    const { rerender } = render(<ProjectRail rail={rail(10)} compact />);
    const start = screen.getByLabelText(/下一里程碑/);
    expect(start).toHaveClass("is-edge-start");
    expect(within(start).getByText("完成基础篇")).toBeInTheDocument();
    expect(within(start).getByText("9月1日")).toBeInTheDocument();

    rerender(<ProjectRail rail={rail(50)} compact />);
    const center = screen.getByLabelText(/下一里程碑/);
    expect(center).not.toHaveClass("is-edge-start");
    expect(center).not.toHaveClass("is-edge-end");

    rerender(<ProjectRail rail={rail(90)} compact />);
    expect(screen.getByLabelText(/下一里程碑/)).toHaveClass("is-edge-end");
  });

  it("keeps a fallback line when there is no next milestone", () => {
    render(<ProjectRail rail={rail(50, { nodes: [], next: null })} compact />);
    expect(screen.getByText(/下一里程碑：/)).toBeInTheDocument();
    expect(screen.getByText("未设置")).toBeInTheDocument();
    expect(screen.queryByLabelText(/下一里程碑/)).toBeNull();
  });

  it("keeps the full legend in the detail rail instead of a node label", () => {
    render(<ProjectRail rail={rail(50)} />);
    expect(screen.queryByLabelText(/下一里程碑/)).toBeNull();
    expect(screen.getByText("完成基础篇")).toBeInTheDocument();
    expect(screen.getByText(/9月1日 · 进行中/)).toBeInTheDocument();
  });
});
