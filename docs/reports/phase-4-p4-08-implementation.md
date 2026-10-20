# 阶段 4 P4-08 实施报告：日／周／月回顾页面、下钻、图表等价数据与回顾偏好

日期：2026-10-15。对应工作包：P4-08（`docs/specs/0005-phase-4-daily-workflow-and-reliability.md` §10），依赖：P4-07、P4-03。
状态：**代码、测试与验证已完成**；AC13 的 E2E 与 AC14 的 axe／缩放检查成立。

## 1. 范围

按开工提示词交付五项：

1. 新增 `src/components/review/`：把 `App.tsx` 里内联的 `ReviewPage` 迁出并扩展为**周期页面**，按规格 §7.4 的顺序组织（① 成果与待续 → ② 投入和进度图 → ③ 任务／项目明细 → 页面内明细区 → 口径说明）。
2. 周期选择与回顾偏好：`reviewPeriod`／`reviewAnchorDate` 真正被读写，走既有 `updatePreferences` → `SettingsRepository` 写入队列。
3. 下钻与明细：日期／项目／任务都能打开页面内明细区，键盘可达（Tab 进出、Esc 关闭、焦点归还），回到汇总保留查询与滚动；未知引用显示「来源不可用」且不崩页面。
4. 移除兼容入口：`buildSevenDayReview` 删除，全仓只剩 `buildReview`／`buildReviewFromIndex`。
5. 导航标签改名：`App.tsx` 导航表、`App.test.tsx` 导航逐项用例、`e2e/phase1.spec.ts` 三处同步为「回顾」，页面标题按周期给出。

明确未做（越界项）：不新增依赖（图表是纯 CSS）；不改 `review.ts` 的九项统计口径与 `notes`（只补下钻用的明细列表，见 §4.5）；不新增 SQLite 迁移／字段（schema 仍 v7）、不新增 Tauri Command；不改 P4-04／P4-05 的滚动仲裁与「程序性滚动不写偏好」闸门；不改缩放范围与预设；不改截止页（P4-06）与决议 D1–D6 的任何一条；明细区的筛选／焦点／滚动不写 Store；不做 M12 的长列表性能测量。

## 2. 交付清单

| 文件 | 变更 |
| --- | --- |
| `src/components/review/review-page.tsx` | **新增**。周期页面：周期选择（日／周／月）、上一／下一周期、回到当前周期、项目范围说明、① ② ③ 三段、明细区宿主、口径说明与空状态；偏好读写与 App 层内存状态的归属见 §4.4。 |
| `src/components/review/review-chart.tsx` | **新增**。纯 CSS 柱状图 + 始终可见的等价数值表；一张图一个单位；净进度含零基线与文字说明；全零周期不绘图。 |
| `src/components/review/review-detail.tsx` | **新增**。页面内明细区：日期／项目／任务三种目标，显示原始事件时间、进度变化、计划时段、实际起止、已记录备注与待续原因；Esc 关闭、未知引用兜底。 |
| `src/components/review/review-page.test.tsx` | **新增** 15 个组件用例（页面顺序、单位、零基线、等价数值表、全零、偏好、下钻键盘路径、滚动恢复、触发元素被替换时按身份找回、无入口时退到页面标题、未知引用、行级动作与项目筛选、`notes`、未推进分别说明）。 |
| `src/lib/review.ts` | 补下钻明细：`ReviewDaySummary.events`／`records`，`ReviewTaskDetail.sessions`／`records`／`runningRecords`／`carryoverReasons`（+ `ReviewCarryoverReason`）；**删除** `buildSevenDayReview`；新增记录／时段排序比较器。九项口径与 `notes` 未变。 |
| `src/lib/deadlines.ts` | 新增导出 `addLocalMonths`（本地日历月加减，月末收敛；回顾页翻月与测试共用，不另写 `setMonth`）。 |
| `src/lib/review.test.ts` | 兼容入口的 5 条用例改写为**等价的新引擎用例**（4 条）并新增 3 条下钻明细用例（共 38 条）。 |
| `src/lib/deadlines.test.ts` | 新增 `addLocalMonths` 的月末收敛、跨年与往返恒等用例。 |
| `src/lib/settings.test.ts` | 回顾周期／锚点从「占位」升级为「保存重载恒等 + 非法值回退」用例。 |
| `src/App.tsx` | 删除内联 `ReviewPage`；改为渲染 `src/components/review/review-page.tsx`；新增 `reviewView`（项目筛选 + 明细选择，App 层内存）与 `reviewScrollTop`（ref）；导航标签「7 天回顾」→「回顾」；任务编辑气泡状态由截止页与回顾页共用（`deadlineEditingTask` → `taskEditorAnchor`，仅重命名）。 |
| `src/App.test.tsx` | 导航逐项用例的回顾标签／标题更新；新增 2 条 P4-08 用例（偏好保存重载恒等、下钻与项目筛选同会话保留但重启不恢复）。 |
| `src/styles.css` | 回顾样式重写：成果／图表／明细行／明细区／`notes`；`review-charts` 等旧类（`.review-days`／`.review-bar`）随内联页面一起移除。 |
| `e2e/phase1.spec.ts` | 阶段 2 用例的回顾标签／标题更新；新增 3 条 M11 用例（汇总与明细可核对 + 偏好跨重启、明细键盘下钻与滚动恢复、200% 缩放下浅／深色 axe 与核心路径）。 |
| `docs/PROJECT-GUIDE.md` | 按文档同步协议更新 §2／§5／§6／§8／§11／§12 与已知边界。 |
| `README.md` | 「当前已实现」里把「简单最近 7 天回顾」换成截止事项页与日／周／月回顾（含图表与下钻），补上阶段 4 P4-01–P4-08 的交付状态，并订正「独立截止任务页／完整日／周／月回顾仍属后续阶段」这句已过期的话。 |
| `docs/reports/phase-4-p4-08-implementation.md` | 本报告。 |

