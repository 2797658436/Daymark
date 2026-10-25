# 日历整改 A2 开工提示词：页头与工具栏合并成一行 chrome

> 用法：整段复制到新会话作为开场提示。前置：A1（进入即现在）已完成并绿。方案基线见 `docs/reports/calendar-evaluation-2026-10-24.md`（下称**评估**）的 **F02、F06、F11（eyebrow 与工具栏部分）**，对应 §5.2 第 2 步。

---

你在 Daymark 仓库（F:\PythonProject\Daymark）开工**日历整改 A2：把日历页网格之前的两行 chrome（页头 6 控件 + 工具栏 8 控件）合并成一行，并修掉 200% 下的横向溢出**。本包只改页头/工具栏的 markup 与 CSS、以及网格 min-width 的单位语义；不碰网格内部、不碰拖拽、不碰数据。

## 先读（按顺序，不要跳过）

1. `AGENTS.md`（headless 优先、截图逐张看、finally 清理）。
2. 评估 §2 结构账（chrome 占比那一列）、§3 设计基准 1/2/5、§4 的 **F02、F06、F11**、§5.2 第 2 步、§5.4 验证清单、§6 的 D1（本包要为它铺路：工具栏收敛后任务池覆盖判定才看得清）。
3. `docs/design/UI-SPEC.md`「主窗口结构」「日历视图」段；**注意用户工作区里 UI-SPEC.md 有未提交修改，开工先读当前版本，回写时合并而不是覆盖**。
4. `src/App.tsx` 的 `CalendarPage`（约 1075–1224）：1210 行 `PageHeader`（eyebrow「手动排程」+ 6 控件）、1211 行 `.calendar-toolbar`（8 控件）、1212 行时间块表单槽。
5. `src/styles.css`：538 行 `.calendar-page`、564–573 行 `.calendar-toolbar` 一族、575–577 与 591 行的 `min-width: 720px / 520px`、518–522 行 `.segmented`、376–386 行任务池头紧凑档（2.125rem 的出处与理由）。
6. 对照组：`ref-projects-1200.png`／`ref-deadlines-1200.png`（一行筛选条长什么样）与 `cal-day-full-200.png`（现在折成什么样），都在 `docs/reports/calendar-evaluation-2026-10-24/` 与 `output/2026-10-24_calendar-assessment/`。

## 现状账（改前基线，probe 实测）

100%：页头 64 + 工具栏 62 = 网格前 chrome 184px（23%）；960×640：工具栏折成 115px、chrome 237px（37%）；200%：页头 110 + 工具栏 285、chrome 453px（**56.6%**），且 `workspace-main` 横向溢出（745>718）、周视图 `.calendar-viewport` 横向溢出 80px（min-width 720px 是物理 px，不随根字号走）。

## 交付范围

1. **页头**：删 eyebrow；标题直接写当前范围（日：`8月5日 周三`；周：`8月3日 — 8月9日`；月：`2026年8月`，学回顾页「标题即周期」）；右侧一组 `日/周/月` 分段 + `‹ 今天 ›`（把 1210 行的上一段/下一段/回到今天收进这一组）。日期范围不再在工具栏左侧重复写一遍（基准 3：同一句话不写两遍）。
2. **工具栏降级为视图内状态条**（不再是独立圆角卡）：左 = 仅日视图的「默认时段/全天」+ 密度三档（紧凑/标准/详细），全部用 **2.125rem 紧凑分段**；右 = 「显示实际记录」可见开关 + 一个「显示 ⋯」气泡，气泡内放**时间块**与**吸附**（含当前吸附状态文字，基准 5/21：低频收 ⋯）。气泡走既有 `FloatingPanel kind="action"` + `closeOnOutsideClick`，不要新造浮层。
3. **min-width 改逻辑像素**（F06）：`.calendar-grid`／`.week-calendar-main`／`.week-sticky-header` 的 `min-width: 720px` 与 `.continuous-day-panel` 的 `520px` 改为随根字号走的写法（如 `max(520px, 45rem)` 一档），语义=「200% 下等价于今天 100% 的 720/520 逻辑宽」。**改完必须复跑 P4-13 的遮挡用例**（min-width 变化会影响 960×200% 的布局）。
4. **测试同步**：`App.test.tsx` 与 `e2e/phase1.spec.ts`／`gui-optimization.spec.ts` 中按工具栏 aria-label/文案取按钮的用例（显示实际记录、时间块、吸附、密度、日视图模式）改到新位置；`gui-optimization.spec.ts:4` 的缩放矩阵用例复跑；导航/页头标题相关用例（若有按「日历」+eyebrow 断言的）同步。
5. **F11 的一半**：删 eyebrow 后，把日历段里 <`.75rem` 的**工具栏与状态条文字**抬到 `.75rem`（卡片与刻度文字留给 A4）。

## 明确不做（越界即停并回报）

- 不改网格内部结构、不改吸顶头（A4）、不改列宽与任务池覆盖判定（A3）。
- 不改拖拽与任何事务；不新增依赖；不改设置字段（密度/日视图模式/吸附/实际记录的偏好键名一个不动）。
- 不把「显示实际记录」也收进 ⋯（它是该开关的唯一可见入口，UI-SPEC 允许在自定义界面隐藏但必须保留替代入口——收进 ⋯ 可以，但本包先保留可见，减少回归面）。
- 不动用户未提交修改（含并行的 UI-SPEC.md 改动）。

## 必须保持（回归红线）

- 自定义界面的锁定项：视图切换、时间网格、「更多」入口不可隐藏（UI-SPEC「主窗口结构」）；「显示 ⋯」气泡里的项仍要能被设置页的常显/隐藏控制读到（若该控制按按钮 id 枚举，同步枚举）。
- 键盘路径：状态条各控件 Tab 可达、气泡 Esc 关闭且焦点归还（浮层宿主既有语义）。
- 960–1199 任务池覆盖面板机制不受影响。

## 验证

```powershell
npm run check
node output/2026-10-24_calendar-assessment/probe.mjs
```

- `measurements.json` 复测目标：所有 `cal-*` 场景 `heightBudget.toolbarRows.rows = 1`；`chromeBeforeGrid` ≤ **120px**（100% 各宽度）与 ≤ **200px**（200%）；`overflow.workspaceMain.hScroll = false` 且 `overflow.calendarViewport.hScroll = false`（含 `cal-week-200`、`cal-day-full-200`）。
- 重拍并**逐张看** `cal-day-full-1200/960/200`、`cal-week-1200/200`、`cal-month-1200`：单行不折、无横向滚动条、⋯ 气泡打开态另拍一张；落 `output/<今天日期>_calendar-a2/`。
- 960×200% 浅/深逐页 axe 与 M13 两条遮挡用例必须全绿（min-width 改动的回归面）。

## 完成定义

1. 代码 + 测试落地，`npm run check` 四步全绿。
2. 写 `docs/reports/calendar-a2-implementation.md`：改前/改后 chrome 账（对照评估 §2 表）、控件去向清单（哪个控件去了哪里）、min-width 语义说明、验证实测、反向验证（把 min-width 改回 px 应复现横溢）、未做与边界。
3. 文档同步：PROJECT-GUIDE §5 代码地图若描述工具栏结构则修正；UI-SPEC 若对工具栏按钮顺序有逐字描述则**合并式**回写（尊重用户未提交修改）。
4. 不 `git commit`；不动用户未提交内容。
5. 汇报：控件去向表、验证实测、A3 交接点（尤其任务池覆盖判定要用的「网格可用宽」怎么量）。
