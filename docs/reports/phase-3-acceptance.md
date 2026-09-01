# Daymark 阶段 3 验收报告

- 验收日期：2026-09-01
- 验收对象：`docs/specs/0003-phase-3-calendar-experience.md`（M1–M6）+ `docs/specs/0004-m7-project-deadlines-and-milestones.md`（M7.1–M7.4）
- 验收方式：生产构建 + 全套测试（Vitest / Rust / Playwright）+ 规格逐条核对
- 验收基线：阶段 2 验收报告（2026-08-10）之后的全部阶段 3 提交

## 总结论

**阶段 3 验收通过。** 阶段 3 六个里程碑（M1 时间轴与三视图、M2 状态感知与计划/实际叠加、M3 缩放与卡片自适应、M4 默认时段折叠、M5 完整拖拽排程、M6 全天区/月摘要/键盘导航）与 M7 四个子段（M7.1 核心数据、M7.2 项目编辑、M7.3 日历标记、M7.4 历史与风险）的全部验收标准均已满足，无阻断性功能缺陷。发现 1 项文档同步缺口（PROJECT-GUIDE 未反映 M7 的 schema v7 与最新测试库存），不构成功能问题，已记录为遗留事项。

| 里程碑 | 验收标准 | 结论 |
|---|---|---|
| M1 时间轴骨架与三视图 | 3.1 | 通过 |
| M2 状态感知与计划/实际叠加 | 3.6、3.7 | 通过 |
| M3 缩放与卡片自适应 | 3.5 | 通过 |
| M4 默认时段折叠与临时展开 | 3.2 | 通过 |
| M5 完整拖拽排程 | 3.8 | 通过 |
| M6 全天区域、月摘要与键盘导航 | 3.3、3.4、3.9 | 通过 |
| M7.1 核心数据（schema v6、CRUD、备份兼容） | 0004 §M7.1 | 通过 |
| M7.2 项目编辑（截止日期 + 里程碑 CRUD） | 0004 §M7.2–3 | 通过 |
| M7.3 日历标记（旗帜/菱形、详情投影） | 0004 §M7.2–3 | 通过 |
| M7.4 历史与风险（结果快照、续排、排程读约束） | 0004 §M7.4 | 通过 |

## 测试基线（本次验收实测）

| 套件 | 结果 | 时间 |
|---|---|---|
| Vitest（11 个测试文件） | **106 通过** | ~22s |
| Rust（database.rs 23 + backup.rs 9 + lib.rs 1） | **33 通过** | 0.62s |
| Playwright E2E（e2e/phase1.spec.ts） | **15 通过** | 45.7s |
| 生产构建（tsc --noEmit + Vite） | 成功 | 2.0s |

> 注：本次验收 e2e 15/15 全绿。阶段 3 开发期间沙箱内 e2e 偶发失败（title-only/M3/M4 轮换）已确认是 WorkBuddy 沙箱环境问题（safe-delete 拦截产物清理 + 透明代理），非代码回归；同一套件在本机终端稳定通过。

## 逐项验收

### M1 时间轴骨架与三视图（3.1 全部通过）

| 验收标准摘要 | 实现证据 | 测试证据 |
|---|---|---|
| 日历默认周视图，首次进入落在当前周 | `App.tsx` DEFAULT_SETTINGS.calendarView="week" | `settings.test.ts` 默认值规范化 |
| 日视图连续滚动跨 00:00/24:00 边界无缝进入相邻日期，固定日期标题 + 常驻"回到今天" | `App.tsx` ContinuousDayView、weekDates 边界逻辑 | `calendarTimeline.test.ts`（5 例）、e2e "day axis changes date only at midnight" |
| 周视图周一为起点、日期头吸顶、今天文字+描边、单击日期头进入日视图 | `App.tsx` WeekDateHeaders、week-sticky-header | `App.test.tsx` 周头键盘/打开日视图 |
| 月视图固定六行网格、周一为行首、相邻月弱化、切月高度不跳动 | `App.tsx` MonthCalendar、monthDates | `App.test.tsx` 月导航用例 |
| 视图切换保留各自最近锚点与缩放 | `settings.ts` calendarAnchors/calendarZoom 按视图分键 | `App.test.tsx` "keeps a separate anchor for each calendar view" |