前端部分无新增依赖、无 SQLite 变更、无 Tauri Command、无 Rust 改动。

## 3. 契约

```ts
// src/components/review/review-page.tsx
export type ReviewSelection = { kind: "date" | "project" | "task"; id: string };
interface ReviewPageProps {
  index: WorkspaceIndex;                 // 页面只消费 App 建好的稳定索引
  preferences: AppSettings;              // 读 reviewPeriod / reviewAnchorDate
  onPreferences: (patch: Partial<AppSettings>) => void;  // 写偏好（唯一持久化状态）
  projectId: string | null;              // 项目下钻（引擎查询的一部分，App 层内存）
  onProjectId: (projectId: string | null) => void;
  selection: ReviewSelection | null;     // 明细区目标（App 层内存）
  onSelection: (selection: ReviewSelection | null) => void;
  scrollRef: RefObject<HTMLElement | null>;  // 主内容区（滚动容器）
  scrollTop: RefObject<number>;              // 滚动位置（ref，不触发重渲染）
  onGoToday: () => void;
  onEditTask: (task: Task, anchorElement: HTMLElement) => void;
  onArrangeTask: (task: Task) => void;
  onOpenProject: (projectId: string, milestoneId: string | null) => void;
}

// src/lib/review.ts（P4-08 新增的明细字段；其余同 P4-07 报告 §3）
interface ReviewDaySummary { /* …既有 8 项… */ events: ProgressEvent[]; records: ExecutionRecord[] }
interface ReviewTaskDetail {
  /* …既有字段… */ sessions: ExecutionSession[]; records: ExecutionRecord[]; runningRecords: ExecutionRecord[];
  carryoverReasons: ReviewCarryoverReason[];   // "incompleteAdvance" | "pendingReview" | "notAdvanced" | "skippedOccurrence"
}

// src/lib/deadlines.ts
function addLocalMonths(date: string, amount: number): string
```

- **页面只建一次索引**：`App` 的 `workspaceIndex`（`useMemo`）直接传给回顾页，页面用 `buildReviewFromIndex`，不再为回顾扫一遍全量数组。
- **`ReviewResult` 是只读投影**：`tasks[].taskId`／`milestones[].milestoneId` 是原始 ID；行级动作把原始 `Task`／`Project` 交给 App（编辑气泡与排程入口复用截止页那一套）。
- **`notes` 原样展示**（含设备时区名），页面不编造自己的口径文案。

