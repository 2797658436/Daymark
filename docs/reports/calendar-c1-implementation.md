# 日历整改 C1 实施记录：页头单行化、全天并排、常驻「回到现在」、右下角排布与横向滚动条

> 对应开工提示：[`calendar-c1-kickoff-prompt.md`](calendar-c1-kickoff-prompt.md)。方案基线：评估 §5.6 的 C 轮索引（原反馈 #1／#2／#9／#10／#14／#15）。本包只动页面骨架与常驻控件，**未改拖拽状态机、气泡内容与卡片进度呈现**。

## 1. 结果摘要

| 判据 | 改前（0.1.19） | 改后 |
| --- | --- | --- |
| 月／周页头行数 | 2 行（页头 34px ＋ 状态条 34px，中间 8px 间距；200% 为 68 ＋ 68） | **1 行**（50px；200% 100px，无第二条） |
| 页头控件命中高度 | 34px（200% 68px） | **≥44px**（三视图全部页头控件；探针 192 个场景最小 44） |
| 停靠任务池 + 200% 的页头 | 工具行在第二行；页头 min-content 顶宽后 1200@200 的周页头 753 / 页 658，右侧控件与网格压在任务池下 | 页头可收缩，`scrollWidth === clientWidth`；周标题 80px 省略（见 §9 第 1 条），其余全部可见 |
| 周吸顶（100% 展开） | 88px（日期头 44 ＋ 全天 44） | **88px**（不变） |
| 周吸顶（200% 收起） | **176px**（日期头 88 ＋ 全天标签行 88） | **88px**（收起态整行不渲染） |
| 「回到现在」 | 只在 `nowDirection` 非空时出现（月视图／非今天／now 已在视口内都不出现） | **日／周恒显**；月视图不加（页头已有「今天」） |
| 右下角遮挡 | 24 个「详情已打开」场景里 **5 个** 的任务池浮钮被 `CalendarDateDetails` 盖住（月 960／1040 × 100／200、月 1162@200） | **0 个**（5 个场景的 `elementFromPoint` 都命中浮钮） |
| 「回到现在」×「任务池」几何重叠 | 0（改前后都不重叠；改前是「回到现在」几乎不出现） | 0（纵向固定 8px 间距，命中高度 44） |
| 视口级横向滚动 | 日视图 40/40 个场景的 `.continuous-day-axis` **恒有 1px 横溢**；月视图 200%＋停靠任务池在 1200 宽，恢复旧 `min-width: 720px` 时视口**横溢 80px** | **0**（192 个场景，宽 960–1920 × 100–200% × 任务池开／关；反事实复测见 §6.2） |
| 空默认时段的「默认时段」按钮 | 可点；选中后非今天整天塌成 44px 折叠带 | **禁用**（`title="先在设置里添加默认时段"`）；偏好仍是默认时段时按全天渲染 |

## 2. 月／周工具行并入第一行（#15）

`src/App.tsx` 的 `CalendarPage`：

- 页头 `actions` 在视图切换与日期导航之后新增 `.calendar-header-tools`（`role="group" aria-label="日历显示选项"`）：密度三档、实际记录开关（仅周）、「显示 ⋯」。月／周不再渲染 `.calendar-toolbar`；日视图保持原两行（控件多，用户未要求）。
- 页头控件统一为 44px 命中高度：`.calendar-view-switch`／`.calendar-step-group`／`.calendar-header-tools .segmented` 为 `3.125rem`（内容盒 44px，容器多出的 6px 是分段控件的描边与内衬），文字分段与箭头按钮补 `min-width: 44px`；「实际记录」与「显示 ⋯」为 `2.75rem`。
- 空间不足时的紧凑形态（`C1` 允许的三档语义不变）：
  - 密度三档保留 `aria-label`／`title` 与 `aria-pressed`，150%／200% 只显示 `Rows4／Rows3／Rows2` 图标，100% 显示“紧凑／标准／详细”文字；图标尺寸用 `.875rem`，200% 下随根字号长大。
  - 实际记录在 150%／200% 只留勾选框（`aria-label="显示实际记录"` + `title`），命中区 `min-height: 2.75rem`、`min-width: 44px`；日期箭头按钮在 200% 固定 44px 宽，标题改用短日期写法（125% 起用短标题）。**这些缩档按缩放判断、不按窗口宽** —— 任务池停靠时 200% 的 1200 宽窗口只剩 658px 页宽，窗口媒体查询看不见这次挤压（见 §6.2 第 3 条）。200% 页头从 128px 高（折行）收到 100px 单行。
