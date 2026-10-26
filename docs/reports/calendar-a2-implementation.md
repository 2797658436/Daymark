# 日历整改 A2 实施记录：页头与状态条合并、min-width 逻辑像素

- 日期：2026-10-25
- 范围：评估 `docs/reports/calendar-evaluation-2026-10-24.md` 的 **F02、F06、F11（eyebrow 与工具栏文字部分）**，A 轮第 2 步
- 状态：代码、测试、文档已落地；`npm run check` 四步全绿。**未提交 Git**
- 证据：`output/2026-10-25_calendar-a2/`（探针、审计、截图、检查日志；gitignored）

## 1. 结果摘要

- 网格前 chrome：100% 由 **184px → 108px**，960 宽由 **184px**（日视图 237px）→ **108px**，200% 由 **453px → 176px**；均低于验收线 ≤120px／≤200px。
- 所有日历场景状态条 **单行**（`heightBudget.toolbarRows.rows = 1`）；`workspace-main` 与 `.calendar-viewport` 的横向溢出全部为 `false`（含 week-200、day-full-200）。
- 控件从「页头 6 + 工具栏 8」收敛为「页头 6 + 状态条 4–7 + 气泡 2」；日期范围只在页头写一次，时间块与吸附收进「显示 ⋯」。
- 200% 下页头标题自动换紧凑写法（`8/5 周三`／`8/3–8/9`），完整文本仍在 `aria-label` 中；「显示实际记录」与「显示 ⋯」在 200% 下分别缩为「实际记录」和图标，入口仍然可见、可点。
- 反向验证：只把网格下限退回旧的 px 语义，1200×800@200% 的周视图立刻复现 `720 / 640` 横向溢出；当前实现为 `640 / 640`。

## 2. 改前／改后结构账

改前数字取 2026-10-24 评估与 `audit-before-a1.json`；改后为 A2 最终树复跑 `output/2026-10-25_calendar-a2/audit.json`。`chromeBeforeGrid` = `.calendar-viewport` 顶边（含 `workspace-main` 的 24px 上内边距）。

| 场景 | 改前 页头/状态条/chrome | 改后 页头/状态条/chrome | 改后 chrome 占比 | 改后可用时间 | 改后一屏小时 |
| --- | --- | --- | --- | --- | --- |
| 日·全天 1200×800@100% | 64 / 62 / **184** | **34 / 34 / 108** | 13.5% | 564px | 7.83h |
| 日·全天 960×640@100% | 64 / 115 / **237** | **34 / 34 / 108** | 16.9% | 404px | 5.61h |
| 日·全天 1200×800@200% | 110 / 285 / **453** | **68 / 68 / 176** | 22.0% | 491px | 6.82h |
| 周 1200×800@100% | 64 / 62 / **184** | **34 / 34 / 108** | 13.5% | 534px | 7.42h |
| 周 960×640@100% | 64 / 62 / **184** | **34 / 34 / 108** | 16.9% | 374px | 5.19h |
| 周 1200×800@200% | 110 / 195 / **363** | **68 / 68 / 176** | 22.0% | 384px | 5.33h |

「可用时间」沿用审计口径：`gridHeight − stickyInsideGrid`。吸顶头未改（A4 范围）：日视图 100% 92px／200% 97px，周视图 100% 122px／200% 204px。

### 2.1 横向溢出

| 场景 | 改前 `.calendar-viewport` | 改后 | 改前 `workspace-main` | 改后 |
| --- | --- | --- | --- | --- |
| cal-week-1200 | 726 / 726（无） | 726 / 726（无） | 796 / 796（无） | 796 / 796（无） |
| cal-week-960 | 842 / 842（无） | 842 / 842（无） | 888 / 888（无） | 888 / 888（无） |
| cal-week-200 | **720 / 640（有）** | **640 / 640（无）** | 718 / 718（无） | 718 / 718（无） |
| cal-day-full-200 | 697 / 697（无） | 640 / 640（无） | **745 / 718（有）** | **718 / 718（无）** |

