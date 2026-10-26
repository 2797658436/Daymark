# 日历整改 A3 实施记录：周视图列宽、任务池自动覆盖与截断治理

- 日期：2026-10-25
- 范围：评估 `docs/reports/calendar-evaluation-2026-10-24.md` 的 **F03、F07、F12** 与 §6 的 **D1=a、D2=a**，A 轮第 3 步
- 状态：代码、测试、文档已落地；`npm run check` 四步全绿（build／395 条 Vitest／53 条 Playwright／48 条 Rust）。**未提交 Git**，未改动用户未提交的 A1/A2 内容
- 证据：`output/2026-10-25_calendar-a3/`（探针、量测、反向验证原始数据、截图；gitignored）

## 1. 结果摘要

- 周 1200×800@100%：列宽 **94 → 141px**，任务池自动转覆盖（右侧不再有停靠池），`clippedCount` **7 → 0**，无横向滚动。
- 周 960：列宽 111px 不变，`clippedCount` **4 → 0**（全天长句整行删除），无横向滚动。
- 周 1200×800@200%：全天区默认折叠，`clippedCount` **9 → 2**，两条都是带 `title` 的单行省略；无横向滚动。
- 周选中态：日期头单击只选中，右侧当天详情以贴顶侧栏出现（1200 下 320px、`position: sticky`），列宽 95px、`clippedCount` 3（全部带 `title`），不再跳走日视图。
- 月 1200／960：`安排 N 项 · 10:00…` 长句整行删除，改为至多两条标记行 + 一条聚合行；两档各只剩 1 条带 `title` 的聚合行省略。
- 反向验证：把列下限退回 84px、网格下限退回 720px、强制停靠池后，1200 下精确复现 **94px 列**，确认 A2 基线可重复；随后恢复 112px 并重新构建。
- 新增参数化并行上限：默认 3，列宽 <96px 时 2；第 3 项起收进「另外 N 项」。汇总卡与展开列表行为未变。

## 2. 列宽与任务池覆盖判定

### 2.1 「假想停靠后」的网格宽

判定不读 `.calendar-viewport` 当前宽：池子一旦转覆盖，视口会立刻变宽（1200 下 744 → 1052），用当前视口做判据会在阈值两侧来回跳。实现改为量一个与当前池态无关的量（`src/App.tsx:169-185`）：

```
假想停靠宽 = 外壳 clientWidth
           − 侧栏 getBoundingClientRect().width
           − workspace-main 的左右内边距
           − --pool-width（缺失时 320）
           − 6（分隔条）
```

- 由 `.app-shell` 的 `ResizeObserver` + `window resize` 驱动，只在 `page`／`calendarView`／`scale`／`taskPoolWidth` 变化时重装。
- 任一边量到 0（jsdom 没有布局）时存 `null`，不触发覆盖，避免测试环境误判。
- 阈值 `902 × (100 / scale)`，与 `--calendar-ui-factor` 同源：100% 为 902 CSS px，200% 为 451 CSS px。
- 周视图且量到可用宽时才启用；日视图不参与（保留 960–1199 静态侧栏例外）；月视图保持原窗口断点，不在本包范围。

实测（`measurements.json` 的 `pool` 字段）：

| 场景 | 外壳 | 侧栏 | 页内边距 | 池宽 | 假想停靠宽 | 阈值 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1200×800@100% | 1200 | 70 | 60 | 320 | **744** | 902 | 覆盖 |
| 960×640@100% | 960 | 64 | 36 | 320 | **534** | 902 | 覆盖（同时命中窄窗） |
| 1200×800@200% | 1200 | 140 | 60 | 320 | **674** | **451** | 停靠 |

200% 下 674 ≥ 451，所以 1200 窗口保持停靠池；这与 A2 交接的 451 CSS px 口径一致，也解释了为什么不能把阈值写成固定 902 CSS px。

### 2.2 覆盖面板复用

