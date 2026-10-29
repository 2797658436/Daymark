# 可用时间窗口与每日上限：统一自动排程的可用性模型

版本：1.0；编制日期：2026-10-29；状态：**已定案，待实施**（AV1–AV9 全部按推荐项定案，见 §7）。

修订：v1.0 取代同日 0.1 草案（文件名 `0008-schedule-availability-modes.md`）的「三种可用性模式」设计。经 2026-10-29 与用户讨论，统一为**「可用时间窗口（白名单）+ 可选每日上限」**：取消 `mode` 枚举与独立的「课程表 / 空闲时间」实体——「默认时段」正名为「可用时间窗口」并改用拖拽周网格编辑，「每日 X 小时」降为窗口之上的一个可选上限开关，「课程表」等价于把空闲画在课间，不再需要黑名单式占用表。

基线：本地提交 `12a7ba4`（0.1.21）。本文只规划，不改产品代码。相关既有实现：
[`src/lib/scheduling.ts`](../../src/lib/scheduling.ts)（排程引擎）、[`src/lib/settings.ts`](../../src/lib/settings.ts)（`DefaultTimeSlot` 与偏好规范化）、[`src/lib/scheduleReasons.ts`](../../src/lib/scheduleReasons.ts)（原因文案）、[`src/App.tsx`](../../src/App.tsx) 的 `SchedulePanel`（约 3295–3740 行）、设置页「时间与排程」段与 `DefaultTimeSlotEditor`（约 3904–3928 行）、日历周网格 `DayCalendarGrid`（约 1804 行）。设计语言对齐 [`docs/design/UI-SPEC.md`](../design/UI-SPEC.md)；2026-10 自动排程整改的决策编号 D1–D5 已被 [`auto-schedule-evaluation-2026-10-24.md`](../reports/auto-schedule-evaluation-2026-10-24.md) 占用，本文另用 **AV** 前缀供代码注释回引。

---

## 1. 目标与阶段边界

自动排程的可用性现在只有一种来源：**默认时段列表**。[`buildSchedulePlan`](../../src/lib/scheduling.ts) 的空档恒等于「默认时段 − 已占用」，没配任何时段时面板直接落到「还没有默认时段」空状态（[`App.tsx`](../../src/App.tsx) `zeroSlots` 分支），且**没有任何「每天最多排几小时」的概念**。

而「默认时段」的数据结构 `DefaultTimeSlot = { id, label, start, end, weekdays[] }`（[`settings.ts:22`](../../src/lib/settings.ts)）**本身就是「每周重复、可多个的可用时间窗」**。所以本方案不新造数据，而是：

1. 把「默认时段」**正名为「可用时间窗口」**，并给它一个更直观的**拖拽周网格编辑器**（7 天 × 时段，拖选标记空闲，可多段）。
2. 在窗口之上叠加一个**可选的「每日上限」**（不填 = 不限，保持现状；填 X = 每天最多排 X 小时，硬封顶）。

### 1.1 统一模型：两个正交的轴

| 轴 | 含义 | 数据 | 旧概念如何落入 |
| --- | --- | --- | --- |
| **可用窗口**（哪里能排） | 每周重复、可多段的空闲时间 | 复用 `defaultTimeSlots` 数组 | 「默认时段」＝它的旧名；「课程表」＝把空闲画在课间 |
| **每日上限**（每天排多少，可选） | 当天累计排入的硬上限 | `dailyScheduleBudgetMinutes: number \| null` | 不填＝纯默认时段行为；填 X＝「每日 X 小时」 |

一次性不可用（某天临时有安排）不进这两个轴，继续用既有的**时间块 `TimeBlock`**——引擎已把它当 busy 扣减。

### 1.2 必须交付

| 模块 | 结果 | 优先级 |
| --- | --- | --- |
| M1 每日上限（引擎） | `buildSchedulePlan` 接受可选 `dailyBudgetMinutes`，按天硬封顶记账；超出产出新原因 `daily-budget-full` | P1 |
| M2 每日上限（设置） | 新增偏好 `dailyScheduleBudgetMinutes`（默认 `null` = 不限），含区间／预设常量与规范化 | P1 |
| M3 面板上限输入 | `SchedulePanel` 加「每天最多 X」可选输入（本次可改／可关，seeded from 设置），容量条按上限口径 | P1 |
| M4 可用时间周网格 | 设置页「时间与排程」把默认时段编辑升级为**拖拽周网格**（7 天 × 时段，拖选标记、可多段、预设按钮），正名「可用时间」 | P1 |
| M5 原因文案 | `scheduleUnscheduledText` 增加 `daily-budget-full` 文案 | P2 |
| M6 命名同步 | 界面／文档里「默认时段」相关措辞正名为「可用时间窗口」（含 `calendarDayMode` 的「默认时段」档标签） | P2 |

