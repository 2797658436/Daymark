# 日历整改 A1 实施记录：日视图「进入即现在」

- 日期：2026-10-25
- 范围：评估 `docs/reports/calendar-evaluation-2026-10-24.md` 的 **F01**，A 轮第 1 步
- 状态：代码、测试、文档已落地并通过最终验证；**未提交 Git**，不代表 A 轮已验收
- 证据：`output/2026-10-25_calendar-a1/`（探针、审计、截图、最终检查日志；gitignored）

## 1. 根因复测

### 1.1 改前基线

`node output/2026-10-24_calendar-assessment/audit.mjs` 在改前复现了评估中的数字（夹具时钟 `2026-08-05T12:00`）：

| 场景 | `firstVisibleMinute` | `lastVisibleMinute` | 可见小时 | 一天几屏 |
| --- | --- | --- | --- | --- |
| day-full-1200 | **0** | 405 | 6.75 | 2.99 |
| day-full-960 | **0** | 227 | 3.79 | 4.74 |
| day-full-200 | **0** | 181 | 3.02 | 5.59 |
| day-slots-1200 | **0** | 405 | 6.75 | 1.10 |
| week-1200 | 478 | 962 | 8.06 | 2.98 |
| week-960 | 545 | 895 | 5.83 | 4.11 |
| week-200 | 471 | 805 | 5.57 | 4.31 |

改前截图 `output/2026-10-25_calendar-a1/before/cal-day-full-1200.png` 顶部是 00:00 空网格，右下角「回到现在」常亮。

### 1.2 写入溯源

一次性探针 `output/2026-10-25_calendar-a1/rootcause.mjs` 记录了 `.continuous-day-axis` 的每次 `scrollTop` 写入与 scroll 事件（JSON 同目录 `rootcause-before-*.json`）：

- **首屏直接挂载日视图**（`lastPage=calendar`、`calendarView=day`）：只发生一次写入 `1822`（恰为 `scrollHeight 5466 / 3`，中间面板起点），首次定位**一次都没有写**；`firstVisibleMinute=0`。
- **从周视图切到日视图**：写入 `1822` → `2489` 两次，落在 12:00，正常。与评估「周视图没有三日缓冲所以正常」一致。

复测还多找到一层评估未写的根因：首屏直接挂载时，`ContinuousDayView` 的 layout effect 确实在写完后调用了 `onProgrammaticPosition()`，但此刻**父组件的 `calendarRef` 尚未挂上**（React 先跑子组件 layout effect，父级 ref 在稍后提交），`scrollerFor()` 返回 `null`，`markProgrammaticSettle(null)` 等于没有标记。随后这次写入产生的 scroll 事件被当成用户滚动，把父级刚排队的首次定位取消了。周→日切换时父级 ref 已在，标记有效，所以只有首屏直挂失败。

评估给出的两条根因仍然成立并已处理：`applyPosition` 在取不到轨道时 `return true` 会把「还没量到」当「已落地」；三日缓冲的直接写入与首次定位缺少仲裁。新增的 ref 时序问题使「三日缓冲写入必须由仲裁入口在 ref 可用之后执行」成为必要设计，而不是只把写入挪个位置。

## 2. 改动清单

| 文件:行 | 改动 |
| --- | --- |
| `src/hooks/useCalendarViewport.ts:244` | `CalendarViewportApi` 新增 `requestBufferShift(apply, onDiscard?)`，优先级 4。 |
| `src/hooks/useCalendarViewport.ts:332-340` | `cancelPending` 记录被取消的意图并调用其 `discard`，让日视图在平移被作废时复位 `shifting`／`pendingScrollOffset`。 |
| `src/hooks/useCalendarViewport.ts:378-426` | `queue` 支持 `discard`；三日缓冲与恢复／首次定位同代相遇时串成「先平移、后定位」，不再让优先级把定位作废。 |
| `src/hooks/useCalendarViewport.ts:431-451` | `requestBufferShift`：微任务里执行对齐（父级 layout effect 已跑完、generation 已递增、ref 已挂上），成功即返回；量不到轨道时退回优先级 4 队列。 |
| `src/hooks/useCalendarViewport.ts:452-468` | `applyPosition` 取不到轨道改 `return false`，保持待处理，由下一帧重试与 ResizeObserver 兜住。 |
| `src/App.tsx:1242` | `CalendarPage` 把 `viewport.requestBufferShift` 传给 `ContinuousDayView`。 |
| `src/App.tsx:1254-1291` | `ContinuousDayView` 新增 `onBufferShift`；三日缓冲的 layout effect 不再写 `scrollTop`，改为提交请求；写入后仍调用 `onProgrammaticPosition()`（语义不变），取消时复位平移状态。 |
| `src/hooks/useCalendarViewport.test.tsx:242/259` | 新增 2 条：轨道未就绪时意图保持；三日缓冲先于首次定位落地（今天→现在、非今天→首个默认时段）。 |
| `e2e/phase1.spec.ts:793` | 新增 1 条 A1 E2E：首屏直挂日视图的视口中心、周视图不退化、非今天锚点的首时段落点。 |
| `docs/PROJECT-GUIDE.md:165,486` | §4 补充三日缓冲走仲裁入口；§12 修改入口补 `requestBufferShift`。 |

