# 日历整改 C1 开工提示词：工具行单行化、全天并排、回到现在常驻、右下角浮层与横向滚动条修复

> 用法：整段复制到新会话作为开场提示。前置：A 轮（`391a7c8`）、B 轮（`8adddaf`）、B3（`bcc527a`）、0.1.19（`22122d8`）均已提交。方案基线见 `docs/reports/calendar-evaluation-2026-10-24.md`（下称**评估**）§5.5 的 C 轮索引与 §6 的 **D14–D17**。
> 本包来自**用户 2026-10-27 实测 0.1.19 的 15 条反馈**中的骨架类六条（原编号 #1、#2、#9、#10、#14、#15）。C1–C4 四包相互独立，本包**不改拖拽状态机、不改气泡内容、不改卡片进度呈现**。

---

你在 Daymark 仓库（F:\PythonProject\Daymark）开工**日历整改 C1：把日历页头部收成一行（月/周视图）、周视图全天区并入第一行、「回到现在」常驻、修右下角三层浮层互相遮挡、消掉视口级横向滚动条、空默认时段时禁用「默认时段」模式按钮**。

## 先读（按顺序，不要跳过）

1. `AGENTS.md`。
2. 评估 §5.5 的 C 轮索引（15 条→四包映射）、§6 的 D14–D17。
3. `docs/reports/calendar-a6-implementation.md`（密度三档 84/168/216、周吸顶 88px 带、「+N」chip 的既有裁决）。
4. `src/App.tsx`：`CalendarPage` 的 PageHeader（1483–1499）、`calendar-toolbar`（1500–1509）、`back-to-now`（1516）与 `nowDirection` 测量（1384–1399）、周视图 `WeekDateHeaders`/`WeekAllDayArea`（1876–1895、1511 的挂载点）、`CalendarDateDetails`（1897–1903）、任务池按钮 `task-pool-toggle`（745）。
5. `src/styles.css`：`.calendar-toolbar`（632–651）、`.calendar-viewport`（657）、周布局与吸顶（660–690）、月布局（708–711）、详情面板与容器查询（724–747）、`.task-pool-toggle`（388）、`.back-to-now`（936）、min-width 变量链（576–583）。
6. `src/lib/calendarTimeline.ts` 130–151（空 slots 时 defaultSlots 模式整天塌成 44px 折叠带的机制）与 `src/lib/settings.ts` 114、329–333（空数组是合法持久化状态）。

## 现状账（改前基线，均已实测定位）

- 头部两行：第一行 PageHeader（日/周/月切换 + 上一段/今天/下一段），第二行 `calendar-toolbar`（日视图模式分段 1502、密度分段 1503、实际记录开关 1506、「显示…」1507）；toolbar `flex-wrap: wrap`（styles.css:632）窄窗口还会再折行。用户要求月/周视图把这些并进第一行。
- 周视图吸顶第二行 `WeekAllDayArea`（44px）：收起态仍占一整行（styles.css:690 `.week-all-day.collapsed .week-all-day-label { grid-column: 1 / -1; min-height: 44px }`），用户要求「全天」做成第一行里的切换按钮、收起时零占位。
- 「回到现在」只在 `nowDirection` 非空时渲染（App.tsx:1516）：月视图、锚点非今天、now 线已在视口内三种情况都隐藏（1384–1391）。用户要求**常驻**。
- 右下角三层浮层几何重叠：`task-pool-toggle` fixed right:18/bottom:18 z-20（窗口坐标系）、`back-to-now` absolute right:18/bottom:18 z-30（`.calendar-page` 坐标系）、`CalendarDateDetails` 窄容器时变覆盖层 `inset: 0 0 0 auto`（styles.css:730–731、743–744）——三者叠在同一角落，用户实测「已选日期挡住任务池按钮」。
- 横向滚动条：`.calendar-viewport { overflow: auto }`（styles.css:657）+ 硬 min-width 链（`--calendar-min-week` 100% 时 842px；with-detail 双列下限 842+260=1102px；月 720/860px；日 `--calendar-min-day`）+ 容器查询阈值 1162/1040（styles.css:742–747、729–736）之间存在「查询认为够宽、内容实际更宽」的窗口；`html,body,#root { min-width: 960px }`（94）与 `max-width: 1240px`（584）、任务池停靠（214）共同挤压。
- 「默认时段」模式按钮无 disabled 逻辑（App.tsx:1502）：`defaultTimeSlots` 为空数组时选它 → 非今天整天塌成一条 44px 折叠带、今天只有现在 ±60 分钟可见（calendarTimeline.ts:130–151），看起来像坏了。

## 交付范围

### 1. 月/周视图工具行并入第一行（#15）

