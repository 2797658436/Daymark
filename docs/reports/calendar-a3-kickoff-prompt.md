# 日历整改 A3 开工提示词：周视图列宽、任务池自动覆盖与截断治理

> 用法：整段复制到新会话作为开场提示。前置：A1、A2 已完成并绿。方案基线见 `docs/reports/calendar-evaluation-2026-10-24.md`（下称**评估**）的 **F03、F07、F12** 与 §6 的 **D1、D2**，对应 §5.2 第 3 步。

---

你在 Daymark 仓库（F:\PythonProject\Daymark）开工**日历整改 A3：让周视图在最常见的 1200 宽 + 任务池停靠组合下可读**。三件事：列宽下限与任务池自动降级（F03/D1）、全天标记与月格截断治理（F07）、周视图日期头语义与右侧当天详情（F12/D2，含 UI-SPEC 回写）。

## 先读（按顺序，不要跳过）

1. `AGENTS.md`。
2. 评估 §2 结构账（列宽那一列）、§3 基准 4/6/7、§4 的 **F03、F07、F12**、§5.2 第 3 步、§5.4、§6 的 D1/D2（**已定案，不要再讨论选项**）。
3. `docs/design/UI-SPEC.md`「主窗口结构」（960–1199 覆盖面板机制、§131 日期头语义、§133 窄列退化顺序、§136 月视图选中）；**用户工作区里 UI-SPEC.md 有未提交修改，回写 §131/§136 时先读当前版本再合并**。
4. `src/App.tsx`：壳层 `hasTaskPool`／`day-view-pool` 的判定（grep `hasTaskPool` 与 `with-task-pool`）、`WeekDateHeaders`（1371–1380）、`WeekAllDayArea`（1382–1386）、`MonthCalendar`（1338–1369）、`CalendarDateDetails`（1388–1394）、周视图布局 1214–1218。
5. `src/styles.css`：575–588 行周网格与吸顶、583–587 行全天格、594–606 行月历、612–619 行窄容器覆盖规则、662–665 行 `.calendar-session` 四档容器查询。
6. `src/lib/calendarPlacement.ts` 的 `concurrentLayouts`（约 60–63 行并排/汇总阈值）。
7. 证据图：`cal-week-1200.png`（94px 列、23px 并行卡）、`cal-week-200.png`（碎字）、`cal-month-1200.png`（截断 chip）。

## 现状账（改前基线）

- 周 1200 + 停靠池：列宽 **94px**、卡片 86px → 四档容器查询全命中，卡片只剩标题；18:00 三并行每张 **23px**。周 960（池转覆盖）反而 111px。
- 截断：周 1200 七处（「今天截止 · 写开题报告的文献综述部分」需 178px 只有 63px）；周 200% 九处（需 355px 只有 64px）；月格 chip 全截断。
- 周视图日期头单击 = 直接切日视图（`onOpenDate`），`selectedCalendarDate` 只能由全天标记/月格设置 → 右侧 `CalendarDateDetails` 在周视图无入口。

## 交付范围