## 4. 关键实现决策

### 4.1 页面顺序固定，页面只呈现

三段顺序与 `notes` 的顺序在组件测试里逐项钉住（`.review-page > section` 的类名序列 + 三个 `h2`）。页面不做任何聚合运算：每行、每列、每个数字都来自 `ReviewResult` 或 `formatPercentPoints`／`formatRecordedMs`／`formatTaskProgressRange`。

### 4.2 图表：一张图一个单位、零基线、等价数值表

- **单位**：`ReviewChart` 只有一个 `unit` 属性，投入图传「分钟」、进度图传「百分点」；两张图各有自己的数值表。组件测试断言「分钟图不含『百分点』、进度图不含『分钟』」。
- **零基线**：`zeroPercent = maxUp / (maxUp + maxDown) × 100`，正值从基线向上、负值向下；零基线本身画一条虚线。全正时基线落在底部（普通柱状图），有下调时上移（本例 20↑/30↓ → 40%）。**不用色阶**：下调用 `--muted-strong` + 边框，并配一句「零基线以上是上调，以下是下调；下调如实显示，不代表失败」。
- **等价数值表**：始终可见，与图上的柱逐列对应（`data-chart-row` ↔ `data-chart-column[data-chart-date]`），并复用引擎已经算好的显示值（`recordedMinutes` → 「60 分钟」／「未记录」）。图表本体 `aria-hidden`，可访问的等价物就是那张表。
- **空周期不画图**：`hasValues = rows.some(value !== 0)`；全零时只给一句说明（投入图「本周期没有记录实际投入，因此不绘制全零图表。」）。整个周期没有事实时连 ①②③ 都不渲染，只留周期入口与中性的空状态（沿用既有文案「没有记录时不绘制全零图表，也不会把未记录解释为失败」）。

### 4.3 下钻是页面内区域，不是模态

明细区是一个 `role=region`（`aria-labelledby`）+ `tabIndex={-1}` 的 `<section>`：

- **打开**：记录触发元素与打开前的 `scrollTop`，`scrollIntoView({ block: "nearest" })` 把它带进视野，然后聚焦容器本身 —— 这样 Esc 才落在它自己的 `onKeyDown` 里，Tab 也能自然进出（不锁背景、不抢全局 Esc，与编辑气泡的模态语义不冲突）。
- **关闭**：`onSelection(null)` → 焦点还给触发元素（`preventScroll`）→ 恢复打开前的 `scrollTop`。触发元素**可能已经被替换掉**（从某一天的明细里继续下钻到任务时日期明细随之卸载；切页返回后原节点也不再是同一个），所以记的是它的**身份** `kind:id`：原节点还在就直接用，否则按 `[data-review-trigger]` 找回同一个目标的另一个入口（与截止页用 `data-deadline-key` 找回焦点行同理），再不行退到页面标题（`h1` 带 `tabIndex={-1}`）—— 始终不调用已断开的节点，键盘用户不会掉到 body。查询（周期／锚点／项目筛选）在关闭时**不被动过**。
- **挂载时不抢焦点**：从别的页面回来时只恢复 `scrollTop`（与截止页同一套），不会重新把页面滚到明细区。
- **未知引用**：任务是查 `index.tasksById`、项目是查 `index.projectsById`、日期是查 `result.days`（等价于 `deadlineItemSourceExists` 的判据，但按本页的类型写，不硬套截止页的类型）。任务缺失时显示「来源不可用」；任务存在但本周期无事实时保留仍成立的事实（「当前完成度 N% 是**当前值**，不是这一周期的历史」）；日期不在当前周期时说明「查询已经改变」。

### 4.4 状态归属：偏好 vs App 层内存

| 状态 | 归属 | 理由 |
| --- | --- | --- |
| `reviewPeriod`／`reviewAnchorDate` | 偏好（`SettingsRepository` 写入队列） | 规格 §7.1「首次进入默认当前周，此后记住周期和锚点」 |
| 项目筛选（引擎 `projectId`） | App 层内存 | 与截止页筛选同规则：同会话跨页有效、重启不恢复、不写 Store |
| 明细区选择（`selection`） | App 层内存 | 同上 |
| 滚动位置 | App 层 `ref` | 同上（每滚一像素不重渲染应用壳） |
| 展开／收起等临时状态 | 无 | 明细区没有需要记住的展开态 |

