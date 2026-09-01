// THROWAWAY PROTOTYPE: three structural variants of the Daymark core loop,
// switchable with ?variant=A|B|C. All state is in memory.

const variantNames = {
  A: "Focus Lane · 稳定三栏",
  B: "Action Desk · 行动工作台",
  C: "Time Canvas · 时间画布",
};

const initialState = () => ({
  tasks: [
    { id: "t1", title: "完成答辩 PPT 初稿", category: "工作", project: "毕业答辩", progress: 35, deadlineRelative: "还有 2 天", deadlineDate: "2026.7.31", deadlineMode: "relative", duration: 60 },
    { id: "t2", title: "U3 Lesson 2", category: "学习", project: "四级词汇精讲 · P12", progress: 48, deadlineRelative: "还有 6 天", deadlineDate: "2026.8.4", deadlineMode: "relative", duration: 45 },
    { id: "t3", title: "整理房间和书桌", category: "生活", project: "", progress: 20, deadlineRelative: "本周", deadlineDate: "2026.8.2", deadlineMode: "relative", duration: 30 },
    { id: "t4", title: "复习概率论错题", category: "学习", project: "期末复习", progress: 10, deadlineRelative: "还有 9 天", deadlineDate: "2026.8.7", deadlineMode: "relative", duration: 40 },
  ],
  sessions: [
    { id: "s1", taskId: "t3", start: "18:30", duration: 30, state: "done" },
    { id: "s2", taskId: "t1", start: "20:00", duration: 60, state: "current" },
    { id: "s3", taskId: "t2", start: "21:30", duration: 45, state: "next" },
  ],
  selectedTaskId: "t1",
  detailTaskId: null,
  progressTaskId: null,
  activeSessionId: null,
  reviewSessionId: null,
  allDay: false,
  filter: "全部",
  inspectOpen: false,
  toast: "",
  undo: [],
});

let state = initialState();
const app = document.querySelector("#app");

const getVariant = () => {
  const value = new URL(window.location.href).searchParams.get("variant")?.toUpperCase();
  return variantNames[value] ? value : "A";
};

const setVariant = (variant) => {
  const url = new URL(window.location.href);
  url.searchParams.set("variant", variant);
  history.replaceState({}, "", url);
  render();
};

const taskById = (id) => state.tasks.find((task) => task.id === id);
const sessionById = (id) => state.sessions.find((session) => session.id === id);
const categoryClass = (category) => category === "学习" ? "study" : category === "生活" ? "life" : "work";

function snapshot() {
  return JSON.parse(JSON.stringify({
    tasks: state.tasks,
    sessions: state.sessions,
    selectedTaskId: state.selectedTaskId,
    detailTaskId: state.detailTaskId,
    activeSessionId: state.activeSessionId,
    reviewSessionId: state.reviewSessionId,
  }));
}

function pushUndo(label) {
  state.undo.push({ label, value: snapshot() });
  if (state.undo.length > 12) state.undo.shift();
}

function undo() {
  const entry = state.undo.pop();
  if (!entry) return showToast("没有可撤销的操作");
  Object.assign(state, entry.value);
  showToast(`已撤销：${entry.label}`);
}

function showToast(message) {
  state.toast = message;
  render();
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    state.toast = "";
    render();
  }, 2600);
}

function progressBar(task) {
  return `
    <div class="progress-row">
      <div class="progress-track"><div class="progress-fill" style="width:${task.progress}%"></div></div>
      <button class="progress-button" data-action="toggle-progress" data-task-id="${task.id}" aria-label="更新 ${task.title} 的进度">${task.progress}%</button>
    </div>
    ${state.progressTaskId === task.id ? progressPopover(task) : ""}
  `;
}

function progressPopover(task) {
  return `
    <div class="progress-popover" data-popover="progress">
      <input type="range" min="0" max="100" step="5" value="${task.progress}" data-action="set-progress" data-task-id="${task.id}" />
      <div class="progress-actions">
        <button class="chip-button" data-action="bump-progress" data-task-id="${task.id}" data-amount="5">+5%</button>
        <button class="chip-button" data-action="bump-progress" data-task-id="${task.id}" data-amount="10">+10%</button>
        <button class="chip-button" data-action="complete-task" data-task-id="${task.id}">完成</button>
      </div>
    </div>
  `;
}

