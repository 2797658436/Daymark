import { useId, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";

/**
 * 设置页的展示型构件（B 方案：单列分组 + 标准设置行）。
 *
 * 只负责结构与样式，不持有偏好、不读写 Store —— 保存仍由 `App` 的同一条写入队列负责。
 * 四条既定口径：
 *  1. 开关保留 `input[type=checkbox]` 语义，只换外观（改 role 会打断既有测试与读屏习惯）；
 *  2. 分段选择用原生 radio + `role="radiogroup"`，视觉 32px、命中区 44px；
 *  3. 依赖项是**圆角子格子**，关闭态靠 `--muted-strong` 而不是整体透明度
 *     （P4-13 立的规矩：不用 `opacity` 做去强调）；
 *  4. 单项重置只在**偏离默认值**时出现，位置在控件框外 —— 固定宽度的槽保证同一列控件
 *     始终右对齐，不会因为按钮出现而左右跳。
 */

interface SettingsSectionProps {
  icon: ReactNode;
  title: string;
  note?: string;
  children: ReactNode;
}

export function SettingsSection({ icon, title, note, children }: SettingsSectionProps) {
  const headingId = useId();
  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <header className="settings-section-head">
        {icon}
        <h2 id={headingId}>{title}</h2>
        {note ? <p>{note}</p> : null}
      </header>
      <div className="settings-rows">{children}</div>
    </section>
  );
}

interface ResetProps {
  /** 该行是否已偏离默认值；false 时不渲染按钮，但保留占位。 */
  modified?: boolean;
  onReset?: () => void;
}

interface SettingsRowProps extends ResetProps {
  label: string;
  note?: string;
  htmlFor?: string;
  dependent?: boolean;
  muted?: boolean;
  children: ReactNode;
}

export function SettingsRow({ label, note, htmlFor, dependent, muted, modified, onReset, children }: SettingsRowProps) {
  return (
    <div className={rowClass(dependent, muted)}>
      <span className="settings-label">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <strong>{label}</strong>}
        {note ? <small>{note}</small> : null}
      </span>
      <div className="settings-control">
        {children}
        {onReset ? <SettingsReset label={label} modified={Boolean(modified)} onReset={onReset} /> : null}
      </div>
    </div>
  );
}

interface SettingsToggleRowProps extends ResetProps {
  label: string;
  note?: string;
  checked: boolean;
  dependent?: boolean;
  muted?: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * 开关行。标题用 `<label htmlFor>` 与开关关联，**不用整行 `<label>` 包住** ——
 * 否则重置按钮会变成 label 的后代，点它等于点开关。
 */
export function SettingsToggleRow({ label, note, checked, dependent, muted, modified, onReset, onChange }: SettingsToggleRowProps) {
  const id = useId();
  return (
    <div className={rowClass(dependent, muted)}>
      <span className="settings-label">
        <label htmlFor={id}>{label}</label>
        {note ? <small>{note}</small> : null}
      </span>
      <div className="settings-control">
        <input id={id} type="checkbox" className="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        {onReset ? <SettingsReset label={label} modified={Boolean(modified)} onReset={onReset} /> : null}
      </div>
    </div>
  );
}

interface SettingsChoiceProps<T extends string> {
  label: string;
  name: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}

export function SettingsChoice<T extends string>({ label, name, value, options, onChange }: SettingsChoiceProps<T>) {
  return (
    <div className="settings-choice" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label key={option.value} className={option.value === value ? "choice selected" : "choice"}>
          <input type="radio" name={name} value={option.value} checked={option.value === value} onChange={() => onChange(option.value)} />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

/** 单项重置：只在偏离默认值时渲染；绝对定位在卡片外的固定列里，不占行内布局。 */
function SettingsReset({ label, modified, onReset }: { label: string } & Required<ResetProps>) {
  if (!modified) return null;
  return (
    <button type="button" className="settings-reset" aria-label={`将「${label}」恢复默认`} onClick={onReset}>
      <RotateCcw size={14} aria-hidden="true" />
    </button>
  );
}

function rowClass(dependent?: boolean, muted?: boolean) {
  return ["settings-row", dependent ? "is-dependent" : "", muted ? "is-muted" : ""].filter(Boolean).join(" ");
}