锚点为 `null` 时按「当前周期」计算：`anchorDate = preferences.reviewAnchorDate ?? localDateOf(now)`，时钟由页面按 30 秒节拍取一次并注入引擎（引擎内不读时钟）。翻页写锚点：日 ±1 天、周 ±7 天（`addLocalDays`）、月 ±1 个自然月（`addLocalMonths`）；「回到当前周期」写 `null`（把锚点交回时钟）。

### 4.5 引擎补的是「明细列表」，不是统计口径

P4-07 的九项口径与 `notes` 一个字都没改。新增字段的理由是**页面不该自己再过滤一遍事实**：

- `days[].events`：事件已经按本地日分桶，页面不必用 `localDateOf` 再分一次（也就不会长出第二套分桶规则）。
- `days[].records`：与那一天窗口有交集的**已结束**记录（跨午夜的记录同属两天，与「投入按交集毫秒切分」不矛盾）。
- `tasks[].sessions`／`records`／`runningRecords`：计划时段、已结束记录、进行中记录三者分开给，明细区因此能保持「计划／实际不混」。
- `tasks[].carryoverReasons`：待续的四个分支语义不同（「推进过但没完成」≠「根本没推进」），页面需要如实说出是哪一种，而不是自己再判断一遍。这是 P4-07 报告 §9 里点名的可选补字段。

排序也由引擎统一给出：事件按 `(occurredAtUtc, id)`，记录按 `(actualStartUtc, id)`，计划时段按 `(localDate, startLocal, id)` —— 与既有日历顺序一致，页面不排序。

### 4.6 兼容入口移除

`grep -rn "buildSevenDayReview" src/ e2e/` 在移除前只有两处：`App.tsx` 的内联 `ReviewPage` 与 `review.test.ts`。两者都已改写（`App.tsx` 改为渲染新页面，测试改写为等价的新引擎用例），随后删除函数。`review.test.ts` 里那条「7 天适配逐日等价」的用例随之作废（它证明的是适配层与引擎一致，适配层不存在了），被 §4.5 的下钻明细用例取代。P4-07 报告 §9.5「第三个参数是否保持必需」因此**作废**。

### 4.7 导航改名与三处同步

`PageId` 仍为 `"review"`，`PAGE_IDS` 未动。改名同步了三处：

1. `src/App.tsx` 导航表 `{ id: "review", label: "回顾" }`；
2. `src/App.test.tsx` 的 `NAVIGATION` 逐项用例 `["review", "回顾", "本周回顾"]`；
3. `e2e/phase1.spec.ts` 的阶段 2 用例（`getByRole("button", { name: "回顾", exact: true })` + `heading "本周回顾"`）。

页面标题按周期给出：日＝`8月5日回顾`、月＝`2026年8月回顾`、周＝当前周说`本周回顾`，翻到别的周则给出范围（`8月3日 — 8月9日回顾`）——「本周」不能用在不是本周的那一周上。

### 4.8 任务编辑气泡由截止页与回顾页共用

`App.tsx` 里那个「编辑任务 X」的气泡原来叫 `deadlineEditingTask`，现在两个页面都用它，因此重命名为 `taskEditorAnchor`／`taskEditorBusy`（只有变量名与注释变化，气泡本身、编辑会话与无障碍名称都没动；截止页的既有用例原样通过）。

## 5. 刻意行为变化

