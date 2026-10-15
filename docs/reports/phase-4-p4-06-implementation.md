# 阶段 4 P4-06 实施报告：共享索引、截止事项投影与页面

日期：2026-10-15。对应工作包：P4-06（`docs/specs/0005-phase-4-daily-workflow-and-reliability.md` §10），依赖：P4-03（本包同时复用了 P4-04／P4-05 的成果，但未改动它们）。
状态：**代码、测试与验证已完成**；AC08／AC09／AC10 成立。

## 1. 范围

按开工提示词交付五项：

1. `src/lib/workspaceSelectors.ts`：任务／项目／执行时段／执行记录／里程碑／到期结果按 ID 的稳定索引，加上「待回顾」的**唯一**判断与项目加权进度、里程碑达成规则等共享选择器（P4-07 复用）。
2. `src/lib/deadlines.ts`：纯函数 `buildDeadlineItems(workspace, today, filter)` ＋ 分组与排序，严格按规格 §6.1。
3. `src/components/deadlines/`：页面与行级动作（筛选、日期分组、两种空状态、复用既有编辑气泡与预选任务的排程入口）。
4. `PageId = "deadlines"` 三处同步 ＋ 导航入口「截止事项」。
5. 任务详情始终使用原始 ID；派生 `DeadlineItem` 不是可保存对象。

明确未做（越界项）：不新增 SQLite 迁移／字段（schema 仍 v7）、不新增 Tauri Command、不新增依赖；不做 M11 日／周／月回顾；不动 `reviewPeriod`／`reviewAnchorDate`；不改 P4-04／P4-05 的滚动仲裁与「程序性滚动不写偏好」闸门；不改缩放范围与预设；不把截止页的筛选／焦点／滚动写进 Store。

## 2. 交付清单

| 文件 | 变更 |
| --- | --- |
| `src/lib/workspaceSelectors.ts` | **新增**。`WorkspaceIndex`（6 张按 ID 的 Map ＋ `recordsBySessionId`／`tasksByProjectId`／`milestonesByProjectId`）、`isPendingReview`／`isPendingReviewIn`／`pendingReviewSessions`、`isTaskCompleted`、`projectProgress`、`projectTaskCounts`、`orderedMilestoneTasks`、`milestoneReached`／`milestoneReachedNow`、`milestoneSummary`。后五项从 `App.tsx` **迁出**（原实现删除，App 改为导入）。 |
| `src/lib/deadlines.ts` | **新增**。`DeadlineItem`／`DeadlineKind`／`DeadlineState`／`DeadlineGroup`／`DeadlineFilter`／`DEFAULT_DEADLINE_FILTER`、`buildDeadlineItems`／`buildDeadlineItemsFromIndex`、`deadlineStateOf`、`deadlineGroupOf`、`groupDeadlineItems`、`isDefaultDeadlineFilter`、`deadlineItemSourceExists`、`addLocalDays`／`localDaysBetween`／`localDateOf` 与若干展示用格式化函数。 |
| `src/components/deadlines/deadlines-page.tsx` | **新增**。页面：标题与计数、四组筛选、日期分组、两种空状态、滚动与焦点的恢复与记录、失效焦点项的中性提示。 |
| `src/components/deadlines/deadline-row.tsx` | **新增**。行级呈现与动作：任务（编辑／安排）、项目（定位项目）、里程碑（定位目标／冻结时续排）。 |
| `src/lib/settings.ts` | `PAGE_IDS` 成为合法页面 ID 的**唯一出处**，`PageId` 由它派生；`normalizeSettings` 的 `lastPage` 白名单直接读 `PAGE_IDS`（`"overview" → "today"` 历史别名未动）。 |
| `src/App.tsx` | 导航表新增「截止事项」；`workspaceIndex` 由 `useMemo` 每快照重建一次并传给今日页／日历页／截止页；截止页会话状态（筛选、焦点项）与滚动位置（ref）；复用编辑气泡与排程入口；`ProjectsPage` 新增 `focus`／`onFocusHandled` 与项目卡／里程碑行的 DOM id；待回顾判断改走共享选择器；日历卡片改为读索引的时段记录。 |
| `src/styles.css` | 截止页样式；导航自身可滚动（`.sidebar nav`）。 |
| `src/lib/deadlines.test.ts` | **新增** 18 个用例：分组边界、本地日历运算、排序、任务过滤、项目规则、里程碑冻结优先与默认隐藏、筛选辅助函数。 |
| `src/lib/workspaceSelectors.test.ts` | **新增** 10 个用例：索引、待回顾判断、项目进度与里程碑规则。 |
| `src/components/deadlines/deadlines-page.test.tsx` | **新增** 9 个用例：呈现、两种空状态、筛选、暂停任务、当前达成项、行级动作、焦点恢复与失效提示、滚动记录。 |
| `src/lib/settings.test.ts` | +1 个用例：`PAGE_IDS` 逐项被 `lastPage` 白名单接受，`overview` 别名与非法值仍回退。 |
| `src/App.test.tsx` | +3 个用例：导航入口逐项可达且跨重启恢复（覆盖三处同步的第三处）、截止页筛选与焦点同会话保留／重启不恢复、安排必须预览确认。 |
| `e2e/phase1.spec.ts` | +2 个 AC10 用例：跨页返回保留筛选／焦点／滚动（重启不恢复）；安排必须预览确认。 |
| `docs/reports/phase-4-p4-06-implementation.md` | 本报告。 |
| `docs/PROJECT-GUIDE.md` | 按文档同步协议更新 §2／§5／§8／§11／§12 与已知边界。 |

