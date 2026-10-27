# 日历整改 C2 开工提示词：气泡定位与风格统一、时间编辑 GUI 统一、周视图详情面板收敛、添加入口重做

> 用法：整段复制到新会话作为开场提示。前置：见评估 §5.5 的 C 轮索引；决策依据 **D15**（添加入口）与 **D17**（周视图详情面板），见评估 §6。
> 本包来自**用户 2026-10-27 实测 0.1.19 的 15 条反馈**中的气泡/表单类六条（原编号 #5、#6、#8、#11、#12、#13）。C1–C4 四包相互独立；若 C1 已落地，工具行控件已并入头部第一行，选择器按新结构取。**不改拖拽状态机、不改密度与布局骨架**。

---

你在 Daymark 仓库（F:\PythonProject\Daymark）开工**日历整改 C2：把弹到左上角的「空白时段操作」气泡锚回松手点、重做「显示…」气泡、时间编辑类 GUI 全部统一到 TimeField、删掉「添加时间块」按钮并把「从任务池安排」升级成带项目筛选+任务搜索的便捷面板、周视图点击一天直接跳日视图（详情面板只留在月视图并可关闭）**。

## 先读（按顺序，不要跳过）

1. `AGENTS.md`。
2. 评估 §5.5 的 C 轮索引、§6 的 **D15、D17**。
3. `src/components/ui/floating-panel.tsx` 全文（84–115 的三级锚点回退、91 行「零尺寸矩形=无锚点」判定、166–169 portal）与 `src/components/ui/overlay-host.tsx`（Esc 栈、dismissible）。
4. `src/App.tsx`：空白拖选链路（1998–2001 的 `blankAnchor = new DOMRect(x, y, 0, 0)`、2022 预览、2023–2029 气泡三选项）、`dragDecisionAnchor` 的 1×1 兜底先例（867–874 注释）、更多气泡（1517–1523）、添加时间块面板（1524）、`TimeBlockEditor`（2391–2412，原生 `input[type=time]`）、`SessionEditPopover`（2375–2382）、`ContinueScheduleDialog`（2357）、`CalendarDateDetails`（1897–1903）及其挂载点（1511 月、1514 周）、周日期头 `onSelectDate`/`onOpenDate`（1876、1511）。
5. `src/components/ui/time-picker.tsx`（138–185 `TimeField`；8–13 注释：为什么弃用原生 time 输入）。
6. 对照样板：`DefaultTimeSlotEditor`（App.tsx:2454–2493，TimeField + `.time-row` 同行布局 + 时长快捷 chips）——本包的「统一」以它为基准。

## 现状账（改前基线，均已实测定位）

- **左上角气泡的根因**：`FloatingPanel` 把 0×0 的 `DOMRect` 判为「没有锚点」（floating-panel.tsx:91），回退到 `trigger`（挂载时的 `document.activeElement`）；日视图 `.day-track` 不带 tabIndex，松手后 activeElement 是 `body`，其 rect 全视口宽 → 面板钳到 **(12,12) 左上角**。空白拖选气泡传的正是 `DOMRect(x, y, 0, 0)`（App.tsx:2001）。仓库里已有书面先例：拖拽决策气泡用 1×1 矩形兜底（App.tsx:867–874）。
- 非锚定气泡清单：添加时间块（1524）、任务池任务编辑（1215）、默认时段编辑（3721）、空白时段操作（2023，等同非锚定）。
- `TimeBlockEditor` 用原生 `input[type=date]`/`input[type=time]`（2407–2412）；`SessionEditPopover`、`ContinueScheduleDialog` 同样原生。而 `DefaultTimeSlotEditor`、`HabitEditor` 已用 `TimeField` 滚轮 —— 同一应用两套时间控件并存。
- 「显示…」气泡（`calendar-more-panel`）：时间块入口 + 吸附开关 + Alt 提示，风格与其它 action 气泡不一致（用户原话「风格不一样而且做的不好，需要重做」）。
- `CalendarDateDetails` **没有任何关闭途径**：组件无 `onClose` prop，全仓 `setSelectedCalendarDate` 只有设值调用、从未设回 null；周视图点日期头/格子/全天 chip 都会打开它（1511/1513/1876），用户实测「弹出来的块无法关掉」。月视图同组件，用户评价「月视图里很好」→ 保留。

## 交付范围

### 1. 空白时段气泡锚定松手点（#5）