只切一个状态：`poolUsesOverlay`（`src/App.tsx:525-527`）。覆盖态的遮罩、Esc 关闭、焦点归还、右下浮钮重开全部沿用 960–1199 的既有机制；CSS 只补了一组由 `.app-shell.pool-overlay` 驱动的等价规则（`src/styles.css:1800-1804`），媒体查询下的原规则未改：

- `--pool-overlay-inset`：宽屏 4.375rem，≤1199 为 4rem；遮罩和固定池子都用它对齐图标栏。
- `.pool-overlay > .pool-splitter-region { display: none }`，池子固定在右侧 360px（窄窗为 `min(360px, 100vw − inset)`）。
- `.task-pool-toggle` 仍是覆盖态的重开入口；`Esc` 只关池子，不抢浮层的顶层。

### 2.3 列宽与网格下限

- `--calendar-week-column: calc(112px × var(--calendar-ui-factor, 1))`（`src/styles.css:575`）。
- `--calendar-min-week: calc(842px × var(--calendar-ui-factor, 1))`（`src/styles.css:573`）。`58 + 7×112 = 842` 是网格真正的最小内容宽；开工提示里的 902 用于**停靠判定**（留余量），若直接写成 `min-width: 902px`，960 窗口会凭空多出 60px 横向滚动。
- 1200 覆盖态实测 141px；960 实测 111px（列轨 112px，量的是 `.day-track` 内宽）；200% 实测 82px；选中详情时 95px（见 §2.4）。
- 200% 的 `weekColumnWidth` 是 CSS 像素，不是设计像素；并行上限按渲染后的 CSS 宽判定，宁可比设计口径更早降到 2 列。

### 2.4 周详情：1162px 断点与 sticky 侧栏

日期头选中后，右侧 `CalendarDateDetails` 需要 `58 + 7×112 + 320 = 1162px`。不足时（`@container (max-width: 1162px)`，`src/styles.css:711-720`）：

- 布局改为 `minmax(0,1fr) min(320px, 100% − 58px)`，周网格让出宽度，详情成为**贴顶侧栏**（`position: sticky; top: 0; align-self: start; z-index: 22`）。
- 不能用绝对定位：详情会跟着 1850px 高的周内容滚到视口上方，选中后只剩空白（过程记录 §10）。
- 因此选中态列宽会低于 112（1200 下 95px），并行上限按 96px 判据降到 2；详情保证不被挤出视口。这是本包接受的边界，已写进 UI-SPEC §131。

## 3. 并行上限参数化

`concurrentLayouts(sessions, maxSideBySide = 3)`（`src/lib/calendarPlacement.ts:46-67`）：

- `laneCount > maxSideBySide` 才收成汇总；`visibleLanes = collapsed ? Math.min(2, maxSideBySide) : laneCount`。
- 汇总态固定展示前 2 项，第 3 项起 `hidden`，由最后一个可见泳道的卡片显示「另外 N 项」；`showCount` 仍只在第一张卡。
- 周视图在 `CalendarPage` 里量 `.calendar-grid.week` 的宽度，`(width − 58) / 7 < 96` 时传 `concurrencyLimit={2}`（`src/App.tsx:1166-1177`、`1335`），`CalendarDay` 原样转交（`:1605`）。
- `calendarPlacement.test.ts` 原有 3 泳道默认用例保留，新增「上限为 2 时第 3 条收进汇总」用例（`:32`）。
- 既有 4 项以上「另外 N 项」展开列表、选中浮层未改。

## 4. 全天标记与月格

### 4.1 全天标记（周）

- 由逐条长句改为按类型分组的「图标 + 计数」胶囊：`截止 N`／`项目截止 N`／`里程碑 N`（`src/App.tsx:1539-1554`）。同组取最紧迫的 `urgency-*`，图标（旗／菱）与颜色双重编码。
- 胶囊 `aria-haspopup="dialog"`、`aria-expanded`，`title` 是整组明细；点击打开 `FloatingPanel kind="action"`（非模态、点外部／Esc 关闭、焦点归还由宿主负责），逐行复用 `calendarMarkerLabel`／`calendarMarkerAriaLabel`。行高 2.75rem，键盘可达。
- 200% 下 `defaultCollapsed={preferences.scale >= 200}`，仍保留「展开」按钮；展开后整条带子重建，默认折叠不影响已选日期。
- 所有保留的单行省略（胶囊文字、标记行、列表行）都带 `title`。

