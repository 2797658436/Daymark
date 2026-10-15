# 阶段 4 P4-07 实施报告：周期统计引擎、跨日拆分与事实口径样本

日期：2026-10-15。对应工作包：P4-07（`docs/specs/0005-phase-4-daily-workflow-and-reliability.md` §10），依赖：P4-01、P4-06。
状态：**代码、测试与验证已完成**；AC11／AC12／AC13 的纯函数与数值层成立（图表与页面属 P4-08）。

## 1. 范围

按开工提示词交付四项：

1. `src/lib/review.ts` 重写为周期统计引擎：`ReviewPeriod`／`ReviewQuery`／`buildReview(workspace, query, now)`，日＝本地自然日、周＝周一至周日、月＝自然月，`now` 显式注入，`projectId` 过滤。
2. 规格 §7.2 的九行口径逐行实现（净进度变化、曾完成任务数、有进度变化任务数、已记录实际投入、进行中的执行、待回顾、明确未推进／跳过、待续，以及表头的「统一统计口径」本身）。
3. `buildSevenDayReview` 保留为兼容入口，改为新引擎之上的薄适配；公开返回形状不变。
4. 复用而非重写：「待回顾」判断只来自 `workspaceSelectors`，里程碑达成规则、项目加权进度、本地日历运算也都读既有实现。

明确未做（越界项）：不新增 `src/components/review/`（周期选择／图表／下钻）、不改导航、不接线 `reviewPeriod`／`reviewAnchorDate` 的 UI；不写 Tauri Store、不新增偏好字段；不新增 SQLite 迁移／字段（schema 仍 v7）、不新增 Tauri Command、不新增依赖；不改 P4-04／P4-05 的滚动仲裁与「程序性滚动不写偏好」闸门；不改缩放范围与预设；不修改任何历史事实（引擎是只读投影）。

## 2. 交付清单

| 文件 | 变更 |
| --- | --- |
| `src/lib/review.ts` | **重写**。`ReviewPeriod`／`ReviewQuery`／`ReviewResult`（含 `days`／`progress`／`actual`／`plan`／`pendingReview`／`notAdvanced`／`carryoverTaskIds`／`tasks`／`milestones`／`notes`）、`reviewRange`、`buildReview`／`buildReviewFromIndex`、`buildSevenDayReview`（兼容适配）、`formatPercentPoints`／`formatRecordedMs`／`formatTaskProgressRange`／`REVIEW_PERIOD_LABEL`。 |
| `src/lib/review.test.ts` | **重写** 36 个用例（原 4 个）：周期边界、跨午夜／跨月拆分、毫秒精度、并行记录、进行中执行、九项口径、项目过滤、日月周汇总核对、7 天兼容入口、两条源码护栏。 |
| `src/lib/review.timezone.test.ts` | **新增** 2 个用例：在 `America/New_York` 下验证 23 小时本地日与「春季跳时」的真实经过时长。 |
| `src/lib/deadlines.ts` | 新增导出 `isLocalDate`（真实有效的本地日期判据，与 `settings.ts` 的规范化同源）。避免在 `review.ts` 里再写第三份正则。 |
| `src/App.tsx` | `ReviewPage` 用 `useCurrentTime()` 取一次时钟并把 `now` 显式传给 `buildSevenDayReview`（两行）。 |
| `docs/reports/phase-4-p4-07-implementation.md` | 本报告。 |
| `docs/PROJECT-GUIDE.md` | 按文档同步协议更新 §2／§5／§6／§8／§11／§12 与已知边界。 |

前端部分无新增依赖、无 SQLite 变更、无 Tauri Command、无 Rust 改动。

## 3. 契约

