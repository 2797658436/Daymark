/**
 * 星期选择：一排按钮，按下即切换某天是否启用。
 *
 * 为什么不用 `input[type=checkbox]`：勾选框自带那个小方块，在一排等宽格子中间很噪；
 * 这里要的是「一个字就是整个按钮」，启用与否**只靠边框和字色**表达。
 *
 * 语义仍是切换：`<button type="button" aria-pressed>`，读屏会念「已按下 / 未按下」；
 * 可访问名给成「周一」而不是「一」，单字在孤立朗读时没有意义。
 * 分组名交给调用方的 `<fieldset><legend>`，所以这里不再自带 role/aria-label。
 *
 * 顺序是**周一到周日**（与日历列头一致），周日在最后而不是最前。
 */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_LABEL = ["日", "一", "二", "三", "四", "五", "六"] as const;

interface WeekdayPickerProps {
  value: number[];
  onChange: (weekdays: number[]) => void;
  disabled?: boolean;
}

export function WeekdayPicker({ value, onChange, disabled }: WeekdayPickerProps) {
  return (
    <div className="weekday-picker">
      {WEEKDAY_ORDER.map((day) => {
        const active = value.includes(day);
        const toggle = () => onChange(active ? value.filter((item) => item !== day) : [...value, day]);
        return (
          <button
            key={day}
            type="button"
            className={active ? "weekday-button is-active" : "weekday-button"}
            aria-pressed={active}
            aria-label={`周${WEEKDAY_LABEL[day]}`}
            disabled={disabled}
            onClick={toggle}
          >
            {WEEKDAY_LABEL[day]}
          </button>
        );
      })}
    </div>
  );
}