- 月／周没有第二条后，`.calendar-page` 的栅格改为两行 `auto minmax(0, 1fr)`；否则视口会落进 auto 行、撑不满高度。
- 既有 `App.test.tsx` 137 条用例**一条未删**，accessible name（“显示更多日历选项”“显示实际记录”“紧凑／标准／详细”）保持不变，因此 selector 无需批量改写；新增的三条见 §8。

## 3. 周视图全天区并入第一行（#10）

- 收起／展开状态从 `WeekAllDayArea` 上移到 `CalendarPage`（初值仍是 `preferences.scale < 200`）。`WeekDateHeaders` 的 gutter 单元格改成 `.week-date-gutter`，里面是一枚占满单元格的 `.week-all-day-toggle`（“全天”＋箭头，`aria-expanded`、`aria-controls="calendar-week-all-day"`，`title` 与 `aria-label` 为“收起／展开全天标记”，44px 命中高度）。
- `WeekAllDayArea` 只在展开时渲染 chip 行；收起时 `<section hidden>`（CSS `[hidden] { display: none }`），`aria-controls` 目标仍在 DOM 里。浮层开关（“+N”／胶囊名单）行为与 A6 相同；收起时顺带关掉打开的名单。
- 吸顶高度（`residuals.mjs` 复跑）：100% 展开 44＋44＝**88**；200% 收起 88＋0＝**88**（改前 88＋88＝**176**）。125%／150% 展开分别为 110／132（同一条 rem 规则）。
- `with-detail` 容器查询补了 `.week-all-day { min-width: 0 }`：改前它在 1162px 侧栏态仍保留 842px 下限，整行 chip 会藏到详情面板下面（见 §6）。

## 4. 「回到现在」常驻（#2）

- 渲染条件从 `nowDirection` 改为 `calendarView !== "month"`；箭头只在 `nowDirection` 有值时出现，居中时换成定位图标（纯装饰），按钮名始终是“回到现在”。
- 点击语义：锚点不是今天 → 先 `setAnchor(今天)`，等新日期渲染完成（`pendingRevealRef` 在 `useEffect` 里执行）再 `viewport.revealNow()`；锚点是今天 → 直接 `revealNow()`。不能在同一个事件里先 `revealNow()`：换日会让 hook 的 generation 递增并作废旧请求。
- 位置：绝对定位在 `.calendar-page` 右下，`bottom: calc(18px + 44px + 8px - clamp(18px, 2.5vw, 36px))`，叠在任务池浮钮上方 8px（`--floating-*` 变量在 `.calendar-page` 上声明，`workspace-main` 的底部内边距用同一 `clamp` 抵消）。
- E2E 的两条旧断言更新：M2 里“点完就消失”改为“仍然可见”；M9 的注释改为“常驻，先手动滚走再点”。`App.test.tsx` 新增“日／周可见、月不可见、非今天点击回今天”。

## 5. 空默认时段的兜底（#1）

- `defaultTimeSlots.length === 0` 时：“默认时段”按钮 `disabled`，`title="先在设置里添加默认时段"`；`aria-pressed` 仍是真实偏好（可能为 true）。
- `DayCalendarGrid` 里 `defaultsCollapsed = calendarDayMode === "defaultSlots" && defaultTimeSlots.length === 0`：时间轴按 `fullDay` 建，且不建分段映射（`activeTimeline` 为 undefined，直接 24 小时网格），整天不再塌成 44px 折叠带。**偏好值不改写**，用户补回时段后第二天自动恢复。判据只看整份列表：只有某一天没有时段（周末）仍保留原来的折叠语义，不在本包范围。
- `App.test.tsx` 新增：按钮 disabled + title + `aria-pressed` 仍为 true、`.collapsed-time-gap` 数量 0、偏好未被改写。

