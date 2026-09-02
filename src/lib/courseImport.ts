export interface CourseTaskDraft {
  title: string;
  estimatedMinutes: number | null;
  selected: boolean;
}

const TIME_PATTERN = "\\d{1,2}:\\d{2}(?::\\d{2})?";

/** 纯时间行，如 "23:19" / "01:05:00" */
const SOLO_TIME = new RegExp(`^(?:(${TIME_PATTERN}))$`);
/** 标题行尾部的分隔时间，如 "起步 12:30"、"起步 | 12:30" */
const TRAILING_TIME = new RegExp(`(?:\\s*[|·—-]\\s*|\\s+)(${TIME_PATTERN})\\s*$`);

function isNoiseLine(line: string) {
  return /^(?:\.{3,}|…+|[-–—_*·•\s]+)$/.test(line);
}

/**
 * 把粘贴的课程清单解析为任务草稿。支持三种布局：
 *   1) 同行：      P1 起步 12:30 / 使用说明 23:19
 *   2) 标题换行时间：使用说明
 *                  23:19
 *   3) 时间换行标题：23:19
 *                  Unit1 Lesson 1
 * 时间解释为 分:秒（mm:ss / h:mm:ss），向上取整分钟。
 */
export function parseCourseText(source: string): CourseTaskDraft[] {
  const result: CourseTaskDraft[] = [];
  let pendingTime: string | null = null;
  const lines = source.split(/\r?\n/);

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line || isNoiseLine(line)) continue;

    const solo = line.match(SOLO_TIME);
    if (solo) {
      if (result.length > 0 && result[result.length - 1].estimatedMinutes === null) {
        // 标题在上、时间在下：回填给上一个还没时间的标题
        result[result.length - 1].estimatedMinutes = durationToMinutes(solo[1]);
      } else {
        // 时间在上、标题在下（或前标题已有时间）：暂存等下一标题
        pendingTime = solo[1];
      }
      continue;
    }

    // 剥离列表前缀（P1 / 2. / - / •），但保留 Unit1 这类数字在词中的标题
    line = line.replace(/^[-*•]\s*/, "").replace(/^(?:P\s*)?\d+[.)、:\-]?\s*/i, "").trim();
    if (!line || isNoiseLine(line)) continue;

    const trailing = line.match(TRAILING_TIME);
    let estimatedMinutes: number | null = null;
    if (trailing) {
      line = line.slice(0, trailing.index).trim();
      estimatedMinutes = durationToMinutes(trailing[1]);
      pendingTime = null;
    } else if (pendingTime) {
      estimatedMinutes = durationToMinutes(pendingTime);
      pendingTime = null;
    }
    if (!line) continue;

    result.push({ title: line, estimatedMinutes, selected: true });
  }
  return result;
}

function durationToMinutes(value: string) {
  const parts = value.split(":").map(Number);
  const seconds = parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
  return Math.max(1, Math.ceil(seconds / 60));
}
