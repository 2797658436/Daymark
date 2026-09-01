# Daymark 阶段 2 验收报告

- 验收日期：2026-08-10
- 验收对象：`docs/specs/0002-phase-2-21-day-candidate.md` 全部验收标准
- 验收方式：生产构建 + 全套测试（Vitest / Rust / Playwright）+ 规格逐条核对

## 总结论

**阶段 2 验收通过。** 规格 0002 的 24 条验收标准全部满足（23 条完全满足，1 条经规格澄清后满足），无阻断性功能缺陷，无规格范围外实现。

| 能力域 | 验收标准数 | 结论 |
|---|---|---|
| 自动排程 Lite | 5 | 通过（AC4 经规格澄清） |
| 轻量时间块 | 3 | 通过 |
| 基础重复习惯 | 5 | 通过 |
| 错过后的挽救提示 | 3 | 通过 |
| 简单最近 7 天回顾 | 3 | 通过 |
| B 站链接导入 Beta | 5 | 通过 |

## 测试基线

| 套件 | 结果 | 时间 |
|---|---|---|
| Vitest（7 个测试文件） | **55 通过** | 12.84s |
| Rust（database.rs + main.rs） | **24 通过** | 0.47s |
| Playwright E2E | **9 通过** | 25.0s |
| 生产构建（tsc --noEmit + Vite） | 成功 | 1.35s |

## 逐项验收

### 自动排程 Lite（5/5 通过）

| AC | 验收标准摘要 | 实现证据 | 测试证据 |
|---|---|---|---|
| 1 | 任务池主动打开，看到 7 天可安排任务与容量 | `src/App.tsx` AutoScheduleDialog、`src/lib/scheduling.ts` `buildSchedulePlan` | `scheduling.test.ts`、`App.test.tsx` "schedules across 7 days" |
| 2 | 只追加空档，不移动既有安排/时间块，不超出默认时段 | `scheduling.ts` busy/eligible 过滤 | `scheduling.test.ts` "skips busy" |
| 3 | 按截止/优先级/池顺序确定性排序；使用单次投入时长 | `scheduling.ts` 排序与 item 构造 | `scheduling.test.ts` 排序用例 |
| 4 | 部分安排短于目标但不短于最低值，不自动补排 | `scheduling.ts` `full ?? partial` | `scheduling.test.ts` "never emits a second session for the remainder" |
| 5 | 先选任务看草案，确认后批量写入、原子完成、一次撤销 | `App.tsx` 预览→应用→撤销 toast | `App.test.tsx` "undoes an applied schedule draft"、Rust `apply_schedule_draft` 回滚测试 |

### 轻量时间块（3/3 通过）

| AC | 验收标准摘要 | 实现证据 | 测试证据 |
|---|---|---|---|
| 1 | 日历创建/删除只含标题日期起止的时间块 | `App.tsx` BlockForm、`deleteTimeBlock` | `App.test.tsx` "deletes a lightweight time block" |
| 2 | 与执行时段视觉/数据分离，不进任务池、不计回顾 | `styles.css` 时间块虚线样式、`review.ts` 只统计 executionRecords | `review.test.ts` "does not count media minutes or scheduled sessions without execution" |
| 3 | 自动排程视为不可用容量 | `scheduling.ts` timeBlocks→busy | `scheduling.test.ts` "skips busy" |

### 基础重复习惯（5/5 通过）

| AC | 验收标准摘要 | 实现证据 | 测试证据 |
|---|---|---|---|
| 1 | 每天/工作日/每周选日 + 单次投入 + 可选固定开始 | `recurrence.ts`、`App.tsx` 习惯表单 | `recurrence.test.ts` |
| 2 | 习惯是持续定义，发生日期独立状态，不为每天复制任务 | `recurring_habits` + `habit_occurrences` 表 | Rust 习惯事务测试 |
| 3 | 默认不累积：过去发生保留，不复制成今日欠账 | `App.tsx` 排程候选过滤已有发生项 | `App.test.tsx` "does not reschedule a habit date already settled as skipped" |
| 4 | 安排今天发生项或跳过；用既有执行闭环 | `App.tsx` 习惯发生项执行 | `App.test.tsx` 习惯打卡用例 |
| 5 | 自动排程把未安排发生项作为候选但不重复 | `App.tsx` 候选构造去重 | 同上排程习惯去重用例 |

### 错过后的挽救提示（3/3 通过）

