import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { FloatingPanel } from "../ui/floating-panel";
import { useOverlayLayer } from "../ui/overlay-host";

/**
 * 回顾图表（阶段 4 P4-08，规格 §7.4）。
 *
 * 三条硬规矩，都在这一层收口：
 *
 * 1. **一张图只有一个单位**：投入图只用分钟，进度图只用百分点。两个量纲不混进同一张图 ——
 *    混起来会把「投入了 60 分钟」读成「推进了 60 个百分点」。
 * 2. **零基线**：进度变化可能为负（下调），零基线以上是上调、以下是下调，并且带一句
 *    文字说明。**不用「越深越好」的色阶**：下调是事实，不是失败，也不代表热度。
 * 3. **等价数值表**：每张图都带一张数值表，悬停只是增强而不是唯一入口。
 *
 * 只用 CSS 画（规格 §9／§12：本阶段不新增依赖），没有图表库；图表本身对辅助技术
 * 隐藏（`aria-hidden`），可访问的等价物是那张表。
 *
 * 2026-10-19 密度修订（用户反馈「内容太多」）：
 * - 数值表从「每天一行、整行铺满」改成**多列成对排布**：周 2 对、月 4 对。行数减少
 *   一半以上，但每个日期仍然是一个独立的行标题、仍然可下钻。
 * - 柱宽封顶 2.75rem 并居中。此前柱宽由「列宽 × 72%」决定，单日周期会画出一根
 *   889px 宽的橙色方块，周视图也有 125px。
 * - 单日周期不画柱：一根柱子没有比较对象，图上的信息量为零。
 *
 * 2026-10-19 第二轮（用户：想看得更细）：
 * - 悬停柱子显示当天日期与数值（只是增强，不替代数值表）。
 * - 长周期（月）的数值表默认折叠成一句「每日数值（31 天）」，需要核对时再展开 ——
 *   内容仍在 DOM 里，键盘也能展开，不是把表格删掉。
 * - 右上角「放大」把图放进浮层：每根柱固定 3.5rem，日期刻度逐日可读；滚轮／拖动／
 *   方向键横向平移，不必再挤在一屏里。
 */

