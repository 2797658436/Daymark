# Daymark 阶段 3 验收报告

- 验收日期：2026-09-06
- 验收对象：`docs/specs/0003-phase-3-calendar-experience.md`（M1–M6）+ `docs/specs/0004-m7-project-deadlines-and-milestones.md`（M7.1–M7.4）
- 验收方式：生产构建 + 全套测试（Vitest / Rust / Playwright）+ 规格逐条核对
- 验收基线：阶段 2 验收报告（2026-08-10）之后的全部阶段 3 提交

## 总结论

**阶段 3 验收通过。** 阶段 3 六个日历里程碑（M1 时间轴与三视图、M2 状态感知与计划/实际叠加、M3 缩放与卡片自适应、M4 默认时段折叠、M5 完整拖拽排程、M6 全天区/月摘要/键盘导航）与 M7 四个子段（M7.1 核心数据、M7.2 项目编辑、M7.3 日历标记、M7.4 历史与风险）的验收标准均已满足，无阻断性功能缺陷。收尾同时修正了紧凑任务卡拖拽 E2E、深色主题过渡期 axe 采样、日视图任务池调宽持久化，以及 M7 的顺序任务、累计续排和本地日期冻结边界。

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
| Vitest（11 个测试文件） | **123 通过** | 本次完整检查 |
| Rust（全目标） | **36 通过** | 本次完整检查 |
| Playwright E2E（e2e/phase1.spec.ts） | **16 通过** | 本次完整检查 |
| 生产构建（tsc --noEmit + Vite） | 成功 | 本次完整检查 |

> 注：本次验收由 `npm run check` 串行完成生产构建、Vitest、Playwright 与 Rust 全目标测试；随后另行执行 Windows NSIS 安装包构建。

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
| 以设备本地自然日冻结已经到期且未达成的里程碑；同日不提前冻结、已达成不生成失败快照 | `lib.rs` workspace/data 命令 + `database.rs` freeze_expired_outcomes + `migrations/007_milestone_outcomes.sql` | `database.rs` 到期冻结与已达成用例 |
| 顺序任务里程碑要求目标任务及其全部前置任务完成 | `App.tsx` orderedMilestoneTasks + `database.rs` ordered_milestone_tasks | 前端/Rust `ordered-task milestone` 用例 |
| 加权项目进度在前端、浏览器预览与桌面端统一使用 0–100 百分比尺度 | `App.tsx` projectProgress + `native.ts`/`database.rs` 进度计算 | Rust `project_progress_milestone_uses_the_existing_percentage_scale` |
| 冻结后的里程碑不可编辑或删除；显式续排创建新里程碑并保留累计目标语义 | `App.tsx` continueMilestoneDraft + `database.rs`/`native.ts` 历史保护 | App/native/Rust 冻结历史与续排用例 |
| 确定性排程读取任务截止、适用未达成里程碑和项目截止约束 | `App.tsx` scheduleDeadlineForTask | `App.test.tsx` 项目截止兜底与最早适用里程碑约束用例 |
| 首次冻结刷新当日备份；备份校验覆盖 v7（缺 milestone_outcomes 必须拒绝） | `lib.rs` refresh_daily_backup + `backup.rs` validate_database version>=7 | `backup.rs` "restore_rejects_a_v7_backup_that_is_missing_milestone_outcomes" |

## 数据与安全决策核对

- ✅ 阶段 3 M1–M6 不新增 SQLite 表/字段/迁移，体验基于既有数据（规格 0003 §Data and Safety）
- ✅ M7 项目截止日期与里程碑作为核心领域事实入 SQLite：v6 加列+表，v7 加结果快照表；未写入 Tauri Store、未由子任务推导（ADR 0004）
- ✅ 到期结果在工作区／数据读取与领域写入入口按设备本地自然日同步；`snapshot()` 保持只读，冻结操作使用即时事务且由 UNIQUE milestone_id 保证幂等
- ✅ 冻结里程碑不可修改或删除；续排复用既有 createProjectMilestone 通道，以新 ID 保留原历史，数量／进度继续使用累计目标
- ✅ 排程优先读取任务截止日期，否则取适用未达成里程碑与项目截止中的更早日期；容量预测、专属排程按钮与提醒明确留在后续范围
- ✅ 所有核心写操作继续走 Tauri 后台串行队列并在成功后刷新当日备份
- ✅ 备份恢复版本感知：v6 校验 project_milestones、v7 校验 milestone_outcomes

## 后续范围（不阻断阶段 3）

1. 项目容量预测、里程碑专属排程按钮、节奏建议、自动级联顺延与项目／里程碑系统通知不属于本阶段。
2. 开机自启、独立截止任务页、完整日／周／月回顾、复杂重复规则、AI 规划和高级布局自定义继续留在后续阶段。
3. 阶段 2 的 21 天候选版仍需要真实使用观察；自动化通过不能替代该验证计划。

## 验收签核

阶段 3 十项能力（M1–M6 + M7.1–M7.4）全部满足规格验收标准，测试基础设施齐备（Vitest 123 / Rust 36 / Playwright 16 全绿），数据与安全决策核对通过，可进入阶段 3 真实使用验证或下一阶段规划。