`workspace-main` 在 day-full-200 的改前溢出主要来自旧的页头／工具栏折行后的最小内容宽；本次把 chrome 压到单行后消失。连续日轴自身仍有 2px 的 `scrollWidth / clientWidth` 差（720/718、510/508、626/624），来源是时间块删除按钮（`.time-block-delete` 的 `scrollWidth 32 / clientWidth 20`）撑出卡片 10px，再逐层传到轴上；它不是本次 min-width 造成的，也不在评估 F06 的验收口径（验收只看 `.calendar-viewport` 与 `.workspace-main`），留给时间块／A4 之后处理。

## 3. 控件去向

| 原位置 | 原控件 | 新位置 | 说明 |
| --- | --- | --- | --- |
| 页头 eyebrow | 「手动排程」 | **删除** | 主导航已经高亮「日历」；与回顾页一致，标题即事实 |
| 工具栏左侧 | 当前日期范围文本 | **页头 h1** | 日：`8月5日 周三`；周：`8月3日 — 8月9日`；月：`2026年8月`；只在页头出现一次。200% 下显示紧凑写法，`aria-label` 保留全文 |
| 页头 | 日／周／月 | 页头右侧 `calendar-view-switch` | 仍是分段按钮，`aria-pressed` 不变 |
| 页头 | 上一段／回到今天（本周／本月）／下一段 | 页头右侧 `‹ 今天 ›` 组 | 可见文字统一为「今天」，`aria-label` 仍按视图读「回到今天／本周／本月」；上一段／下一段保留原 `aria-label` |
| 工具栏左 | 默认时段／全天 | 状态条左（仅日视图） | 2.125rem 紧凑分段 |
| 工具栏左 | 紧凑／标准／详细 | 状态条左（全部视图） | 2.125rem 紧凑分段；`aria-label="日历缩放"` 不变 |
| 工具栏右 | 显示实际记录 | 状态条右（日／周；月仍隐藏） | 仍为可见开关；`showActualRecordsControl` 的隐藏语义不变；200% 下短标签「实际记录」，checkbox 的 `aria-label` 不变 |
| 工具栏右 | 时间块 | 「显示 ⋯」气泡 | 点击后打开既有 `FloatingPanel` 时间块编辑器 |
| 工具栏右 | 磁铁（吸附） | 「显示 ⋯」气泡 | 文案直接显示当前状态（「吸附 15 分钟」／「吸附已关闭」），保留 `aria-pressed` 与 Alt 临时反转 |
| 工具栏右 | — | 「显示 ⋯」触发器（新增） | `aria-haspopup="dialog"`、`aria-expanded`；气泡走 `FloatingPanel kind="action"` + `closeOnOutsideClick`，Esc 关闭并归还焦点 |
| 工具栏下方 | `.time-block-form-slot` 空行 | **删除** | 时间块编辑器本来就是 `FloatingPanel`（portal），空行只贡献两个 8px 行距；编辑器改挂在页面末尾 |

控件总数：原 14 个（页头 6 + 工具栏 8），现页头 6 + 状态条 4–7（日 7／周 5／月 4）+ 气泡 2。设置字段名一个未改。

## 4. min-width 语义

### 4.1 实现

`CalendarPage` 在 `.calendar-page` 的内联样式里提供 `--calendar-ui-factor: 100 / preferences.scale`；`styles.css` 用它与「设计宽」相乘：

| 变量 | 设计宽 | 100% | 200% | 用途 |
| --- | --- | --- | --- | --- |
| `--calendar-min-week` | 716px | 716 | 358 | `.calendar-grid`、`.week-calendar-layout`、`.week-calendar-main`、`.week-sticky-header`、`.week-all-day` |
| `--calendar-min-day` | 500px | 500 | 250 | `.calendar-grid.day`、`.continuous-day-panel` |
| `--calendar-week-column` | 84px | 84 | 42 | `.week-date-headers`／`.week-all-day`／`.calendar-grid` 的 7 列下限 |
| `--calendar-day-column` | 400px | 400 | 200 | 日视图单列下限 |

716 = 720 − 4px、500 = 520 − 20px：前者给 1px 边框与亚像素留余量；后者要让 960×640 的 `.continuous-day-axis` 客户端宽（508px）容得下当天面板（旧的 520px 会多出 12px 横向滚动）。