function taskCard(task, compact = false) {
  const selected = state.selectedTaskId === task.id ? "selected" : "";
  const deadline = task.deadlineMode === "relative" ? task.deadlineRelative : task.deadlineDate;
  const future = state.sessions.filter((session) => session.taskId === task.id && session.state !== "done");
  return `
    <article class="task-card ${categoryClass(task.category)} ${selected}" draggable="true" data-task-id="${task.id}" tabindex="0" aria-label="任务：${task.title}">
      <div class="task-head">
        <h3 class="task-title">${task.title}</h3>
        <button class="deadline" data-action="toggle-deadline" data-task-id="${task.id}">${deadline}</button>
      </div>
      ${compact ? "" : `<div class="task-context">${task.category}${task.project ? ` · ${task.project}` : ""}</div>`}
      ${progressBar(task)}
      ${compact ? "" : `<div class="task-foot"><span>今日 +${task.id === "t1" ? 10 : 0}%</span><span>${future.length ? `未来 ${future.length} 次` : `建议 ${task.duration} 分钟`}</span></div>`}
    </article>
  `;
}

function filteredTasks() {
  if (state.filter === "全部") return state.tasks;
  if (state.filter === "未安排") return state.tasks.filter(task => !state.sessions.some(session => session.taskId === task.id && session.state !== "done"));
  return state.tasks.filter(task => task.category === state.filter);
}

function taskPool({ dock = false } = {}) {
  const list = filteredTasks();
  if (dock) return `<div class="task-dock" aria-label="任务池停靠栏">${list.map(task => taskCard(task, true)).join("")}</div>`;
  return `
    <div class="section-title-row">
      <div><div class="page-kicker">Task Pool</div><h2 class="section-title">任务池</h2></div>
      <span class="count-pill">${list.length} 项</span>
    </div>
    <form class="quick-create" data-form="quick-create">
      <input name="title" aria-label="快速新建任务" placeholder="写下要做的事…" autocomplete="off" />
      <button class="primary-button" type="submit">添加</button>
    </form>
    <div class="pool-toolbar">
      ${["全部", "未安排", "学习", "工作", "生活"].map(filter => `<button class="chip-button ${state.filter === filter ? "active" : ""}" data-action="filter" data-filter="${filter}">${filter}</button>`).join("")}
    </div>
    <div class="task-list">${list.map(task => taskCard(task)).join("")}</div>
  `;
}

const slotTimes = ["18:00", "18:30", "19:00", "19:30", "20:00", "20:30", "21:00", "21:30", "22:00", "22:30", "23:00"];

function sessionCard(session) {
  const task = taskById(session.taskId);
  if (!task) return "";
  const active = state.activeSessionId === session.id ? "active" : "";
  return `
    <div class="session-card ${categoryClass(task.category)} ${session.state === "current" ? "current" : ""} ${active}" draggable="true" data-session-id="${session.id}" data-task-id="${task.id}" tabindex="0">
      <div class="session-title">${task.title}</div>
      <div class="session-meta">${session.start} · ${session.duration} 分钟 · ${active ? "正在执行" : session.state === "done" ? "待回顾" : session.state === "current" ? "当前安排" : "接下来"}</div>
    </div>
  `;
}