### 4.2 月格

- 删除「安排 N 项 · 10:00…」长句；标记行最多 2 条（截止旗／项目截止旗／里程碑菱 + 短标题，各自带 `title` 与紧迫度双编码），超出合并为「另外 N 项」（`src/App.tsx:1472-1518`）。
- 聚合行 `安排 N · 完成 M · 推进 K`：零值不写对应段，三段全空时整节不渲染；聚合行是单行省略并带完整 `title`。
- 月格不再消费 `calendarDaySummary().visible`／`overflowCount`（它们仍含长句投影），改为直接读 `scheduledSessions`／`deadlines`／`projectDeadlines`／`milestones`／`completedTasks`／`progressedTasks`；统计口径一个字未改。
- 行高、空格降权等 F13 密度重排未做。

## 5. 日期头语义

`WeekDateHeaders`（`src/App.tsx:1528-1537`）：

- 主按钮单击 = 选中该日：列获得 `.selected`（底色 + 底边强调线），右侧出现 `CalendarDateDetails`；`aria-pressed` 反映选中。
- 双击主按钮 = 进入该日连续日视图；另有一个显式的 `.week-date-open` 图标按钮（`CalendarDays`，`aria-label="打开 {date} {长日期} 日视图"`，`title="打开日视图"`），鼠标、键盘都可点。
- 方向键在日期头间移动焦点（左右一天、`PageUp/PageDown` 一周），既有行为不变；**Enter 只选中**，与月视图一致。
- 窄容器（≤760px）里图标按钮收成右上角角标，悬停／`focus-within` 时浮现，仍在 DOM 与 Tab 顺序中。
- 语义选择说明：开工提示第 5 条前半句写「双击或 Enter = 进日视图」，后半句又明确「Enter 语义从进日视图改为选中」。实现按后半句与月视图对齐，测试与 UI-SPEC 均写「Enter 选中、双击进日视图」；若后续要恢复 Enter 进日视图，只需改这一个判断并同步两条测试。

## 6. 控件与文案去向

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| 周日期头 | 单击 = 跳日视图；无选中态 | 单击 = 选中 + 列描边 + 右侧当天详情；双击 = 日视图；右侧新增「打开日视图」图标按钮 |
| 周全天区 | 逐日长句「今天截止 · 写开题报告的文献综述部分」原位两行 | 按类型 `截止 N`／`项目截止 N`／`里程碑 N` 胶囊；点击打开锚定浮层完整名单 |
| 周全天区（200%） | 展开 | 默认折叠为一条「全天／展开」带 |
| 月格第一行 | `安排 N 项 · 10:00 起` | 截止／项目截止／里程碑标记行，至多 2 条 |
| 月格第二行 | `曾完成 N 项`、`进度变化 …` | 一条 `安排 N · 完成 M · 推进 K` |
| 周列宽 | 下限 84px | 下限 112px（设计像素，随 `--calendar-ui-factor` 反比换算） |
| 任务池 | 窗口 ≥1200 即停靠 | 假想停靠网格 ≥902 设计宽才停靠；否则复用覆盖面板 |
| 并行卡 | 固定 4 项起汇总 | 默认 3 项上限；列宽 <96px 时 2 项上限 |

未新增设置字段；选中日期与全天浮层展开仍是 App 层内存，重启不恢复。

## 7. 截断治理前后对照

改前取 `output/2026-10-24_calendar-assessment/measurements.json`（A2 探针），改后取 `output/2026-10-25_calendar-a3/measurements.json`。改后口径新增了 `.month-cell-aggregate`，并把 `title` 作为「可接受省略」的判据。