前端部分无新增依赖、无 SQLite 变更、无 Tauri Command、无 Rust 改动。

## 3. 契约

```ts
// src/lib/workspaceSelectors.ts
interface WorkspaceIndex {
  workspace: WorkspaceSnapshot;
  tasksById: Map<string, Task>;
  projectsById: Map<string, Project>;
  sessionsById: Map<string, ExecutionSession>;
  recordsById: Map<string, ExecutionRecord>;
  recordsBySessionId: Map<string, ExecutionRecord[]>;   // sessionId 为空的补录不进这张表
  tasksByProjectId: Map<string, Task[]>;
  milestonesById: Map<string, ProjectMilestone>;
  milestonesByProjectId: Map<string, ProjectMilestone[]>;
  outcomesByMilestoneId: Map<string, MilestoneOutcome>;
  frozenMilestoneIds: Set<string>;
}
createWorkspaceIndex(workspace: WorkspaceSnapshot): WorkspaceIndex
isPendingReview(session, task, sessionRecords, now): boolean     // 唯一判断
isPendingReviewIn(index, session, now): boolean
pendingReviewSessions(index, now): ExecutionSession[]
isTaskCompleted(task): boolean
projectProgress(tasks): number
projectTaskCounts(index, projectId): { total: number; completed: number }
orderedMilestoneTasks(milestone, tasks): Task[]
milestoneReached(milestone, tasks, weighted): boolean            // M7 唯一规则
milestoneReachedNow(index, milestone): boolean
milestoneSummary(milestone, tasks): string

// src/lib/deadlines.ts
interface DeadlineItem { key; kind: "task"|"project"|"milestone"; sourceId; projectId; date; title; state: "open"|"currentlyReached"|"frozenUnmet" }
interface DeadlineFilter { kinds; projectId: string | null; taskStatuses; includeReachedMilestones: boolean; query: string }
buildDeadlineItems(workspace, today, filter?): DeadlineItem[]
buildDeadlineItemsFromIndex(index, today, filter?): DeadlineItem[]
deadlineGroupOf(date, today): "overdue"|"today"|"nextSevenDays"|"later"
groupDeadlineItems(items, today): Array<{ group; title; items }>

// src/lib/settings.ts
const PAGE_IDS = ["today","calendar","deadlines","projects","review","data","appearance"] as const;
type PageId = (typeof PAGE_IDS)[number];

// src/components/deadlines/deadlines-page.tsx
interface DeadlinesPageProps {
  index: WorkspaceIndex; filter: DeadlineFilter; onFilterChange(filter): void;
  focusKey: string | null; onFocusKey(key: string | null): void;
  scrollRef: RefObject<HTMLElement | null>; scrollTop: RefObject<number>;
  onEditTask(task, anchorElement): void; onArrangeTask(task): void;
  onOpenProject(projectId, milestoneId: string | null): void; onContinueMilestone(milestone): void;
}
```