### 4.2 与提示词建议的偏差（重要）

提示词与评估写的 `min-width: max(520px, 45rem)` 在本仓库的缩放模型下**方向相反**：界面缩放实现为 `document.documentElement.style.fontSize = scale%`，200% 时 `1rem = 32px`，`45rem = 1440px`，只会把 200% 的日历推得更宽；`45rem` 在 200% 的物理像素不可能「等价于今天 100% 的 720 逻辑宽」。本包按验收线（200% 下不得横向滚动）与「逻辑宽」的真实意图，改成 `设计宽 × 100/缩放` 的反比换算。反向验证见 §5.5：退回 px 后 200% 周视图立即 720/640 横溢。

### 4.3 列下限同步

只改 `min-width` 不够：`.calendar-grid` 的 `grid-template-columns` 里还有 `minmax(84px, 1fr)`，200% 下 58 + 7×84 仍会撑到 646px。因此 84px／400px 两个列下限也乘同一个 factor。月视图的 `.month-calendar-layout` 仍是旧的 720px（本次范围只点名周／日网格；月视图在 1200×200% 的实际可用宽约 1000px，未触发溢出），留给后续包一并处理。

## 5. 验证

### 5.1 `npm run check`（最终树）

- 最终树（含最后一处重复 CSS 规则清理）复跑，退出码 0，日志覆盖到这一版。
- 生产构建：通过（`tsc --noEmit && vite build`）。
- Vitest：**394 / 30 文件**全绿（新增 1 条状态条／气泡焦点用例）。
- Playwright：**53 / 53** 全绿（含 M12/M13、960×200% 浅／深 axe、缩放矩阵）。
- Rust：**48 / 48** 全绿。
- 完整日志：`output/2026-10-25_calendar-a2/check-final.log`。

### 5.2 探针复测

`probe.mjs` 与 `audit.mjs` 复制到 `output/2026-10-25_calendar-a2/` 后运行（原目录的 10-24 基线保留不动），并把等待条件从「一级标题＝日历」改成 `.calendar-page`。

- 所有 `cal-*` 场景 `toolbarRows.rows = 1`（状态条左右两组同高）。
- `chromeBeforeGrid`：100% 全部 108px；200% 176px。
- `overflow.calendarViewport.hScroll` / `overflow.workspaceMain.hScroll`：全部 false（含 `cal-week-200`、`cal-day-full-200`）。
- `cal-week-1200` 列宽仍为 94px、`cal-week-200` 82px，`clippedCount` 7／9 —— 属 F03/F07（A3），本次未改。
- `ref-settings-1200` 仍因既有的「设置」标题不一致超时；与 A1 报告记录一致，与本包无关。

### 5.3 截图逐张检查（headless）

截图在 `output/2026-10-25_calendar-a2/`，均用读图工具逐张看过：

- `cal-day-full-1200.png`：标题 `8月5日 周三`、无 eyebrow；状态条单行；顶部 09:00 起、12:00 现在线在视野中部；无横向滚动条。
- `cal-day-full-960.png`：页头与状态条仍单行；任务池保持静态侧栏；无折行、无横溢。
- `cal-day-full-200.png`：标题缩为 `8/5 周三`，视图切换与 `‹ 今天 ›` 同排；状态条左侧两段、右侧「实际记录」+ 图标入口同排；无横向滚动条。**已知既有问题**：左侧 58px 时间轴在 200% 下仍会把 `09:00` 的首字裁掉（A1 截图已存在，属 A4／后续），时间块卡片在 200% 下仍偏挤（A4）。
- `cal-week-1200.png`：标题 `8月3日 — 8月9日`；状态条只剩密度 + 实际记录 + ⋯；无横溢。列宽 94px 与卡片截断仍是 A3。
- `cal-week-200.png`：标题 `8/3–8/9`；状态条单行；无横溢。列宽 82px、全天区「收起」竖排与卡片碎字仍是 A3。
- `cal-month-1200.png`：标题 `2026年8月`；状态条只有密度 + ⋯（月视图实际记录开关按原行为隐藏）；无横溢。
- `cal-day-more-open-1200.png`：气泡锚在「显示 ⋯」下方，224px 宽，含「时间块」「吸附 15 分钟」与 Alt 提示。
- `cal-week-more-open-200.png`：气泡 448px 宽，仍在视口内；「吸附 15 分钟」项用 `aria-pressed` 的强调底。