```ts
// src/lib/review.ts
type ReviewPeriod = "day" | "week" | "month";
interface ReviewQuery { period: ReviewPeriod; anchorDate: string; projectId: string | null }

interface ReviewDaySummary { date; progressDelta; recordedMs; recordedMinutes; pendingReviewCount; notAdvancedCount; skippedCount; runningCount }
interface ReviewProgressSummary { netDelta: number; changedTaskIds: string[]; completedTaskIds: string[] }
interface ReviewActualSummary { recordedMs; recordedMinutes; runningRecords: ExecutionRecord[]; overlapping: boolean; unrecorded: boolean }
interface ReviewPlanSummary { sessionCount: number }
interface ReviewNotAdvancedSummary { missedSessions; skippedSessions; cancelledSessions; skippedOccurrences; count }
interface ReviewMilestoneSummary { milestoneId; projectId; title; targetLocalDate; frozen; reached; resultText }
interface ReviewTaskDetail {
  taskId; title; projectId; currentProgress; currentStatus;
  netDelta; events; startProgress: number | null; endProgress: number | null; everCompleted;
  recordedMs; runningCount; pendingReviewCount; missedCount; skippedCount; carryover;
}
interface ReviewResult {
  period; anchorDate; startDate; endDate; projectId;
  days; progress; actual; plan; pendingReview; notAdvanced; carryoverTaskIds; tasks; milestones; notes;
}

function reviewRange(period, anchorDate): { startDate; endDate }
function buildReview(workspace, query, now: Date): ReviewResult
function buildReviewFromIndex(index: WorkspaceIndex, query, now: Date): ReviewResult
function buildSevenDayReview(workspace, endDate: string, now: Date): { startDate; endDate; days; progressedTaskIds; completedTaskIds; carryoverTaskIds }

// src/lib/deadlines.ts
function isLocalDate(value: unknown): value is string
```

- **`buildReviewFromIndex`** 与 `deadlines.ts` 的 `buildDeadlineItemsFromIndex` 同构：页面只建一次索引，不为回顾再扫一遍全量数组。
- **`ReviewResult` 是只读投影**：`tasks[].taskId`／`milestones[].milestoneId` 都是原始 ID，派生记录不是可保存对象。
- **`notes`** 是口径说明（当前设备时区、项目过滤、并行记录、同一时刻事件、有计划但未记录），页面原样展示，不自行编造。

## 4. 关键实现决策

### 4.1 周期是日历周期，日期运算只走整数日历加法

`reviewRange` 的三条分支：日＝锚点当天；周＝`(utcWeekday(anchor) + 6) % 7` 回退到周一、再 `addLocalDays(start, 6)`；月＝`${year}-${pad(month)}-01` 到 `addLocalDays(first, daysInMonth(year, month) - 1)`。全部复用 `deadlines.ts` 的 `addLocalDays`（`Date.UTC` 整数加减），`daysInMonth` 用 `new Date(Date.UTC(year, month, 0)).getUTCDate()`。**没有一处**用固定毫秒推导日期边界。

`anchorDate` 不是真实本地日期时（`2026-02-30`）回退到 `localDateOf(now)`，不猜、不抛错。

### 4.2 `now` 显式注入，引擎内不读时钟

`buildReview`／`buildReviewFromIndex`／`buildSevenDayReview` 都要求传入 `now`。引擎内出现的 `new Date(...)` 只有三种用途：把已保存的 UTC 时间点解析成时间戳、按设备本地时区构造某个本地日期的日界、由日历字段构造 UTC 午夜。没有任何 `Date.now()` 或无参 `new Date()`。

这条不是靠自觉：`review.test.ts` 的「engine guards」直接读 `src/lib/review.ts` 源码（先剥掉注释）断言不含 `Date.now()` 与无参 `new Date()`，另有一条行为用例证明同一个快照在不同 `now` 下给出不同的待回顾结果。反向验证 #14 证明去掉这条纪律会被抓到。

### 4.3 跨日拆分：按 UTC 毫秒求交，日界换算成 UTC

```
localDayStartMs(date) = new Date(y, m - 1, d).getTime()   // 设备本地时区的本地午夜
dayWindows[i] = [localDayStartMs(dates[i]), localDayStartMs(addLocalDays(dates[i], 1))]
overlap = min(recordEnd, dayEnd) - max(recordStart, dayStart)
```

- 日界由**本地日历字段**构造，所以夏令时那天的窗口自然就是 23 或 25 小时，不需要额外分支。
- 交集用 UTC 毫秒相减；跨午夜（含跨月、跨年）的记录按日分别计入，规格 §7.3 的 23:50–次日 00:20 → 前日 10 分钟、次日 20 分钟成立。
- 记录完全落在周期之外（`end <= periodStart || start >= periodEnd`）才跳过；部分重叠的记录由日窗口的 `min`／`max` 自然裁剪。

### 4.4 精度保留到汇总结束

`recordedMs` 全程是毫秒整数：按日累加交集毫秒，`recordedMinutes` 只在**最后**由该日（或该周期）的毫秒一次换算。旧实现是每条记录 `Math.round(durationMs / 60_000)` 后再相加，5 × 30 秒会得到 5 分钟；新实现得到 3 分钟（反向验证 #2）。

