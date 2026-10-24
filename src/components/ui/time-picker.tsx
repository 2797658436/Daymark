import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { FloatingPanel } from "./floating-panel";

/**
 * 时间选择：一个长得像输入框的按钮 + 两列滚轮浮层。
 *
 * 为什么不用 `<input type="time">`：原生控件点下去只会把焦点落到**某一段**（时或分），
 * 实测点文字再敲 `0830` 会变成 `21:30` —— 用户既不知道改的是哪段，也没法「打开就选」。
 * 这里把整块做成按钮：点一下弹滚轮，选完点外面关闭；键盘仍可 ↑/↓ 按 5 分钟微调。
 *
 * 布局按项目口径（2026-10-18 用户定稿）：**两列数字 + 中间的冒号**，不写成 `:00`；
 * 浮层比输入框窄（12rem），选中行字号加大一档、颜色用 accent-strong。
 */

const ITEM_HEIGHT = 30;
/**
 * 空值打开滚轮时的落点。只是滚轮的初始位置 —— 不选就不会写回草稿，
 * 与 `App` 里习惯排程的兜底值（默认晚间时段的起点，出厂为 19:00）对齐。
 */
const EMPTY_ANCHOR = "19:00";

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function parseClock(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return { hour: Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 0, minute: Number.isFinite(minute) ? Math.min(59, Math.max(0, minute)) : 0 };
}

function clockAt(total: number) {
  const value = ((total % 1440) + 1440) % 1440;
  return `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
}

interface WheelColumnProps {
  label: string;
  values: number[];
  active: number;
  onSelect: (value: number) => void;
}

function WheelColumn({ label, values, active, onSelect }: WheelColumnProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const reactId = useId();
  const index = Math.max(0, values.indexOf(active));
  const settleTimer = useRef<number | null>(null);
  const indexRef = useRef(index);
  indexRef.current = index;

  // 行高必须**量出来**：`.wheel-item` 用 rem，界面缩放到 200% 时会变成 60px，
  // 写死 30 会让「滚到哪算选中」整体错位。
  const itemHeight = useCallback(() => ref.current?.querySelector<HTMLElement>(".wheel-item")?.getBoundingClientRect().height || ITEM_HEIGHT, []);

  // 选中值变化（点击、键盘、外部更新）时把对应行滚到中间。
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const target = index * itemHeight();
    if (Math.abs(element.scrollTop - target) > 2) element.scrollTop = target;
  }, [index, itemHeight]);

  useEffect(() => () => { if (settleTimer.current) window.clearTimeout(settleTimer.current); }, []);

  // 滚动停止 80ms 后取「最靠近中线的那一行」——滚轮不需要松手回调。
  const settle = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const height = itemHeight();
    const next = Math.min(values.length - 1, Math.max(0, Math.round(element.scrollTop / height)));
    if (values[next] !== values[indexRef.current]) onSelect(values[next]);
  }, [itemHeight, onSelect, values]);

  return (
    <div
      ref={ref}
      className="wheel-column"
      role="listbox"
      aria-label={label}
      aria-activedescendant={`${reactId}-${index}`}
      tabIndex={0}
      onScroll={() => {
        if (settleTimer.current) window.clearTimeout(settleTimer.current);
        settleTimer.current = window.setTimeout(settle, 80);
      }}
      onKeyDown={(event) => {
        const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : event.key === "PageUp" ? -5 : event.key === "PageDown" ? 5 : 0;
        const jump = event.key === "Home" ? 0 : event.key === "End" ? values.length - 1 : null;
        if (!step && jump === null) return;
        event.preventDefault();
        onSelect(values[Math.min(values.length - 1, Math.max(0, jump ?? index + step))]);
      }}
    >
      {values.map((value, at) => (
        <div
          key={value}
          id={`${reactId}-${at}`}
          role="option"
          aria-selected={at === index}
          className={at === index ? "wheel-item is-active" : "wheel-item"}
          onClick={() => onSelect(value)}
        >
          {pad(value)}
        </div>
      ))}
    </div>
  );
}

function TimeWheel({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { hour, minute } = parseClock(value);
  const hours = Array.from({ length: 24 }, (_, index) => index);
  // 分钟按 5 分钟一档，但把当前值也放进去 —— 旧数据里的 21:07 不会被静默吞掉。
  const minutes = Array.from(new Set([...Array.from({ length: 12 }, (_, index) => index * 5), minute])).sort((left, right) => left - right);
  return (
    <div className="time-wheel">
      <span className="time-wheel-band" aria-hidden="true" />
      <WheelColumn label="小时" values={hours} active={hour} onSelect={(next) => onChange(`${pad(next)}:${pad(minute)}`)} />
      <span className="time-wheel-colon" aria-hidden="true">:</span>
      <WheelColumn label="分钟" values={minutes} active={minute} onSelect={(next) => onChange(`${pad(hour)}:${pad(next)}`)} />
    </div>
  );
}

interface TimeFieldProps {
  /** 朗读用前缀，例如「开始时间」。按钮可见文字只有 `21:00`。 */
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** 空值时按钮上的灰字（可选字段用，例如「未设置」）。不传则保持空白。 */
  placeholder?: string;
  /** 允许清除：浮层底部多一个「清除」，把值改回空字符串。 */
  allowClear?: boolean;
}

export function TimeField({ label, value, onChange, disabled, placeholder = "", allowClear = false }: TimeFieldProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // 空值也把滚轮摆在有意义的位置：否则会从 00:00 开始，选一次就要滚十几屏。
  const anchor = value || EMPTY_ANCHOR;
  const minutes = parseClock(anchor);
  const shown = value || placeholder;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`time-field${value ? "" : " is-empty"}`}
        aria-label={`${label} ${shown}`.trim()}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          // 不开浮层也能改：↑/↓ 走 5 分钟，PageUp/PageDown 走一小时。
          const delta = event.key === "ArrowUp" ? 5 : event.key === "ArrowDown" ? -5 : event.key === "PageUp" ? 60 : event.key === "PageDown" ? -60 : 0;
          if (!delta) return;
          event.preventDefault();
          onChange(clockAt(minutes.hour * 60 + minutes.minute + delta));
        }}
      >
        {shown}
      </button>
      {open && (
        <FloatingPanel
          kind="action"
          label={`选择${label}`}
          anchorElement={buttonRef.current}
          className="time-picker-popover"
          closeOnOutsideClick
          onClose={() => setOpen(false)}
        >
          <TimeWheel value={anchor} onChange={onChange} />
          {allowClear && value && (
            <div className="time-picker-foot">
              <button type="button" onClick={() => { onChange(""); setOpen(false); }}>清除</button>
            </div>
          )}
        </FloatingPanel>
      )}
    </>
  );
}

