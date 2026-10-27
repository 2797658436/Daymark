# 日历整改 C2 实施记录：气泡定位与风格统一、时间编辑统一、周视图面板收敛、添加入口重做

> 对应开工提示：[`calendar-c2-kickoff-prompt.md`](calendar-c2-kickoff-prompt.md)。方案基线：评估 §5.6 的 C 轮索引（原反馈 #5／#6／#8／#11／#12／#13）与决策 D15／D17。本包未改拖拽状态机、吸附语义、B 轮验收过的让位／确认气泡，也未动密度与布局骨架。

## 1. 结果摘要

| 判据 | 改前（0.1.19 + C1） | 改后 |
| --- | --- | --- |
| 空白拖选气泡位置 | 0×0 `DOMRect` 被判为「无锚点」→ `body` 矩形 → 钳到 **(12,12)** | **锚在松手点**（实测三场景 `bubble.left = release.x`、`bubble.top = release.y + 8`） |
| 非锚定气泡 | 添加时间块、任务池任务编辑、默认时段编辑等随 `activeElement` 漂移 | 任务池任务编辑锚到**卡片**、默认时段编辑锚到**列表行／添加入口**；确无锚点的模态改为水平居中回退，不再落 `(12,12)` |
| 「显示 ⋯」气泡 | 时间块入口 + 吸附开关 + Alt 提示，风格与其它动作气泡不一致 | 只剩吸附一行（图标＋文案＋开／关），44px 行高、统一内边距／圆角／`--shadow-float`；**月视图不渲染触发按钮** |
| 添加入口 | 「显示 ⋯」里有时间块；空白气泡的任务列表无筛选／搜索 | 时间块只在空白气泡内联创建；「从任务池安排」是**项目筛选 + 任务搜索**面板，复用任务池行语义 |
| 原生时间控件 | `TimeBlockEditor`、`SessionEditPopover`、`ContinueScheduleDialog` 共 4 个 `input[type=time]` | 全部换 `TimeField`；开始／结束同一行；时间块补 30／45／60／90／120 分钟 chips |
| 全仓时间输入 | 4 处 | `grep -rn 'type="time"\|input\[type=time\]' src e2e` → **零命中** |
| 周视图详情面板 | `CalendarDateDetails` 常驻右侧且**没有关闭途径** | **移除**；日期头／空白单击／全天 chip 一律跳日视图 |
| 月视图详情 | 无关闭途径 | header 关闭 X、`Esc`、同格 toggle 三条出口；「另外 N 项」始终打开 |
| 测试 | Vitest 419（按 HEAD 声明数）／Playwright 62 | **Vitest 426／Playwright 62／Rust 48**，`npm run check` 四步全绿 |

## 2. 锚点修法：选了「集中修」而不是逐个传 1×1

### 2.1 改法

`src/components/ui/floating-panel.tsx` 的 `place()`：

- 新增 `isPointAnchor(rect)`：**只要 `width`／`height`／`left`／`top` 任一非零就是有效锚点**。松手点那种 `DOMRect(x, y, 0, 0)` 因此成为有效点锚点；默认构造的 `DOMRect(0,0,0,0)` 与断开连接元素的 rect 仍然是「无锚点」。
- `trigger` 回退**排除 `body`／`documentElement`**：它们的矩形是整个视口，正是 #5 把气泡钳到左上角的根因。
- 无锚点时仍保持水平居中、`top = 56px` 的回退，不再出现 `(12,12)`。

选择这条而不是只把 `blankAnchor` 改成 1×1 的理由：所有「只有坐标」的调用点都能一次受益，且不影响既有的拖拽决策气泡（它传 1×1，`isPointAnchor` 照样为真，不会被二次放大；`top` 仍是 `y + 8`，与 1×1 的 `bottom` 相同）。若只改调用点，未来任何新的点锚点都会再次踩同一个坑。

### 2.2 全量调用点核对

`FloatingPanel` 的全部挂载点（改后）：

