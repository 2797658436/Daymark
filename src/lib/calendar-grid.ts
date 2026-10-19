/**
 * 月历格子的纯函数：一个月按周切行（周一起头），并把首尾用相邻月份的日期补齐。
 *
 * 补齐的日子**不是空的**：它们可点、只是颜色浅一点 —— 空白的格子在日历里看起来
 * 像「这一天不存在」。回顾页的周期选择器与任务编辑的日期字段共用这一份。
 */
export const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

export interface MonthCell {
  date: string;
  /** 属于相邻月份：仍然可点，只是降一级颜色。 */
  outside: boolean;
}

const pad = (value: number) => String(value).padStart(2, "0");

function dateString(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function monthRows(month: string): MonthCell[][] {
  const [year, index] = month.split("-").map(Number);
  const first = new Date(year, index - 1, 1);
  const offset = (first.getDay() + 6) % 7;
  const total = new Date(year, index, 0).getDate();
  const cells: MonthCell[] = [];

  for (let back = offset; back > 0; back -= 1) {
    cells.push({ date: dateString(new Date(year, index - 1, 1 - back)), outside: true });
  }
  for (let day = 1; day <= total; day += 1) {
    cells.push({ date: `${month}-${pad(day)}`, outside: false });
  }
  let forward = 1;
  while (cells.length % 7 !== 0) {
    cells.push({ date: dateString(new Date(year, index, forward)), outside: true });
    forward += 1;
  }

  const rows: MonthCell[][] = [];
  for (let start = 0; start < cells.length; start += 7) rows.push(cells.slice(start, start + 7));
  return rows;
}

/** 月份加减，跨年自动进位。 */
export function shiftMonth(month: string, delta: number) {
  const [year, index] = month.split("-").map(Number);
  const next = new Date(year, index - 1 + delta, 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
}