| 场景 | 改前列宽 / clipped | 改后列宽 / clipped | 改后未带 title | 说明 |
| --- | --- | --- | --- | --- |
| cal-week-1200 | 94px / **7** | 141px / **0** | 0 | 全天长句删除、列宽回升 |
| cal-week-960 | 111px / **4** | 111px / **0** | 0 | 同为全天长句 |
| cal-week-200 | 94px / **9** | 82px / **2** | 0 | 200% 折叠全天区；剩 2 条会话标题省略，均带 `title` |
| cal-week-selected | —（直接跳日视图） | 95px / **3** | 0 | 18:00 两泳道卡片标题，均带 `title` |
| cal-month-1200 | 0（选择器未覆盖月格 chip）／截图全截断 | **1** | 0 | 唯一省略是聚合行，带完整 `title` |
| cal-month-960 | 同上 | **1** | 0 | 同上 |

改前 7 条的例子（全部是全天长句）：`已逾期 · 跑步 5 公里` 需 93px 只有 59px、`今天截止 · 写开题报告的文献综述部分` 需 178px 只有 63px。改后剩下的 5 条（200% 2 条、选中态 3 条）都是会话标题的单行省略，`strong` 的 `title` 是完整任务名，悬停与读屏可拿到全文。

标准密度卡片在周 1200 实测：13 张会话卡全部有 `<time>`，样本为 `10:00–11:00` + `准备中期答辩讲稿`，标题字号 12px（200% 为 24px），符合「至少标题 + 起止时间」。

## 8. UI-SPEC 回写（合并式）

保留工作区里 A2 的未提交修改，只改周／月相关段落：

- 第 133 行：单击选中 + 右侧列表、双击进日视图、Enter 只选中、显式图标入口；补 1162px 详情侧栏与列宽可低于 112 的边界。
- 第 134 行：全天区改「图标 + 计数」胶囊、锚定浮层名单、200% 默认折叠。
- 第 135 行：中央区域不足 902 设计宽时任务池转覆盖、列宽下限 112px。
- 第 138 行：月格标记行至多 2 条 + 聚合行，零值省略、全零不渲染。
- 第 139 行：周／月选中语义一致（单击选中，不切换视图）。

## 9. 验证

### 9.1 `npm run check`（最终树）

四步全部退出码 0：

1. `tsc --noEmit && vite build` 通过（仅有既有的 chunk >500kB 提示）。
2. Vitest：**30 个文件 / 395 条全过**。
3. Playwright：**53 条全过**，含 `phase 4 M12 has no automated accessibility violations on every page at 960 and 200 percent in light and dark` 与 `M13` 的两条遮挡／14 轮 axe 用例。
4. `cargo test --all-targets`：**48 条全过**。

### 9.2 探针复测

`node output/2026-10-25_calendar-a3/probe.mjs`（headless、单 browser、生产构建 + vite preview、固定时钟；`ref-settings-1200` 仍超时，是 A2 已记录的既有问题，不在本包范围）：

- `cal-week-1200`：`weekColumnWidth 141`、`clippedCount 0`、`hScroll false`、`pool.overlayClass true`、假想宽 744。
- `cal-week-960`：111px、clipped 0、无横向滚动、假想宽 534。
- `cal-week-200`：82px、clipped 2（untitled 0）、无横向滚动、停靠池、假想宽 674。
- `cal-week-selected`：95px、clipped 3（untitled 0）、详情 `position: sticky`、`top 109 / height 462 / width 320`。
- `cal-week-allday-panel-1200`：浮层 2 行（当天截止 + 里程碑）。
- `cal-month-1200/960`：clipped 1（聚合行，带 title）。
- 全部周场景 `sessionsWithTime` 为 12–13，标准密度样本时间为 `10:00–11:00`。

### 9.3 截图逐张检查（headless，1024 宽以上为 1200×800，960 场景 960×640）