| 位置 | 锚点 | 结论 |
| --- | --- | --- |
| `App.tsx` 截止／回顾共用的任务编辑气泡 | `taskEditorAnchor.anchorElement` | 实元素，不变 |
| `App.tsx` 拖拽决策气泡 | `dragDecisionAnchor()`（落点框或 1×1） | 1×1 仍有效，无双重放大 |
| `TaskPool` 新建习惯 | `habitAnchor`（触发按钮 rect） | 实矩形，不变 |
| `TaskPool` 进度编辑 | `progressEdit.anchor` | 实元素，不变 |
| `TaskPool` 任务编辑 | **`editing.anchor`（卡片）** | 本包从无锚点改为锚卡片 |
| `CalendarPage` 「显示 ⋯」 | `moreAnchor`（触发按钮） | 不变 |
| `CalendarDay` 空白气泡 | `blankAnchor`（松手点 0×0） | **集中修后成为点锚点** |
| `CalendarSession` 待回顾操作 | `articleRef.current` | 实元素，不变 |
| `SessionEditPopover` | `anchorElement`（铅笔按钮） | 不变 |
| 项目导入菜单／项目编辑 | `importMenuAnchor`／`projectEditAnchor` | 实元素，不变 |
| 项目新建／里程碑表单／自动排程（无锚点） | 无 | 回退到 `activeElement`（触发按钮）；`body` 已被排除，最坏是水平居中 + 56px |
| 里程碑删除 | `milestoneDelete.anchor` | 实元素，不变 |
| 默认时段编辑 | **`slotAnchor`（列表行或「添加时段」按钮）** | 本包从无锚点改为锚行 |
| `TimeField` 自身的时间滚轮 | `buttonRef.current` | 实元素，不变 |
| 原「添加时间块」浮层 | — | 已删除（时间块改内联） |

## 3. 「显示 ⋯」重做与添加入口（#8／#12，D15）

- 删除「时间块」入口；`moreTrigger` 只在 `calendarView !== "month"` 时渲染。日／周气泡内容为一行吸附项（`Magnet` 图标 + 「吸附」+ 当前说明 + 「开／关」状态胶囊），底部保留 Alt 提示；可访问名仍是 `吸附 15 分钟`／`吸附已关闭`，`aria-pressed` 不变。
- 时间块统一从空白拖选气泡的「时间块」进入：表单预填拖选出的日期与起止时间，包含标题、日期、`TimeField` 起止与时长 chips；取消返回气泡菜单，提交走既有 `onCreateBlock`。
- 「从任务池安排」面板：搜索框（`role=searchbox`，`aria-label="搜索任务"`）+ 项目筛选 chips（全部／独立任务／各项目，44px 命中）+ 列表行（标题 + 项目 · 时长）。筛选只作用于 `status=active && kind!=="habit"` 的候选；选中一行调用既有 `onSchedule(task, date, start)`，不新增提交路径。
- 面板仍由 `FloatingPanel kind="action"` 承载：`Esc`、外部点击关闭；锚点是松手点。

## 4. 时间编辑 GUI 统一（#6）

| 表单 | 改前 | 改后 |
| --- | --- | --- |
| `TimeBlockEditor` | 原生 date + 2×原生 time，单行 5 列 | 单列：标题／日期／`.time-row`（`TimeField` 开始·至·结束）／时长 chips／提交 |
| `SessionEditPopover` | 原生 date + `.time-inputs` 两个原生 time | 原生 date + `.time-row`（两个 `TimeField`），校验与提交不变 |
| `ContinueScheduleDialog` | 原生 date + 原生 time | 原生 date + `TimeField`（`.continue-schedule-fields`） |
| `DefaultTimeSlotEditor` | `TimeField` + `.time-row` + chips（样板） | 未改，`.time-row` 提升为全局共享样式 |
| `HabitEditor` | `TimeField` | 未改 |

- 时长 chips 抽到共享常量 `SLOT_DURATION_CHOICES`，新增 45 分档，默认时段与时间块共用。
- 日期控件按开工提示允许保留原生 `input[type=date]`，补充 `width: 100%` 与表单内标签间距；边框／圆角／焦点环沿用全局 `input` token。
- `grep -rn 'type="time"\|input\[type=time\]' src e2e` → **零命中**（原 `time-picker.tsx` 的说明注释与两处测试选择器也已改写为不依赖该字符串）。
- 已知行为变化：`TimeField` 的分钟滚轮是 5 分钟一档（旧数据里的 21:07 会保留在选项中），因此会话精确编辑新建的值按 5 分钟步进。原测试的 `13:07／14:19` 改写为 `13:05／14:20`，仍覆盖「不吸附、可跨午夜」。

## 5. 周视图收敛（#11／#13，D17）