### 1.3 本阶段不交付

- **课程表 / 黑名单占用**：不建独立实体、不动 SQLite。白名单式「直接标空闲」已覆盖同一用例（AV1）。
- **可排边界／每日上限按星期细分**：本轮上限是**单一全局值、每天相同**；周网格本就按星期标记窗口，上限细分留后续（AV8）。
- **跨午夜窗口**：单段窗口要求 `start < end` 且落在同一自然日（如 19:00–22:00）；跨天用两段表示。
- 不改默认排序口径（截止 → 优先级 → 池序）、不改「仅追加、不重排既有安排」、不改 `applyScheduleDraft` 单事务与整组撤销。

### 1.4 不可破坏的约束

- **未设上限时行为逐字不变**：不传 `dailyBudgetMinutes` 时 `buildSchedulePlan` 输出与现有 17 条用例断言完全一致；`dailyScheduleBudgetMinutes` 默认 `null`，**绝不给现有用户凭空加上限**。
- **存储键不变**：继续用 `defaultTimeSlots`，已存数据、备份、日历折叠（`calendarDayMode: defaultSlots`）零改动自动兼容（AV2）。
- **Phase 1 零 SQLite 迁移**：只加一个偏好字段，随现有备份整份 JSON 自动迁移（[PROJECT-GUIDE §9](../PROJECT-GUIDE.md)）；旧备份缺字段时 `normalizeSettings` 补默认值。
- **引擎不持有领域关系**：项目顺序、里程碑、依据 chip 仍只在 `App.tsx` 界面层算。

---

## 2. 基线证据

| 事实 | 当前证据 | 对设计的影响 |
| --- | --- | --- |
| `DefaultTimeSlot` 已是「每周可多段窗口」 | [`settings.ts:22`](../../src/lib/settings.ts)：`{ id, label, start, end, weekdays[] }`，`defaultTimeSlots` 为数组 | 周网格只是它的**新编辑器**，不是新数据；存储键复用 |
| 空档＝时段 − busy | [`scheduling.ts`](../../src/lib/scheduling.ts) `buildGaps`（约 171–189 行）：按星期取时段 → 合并 → 减 busy | 引擎只需在分配阶段加「每日上限」记账，空档源不动 |
| busy 已含时间块 | `SchedulePanel` 的 `busy` useMemo（[`App.tsx`](../../src/App.tsx) 约 3324–3328 行）：`scheduled 会话 + timeBlocks + 今天已过去` | 一次性不可用走时间块，无需课程表 |
| 无每日上限概念 | 全仓无「daily budget / 每日时长」实现 | 新增 `dailyBudgetMinutes` 入参 + 记账 + 一条原因 |
| 无时段即全 blocked | [`App.tsx`](../../src/App.tsx) `zeroSlots` 门控窗口选择器／工具行／容量条／底栏／空状态 | 空窗口仍走空状态，但引导语改为「去标记可用时间」（周网格），并提供一键预设 |
| 原因枚举是封闭集合 | `ScheduleUnscheduledReason`（[`scheduling.ts`](../../src/lib/scheduling.ts) 约 41–48 行）6 种 + 预留 `continuous-unavailable`；文案唯一出处 [`scheduleReasons.ts`](../../src/lib/scheduleReasons.ts) | 新增 `daily-budget-full`，`explainUnscheduled` 补一条分支，文案表补一行 |
| 偏好随备份自动迁移 | [PROJECT-GUIDE §8／§9](../PROJECT-GUIDE.md)：新增偏好不需迁移或表 | Phase 1 只加偏好字段 + 规范化 |
| 已有周网格渲染可复用 | `DayCalendarGrid`／[`calendarTimeline.ts`](../../src/lib/calendarTimeline.ts)／`snapMinutes` 吸附 | 周网格编辑器复用同一套时间轴／吸附约定，不新造像素映射 |
| 领域语言绑定「默认时段」 | [`CONTEXT.md`](../../CONTEXT.md)：「默认时段＝偏好时间窗口」「自动排程＝发现近期默认时段中的可用空档」 | 落地时回写 CONTEXT：正名「可用时间窗口」，新增「每日上限」，自动排程定义涵盖可选上限 |