- **投影的边界**：`DeadlineItem` 是只读派生记录。行级动作把**原始对象**（`Task`／`Project`／`ProjectMilestone`）交给 `App`，从不把 `DeadlineItem` 当可保存对象。
- **索引的所有权**：`AppShell` 用 `useMemo(() => createWorkspaceIndex(workspace), [workspace])` 每快照重建一次，再传给今日页／日历页／截止页；索引是快照的只读投影，不回写任何事实。

## 4. 关键实现决策

### 4.1 `PageId` 三处来源收敛成「两处 + 一处测试」

规格 §6.2 点名三处：`PageId` 联合类型、`normalizeSettings` 的 `lastPage` 白名单、`App.tsx` 的导航表。前两处一旦分叉就会出现「类型检查通过、运行期静默回退到默认页」，所以本包把合法值提到 `PAGE_IDS` 常量，**类型由它派生、白名单直接读它** —— 结构上不可能分叉。第三处（导航表）无法与设置层共享定义（它是 React 组件表），改由测试逐项覆盖：`App.test.tsx` 的「keeps every navigation entry reachable, legal and restorable」按 `[...PAGE_IDS]` 顺序点击每一个入口，断言渲染出对应标题、`lastPage` 落库未被回退，并在重启后仍停在该页；`settings.test.ts` 另有一条「每个 `PAGE_IDS` 都被 `lastPage` 白名单接受」。

### 4.2 截止视图是纯投影，不建表、不加字段

`buildDeadlineItems` 只读现有快照：任务读 `deadlineLocal`、项目读它自己声明的 `deadlineLocal`、里程碑读 `targetLocalDate`。没有新的 SQLite 表／字段／迁移／Command，也没有把「截止事项」写进 Store。派生记录的唯一用途是呈现与筛选。

### 4.3 日期运算一律走本地日历

`addLocalDays` 用 `Date.UTC(y, m-1, d + amount)` 做**整数日历加法**，`localDaysBetween` 比较两个 UTC 午夜；「未来七天」= `date <= addLocalDays(today, 7)` 的字符串比较，全程不除以固定 24 小时。跨月、跨年、闰年与夏令时切换日都安全 —— 用例刻意选了 2026-03-07（次日即北美夏令时开始）作为分组边界样本。

### 4.4 排序：日期 → 类型 → `sortOrder` → 稳定 ID，项目额外用标题

规格的排序链是「日期升序 → 类型固定顺序 → 原 `sortOrder` → 稳定 ID」。任务与里程碑都有 `sortOrder`，项目**没有**这个字段（`Project` 只有 `id`／`title`／`deadlineLocal`）。本包的做法：任务／里程碑按 `sortOrder`，项目在同一日期与类型内按**标题**升序，最后统一用源 ID 收尾 —— 与 `calendarSummary` 对项目的既有口径一致，也是确定性全序。这是对规格字面的**补充**而非替代（项目的 `sortOrder` 分支为空），已在 §7 与 §9 记录。

### 4.5 里程碑：冻结优先，派生复用 M7 同一规则

`deadlineStateOf` 先查 `outcomesByMilestoneId`：有冻结结果就用它（`reached=false → frozenUnmet`，即使现在任务已经全部完成也不改写）；没有才调用 `milestoneReachedNow`。`milestoneReached`／`orderedMilestoneTasks`／`projectProgress` 本包从 `App.tsx` **迁到** `workspaceSelectors.ts`，项目页与截止页读的是同一份实现 —— 「不得另写一套」在结构上成立（原实现已删除，不是复制）。默认只显示 `open` 与 `frozenUnmet`；`currentlyReached` 要显式切换。

### 4.6 「待回顾」判断收敛，并顺手去掉日历卡片的逐行全量扫描

`isPendingReview` 从 `App.tsx` 迁到 `workspaceSelectors.ts`，今日页改为 `isPendingReviewIn(index, session, now)`。同时把日历卡片的数据来源从 `workspace.executionRecords`（全量）换成 `index.recordsBySessionId.get(session.id)` —— 原实现在**每张卡片**上 `records.some(...)` 扫全量历史，正是规格 §8 要消除的模式；判断本身与语义完全不变（用例与 E2E 全部保持通过）。