function timeline({ compact = false } = {}) {
  const times = state.allDay ? ["08:00", "10:00", "12:00", "14:00", "16:00", ...slotTimes] : slotTimes;
  return `
    <div class="timeline ${compact ? "compact" : ""}" aria-label="今日时间线">
      ${state.allDay ? "" : `<button class="folded-time" data-action="toggle-all-day"><span>00:00–18:00 已折叠</span><span>展开全天</span></button>`}
      <div class="current-line" aria-label="当前时间 20点18分"></div>
      ${times.map(time => `
        <div class="time-slot">
          <div class="time-label">${time}</div>
          <div class="drop-slot" data-drop-time="${time}">
            <span class="drop-hint">放在 ${time}</span>
            ${state.sessions.filter(session => session.start === time).map(sessionCard).join("")}
          </div>
        </div>
      `).join("")}
      ${state.allDay ? `<button class="folded-time" data-action="toggle-all-day"><span>收起到默认时段</span><span>18:00–23:30</span></button>` : ""}
    </div>
  `;
}

function currentSession() {
  return state.sessions.find(session => session.id === state.activeSessionId)
    || state.sessions.find(session => session.state === "current")
    || state.sessions.find(session => session.state === "next");
}

function nowCard() {
  const session = currentSession();
  const task = session && taskById(session.taskId);
  if (!task) {
    return `<section class="now-card"><div class="now-meta">当前为空档</div><h2 class="now-title">给接下来留一个小位置</h2><p class="now-detail">从任务池拖一项到时间轴即可。</p></section>`;
  }
  const active = state.activeSessionId === session.id;
  return `
    <section class="now-card">
      <div class="now-meta">${active ? "正在执行 · 已投入 18 分钟" : session.state === "current" ? "当前安排 · 20:00–21:00" : "下一项安排"}</div>
      <h2 class="now-title">${task.title}</h2>
      <p class="now-detail">${task.category}${task.project ? ` · ${task.project}` : ""} · 当前进度 ${task.progress}%</p>
      <div class="now-actions">
        ${active
          ? `<button class="primary-button" data-action="end-session" data-session-id="${session.id}">结束本次</button>`
          : `<button class="primary-button" data-action="start-session" data-session-id="${session.id}">开始本次</button>`}
        <button class="soft-button" data-action="toggle-progress" data-task-id="${task.id}">更新进度</button>
        <button class="soft-button" data-action="open-detail" data-task-id="${task.id}">查看详情</button>
      </div>
      ${state.progressTaskId === task.id ? progressPopover(task) : ""}
    </section>
  `;
}

function summaryStrip() {
  const progressed = state.tasks.filter(task => task.progress > 0).length;
  const totalIncrease = state.tasks.reduce((total, task) => total + task.progress, 0);
  return `
    <div class="summary-strip">
      <div class="summary-cell"><div class="summary-value">${progressed}</div><div class="summary-label">今天有推进的任务</div></div>
      <div class="summary-cell"><div class="summary-value">+${Math.round(totalIncrease / 8)}%</div><div class="summary-label">今日累计进度变化</div></div>
      <div class="summary-cell"><div class="summary-value">2</div><div class="summary-label">未来 7 天内截止</div></div>
    </div>
  `;
}

function header() {
  return `
    <div class="header-row">
      <div><div class="page-kicker">Wednesday · July 29</div><h1 class="page-title">今天，先推进一点</h1><p class="page-subtitle">不需要一次完成，只需要让下一步变得容易。</p></div>
      <div class="header-actions">
        <button class="soft-button" data-action="undo">撤销${state.undo.length ? ` · ${state.undo.length}` : ""}</button>
        <button class="soft-button" data-action="toggle-all-day">${state.allDay ? "默认时段" : "全天"}</button>
      </div>
    </div>
  `;
}

function variantA() {
  return `
    <main class="app-frame variant-a">
      <nav class="rail" aria-label="主导航">
        <div class="brand-mark">D</div>
        <button class="rail-button active" title="今日">⌂</button>
        <button class="rail-button" title="日历">▦</button>
        <button class="rail-button" title="项目">▣</button>
        <button class="rail-button" title="回顾">⌁</button>
        <div class="rail-spacer"></div>
        <button class="rail-button" title="自定义界面">✎</button>
        <button class="rail-button" title="设置">⚙</button>
      </nav>
      <section class="main-column">
        ${header()}
        ${nowCard()}
        ${summaryStrip()}
        <div class="section-title-row"><h2 class="section-title">今天的时间线</h2><span class="count-pill">拖入任务即可安排</span></div>
        ${timeline()}
      </section>
      <aside class="pool-panel">${taskPool()}</aside>
    </main>
  `;
}

