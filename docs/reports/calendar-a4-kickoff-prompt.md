# 日历整改 A4 开工提示词：日视图吸顶带、有效日折叠、密度预设与视觉对齐

> 用法：整段复制到新会话作为开场提示。前置：A1–A3 已完成并绿。方案基线见 `docs/reports/calendar-evaluation-2026-10-24.md`（下称**评估**）的 **F05、F08、F11** 与 §6 的 **D4**，对应 §5.2 第 4 步（A 轮收尾）。

---

你在 Daymark 仓库（F:\PythonProject\Daymark）开工**日历整改 A4：让日视图一屏装得下一天的有效部分，并把日历的视觉语言对齐到已优化页面**。四件事：92px 双层吸顶合并为 44px 日期带（F05）、全天模式「有效日」折叠 + 上一天吸顶带（F08）、密度预设 60/84/108（F08/D4）、日历段字号与卡片语言对齐（F11）。

## 先读（按顺序，不要跳过）

1. `AGENTS.md`。
2. 评估 §2 结构账（网格内吸顶、一屏小时数、一天=几屏三列）、§3 基准 3/9/10、§4 的 **F05、F08、F11**、§5.2 第 4 步、§5.4、§6 的 D4（**已定案**）。
3. `docs/PROJECT-GUIDE.md` §4 滚动仲裁（逻辑坐标 `{date, minute, viewportRatio}`、折叠条取中点的采样规则）、§10 **图层表三档规则**与「按容器隐藏信息有两套断点口径」、§12「修改日历滚动/浏览位置」「修改日历图层顺序」「修改日历某层配色」三条同步清单。
4. `src/App.tsx`：`ContinuousDayView`（1226–1276，三日缓冲与 `.continuous-day-separator`）、`DayCalendarGrid`（1286–1328，timeline 合成）、`CalendarTimeAxis`（1330–1336，`.day-head-spacer`）、`CalendarDay`（1396 起，`.calendar-day > header` 在 1503 行）、折叠条渲染 1529–1531。
5. `src/lib/calendarTimeline.ts` —— 默认时段合并、补集、折叠映射的分钟/像素双向映射（**不得另写一套**）。
6. `src/lib/settings.ts` 275–295 行 `CALENDAR_SCALE_RANGE`／`CALENDAR_SCALE_PRESET` 与规范化；`src/lib/settings.test.ts` 的预设恒等用例。
7. `src/styles.css`：590–593 行连续日、620–622 行 time-axis 与日期头、627 行折叠条、637–666 行卡片、图层表注释 539–561。
8. 证据图：`cal-day-full-1200.png`（00–06 空网格 + 双层吸顶）、`cal-day-slots-1200.png`（折叠形态参照）。

## 现状账（改前基线）

- 吸顶 92px/面板（分隔条 40 + 日期头 52），同一天写三遍（分隔条 `formatLongDate`、日期头周几+日号、工具栏/页头范围）；三日缓冲滚动每隔一屏重复一次。
- 全天模式一天 1728px = 2.99 屏；A1 修好落点后一屏仍只有 6.75 小时（standard 72px/h）；00:00–06:00 空网格占第一屏大半。
- 字号违规：`.66/.68/.7rem`（10.6–11.2px）多处；卡片 7px 圆角 + 强调色边条，与任务池/回顾的卡片语言不是一套。

## 交付范围

