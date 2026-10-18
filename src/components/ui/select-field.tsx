/**
 * 统一的下拉控件：原生 `select` 负责交互、键盘与弹层，另叠一层自绘文字。
 *
 * 为什么要多这一层：`appearance: base-select` 下浏览器把 select 的 `overflow` 强制成
 * `visible`，`text-overflow: ellipsis` 永远不生效（overflow / clip / contain / mask 与
 * `::after` 插省略号五种写法都实测过），长文案只能横向溢出、或者换行撑破固定高度。
 * 只有自己画的这层能真正截断成 `…`，同时保证箭头始终贴在右边。
 *
 * 约定：
 *  - 文字层 `aria-hidden` + `pointer-events: none`，读屏与点击仍然落到原生 select 上；
 *  - `id` 转发给 select，设置页的 `<label htmlFor>` 不受影响；
 *  - 值统一按**字符串**进出，数字型调用点自己 `Number()` 回来（唯一允许的转换点）。
 */
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectFieldProps {
  id?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

export function SelectField({ id, value, options, onChange, disabled, className }: SelectFieldProps) {
  const current = options.find((option) => option.value === value);
  return (
    <span className={className ? `select-shell ${className}` : "select-shell"}>
      <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
        ))}
      </select>
      <span className="select-display" aria-hidden="true"><span>{current?.label ?? ""}</span></span>
    </span>
  );
}
