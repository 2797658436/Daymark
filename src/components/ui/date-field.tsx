import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";

import { WEEKDAY_LABELS, monthRows, shiftMonth } from "../../lib/calendar-grid";
import { FloatingPanel } from "./floating-panel";

/**
 * 日期字段：圆角按钮 + 自绘月历，不用原生 `input[type=date]`。
 *
 * 原生日期控件的样子由浏览器决定（深色主题下更是另一套），和界面的圆角语言对不上。
 * 这里给的是：按钮显示当前日期；悬停浮出快捷天数；点击打开月历。
 */
export function DateField({ value, onChange, today, label, placeholder = "未设置", allowClear = true }: {
  value: string | null;
  onChange: (value: string | null) => void;
  today: string;
  label: string;
  placeholder?: string;
  allowClear?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => (value ?? today).slice(0, 7));
  const button = useRef<HTMLButtonElement | null>(null);

  useEffect(() => { if (open) setMonth((value ?? today).slice(0, 7)); }, [open, value, today]);

  const quick = [
    { text: "今日", date: today },
    { text: "明日", date: addDays(today, 1) },
    { text: "+2 日", date: addDays(today, 2) },
    { text: "+7 日", date: addDays(today, 7) },
  ];

  return <span className="date-field">
    <button ref={button} type="button" className={`date-field-button${value ? "" : " is-empty"}`} aria-label={`${label}：${value ?? placeholder}`}
      aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <CalendarDays size={14} aria-hidden="true" />
      <span>{value ? formatFieldDate(value) : placeholder}</span>
    </button>
    {value && allowClear && <button type="button" className="date-field-clear" aria-label={`清除${label}`} onClick={() => onChange(null)}><X size={13} /></button>}

    {/* 悬停浮出快捷天数：只改值，不打开月历。 */}
    <span className="date-field-quick" role="group" aria-label={`${label}快捷设置`}>
      {quick.map((item) => <button key={item.text} type="button" className={value === item.date ? "is-active" : ""}
        onClick={() => onChange(item.date)}>{item.text}</button>)}
    </span>

    {open && <FloatingPanel kind="action" label={`选择${label}`} anchorElement={button.current} closeOnOutsideClick
      className="date-field-panel" onClose={() => setOpen(false)}>
      <div className="review-picker-head">
        <button type="button" aria-label="上个月" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft size={15} /></button>
        <strong>{Number(month.slice(0, 4))} 年 {Number(month.slice(5, 7))} 月</strong>
        <button type="button" aria-label="下个月" onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight size={15} /></button>
      </div>
      <div className="review-picker-weekdays" aria-hidden="true">{WEEKDAY_LABELS.map((text) => <span key={text}>{text}</span>)}</div>
      <div className="review-picker-grid">
        {monthRows(month).map((row) => <div className="review-picker-row" key={row.find(Boolean) ?? "empty"}>
          {row.map((date, index) => date === null
            ? <span key={`empty-${index}`} className="review-picker-day is-empty" />
            : <button key={date} type="button"
              className={["review-picker-day", date === today ? "is-today" : "", date === value ? "is-active" : ""].filter(Boolean).join(" ")}
              aria-label={formatFieldDate(date, true)}
              onClick={() => { onChange(date); setOpen(false); }}>
              {Number(date.slice(8, 10))}
            </button>)}
        </div>)}
      </div>
      <div className="date-field-panel-foot">
        <button type="button" onClick={() => { onChange(null); setOpen(false); }}>清除</button>
        <button type="button" onClick={() => { onChange(today); setOpen(false); }}>设为今天</button>
      </div>
    </FloatingPanel>}
  </span>;
}

export function addDays(date: string, delta: number) {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(year, month - 1, day + delta);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
}

function formatFieldDate(date: string, full = false) {
  const [year, month, day] = date.split("-").map(Number);
  return full ? `${year} 年 ${month} 月 ${day} 日` : `${month} 月 ${day} 日`;
}