## 6. 右下角排布与横向滚动诊断

### 6.1 浮层排布（#14）

- 任务池浮钮：`fixed; right: 18px; bottom: 18px; height: 44px`，`z-index` 20 → **31**。
- 「回到现在」：页面内绝对定位，叠在浮钮上方 8px，`z-index` 30 → **32**。
- 层级理由：`.calendar-viewport` 的 `container-type: inline-size` 并没有建立能被 z 比较的上下文，详情面板的 `z-index: 22` 会在根上下文里压过浮钮；把两枚常驻浮钮抬到 31／32 之后，无论详情面板多长都盖不住它们。图层表已在 `src/styles.css` 的注释与 `docs/design/UI-SPEC.md` 回写。
- 月视图覆盖态（`@container (max-width: 1040px)`）的详情面板 `inset` 从 `0 0 0 auto` 改为 `0 0 var(--floating-stack-clearance) auto`，在底部让出浮钮与 8px 间距（100% 为 86–98px，随窗口内边距变化；200% 同步变大）。
- 验证：探针在 960／1040／1162／1440 × 任务池开／关 × 100%／200% 的「详情已打开」场景里用 `document.elementsFromPoint` 取浮钮中心的最上层元素 —— 改前 5 个场景最上层是 `aside.calendar-date-details`，改后 24/24 都是 `button.task-pool-toggle`；「回到现在」与浮钮的矩形在 192 个场景里零相交。

### 6.2 横向滚动（#9）

先写一次性探针（[`probe.mjs`](../../output/2026-10-27_calendar-c1/probe.mjs)）量每个场景的 `scrollWidth - clientWidth`，根因清单：

1. **日视图 1px 横溢（40/40 个日视图场景）**：`grid-template-columns` 的 `1fr` 在奇数像素容器里算出 `.5px`，`.day-track` 的 `scrollWidth` 四舍五入成 `clientWidth + 1`，`.continuous-day-axis` 因此恒有一条 1px 横向滚动条。修法只裁面板内这层亚像素外溢（`.continuous-day-panel { overflow-x: clip }`），面板本身仍按 `min-width` 参与轴的横向滚动，真正窄的配置不受影响。反事实探针把 `overflow-x` 改回 `visible` 后 1px 立即复现：`.continuous-day-axis` 量到 `scrollWidth 835 / clientWidth 834`（[`counterfactual.mjs`](../../output/2026-10-27_calendar-c1/counterfactual.mjs)）。
2. **月视图 200%＋停靠任务池**：`.month-calendar-layout` 的旧 `min-width: 720px` 不随界面缩放收缩。1200 宽窗口在 200% 且任务池停靠时，页宽 658、视口内容宽 640 —— 恢复旧值后 `.calendar-viewport` 量到 `scrollWidth 720 / clientWidth 640`，即 **80px** 横向滚动；C1 的 `calc(720px * var(--calendar-ui-factor))`（100% 不变、200% 360px）下是 `640 / 640`。月格自身的 86px 列下限仍保证可读。
3. **页头是 grid item，`min-width: auto` 会把本身顶宽（本轮验证中新发现）**：`#15` 把工具并进页头后，页头最小内容宽（200% 周视图 753px）大于页宽（1200@200% 停靠任务池时 658px），页头作为 `.calendar-page` 的 grid item 不会收缩，于是把整页列宽顶到 753 —— 日历网格与「显示 ⋯」右侧被压到任务池面板下面（改前实测：页头 746/753、页 658，周视图右侧约 50px 被裁）。修法：页头 `min-width: 0`、`.header-actions` 保持 `flex: none`、由标题承担压缩（`h1` 已有省略号，补 `title` 兜底完整范围）；同时在 150%／200% 不再按窗口宽而按缩放收成紧凑形态（密度图标、实际记录只留勾选框、200% 箭头按钮固定 44px）。改后同一场景页头、页、视口三者 `scrollWidth === clientWidth`（见 §8.3 的 `squeeze.mjs` 读数）。
4. **周详情侧栏下的全天行**：`.with-detail` 的两个容器查询只把 `.week-date-headers`／`.week-all-day` 的列改成 `minmax(0,1fr)`，没放开它们的 `min-width: 842px`；1162px 侧栏态下主列只有 732px，全天 chip 行整条藏到详情面板下面（它不会产生滚动条，因为 sticky 溢出不计入滚动区，但内容不可见）。两处都补 `.with-detail .week-all-day { min-width: 0 }`。
5. **容器查询阈值本身没有「认为够宽、内容更宽」的缺口**：1040／1162 的 `with-detail` 转换与真实内容宽在本次矩阵里一致（改前改后 `viewport` delta 均为 0），因此未动阈值。周 200% 的 74px 窄列内部横溢（A6 已裁决接受）保持不变。