export interface ReviewChartRow {
  date: string;
  /** 图上的数值。投入图恒为非负；进度图可正可负。 */
  value: number;
  /** 数值表里的显示值：直接来自引擎的口径，不在页面里再算一次。 */
  label: string;
  /** 图下方的短刻度（周／月是日号，日是当天日期）。 */
  tick: string;
  /** 容器很窄时用的更短刻度（周视图「周一 10/19」→「周一」）。缺省时沿用 `tick`。 */
  tickShort?: string;
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
  /** 提供时，「详细」气泡改用它：周视图要同时看日期、星期、投入与百分点。 */
  splitDetail?: { date: string; fullLabel: string; weekday: string; minutes: string; delta: string }[];
  /** 提供时，数值表的日期成为可下钻的按钮（日期明细）。 */
  onOpenDate?: (date: string, trigger: HTMLElement) => void;
  /** 放大浮层是否打开（按钮已移到卡片标题行，状态由页面持有）。 */
  expanded: boolean;
  onExpand: (open: boolean) => void;
  /** 「详细」气泡是否打开；锚点也由页面传入。 */
  detailOpen: boolean;
  onDetailOpen: (open: boolean) => void;
  detailAnchor: RefObject<HTMLButtonElement | null>;
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
  // 量的是**表格那一格自己的宽度**：周视图并排时右边只有 14rem，只能放一对日期。
  const ref = useRef<HTMLDivElement | null>(null);
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

export function ReviewChart({ title, unit, rows, signed, baselineNote, emptyText, splitDetail, onOpenDate, expanded, onExpand, detailOpen, onDetailOpen, detailAnchor }: ReviewChartProps) {
  // 全零不画图：没有事实时画一排零柱会把「未记录」误读成「做了但没推进」。
  const hasValues = rows.some((row) => row.value !== 0);
  const maxUp = Math.max(0, ...rows.map((row) => row.value));
  const maxDown = Math.max(0, ...rows.map((row) => -row.value));
  const span = maxUp + maxDown;
  // 零基线在容器里的位置（从顶往下算）。非负图的零基线落在底部，有负值时上移。
  const zeroPercent = span === 0 ? 100 : (maxUp / span) * 100;
  const { ref, pairs } = usePairCount(rows.length);
  const single = rows.length === 1;
  // 长周期默认收起数值表：月视图 8 行表格会把图表挤到看不见。短周期只有一两行，展开更省事。
  const collapsible = rows.length > 7;
  // 一周只有 7 天：数值表折进「详细」气泡，图独占整列；月视图仍然是常驻的折叠表。
  const popoverTable = !single && rows.length <= 7;

  const barStyle = (value: number): CSSProperties => {
    if (value > 0) return { bottom: `${100 - zeroPercent}%`, height: `${(value / maxUp) * zeroPercent}%` };
    if (value < 0) return { top: `${zeroPercent}%`, height: `${(-value / maxDown) * (100 - zeroPercent)}%` };
    return { bottom: `${100 - zeroPercent}%`, height: "2px" };
  };
  const barClass = (value: number) => `review-chart-bar ${value > 0 ? "up" : value < 0 ? "down" : "flat"}`;
  /** 气泡挂在柱顶：底部位置 = 柱底 + 柱高。0 值挂在零基线上。 */
  const tipStyle = (value: number): CSSProperties => {
    if (value > 0) return { bottom: `${100 - zeroPercent + (value / maxUp) * zeroPercent}%` };
    if (value < 0) return { top: `${zeroPercent}%` };
    return { bottom: `${100 - zeroPercent}%` };
  };

  // 从「详细」气泡里点日期时先收起气泡，并把下钻推到下一个任务里执行：
  // 气泡关闭时宿主会在下一帧把焦点还给「详细」按钮，同一帧打开的明细会被抢走焦点，
  // Esc 就落不到明细自己身上了。等归还做完再开，明细的聚焦才是最后一次。
  const openFromPopover = (date: string, trigger: HTMLElement) => {
    onDetailOpen(false);
    window.setTimeout(() => onOpenDate?.(date, trigger), 0);
  };

  const dateCell = (row: ReviewChartRow) => onOpenDate
    ? <button type="button" className="review-chart-date" data-review-trigger={`date:${row.date}`} aria-label={`查看 ${row.fullLabel} 的明细`} onClick={(event) => { onDetailOpen(false); onOpenDate(row.date, event.currentTarget); }}>{row.fullLabel}</button>
    : row.fullLabel;

  /** 数值表：列对数由调用方给（页内按可用宽度算，气泡里固定一对）。 */
  const renderTable = (pairCount: number) => {
    const groups: ReviewChartRow[][] = [];
    for (let index = 0; index < rows.length; index += pairCount) groups.push(rows.slice(index, index + pairCount));
    return <table className={`review-chart-table${pairCount > 1 ? " is-multi" : ""}`} aria-label={`${title}（${unit}）等价数值表`}>
      <thead><tr>
        {Array.from({ length: pairCount }).map((_, index) => <PairHeader key={index} unit={unit} />)}
      </tr></thead>
      <tbody>
        {groups.map((group) => <tr key={group[0].date}>
          {group.map((row) => <Fragment key={row.date}>
            <th scope="row" data-chart-row={row.date}>{dateCell(row)}</th>
            {/* 零值／未记录降到次要色：31 天里通常有 20 多天没有记录，它们不该和真实数值抢注意力。 */}
            <td data-chart-cell={row.date} className={row.value === 0 ? "is-zero" : undefined}>{row.label}</td>
          </Fragment>)}
          {/* 末行不满时用一格跨列补齐：不能补空 <th>（axe 会报 empty-table-header），
              也不能不补（那一行的分隔线会断在半路）。 */}
          {pairCount - group.length > 0 && <td className="is-empty" colSpan={(pairCount - group.length) * 2} />}
        </tr>)}
      </tbody>
    </table>;
  };

  const plot = !single && <div className="review-chart" aria-hidden="true">
    <div className="review-chart-plot">
      <span className="review-chart-zero" style={{ top: `${zeroPercent}%` }} />
      {rows.map((row, index) => <div className="review-chart-column" key={row.date} data-chart-date={row.date} data-chart-value={row.value}>
        <span className={barClass(row.value)} style={barStyle(row.value)} />
        {/* 边缘几列的气泡贴边对齐，否则居中会让气泡越出卡片、把 #main-content 撑出横向滚动。 */}
        <span className={`review-chart-tip${index < 2 ? " is-start" : index > rows.length - 3 ? " is-end" : ""}`} style={tipStyle(row.value)}>{row.fullLabel} · {row.label}</span>
      </div>)}
    </div>
    <div className="review-chart-ticks">{rows.map((row) => <span key={row.date}>
      <span className="is-long">{row.tick}</span>
      {row.tickShort && <span className="is-short">{row.tickShort}</span>}
    </span>)}</div>
  </div>;

  // 等价数值表：与图上的柱一一对应，不依赖悬停，也不依赖颜色。
  // 月视图默认收起成一行摘要（表格仍在 DOM 里，键盘能展开）；周视图折进「详细」气泡。
  const slot = popoverTable ? null : <div className="review-chart-slot" ref={ref}>
    {collapsible
      ? <details className="review-chart-details"><summary>每日数值（{rows.length} 天）</summary>{renderTable(pairs)}</details>
      : renderTable(pairs)}
  </div>;

  return <figure className={`review-chart-figure${single ? " is-single" : ""}${popoverTable ? " is-week" : ""}`} aria-label={`${title}（${unit}）`}>
    {hasValues ? <>{plot}{slot}</> : <p className="review-chart-empty">{emptyText}</p>}

    {/* 单日没有零基线可比，这句说明只会变成噪音；正负号本身已经表达了方向。 */}
    {signed && hasValues && baselineNote && !single && <p className="review-chart-note">{baselineNote}</p>}

    {/* 周视图的数值表：「详细」按钮打开气泡，表格仍然是可键盘到达的等价物。 */}
    {detailOpen && <FloatingPanel kind="action" label={`${title}每日数值`} anchorElement={detailAnchor.current} closeOnOutsideClick
      className="review-chart-popover" onClose={() => onDetailOpen(false)}>
      {/* 宿主在时会统一处理 Esc；这里再兜一层，让页面单独渲染（测试、嵌入）时也能关。 */}
      <div onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onDetailOpen(false); } }}>
        {splitDetail
          ? <table className="review-chart-table is-split" aria-label={`${title}逐日数值`}>
            <thead><tr><th scope="col">日期</th><th scope="col">星期</th><th scope="col">投入时间</th><th scope="col">百分点</th></tr></thead>
            <tbody>{splitDetail.map((row) => <tr key={row.date}>
              <th scope="row" data-chart-row={row.date}>{onOpenDate
                ? <button type="button" className="review-chart-date" data-review-trigger={`date:${row.date}`} aria-label={`查看 ${row.fullLabel} 的明细`} onClick={(event) => openFromPopover(row.date, event.currentTarget)}>{row.fullLabel}</button>
                : row.fullLabel}</th>
              <td>{row.weekday}</td>
              <td>{row.minutes}</td>
              <td>{row.delta}</td>
            </tr>)}</tbody>
          </table>
          : renderTable(1)}
      </div>
    </FloatingPanel>}

    {expanded && <ExpandedChart title={title} unit={unit} rows={rows} signed={signed} zeroPercent={zeroPercent} maxUp={maxUp} maxDown={maxDown} onClose={() => onExpand(false)} />}
  </figure>;
}