### 4.5 「执行记录累计」而不是唯一墙钟时间

`actual.recordedMs` 是各记录交集时长的**和**。当区间并集长度小于合计时，说明存在并行的执行记录（v3 之前的历史事实），此时 `actual.overlapping = true` 并追加一条口径说明「存在并行的执行记录，实际投入为「执行记录累计」，不等于唯一墙钟时间」。并集用 `unionMs` 做一次排序合并，不引入依赖。

### 4.6 待回顾复用共享选择器，并顺手做了一条源码护栏

`pendingReview` 只由 `isPendingReviewIn(index, session, now)`（`workspaceSelectors.ts`）产出，再按 `session.localDate` 落在周期内筛一次。行为上用一条用例证明「周期内待回顾 == `pendingReviewSessions(index, now)` 的周期子集」；结构上用源码护栏断言 `review.ts` 里存在 `isPendingReviewIn`、不存在自写的 `function isPendingReview`、也不出现 `status !== "scheduled"` 这类重写痕迹（反向验证 #8）。

### 4.7 明确未推进／跳过：读显式状态，且与「已产生记录」不重复计

| 状态 | 归入 | 说明 |
| --- | --- | --- |
| `session.status === "missed"` | `notAdvanced.missedSessions` | 明确未推进。**已经产生实际执行记录的 `missed` 时段不计入**，按实际投入计入即可 —— 与既有 7 天回顾的 `!recovered` 规则一致，避免同一件事被说成两件（反向验证 #9 证明去掉它会失败）。 |
| `session.status === "skipped"` | `notAdvanced.skippedSessions` | 跳过 |
| `session.status === "cancelled"` | `notAdvanced.cancelledSessions` | **取消安排**，与「跳过」分开列出，各自可读 |
| `occurrence.status === "skipped"` | `notAdvanced.skippedOccurrences` | 习惯发生项自己的跳过状态；若它的 `sessionId` 指向的时段已经被计入，则不重复计数（反向验证 #10） |

时间经过本身不会产生 `missed`：只有已结束计划、任务未完成、无执行记录时出现的是**待回顾**（派生状态），`notAdvanced.count` 仍为 0。

### 4.8 待续：当前 active 且周期内有未完成推进或未推进类事实

```
carryoverTaskIds = scopedTasks.filter(task =>
  task.status === "active" && (
    incompleteAdvanceTaskIds.has(task.id) ||   // 周期内存在 toProgress < 100 的事件
    pendingReviewTaskIds.has(task.id) ||
    notAdvancedTaskIds.has(task.id) ||         // missed / skipped / cancelled 时段
    skippedOccurrenceTaskIds.has(task.id)      // 习惯跳过
  )).map(task => task.id)
```

顺序沿用快照里 `tasks` 的顺序（与旧实现一致）。`已完成`／`已暂停` 的任务不进入待续。引擎只返回 ID 与明细，**不复制、不新建任务**（用例断言快照未被改写）。

### 4.9 明细：只列出周期内确有事实的任务

`tasks[]` 收录「有事件、有周期内时段、有交集记录、有进行中记录、有跳过发生项」之一的任务。没有任何事实的任务不会出现 —— 因此不存在「伪造的 0% 执行率」。有事实但没有进度事件的任务，`startProgress`／`endProgress` 都是 `null`，`formatTaskProgressRange` 给出「本周期无进度记录，当前 N%」，不从当前值反推历史（反向验证 #13）。

### 4.10 排序：发生时间 → 稳定 ID

周期内事件按 `(Date.parse(occurredAtUtc), id)` 排序。同一时刻存在多条事件时保留全部明细，并追加一条口径说明「同一时刻存在多条进度事件，先后无法证明；明细按发生时间与稳定 ID 排序」——稳定 ID 只保证确定性，不被当成时间先后（反向验证 #15）。

### 4.11 里程碑：冻结结果优先，未冻结才派生

`ReviewResult.milestones` 收录 `targetLocalDate` 落在周期内的里程碑（受 `projectId` 过滤）：有 `milestoneOutcomes` 冻结结果就直接用它的 `reached` 与 `resultText`；没有才调用 `milestoneReached(milestone, tasks, projectProgress(tasks))` 与 `milestoneSummary`（都来自 `workspaceSelectors`，M7 唯一规则）。后续完成不会改写这个周期看到的文本（反向验证 #12）。