| 变化 | 原因 |
| --- | --- |
| 导航标签「7 天回顾」→「回顾」；页面标题从固定「最近 7 天回顾」改为按周期给出 | 规格 §3 明确要求标签随周期选择一并改；有了日／周／月之后「7 天」不再准确。 |
| 回顾页不再有「每天的事实」进度条列表，改为「投入」与「进度」两张图 + 两张等价数值表 | 规格 §7.4：投入图只用分钟、进度图只用百分点。旧页面的条宽取 `max(progressDelta, actualMinutes / 3)`，把两种量纲混在一根条上（GUI 评估 2026-09-06 记录过这个问题）。 |
| 空周期也保留周期入口与空状态说明 | 旧页面把整个内容替换成空状态，连周期都换不了；现在标题栏（周期选择／翻页）始终可用。 |
| `buildSevenDayReview` 删除 | 规格 §7.4「迁移调用者到新引擎后移除」；本包就是那个时机。 |
| 引擎新增 `days[].events`／`records` 与 `tasks[].sessions`／`records`／`runningRecords`／`carryoverReasons` | 下钻要显示原始事实；放在引擎里可以避免页面自己按日期／任务过滤，从而不产生第二套分桶或第二套口径。九项统计与 `notes` 未变。 |
| `App.tsx` 的 `deadlineEditingTask` → `taskEditorAnchor` | 同一气泡现在服务两个页面；纯重命名，无行为变化。 |

P4-04～P4-07 的回归全部保持：滚动仲裁优先级与 generation、拖拽延后、程序性滚动不写偏好、`seedCalendarPositions` 播种、日↔周十次不漂移、缩放锚点与预设恒等、截止页分组／筛选／焦点／滚动、引擎九项口径与两条源码护栏、既有编辑气泡语义、撤销提示的五秒收起与悬停暂停，均未改动（`npm run check` 四步全绿）。

## 6. 验证

### 6.1 测试数量（本次实测）

| 层级 | 本次实测 | 本包增量 |
| --- | --- | --- |
| Vitest | **291 / 24 文件** | +20（`review-page.test.tsx` 15 条新文件、`review.test.ts` −5 兼容 +7 等价与新明细、`deadlines.test.ts` +1、`settings.test.ts` 改写 1 条、`App.test.tsx` +2） |
| Playwright | **37** | +3（M11 三条） |
| Rust | **38 passed / 0 failed** | 0（本包未改 Rust 代码） |
| `tsc --noEmit` + Vite 生产构建 | dist JS 465.45 kB（gzip 137.34 kB）／CSS 81.24 kB | — |

`npm run check` 四步串行执行，**exit 0，四步全绿**（2026-10-15 实测）：

```
npm run build   → tsc --noEmit + vite build 通过（dist JS 465.45 kB / CSS 81.24 kB）
npm test        → 291 passed / 24 files
test:e2e        → 37 passed
test:native     → 38 passed; 0 failed
```

E2E 使用自带 Chromium；本次运行由 `scripts/run-e2e.mjs` 启动（默认 worker 数），并在启动前把上一次的 `test-results/` 残留用 rename 挪进 `_quarantine/`（未新增未处理批次）。

**第一次 `npm run check` 红在一个既有用例上（不是本包的代码）**：`App.test.tsx` 的 P4-04 用例「restores the day browsing position after a round trip through the week view」用固定 `setTimeout(360)` 等 300ms 的滚动落定防抖，机器忙时防抖还没跑完就去读偏好（`readCalendarPositions().day` 为 `undefined`）。它单独跑 3/3 通过、紧接着重跑 `check` 即绿，本包没有改动这条用例或它覆盖的实现。按「不改 P4-04 的内容」的要求未顺手修；建议 P4-09 把它换成 `waitFor(() => expect(readCalendarPositions().day).not.toBeNull())`（断言值不变，只去掉固定等待）。

### 6.2 反向验证（去掉修复即失败）

把 14 处修复逐项改回缺陷形态后重跑对应用例，**14 项全部如期失败**（脚本：`.workbuddy-ai/tmp/p4-08-reverse-verify.sh` ＋ 变异定义 `.workbuddy-ai/tmp/p4-08-mutations.mjs`，逐项改完立即从原样副本还原；跑完 4 个源文件的 SHA-1 与跑前逐字节一致）：