function PairHeader({ unit }: { unit: string }) {
  return <><th scope="col">日期</th><th scope="col">{unit}</th></>;
}

/**
 * 放大视图：每根柱固定 3.5rem，日期刻度逐日可读。
 *
 * 平移三种方式都要有：滚轮（原生非 passive 监听 —— React 把 `onWheel` 注册成 passive，
 * `preventDefault()` 会被忽略，页面会跟着滚）、拖动（指针捕获）、方向键（容器
 * `tabIndex=0`，浏览器自带横向滚动）。
 */
function ExpandedChart({ title, unit, rows, signed, zeroPercent, maxUp, maxDown, onClose }: {
  title: string; unit: string; rows: ReviewChartRow[]; signed?: boolean;
  zeroPercent: number; maxUp: number; maxDown: number; onClose: () => void;
}) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const headingId = `review-chart-expanded-${title}`;
  useOverlayLayer("review-chart-expanded", { kind: "confirm", dismissible: true, onDismiss: onClose });

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (node.scrollWidth <= node.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (delta === 0) return;
      event.preventDefault();
      node.scrollLeft += delta;
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => { scroller.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const drag = useRef<{ x: number; left: number } | null>(null);
  const barStyle = (value: number): CSSProperties => {
    if (value > 0) return { bottom: `${100 - zeroPercent}%`, height: `${(value / maxUp) * zeroPercent}%` };
    if (value < 0) return { top: `${zeroPercent}%`, height: `${(-value / maxDown) * (100 - zeroPercent)}%` };
    return { bottom: `${100 - zeroPercent}%`, height: "2px" };
  };
  /** 数值标签挂在柱顶（和上面气泡同一套算法）；柱子顶到 100% 时靠图顶留白接住。 */
  const valueStyle = (value: number): CSSProperties => {
    if (value > 0) return { bottom: `${100 - zeroPercent + (value / maxUp) * zeroPercent}%` };
    if (value < 0) return { top: `${zeroPercent}%` };
    return { bottom: `${100 - zeroPercent}%` };
  };
  /** 悬停气泡里的完整说法：0 要说清是「没有记录」还是「没有变化」。 */
  const valueText = (value: number) => value === 0
    ? (signed ? "没有变化" : "没有记录")
    : `${value > 0 && signed ? "+" : ""}${Math.round(value)} ${unit}`;
  // 一周只有 7 根柱：浮层跟着内容收窄，不再撑满 1120px。
  const modalWidth = `min(calc(${rows.length * 3.5}rem + 5rem), 1120px, 100%)`;

  return createPortal(<div className="chart-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="chart-modal" style={{ width: modalWidth }} role="dialog" aria-modal="true" aria-labelledby={headingId}>
      <header>
        <div><h2 id={headingId}>{title}</h2><span>单位：{unit}</span></div>
        <button type="button" className="chart-modal-close" aria-label="关闭放大的图表" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="chart-modal-scroll" ref={scroller} tabIndex={0} role="group" aria-label={`${title}图表，可左右滚动`}
        onPointerDown={(event) => { drag.current = { x: event.clientX, left: event.currentTarget.scrollLeft }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={(event) => { const state = drag.current; if (!state) return; event.currentTarget.scrollLeft = state.left - (event.clientX - state.x); }}
        onPointerUp={(event) => { drag.current = null; if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { drag.current = null; }}>
        <div className="chart-modal-plot" style={{ width: `${rows.length * 3.5}rem` }} aria-hidden="true">
          <span className="review-chart-zero" style={{ top: `${zeroPercent}%` }} />
          {rows.map((row) => <div className="chart-modal-column" key={row.date} data-chart-date={row.date} data-chart-value={row.value}>
            <span className="chart-modal-value" style={valueStyle(row.value)}>{row.value === 0 ? "—" : `${row.value > 0 && signed ? "+" : ""}${Math.round(row.value)}`}</span>
            <span className={`review-chart-bar ${row.value > 0 ? "up" : row.value < 0 ? "down" : "flat"}`} style={barStyle(row.value)} />
            <span className="chart-modal-tick">{row.fullLabel}</span>
            <span className="chart-modal-tip">{row.fullLabel} · {valueText(row.value)}</span>
          </div>)}
        </div>
      </div>
    </section>
  </div>, document.body);
}
