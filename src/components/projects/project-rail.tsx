import type { CSSProperties } from "react";

import type { ProjectRailData } from "../../lib/projectRail";

const DATE_FORMAT = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" });
const STATE_LABEL = { reached: "已达成", missed: "未达成", active: "进行中" } as const;

/**
 * 项目进度轨：一条加权进度条 + 里程碑菱形。
 *
 * 菱形沿用日历里的里程碑符号（UI-SPEC：项目截止用旗帜、里程碑用菱形），不另造图标。
 * 紧凑卡把“下一里程碑”贴在对应菱形下方：中间居中对齐，靠近两端时改为左/右对齐，
 * 避免标签冲出卡片；标题过长时省略，日期和“（约）”始终保留。轨道本身对辅助技术隐藏，
 * 可读信息由这条标签（紧凑卡）或图例（详情）承担。
 */
export function ProjectRail({ rail, compact = false }: { rail: ProjectRailData; compact?: boolean }) {
  const next = rail.next;
  const labelEdge = next ? next.position <= 30 ? " is-edge-start" : next.position >= 70 ? " is-edge-end" : "" : "";
  return <div className={[compact ? "project-rail-block is-compact" : "project-rail-block", compact && next ? "has-node-label" : ""].filter(Boolean).join(" ")}>
    <div className="project-rail" aria-hidden="true">
      <span className="project-rail-fill" style={{ width: rail.progress + "%" }} />
      {rail.nodes.map((node) => <span key={node.milestone.id}
        className={["project-rail-node", "is-" + node.state, node.milestone.id === next?.milestone.id ? "is-next" : "", node.approximate ? "is-approximate" : ""].filter(Boolean).join(" ")}
        style={{ left: node.position + "%" }}
        title={node.milestone.title + " · " + node.summary + (node.approximate ? " · 位置按达成条件换算" : "")} />)}
    </div>
    {compact
      ? next
        ? <span className="project-rail-label-slot">
          <span className={"project-rail-node-label" + labelEdge}
            style={{ "--rail-position": next.position + "%" } as CSSProperties}
            aria-label={"下一里程碑：" + next.milestone.title + " · " + formatDate(next.milestone.targetLocalDate) + (next.approximate ? "（约）" : "")}>
            <strong>{next.milestone.title}</strong>
            <span>{formatDate(next.milestone.targetLocalDate)}{next.approximate ? "（约）" : ""}</span>
          </span>
        </span>
        : <p className="project-rail-next">下一里程碑：<strong>{rail.nodes.length ? "已达成" : "未设置"}</strong></p>
      : <div className="project-rail-legend">
        {rail.nodes.length === 0
          ? <span className="project-rail-empty">还没有里程碑</span>
          : rail.nodes.map((node) => <span key={node.milestone.id} className={"project-rail-legend-item is-" + node.state}>
            <span className="project-rail-legend-dot" aria-hidden="true" />
            <strong>{node.milestone.title}</strong>
            <span>{formatDate(node.milestone.targetLocalDate)} · {STATE_LABEL[node.state]}{node.approximate ? "（约）" : ""}</span>
          </span>)}
      </div>}
  </div>;
}

function formatDate(date: string) {
  return DATE_FORMAT.format(new Date(date + "T12:00:00"));
}