改后复跑 192 个场景：`viewport`／`axis`／`documentElement` 的横向差值全部 ≤1（实测全为 0），覆盖 960／1040／1162／1200／1280／1440／1920 × 100%／125%／150%／200% × 三视图 × 任务池开／关，月／周另含选中详情的场景。

## 7. residuals 预期值变更

`output/2026-10-26_calendar-a6/residuals.mjs` 的吸顶读数随新结构更新，并加上显式断言（PASS/FAIL，失败时退出码 1）：

| 场景 | 旧预期 | 新预期 | 理由 |
| --- | --- | --- | --- |
| `res-day-1200` | 日带 44 | **44** | 未动 |
| `res-day-200` | 日带 88 | **88** | 未动 |
| `res-week-1200` | 日期 44 ＋ 全天 44 ＝ 88 | **88**（`weekAllDay: 44`） | 100% 默认展开，结构未变 |
| `res-week-200` | 日期 88 ＋ 全天 88 ＝ **176** | **88**（`weekAllDay: 0`，`hidden: true`） | 全天开关进日期头，收起态不渲染第二行 |

脚本同时把状态条的量测目标从 `.calendar-toolbar` 换成 `.calendar-toolbar ?? .calendar-header-tools`（周／月已无第二行），并量新的 `.week-all-day-toggle`（100% 57×44、200% 115×88）。复跑：溢出卡 0、轴裁切 0、日横溢 0、今日药丸 4.89、状态中心对齐（34/34 → 99/99，200% 68 → 166/166），**吸顶断言全绿**。周 200% 仍有 **21** 条窄列内部横溢，全部落在已裁决接受的 74px 列内部（`calendar-now-line` 的 96px 时间标签、宽度 93 / 容器 58 的时间块、日期头文字等；逐条清单见 [`week-overflow-list.mjs`](../../output/2026-10-27_calendar-c1/week-overflow-list.mjs)），不上升到视口级滚动条。

## 8. 验证

### 8.1 `npm run check`

最终树四步全绿：`tsc --noEmit && vite build` 通过、Vitest **422/29**（新增 3 条；29 个测试文件）、Playwright **62/62**（改 2 条、未删断言）、Rust **48/48**（2026-10-27 收口实测）。

E2E 的两处布局同步：

- M2“回到现在”不再在点击后消失（C1／#2）。
- “scheduled session can move and return to the pool”的第二次拿起：`scrollIntoViewIfNeeded` 只保证元素落在滚动口里，会把卡片顶到 88px 吸顶头后面，指针按在卡片上沿时实际点到日期头；新增 `revealBelowSticky()` 从吸顶头下方露出卡片。随后“指针停在池顶时日历不得滚动”的断言要求先把指针**横着移出日历**再竖移到池顶 —— 从日历内部横穿到池顶的那段路径本身就会合法触发上边缘滚动（页头变高 16px 后多跨入一格），不改产品行为、只让用例测它本来要测的那件事。

### 8.2 截图（headless，生产构建，固定时钟 `2026-08-05T12:00`，单 browser，`finally` 清理）

`output/2026-10-27_calendar-c1/` 共 23 张（`shots.mjs` 19、`squeeze.mjs` 3、`debug-drag.png` 1），逐张用读图核对：

