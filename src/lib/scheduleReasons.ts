import type { ScheduleUnscheduledItem } from "./scheduling";

/**
 * 把引擎给出的「排不进」原因翻成一句人话。
 *
 * 这一层只做翻译，不做判断：界面永远显示引擎算出来的原因，不自己推测为什么排不上。
 * 每条文案都在 `scheduleReasons.test.ts` 里钉住，改措辞时用例会先红。
 */
export function scheduleUnscheduledText(item: ScheduleUnscheduledItem | undefined, minimumMinutes: number, budgetMinutes?: number | null): string {
  if (!item) return "当前组合里放不下";
  switch (item.reason) {
    case "below-minimum": return `单次时长短于最低有效时长 ${minimumMinutes} 分钟`;
    case "no-slots": return "所选范围里没有默认时段";
    case "no-gap-that-day": return "该日没有可用空档";
    case "fixed-start-busy": return "固定开始时间已被占用";
    case "deadline-no-gap": return "截止日期前没有可用空档";
    case "gaps-too-short": return `空档都短于最低有效时长（最长 ${item.longestGapMinutes} 分钟）`;
    case "daily-budget-full": return budgetMinutes != null ? `每日时长上限已排满（每天最多 ${formatBudgetMinutes(budgetMinutes)}）` : "每日时长上限已排满";
    // 预留位：等「需要连续时段」落地后才会产出，本阶段不实现（D4=a）。
    case "continuous-unavailable": return "需要连续时段（后续阶段）";
    default: return "当前组合里放不下";
  }
}

/** 上限分钟 → 「4 小时」这类短文案；只在原因文案里用。 */
function formatBudgetMinutes(minutes: number) {
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return minutes > 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`;
}