function variantB() {
  return `
    <main class="app-frame variant-b">
      <nav class="top-nav">
        <div class="top-brand"><div class="brand-mark" style="margin:0;width:38px;height:38px">D</div><span>Daymark</span></div>
        <div class="top-links"><button class="top-link active">今天</button><button class="top-link">日历</button><button class="top-link">项目</button><button class="top-link">回顾</button></div>
        <div class="header-actions"><button class="soft-button" data-action="undo">撤销</button><button class="icon-button">⚙</button></div>
      </nav>
      <section class="action-desk">
        ${header()}
        <div class="desk-hero">
          ${nowCard()}
          <div class="day-score"><div class="page-kicker">今日推进</div><div class="big-progress">3 项</div><p class="page-subtitle">你已经让计划往前走了。没有目标的任务不计算虚假达成率。</p></div>
        </div>
        <div class="desk-grid">
          <section class="surface">${taskPool()}</section>
          <section class="surface"><div class="section-title-row"><h2 class="section-title">今日安排</h2><button class="chip-button" data-action="toggle-all-day">${state.allDay ? "默认时段" : "展开全天"}</button></div>${timeline({ compact: true })}</section>
        </div>
      </section>
    </main>
  `;
}

function variantC() {
  return `
    <main class="app-frame variant-c">
      <header class="canvas-header">
        <div class="top-brand"><div class="brand-mark" style="margin:0">D</div><div><div class="page-kicker">Time Canvas</div><div style="font-size:18px">7月29日 · 今天</div></div></div>
        <div class="header-actions"><button class="soft-button" data-action="toggle-all-day">${state.allDay ? "默认时段" : "全天"}</button><button class="soft-button" data-action="undo">撤销</button><button class="icon-button">⚙</button></div>
      </header>
      <section class="canvas-board">${timeline()}</section>
      <aside class="floating-now">${nowCard()}</aside>
      ${taskPool({ dock: true })}
    </main>
  `;
}

function reviewSheet() {
  const session = sessionById(state.reviewSessionId);
  if (!session) return "";
  const task = taskById(session.taskId);
  return `
    <section class="review-sheet" aria-label="本次小结">
      <div class="page-kicker">Session Review</div>
      <h3>这次推进了多少？</h3>
      <p>${task.title} · 已记录 ${session.duration} 分钟</p>
      <label>任务进度 <strong id="review-progress-value">${task.progress}%</strong></label>
      <input type="range" min="0" max="100" step="5" value="${task.progress}" data-action="review-progress" data-task-id="${task.id}" />
      <label>一句可选感受</label>
      <textarea placeholder="例如：比预计难，但完成了开头。"></textarea>
      <div class="now-actions" style="margin-top:12px"><button class="primary-button" data-action="save-review">保存小结</button><button class="soft-button" data-action="skip-review">稍后再写</button></div>
    </section>
  `;
}

function detailDrawer() {
  const task = taskById(state.detailTaskId);
  if (!task) return "";
  return `
    <aside class="detail-drawer" aria-label="任务详情">
      <div class="header-row" style="margin:0"><div class="page-kicker">Task Detail</div><button class="icon-button" data-action="close-detail">×</button></div>
      <h2>${task.title}</h2>
      ${progressBar(task)}
      <div class="detail-row"><span class="detail-label">分类</span><strong>${task.category}</strong></div>
      <div class="detail-row"><span class="detail-label">项目</span><strong>${task.project || "未归入项目"}</strong></div>
      <div class="detail-row"><span class="detail-label">截止日期</span><strong>${task.deadlineDate}</strong></div>
      <div class="detail-row"><span class="detail-label">单次投入</span><strong>${task.duration} 分钟</strong></div>
      <div class="detail-row"><span class="detail-label">未来安排</span><strong>${state.sessions.filter(session => session.taskId === task.id && session.state !== "done").length} 次</strong></div>
      <p class="muted" style="font-size:12px;margin-top:16px">原型只验证信息层级，不会保存字段修改。</p>
    </aside>
  `;
}

