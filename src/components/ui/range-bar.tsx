import type { CSSProperties } from "react";

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
  className?: string;
}

export function RangeBar({ id, label, min, max, step, value, onChange, onPointerUp, onKeyUp, compact, dots, ariaValueText, className }: RangeBarProps) {
  const span = max - min;
  const percent = span > 0 ? Math.min(100, Math.max(0, ((value - min) / span) * 100)) : 0;
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
        aria-valuetext={ariaValueText}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerUp={onPointerUp}
        onKeyUp={onKeyUp}
      />
    </span>
  );
}