| 截图 | 视口 / 缩放 | 检查结论 |
| --- | --- | --- |
| `header-day-960` / `header-week-960` / `header-month-960` | 960×640 / 100% | 月／周单行（标题＋视图＋导航＋密度＋实际记录＋显示）；日视图保留第二行；无换行、无裁切 |
| `header-day-1440` / `header-week-1440` / `header-month-1440` | 1440×800 / 100% | 同上，控件与标题留白舒展 |
| `header-week-200-960` / `header-day-200-960` | 960×640 / 200% | 单行；密度为三枚可辨识的行高图标（`aria-label` 仍为三档）；实际记录只留勾选框；标题“8/3–8/9”“8/5 周三”完整 |
| `allday-open-week-1200` / `allday-collapsed-week-1200` | 1200×800 / 100% | 展开：日期头 44＋chip 44＝88；收起：chip 行消失、吸顶回到 44，gutter 的「全天」开关状态正确 |
| `corner-week-960` | 960×640 / 100% | 「回到现在」在任务池浮钮上方 8px，两者都可见、可点 |
| `corner-month-960-detail` / `corner-month-1040-detail` | 960×640、1040×700 / 100% | 详情面板底部让出浮钮区域，任务池浮钮完整露出 |
| `corner-month-1162-detail` / `corner-week-1162-detail` | 1162×700 / 100% | 侧栏态详情不再盖住浮钮；「回到现在」浮在详情之上仍可见 |
| `corner-day-960-200` | 960×640 / 200% | 常驻浮钮与任务池均可见，日历轴无横向滚动 |
| `header-week-150-1440` | 1440×800 / 150% | 宽窗口也走 150% 的紧凑形态：密度三图标、实际记录勾选框；标题完整、无折行 |
| `header-week-200-1200-docked` / `header-month-200-1200-docked` | 1200×800 / 200%，任务池停靠 | 页头、网格、右缘控件都不再伸到任务池下面；周标题被压缩成“8/…”（见 §9 第 1 条），完整范围在 `aria-label`／`title` 与下方日期头里 |

headless 的已知限制：Chromium 用 overlay 滚动条，`::-webkit-scrollbar` 不绘制；本包不改滚动条样式，横向判据改用 `scrollWidth - clientWidth` 而不是像素截图。没有打开 headed 浏览器。

### 8.3 量测

- [`probe-before.json`](../../output/2026-10-27_calendar-c1/probe-before.json)／[`probe-after.json`](../../output/2026-10-27_calendar-c1/probe-after.json)：改前 136／改后 192 个场景的页头行数、吸顶、浮层几何与横溢读数（复跑日志在 `probe-after.txt`）。最终树汇总：`viewport`／`axis`／`document` 横溢各 **0**、页头多行 **0**、页头子项被裁 **0**、页头控件最小高度 **44**、24 个详情场景里浮钮被盖 **0**。
- [`hcheck.mjs`](../../output/2026-10-27_calendar-c1/hcheck.mjs)：三视图 × 960–1440 × 100–200% 的页头单行、控件宽度与命中高度（最小 44px）、轴横溢；最终树 48 个场景零失败（`hcheck-after.txt`）。
- [`squeeze.mjs`](../../output/2026-10-27_calendar-c1/squeeze.mjs)：任务池停靠时页头是否被顶宽 —— 逐场景量页头／页／视口／主区的 `scrollWidth` 与 `clientWidth`。修前 1200@200% 周视图页头 753 / 页 658（右侧约 50px 压在任务池下），修后 `scrollWidth === clientWidth`；1200@200% 周标题可用宽 80px、月 141px。
- [`counterfactual.mjs`](../../output/2026-10-27_calendar-c1/counterfactual.mjs)：临时恢复旧 CSS 复现 **1px** 日轴横溢（835 / 834）与月视图 1200@200% 的 **80px** 视口横溢（720 / 640）。
- [`shots.mjs`](../../output/2026-10-27_calendar-c1/shots.mjs)／[`shots.json`](../../output/2026-10-27_calendar-c1/shots.json)：截图与同帧读数。
- [`sweep-month.mjs`](../../output/2026-10-27_calendar-c1/sweep-month.mjs)／[`sweep-month-detail.mjs`](../../output/2026-10-27_calendar-c1/sweep-month-detail.mjs)／[`week-overflow-list.mjs`](../../output/2026-10-27_calendar-c1/week-overflow-list.mjs)：月视图 960–1440@100–200% 的旧／新 `min-width` 对照与周 200% 横溢逐条清单。
- [`inspect.mjs`](../../output/2026-10-27_calendar-c1/inspect.mjs)／[`inspect-day.mjs`](../../output/2026-10-27_calendar-c1/inspect-day.mjs)／[`debug-drag.mjs`](../../output/2026-10-27_calendar-c1/debug-drag.mjs)：详情侧栏、日轴 1px 与 E2E 拖拽几何的一次性诊断（保留作证据，不参与产品构建）。