function prototypeSwitcher(variant) {
  return `
    <div class="prototype-switcher" aria-label="原型方案切换器">
      <button data-action="previous-variant" aria-label="上一个方案">←</button>
      <div class="variant-label"><span class="prototype-tag">THROWAWAY</span>${variant} · ${variantNames[variant]}</div>
      <button data-action="next-variant" aria-label="下一个方案">→</button>
      <button data-action="toggle-inspector" aria-label="查看原型状态">{ }</button>
      <button data-action="reset" aria-label="重置原型">↺</button>
    </div>
  `;
}

function stateInspector(variant) {
  if (!state.inspectOpen) return "";
  const visibleState = {
    variant,
    selectedTaskId: state.selectedTaskId,
    activeSessionId: state.activeSessionId,
    tasks: state.tasks.map(({ id, title, progress }) => ({ id, title, progress })),
    sessions: state.sessions,
    undoDepth: state.undo.length,
  };
  return `<pre class="state-inspector">PROTOTYPE STATE\n${escapeHtml(JSON.stringify(visibleState, null, 2))}</pre>`;
}

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function render() {
  const variant = getVariant();
  const content = variant === "B" ? variantB() : variant === "C" ? variantC() : variantA();
  app.innerHTML = `
    <div class="prototype-shell">
      ${content}
      ${detailDrawer()}
      ${reviewSheet()}
      ${stateInspector(variant)}
      ${state.toast ? `<div class="toast">${state.toast}</div>` : ""}
      ${prototypeSwitcher(variant)}
    </div>
  `;
  bindDragAndDrop();
}

function cycleVariant(direction) {
  const keys = Object.keys(variantNames);
  const index = keys.indexOf(getVariant());
  setVariant(keys[(index + direction + keys.length) % keys.length]);
}

function addTask(title) {
  const clean = title.trim();
  if (!clean) return;
  pushUndo("新建任务");
  const id = `t${Date.now()}`;
  state.tasks.unshift({ id, title: clean, category: "学习", project: "", progress: 0, deadlineRelative: "无截止日期", deadlineDate: "未设置", deadlineMode: "relative", duration: 30 });
  state.selectedTaskId = id;
  showToast("任务已加入任务池");
}

function scheduleTask(taskId, start) {
  const task = taskById(taskId);
  if (!task) return;
  pushUndo("安排任务");
  state.sessions.push({ id: `s${Date.now()}`, taskId, start, duration: task.duration, state: "next" });
  state.selectedTaskId = taskId;
  showToast(`已安排到 ${start}`);
}

function moveSession(sessionId, start) {
  const session = sessionById(sessionId);
  if (!session) return;
  pushUndo("移动执行时段");
  session.start = start;
  session.state = "next";
  showToast(`已移动到 ${start}`);
}

function setTaskProgress(taskId, value, add = false) {
  const task = taskById(taskId);
  if (!task) return;
  pushUndo("更新进度");
  task.progress = Math.max(0, Math.min(100, add ? task.progress + Number(value) : Number(value)));
  render();
}

function bindDragAndDrop() {
  document.querySelectorAll("[draggable='true']").forEach(element => {
    element.addEventListener("dragstart", event => {
      if (element.dataset.sessionId) {
        event.dataTransfer.setData("application/x-daymark-session", element.dataset.sessionId);
      } else {
        event.dataTransfer.setData("application/x-daymark-task", element.dataset.taskId);
      }
      event.dataTransfer.effectAllowed = "move";
    });
  });

  document.querySelectorAll("[data-drop-time]").forEach(slot => {
    slot.addEventListener("dragover", event => {
      event.preventDefault();
      slot.classList.add("drag-over");
    });
    slot.addEventListener("dragleave", () => slot.classList.remove("drag-over"));
    slot.addEventListener("drop", event => {
      event.preventDefault();
      slot.classList.remove("drag-over");
      const taskId = event.dataTransfer.getData("application/x-daymark-task");
      const sessionId = event.dataTransfer.getData("application/x-daymark-session");
      if (sessionId) moveSession(sessionId, slot.dataset.dropTime);
      else if (taskId) scheduleTask(taskId, slot.dataset.dropTime);
    });
  });
}