- 月、周视图：密度分段（紧凑/标准/详细）、实际记录开关（周）、「显示…」触发（周；月见 C2 的裁决，本包按月视图仍需渲染处理）并入 PageHeader 的 actions 行；`calendar-toolbar` 在这两个视图不再渲染第二行。**日视图保持现有两行**（控件多，用户未要求）。
- 约束：960×640 与 200% 缩放下头部不换行、不裁切、命中区 ≥44px、文字对比度 ≥4.5:1；空间不足时允许密度分段用紧凑形态（如仅图标 + aria-label + title），但三档语义与 `aria-pressed` 不变。
- `App.test.tsx` 里所有经工具行选择器取控件的用例同步更新（「显示更多日历选项」「显示实际记录」等 accessible name 保持不变）。

### 2. 周视图全天区并入第一行（#10）

- 「全天」标签 + 展开/收起切换按钮移进 `WeekDateHeaders` 第一行（gutter 单元格）；**收起态不渲染第二行**（吸顶带回到 44px），展开态照常渲染全天 chip 行与「+N」浮层（A6 既有行为不变）。
- 切换按钮 `aria-expanded` + `aria-controls`；`defaultCollapsed={preferences.scale >= 200}` 的既有默认保留。
- `output/2026-10-26_calendar-a6/residuals.mjs` 的吸顶高度断言（44/88/88/176）随新结构更新预期，**并在实施记录里写明改前/改后数值**。

### 3. 「回到现在」常驻（#2）

- 日、周视图恒显（月视图不加，头部已有「今天」）；不再以 `nowDirection` 作可见性条件（方向箭头语义可保留为装饰）。
- 点击行为：锚点非今天 → 先回今天再 `viewport.revealNow()`；锚点是今天 → `revealNow()`（now 线已可见时也执行，平滑居中）。
- 位置与第 5 条的角落排布统一处理。

### 4. 「默认时段」按钮禁用（#1）

- `defaultTimeSlots` 为空数组时：「默认时段」分段按钮 `disabled` + `title="先在设置里添加默认时段"`。
- 同时给一条兜底：slots 为空而 `calendarDayMode === "defaultSlots"` 时，时间轴**按 fullDay 渲染**（不塌成 44px 带子）；偏好值不改写，用户补回时段后自动恢复 defaultSlots 渲染。

### 5. 右下角浮层排布（#14）

- `task-pool-toggle`、`back-to-now` 纵向错开（例：back-to-now `bottom: calc(18px + 按钮高 + 8px)`，具体数值以 44px 命中区和 4px 网格定）；月视图窄容器下 `CalendarDateDetails` 覆盖层给底部留白或让出右下角，不再盖住任务池按钮。
- 在 960、1040、1162、1440 四个宽度与任务池开/关两种状态下逐一验证无遮挡。

### 6. 视口级横向滚动条（#9）

- 判据：日/周/月三视图 × 宽 960–1920 × 任务池开/关 × UI 缩放 100%/125%/150%/200%，`.calendar-viewport`（日视图另含 `.continuous-day-axis`）**不出现横向滚动条**；唯一例外是 A6 已裁决接受项（周 200% 74px 窄列的内部横溢）。
- 手段自选（容器查询阈值对齐真实内容宽、with-detail 详情列更早转覆盖、min-width 收敛等），但不得让周视图列宽跌破 A6 的结构账（141/111/74/95），不得引入文字裁切。
- 先诊断：写一次性探针（落 `output/`）量出每个场景 `scrollWidth - clientWidth`，把根因场景清单写进实施记录；若根因恰是已裁决项，停下来回报而不是私自推翻裁决。

## 明确不做（越界即停并回报）

- 不动拖拽状态机与密度档切换的滚动恢复（C4）；不动任何气泡/浮层的内容与风格（C2）；不动 now 线与卡片进度条（C3）；不做 F13 月视图密度重排（后续包）。
- 不改 `useCalendarViewport` 的优先级仲裁结构；不改 A6 的密度定标与档位迁移。
- 不 `git commit`；开工先 `git status` 确认并**保留用户未提交修改**。

## 验证

```powershell
npm run check
node output/2026-10-26_calendar-a6/residuals.mjs   # 预期值按第 2 条更新后跑
```

- 截图落 `output/<今天日期>_calendar-c1/` 并**逐张看**：三视图头部单行（960 与 1440 各一组）、周全天收起/展开对照（吸顶高度标注）、常驻「回到现在」与任务池按钮同屏、右下角三宽度排布、横滚探针的改前/改后读数。
- 组件测试新增：空 slots 时「默认时段」disabled、回到现在常驻且锚点非今天时点击回今天、全天切换收起后第二行不渲染。既有 419 条 Vitest 与 62 条 E2E 全绿（selector 变更同步改用例，不许删断言）。

## 完成定义

1. 上述判据全绿；实施记录 `docs/reports/calendar-c1-implementation.md` 写明：六项的改前/改后对照（含吸顶高度、横滚读数）、residuals 预期值变更理由、未收口项与回退方法。
2. `docs/PROJECT-GUIDE.md` 与 `docs/design/UI-SPEC.md` 合并式回写（头部结构、全天行、回到现在常驻语义、右下角浮层排布）。
3. 不 `git commit`；保留工作区其它未提交修改。