## 9. 未收口项与边界

1. **1200–1280px 窗口 + 200% + 任务池停靠时的周标题被压缩**：页宽只有 658–734px，页头控件（视图 142 ＋ 日期导航 168 ＋ 工具 248）已按 44px 命中区收到最小，标题只剩 80–118px，显示成“8/…”；完整范围仍在 `aria-label` 与 `title`（悬停可见），下方的周日期头也逐列写着日期。**不再折行**是 #15 的硬约束，因此这里选择「标题省略、控件与网格不被裁」；要彻底解决需要给周页头另设第二行或缩小 200% 的导航控件，留给后续轮次。
2. **周详情侧栏（1162px 以上）的内容底边**：「回到现在」浮在详情列表之上，按钮可见可点，但会盖住侧栏底部一小段内容；D17／C2 会把周视图详情整体移除，本包不再为它重排。
3. **200% 下周日期头的“周／日号”折两行**：A6／F20⑧ 已接受，未动。
4. **周 200% 的 74px 窄列内部横溢**：A6 已裁决接受；本包只保证它不上升到视口级滚动条。
5. **任务池 200% 右栏裁切**：既有后续项，不在本包范围。
6. **月视图密度（F13）**：未动。
7. **日视图在 960@200%＋任务池停靠时标题短写法**：标题使用 `data-compact-title` 的短日期（与 200% 既有口径一致），不是裁切；完整标题仍在 `aria-label`／`title`。
8. 未 `git commit`；用户工作区的未提交修改（含 `docs/reports/calendar-evaluation-2026-10-24.md`）原样保留。

## 10. 回退方法

本包没有数据模型、迁移、设置字段名或备份格式改动。回退源码：

```powershell
git diff -- src/App.tsx src/App.test.tsx src/styles.css e2e/phase1.spec.ts docs/design/UI-SPEC.md
```

按 hunk 撤回：`App.tsx` 的页头工具行、`allDayOpen` 与两组件 props、常驻「回到现在」与 `pendingRevealRef`、空默认时段兜底、页头 `title` 兜底；`styles.css` 的 `.calendar-header-tools`、页头 44px 命中与 `min-width: 0`／`.header-actions { flex: none }`、150/200% 紧凑形态、周全天开关、`--floating-*` 与 31／32 层级、`.continuous-day-panel { overflow-x: clip }`、月视图 `--calendar-ui-factor`、`.with-detail .week-all-day`；`e2e/phase1.spec.ts` 的 `revealBelowSticky` 与“回到现在”常驻断言。回退后重跑 `npm run check` 与 `residuals.mjs`，周吸顶应回到 176（200% 收起），日轴 1px 复现，月视图 1200@200% 横溢复现，1200@200% 的周页头重新压到任务池下面（`squeeze.mjs`）。

## 11. 文档同步

- `docs/design/UI-SPEC.md`：§122 页头单行与紧凑形态、§123 日视图状态条与右下角浮钮、§125 空默认时段禁用与兜底、§134 全天开关进日期头与吸顶 88／88、§142 密度的位置、§151「回到现在」常驻语义。
- `docs/PROJECT-GUIDE.md`：§5 的 `App.tsx`／`styles.css` 行补 C1 结构，§11 测试库存更新为 422／62／48 并记录本包新增／改写的用例。
- 评估 §5.6 已由总 Agent 维护，本包未重复改动。
