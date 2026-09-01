export interface CourseTaskDraft {
  title: string;
  estimatedMinutes: number | null;
  selected: boolean;
}

export function parseCourseText(source: string): CourseTaskDraft[] {
  const result: CourseTaskDraft[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    line = line.replace(/^[-*•]\s*/, "").replace(/^(?:P\s*)?\d+[.)、:\-]?\s*/i, "");
    const durationMatch = line.match(/(?:\s*[|·—-]\s*|\s+)(\d{1,2}:\d{2}(?::\d{2})?)\s*$/);
    let estimatedMinutes: number | null = null;
    if (durationMatch) {
      line = line.slice(0, durationMatch.index).trim();
      estimatedMinutes = durationToMinutes(durationMatch[1]);
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