1. **列宽与任务池降级（F03/D1=a）**：`.calendar-grid` 周视图列下限 84 → **112px**（7×112+58=902）；把任务池停靠判定从「窗口宽 ≥1200」改为「**周视图网格可用宽 ≥902**」（日视图维持现状：960–1199 仍保留静态侧栏，UI-SPEC 有明文），不足即复用既有覆盖面板机制（遮罩、Esc、焦点归还、右下浮钮重开，全部现成）。判定要读真实可用宽（容器 ResizeObserver 或 container query + 状态），不要硬编码窗口断点。
2. **并行降级**：`concurrentLayouts` 的并排上限参数化——列宽 <96px 时最多 2 并排 + 「另外 N 项」（现阈值是 4 起汇总）；汇总卡与展开列表行为不变（`App.tsx:1566-1574`）。补 `calendarPlacement.test.ts` 用例。
3. **全天标记（F07）**：默认态改「图标 + 计数胶囊」（如 `截止 2 · 里程碑 1`，紧迫度用既有 `urgency-*` 色条/图标双编码），点击/键盘打开 `FloatingPanel kind="action"` 展开该日完整标记名单（复用 `WeekAllDayArea` 已有的 expandedDates 状态，只是把展开形态从原位列表改成浮层）；200% 下全天区默认折叠（既有 `.week-all-day.collapsed`）。**所有保留的单行省略号必须带 `title`**。
4. **月格（F07 的月部分，只做减法）**：删「安排 N 项 · 10:00…」这类长句 chip，改为标记行（截止旗/里程碑菱 + 短标题，至多 2 条）+ 一条聚合行（`安排 N · 完成 M · 推进 K`，零值不写那一段，基准「没话说整节不渲染」）；密度重排（空格降权、行高 96）**不做**，留给后续包 F13。
5. **日期头语义（F12/D2=a）**：单击日期头 = 选中该列（列描边 + 右侧 `CalendarDateDetails`）；**双击或 Enter = 进日视图**；日期头保留一个显式「打开日视图」小入口（图标按钮 + aria-label）。键盘：方向键在日期头间移动的既有行为不变，Enter 语义从「进日视图」改为「选中」，**同步改 `App.test.tsx` 的周键盘用例与 `e2e/phase1.spec.ts:589`（M6 键盘导航）**。
6. **回写 UI-SPEC**：§131「单击日期头进入该日的连续日视图」改为「单击选中并在右侧显示当天列表；双击或 Enter 进入日视图」；§136 补一句周视图与月视图选中语义一致。**合并式回写，保留用户未提交修改**。

## 明确不做（越界即停并回报）

- 不改日视图（A4）、不改 chrome（A2 已做）、不改拖拽（B 轮）。
- 不改月视图行高/空格权重（F13 后续包）；不改 `calendarDaySummary`／`calendarDayMarkers` 的统计口径（只改呈现）。
- 不新增依赖；不改设置字段；选中日期仍只放 App 层内存（同会话有效、重启不恢复，与截止页一致）。
- 不动用户未提交修改。

## 必须保持（回归红线）

- 960–1199 覆盖面板既有行为与「日视图保留静态侧栏」的例外。
- 周视图键盘网格（`role="group"` + `aria-current`，P4-11）与月视图 6×7 表结构（`grid → row → columnheader/gridcell`）不得破坏；960×200% 浅/深逐页 axe 全绿。
- M6（`phase1.spec.ts:589`）月摘要/全天溢出/键盘导航用例按新语义改写后仍覆盖原行为点。
- 并行 4 项以上的「另外 N 项」展开列表、选中浮前等既有交互不回退。

## 验证

```powershell
npm run check
node output/2026-10-24_calendar-assessment/probe.mjs
```

- `measurements.json` 复测目标：`cal-week-1200` 的 `weekColumnWidth ≥ 112`（任务池应已自动转覆盖：截图里右侧不应有停靠池）；`clippedCount = 0` 或仅剩带 `title` 的单行省略号（`cal-week-1200/200`、`cal-month-1200/960`）；standard 密度卡片在周视图至少显示标题 + 起止时间（看 `sessions.densities` 与截图）。
- 重拍并**逐张看**：`cal-week-1200`（含三并行那一列）、`cal-week-960`、`cal-week-200`、`cal-week-selected`（现在是选中列 + 右侧详情，而不是跳去日视图）、`cal-month-1200`；另拍全天浮层展开态一张；落 `output/<今天日期>_calendar-a3/`。
- 960×200% 逐页 axe + M13 遮挡用例全绿。

## 完成定义

1. 代码 + 测试落地，`npm run check` 四步全绿。
2. 写 `docs/reports/calendar-a3-implementation.md`：列宽/覆盖判定实现方式、控件与文案去向、截断治理前后对照（clipped 清单）、UI-SPEC 回写 diff 摘要、验证实测、反向验证（把列宽下限改回 84 应复现 94px 列）、未做与边界。
3. 文档同步：PROJECT-GUIDE §5／§10 若描述周视图列宽或日期头语义则修正；UI-SPEC §131/§136 合并回写。
4. 不 `git commit`；不动用户未提交内容。
5. 汇报：验证实测、UI-SPEC 回写内容、A4 交接点（吸顶带要复用的 `calendarDaySummary` 字段、覆盖面板状态对日视图的影响）。