### 4.12 兼容入口是薄适配

`buildSevenDayReview(workspace, endDate, now)` 内部只做三件事：`addLocalDays(endDate, -6)` 定窗口 → 调用同一份 `buildRange` → 把 `ReviewDaySummary` 映射回旧字段名。一条用例逐个日期比对「7 天回顾的每一天 == 单日 `buildReview`」，证明全仓只有一份统计算法。

## 5. 刻意行为变化

| 变化 | 原因 |
| --- | --- |
| 跨午夜的已结束记录**不再整段记在起始日** | 规格 §7.3 明确要求按本地日边界切分。23:50–次日 00:20 从「起始日 30 分钟」改为「前日 10 分钟 + 次日 20 分钟」。既有用例只覆盖日内记录，因此既有断言不变；新增用例专门盯这一条。 |
| 实际投入先按毫秒汇总、最后一次换算 | 规格 §7.2「保留毫秒或秒精度至汇总结束」。旧实现的逐条 `Math.round` 再相加会产生累积偏差。 |
| `buildSevenDayReview` 新增**必需的第三个参数 `now`** | 待回顾是相对「现在」的派生状态，兼容入口不能偷看系统时钟。返回形状（`startDate`／`endDate`／`days`／`progressedTaskIds`／`completedTaskIds`／`carryoverTaskIds`）完全不变，`App.tsx` 的 `ReviewPage` 改为把 `useCurrentTime()` 的值传进来。 |
| `buildSevenDayReview` 的 `carryoverTaskIds` 现在也包含「有待回顾时段」的 active 任务 | 新口径下待续是「周期内有未完成推进或待回顾／未推进／跳过事实」；7 天条显示的「N 项仍可继续安排」随之更准确。 |
| `days[].missedCount` 语义收紧为「明确未推进且没有实际执行记录」 | 与既有实现一致（旧代码是 `status === "missed" && !recovered`），只是现在由新引擎统一给出。 |
| `isLocalDate` 落到 `deadlines.ts` 并导出 | 原本 `settings.ts` 与 `native.ts` 各有一份私有实现；引擎需要同一判据，避免第三份正则。 |
| 新增 `ReviewResult.milestones` | 规格 §7.3 最后一条（冻结里程碑结果保留、后续完成不改写该周期快照）需要有可验证的落点；九行表格本身不含里程碑，所以由引擎给出只读快照，供 P4-08 的「成果」区使用。 |

P4-04～P4-06 的回归全部保持：滚动仲裁优先级、generation、拖拽延后、程序性滚动不写偏好、`seedCalendarPositions` 播种、日↔周十次不漂移、缩放锚点与预设恒等、截止页分组／筛选／焦点／滚动，以及既有编辑气泡语义，均未改动（`npm run check` 四步全绿）。

## 6. 验证

### 6.1 测试数量（本次实测）

| 层级 | 本次实测 | 本包增量 |
| --- | --- | --- |
| Vitest | **266 / 22 文件** | +34（`review.test.ts` 4 → 36；新增 `review.timezone.test.ts` 2） |
| Playwright | **33**（自带 Chromium，`--workers=1`） | 0（页面属 P4-08） |
| Rust | **38 passed / 0 failed** | 0（本包未改 Rust 代码） |
| `tsc --noEmit` + Vite 生产构建 | dist JS 439.91 kB（gzip 131.91 kB）／CSS 77.79 kB | — |

`npm run check` 四步串行执行，**exit 0，四步全绿**（2026-10-15 实测）：

```
npm run build   → tsc --noEmit + vite build 通过（dist JS 439.91 kB / CSS 77.79 kB）
npm test        → 266 passed / 22 files
test:e2e        → 33 passed (--workers=1)
test:native     → 38 passed; 0 failed
```

`test:native` 输出里出现 `warning: error copying object file … full.rmeta … 拒绝访问 (os error 5)` 是 `src-tauri/target/debug/incremental` 的增量缓存问题，只影响增量写入、不影响编译与结果（见 `docs/reports/phase-4-p4-04-implementation.md` §6.4 第 3 条）。

### 6.2 反向验证（去掉修复即失败）

把 `review.ts` 逐项改回缺陷形态后重跑对应用例，**19 项全部如期失败**（脚本：`.workbuddy-ai/tmp/p4-07-reverse-verify.sh` ＋ 变异定义 `.workbuddy-ai/tmp/p4-07-patch.mjs`，逐项改完立即还原，跑完全部 19 项后源文件与跑前逐字节一致）：