| # | 变异 | 被抓到的用例 |
| --- | --- | --- |
| 1 | 零基线恒在底部（净负进度画不出来） | 净负进度的零基线与文字说明 |
| 2 | 进度图改用「分钟」 | 一张图一个单位 |
| 3 | 去掉等价数值表 | 页面顺序与「两张图两张表」 |
| 4 | 全零周期也画图 | 空周期不绘制全零图表 |
| 5 | 明细区不响应 Esc | 明细键盘打开与 Esc 关闭 |
| 6 | 关闭明细不恢复滚动 | 回到汇总保留查询与滚动 |
| 7 | 未知引用不再兜底（直接崩） | 未知引用保留仍成立的事实 |
| 8 | 切换周期不写偏好 | 周期与锚点写偏好 |
| 9 | 图表区被标成明细区（顺序错） | 页面顺序 |
| 10 | 该日事件全部塞进周期第一天 | 明细按本地日分桶 |
| 11 | 待续原因恒为空 | 待续原因分支 |
| 12 | 数值表直接显示原始数字（丢掉「未记录」） | 一张图一个单位（数值表口径） |
| 13 | 进行中的执行混进明细记录 | 计划／已结束／进行中三者分开 |
| 14 | 明细不显示已记录备注 | 明细显示原始备注 |

### 6.3 AC13／AC14

- **AC13（日／周／月汇总与明细可核对，当前进度不冒充历史）**：纯函数层由 `review.test.ts` 覆盖（日／周／月互相对照、明细与汇总相加一致）；页面层由 `review-page.test.tsx` 覆盖（数值表 ↔ 图上的柱逐列一致、③ 行与 ② 表一致）；浏览器层由 E2E「keeps day, week and month summaries checkable against their detail and remembers the choice」覆盖：默认当前周 → 断言 `实际投入 60 分钟`／`净进度 -10 百分点`／8-04 是「60 分钟」+「+20 百分点」／8-05 是「未记录」+「-30 百分点」／零基线在 40%；③ 明细里 `Alpha 任务` 显示 `40% → 60%`、`明细任务 1`（只有计划没有事件）显示 `本周期无进度记录，当前 45%`；切日／切月（31 行日期概览）、翻页写锚点、重启后仍是同一个月、「回到当前周期」写回 `null`。
- **AC14（浅／深色、100／150／200%、960／1200 宽度核心路径可完成）**：新增 E2E 在 960×640 + 200% 缩放下对回顾页跑 axe（浅／深色各一次，`violations` 均为空），并断言 `#main-content` 无横向溢出（`scrollWidth - clientWidth ≤ 2`）、等价数值表可见、从日期下钻再 Esc 关闭这条核心路径可完成。另有三组既有 E2E（`gui-optimization.spec.ts` 的 960/1200 × 100/150/200%）在四步串行的 `check` 里继续通过，导航入口在高缩放下可达由 `App.test.tsx` 的逐项用例兜住。

## 7. 未做与边界

- **规格 §7.1「从某日进入则临时聚焦该日」暂不存在入口**：目前没有任何页面会带着某一天跳到回顾页（今日页／日历／截止页都没有这个动作），本包**不凭空造**一个入口。回顾页只在自身内部改查询（周期／翻页／项目筛选）。该路径在规格里成立的前提是将来有页面要跳进来，届时只需在 `App` 里设置 `reviewAnchorDate` 即可。
- **不做 M12**：不测量 1000 任务／10000 条历史的渲染预算，也不做虚拟列表（属 P4-09）。
- **不做跨设备时区承诺**：进度事件按查看设备的本地时区分桶，`notes` 原样展示当前时区；当前模型没有每次进度事件的本地时区快照。
- **里程碑明细不补字段**：`ReviewResult.milestones` 仍只给冻结结果／当前达成与文本（P4-07 §9.4 的结论：够用）。「成果」区显示目标日期、达成与否、是否冻结与结果文本，不显示达成条件的更多细节。
- **`notes` 不改写**：页面原样展示引擎口径（含设备时区名），没有在组件里另写一套说法。
- **回顾页不常驻任务池**：`hasTaskPool` 仍只含今日／日历／项目（决议 D1 的同类问题在回顾页不适用：回顾是只读投影）。
- **项目筛选是「额外能力」而不是必需**：明细区的「只看这个项目」把 `ReviewQuery.projectId` 接上界面，用于看该项目的周期合计；不点它也能完成任务级与日期级下钻。