- `cal-week-1200.png`：七列明显变宽；标题与起止时间同时可见；全天胶囊「截止 1」「里程碑 1」；右下角「任务池」浮钮说明池已转覆盖。
- `cal-week-960.png`：七列无横向滚动，标题换行完整；全天胶囊可点。
- `cal-week-200.png`：全天区收成「全天／展开」一条；日期头只留星期与日号；任务池停靠在右（假想宽 ≥451）。
- `cal-week-selected.png`：8 月 6 日列有选中底色与底边线，右侧 320px 详情贴顶显示「已选日期／打开日视图／重要事实／当天安排」，没有跳去日视图。
- `cal-week-allday-panel-1200.png`：浮层列出「今天截止 · 写开题报告的文献综述部分」「中期答辩」两行，头部日期与关闭按钮齐全。
- `cal-month-1200.png`：格内为旗／菱标记 + 短标题，第二条以下收「另外 N 项」，底部一条聚合行（`安排 8 · 完成 1 …` 单行省略，悬停有全文）。
- 检查项：无横向滚动、无重叠、文本对比度沿用既有 token；`urgency-later` 不再整元素降透明度（否则 axe 对比度不过）。

### 9.4 axe 与 M13

`npm run check` 的 Playwright 已包含 960×200% 浅／深逐页 axe 与 M13 的 `elementFromPoint` 遮挡用例，均通过；周视图仍是 `role="group"` + `aria-current`，月历仍是 6×7 表结构。

### 9.5 反向验证

临时把 `--calendar-week-column` 改回 84px、`--calendar-min-week` 改回 720px，并暂时禁用 `weekPoolNeedsOverlay` 以恢复 A2 的停靠态，重新 build 后跑 `probe.mjs --only=cal-week-1200`：

- `weekColumnWidth = 94`、`pool.docked = true`，与 A2 基线**逐像素一致**；原始数据存 `output/2026-10-25_calendar-a3/reverse-week-94.json`。
- 随后恢复 112／842 与覆盖判定，重新 build 并跑全量探针；最终 `measurements.json` 为恢复后的数据。

### 9.6 文档同步

- `docs/PROJECT-GUIDE.md`：能力总览（任务池覆盖条件、日期头语义）、§5 的 `App.tsx`／`calendarPlacement`／`styles.css`／`App.test.tsx` 条目；未改 §10 图层表（本包没有新增图层）。
- `docs/design/UI-SPEC.md`：§131／§136 及相邻周／月条目，合并式回写，A1/A2 的未提交修改原样保留。

## 10. 过程中发现并修正的问题

- 新加的 Esc `useEffect` 一开始放在 `if (loading) return` 之后，加载完成后 hook 数量变化，124 条 App 测试报 “Rendered more hooks than during the previous render”。把任务池派生值与 Esc 监听到早退之前解决。
- 按提示把 `--calendar-min-week` 写成 902 后，960 窗口出现 60px 横向滚动；实际网格最小内容宽是 `58 + 7×112 = 842`，902 只作停靠阈值。
- 周详情最初沿用绝对定位，选中 8 月 6 日后详情跟着内容滚到视口上方（top −550），看起来像「面板没出现」；改为 1162px 断点下的 sticky 侧栏。
- 新加的 `urgency-later` 曾给月格／胶囊整元素 `opacity: .82`，axe 报 color-contrast；改为 `opacity: 1`，紧迫度只靠既有色条与图标表达。
- 1200 下任务池转覆盖后，原拖拽 E2E 找不到停靠池里的 `.task-card`；该用例改用 1440×800（池保持停靠）继续验证拖拽，不改变 A3 的覆盖行为。

## 11. 未做与边界

