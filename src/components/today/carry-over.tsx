import { useEffect, useRef, useState } from "react";
import { Clock3, X } from "lucide-react";

import type { Task } from "../../lib/native";
import type { CarryOverEntry } from "../../lib/workspaceSelectors";

/**
 * 左下角「待续」浮钮与抽屉（2026-10-28）。
 *
 * **它不是新概念**：数据来自 `carryOverTasks` —— 任务池里「排过期次、还没做完、今天也
 * 没有未结束时段」的那一批。抽屉只是把这批任务捞出来给一个快捷入口，不复制任务数据。
 *
 * **为什么在左下角**：右下角属于任务池浮钮（`.task-pool-toggle` 是 `fixed right:18
 * bottom:18`），而且这样分工更清楚 —— 左边是回头看，右边是往前做。不管任务池开着
 * 还是收着，待续的位置都不变。
 *
 * 闸门是「有内容才出现」：没有待续任务时整枚浮钮都不渲染，不制造常驻的压力。
 */
export function CarryOverLauncher({ entries, today, onSchedule }: {
  entries: CarryOverEntry[];
  /** 今天（本地日历日），用来把时段日期说成「昨天／前天／10月25日」。 */
  today: string;
  onSchedule: (task: Task) => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 浮层里的 Esc 只关这一层；焦点回到浮钮，键盘用户不会掉到页面另一头。
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (entries.length === 0) return null;

  return <>
    <button ref={buttonRef} type="button" className="carry-toggle" aria-expanded={open} aria-controls="carry-drawer"
      onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen((value) => !value)}>
      <Clock3 size={16} aria-hidden="true" />
      待续<span className="carry-count">{entries.length}</span>
    </button>
    {open && <>
      <button type="button" className="carry-scrim" aria-label="关闭待续" onClick={close} />
      <aside id="carry-drawer" className="carry-drawer" role="dialog" aria-label="待续任务">
        <header className="carry-head">
          <h2>待续 {entries.length} 项</h2>
          <button type="button" className="icon-action" aria-label="关闭待续" onClick={close}><X size={16} /></button>
        </header>
        <div className="carry-list">
          {entries.map(({ task, session }) => <div key={task.id} className="carry-row">
            <strong title={task.title}>{task.title}</strong>
            <button type="button" className="carry-schedule" onClick={() => { close(); onSchedule(task); }}>排到今天</button>
            <span className="carry-meta">{dayLabelOf(session.endLocalDate, today)} {session.startLocal} 的时段没做完 · {task.progress}%</span>
          </div>)}
        </div>
      </aside>
    </>}
  </>;
}

/** 「昨天／前天／10月25日」。只做本地日历日差，不碰时刻。 */
function dayLabelOf(date: string, today: string) {
  const from = new Date(`${today}T12:00:00`).getTime();
  const to = new Date(`${date}T12:00:00`).getTime();
  const days = Math.round((from - to) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days === 2) return "前天";
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}
