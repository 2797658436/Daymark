import type { CSSProperties } from "react";

/**
 * 回顾图表（阶段 4 P4-08，规格 §7.4）。
 *
 * 三条硬规矩，都在这一层收口：
 *
 * 1. **一张图只有一个单位**：投入图只用分钟，进度图只用百分点。两个量纲不混进同一张图 ——
 *    混起来会把「投入了 60 分钟」读成「推进了 60 个百分点」。
 * 2. **零基线**：进度变化可能为负（下调），零基线以上是上调、以下是下调，并且带一句
 *    文字说明。**不用「越深越好」的色阶**：下调是事实，不是失败，也不代表热度。
 * 3. **等价数值表**：每张图都带一张始终可见的数值表，悬停只是增强而不是唯一入口。
 *
 * 只用 CSS 画（规格 §9／§12：本阶段不新增依赖），没有图表库；图表本身对辅助技术
 * 隐藏（`aria-hidden`），可访问的等价物是那张表。
 */

export interface ReviewChartRow {
  date: string;
  /** 图上的数值。投入图恒为非负；进度图可正可负。 */
  value: number;
  /** 数值表里的显示值：直接来自引擎的口径，不在页面里再算一次。 */
  label: string;
  /** 图下方的短刻度（周／月是日号，日是当天日期）。 */
  tick: string;
  /** 数值表里的完整日期。 */
  fullLabel: string;
}

export interface ReviewChartProps {
  title: string;
  /** 单位：投入图「分钟」，进度图「百分点」。 */
  unit: string;
  rows: ReviewChartRow[];
  /** 是否含可正可负的值（进度图）。非负图不需要零基线说明。 */
  signed?: boolean;
  /** 有符号图的零基线文字说明。 */
  baselineNote?: string;
  /** 全周期为零时的文字：空周期不绘制全零图表。 */
  emptyText: string;
  /** 提供时，数值表的日期成为可下钻的按钮（日期明细）。 */
  onOpenDate?: (date: string, trigger: HTMLElement) => void;
}

export function ReviewChart({ title, unit, rows, signed, baselineNote, emptyText, onOpenDate }: ReviewChartProps) {
  // 全零不画图：没有事实时画一排零柱会把「未记录」误读成「做了但没推进」。
  const hasValues = rows.some((row) => row.value !== 0);
  const maxUp = Math.max(0, ...rows.map((row) => row.value));
  const maxDown = Math.max(0, ...rows.map((row) => -row.value));
  const span = maxUp + maxDown;
  // 零基线在容器里的位置（从顶往下算）。非负图的零基线落在底部，有负值时上移。
  const zeroPercent = span === 0 ? 100 : (maxUp / span) * 100;

  const barStyle = (value: number): CSSProperties => {
    if (value > 0) return { bottom: `${100 - zeroPercent}%`, height: `${(value / maxUp) * zeroPercent}%` };
    if (value < 0) return { top: `${zeroPercent}%`, height: `${(-value / maxDown) * (100 - zeroPercent)}%` };
    return { bottom: `${100 - zeroPercent}%`, height: "2px" };
  };
  const barClass = (value: number) => `review-chart-bar ${value > 0 ? "up" : value < 0 ? "down" : "flat"}`;

  return <figure className="review-chart-figure">
    <figcaption className="review-chart-caption">
      <strong>{title}</strong>
      <span>单位：{unit}</span>
    </figcaption>

    {hasValues ? <>
      <div className="review-chart" aria-hidden="true">
        <div className="review-chart-plot">
          <span className="review-chart-zero" style={{ top: `${zeroPercent}%` }} />
          {rows.map((row) => <div className="review-chart-column" key={row.date} data-chart-date={row.date} data-chart-value={row.value}>
            <span className={barClass(row.value)} style={barStyle(row.value)} />
          </div>)}
        </div>
        <div className="review-chart-ticks">{rows.map((row) => <span key={row.date}>{row.tick}</span>)}</div>
      </div>

      {/* 等价数值表：与图上的柱一一对应，不依赖悬停，也不依赖颜色。 */}
      <table className="review-chart-table" aria-label={`${title}（${unit}）等价数值表`}>
        <thead><tr><th scope="col">日期</th><th scope="col">{unit}</th></tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.date} data-chart-row={row.date}>
            <th scope="row">{onOpenDate
              ? <button type="button" className="review-chart-date" data-review-trigger={`date:${row.date}`} aria-label={`查看 ${row.fullLabel} 的明细`} onClick={(event) => onOpenDate(row.date, event.currentTarget)}>{row.fullLabel}</button>
              : row.fullLabel}</th>
            <td>{row.label}</td>
          </tr>)}
        </tbody>
      </table>
    </> : <p className="review-chart-empty">{emptyText}</p>}

    {signed && hasValues && baselineNote && <p className="review-chart-note">{baselineNote}</p>}
  </figure>;
}