---

## 3. 引擎改动（[`scheduling.ts`](../../src/lib/scheduling.ts)）

`buildSchedulePlan` 入参**只加一个可选字段**（不传即现状）：

```ts
buildSchedulePlan(input: {
  startDate: string; days: number; items: ScheduleItem[];
  defaultTimeSlots: DefaultTimeSlot[]; busy: BusyInterval[]; minimumMinutes: number;
  dailyBudgetMinutes?: number | null;   // 新增；null/undefined = 不限（默认）
}): SchedulePlan
```

改动点：

1. **按天记账（硬封顶，AV3/AV7）**：维护 `usedByDate: Map<date, minutes>`。为任务挑空档时，该空档的可用分钟截断为
   `usable = min(gap.end - start, dailyBudgetMinutes - (usedByDate.get(gap.date) ?? 0))`（`dailyBudgetMinutes` 为空时不截断）。`usable < minimumMinutes` 的空档对该任务不可用；选中后按 `min(targetMinutes, usable)` 分配（沿用「放不下就部分安排、不补第二段」），并累加 `usedByDate`。当天排满后剩余任务自然流向窗口内后续日期（现有按日期升序取空档，天然摊开）。
2. **容量口径（AV9）**：不限时 `availableMinutes = Σ(gap ≥ minimumMinutes)`（现状）；设上限时 `availableMinutes = Σ_day min(当天合格空闲合计, dailyBudgetMinutes)`。容量条因此显示「这次实际能排多少」，被上限挡住的时钟空闲不计入分母。
3. **新原因 `daily-budget-full`**：`ScheduleUnscheduledReason` 增此值；`explainUnscheduled` 在「存在 ≥ `minimumMinutes` 的合格空档，但每个合格日的剩余预算都 < `minimumMinutes`」时返回它（区别于 `gaps-too-short`＝压根没有够长空档），`longestGapMinutes` 记当天剩余预算的最大值。
4. **不动**：排序口径、部分安排语义、`unscheduledKeys` 兼容字段、空档源（仍来自 `defaultTimeSlots`）。现有 17 条用例不改即通过。

---

## 4. 数据与设置影响

### 4.1 复用 `defaultTimeSlots`（AV2，零迁移）

底层存储键、类型、规范化、备份迁移**全部不变**；只在界面与文档把「默认时段」正名为「可用时间窗口」。`DEFAULT_SETTINGS.defaultTimeSlots` 的初始种子（「晚间专注 19:00–22:00 每天」）保留——它是新用户的初始值，不是空窗口的静默兜底（AV7）。`normalizeTimeSlots` 现有语义（空数组＝有效的用户选择、非法值回退种子）不动。

### 4.2 新增偏好 `dailyScheduleBudgetMinutes`

```ts
interface AppSettings {
  // …既有字段…
  dailyScheduleBudgetMinutes: number | null;  // 默认 null = 不限；启用时默认填充 240
}
```

- 区间与预设照 `MINIMUM_SESSION_MINUTES_RANGE` 的写法，供设置页输入框与 `normalizeSettings` **同源**：
  - `DAILY_BUDGET_MINUTES_RANGE = [30, 960]`
  - `DAILY_BUDGET_MINUTES_PRESETS = [60, 120, 180, 240, 360]`
- 规范化：`null` 保留为「不限」；数值用 `normalizeIntegerInRange` 落在区间内否则回退 `null`（**不回退 240**，以免老设置升级后被静默加上限）。
- 面板本次的 X 覆盖与开／关状态是临时 React 状态，不持久化（与 `windowMode` 一致，AV4）。

### 4.3 课程表核心数据（明确不做）

0.1 草案里的 Phase 2（课程表 SQLite v9 迁移 + Rust model + 每周网格录入 + `freeTime` 模式）**整体取消**：白名单式可用窗口是偏好、不是核心数据，一次性占用走既有时间块。因此本方案**不触碰 SQLite schema**（当前 v8）。