1. **44px 吸顶日期带（F05）**：合并 `.continuous-day-separator` 与 `.calendar-day > header` 为一条 44px 带：`8月5日 周三 · 今天 · 6 项安排 · 投入 2h10m`（计数与投入来自 `calendarDaySummary`／既有选择器，**不在组件里另算**）；删 `.day-head-spacer` 的双层结构，时间轴侧对齐改为同一条带的高度。「今天」药丸保留在这条带上（M13 遮挡用例盯着它）。图层表里 19/20 两档合并后仍须满足三档规则，改完跑 `elementFromPoint` 用例。
2. **有效日折叠（F08）**：全天模式下 00:00–06:00 与 23:00–24:00 在**该日无任何安排/时间块/记录时**默认折成折叠带（复用 `collapsed-time-gap` 与 `calendarTimeline` 的补集逻辑，文案 `00:00–06:00 · 0 项安排` 改为更短的 `凌晨 · 无安排`）；有安排或当前时间落入时自动展开；提供「展开整天」入口（既有 `expanded-gap` 机制）。**默认时段模式的语义不变**。
3. **上一天吸顶带（F08③）**：三日缓冲的「上一天」不再渲染完整 1728px 面板，改为 44px 吸顶带（同 §1 的带，日期为前一天）；用户向上滚过带子时才展开完整前一天（展开后保持，不回缩）。逻辑坐标采样与「折叠条取中点」规则要覆盖新带子；`useCalendarViewport.test.tsx` 补用例。
4. **密度预设（D4）**：`CALENDAR_SCALE_PRESET` day/week 改 `compact 60 / standard 84 / detailed 108`；`CALENDAR_SCALE_RANGE`（28–192）不动；旧偏好里已存的连续 scale 值不受影响（只改档位→预设的映射），`settings.test.ts` 的预设规范化/保存重载恒等用例同步。
5. **视觉对齐（F11）**：日历段可读文字 <`.75rem` 的全部抬到 `.75rem`（刻度与角标可留 `.72rem` 且带 title）；`.calendar-session` 改 10px 圆角 + `--line-soft` 描边 + 左侧 3px **分类色条**（分类色，非强调色；分类色来源与任务池色条同源）；状态图标+文字双编码保持现状。**不改全局 token 的值**；改配色前先按 PROJECT-GUIDE §12 的配色清单两主题各量一次对比度。

## 明确不做（越界即停并回报）

- 不改周视图（A3 已做）、不改 chrome（A2）、不改拖拽（B 轮）、不改月视图密度（F13）。
- 不改 `calendarTimeline` 的映射算法本身（只增加折叠段的输入）；不改滚动仲裁优先级表（A1 已动过，本包只补采样用例）。
- 不改设置字段名；「展开整天」偏好不持久化（临时展开只属当前浏览过程，UI-SPEC §129）。
- 不动用户未提交修改。

## 必须保持（回归红线）

- 图层表三档规则与 M13 两条用例（`phase1.spec.ts:1738/1837`，含 14 轮 axe）全绿。
- 折叠相关：M4（`phase1.spec.ts:462`）折叠边界与拖拽悬停展开、`calendarTimeline.test.ts` 映射可逆、浏览位置跨重启恢复（712）与「回到现在」（910）。
- 跨日拖拽、跨午夜会话的日期事实、`data-collapsed` 标记语义。
- 200% 下叠加层按 rem 逐行隐藏的两条断点（P4-13）与 `.calendar-time-block` 的 px 例外**不要顺手统一**。

## 验证

```powershell
npm run check
node output/2026-10-24_calendar-assessment/audit.mjs
node output/2026-10-24_calendar-assessment/probe.mjs
```

- `audit.json` 复测目标：`stickyInsideGrid ≤ 44`；`day-full-1200` 的 `visibleHours ≥ 8`、`scrollHeightsOfOneDay ≤ 2`；`day-full-960` 的 `visibleHours ≥ 5`；周视图数字不退化。
- 重拍并**逐张看**：`cal-day-full-1200/960/200`、`cal-day-slots-1200`、`cal-day-actual`（叠加层与新吸顶带的层级）、`cal-day-compact/detailed`（三档对照）；另拍「上一天吸顶带 + 向上滚展开」前后两张；落 `output/<今天日期>_calendar-a4/`。
- 浅/深 × 日/周/月 × 960×200% 的 axe 与 M13 遮挡全绿；分类色条两主题对比度实测写进报告。

## 完成定义

1. 代码 + 测试落地，`npm run check` 四步全绿。
2. 写 `docs/reports/calendar-a4-implementation.md`：吸顶带字段来源、有效日折叠的判定与自动展开规则、上一天带子的采样处理、预设迁移说明、配色对比度实测（浅/深）、改前/改后结构账对照、反向验证（把 `!track`/折叠判定改回旧值应复现旧现象）、未做与边界（含 F13 留给后续包）。
3. 文档同步：PROJECT-GUIDE §2 已实现能力、§4 滚动仲裁段（新带子的采样）、§8 预设值、§10 图层表若档位含义变化、§11 测试数量、§12 修改入口；UI-SPEC「日历视图」段若对吸顶/折叠有逐字描述则合并回写。
4. 不 `git commit`；不动用户未提交内容。
5. 汇报：A 轮整轮的结构账收口对照（评估 §2 表 vs 实测）、遗留项清单、B 轮开工前必须知道的交接点（哪些选择器/aria-label 变了，B 轮的 E2E 重写要按新名字找元素）。
