import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";

import { reviewRange, type ReviewPeriod } from "../../lib/review";
import { WEEKDAY_LABELS as WEEKDAY, monthRows, shiftMonth } from "../../lib/calendar-grid";
import { FloatingPanel } from "../ui/floating-panel";

/**
 * 周期选择器：一个按钮打开日历，日历里再选「日／周／月」。
 *
 * 三种模式的格子形状不同：
 * - 日：月历，点某一天跳过去。
 * - 周：还是月历，但一行就是一周（周一起头），悬停整行高亮，点哪一格都落到那一周。
 * - 月：年视图，12 个月一格，`<` / `>` 换年。
 *
 * 几何全部走 CSS（圆角 8px 的格子、12px 的面板），和界面其它浮层同一套 token。
 */
const MONTH_LABEL = ["1 月", "2 月", "3 月", "4 月", "5 月", "6 月", "7 月", "8 月", "9 月", "10 月", "11 月", "12 月"];

const pad = (value: number) => String(value).padStart(2, "0");
const monthOf = (date: string) => date.slice(0, 7);
const yearOf = (date: string) => Number(date.slice(0, 4));

export function ReviewPeriodPicker({ period, anchorDate, today, onSelect }: {
  period: ReviewPeriod;
  anchorDate: string;
  today: string;
  onSelect: (period: ReviewPeriod, anchor: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ReviewPeriod>(period);
  const [month, setMonth] = useState(() => monthOf(anchorDate));
  const [year, setYear] = useState(() => yearOf(anchorDate));
  const button = useRef<HTMLButtonElement | null>(null);

  // 每次打开都回到当前周期所在的位置，而不是上次翻到的地方。
  useEffect(() => {
    if (!open) return;
    setMode(period);
    setMonth(monthOf(anchorDate));
    setYear(yearOf(anchorDate));
  }, [open, period, anchorDate]);

  const rows = useMemo(() => monthRows(month), [month]);
  const currentWeek = period === "week" ? reviewRange("week", anchorDate) : null;
  const inCurrentWeek = (date: string | null) => Boolean(date && currentWeek && date >= currentWeek.startDate && date <= currentWeek.endDate);

  const choose = (next: ReviewPeriod, anchor: string) => {
    onSelect(next, anchor);
    setOpen(false);
  };

  return <>
    <button ref={button} type="button" className="review-picker-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <CalendarDays size={15} />选择日期
    </button>
    {open && <FloatingPanel kind="action" label="选择回顾周期" anchorElement={button.current} closeOnOutsideClick
      className="review-picker" onClose={() => setOpen(false)}>
      <div className="segmented review-picker-mode" role="group" aria-label="选择周期类型">
        {(["day", "week", "month"] as ReviewPeriod[]).map((option) => <button key={option} type="button" aria-pressed={mode === option}
          className={mode === option ? "active" : ""} onClick={() => setMode(option)}>
          {option === "day" ? "日" : option === "week" ? "周" : "月"}
        </button>)}
      </div>

      {mode === "month" ? <>
        <div className="review-picker-head">
          <button type="button" aria-label="上一年" onClick={() => setYear(year - 1)}><ChevronLeft size={15} /></button>
          <strong>{year} 年</strong>
          <button type="button" aria-label="下一年" onClick={() => setYear(year + 1)}><ChevronRight size={15} /></button>
        </div>
        <div className="review-picker-months">
          {MONTH_LABEL.map((text, index) => {
            const value = `${year}-${pad(index + 1)}-01`;
            const active = yearOf(anchorDate) === year && Number(anchorDate.slice(5, 7)) === index + 1 && period === "month";
            return <button key={text} type="button" aria-pressed={active} className={active ? "is-active" : undefined}
              onClick={() => choose("month", value)}>{text}</button>;
          })}
        </div>
      </> : <>
        <div className="review-picker-head">
          <button type="button" aria-label="上个月" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft size={15} /></button>
          <strong>{Number(month.slice(0, 4))} 年 {Number(month.slice(5, 7))} 月</strong>
          <button type="button" aria-label="下个月" onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight size={15} /></button>
        </div>
        <div className="review-picker-weekdays" aria-hidden="true">{WEEKDAY.map((text) => <span key={text}>{text}</span>)}</div>
        <div className={`review-picker-grid${mode === "week" ? " is-week" : ""}`}>
          {rows.map((row) => <div className={`review-picker-row${mode === "week" && row.some(inCurrentWeek) ? " is-current" : ""}`} key={row.find(Boolean) ?? Math.random()}>
            {row.map((date, index) => date === null
              ? <span key={`empty-${index}`} className="review-picker-day is-empty" />
              : <button key={date} type="button"
                className={["review-picker-day",
                  date === today ? "is-today" : "",
                  mode === "day" && date === anchorDate && period === "day" ? "is-active" : "",
                  mode === "week" && inCurrentWeek(date) ? "is-active" : ""].filter(Boolean).join(" ")}
                aria-label={formatPickerDate(date, true)}
                aria-current={date === today ? "date" : undefined}
                onClick={() => choose(mode, date)}>
                {Number(date.slice(8, 10))}
              </button>)}
          </div>)}
        </div>
        {mode === "week" && <p className="review-picker-hint">点任意一格，查看它所在的一周</p>}
      </>}
    </FloatingPanel>}
  </>;
}

function formatPickerDate(date: string, full = false) {
  const [year, month, day] = date.split("-").map(Number);
  return full ? `${year} 年 ${month} 月 ${day} 日` : `${month} 月 ${day} 日`;
}