检查项：单行不折、无横向滚动条、200% 标题／标签换紧凑写法后不截断、气泡不越出视口、按钮命中区在 100% 为 34px 紧凑档（评估基准 5 允许）。不做审美签收。

### 5.4 axe 与 M13

- `phase 4 M12 keeps the calendar page clean with session status icons and all-day markers`：通过。
- `phase 4 M12 keeps the calendar page clean with the actual-record overlay`：通过。
- `phase 4 M13 keeps the sticky calendar headers above the track content`（100%／200%，日／周／月，含遮挡命中）：通过。
- `phase 4 M13 keeps the calendar page clean with the de-emphasised plan, the actual record and the time block`（960×200% 浅／深，14 轮 axe）：通过。
- `phase 4 M12 has no automated accessibility violations on every page at 960 and 200 percent in light and dark`：通过。

### 5.5 反向验证

`output/2026-10-25_calendar-a2/reverse-minwidth.mjs` 在同一页面注入 `--calendar-min-week: 720px; --calendar-min-day: 520px; --calendar-week-column: 84px; --calendar-day-column: 400px;`：

```
control      viewport 640/640 hScroll=false  grid.minWidth=358px
px-min-width viewport 720/640 hScroll=true   grid.minWidth=720px  (1200×800@200%)
```

即：只退回旧的 px 语义就复现了评估 F06 的横向溢出；当前反比换算把它消掉。

### 5.6 文档同步（合并式）

- `docs/design/UI-SPEC.md`：日历视图新增两条（页头标题即当前范围、单行状态条的内容与位置）；周视图删去「可点击的日期范围／轻量周选择器」（本就未实现），改为标题即范围 + `‹ 今天 ›` 组；月视图同样改写；缩放入口、实际记录开关与吸附由「工具栏」改称「状态条」，吸附写明在「显示 ⋯」气泡里显示状态文案。
- `docs/PROJECT-GUIDE.md`：能力清单里的磁铁／实际记录改称状态条与「显示 ⋯」气泡；§5 的 `App.tsx` 行补 A2 的页头标题、状态条与 `--calendar-ui-factor`，`styles.css` 行补 min-width／列下限与 `2.125rem` 紧凑档。
- 只改与本次结构直接相关的句子，保留其他未提交内容（A1 的 `useCalendarViewport` 等）原样。

## 6. 过程中发现并修正的问题

1. **「显示 ⋯」触发器曾把 `event.currentTarget` 延迟到状态更新器里读**：React 在部分时序下执行更新器时 `currentTarget` 已为 null，气泡打不开（单元测试同步执行时看不出来，真实浏览器在切换视图后立即点会触发）。改为先 `const trigger = event.currentTarget` 再 `setMoreAnchor`。
2. **浮层宿主「同一提交一关一开」的边界**：同一提交里把「显示 ⋯」换成时间块编辑器时，浮层栈长度 1→1，`OverlayHostProvider` 的 context 只按 `layers.length` 记忆，新面板 mount 时拿到 `isTop=false` 后不再重渲染，`pointer-events` 停在 `none`（单元测试报「元素 pointer-events: none」）。本包没有改宿主，而是让时间块编辑器先挂上、再由 `useEffect` 收起「显示 ⋯」（栈先 1→2，再 2→1）。**后续包**若要彻底修，应让 host 的 `api` 依赖 `layers` 本身；本包试过该改法，在一个 fake-timer 用例里出现挂起，已回退，暂不扩大改动面。
3. 页头标题在 200% 下改用紧凑日期：这是提示词示例之外的一处补充，否则周标题「8月3日 — 8月9日」与 6 个控件在 1200×200% 的可读宽内无法同排；完整文本保留在 `aria-label`。

## 7. 未做与边界

