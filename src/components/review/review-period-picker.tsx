import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";

import { reviewRange, type ReviewPeriod } from "../../lib/review";
import { WEEKDAY_LABELS, monthRows, shiftMonth, type MonthCell } from "../../lib/calendar-grid";
import { FloatingPanel } from "../ui/floating-panel";

/**
 * 周期选择器：一个按钮打开日历，形状跟着当前周期走 —— 卡片里不再放第二套
 * 「日／周／月」，那一排已经由页头提供了，放两遍只会互相打架。
 *
 * - 日：月历，点某一天跳过去。
 * - 周：还是月历，但每一行是一整条可点的横条（周一起头），悬停整条高亮。
 * - 月：年视图，12 个月四列三行，`<` / `>` 换年。
 *
 * 相邻月份的日期也画出来并且可点，只是颜色浅一级。
 */
const MONTH_LABEL = ["1 月", "2 月", "3 月", "4 月", "5 月", "6 月", "7 月", "8 月", "9 月", "10 月", "11 月", "12 月"];

const monthOf = (date: string) => date.slice(0, 7);
/** 给读屏用的完整中文日期：2026 年 3 月 12 日。 */
const cnDate = (date: string) => `${Number(date.slice(0, 4))} 年 ${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日`;
const yearOf = (date: string) => Number(date.slice(0, 4));

export function ReviewPeriodPicker({ period, anchorDate, today, onSelect }: {
  period: ReviewPeriod;
  anchorDate: string;
  today: string;
  onSelect: (period: ReviewPeriod, anchor: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => monthOf(anchorDate));
  const [year, setYear] = useState(() => yearOf(anchorDate));
  const button = useRef<HTMLButtonElement | null>(null);

  // 每次打开都回到当前周期所在的位置，而不是上次翻到的地方。
  useEffect(() => {
    if (!open) return;
    setMonth(monthOf(anchorDate));
    setYear(yearOf(anchorDate));
  }, [open, anchorDate]);

  const rows = useMemo(() => monthRows(month), [month]);
  const week = reviewRange("week", anchorDate);
  const inCurrentWeek = (date: string) => date >= week.startDate && date <= week.endDate;

  const choose = (anchor: string) => {
    onSelect(period, anchor);
    setOpen(false);
  };

  const dayClass = (cell: MonthCell) => ["review-picker-day",
    cell.outside ? "is-outside" : "",
    cell.date === today ? "is-today" : "",
    period === "day" && cell.date === anchorDate ? "is-active" : ""].filter(Boolean).join(" ");

  return <>
    <button ref={button} type="button" className="review-picker-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <CalendarDays size={15} />选择日期
    </button>
    {open && <FloatingPanel kind="action" label="选择回顾日期" anchorElement={button.current} closeOnOutsideClick
      className="review-picker" onClose={() => setOpen(false)}>
      {period === "month" ? <>
        <div className="review-picker-head">
          <button type="button" aria-label="上一年" onClick={() => setYear(year - 1)}><ChevronLeft size={15} /></button>
          <strong>{year} 年</strong>
          <button type="button" aria-label="下一年" onClick={() => setYear(year + 1)}><ChevronRight size={15} /></button>
        </div>
        <div className="review-picker-months">
          {MONTH_LABEL.map((text, index) => {
            const active = yearOf(anchorDate) === year && Number(anchorDate.slice(5, 7)) === index + 1;
            return <button key={text} type="button" aria-pressed={active} className={active ? "is-active" : undefined}
              onClick={() => choose(`${year}-${String(index + 1).padStart(2, "0")}-01`)}>{text}</button>;
          })}
        </div>
      </> : <>
        <div className="review-picker-head">
          <button type="button" aria-label="上个月" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft size={15} /></button>
          <strong>{Number(month.slice(0, 4))} 年 {Number(month.slice(5, 7))} 月</strong>
          <button type="button" aria-label="下个月" onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight size={15} /></button>
        </div>
        <div className="review-picker-weekdays" aria-hidden="true">{WEEKDAY_LABELS.map((text) => <span key={text}>{text}</span>)}</div>
        {period === "week"
          // 周模式：一行就是一周，整条横条可点，比七个方块更像「一周」。
          ? <div className="review-picker-grid is-week">
            {rows.map((row) => <button key={row[0].date} type="button" className={`review-picker-week${inCurrentWeek(row[0].date) ? " is-current" : ""}`}
              aria-label={`${cnDate(row[0].date)} 那一周`} onClick={() => choose(row[0].date)}>
              {row.map((cell) => <span key={cell.date} className={`review-picker-week-day${cell.outside ? " is-outside" : ""}${cell.date === today ? " is-today" : ""}`}>{Number(cell.date.slice(8, 10))}</span>)}
            </button>)}
          </div>
          : <div className="review-picker-grid">
            {rows.map((row) => <div className="review-picker-row" key={row[0].date}>
              {row.map((cell) => <button key={cell.date} type="button" className={dayClass(cell)}
                aria-label={cnDate(cell.date)} aria-current={cell.date === today ? "date" : undefined}
                onClick={() => choose(cell.date)}>
                {Number(cell.date.slice(8, 10))}
              </button>)}
            </div>)}
          </div>}
      </>}
    </FloatingPanel>}
  </>;
}