| # | 变异 | 被抓到的用例 |
| --- | --- | --- |
| 1 | 跨日记录整段记在起始日 | 23:50–00:20 拆分、跨月拆分、7 天适配一致（3 条失败） |
| 2 | 日界用「起始 + 固定 86_400_000 毫秒」 | `review.timezone.test.ts` 的 23 小时本地日 |
| 3 | 逐条四舍五入后再累加 | 毫秒精度保留到汇总 |
| 4 | 月＝最近 30 天而不是自然月 | 自然月与闰年、日月周汇总（3 条失败） |
| 5 | 周从周日开始 | 周一周界、跨月跨年、跨日拆分（5 条失败） |
| 6 | 月份长度硬编码成 30 | 自然月与闰年、日月周汇总 |
| 7 | 净进度变化只累加上调 | 40→100→60、A+40/B−10、净零变化、重复完成（4 条失败） |
| 8 | 重复完成重复计数 | 重复完成只计一次 |
| 9 | 待回顾自己写一份判断 | 共享选择器一致、`now` 显式注入 |
| 10 | 未推进不排除已产生记录的时段 | 未推进不重复计、兼容入口的已挽救时段 |
| 11 | 关联发生项与 session 不去重 | 习惯发生项去重 |
| 12 | 待续漏掉待回顾 | 待续集合 |
| 13 | 冻结结果被当前达成覆盖 | 冻结里程碑不被改写 |
| 14 | 无事件时用当前进度反推历史 | 不从当前值反推历史 |
| 15 | 引擎自己读系统时钟 | 源码护栏 + 锚点回退 |
| 16 | 进度事件不按时间与稳定 ID 排序 | 事件排序 |
| 17 | 项目过滤失效 | 项目过滤 |
| 18 | 有进行中记录时仍说「没有任何实际投入事实」 | 进行中执行单列 |
| 19 | 兼容入口的 7 天窗口差一天 | 空工作区 7 天长度 |

### 6.3 夏令时覆盖：本机 `TZ` 环境变量不可用，改用进程内设置

实测本机 node（v22.22.2，Windows）**忽略 `TZ` 环境变量**：`TZ=America/New_York node -e "..."` 的 `process.env.TZ` 是 `undefined`、`Intl` 仍是 `Asia/Shanghai`、`getTimezoneOffset()` 仍是 −480。在进程内赋值 `process.env.TZ = "America/New_York"` 则立即生效（offset 变 240）。

因此夏令时覆盖放在独立的 `src/lib/review.timezone.test.ts`：`beforeAll` 设置进程时区、`afterAll` 还原，并**先断言那一天是 23 小时**，防止时区没生效时用例静默空跑。Vitest 默认按文件隔离进程，改动不外溢 —— 设置后全量 266 个用例仍全绿。

这条同时说明：`AC11` 的夏令时部分在本机**是可证伪的**（反向验证 #2），不再是 P4-06 §6.2 记录的那种「只能靠构造性保证」。

### 6.4 AC11／AC12／AC13

- **AC11**：周一周界（周一／周日／周中三种锚点）、闰年（2028-02 → 02-01…02-29）、跨月跨年（2026-12-31 所在的周 → 12-28…2027-01-03）、跨午夜（23:50–00:20 → 10／20 分钟，跨月同理）、夏令时（23 小时本地日 + 春季跳时的真实经过时长）全部由 `review.test.ts`／`review.timezone.test.ts` 的固定时间样本覆盖。
- **AC12**：同日 40→100→60 → 净变化 **+20 百分点**、曾完成 1 项、当前 60%（`everCompleted` 与 `currentProgress` 分开表达，不会显示成当前已完成）；任务 A +40、任务 B −10 → 合计 **+30 百分点**，并且 `formatPercentPoints` 的输出不含 `%`（不能读成「项目完成度 30%」）；净零变化仍有完整明细；无执行记录时 `unrecorded` + 「未记录」而不是 0% 执行率。图表数值断言属 P4-08，本包把数值层做实。
- **AC13**：同一批事实的日／周／月汇总可互相核对（周净变化 == 周内各日之和 == 任务明细之和；周投入毫秒 == 各日之和），且「该周的历史区间」不等于任务当前完成度。E2E 部分属 P4-08。

## 7. 未做与边界