- 未改网格内部、吸顶头／日期分隔条（A4）、列宽与任务池覆盖判定（A3）、拖拽与任何事务。
- 未新增依赖；设置字段（密度／日视图模式／吸附／实际记录）键名一个未改。
- 未把「显示实际记录」收进 ⋯；它在状态条上仍可见，`showActualRecordsControl` 的隐藏语义不变。
- 未改 `.month-calendar-layout` 的 720px 下限（不在本包点名的四处之内）。
- 未动用户未提交内容；开工时工作区只有 A1 的 `App.tsx`／`useCalendarViewport*`／`phase1.spec.ts`／`PROJECT-GUIDE` 改动与 `.workbuddy-ai/`，本包在它们之上继续。
- 连续日轴自身的 2px 横溢（时间块删除按钮）未修，见 §2.1。

## 8. A3 交接点

### 8.1 任务池覆盖判定要用的「网格可用宽」怎么量

- **不要**直接量当前 `.calendar-viewport` 的宽度来做「停靠还是覆盖」的判定：池子停靠时它是 726px（1200 窗口）、池子转覆盖后它会变大，判据会在「≥902」两侧来回跳，形成开合振荡。
- 应量「假想停靠后」的网格宽：`workspace-main` 内容宽 − 任务池宽（`--pool-width`，默认 320）− 分隔条 6px，再与 `902` 比较；或者量 `.calendar-page` 的可用宽并在池子已覆盖时把池宽加回来。`.calendar-viewport` 是 `container-type: inline-size`，但容器查询不能直接驱动 React 状态，停靠判定仍需要一个 `ResizeObserver`（或已有的工作区宽度测量），在**池子状态变化之外**的尺寸源上取值。
- **902 要按缩放换算**：本包已经把网格下限与列下限都改成 `设计宽 × var(--calendar-ui-factor)`。A3 若把列下限提到 112px，应写成 `--calendar-week-column: calc(112px * var(--calendar-ui-factor, 1))`，并把判据写成 `calc(902px * var(--calendar-ui-factor, 1))`；否则 200% 下 902 CSS px 会把本可停靠的池子误判为覆盖（或在 100% 与 200% 之间不一致）。用同一 factor 后，200% 的阈值是 451 CSS px，1200 窗口停靠池时约 640px 可用宽 → 可继续停靠，列宽约 83 CSS px（物理上约等于 166px，比 100% 的 94px 还宽）。
- 覆盖面板复用 960–1199 的既有机制（遮罩、Esc、焦点归还、右下浮钮），判定变化只切 `poolUsesOverlay`，不要新增第二套面板。

### 8.2 其他

- A3 改 `.calendar-grid` 列下限时，四个变量（§4.1）与 `styles.css` 的 `--calendar-min-week` 一起改；`.week-date-headers`／`.week-all-day` 用的是同一个 `--calendar-week-column`，不要漏。
- 本包保留的 `.calendar-toolbar` 仍是状态条容器；A3 若需要继续压缩状态条，请保留 `role="group"`、左右两组同高（`toolbarRows=1` 的判据）与气泡锚点。
- 任务池在 200% 下的既有溢出／截断（截图右侧面板）不在 A2 范围；A3 的覆盖判定落地后应一并复拍 1200×200% 与 960×200%。

## 9. 证据清单

- `output/2026-10-25_calendar-a2/probe.mjs`、`measurements.json`
- `output/2026-10-25_calendar-a2/audit.mjs`、`audit.json`
- `output/2026-10-25_calendar-a2/more-open.mjs`、`cal-day-more-open-1200.png`、`cal-week-more-open-200.png`
- `output/2026-10-25_calendar-a2/reverse-minwidth.mjs`
- `cal-day-full-1200/960/200.png`、`cal-day-slots-*`、`cal-week-1200/960/200.png`、`cal-month-1200/960.png`
- 最终树复跑日志：`probe-final.log`、`audit-final.log`、`more-open-final.log`、`reverse-final.log`
- `output/2026-10-25_calendar-a2/check-final.log`
- 原始 10-24 基线保持原样：`output/2026-10-24_calendar-assessment/`