没有改布局、吸顶、密度预设、工具栏、拖拽语义、`calendarTimeline` 映射、缩放范围、P4-05 写入闸门、`seedCalendarPositions`、SQLite／Tauri／设置字段，也没有新增依赖。

### 2.1 为什么平移在提交末尾落地，而不是等下一帧

第一版实现把三日缓冲完全排进优先级 4 队列（下一帧 rAF 执行）。这满足「两次写入都走仲裁」，但引入了一个真实回归：`e2e/phase1.spec.ts:42` 的「拖到下一段日期」用例在 5 次重复里 **3 次失败**（HEAD 基线 5/5 通过）。探针 `output/2026-10-25_calendar-a1/probe-drag-flake.mjs` 显示失败时落库日期是**今天**而不是明天，`scrollTop` 停在 2826／4648／1004 等「现在」位置；原因是用户（或 Playwright）点完「下一段日期」立刻开始拖拽，缓冲平移还在等下一帧，拖拽目标框先算好，随后平移把面板整体移动，松手时鼠标已在相邻一天的列上。

因此最终实现改为：**请求仍提交给同一个仲裁入口（优先级 4），但在父级 layout effect 之后的微任务里先落地**，保证它在下一帧之前完成、不会在拖拽中途移动面板；同代的恢复／首次定位继续在 rAF 里排在它之后。只有轨道仍不可测量时才退回优先级 4 队列。这样既保留「先平移、后定位」的仲裁顺序，也消除了交互中途的滚动位移。

## 3. 刻意行为变化

1. 三日缓冲的对齐写入从「子组件 layout effect 同步写」变成「微任务里由仲裁入口写」，但仍在同一提交、同一帧内完成；`onProgrammaticPosition()` 的语义不变（写入后上报，程序性滚动不写偏好），只是现在总能找到已挂载的滚动容器。
2. 取不到轨道时请求不再「成功」，而是保持待处理；`MAX_RESTORE_RETRIES` 之后由 ResizeObserver 再推，不空转 rAF。
3. 平移被更高优先级请求或 generation 变化取消时，`discard` 复位 `shifting`／`pendingScrollOffset`，避免日视图跨日判定被永久冻结。
4. 周视图、月视图的落点逻辑未改；偏好写入闸门未改。

## 4. 验证

### 4.1 `npm run check`（最终树）

- 生产构建：通过（`tsc --noEmit && vite build`）。
- Vitest：**393 / 30 文件**全绿（原 391；新增 2 条，`useCalendarViewport.test.tsx` 18 → 20）。
- Playwright：**53 / 53** 全绿（原 52；新增 A1 1 条）。
- Rust：**48 / 48** 全绿。
- 完整日志：`output/2026-10-25_calendar-a1/check-final3.log`（最终树，前台全量）。

### 4.2 audit 改前／改后

夹具时钟 `2026-08-05T12:00`，视口中心应落在 720 分钟。`firstVisibleMinute` 是「首日轨道顶部」口径，环绕它的可见窗口对称于中心。

| 场景 | 改前 first / last / 可见小时 | 改后 first / last / 可见小时 | 改后视口中心 |
| --- | --- | --- | --- |
| day-full-1200 | 0 / 405 / 6.75 | **479 / 961 / 8.03** | **720** |
| day-full-960 | 0 / 227 / 3.79 | **568 / 872 / 5.06** | **720** |
| day-full-200 | 0 / 181 / 3.02 | **592 / 849 / 4.30** | **720.5** |
| day-slots-1200 | 0 / 405 / 6.75 | 0 / 458 / 7.63 | 折叠段存在，线性 `first/last` 不具可比性；截图里 12:00 现在线与安排均可见 |
| week-1200 | 478 / 962 / 8.06 | 478 / 962 / 8.06 | 720 |
| week-960 | 545 / 895 / 5.83 | 545 / 895 / 5.83 | 720 |
| week-200 | 471 / 805 / 5.57 | 553 / 887 / 5.57（另一次复跑为 471 / 805） | 720（另一次中心 638） |