- **没有页面**：`src/components/review/`、周期选择器、图表、下钻、`reviewPeriod`／`reviewAnchorDate` 的读写全部留给 P4-08。引擎已能接受任意 `period` + `anchorDate`，但当前没有任何 UI 读设置里的这两项。
- **没有新事实**：不新增表／字段／迁移／Command／偏好；引擎只读，用例断言快照在调用后逐字节不变（`milestones`／`tasks`／`carryoverTaskIds` 都是引用或 ID）。
- **不做跨设备时区承诺**：进度事件按查看设备的本地时区分桶，`notes` 里显式写明当前时区；当前模型没有每次进度事件的本地时区快照，跨设备查看时「事件落在哪一天」可能不同。旧计划的未知 UTC 偏移保持未知（引擎不读 `utcOffsetMinutes` 做投入换算，只按已保存的 `localDate` 分桶计划）。
- **投入只统计已结束记录**：进行中的执行单列，不计入 `recordedMs`；`unrecorded` 只在「既无已结束交集、也无进行中记录」时为真。
- **不评估、不评分、不算连续天数**：沿用「回顾」的领域定义。
- **`days[]` 覆盖周期内每一天**（月最多 31 天），空白天同样出现，便于 P4-08 画零基线。
- **`notes` 文案是口径说明，不是 UI 文案**：P4-08 可以直接展示，也可以据此改写措辞。

## 8. 发现的不一致

### 8.1 `PROJECT-GUIDE.md` §5 的 `review.ts` 行已过期

原文写「最近 7 个本地日期的事实汇总，不生成评分或连续天数」。本包已按文档同步协议改写为周期引擎的新契约。

### 8.2 开工提示词里「App.tsx 的今日页「最近 7 天」条」与实际调用点不符

实际消费 `buildSevenDayReview` 的是**「7 天回顾」页**（`App.tsx` 的 `ReviewPage`），今日页只有自己的当日统计（`todayEvents`）。不影响交付，只是描述与代码不一致；本包按实际代码处理。

### 8.3 `calendarSummary.deadlineUrgency` 的固定 24 小时仍是未收口项（沿用 P4-06 §8.2）

M6 留下的 `src/lib/calendarSummary.ts` 仍用 `milliseconds <= 7 * 86_400_000` 判断「7 天内截止」。本包的引擎没有复用它（引擎按本地日历运算），但它仍在日历标记与月摘要的紧迫度文案里。属 P4-09 的收口项，本包未改。

### 8.4 本机 node 忽略 `TZ` 环境变量（环境事实，非代码缺陷）

见 §6.3。它影响的是「如何在 CI／本机验证夏令时」，已在报告里记明做法（进程内设置 + 23 小时自检断言）。P4-10 若要在真正的夏令时时区跑验收，需要知道这一点。

### 8.5 未发现规格与领域事实冲突之处

`CONTEXT.md` 的「回顾」「执行记录」「未执行时段」「投入时间」「完成度」「里程碑达成条件」在实现中一一对应：引擎只汇总既有事实，不新增状态、不替用户声称做过什么、不把未记录读成失败。未新建 ADR（本包只是把既有事实换一种口径投影，没有引入新的长期架构决策）。

## 9. 仍需用户决定

1. **待续是否要包含「只有待回顾、没有任何进度事件」的任务**：本包按规格字面包含（「周期内有未完成推进**或**待回顾／未推进／跳过事实」）。若希望待续只表示「真的推进过但没完成」，去掉 `pendingReviewTaskIds` 一个分支即可。
2. **已产生执行记录的 `missed` 时段不计入「未推进」**（§4.7）：这是沿用既有 7 天回顾的规则。若希望「用户显式说过未推进」优先于「后来补录了记录」，需要改这一处判断并同步兼容入口的 `missedCount`。
3. **`notes` 的中文措辞**：现在是引擎直接给出的口径说明（含设备时区名）。P4-08 若要换成更短的 UI 文案，建议保留「执行记录累计」与「未记录」这两个关键说法。
4. **`ReviewResult.milestones` 是否够用**：目前只给冻结结果／当前达成与文本。若 P4-08 的「成果」区还要显示里程碑目标条件摘要的更多细节，可以在不改事实模型的前提下补字段。
5. **`buildSevenDayReview` 的第三个参数**：本包把它改成必需参数并让 `App` 显式注入时钟。如果更希望兼容入口保持两参数签名（内部退化为不计算待回顾相关口径），可以在 P4-08 移除调用者前再调整。