### M2 状态感知与计划/实际叠加（3.6、3.7 全部通过）

| 验收标准摘要 | 实现证据 | 测试证据 |
|---|---|---|
| 今天时间轴显示当前时间线与时间标签；已过去区域极淡背景；滚离后"回到现在"按钮 | `App.tsx` data-now-marker、nowDirection、back-to-now | `App.test.tsx` 当前时间线用例 |
| 当前安排卡片高亮边框+光晕；细时间条与粗进度条分开 | `App.tsx` current-schedule、双进度条 | `App.test.tsx` "keeps planned and actual time separate" |
| 已结束未完成任务进"待回顾"，三操作（更新进度/继续安排/本次未推进），不自动判未执行 | `App.tsx` pending-review 卡片三按钮 | `App.test.tsx` "keeps an ended unfinished session pending until the user confirms no progress" |
| 工具栏"显示实际记录"开关；原计划淡虚线、实际记录实色层 | `App.tsx` showActualRecords、actual layer | `App.test.tsx` 叠加只读用例 |
| 状态区分同时用边框/文字/图标，不只依赖颜色 | `styles.css` session-status-icon 等 | axe 无障碍 e2e |

### M3 缩放与卡片自适应（3.5 全部通过）

| 验收标准摘要 | 实现证据 | 测试证据 |
|---|---|---|
| Ctrl+滚轮/触控板捏合以指针时间为锚点缩放 | `App.tsx` zoomWithWheel、zoomAnchorRef | e2e "M3 zooms around the pointed time" |
| 工具栏紧凑/标准/详细三档入口；各视图分别持久化 | `settings.ts` calendarScaleForZoom、calendarZoom 按视图 | `App.test.tsx` "keeps and restores an actual zoom level for each calendar view" |
| 卡片按高度分级：<30 分钟仅标题色条、30–59 加时间与细进度、60+ 显示完整信息 | `App.tsx` density 分级渲染 | `calendarTimeline.test.ts` 信息量用例 |
| 缩放只改视觉密度，不改变真实时段数据 | 纯渲染层，写命令不经过缩放 | 上述测试 + Rust 数据层无缩放相关改动 |

### M4 默认时段折叠与临时展开（3.2 全部通过）

| 验收标准摘要 | 实现证据 | 测试证据 |
|---|---|---|
| 日视图"默认时段/全天"两种模式，可设默认并记住最近选择 | `App.tsx` dayMode 状态、settings.ts 持久化 | `settings.test.ts` 日视图模式规范化 |
| 折叠条始终显示起止与数量（如"10:00–18:00 · 2 项安排"），点击切换展开/收起 | `App.tsx` folded interval 渲染 | `App.test.tsx` "folds non-default day ranges, shows their arrangement count, and keeps expansion temporary" |
| 拖拽悬停约半秒自动展开；拖离未提交恢复；放置成功保留 | `App.tsx` dragEnter 计时 + expandedGapKeys | 同上用例 |
| 当前时间在折叠区自动展开约两小时窗口 | `App.tsx` nowInFolded 检测 | 同上 |
| 外部跳转命中折叠区内安排自动展开并高亮 | `App.tsx` focusSessionId → expandedGapKeys | `App.test.tsx` 跨页目标显露 |

### M5 完整拖拽排程（3.8 全部通过）

| 验收标准摘要 | 实现证据 | 测试证据 |
|---|---|---|
| 拖拽持续显示精确时间预览与可放置区域 | `App.tsx` dragPreview | `App.test.tsx` 拖拽预览用例 |
| 磁铁按钮显示吸附状态（如"吸附 15 分钟"），Alt 临时反转 | `App.tsx` snapMinutes、magnet 按钮 | `App.test.tsx` "吸附 15 分钟" aria-pressed |
| 边缘插入显示插入线并"插入并后移"，松手提交、拖出复原 | `calendarPlacement.ts` insertionChanges、`App.tsx` | `calendarPlacement.test.ts`（2 例）、e2e "M5 previews and atomically commits insertion" |
| 中央悬停约半秒聚拢"同时安排"，松手才创建重叠 | `App.tsx` overlapTimer、concurrentLayouts | `App.test.tsx` 重叠用例 |
| 并行 2–3 项并排等宽；4 项以上前两项+"另外 N 项"汇总卡原位展开 | `calendarPlacement.ts` concurrentLayouts | `calendarPlacement.test.ts`、`App.test.tsx` 并行/折叠 |
| 空白悬停显示 ＋ 与时间；单击或纵向框选打开小气泡（新建/从任务池/时间块），Esc 取消 | `App.tsx` blankBubble、blankRange 框选 | `App.test.tsx` 空白气泡与框选预填 |