| 表面 | 改前 | 改后 |
| --- | --- | --- |
| 日期头单击 | 选中该列 + 右侧详情；列描边 | **进入该日日视图** |
| 日期头双击 | 进入日视图 | 不再需要（单击即达） |
| 日期头 `Enter` | 只选中 | **进入日视图** |
| 日期头「打开日视图」角标 | 独立按钮 | 删除（整块日期头就是入口） |
| 空白格单击（无拖动） | 打开 30 分钟空白气泡 | **进入该日日视图** |
| 空白格拖选 | 打开预填气泡 | 不变 |
| 空白格键盘 `Enter` | 打开气泡 | 不变（保留无指针的创建通道） |
| 全天组 chip | 打开该日标记名单浮层 | **进入该日日视图** |
| 全天「+N」chip | 打开名单浮层 | **进入该日日视图** |
| 右侧 `CalendarDateDetails` | 常驻、无法关闭 | 周视图移除 |
| `.week-calendar-layout.with-detail`／1162px 侧栏／周列让位 | 存在 | 删除 |
| 周列选中描边 / `aria-current` | 存在 | 删除（周视图无选中态） |

- 标记名单浮层（`week-all-day-panel`）随 chip 语义一起删除；每条标记的完整文字仍在该 chip 的 `title` 与 `aria-label` 里。需要逐条查看任务／项目详情时走月视图日期详情（月格标记按钮保留）。
- 月视图：`CalendarDateDetails` 增加 `onClose`；header 关闭 X（44px 命中）、`Esc`（仅在浮层栈为空时监听，避免与气泡抢键）、再次点击同一格均可关闭。「另外 N 项」通过独立的 `onOpenDate` 打开，不参与同格 toggle。
- 月视图详情仍保留「打开日视图」。

## 6. 验证

### 6.1 `npm run check`

2026-10-27 最终树四步全绿：

- `tsc --noEmit && vite build` 通过；
- Vitest **426/29**（`App.test.tsx` 137 → 144，净增 7 条：空白单击跳日视图、任务池便捷面板、月溢出始终打开、周全天 chip／日期头跳转等；另有 6 条旧用例改写。开工提示与 C1 记录写的是 422，但 HEAD 的 `App.test.tsx` 声明数为 137，按此推算 C1 实际为 **419**，以本次全量运行的实测 426 为准）；
- Playwright **62/62**；
- Rust **48/48**。

附注：同日在 PowerShell 里单独跑 `npx vitest run` 曾有一次「B 站分 P 预览」找不到 `region`（426 条里 1 红），同命令随即重跑 **426/426** 全绿；该用例不在本包改动面内，按既有的时序敏感项记录，不作为 C2 回归。

### 6.2 组件测试

新增／改写的关键用例：

- 空白气泡 `style.left === "240px"`、`style.top === "608px"`（松手点 240/600 + 8），直接钉住 #5。
- 周视图日期头 / 空白单击 / 全天 chip 进入日视图，且 `.calendar-date-details` 数量为 0。
- 周视图键盘：日期头 `Enter` 进日视图；网格 `Enter` 仍打开空白气泡。
- 月视图：X、`Esc`、同格 toggle 三种关闭；「另外 N 项」在同格已选中时仍打开。
- 任务池面板：项目筛选、标题搜索、空结果、选中落库（`createExecutionSession`，10:00）。
- 时间块：从空白气泡创建，`TimeField` 起止 + 45 分 chip，落库 `10:00–11:30`。
- 会话编辑：`13:05／14:20` 与跨午夜 `23:00／01:00` 均通过滚轮选择。
- 显示气泡：无时间块入口、月视图无触发按钮。

### 6.3 截图（headless，生产构建，固定时钟 `2026-08-05T12:00`，单 browser，`finally` 清理）

`output/2026-10-27_calendar-c2/` 共 12 张，逐张用读图核对：

| 截图 | 视口 / 缩放 | 检查结论 |
| --- | --- | --- |
| `blank-bubble-day-a` / `blank-bubble-day-b` | 1280×900 / 100% | 气泡分别贴在两处松手点下方 8px；无 12,12 左上角回退；范围预览与气泡不重叠 |
| `calendar-more-reworked` | 1280×900 / 100% | 单行吸附项 + 开状态胶囊 + Alt 提示；44px 行高、与其它动作气泡同一圆角/阴影 |
| `time-block-inline-timefield` | 1280×900 / 100% | 时间块内联表单：标题/日期/开始·至·结束/5 枚时长 chip/共 45 分钟；无原生时间控件 |
| `session-edit-timefield` | 1280×900 / 100% | 日期 + 开始·至·结束同一行；按钮名与读数正确 |
| `continue-schedule-timefield` | 1280×900 / 100% | 日期 + `TimeField` 开始；弹窗内无原生时间控件 |
| `pool-picker-all` | 1280×900 / 100% | 搜索框 + 全部/独立任务/毕业设计/阅读计划 chips + 4 行任务，行高 44px |
| `pool-picker-filtered` | 1280×900 / 100% | 选中「毕业设计」+ 搜索「论」后只剩「写论文」；`aria-pressed` 实测 `全部=false / 毕业设计=true` |
| `week-before-jump` / `day-after-jump` | 1280×900 / 100% | 周视图（无右侧详情、无列选中描边）→ 单击日期头 → 8月5日日视图 |
| `month-detail-close` / `month-detail-closed` | 1280×900 / 100% | 详情 header 有「打开日视图」+ 关闭 X；关闭后七列恢复、无详情 |

