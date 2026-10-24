import { useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";

interface NumberFieldProps {
  id?: string;
  label: string;
  value: number | null;
  min: number;
  max: number;
  step?: number;
  suffix: string;
  /** 允许清空（可选字段，例如「预计耗时」）。清空后回调 `null`。 */
  nullable?: boolean;
  /** 常用值。只在 [min, max] 内的会显示成一行快捷选项。 */
  presets?: readonly number[];
  disabled?: boolean;
  onChange: (value: number | null) => void;
}

/**
 * 数值输入（分钟 / 百分比 / 个数）的统一控件：一个外框 + 两侧步进 + 单位后缀。
 *
 * 为什么要有它：分钟输入散在任务编辑、习惯、时间块、设置等 5 处，此前各写一个
 * `input[type=number]`，范围（1–1440 / 5–240 / 0–120）、步长和单位后缀全不一致，
 * 原生微调箭头还会随浏览器/缩放变样。这里把它们收成同一套：外框 46px、10px 圆角、
 * `--panel-strong` 底，与 select / 分段控件同一尺寸；单位作为后缀常驻，不写在标签里。
 *
 * 根节点用 `<span>`：这些控件经常整个塞在 `<label>` 里，`<div>` 会让 label 的
 * 内容模型不合法（label 只允许 phrasing content）。
 *
 * 输入框上**不写 **：HTML 的步长基准是 ， +  会把 60
 * 这种合法值判成非法，原生校验会直接挡住整个表单提交（任务编辑器踩过）。
 * ± 的步长由本组件的  属性在 JS 里控制，键盘上下键按 1 走。
 *
 * 步进按钮 `tabIndex={-1}`：键盘用户直接对着输入框按 ↑/↓ 或输入数字即可，
 * 三个 Tab 停靠点会把设置页的键盘路径拖得很长；鼠标用户仍然可以点 ±。
 * 输入过程中保留草稿（允许清空重打），失焦或回车才夹到 [min, max]。
 *
 * 根节点上**必须**拦住「点空白处」的默认行为：这个控件常被整个塞进 `<label>`，
 * 而 label 的点击激活只会转给**第一个**可关联元素 —— 也就是减号。于是点单位后缀、
 * 点外框内的空白、点标签文字，都会让数值莫名掉一档（2026-10-24 用户实测：点右侧
 * 留白 −5）。这里把这类点击改成聚焦输入框，和普通文本框的手感一致。
 */
export function NumberField({ id, label, value, min, max, step = 1, suffix, nullable = false, presets, disabled = false, onChange }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const shown = draft ?? (value === null ? "" : String(value));
  const current = value ?? min;
  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  const usablePresets = (presets ?? []).filter((preset) => preset >= min && preset <= max);

  // 外部值变化（步进按钮、快捷选项、重置）时清掉草稿，否则输入框会停在旧文本上。
  useEffect(() => { if (draft !== null && Number(draft) === value) setDraft(null); }, [value, draft]);

  const commit = (raw: string) => {
    setDraft(null);
    if (raw.trim() === "") { if (nullable && value !== null) onChange(null); return; }
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) return;
    const next = clamp(parsed);
    if (next !== value) onChange(next);
  };

  const stepBy = (delta: number) => {
    setDraft(null);
    const next = clamp(current + delta);
    if (next !== value) onChange(next);
  };

  return (
    <span
      className="number-field-wrap"
      onClick={(event) => {
        // 点在 ± 或输入框上照常走各自的行为；其余位置（单位后缀、外框内空白）
        // 只把焦点交给输入框，不能让外层 label 把它转成一次减号点击。
        if ((event.target as HTMLElement).closest("button, input")) return;
        event.preventDefault();
        inputRef.current?.focus();
      }}
    >
      <span className={`number-field${disabled ? " is-disabled" : ""}`}>
        <button type="button" className="number-step" tabIndex={-1} aria-label={`减少 ${step} ${suffix}`} disabled={disabled || current <= min} onClick={() => stepBy(-step)}>
          <Minus size={14} aria-hidden="true" />
        </button>
        <span className="number-box">
          <input
            id={id}
            ref={inputRef}
            className="number-input"
            type="number"
            inputMode="numeric"
            aria-label={label}
            placeholder={nullable ? "—" : undefined}
            min={min}
            max={max}
            value={shown}
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { commit((event.target as HTMLInputElement).value); inputRef.current?.blur(); } }}
          />
          <span className="number-suffix" aria-hidden="true">{suffix}</span>
        </span>
        <button type="button" className="number-step" tabIndex={-1} aria-label={`增加 ${step} ${suffix}`} disabled={disabled || current >= max} onClick={() => stepBy(step)}>
          <Plus size={14} aria-hidden="true" />
        </button>
      </span>
      {usablePresets.length > 0 && <span className="number-presets">{usablePresets.map((preset) => <button key={preset} type="button" className={`number-preset${value === preset ? " is-active" : ""}`} aria-label={`设为 ${preset} ${suffix}`} aria-pressed={value === preset} disabled={disabled} onClick={(event) => { setDraft(null); onChange(preset); /* 鼠标点完交还焦点，气泡只跟悬停走；键盘操作保留焦点。 */ if (event.detail > 0) event.currentTarget.blur(); }}>{preset}</button>)}</span>}
    </span>
  );
}