### M6 全天区域、月摘要与键盘导航（3.3、3.4、3.9 全部通过）

| 验收标准摘要 | 实现证据 | 测试证据 |
|---|---|---|
| 周视图顶部可折叠全天区默认两行、超出"另外 N 项"原位展开、点击标记右侧开详情 | `App.tsx` WeekAllDayArea | `App.test.tsx` "shows two all-day deadline rows ... expands the overflow in place" |
| 日列变窄按标题/时间/状态/进度/项目逐级隐藏；中央不足先收侧栏 | `App.tsx` density 降级、CSS container query | e2e "narrow windows keep the task pool over the workspace" |
| 月日期格按截止/完成/推进/未推进展示最多三条，其余"另外 N 项"；点击日期右侧完整列表不弹窗 | `App.tsx` MonthCalendar + CalendarDateDetails | `App.test.tsx` 月摘要用例 |
| 周视图键盘：方向键/PageUp/PageDown/Enter 语义 | `App.tsx` moveWeekFocus、keyDown | `App.test.tsx` "moves week header and time-grid focus with keyboard" |
| 月视图键盘：方向键跨行跨月、PageUp/PageDown、Home/End、Enter | `App.tsx` MonthCalendar keyDown | `App.test.tsx` "navigates the month grid without selecting until Enter" |
| 焦点移动不创建数据；视图切换保留所选日期；焦点与选中样式区分 | `App.tsx` focus/selected 独立 class | 上述键盘用例 + aria-selected 断言 |

### M7.1 核心数据（schema v6、CRUD、备份兼容）

| 验收标准摘要 | 实现证据 | 测试证据 |
|---|---|---|
| schema v5→v6 单事务迁移，旧数据不丢 | `migrations/006_project_constraints.sql`、migrate() | `database.rs` v5 升级测试 |
| `deadline_local` 可空 + `project_milestones` 项目外键 + CHECK 恰好一种条件 | 006 迁移 SQL | `database.rs` "project_deadline_and_typed_milestones_round_trip_with_relation_validation" |
| 原生与 TS 同一 camelCase 边界；快照同时返回项目与里程碑 | `models.rs`、`native.ts` | 往返测试 |
| 更新项目/创建/更新/删除里程碑走串行写队列并刷新备份 | `lib.rs` mutate_workspace | Rust 写路径测试 |
| 数据库拒绝无效日期/空标题/跨项目任务/零负数量/范围外进度/条件字段不匹配 | `validate_project_milestone`、`validate_milestone_relations` | `database.rs` 负例测试 |
| 浏览器预览补齐 `deadlineLocal: null` 与空里程碑集合 | `native.ts` BrowserPreviewApi.read | `native.test.ts` |
| v1–v5 备份可检查并恢复后迁移；v6 备份缺 `project_milestones` 必须拒绝 | `backup.rs` validate_database 版本感知 | `backup.rs` "restore_rejects_a_v6_backup_that_is_missing_project_milestones" |

### M7.2 项目编辑

| 验收标准摘要 | 实现证据 | 测试证据 |
|---|---|---|
| 新建/编辑项目可填/清项目截止日期；卡片明确显示截止状态不混同子任务 | `App.tsx` ProjectEditor、ProjectDeadlineChip | `App.test.tsx` "shows the project deadline chip with urgency and persists project edits" |
| 项目内可增删改多个里程碑；表单随条件类型只显示对应输入；保存前可读摘要 | `App.tsx` MilestoneForm、MilestoneForm 条件分支 | `App.test.tsx` "creates a milestone with an ordered task" |
| 里程碑达成状态用文字/图标区分（已达成/进行中），不只依赖颜色 | `App.tsx` milestone-status.reached | 同上 |

### M7.3 日历标记