- `blankAnchor` 改为 1×1 `DOMRect(x, y, 1, 1)`（对齐 867–874 的先例），或统一改 `floating-panel.tsx` 让「零尺寸但有坐标」的矩形成为有效点锚点——**二选一，选后者时必须全量核对既有调用点**（拖拽决策气泡的 1×1 兜底不能被双重放大）。
- 顺带审计其余非锚定气泡：有触发元素的锚到触发元素（默认时段编辑锚到对应列表行；任务池任务编辑锚到卡片）；确无锚点的保持水平居中回退，但**不许再落到 (12,12)**。

### 2. 「显示…」气泡重做（#12）

- 与其它 action 气泡同一套风格：行高 ≥44px、图标+文字行、统一内边距/圆角/阴影（全部走 token），`aria-label` 不变。
- 内容变更（依 D15）：删掉「时间块」项后剩吸附开关 + Alt 提示（日/周视图）；**月视图不再有可显示内容 → 不渲染「显示…」触发按钮**。若 C1 已把触发按钮并入头部第一行，就在头部里移除。

### 3. 添加入口重做（#8，D15）

- 「显示…」气泡里的「添加时间块」按钮**删除**；时间块创建统一走空白拖选气泡的「时间块」内联表单（表单风格见第 4 条）。
- 空白拖选气泡的「从任务池安排」升级为便捷面板：**项目筛选 + 任务搜索**（复用任务池的行样式与筛选语义），选中任务即落到刚拖出的空白时段（走既有 `beginCreate`/`placeCalendarItem` 通道，不新建提交路径）。
- 面板必须锚定在松手点（第 1 条），带 Esc/外部点击关闭。

### 4. 时间编辑 GUI 统一（#6）

- `TimeBlockEditor`、`SessionEditPopover`、`ContinueScheduleDialog` 的原生 `input[type=time]` 全部换 `TimeField`；开始/结束排成 `DefaultTimeSlotEditor` 的 `.time-row` 同行样式，时间块编辑器补时长快捷 chips（30/45/60/90 分钟等，与 2485–2486 同一套）。
- 日期控件：仓库暂无自定义 date field，允许保留 `input[type=date]`，但外观必须与所在表单套件一致（边框/圆角/高度/焦点环走 token）。
- 完成后全仓 `input[type=time]` 应为**零命中**（grep 写进实施记录）。

### 5. 周视图详情面板收敛（#11 + #13，D17）

- 周视图**移除** `CalendarDateDetails`：日期头单击、格子空白单击、全天 chip 单击一律改为跳转该日的日视图（复用既有 `onOpenDate`：`calendarView: "day"` + `calendarAnchors.day`）。
- 月视图保留面板，补关闭途径：header 加关闭 X（`setSelectedCalendarDate(null)`）+ Esc 可关；再点同一格可 toggle 关闭。
- 周视图 `week-calendar-layout.with-detail` 的双列 CSS 与容器查询分支一并清理（不再有 with-detail 状态）。

## 明确不做（越界即停并回报）

- 不改拖拽状态机、吸附语义、让位/确认气泡的文案与结构（B 轮验收过的行为一条不动）。
- 不动密度、布局骨架、右下角排布（C1）；不动 now 线与卡片进度条（C3）。
- 不做月视图 F13 密度重排（后续包）。
- 不 `git commit`；开工先 `git status` 确认并**保留用户未提交修改**。

## 验证

```powershell
npm run check
```

- 截图落 `output/<今天日期>_calendar-c2/` 并**逐张看**：空白气泡锚在松手点（日视图两处不同坐标各一张）、重做后的「显示…」气泡、TimeField 化的时间块/会话编辑/继续排程三个表单、从任务池安排面板（项目筛选+搜索各一张）、周视图点击一天跳日视图的 before/after、月视图面板关闭 X。
- 组件测试：空白气泡坐标断言（anchor 生效，不再是 12,12）、周视图点日期跳日视图且**不再渲染** `calendar-date-details`、月视图 X 关闭、`grep input\[type=time\]` 零命中写进记录。既有用例里引用周视图详情面板的选择器全部同步改写，不许删断言。

## 完成定义

1. 上述判据全绿；实施记录 `docs/reports/calendar-c2-implementation.md` 写明：锚点修法选了哪条及全量调用点核对表、被统一的表单清单、周视图行为对照表、未收口项与回退方法。
2. `docs/PROJECT-GUIDE.md` 与 `docs/design/UI-SPEC.md` 合并式回写（气泡锚定规则、时间控件唯一化、周视图点击语义、添加流程）。
3. 不 `git commit`；保留工作区其它未提交修改。