**与提示词验收区间的差异（重要）**：提示词要求 `day-full-*` 的 `firstVisibleMinute` 落在约 **630–810**。本实现按 UI-SPEC 与评估 §4 的「现在位于视野中央附近」以 `viewportRatio: 0.5` 落地，视口中心是 12:00，因此 8 小时窗口的顶部在约 08:00（479），5 小时窗口顶部在约 09:28（568），4.3 小时窗口顶部在约 09:52（592），都不在 630–810。若要让轨道顶部落在 630–810，等于把「现在」放到窗口顶部而不是中央，会与 E2E 的「视口中心 ∈ 现在 ±90」以及评估的居中目标冲突。这里按**居中**实现并如实记录；请总 Agent 确认是否要改验收口径，而不是在实现里同时满足两个互斥目标。`day-slots` 的 `firstVisibleMinute` 同样不能用于判断落点：折叠段把分钟／像素变成非线性映射。

**周视图**：100% 宽下三种窗口的落点与改前逐字节相同（478/545）。200% 下两次 audit 复跑出现 471 与 553 两个值（中心 638 / 720），同一份代码内即可复现，属于既有的 200% 测量波动，不是 A1 改动引入；本次新增的 E2E 在 100% 下守住周视图落点。

### 4.3 截图逐张检查（headless，1200×800 / 960×640 / 200%）

改后截图在 `output/2026-10-25_calendar-a1/after/`，改前备份在同目录 `before/`。

- `cal-day-full-1200`：顶部约 10:00，12:00 现在线在视野中部，09:00 / 11:00 / 13:30 / 14:00 / 19:30 的安排可见，「回到现在」不显示。
- `cal-day-full-960`：顶部约 11:00，12:00 现在线可见，11:00–11:30 与 13:30–13:45 的安排可见。
- `cal-day-full-200`：顶部约 11:00，12:00 现在线可见；工具栏仍有既有的折行与「时间块」竖排、左侧刻度被截，这是 F02／F06，属于 A2／A4 范围，本包未改。
- `cal-day-slots-1200`：默认时段模式整条时间轴基本放得下，12:00 现在线与 13:00–19:00 折叠带可见。

检查口径：顶部不再是 00:00 空网格；现在线、当天安排、吸顶日期头没有互相遮挡；文字没有被本次改动新增截断；没有新增色值、字号、圆角、阴影或间距。未改动视觉样式，因此对比度、4px 间距网格、200% 可读性沿用现有实现；200% 的既有工具栏问题和 960 下的 dense chrome 不在本包范围，未顺手修正。

### 4.4 回归红线

- `phase1.spec.ts:637` 日↔周十次不漂移：通过。
- `phase1.spec.ts:712` 日／周浏览位置跨重启恢复：通过。
- `phase1.spec.ts:910` 「回到现在」写进浏览位置：通过。
- `phase1.spec.ts:288` 午夜后打开日视图仍保持今天：通过。
- `phase1.spec.ts:462` M4 折叠边界：通过。
- `phase1.spec.ts:42` 一次拖拽安排／撤销：修复中途回归后单独重复 5 次全通过；HEAD 基线同样 5 次全通过。
- `useCalendarViewport.test.tsx` 既有 18 条与新增 2 条：20/20。
- 月视图不存坐标、进入置顶：由既有 E2E 与单测覆盖，通过。

### 4.5 反向验证

1. `useCalendarViewport.ts` 的 `if (!track) return false;` 临时改回 `return true`，只跑新增用例 ①：在「轨道可测 + ResizeObserver 再推」后 `scrollTop` 仍为 0，`waitFor` 超时失败（`src/hooks/useCalendarViewport.test.tsx:255`）。恢复 `false` 后 20/20 通过。
2. 拖拽回归：第一版「完全排到下一帧」的平移实现让 `phase1.spec.ts:42` 在 5 次重复中 3 次失败；改为「提交末尾微任务落地」后 5/5 通过。这是一次由验证抓到并修正的设计问题，不是测试放宽。
3. 过程说明：反向验证时曾用 PowerShell 重写 `useCalendarViewport.ts`，破坏了中文注释编码；随后已从 HEAD 恢复该文件并逐条重放改动，最终 `git diff` 为 61 行新增／8 行删除，文件中不再包含 U+FFFD 替换字符，全量测试在最终树上重跑。
4. 测试环境抖动：一次后台全量检查中，与本包无关的 `App.test.tsx`「项目导入连点」用例失败（`createProjectWithTasks` 未调用）；该用例单独重复 3 次全绿，随后前台全量检查 393/393 通过。按既有测试环境偶发记录，未改测试。日志保留在 `check-final.log` 供对照。