---

## 5. 界面改动（[`App.tsx`](../../src/App.tsx) + [`styles.css`](../../src/styles.css)）

### 5.1 可用时间周网格编辑器（M4，最大一块）

位置：设置页「时间与排程」段，替换／升级现有「默认时段」列表编辑，标题正名「可用时间」。

- **拖拽周网格**：7 列（周一…周日或周日…周六，与 `weekdays` 序号一致）× 纵向时间轴（00:00–24:00，复用 `calendarTimeline` 的分钟／像素映射与 `snapMinutes` 吸附，纵向可滚动／缩放）。拖选一段即标记为可用；可多段；点击／拖删已有段。
- **与既有列表并存（推荐）**：网格是可视化主编辑器，保留现有列表（`settings-slot-list` + `DefaultTimeSlotEditor`）做**精确时间与键盘／无障碍编辑**，两者编辑同一份 `defaultTimeSlots`。理由：纯拖拽网格对键盘用户与「精确到 19:30」不友好；并存也避免删掉可用的既有编辑器。（若用户只要网格，可在实施时去掉列表。）
- **预设按钮（AV7）**：网格上方给「全天 00:00–24:00」「常用 08:00–23:00」「晚间 19:00–22:00」「清空」等一键预设，标记近零成本；**不静默兜底**——空窗口就是空。
- **无障碍与缩放**：44px 命中、≥12px 字号、对比度、960×640 与 200% 不裁切，按 [UI-SPEC](../design/UI-SPEC.md) 与 [AGENTS.md](../../AGENTS.md)「浏览器与可视化验证」执行；网格需键盘可达（方向键移动 + 空格标记，或至少列表可完整替代）。

### 5.2 `SchedulePanel`（M3）

- 头部加「每天最多 [X]」可选输入（`NumberField` + 一个「不限」开关）：默认取 `dailyScheduleBudgetMinutes`（`null` 显示为「不限」），本次可改／可关；改后所有 `buildSchedulePlan` 调用（`recommended`／`defaultSelection`／`plan`／`soloById`）统一带同一份 `dailyBudgetMinutes`，避免口径分叉。
- 容量条按 §3.2 口径显示剩余／总量。
- 空窗口仍走空状态，但文案与入口改为「去标记可用时间」，跳设置页周网格（替代原「去设置默认时段」）。

### 5.3 命名一致性（M6）

「默认时段」在界面出现处一并正名：设置页 `calendarDayMode` 的「默认时段」档标签、日历工具栏、空状态文案等。存储值 `defaultSlots` 不改（只改可见文案），以免动既有偏好与迁移。

---

## 6. 工作包与顺序

每步绿了再走下一步，回退面只到上一步：

1. **W1 引擎 + 设置**（小、低风险，先落）：`dailyScheduleBudgetMinutes` 偏好 + 规范化 + 区间常量；`buildSchedulePlan` 加 `dailyBudgetMinutes` 记账 + `daily-budget-full` 原因 + `scheduleReasons` 文案。完成定义：`npx vitest run src/lib/scheduling.test.ts src/lib/settings.test.ts src/lib/scheduleReasons.test.ts` 全绿，旧用例断言不改即通过。
2. **W2 面板上限输入**：`SchedulePanel` 的「每天最多 X」+ 容量口径 + 空状态引导语。完成定义：`App.test.tsx` 新增用例（改 X 后草案随之变、不限时行为不变）全绿。
3. **W3 可用时间周网格**（最大块）：拖拽网格 + 预设 + 正名，与列表并存。完成定义：组件用例（拖选生成窗口、预设填充、多段、与列表同源）+ headless 可视化证据（浅／深 × 100／200%，网格与面板对照）逐张对照 UI-SPEC。
4. **W4 文档同步**：CONTEXT / PROJECT-GUIDE / UI-SPEC（见 §9）。

---

## 7. 决策点（AV，全部已定案 2026-10-29）