### 4.7 筛选／焦点／滚动的位置：App 层内存，滚动走 ref

- 筛选与焦点项放在 `AppShell` 的 `deadlinesView` state（React state，因此跨页返回时页面能直接按它渲染）。
- 滚动位置放在 `deadlinesScrollTop` **ref**：跟手记录不触发整壳重渲染，也不写 Store。
- 滚动容器是应用主内容区 `<main id="main-content">`。它在切换页面时**不重新挂载**，因此进入截止页时页面只需 `useLayoutEffect` 里先落 `scrollTop`、再用 `focus({preventScroll:true})` 恢复焦点行；顺序反了聚焦会把列表拽走。
- 页面自己按 30 秒节拍取本地日期，分组边界随时间推移自动更新，不依赖 `App` 的重渲染时机。

### 4.8 行级动作只发意图，编辑器留在 `App`

任务「编辑」打开与任务池**同一个** `FloatingPanel` + `TaskEditorFields`（`App` 持有 `deadlineEditingTask` 锚元素），「安排」直接复用 `AutoScheduleDialog` 的 `initialTaskId` 预选路径；项目与里程碑只做定位（`ProjectFocusRequest`）与「续排」（打开既有 `MilestoneForm` 的 continuing 草稿）。页面里没有第二份表单、也没有第二套排程逻辑。

### 4.9 两种空状态

「无数据」＝当前不是非默认筛选且列表为空（真的没有截止事项，无可清除之物）；「筛选无匹配」＝非默认筛选下为空，并提供「清除筛选」。判据是 `isDefaultDeadlineFilter(filter)`，工具栏的「清除筛选」按钮在默认筛选下禁用。

### 4.10 导航入口与 200% 缩放

新增第 7 个入口后，`.sidebar nav` 加 `min-height: 0; overflow-y: auto` —— 最小窗口（640px 高）与 200% 缩放下导航自身可滚动，关键入口不会被裁掉。

## 5. 刻意行为变化

| 变化 | 原因 |
| --- | --- |
| `isPendingReview`／`projectProgress`／`milestoneReached`／`orderedMilestoneTasks`／`milestoneSummary` 从 `App.tsx` 迁到 `workspaceSelectors.ts` | 规格 §7.4 要求月历摘要、今日待回顾、回顾共用底层选择器；P4-07 会复用。原实现删除而不是复制，避免两份判断分叉。 |
| 日历卡片按「该时段自己的执行记录」判断待回顾 | 原先每张卡片扫描全量 `executionRecords`；语义不变，去掉规格 §8 点名的逐行全量扫描。 |
| 导航新增「截止事项」（放在日历与项目之间），导航自身可滚动 | 规格 §3 要求新增入口用该标签，并要求重新检查最小窗口高度与 200% 缩放。 |
| `ProjectsPage` 的项目卡与里程碑行新增 DOM id（`project-<id>`／`milestone-<id>`），并新增 `focus`／`onFocusHandled` 两个 prop | 「项目动作定位项目、里程碑动作定位项目内具体目标」需要可定位的锚点与一次性请求。 |
| `App` 的 `useCurrentTime` 之外，截止页另有一份 30 秒节拍 | 分组边界只与「今天」有关；页面自带节拍，避免整个应用壳为它重渲染。 |
| 空状态组件在截止页内自带一份（类名与 `App.EmptyState` 相同） | 页面是独立模块，不反向依赖应用壳；只复用样式，不复制逻辑。 |

P4-04／P4-05 的回归全部保持：滚动仲裁优先级、generation、拖拽延后、程序性滚动不写偏好、`seedCalendarPositions` 播种、日↔周十次不漂移、缩放锚点与预设恒等，以及既有编辑气泡语义（草稿、提交互斥、失败保留草稿、输入法组合期 Enter／Escape 不误提交不误关）均未改动。

## 6. 验证

### 6.1 测试数量