| AC | 验收标准摘要 | 实现证据 | 测试证据 |
|---|---|---|---|
| 1 | 仅开启签到+挽救时，超宽限期未开始才显示一次非模态提示 | `App.tsx` rescueScenario、`checkInEnabled/rescuePromptsEnabled` | `App.test.tsx` "shows a neutral one-time rescue card after the grace period"、"does not infer a missed fact when start check-in is disabled" |
| 2 | 四动作：现在开始/延后10分钟/重新选择时间/本次跳过 | `App.tsx` 挽救卡片四按钮 | `App.test.tsx` 四个动作各有用例 |
| 3 | 提示事实持久化、不连续催促、中性文案 | `rescuePromptedSessionIds` 持久化 | Rust `mark_rescue_prompted` 幂等测试 |

### 简单最近 7 天回顾（3/3 通过）

| AC | 验收标准摘要 | 实现证据 | 测试证据 |
|---|---|---|---|
| 1 | 主导航"7 天回顾"，实时汇总今天及之前 7 个本地日期 | `App.tsx` ReviewPage、`review.ts` `buildSevenDayReview` | `review.test.ts` 日期窗口用例 |
| 2 | 先成果后数据：完成/推进/待续，再实际投入/进度/未执行跳过 | `review.ts` 返回结构 | `review.test.ts` |
| 3 | 无记录安静空状态；缺签到不换算失败/0分，无总分/连续/评价 | `review.ts` 无 facts 时空态 | `review.test.ts` "stays empty when there are no facts at all" |

### B 站链接导入 Beta（5/5 通过）

| AC | 验收标准摘要 | 实现证据 | 测试证据 |
|---|---|---|---|
| 1 | 粘贴含 BV 号链接，原生层读公开元数据，不用 AI/不下载 | `bilibili.ts`、Rust `fetch_bilibili_video` | `bilibili.test.ts`（固定响应） |
| 2 | 导入前可编辑/取消分 P 预览；确认后单事务创建项目+有序任务 | `App.tsx` B 站分 P 预览 | `App.test.tsx` "imports Bilibili public parts only after an editable Beta preview" |
| 3 | 每分 P 保存媒体时长和 ?p= 链接；媒体时长不声称投入 | task `mediaMinutes/sourceKey/sourceUrl` | `review.test.ts` "does not count media minutes ... as actual input" |
| 4 | 读取失败保留链接、可重试；文本导入独立可用 | `App.tsx` importError 保留 source | `App.test.tsx` "keeps the Bilibili link and lets the user retry after a fetch failure" |
| 5 | Beta 不含播放器/观看跟踪/大规模处理/复杂合并 | 规格范围外约束，无对应代码 | — |

## 数据与安全决策核对

- ✅ 新领域数据进 SQLite，顺序迁移 v4→v5；旧数据不改写（Rust 迁移测试验证 v1→v5 逐级）
- ✅ 习惯定义与显式发生状态入 SQLite，内部关联任务不进任务池
- ✅ B 站来源标识/分 P 链接/媒体时长存任务元数据，网络读取不写库
- ✅ 排程草案仅存前端内存，确认后才批量写入；`apply_schedule_draft` 失配整体回滚
- ✅ 新核心写操作走 Tauri 串行队列并在成功后刷新当日备份

## 规格澄清记录

- **AC4（自动排程）**：2026-08-10 澄清"单次投入时长不是不可拆分的硬约束，所有任务都可部分安排，部分安排只生成一个执行时段、不自动补排"（原措辞"可拆分任务"与 CONTEXT.md 领域语言冲突）。已同步至规格 0002、PROJECT-GUIDE，并补充对应测试。

## 遗留事项

以下内容不属于阶段 2 验收范围，已规划为后续阶段：

- 完整日历体验（连续时间轴、折叠、缩放、完整拖拽）：`docs/specs/0003-phase-3-calendar-experience.md`（已细分 6 个里程碑，未开工）
- 开机自启、通知任务级点击路由、独立截止任务页、完整日/周/月回顾、复杂重复规则、AI 规划：规格范围外，见规格 0002 Out of Scope

## 验收签核

阶段 2 六项纵向能力全部满足规格验收标准，测试基础设施齐备，可进入正式 21 天候选体验验证。真实使用验证按 [`phase-2-21-day-validation-plan.md`](phase-2-21-day-validation-plan.md) 执行。
