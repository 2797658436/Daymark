import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

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
 *
 * 2026-10-19 密度修订（用户反馈「内容太多」）：
 * - 数值表从「每天一行、整行铺满」改成**多列成对排布**：周 2 对、月 4 对。行数减少
 *   一半以上，但每个日期仍然是一个独立的行标题、仍然始终可见、仍然可下钻 ——
 *   这是压缩排版，不是把表格藏起来。
 * - 柱宽封顶 2.75rem 并居中。此前柱宽由「列宽 × 72%」决定，单日周期会画出一根
 *   889px 宽的橙色方块，周视图也有 125px。
 * - 单日周期不画柱：一根柱子没有比较对象，图上的信息量为零。数值表直接作为该周期的
 *   呈现（一行大号数值），规格要求的「日回顾用横向变化条呈现」留给任务明细，不在这里
 *   用柱状图冒充。
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

/** 数值表的列对数：日 1 对、周 2 对、月 4 对。超过 14 天就再分一栏。 */
function preferredPairs(rowCount: number) {
  if (rowCount > 14) return 4;
  if (rowCount > 4) return 2;
  return 1;
}

/**
 * 一对「日期 + 数值」在 0.78rem 字号下至少需要约 11rem 宽（日期 5.5rem、数值 5.5rem）。
 * 界面缩放是靠根字号放大的，所以这里必须用 **rem 为单位的可用宽度** 来降栏：
 * 960px 窗口 + 200% 时可用宽度只剩约 24rem，硬排 4 对会让「10月1日」和「88 分钟」
 * 撞在一起、数值折行溢出（2026-10-19 实测）。
 */
function pairsForWidth(widthRem: number, rowCount: number) {
  return Math.max(1, Math.min(preferredPairs(rowCount), Math.floor(widthRem / 11)));
}

function usePairCount(rowCount: number) {
  const ref = useRef<HTMLElement | null>(null);
  const [pairs, setPairs] = useState(() => preferredPairs(rowCount));

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      // jsdom 没有布局：clientWidth 恒为 0，此时保留按周期长度的默认值，测试才有确定性。
      if (node.clientWidth === 0) return;
      const rootRem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setPairs(pairsForWidth(node.clientWidth / rootRem, rowCount));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    // 根字号变化不会改变元素的 px 宽度（缩放靠 fontSize），要单独盯一下。
    const mutation = new MutationObserver(measure);
    mutation.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-scale"] });
    return () => { observer?.disconnect(); mutation.disconnect(); };
  }, [rowCount]);

  return { ref, pairs };
}

export function ReviewChart({ title, unit, rows, signed, baselineNote, emptyText, onOpenDate }: ReviewChartProps) {
  // 全零不画图：没有事实时画一排零柱会把「未记录」误读成「做了但没推进」。
  const hasValues = rows.some((row) => row.value !== 0);
  const maxUp = Math.max(0, ...rows.map((row) => row.value));
  const maxDown = Math.max(0, ...rows.map((row) => -row.value));
  const span = maxUp + maxDown;
  // 零基线在容器里的位置（从顶往下算）。非负图的零基线落在底部，有负值时上移。
  const zeroPercent = span === 0 ? 100 : (maxUp / span) * 100;
  const { ref, pairs } = usePairCount(rows.length);
  const single = rows.length === 1;

  const barStyle = (value: number): CSSProperties => {
    if (value > 0) return { bottom: `${100 - zeroPercent}%`, height: `${(value / maxUp) * zeroPercent}%` };
    if (value < 0) return { top: `${zeroPercent}%`, height: `${(-value / maxDown) * (100 - zeroPercent)}%` };
    return { bottom: `${100 - zeroPercent}%`, height: "2px" };
  };
  const barClass = (value: number) => `review-chart-bar ${value > 0 ? "up" : value < 0 ? "down" : "flat"}`;

  const rowGroups: ReviewChartRow[][] = [];
  for (let index = 0; index < rows.length; index += pairs) rowGroups.push(rows.slice(index, index + pairs));

  const dateCell = (row: ReviewChartRow) => onOpenDate
    ? <button type="button" className="review-chart-date" data-review-trigger={`date:${row.date}`} aria-label={`查看 ${row.fullLabel} 的明细`} onClick={(event) => onOpenDate(row.date, event.currentTarget)}>{row.fullLabel}</button>
    : row.fullLabel;

  return <figure ref={ref} className={`review-chart-figure${single ? " is-single" : ""}`}>
    <figcaption className="review-chart-caption">
      <strong>{title}</strong>
      <span>单位：{unit}</span>
    </figcaption>

    {hasValues ? <>
      {!single && <div className="review-chart" aria-hidden="true">
        <div className="review-chart-plot">
          <span className="review-chart-zero" style={{ top: `${zeroPercent}%` }} />
          {rows.map((row) => <div className="review-chart-column" key={row.date} data-chart-date={row.date} data-chart-value={row.value}>
            <span className={barClass(row.value)} style={barStyle(row.value)} />
          </div>)}
        </div>
        <div className="review-chart-ticks">{rows.map((row) => <span key={row.date}>{row.tick}</span>)}</div>
      </div>}

      {/* 等价数值表：与图上的柱一一对应，不依赖悬停，也不依赖颜色。
          列对数由周期长度决定，日期仍然逐个可读、可下钻。 */}
      <table className={`review-chart-table${pairs > 1 ? " is-multi" : ""}`} aria-label={`${title}（${unit}）等价数值表`}>
        <thead><tr>
          {Array.from({ length: pairs }).map((_, index) => <PairHeader key={index} unit={unit} />)}
        </tr></thead>
        <tbody>
          {rowGroups.map((group) => <tr key={group[0].date}>
            {group.map((row) => <Fragment key={row.date}>
              <th scope="row" data-chart-row={row.date}>{dateCell(row)}</th>
              {/* 零值／未记录降到次要色：31 天里通常有 20 多天没有记录，它们不该和真实数值抢注意力。 */}
              <td data-chart-cell={row.date} className={row.value === 0 ? "is-zero" : undefined}>{row.label}</td>
            </Fragment>)}
            {/* 末行不满时用一格跨列补齐：不能补空 <th>（axe 会报 empty-table-header），
                也不能不补（那一行的分隔线会断在半路）。 */}
            {pairs - group.length > 0 && <td className="is-empty" colSpan={(pairs - group.length) * 2} />}
          </tr>)}
        </tbody>
      </table>
    </> : <p className="review-chart-empty">{emptyText}</p>}

    {/* 单日没有零基线可比，这句说明只会变成噪音；正负号本身已经表达了方向。 */}
    {signed && hasValues && baselineNote && !single && <p className="review-chart-note">{baselineNote}</p>}
  </figure>;
}

function PairHeader({ unit }: { unit: string }) {
  return <><th scope="col">日期</th><th scope="col">{unit}</th></>;
}