| 层级 | 本次实测 | 本包增量 |
| --- | --- | --- |
| Vitest | **232 / 21 文件** | +41（deadlines 18、workspaceSelectors 10、deadlines 页面 9、settings +1、App +3） |
| Playwright | **33**（自带 Chromium，`--workers=1`） | +2（AC10 两条） |
| Rust | **38 passed / 0 failed** | 0（本包未改 Rust 代码） |
| `tsc --noEmit` + Vite 生产构建 | 见 §6.5 | — |

### 6.2 反向验证（去掉修复即失败）

逐项把关键代码改回缺陷形态后重跑对应用例，**17 项全部如期失败**：

| # | 变异 | 对应用例 | 结果 |
| --- | --- | --- | --- |
| 1 | `addLocalDays` 改成「本地时间构造 + `toISOString().slice(0,10)`」（时区／夏令时类缺陷） | `deadlines.test.ts` 的分组边界与日历加法用例 | 失败 ✓ |
| 2 | 任务过滤不再排除 `kind === "habit"` | 「hides tasks without a deadline and every habit-internal task」 | 失败 ✓ |
| 3 | 任务默认显示全部状态 | 「shows only active tasks by default…」 | 失败 ✓ |
| 4 | 里程碑不再优先读冻结结果 | 「keeps a frozen unmet result even after the project has caught up」 | 失败 ✓ |
| 5 | `currentlyReached` 不再默认隐藏 | 「hides currently reached milestones by default…」 | 失败 ✓ |
| 6 | 排序丢掉类型固定顺序 | 「sorts by date, then kind, then the original sort order, then a stable id」 | 失败 ✓ |
| 7 | 项目改用子任务最后截止日期 | 「uses the project's own declared deadline…」 | 失败 ✓ |
| 8 | `PAGE_IDS` 去掉 `"deadlines"` | `settings.test.ts`「accepts every declared page id…」＋ `App.test.tsx` 导航逐项用例 | 失败 ✓ |
| 9 | `App.tsx` 导航表删掉「截止事项」 | `App.test.tsx`「keeps every navigation entry reachable…」 | 失败 ✓ |
| 10 | 「安排」直接写入执行时段（跳过草案确认） | `App.test.tsx`「previews the schedule draft…」 | 失败 ✓ |
| 11 | 截止页的 `onFocusKey` 不再落到 App 层内存 | `App.test.tsx`「keeps the deadline filter and focus…」 | 失败 ✓ |
| 12 | `orderedMilestoneTasks` 返回全部任务而不是「到目标为止」 | `workspaceSelectors.test.ts`「keeps the ordered-task rule…」 | 失败 ✓ |
| 13 | 页面不再恢复焦点行 | `deadlines-page.test.tsx`「restores the remembered focus row on mount」 | 失败 ✓ |
| 14 | 页面不再记录滚动位置 | `deadlines-page.test.tsx`「records the scroll position…」 | 失败 ✓ |
| 15 | 焦点项失效时不再提示／不再清空 | 「reports a stale focus item…」 | 失败 ✓ |
| 16 | 两种空状态合并成一种 | 「separates the no-data state from the no-match state…」 | 失败 ✓ |
| 17 | 暂停任务也提供安排入口 | 「keeps a paused task visible without offering a schedule entry」 | 失败 ✓ |

AC10 的两条 E2E 同样做过反向验证：去掉页面的滚动恢复、去掉焦点恢复、以及让「安排」跳过预览，E2E 都失败（第 13／14／10 项在 E2E 层复现）。

**一处必须说明的局限**：本机时区是 UTC+8 且没有夏令时，因此「把 7 天边界写成 `(b - a) / 86_400_000 <= 7`」这种**纯固定 24 小时除法**的变异在这个环境里无法被证伪（数值恰好正确）。本包对它的保障是**构造性**的：`addLocalDays` 只对 UTC 日历字段做整数加减，`deadlineGroupOf` 用字符串比较日期，代码里没有任何一处用毫秒差推导日期边界（第 1 项变异证明的是这条路径上的时区类缺陷确实会被现有用例抓到）。要真正在测试里覆盖夏令时，需要在带 DST 的时区（或 `TZ` 环境变量）下重跑同一批用例，这属于 P4-10 的发布前验收范围。

### 6.3 AC08／AC09