## 5. 未做与边界

- 未改布局、吸顶、密度预设、工具栏（A2／A4）。
- 未改拖拽通道、`calendarTimeline` 分钟／像素映射、缩放范围与预设。
- 未改 P4-05 的偏好写入闸门与 `seedCalendarPositions`；「回到现在／目标显露」写偏好保持原样。
- 未改 SQLite／Tauri／设置字段，未新增依赖。
- 未提交 Git；未触碰 `.workbuddy-ai/`。

## 6. 发现的不一致

1. **验收区间与居中目标冲突**：提示词要求 `firstVisibleMinute` 630–810，但 UI-SPEC／评估与 E2E 都要求「现在」在视口中央；本实现按后者，改后 three day-full 的中心均为 720，顶部落在 479/568/592。详见 §4.2。
2. **`probe.mjs` 的日视图指标失效**：它取第一个 `.day-track`（改后是前一天的面板），所以改后读数为 1442/1997、`visibleHours=0`，这不是落点退化；日视图应看 `audit.mjs` 的 `.calendar-day.today`。`day-slots` 的线性 first/last 也因折叠非线性而不可用。
3. **`ref-settings-1200` 探针场景改前改后都失败**（找不到「设置」一级标题，30s 超时），与本包无关，是既有探针／页面标题不一致，未在本包处理。
4. **工作区与提示词描述不同**：开工时 `git status` 只有未跟踪的 `.workbuddy-ai/`，没有提示词列出的 `src/App.tsx`／`src/styles.css`／`docs/design/*` 未提交修改；最近的 `e83659a` 已包含日历评估与六份 kickoff 文档。未发现需要保留的冲突改动。
5. **周 200% 的 audit 落点不稳定**：同一代码两次复跑中心分别为 638 与 720，100% 稳定；属既有测量波动，建议后续单独收口，不要用 200% 的 `firstVisibleMinute` 做 A1 的验收依据。
6. **新增的 ref 时序根因**：首屏直挂时 `onProgrammaticPosition()` 在父级 ref 挂载前调用会静默失效；本包通过「在仲裁入口的微任务里写入并上报」规避，没有改 ref 机制本身。

## 7. A2 交接点

- A2 合并页头／工具栏、改 `min-width` 后，日视图的网格起点与可用高度会变；A1 的落点用轨道几何实时计算，理论上不受影响，但必须重跑 `audit.mjs` 与新增 E2E，确认 `day-full-*` 中心仍在 720、周视图不退化。
- 不要把三日缓冲改回「等下一帧」或「子组件直接写」：前者会让「点下一段日期后立刻拖拽」再次把落点带到相邻一天（本包已实测 3/5 失败），后者会让首次定位被缓冲写入的 scroll 事件取消。
- `requestBufferShift` 的微任务时机依赖父级 layout effect 已跑完；如果 A2/A3 把 `ContinuousDayView` 的父级结构或 ref 挂载时机改掉，需要重新验证首屏直挂路径。
- A4 把 92px 双层吸顶合并为 44px 日期带后，视口内可见区域与「现在居中」的视觉位置会变化；届时应重拍 `cal-day-full-1200/960/200`，并复核 UI-SPEC 的中心预期，而不是直接沿用本包的截图。

## 8. 证据清单

- `output/2026-10-25_calendar-a1/rootcause.mjs`、`rootcause-before-direct.json`、`rootcause-before-switch.json`
- `output/2026-10-25_calendar-a1/probe-drag-flake.mjs`
- `output/2026-10-25_calendar-a1/before/`、`after/`（三张日视图 + 默认时段模式）
- `output/2026-10-25_calendar-a1/audit.json`（最终）、`audit-run1.json`（同步落地前的对照）、`measurements.json`
- `output/2026-10-25_calendar-a1/check-final3.log`（最终通过）、`check-final2.log`（前一轮通过）、`check-final.log`（含一次无关用例的偶发失败）
- 改前原始量测备份：`output/2026-10-24_calendar-assessment/audit-before-a1.json`、`measurements-before-a1.json`