headless 限制：本包不涉及滚动条或 OS 级窗口行为，没有打开 headed 浏览器。截图只证明布局与可读性，审美结论留给用户。

### 6.4 锚点实测读数

`shots.json`：

| 场景 | 松手点 | 气泡左上角 | 差值 |
| --- | --- | --- | --- |
| 日视图 A | (411.24, 470.80) | (411.23, 478.80) | (0, +8) |
| 日视图 B | (676.20, 612.80) | (676.19, 620.80) | (0, +8) |
| 周视图 | (206.55, 428.20) | (206.55, 436.19) | (0, +8) |

## 7. 未收口项与边界

1. **周视图全天标记的二级名单被移除**：这是 D17「全天 chip 单击一律跳日视图」的直接后果。标记的完整文字仍在 chip 的 `title`／`aria-label`，逐条详情改从月视图日期详情查看。若日后需要周内逐条查看，应在日视图补一条「全天标记」带，而不是恢复右侧详情。
2. **周视图空白单击不再创建 30 分钟气泡**：要创建仍可拖选（≥1 格）或先进入日视图。键盘 `Enter` 保留创建通道，避免无指针用户失去入口。
3. **`TimeField` 分钟粒度为 5 分钟**：旧数据里的非 5 分钟值会出现在分钟选项里，但新选择步进 5 分钟。这是既有共享控件的口径，本包不扩其范围。
4. **会话编辑的日期仍是原生 `input[type=date]`**：开工提示允许；外观已与表单一致。若后续统一到自绘 `DateField`，需同步改三处测试的可访问名。
5. **任务池面板行**复用了任务池的标题＋元信息语义，但没有复制进度胶囊与编辑按钮（面板里选任务即安排，不需要第二套动作）。
6. **月视图同格 toggle 与「另外 N 项」**：后者已改为始终打开；日期格本体仍是 toggle。点击标记按钮（task/project）始终打开对应详情，不 toggle。

## 8. 回退方法

本包没有数据模型、迁移、设置字段名或备份格式改动。回退源码：

```powershell
git diff -- src/components/ui/floating-panel.tsx src/App.tsx src/App.test.tsx src/styles.css e2e/phase1.spec.ts e2e/gui-optimization.spec.ts
```

按 hunk 撤回：

- `floating-panel.tsx`：`isPointAnchor` 与 `body` 排除；
- `App.tsx`：`openDay`／`closeDateDetails`、`CalendarDateDetails` 的 `onClose`、`WeekDateHeaders`／`WeekAllDayArea`／`CalendarDay` 的周语义、月视图 `MonthCalendar` 的 `onOpenDate` 与 toggle、`TimeBlockEditor` 的 `initial` 与 chips、`SessionEditPopover`／`ContinueScheduleDialog` 的 `TimeField`、空白气泡的筛选面板、任务池／默认时段编辑的锚元素；
- `styles.css`：`.calendar-more-*` 重做、`.blank-task-*`、`.time-row`／`.time-block-form`、`.calendar-date-details-actions`，以及删除的 `.with-detail`／`.week-date-open`／`.week-all-day-panel*`／`.calendar-day.selected`；
- 测试：按本报告 §6.2 的清单反向恢复。

回退后重跑 `npm run check`；周详情侧栏与列选中态应恢复，空白气泡会重新落回 `(12,12)`，原生时间输入会重新出现在三个表单里。

## 9. 文档同步

- `docs/design/UI-SPEC.md`：§122 月视图无「显示 ⋯」触发、§123 气泡风格与时间块入口删除、§134 周日期头单击／Enter 进日视图且无右侧详情、§135 全天 chip 跳日视图、§136 周视图无右侧详情、§137 键盘语义、§139–140 月详情关闭与「另外 N 项」、§172 吸附气泡、§182–183 空白单击／拖选、§186 时间编辑唯一化与空白气泡添加入口。
- `docs/PROJECT-GUIDE.md`：§5 的 `App.tsx`／`styles.css` 行补 C2 结构，§11 测试库存更新为 426／62／48 并记录本包新增／改写的用例。
- 评估 §5.6 与决策 D15／D17 由总 Agent 维护，本包未重复改动。