- **AC08**：分组边界（含「未来七天」两端与夏令时日期样本）、已完成／暂停／习惯内部任务过滤、当前达成项默认隐藏且可切换，分别由 `deadlines.test.ts`（18 条纯函数用例）与 `deadlines-page.test.tsx`（9 条组件用例）覆盖；`App.test.tsx` 与 AC10 E2E 另在真实渲染路径上复核分组计数。
- **AC09**：冻结目标不被当前达成覆盖由纯函数用例「keeps a frozen unmet result even after the project has caught up」与组件用例（显示「到期未达成」＋冻结结果文本）覆盖；「续排保留旧结果」复用既有 Rust／浏览器回归（`milestoneOutcomes` 不可改写、`updateProjectMilestone`／`deleteProjectMilestone` 拒绝冻结里程碑）以及项目页既有的「续排」用例，本包新增的只是从截止页进入同一条续排路径。

### 6.4 AC10 实测（新增 E2E，真实 Chromium，`--workers=1`）

固定 1200×760 窗口与 2026-08-05 本地日期，种入 12 个跨四个分组的任务截止、1 个项目截止、1 个冻结未达成里程碑与 1 个当前达成里程碑：

| 断言 | 实测 |
| --- | --- |
| 四个分组的行数 | 已逾期 3 / 今天 3 / 未来七天 5 / 以后 3 ✓ |
| 当前达成项默认隐藏 | `.deadline-state.currentlyReached` 计数 0，冻结项保留「完成 0/2，未达成」✓ |
| 打开「显示当前已达成的里程碑」后行数 | 15 ✓ |
| 跨页离开（切到项目页）时的滚动位置 | 被浏览器夹到 0 ✓ |
| 返回后筛选 | 复选框仍勾选 ✓ |
| 返回后滚动位置 | 与离开前误差 ≤2px ✓ |
| 返回后焦点行 | `task:t-06`（离开前点过其「编辑」按钮）✓ |
| 整页重载后 | 复选框回到未勾选、行数 14、滚动 0（重启不恢复）✓ |
| 安排草案 | 「生成排程草案」后仍是预览，`localStorage` 中 `executionSessions` 计数仍为 0；点「应用 N 个时段」后才 >0 ✓ |

### 6.5 `npm run check`

四步串行执行，**exit 0，四步全绿**（总耗时 3m23s）：

```
npm run build   → tsc --noEmit + vite build 通过（dist JS 435.36 kB / CSS 77.72 kB）
npm test        → 232 passed / 21 files
test:e2e        → 33 passed (--workers=1)
test:native     → 38 passed; 0 failed
```

`test:native` 若出现 `error copying object file … full.rmeta … 拒绝访问 (os error 5)`，那是 `src-tauri/target/debug/incremental` 的增量缓存问题，只影响增量写入、不影响编译与结果（见 `docs/reports/phase-4-p4-04-implementation.md` §6.4 第 3 条）。

## 7. 未做与边界

- **不显示任务池**：截止页是「集中查看 + 筛选」的专用列表，没有再并一栏任务池（`hasTaskPool` 仍只含今日／日历／项目）。若希望在这里直接拖拽安排，需要另行设计。
- **关键字只匹配标题**：不匹配项目名、分类或备注；「搜索不改变原对象排序与内容」由「筛选后再排序」保证。
- **项目项在同一天按标题排序**：项目的 `Project` 没有 `sortOrder` 字段（见 §4.4）。规格的 `sortOrder` 一级对项目为空，本包补了标题一级而不是回落到 ID。
- **任务行不提供进度编辑**：行级动作只有「编辑」与「安排」，进度仍在编辑气泡里改（避免在列表上再长出一套进度控件）。
- **筛选／焦点／滚动不写 Store**：整页重载（含恢复备份后的重载）后一律回到默认；协调恢复是整页重载，因此 App 层内存里的旧筛选自然被清掉，无需额外清理逻辑。
- **`scrollLeft` 不参与**：截止页只有纵向滚动。
- **月视图／日周月回顾**：属 P4-07／P4-08，本包未动；`reviewPeriod`／`reviewAnchorDate` 仍无 UI。
- **截止页不新增系统通知**：规格 §6 没有要求，M7 也明确不为项目截止／里程碑新增通知。
- **失效焦点项的处理是「提示 + 清空」**：列表本来就从当前快照派生，所以「刷新列表」就是重新投影；没有额外发起 `get_workspace`（那只会重复读一次同一份数据）。

