import { useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * 滑块 = 轨道里一块留出间隙的实心进度块，没有拖手。
 *
 * 为什么不是直接给 `<input type="range">` 上样式：
 *  - 填充块要**内缩**（四周 4px 间隙、自己的圆角），渐变 + `background-clip` 做不到「块」的效果；
 *  - 吸附点要画在填充块**下面**（被盖住的点自动消失），需要独立的图层。
 * 所以这里用一层视觉结构（track / fill / dot）+ 一层透明的原生 input：
 * 键盘、拖动、`fill()`、读屏语义全部保持原生行为，焦点环画在外层。
 */
interface RangeBarProps {
  id?: string;
  /** 没有外层 `<label>` 时用它提供可访问名。 */
  label?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  onPointerUp?: () => void;
  onKeyUp?: () => void;
  compact?: boolean;
  /** 吸附档位在 0–1 之间的位置，例如 `[0.25, 0.5, 0.75]`。 */
  dots?: number[];
  ariaValueText?: string;
  /**
   * true 时拖动只移动视觉，松手（或键盘抬起、失焦）才提交。
   *
   * 界面缩放必须这样：滑块宽度是 rem，边拖边缩放会让轨道自己在指针下变形，
   * 拖到一半就抓不住了。拖动期间用本地 draft 画填充，提交后才真正改设置。
   */
  commitOnRelease?: boolean;
  /** 提交前的可访问值文本，例如 `(v) => `${v}%``。拖动中也要跟着变。 */
  formatValue?: (value: number) => string;
  className?: string;
}

export function RangeBar({ id, label, min, max, step, value, onChange, onPointerUp, onKeyUp, compact, dots, ariaValueText, commitOnRelease, formatValue, className }: RangeBarProps) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  const span = max - min;
  const percent = span > 0 ? Math.min(100, Math.max(0, ((shown - min) / span) * 100)) : 0;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const commitRef = useRef<() => void>(() => {});
  commitRef.current = () => {
    if (draft === null) return;
    onChange(draft);
    setDraft(null);
  };
  // 用原生 change 事件提交：它在松手时触发一次（键盘也是一次）。
  // pointerup / keyup 覆盖不到 fill() 这类程序化赋值，而测试与自动化正是走那条路。
  useEffect(() => {
    if (!commitOnRelease) return;
    const element = inputRef.current;
    if (!element) return;
    const handler = () => commitRef.current();
    element.addEventListener("change", handler);
    return () => element.removeEventListener("change", handler);
  }, [commitOnRelease]);
  return (
    <span className={["range-bar", compact ? "is-compact" : "", className ?? ""].filter(Boolean).join(" ")}>
      <span className="range-track" aria-hidden="true">
        <span className="range-inner">
          {dots?.map((dot) => <i key={dot} className="range-dot" style={{ left: `${dot * 100}%` } as CSSProperties} />)}
          {/* `max(...)` 保证 0% 时也留一个起点小块，否则轨道看起来是空的。 */}
          <span className="range-fill" style={{ width: `max(.375rem, ${percent}%)` } as CSSProperties} />
        </span>
      </span>
      <input
        className="range-input"
        type="range"
        id={id}
        aria-label={label}
        aria-valuetext={formatValue ? formatValue(shown) : ariaValueText}
        min={min}
        max={max}
        step={step}
        ref={inputRef}
        value={shown}
        onChange={(event) => { const next = Number(event.target.value); if (commitOnRelease) setDraft(next); else onChange(next); }}
        onPointerUp={onPointerUp}
        onKeyUp={onKeyUp}
        onBlur={() => commitRef.current()}
      />
    </span>
  );
}
