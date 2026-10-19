/**
 * 月历格子的纯函数：一个月按周切行（周一起头），首尾补 null 把每行填满。
 *
 * 回顾页的周期选择器与任务编辑里的日期字段共用这一份，避免两处各写一遍
 * 「这个月从星期几开始」的算术。
 */
export const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

export function monthRows(month: string): (string | null)[][] {
  const [year, index] = month.split("-").map(Number);
  const offset = (new Date(year, index - 1, 1).getDay() + 6) % 7;
  const total = new Date(year, index, 0).getDate();
  const cells: (string | null)[] = Array.from({ length: offset }, () => null);
  for (let day = 1; day <= total; day += 1) cells.push(`${month}-${String(day).padStart(2, "0")}`);
  while (cells.length % 7 !== 0) cells.push(null);
  const rows: (string | null)[][] = [];
  for (let start = 0; start < cells.length; start += 7) rows.push(cells.slice(start, start + 7));
  return rows;
}

/** 月份加减，跨年自动进位。 */
export function shiftMonth(month: string, delta: number) {
  const [year, index] = month.split("-").map(Number);
  const next = new Date(year, index - 1 + delta, 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
}