- **拖拽**：池子以覆盖态打开时，遮罩会挡住「从池里拖到日历」的指针路径，这是 960–1199 既有机制的固有限制；本轮按约定不碰拖拽，留给 B 轮（pointer 自绘时应让覆盖池可拖出或拖拽期间自动收起）。停靠态拖拽未受影响。
- **日视图**：未改。A4 的吸顶带、密度与折叠仍按原计划。
- **F13 月视图密度**：未做；月 1200 仍是停靠池 + 95px 格，聚合行可能单行省略（有 `title`）。
- **选中详情**：≤1162px 时周列会低于 112px（1200 选中态 95px），这是为了保证详情不被挤出；如果后续要求「选中时也不低于 112」，需要把详情改成不占布局的覆盖层，并接受遮住周末列。
- **200%**：全天区默认折叠，标记要多一次点击；2 条会话标题仍是单行省略（带 `title`），不追求在 82px 列内放下完整标题。
- **窄容器图标**：≤760px 时「打开日视图」图标只在悬停／聚焦时显现，键盘仍在 Tab 顺序中；若要求始终可见，需要重新分配日期头宽度。
- 未新增依赖、未改 SQLite schema、未改设置字段、未改 `calendarDaySummary`／`calendarDayMarkers` 的统计口径。

## 12. A4 交接点

### 12.1 吸顶带可复用的 `calendarDaySummary` 字段

`calendarDaySummary(workspace, date, today)` 已给出吸顶带需要的全部事实，直接读字段，不要再拼 `visible`：

- `scheduledSessions`：当天仍成立的安排（已排除 `missed`／`cancelled`），可直接算项数与最早开始时间。
- `deadlines`／`projectDeadlines`／`milestones`：三类重要日期，里程碑按 `sortOrder` 排序。
- `completedTasks`／`progressedTasks`／`missedTasks`／`progressDelta`：当天完成、有进度变化、未推进与净变化。
- `visible`／`overflowCount`：仍是旧的「长句投影」（第一条是 `安排 N 项 · hh:mm 起`），A3 的月格已不再消费；吸顶带若需要紧凑摘要请用上面的原始字段自行排版。

### 12.2 覆盖面板状态对日视图的影响

- `poolUsesOverlay` 的宽屏分支只对 `calendarView === "week"` 生效；日视图在 1200 及以上永远停靠（UI-SPEC 的静态侧栏例外），在 <1200 仍按 `narrowWindow` 覆盖。
- 200% 下 1200 窗口的周视图是停靠态（假想宽 674 ≥ 451），日视图同样是停靠态；A4 不要用 `.calendar-viewport` 宽度反推池态，也不要把 `weekGridAvailableWidth` 套到日视图上。
- 覆盖态的遮罩从 `--pool-overlay-inset` 起、池子固定右侧；A4 若在日视图加吸顶带，注意 `z-index` 不要压过 24/25 的池子与遮罩，继续沿用既有图层表。
- 池态切换会重排 `.workspace-main`；A4 的浏览位置恢复逻辑应继续依赖 `useCalendarViewport` 的锚点补偿，不要在池态切换时重新播种。

### 12.3 其他

- 周视图列宽量测（`CalendarPage` 的 `weekColumnWidth`）与并行上限可以照搬到日视图的密度判断，但日视图目前没有并排卡。
- 日期头 Enter 语义已定为「选中」；若 A4 要统一成「Enter 进日视图」，需要同时改 `WeekDateHeaders`、`App.test.tsx:482` 与 `phase1.spec.ts` 的 M6 结尾断言。

## 13. 证据清单

- `output/2026-10-25_calendar-a3/probe.mjs`：探针（支持 `--only=name1,name2`），量测含假想停靠宽、并行、浮层行数、卡片时间与截断 `title`。
- `output/2026-10-25_calendar-a3/measurements.json`：最终全场景数据。
- `output/2026-10-25_calendar-a3/reverse-week-94.json`：反向验证的 94px 原始数据。
- `cal-week-1200.png`、`cal-week-960.png`、`cal-week-200.png`、`cal-week-selected.png`、`cal-week-allday-panel-1200.png`、`cal-month-1200.png`、`cal-month-960.png`：逐张检查过的截图。
- 代码：`src/App.tsx`、`src/styles.css`、`src/lib/calendarPlacement.ts` 及其测试、`src/App.test.tsx`、`e2e/phase1.spec.ts`、`e2e/gui-optimization.spec.ts`。