## 8. 发现的不一致

### 8.1 `PROJECT-GUIDE.md` §8 两处「不读取它们」（已修）

原文写「这两项在 P4-05 只落了默认值与规范化，界面入口与读取属 P4-08；当前『7 天回顾』页面仍按最近七日固定计算，**不读取**它们」。本包已按文档同步协议改写。

### 8.2 `PROJECT-GUIDE.md` §2 已知边界「回顾引擎只产出数据，没有页面」（已删）

同一条里还有「经 `buildSevenDayReview` 兼容入口走同一引擎」，本包一并删除并替换为现在的三条边界（时区分桶、无「从某日进入」入口、不常驻任务池）。

### 8.3 `PROJECT-GUIDE.md` §5 的 `review.ts` 行（已改）

原文的「`buildSevenDayReview` 是同一引擎之上的兼容入口（薄适配，移除调用者属 P4-08）」已替换为移除后的事实与新增明细字段。

### 8.4 规格 §3 与实现的一处措辞

规格 §3 写「M11 落地后『7 天回顾』这一标签须随日／周／月周期一并改为与周期选择一致的措辞」——本包按此执行（导航「回顾」、标题按周期）。规格没有规定具体文案，本包选了最不易误解的一组（见 §9.1）。

### 8.5 `README.md` 的「当前已实现」已落后两个工作包（已修）

README 仍写着「简单最近 7 天回顾」与「独立截止任务页、完整日／周／月回顾仍属后续阶段」——截止事项页在 P4-06 就已交付，本包又交付了回顾页。按文档同步协议一并订正（README 的定位仍是简介与入口，细节留在 PROJECT-GUIDE）。

### 8.6 未发现规格与领域事实冲突之处

`CONTEXT.md` 的「回顾」「执行记录」「未执行时段」「投入时间」「完成度」「待回顾」「待续」「里程碑达成条件」在实现中一一对应：页面只汇总既有事实，不评分、不算连续天数、不把未记录读成失败、不把当前进度冒充历史，也不替用户声称做过什么。未新建 ADR（本包是既有事实的界面层，没有引入新的长期架构决策）。

## 9. 仍需用户决定

1. **周期标题的文案**：现在日＝`8月5日回顾`、月＝`2026年8月回顾`、周＝当前周 `本周回顾`、非当前周 `8月3日 — 8月9日回顾`。若更希望周一律显示日期范围（或统一加「第 N 周」），只需改 `periodTitle` 一处。
2. **打开明细后的焦点落点**：现在聚焦明细区容器（`tabIndex=-1`），Tab 从容器进入第一个控件。若希望直接聚焦「关闭」按钮或第一条事实，改一行即可。
3. **项目筛选是否要跨重启**：现在按 P4-06 的规则只放 App 层内存（重启回到「全部项目」）。若希望它像周期一样被记住，需要把它变成偏好（会新增一个 `AppSettings` 字段）。
4. **`notes` 是否要缩短成 UI 文案**：现在原样展示引擎口径（含设备时区名与「执行记录累计」等说法）。若嫌长，需要改引擎的 `notes` 而不是只改组件（否则会出现两套说法）。
5. **回顾页是否要给任务提供「安排」之外的动作**：现在明细区提供「编辑」「安排」「定位项目」，与截止页一致；如果希望回顾页只读（不提供写入入口），删掉这三个按钮即可。
   **已定（2026-10-20）**：任务／项目明细的**行内**不再放「编辑」「安排」，行内只留「待续」这个事实标记（放在任务名前面、占固定一列）；三个动作只保留下钻明细里的那一份。同日又把下钻明细从页内区域改成**锚在触发元素下方的气泡**（非模态，点空白／点别的板块／Esc 关闭），并把内容改成「一块事实一张卡」。理由：§7.4 的明细只呈现证据，§7.2 给待续的出口只有「查看或安排」，行内编辑改的是任务当前状态、与「看周期历史」语义错位；且周期内几乎每个 active 任务都是待续，行内一对 44px 按钮会让明细区变成待办清单（200% 缩放下占掉 40% 行宽、把任务名挤到折行）。