document.addEventListener("submit", event => {
  if (!event.target.matches("[data-form='quick-create']")) return;
  event.preventDefault();
  const form = new FormData(event.target);
  addTask(String(form.get("title") || ""));
});

document.addEventListener("input", event => {
  const action = event.target.dataset.action;
  if (action === "set-progress") setTaskProgress(event.target.dataset.taskId, event.target.value);
  if (action === "review-progress") {
    const label = document.querySelector("#review-progress-value");
    if (label) label.textContent = `${event.target.value}%`;
  }
});

document.addEventListener("dblclick", event => {
  const card = event.target.closest("[data-task-id]");
  if (!card || event.target.closest("button, input, textarea")) return;
  state.detailTaskId = card.dataset.taskId;
  render();
});

document.addEventListener("click", event => {
  const taskCardElement = event.target.closest(".task-card");
  if (taskCardElement && !event.target.closest("button, input")) {
    state.selectedTaskId = taskCardElement.dataset.taskId;
    render();
    return;
  }

  const control = event.target.closest("[data-action]");
  if (!control) return;
  const action = control.dataset.action;

  if (action === "previous-variant") cycleVariant(-1);
  if (action === "next-variant") cycleVariant(1);
  if (action === "toggle-inspector") { state.inspectOpen = !state.inspectOpen; render(); }
  if (action === "reset") { state = initialState(); render(); }
  if (action === "undo") undo();
  if (action === "toggle-all-day") { state.allDay = !state.allDay; render(); }
  if (action === "filter") { state.filter = control.dataset.filter; render(); }
  if (action === "toggle-progress") { state.progressTaskId = state.progressTaskId === control.dataset.taskId ? null : control.dataset.taskId; render(); }
  if (action === "bump-progress") setTaskProgress(control.dataset.taskId, control.dataset.amount, true);
  if (action === "complete-task") setTaskProgress(control.dataset.taskId, 100);
  if (action === "toggle-deadline") {
    const task = taskById(control.dataset.taskId);
    task.deadlineMode = task.deadlineMode === "relative" ? "date" : "relative";
    render();
  }
  if (action === "open-detail") { state.detailTaskId = control.dataset.taskId; render(); }
  if (action === "close-detail") { state.detailTaskId = null; render(); }
  if (action === "start-session") {
    pushUndo("开始本次");
    state.activeSessionId = control.dataset.sessionId;
    showToast("已记录实际开始时间");
  }
  if (action === "end-session") {
    pushUndo("结束本次");
    const session = sessionById(control.dataset.sessionId);
    if (session) session.state = "done";
    state.activeSessionId = null;
    state.reviewSessionId = control.dataset.sessionId;
    render();
  }
  if (action === "save-review") {
    const input = document.querySelector("[data-action='review-progress']");
    if (input) {
      const task = taskById(input.dataset.taskId);
      if (task) task.progress = Number(input.value);
    }
    state.reviewSessionId = null;
    showToast("本次小结已记录（仅内存）");
  }
  if (action === "skip-review") { state.reviewSessionId = null; showToast("可以稍后再写"); }
});

document.addEventListener("keydown", event => {
  const editing = event.target.matches("input, textarea, select, [contenteditable='true']");
  if (!editing && event.key === "ArrowLeft") cycleVariant(-1);
  if (!editing && event.key === "ArrowRight") cycleVariant(1);
  if (!editing && event.ctrlKey && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undo();
  }
  if (event.key === "Escape") {
    state.detailTaskId = null;
    state.progressTaskId = null;
    state.reviewSessionId = null;
    render();
  }
});

window.addEventListener("popstate", render);
render();