| 编号 | 问题 | 定案 | 对形状的约束 |
| --- | --- | --- | --- |
| AV1 | 概念模型 | a：**白名单「可用时间窗口」统一**，取消独立课程表／黑名单占用 | 无 `mode` 枚举；课程表＝把空闲画在课间 |
| AV2 | 底层存储 | a：**复用 `defaultTimeSlots` 键**，只改界面名 | 零迁移；备份／日历折叠自动兼容 |
| AV3 | 每日上限默认 | a：默认 `null`（不限）以保后向兼容；**启用时默认填充 240、硬封顶** | 绝不让老用户升级后被静默加上限 |
| AV4 | 上限是否面板可改 | a：设置存默认值，面板每次可改／可关，本次不持久化 | 与 `windowMode` 同为临时状态 |
| AV5 | 课程表核心数据 | a：**本轮不做**（白名单已覆盖），不动 SQLite | 取消 0.1 草案的 Phase 2 |
| AV6 | 周网格编辑器 | a：**本轮一步到位做拖拽周网格**（与列表并存） | W3 是最大工作包 |
| AV7 | 空窗口兜底 | a：**不静默兜底**，周网格给一键预设 | 空＝空；种子仅用于新用户初始值 |
| AV8 | 上限／边界按星期细分 | a：本轮单一全局上限、每天相同 | 上限为标量；窗口本就按星期 |
| AV9 | 容量口径 | a：设上限时 `Σ_day min(当天空闲, 上限)` | §3.2，容量条分母 |

---

## 8. 测试计划

- **[`scheduling.test.ts`](../../src/lib/scheduling.test.ts)**（现 17 条，旧断言不改即通过）新增：不传 `dailyBudgetMinutes` 输出与现状一致（回归护栏）；设上限后当天排满即溢出到次日；上限使某任务放不下 → `daily-budget-full` + `longestGapMinutes` 为剩余预算最大值；`availableMinutes` 在上限下 = `Σ_day min(空闲, 上限)`；不限时容量与现状一致。
- **[`settings.test.ts`](../../src/lib/settings.test.ts)**：`dailyScheduleBudgetMinutes` 默认 `null`、越界／非法回退 `null`（不回退 240）、区间内整数保留。
- **[`scheduleReasons.test.ts`](../../src/lib/scheduleReasons.test.ts)**：`daily-budget-full` 文案一条；无惩罚措辞护栏沿用。
- **`App.test.tsx`**：面板「每天最多 X」本次生效不写设置；「不限」时行为与旧默认时段一致；空窗口引导到周网格。
- **周网格组件用例**：拖选生成一段窗口、可多段、预设一键填充／清空、与列表编辑同一份 `defaultTimeSlots`（一侧改另一侧同步）。
- **命令**：`npx vitest run`、`node scripts/run-e2e.mjs --workers=1`；GUI 改动后按 [AGENTS.md](../../AGENTS.md) 用 `scripts/visual-evidence.mjs`（headless）拍周网格与面板（浅／深 × 100／200% + 960×640），落 `output/<日期>_availability-grid/` 并逐张对照 UI-SPEC（4px 网格、≥12px、对比度、44px 命中、不裁切）。

---

## 9. 文档同步（落地后按 [PROJECT-GUIDE 文档同步协议](../PROJECT-GUIDE.md)）

- **[`CONTEXT.md`](../../CONTEXT.md)**：把「默认时段」正名／扩写为「可用时间窗口」（每周、可多段、标记可排区域）；新增「每日上限」词条；改写「自动排程」定义使其涵盖「可用窗口内、可选每日上限下」生成草案。
- **[PROJECT-GUIDE §8](../PROJECT-GUIDE.md)**：设置持久化清单补 `dailyScheduleBudgetMinutes`；§5 代码地图补引擎的上限记账与周网格编辑器。
- **[UI-SPEC](../design/UI-SPEC.md)** 自动排程／设置段：补周网格拖选、预设、每日上限输入的交互与可达性口径；正名相关措辞。

---

## 10. 明确不做的事（本轮）

- 不动 SQLite schema、不动任何领域事实与事务边界；不建课程表实体。
- 不改默认排序口径与「仅追加、不重排既有安排」。
- 不做上限／边界的按星期细分，不做跨午夜窗口。
- 不改 `defaultTimeSlots` 存储键与迁移语义（只改可见文案）。
- 不引入新依赖、不做候选清单虚拟化。
- 不提交 Git、不动用户未提交修改；证据只落 `output/`（gitignored）。