| 验收标准摘要 | 实现证据 | 测试证据 |
|---|---|---|
| 周视图项目截止用旗帜、里程碑用菱形，不混用标记 | `App.tsx` WeekAllDayArea（Flag/Diamond）、calendarSummary.ts calendarDayMarkers | `calendarSummary.test.ts` markers 用例、`App.test.tsx` 周全天区标记用例 |
| 月视图与日期详情保留不同文字/图标语义，不只依赖颜色 | `App.tsx` MonthCalendar、CalendarDateDetails | `App.test.tsx` 月格标记用例 |
| 点击项目截止/里程碑标记打开项目详情并保留日期选中态 | `App.tsx` onOpenProject → CalendarDateDetails projectId | `App.test.tsx` "opens the project detail from a milestone" |
| 标记不占用时间、不创建执行时段 | 标记为只读投影，无写命令 | 结构证据（calendarSummary 只读聚合） |

### M7.4 历史与风险

| 验收标准摘要 | 实现证据 | 测试证据 |
|---|---|---|
| 到期未达成里程碑保留原日期/原目标/实际结果快照，不自动改写历史 | `database.rs` freeze_expired_outcomes + `migrations/007_milestone_outcomes.sql` | `database.rs` "an_expired_unreached_milestone_is_frozen_into_an_outcome_snapshot_once" |
| 未达成后提供显式续排入口，差额参与后续计划 | `App.tsx` continueMilestoneDraft + 续排按钮 | `App.test.tsx` "offers a continue draft with the remaining target" |
| 确定性排程读取项目约束（项目截止兜底） | `App.tsx` AutoScheduleDialog projectDeadlineById | `App.test.tsx` "uses the project deadline as a fallback deadline in auto scheduling" |
| 备份校验覆盖 v7（缺 milestone_outcomes 必须拒绝） | `backup.rs` validate_database version>=7 | `backup.rs` "restore_rejects_a_v7_backup_that_is_missing_milestone_outcomes" |

## 数据与安全决策核对

- ✅ 阶段 3 M1–M6 不新增 SQLite 表/字段/迁移，体验基于既有数据（规格 0003 §Data and Safety）
- ✅ M7 项目截止日期与里程碑作为核心领域事实入 SQLite：v6 加列+表，v7 加结果快照表；未写入 Tauri Store、未由子任务推导（ADR 0004）
- ✅ 到期结果快照在 snapshot() 惰性冻结、幂等（UNIQUE milestone_id），后续进度变化不改写历史（UI-SPEC 330）
- ✅ 续排复用既有 createProjectMilestone 通道，未新增领域命令；排程仅读约束，未改算法
- ✅ 所有核心写操作继续走 Tauri 后台串行队列并在成功后刷新当日备份
- ✅ 备份恢复版本感知：v6 校验 project_milestones、v7 校验 milestone_outcomes

## 遗留事项

1. **文档同步缺口（非功能问题）**：`docs/PROJECT-GUIDE.md` 多处仍停留在阶段 3 M6 基线，未反映 M7 四段完成：
   - 第 3 行 "SQLite schema v5" → 应为 **v7**
   - 第 23/190 行 "schema_version ... 5" → 应为 **7**
   - 第 261 行 validate_database 必需表清单 → 应补 `project_milestones`、`milestone_outcomes`
   - 第 310 行 测试库存 "Rust 26、Vitest 93" → 应为 **Rust 33、Vitest 106、Playwright 15**
   - 第 51 行 M7 段落应更新为"M7 四段全部完成"
2. **沙箱 e2e 偶发**：WorkBuddy 沙箱内 Playwright 偶发失败（safe-delete 拦截/代理），本机终端稳定；本次验收 15/15 全绿。
3. **规格澄清已落地**：阶段 2 遗留的"自动排程单次投入时长可部分安排"澄清已在 0002/PROJECT-GUIDE 同步，阶段 3 无新增澄清。

## 验收签核

阶段 3 十项能力（M1–M6 + M7.1–M7.4）全部满足规格验收标准，测试基础设施齐备（Vitest 106 / Rust 33 / Playwright 15 全绿），数据与安全决策核对通过，可进入阶段 3 真实使用验证或下一阶段规划。文档同步缺口建议在下一个提交前一并修正。