## 8. 发现的不一致

### 8.1 开工提示词的「工作区里已有 P4-05 的未提交改动」已过期

提示词称工作区里有 P4-05 的未提交改动（`src/lib/settings.ts`、`src/hooks/useCalendarViewport.ts`、`src/App.tsx`、对应测试、`e2e/phase1.spec.ts`、`docs/PROJECT-GUIDE.md`、`.gitignore`）。本包开工时 `git status --short` 只有未跟踪的 `.workbuddy-ai/`；P4-05 的代码与文档已在 `aec92ab`／`cd17ec5` 提交。因此本包的基线是**已提交的 P4-05**，不存在「不要回退未提交改动」的实际约束；本包也未提交任何内容。

### 8.2 `calendarSummary.deadlineUrgency` 仍用固定 24 小时算「7 天内」

规格 §6.1 明确「边界用本地日期运算，禁止除以固定 24 小时推算（夏令时会错）」。本包的 `deadlineGroupOf` 遵守了这条，但 M6 留下的 `src/lib/calendarSummary.ts` 的 `deadlineUrgency` 仍是：

```ts
const milliseconds = new Date(`${deadline}T12:00:00`).getTime() - new Date(`${today}T12:00:00`).getTime();
return milliseconds <= 7 * 86_400_000 ? "soon" : "later";
```

它只用于日历标记与月摘要的**紧迫度文案**（`7 天内截止` / `未来截止`），不影响任何排程事实，也不被截止页使用。夏令时切换周内它可能把 `today+7` 判成 `later`（或反之）。本包未改（属 M6 既有行为，改动会影响日历标记的既有断言），建议在 P4-09 的回归收口里一并统一到 `deadlines.ts` 的日历运算。

### 8.3 文档滞后

- `docs/PROJECT-GUIDE.md` §2 的已知边界写着「独立截止任务页……仍属后续阶段」，本包已按文档同步协议改写为已实现能力。
- 同一节 §2 的「今日、日历、项目、7 天回顾、数据与设置六个页面」需要改为七个页面；§5 代码地图需要补三个新文件；§8 需要补 `lastPage` 的合法值；§11 需要更新测试数量；§12 需要补截止视图的修改入口。以上已同步。
- 开工提示词与 P4-05 报告 §9.3 里「`npm run test:native` 在本机无法编译」的前提**已过期**（本包实测 38 通过，`npm run check` 四步全绿），与 P4-05 报告 §8.1 的结论一致。

### 8.4 未发现规格与领域事实冲突之处

`CONTEXT.md` 的「截止日期」「截止标记」「截止任务视图」「项目截止日期」「项目里程碑」「里程碑达成条件」「任务分类」「优先级」在实现中一一对应：截止视图只集中展示，不新建事实；截止标记仍是日历里的只读提示；项目不声称完成；里程碑达成只用 M7 的三选一规则。未新建 ADR（本包不引入新的长期架构决策，只是把既有判断收敛到共享接缝并新增一个只读页面）。

## 9. 仍需用户决定

1. **截止页是否常驻任务池**：本包按「集中查看」定位未加（§7）。若希望在此直接拖拽安排，需要重新设计三栏布局。
2. **关键字是否也匹配项目名**：目前只匹配标题。若匹配项目名，任务行会因所属项目名命中而出现，需要明确文案。
3. **项目项的排序**：规格字面的 `sortOrder` 一级对项目为空（§4.4）。当前用「标题 + 稳定 ID」。若更希望按 ID（即工作区顺序无关的纯稳定序），改一处比较器即可。
4. **`calendarSummary.deadlineUrgency` 是否一并改成日历运算**（§8.2）：会改变日历标记在夏令时周的「7 天内截止」边界，属 M6 既有行为的订正。
5. **导航入口的位置**：本包把「截止事项」放在「日历」与「项目」之间。若希望放在「项目」之后或末尾，改导航表一行即可（三处同步由测试保证）。
