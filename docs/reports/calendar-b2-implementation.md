# 日历整改 B2 实施记录：拖拽统一为 pointer 单通道

> 对应开工提示 [`calendar-b2-kickoff-prompt.md`](calendar-b2-kickoff-prompt.md)。上游：[评估报告](calendar-evaluation-2026-10-24.md) 的 F04／F09／F10／F14 与 §5.3 的 B 轮验收；方案基线：D3（手写 pointer，不引入 `@dnd-kit`）、D5（中央松手按 overlap 提交）、D6（折叠只属日视图）。前一步见 [`calendar-b1-implementation.md`](calendar-b1-implementation.md)。
> 范围：**把任务池 → 日历换成同一个 pointer 状态机，清空全仓 HTML5 DnD**，并补齐 F10 前 8 条规格缺口（跨时段／跨天确认、时间块三选项、拖回池落区、重叠预演、选中浮前与同组左右键、拖拽中读数、真卡让位已由 B1 完成、折叠悬停展开只剩日视图）。多选整组拖拽按方案**不做**。

## 1. 结果摘要

| 项 | 改前（B1 结束） | 改后（B2） |
| --- | --- | --- |
| 池 → 日历 | 原生 HTML5 DnD（`TaskCard.draggable`＋`dataTransfer` 三个私有键＋`lib/calendarDrag.ts` 的影子副本） | `useDragSession` 的 `kind: "create"`（`TaskPoolRow` 的 `pointerdown`，5px 阈值后才算拾起） |
| 拖回任务池 | 只有几何判定 + 取消安排，无视觉 | `.pool-drop-zone` 落区（虚线描边 + 「移回任务池」+「只取消本次时段，保留任务与历史」），池内其余内容压淡 |
| 拖入时间块 | 时间块对 DnD 完全透明 | 时间块参与命中；预览「与时间块同时安排」；松手后三选项「仍然安排／放到时间块之后／取消」 |
| 跨默认时段／跨天 | `placeCalendarItem` 直接 commit | 松手后停在 `deciding`，锚定气泡给出受影响数量与新日期，确认才提交 |
| 重叠区预演 | 拖动中并列看不到松手后的结果 | `concurrentLayouts` 提前把虚拟时段插进去，并排／「另外 N 项」当场成立 |
| 并行组与选中 | 无选中态 | 选中卡视觉浮前（图层 12）＋同组 `←`／`→` 切换 |
| 边缘自动滚动 | `dragover` 事件里每次 4px 线性（没有 dragover 就停） | rAF 循环，二次爬升 1 → 22 px/帧，回中央立即 0，**指针不在滚动容器内一律不滚** |
| 周视图折叠死参数 | `dragExpandedGapKey` 等 4 个未接线 props | 删除；折叠与悬停展开**只属日视图**（UI-SPEC §128 回写） |
| 全仓 HTML5 DnD | 池路径 2 处 + `calendarDrag.ts` | `src/` 零（只剩完成记录气泡的**文件拖入**，与应用内排程无关） |

`npm run check` 的四步（`build` = tsc + vite／`test`／`test:e2e`／`test:native`）全绿：TypeScript 零诊断、Vite 构建通过、Vitest **414/414**（29 文件）、Playwright **60/60**、Rust **48/48**。静态视觉与 B1 的 `after/` **18 张逐字节相同**。四步的命令与实测读数见 §7。

## 2. HTML5 DnD 清除清单

### 2.1 删掉的东西

| 类型 | 内容 | 说明 |
| --- | --- | --- |
| 文件 | `src/lib/calendarDrag.ts`（71 行）、`src/lib/calendarDrag.test.ts`（41 行） | 影子副本 + 类型判定 + 抓取偏移，整份删除 |
| dataTransfer 键 | `application/x-daymark-task`、`application/x-daymark-session`、`application/x-daymark-grab` | 全仓不再出现；`dataTransfer.setData` 零命中 |
| DOM 属性 | `TaskCard`／`TaskPoolRow` 的 `draggable`、`onDragStart` | 换成 `onPointerDown` + `.is-dragging-source` |
| 事件接线 | `CalendarDay` 的 `onDragOver`／`onDragLeave`／`onDrop`、列级 `dragPreview`／`overlapTimer`／`overlapTarget`／`previewFromDrag` | 全部删除，读 `drag.preview` |
| window 兜底 | `dragend`／`drop` 上的拖拽收尾（B1 剩 2 处） | 日历与池都不再有拖拽会走它们 |
| 组件 props | `App.tsx` 里 `onMove`／`onPlace` 的拖拽版本、`onCancelSession` 的池侧入口、`dragExpandedGapKey`／`onGapDragEnter`／`onGapDragLeave`／`onClearDragExpansion`／`onRetainDragExpansion` | 前者收窄为只服务 `SessionEditPopover`；后者是周视图死参数（F14） |

### 2.2 改写的用例

| 文件 | 改动 |
| --- | --- |
| `src/App.test.tsx` | 4 条池拖拽用例改 pointer（含新增「5px 阈值之前不算拾起」）；「折叠非默认时段」改用真实 pointer + `stubRect`／`stubGap` |
| `src/hooks/useCalendarViewport.test.tsx` | `dragEdgeScrollTop` → `dragEdgeScrollVelocity`；拖拽延后那条改 `beginDrag()/endDrag()` |
| `e2e/phase1.spec.ts` | 池 → 日历、日历内移动、拖回池三条改真指针；M4 折叠整段改写；M5 改真指针 + `setViewportSize(1440, 900)`；`gui-optimization.spec.ts` 的「真原生拖拽护栏」整条删除（`dragGuard` helper 一并删） |
| 新增 E2E | 跨天／跨时段确认（取消＋确认两路）、时间块三选项、拖回池落区、边缘滚动加速单调性 |

### 2.3 grep 之后还剩什么（都要能解释）

```text
src/components/completion/completion-bubble.tsx   ← 完成记录气泡的「把图片拖进输入框」，文件拖入，不是排程
src/hooks/useCalendarViewport.ts:605-617          ← 滚动仲裁里保留的 window dragstart/drop 监听：
                                                     防的是「从窗口外拖文件进来」期间恢复请求落地，不服务排程
src/styles.css:1226                               ← 说明注释（为什么跟手卡不能有 transform 过渡）
```

`dataTransfer.setData`／`draggable`／`application/x-daymark-*` 在 `src/` 与 `e2e/` 里**零命中**。

## 3. 状态机最终契约（`src/hooks/useDragSession.tsx`）

```ts
type DragSessionPhase = "idle" | "picked" | "dragging" | "landing" | "deciding";
type DragSessionKind  = "move" | "resize" | "create";
```

B1 的三态扩到五态。`deciding` 是 B2 新增的一段：**已经松手、但要用户先拍板**。它不是提交 —— 气泡里点确认才进 `landing`，取消直接回 `idle`，**副作用一次都没发生**。这一点由「取消后数据与拖动前逐字段相同」的 E2E 钉住。

| 状态 | 事件 | 下一步 | 副作用 |
| --- | --- | --- | --- |
| `idle` | 池行 `pointerdown`（`button === 0`、任务未完成、目标不在 `button/input/select/textarea/a` 里） | `picked`（`kind: "create"`） | `setPointerCapture` + 5 个 window 监听 |
| `idle` | 卡身／手柄 `pointerdown` | `picked`（`move`／`resize`） | 同上 |
| `picked` | 位移 < 5px | `picked` | 无（池行的单击／双击／多选照常） |
| `picked` | 位移 ≥ 5px | `dragging` | `body[data-calendar-dragging]`、`viewport.beginDrag()`、清选区 |
| `dragging` | `pointermove` | `dragging` | 重算 `preview`；指针在池上时 `overPool = true` |
| `dragging` | 指针停在某张卡中央 500ms | `dragging` | `latched = true`，读数变「同时安排」 |
| `dragging` | `pointerup`，`move` 且指针在任务池 | `landing` | `onCancelSession(session)` → `finish()`（§194） |
| `dragging` | `pointerup`，`resize` | `landing` | `onResize(session, duration)` → `finish()` |
| `dragging` | `pointerup`，`buildDecision` 返回非空 | `deciding` | 记 `gesture.decision`，**不提交** |
| `dragging` | `pointerup`，其余 | `landing` | `onCommit(intent)` → `finish()` |
| `deciding` | 气泡「确认」／「仍然安排」 | `landing` | `commitIntent(decision.intent)` |
| `deciding` | 气泡「放到时间块之后」 | `landing` | `commitIntent(decision.afterIntent)`（`startMinute = 时间块结束`） |
| `deciding` | 气泡「取消」／`Escape` | `idle` | `dismissDecision()`：什么都回滚，因为什么都还没发生 |
| 任意 | `Escape`(capture)／`pointercancel`／`window.blur` | `idle` | `cancelGesture()` |

业务判断留在 App，状态机只管「要不要停一下」：

```ts
buildDecision?: (input: {
  intent: CalendarDropIntent; preview: DragSessionPreview; point: { x: number; y: number };
}) => DragDecision | null;

interface DragDecision {
  kind: "boundary" | "block";
  reason: "outside-slots" | "cross-day" | "block";
  anchor: { x: number; y: number };   // 松手时的视口坐标
  count: number;                      // 受影响时段数
  dates: string[];                    // 落到的新日期（去重升序）
  blockTitle: string;
  intent: CalendarDropIntent;         // 确认后的落点
  afterIntent: CalendarDropIntent | null;  // 「放到时间块之后」
}
```

`App.tsx` 的 `buildDragDecision` 两条分支：

1. **时间块优先**：`preview.blockId` 命中 `.calendar-time-block[data-block-id]` → `kind: "block"`，`afterIntent.startMinute` 取时间块结束分钟、`mode: "place"`。
2. **越界**：只在 `calendarView === "day" && calendarDayMode === "defaultSlots"` 时把默认时段换算成 `defaultRanges` 交给 `dropImpact`，得到 `affected`／`dates`／`reason`。**周视图与全天模式一律返回 `null`** —— 那两个视图全程可见，再问一次只会把每次插入变成两步（§191「没有跨时段的普通插入直接提交」）。

## 4. 落点、越界与滚动的纯函数

### 4.1 `dropImpact`（`src/lib/calendarPlacement.ts`）

```ts
export function dropImpact(input: {
  date: string; shifted: SessionPlacementChange[];
  defaultRanges: { start: number; end: number }[];
}): { affected: SessionPlacementChange[]; dates: string[]; reason: "outside-slots" | "cross-day" } | null;
```

判据只看**被推走的时段**：换了日期 → `cross-day`；仍同一天但整段落在所有默认时段之外 → `outside-slots`；`defaultRanges` 为空（周视图／全天模式）时只可能判出 `cross-day`。没有后移、或后移后仍在时段内 → `null`（直接提交，不打扰）。

> 实测踩到一次：链式后移里 21:00→21:30 **仍在**默认时段（19:00–22:00）内，只有 22:00 那一项真的越界，所以气泡写「会影响 **1** 项」而不是 2 项。用例断言据此改正。

### 4.2 `dragEdgeScrollVelocity`（`src/hooks/useCalendarViewport.ts`）

```ts
export function dragEdgeScrollVelocity(input: {
  clientY: number; viewportTop: number; viewportBottom: number;
  edge?: number;      // 触发带，默认 56px
  maxPerFrame?: number; // 上限，默认 22px/帧
}): number;
```

二次爬升 `1 + ratio² × (max − 1)`：贴着边缘 1px/帧、压到最深处 22px/帧；离开两条带即返回 0。调用方是 `useDragSession` 的 rAF 循环，**并且额外要求指针同时落在滚动容器的横纵矩形内**：

```ts
const insideViewport = gesture.lastX >= rect.left && gesture.lastX <= rect.right
  && gesture.lastY >= rect.top && gesture.lastY <= rect.bottom;
```

这条 gate 不是防御性代码，是实测挽救：拖到任务池上时指针常常正对着日历视口的上边缘带，只看 `clientY` 的话日历会一路滚到顶（E2E 里实测 `scrollTop` 370 → 0，松手位置与落点框对不上）。反向验证见 §7.2。

### 4.3 `sessionAtPoint` 的横轴口径（B2 修的真 bug）

B1 用**卡片自己的** `rect.left/right` 判「指针在不在这一张上」。B2 的重叠预演会把同组卡片提前分成并排半宽栏，指针停在列中央时反而落在「预览栏」之外 —— 目标卡从指针下消失，预览显示「同时安排」、松手却按 `place` 落库，**实测差 30 分钟**。

现在的口径：横向**只看整列**（`trackRect`），纵向仍读原计划几何，并在多张命中时**优先指针真压着的那一张**：

```ts
let best: { sessionId; ratio; area; onPointer } | null = null;
...
if (candidate.onPointer !== best.onPointer) { if (candidate.onPointer) best = candidate; continue; }
if (candidate.area < best.area) best = candidate;
```

## 5. 规格补齐对照（UI-SPEC「拖拽排程」段逐条）

> 行号按本轮 `docs/design/UI-SPEC.md` 现值（开工提示里的 §166–199 已漂移到 **169–201**）。✅ = B2 本轮实现或改写；▫️ = 既有行为，本轮只换载体、语义未动；❌ = 规格有要求但本轮未做（原因与后续写法见 §9）。

| 行 | 条目 | 状态 | 落点／说明 |
| --- | --- | --- | --- |
| 169 | 拖入默认 15 分钟吸附 + 实时预览 | ▫️ | `snapMinutesFor`／`preview` |
| 170 | 缩放不改吸附，5/10/15/30 可配 | ▫️ | 同源 `snapMinutes` |
| 171 | 「显示 ⋯」里的吸附项、`Alt` 反转 | ▫️ | `snapMinutesFor(snap, altKey)` |
| 172 | 跟手半透明 + 落点框另画、不矮于卡片、换格过渡 | ✅ | create 同样适用：`preview.duration` 走同一条 `min-height` |
| 173 | 空白直接放置 / 插入线 + 「插入并后移」 | ▫️ | `resolveCalendarDrop` |
| 174 | 插入悬停时真卡让位、拖出复原 | ▫️（B1） | `shifted` 摊到每张卡 + `data-yielding` |
| 175 | 中央半秒「同时安排」 | ▫️（B1＋D5） | latch 是强调路径，不再是唯一入口 |
| 176 | 边缘／中央不同落点与文案 | ▫️ | `.overlap` 实线 + `scale(.97)` |
| 177 | 并行 2–3 等宽并排 | ▫️ | `concurrentLayouts(sessions, 3)` |
| 178 | 4 项以上只显示前 2 + 「另外 N 项」 | ▫️ | 同上，上限参数化 |
| **179** | 并行组选中浮前 + 同组左右键切换 | ✅ | `.calendar-session.is-selected`（图层 12）＋ `ArrowLeft/ArrowRight` 在 `previewLayouts`／`concurrency` 的组内循环；点击与 `onFocus` 都算选中 |
| **180** | 拖入重叠区**提前预演**并排／折叠结果 | ✅ | 把虚拟 session `__drag-preview__` 插进 `concurrentLayouts` 再渲染 |
| 181 | 空白 `＋` 与三入口气泡 | ▫️ | 既有 |
| 182 | 空白纵向框选 | ▫️ | 既有 |
| 183 | 空白不绑双击 | ▫️ | 既有 |
| 184 | 多选任务点空白批量排入 | ▫️ | 既有（与拖拽无关的那条路径） |
| 185–187 | 时间块字段 / 转任务 / 自动排程视为不可用 | ▫️ | 既有 |
| **188** | 拖入时间块中央：「与时间块同时安排」+ 三选项 | ✅ | `preview.blockId`；落点框改用点线 `.block-overlap`；气泡「仍然安排／放到时间块之后／取消」 |
| **189** | 「仍然安排」只覆盖本次；**改时长侵入时间块沿用同样确认** | ✅／❌ | 前半实现（一次落点一个决策，不写规则）；**后半未做**，见 §9 第 1 条 |
| **190** | 插入越出默认时段：预览 + 锚定气泡（数量 + 新日期），确认才提交 | ✅ | `dropImpact` + `deciding`；气泡文案「会影响 N 项已有安排／它们会被推出默认时段／会被推到 X」 |
| **191** | 取消确认全部复原；普通插入直接提交 | ✅ | `dismissDecision()` 零副作用；`buildDecision` 返回 `null` 即直提 |
| 192–193 | 5 秒撤销提示、悬停暂停计时 | ▫️ | 既有（一次拖拽 = 一个撤销项） |
| **194** | 拖回任务池：落区 + 只取消本次时段 + 同样撤销 | ✅ | `.pool-drop-zone`；松手走 `onCancelSession` |
| 195 | 右键「取消本次安排」/「取消全部未来安排」 | ▫️ | 既有 |
| 196 | 拖底边改时长 | ▫️（B1） | `kind: "resize"` |
| **197** | 向下拉长让位 + 跨默认时段／跨天用小气泡确认 | ▫️／❌ | 让位与 B1 一致；**resize 不产生 `shifted`、也不弹气泡**，见 §9 第 1 条 |
| 198 | 向上缩短只释放空档 | ▫️ | 既有 |
| 199 | 可直接编辑精确分钟 | ▫️ | `SessionEditPopover` |
| **200** | 靠近顶部／底部自动滚动，越近越快，回中央立即停 | ✅ | rAF + `dragEdgeScrollVelocity`；E2E 用单调性断言（上／下两带各三点 + 中央 = 0） |
| **201** | 跨午夜时日期带 + 落点框承担日期归属 | ✅ | `.calendar-day-band.is-drag-target`（`data-drag-target`）随 `drag.preview.date` 高亮 |

同轮回写的一条相邻规格：**UI-SPEC §128 的「拖动任务悬停在折叠条约半秒自动展开」加上了「只适用于日视图」**（周视图没有折叠条，原来那段代码是死路径，F14）。

## 6. 视觉细节

- **落区**：`.pool-drop-zone` 铺满整个任务池（`position: absolute; inset: 0`），虚线 2px 描边 + 极淡 `--accent-soft` 底，中间是图标 + 「移回任务池」+ 一行副文案；`.task-pool.is-drop-target > *:not(.pool-drop-zone)` 压淡到 0.25。截图见 `output/2026-10-26_calendar-b2/pool-drop-zone.png`。
- **确认气泡**：`FloatingPanel kind="action"`，`label` 是「越界确认」或「重叠确认」。锚点由 `dragDecisionAnchor(decision)` 给：优先取 `.calendar-drag-preview` 的矩形（贴着落点框），没有落点框时退回 1×1 的 `DOMRect`。**这一步是必需的** —— `FloatingPanel` 把「零尺寸锚点」当作「没有锚点」，会退回 `activeElement`，实测把气泡甩到任务池里（偏 340px）。
- **选中浮前**：图层表新增一档 **12**（并行组选中卡），低于 22 的覆盖详情面板、高于 0–10 的轨道内容；吸顶层 20 与临时层 24／34／35 不动。
- **日期带高亮**：`CalendarDayBand` 收一个 `dragging` 布尔，渲染 `.is-drag-target` + `data-drag-target`，由 `ContinuousDayView` 用 `drag.preview?.date` 算 —— 跨午夜时看带子就知道会落到哪天。
- **文本选择**：拖拽期间 `body[data-calendar-dragging]` → `user-select: none` + `cursor: grabbing`，并在进入 `picked` 时清一次已有选区。这一条 B1 只写了清理端、没有设置端，B2 补上（否则从日历横穿到任务池会把整页文字框成蓝色，截图里抓到过）。

## 7. 验证实测

命令与结果（本机 Windows，PowerShell）：

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `node <隔离>/typescript/bin/tsc -p tsconfig.json --noEmit` | **零诊断** |
| 生产构建 | `node node_modules/vite/bin/vite build` | 通过，`dist/assets/index-IpadYQet.js` 584 kB（gzip 168.8 kB）/ `index-Yl352Tq1.css` |
| 组件测试 | `npx vitest run` | **414/414**，29 个文件，78.9s |
| E2E | `node scripts/run-e2e.mjs --workers=1` | **60/60**，1 worker，4.8min |
| Rust | `npm run test:native` | **48/48** |
| 静态视觉 | `node output/2026-10-24_calendar-assessment/probe.mjs` | 与 B1 的 `after/` **18 张逐字节相同** |

> 960×200% 的浅／深色 axe 与 M13 的两条（吸顶层不被轨道内容盖住、去强调计划＋实际记录＋时间块）都在 60 条 E2E 里，本轮全绿。probe 的最后一帧 `ref-settings-1200` 仍会超时（等待「设置」一级标题 30s），这是**既有**探针问题（B1 那次同样超时，该帧不在 B1 的 `after/` 里），不影响 18 张的比对。

### 7.1 B2 新增／改写的 E2E

| 用例 | 断言要点 |
| --- | --- |
| `calendar B2 asks before an insertion pushes a session out of the default slots` | 取消分支：气泡出现 → 点取消 → **三条 session 的 `startLocal` 与拖动前逐字段相同**；确认分支：同一手势 → 确认 → 后移真的落库（21:30／22:00） |
| `calendar B2 offers three options when a drop lands on a time block` | 落点框带「与时间块同时安排」；三个按钮都在；选「放到时间块之后」→ 落库 `startLocal` = 时间块结束 |
| `calendar B2 auto-scrolls while the pointer sits in the edge band and stops in the middle` | 上带／下带各取三个深度点，位移**严格单调**；指针回中央后 `scrollTop` 停止变化 |
| `scheduled session can move and return to the pool…`（改写） | 落区 `.pool-drop-zone` 可见且文案两段都在；**拖到池子顶部时 `scrollTop` 不变**（这条是 §4.2 那条 gate 的护栏） |
| `phase 3 M4 folds…`（改写） | 悬停折叠条 → 半秒内仍折叠 → 展开 → 拖离复原 → 落入后「落库 = 拖动中的读数」 |

### 7.2 反向验证（两条，都红过）

1. **去掉 rAF 的 `insideViewport` gate**（改成 `const insideViewport = true`），跑 `-g "return to the pool"`：

   ```text
   Expected: 370   Received: 0
   > 209 |  expect(await page.locator(".calendar-viewport").evaluate((el) => el.scrollTop)).toBe(beforeScroll);
   ```

   日历被一路滚到顶。把 gate 还原后同一条通过 —— 说明这条断言真的绑在实现上，而不是「落区出现就算过」。

2. **把 `sessionAtPoint` 的横轴改回「按卡片矩形判」**（补一行 `if (x < rect.left || x > rect.right) continue;`），跑 `-g "centre release overlaps"`：

   ```text
   Expected: "10:00"   Received: "10:30"
   > 436 |  await expect.poll(… "insert-source" …)?.startLocal).toBe("10:00");
   ```

   精确复现了 B2 中途抓到的那个 30 分钟偏差（预览说「同时安排」、松手按 `place` 落库）。还原后通过。

### 7.3 视觉证据（`output/2026-10-26_calendar-b2/`）

静态外观由 `output/2026-10-24_calendar-assessment/probe.mjs` 复拍并与 B1 的 `after/` 逐字节比对（本目录的 `probe/` 是那一轮的产物）。静态截图看不到的三帧由 `drag-probe.mjs` 拍（生产构建 + `vite preview` + 固定时钟，只写 `localStorage`）：

| 文件 | 看什么 |
| --- | --- |
| `pool-drag-preview.png` | 池行变淡（`.is-dragging-source`）＋ 10:30 的虚线落点框 ＋ 黑底读数「10:30–11:30 · 60 分钟」＋「悬停 0.5 秒以同时安排」 |
| `pool-drag-preview-crop.png` | 上面那块落点的近景（标签压在「已有安排」卡上，这是重叠预演的预期叠放） |
| `pool-drop-zone.png` / `-crop.png` | 拖动日历卡片悬停任务池：整块池子变虚线落区 ＋ 图标 ＋「移回任务池」＋「只取消本次时段，保留任务与历史」，池内其余内容压淡 |
| `boundary-confirm.png` | 越出默认时段后：落点框「插入并后移」＋ 气泡「会影响 1 项已有安排／它们会被推出默认时段」＋ 确认／取消，气泡贴着落点框 |

四张都逐张看过。`pool-drop-zone.png` 第一版把日历卡片放在 10:00，那一段正被 sticky 日期带盖住，`pointerdown` 落在表头单元格上、落区根本没出现 —— 探针改成 14:00 之后正常，注释写在脚本里。

## 8. 偏离与顺带修复

1. **图层表加一档 12**（并行组选中卡）。改动很小但属于「改图层数值」，按规矩在 `styles.css` 的图层表里写清位置（0–10 轨道内容 / **12 选中卡** / 20 吸顶 / 22 覆盖详情 / 24–35 临时层），三条硬关系（吸顶 > 轨道、临时 > 吸顶、选中卡在两者之间）都未变。
2. **`sessionAtPoint` 横轴口径**（§4.3）：B1 的写法在 B2 的重叠预演下会分叉，属于 B1 遗留的真实缺陷。
3. **`dragDecisionAnchor`**：`FloatingPanel` 把零尺寸锚点当无锚点，气泡会跑到 `activeElement` 旁边。
4. **rAF 的容器 gate**（§4.2）：不看 `clientX/clientY` 两者的实现会让「拖到池子上」变成「一路滚到顶」。
5. **`body[data-calendar-dragging]` 只写了清理端**（B1）：补齐设置端并清选区。
6. **M5 用例里 `boundingBox()` 的陷阱**：插入预览会把目标卡真推下去 48px，重新量再对齐会把指针送到「目标卡之后」变成 11:00 插入。命中判定读的是原计划几何，**指针本来就该留在原位** —— 用例已按这条改正，注释写在现场。
7. **M4／M5 两条用例对边缘滚动零容忍**：M4 的「不足半秒仍折叠」曾用 `steps: 6` + `waitForTimeout(300)`，慢机器上 6 步移动就能吃掉 300ms，直接越过 500ms 阈值；M5 的落点贴着卡片上沿 1px，滚动一帧（22px）就滑出命中范围。现分别改成「一步到位 + 立刻断言」与「先把目标卡滚到视口中部」，**断言的验收点一个没放宽**。

## 9. 遗留

1. **改时长（resize）不走 `buildDecision`**。`useDragSession` 在 `pointerup` 时对 `kind === "resize"` 提前返回，`computePreview` 对 resize 也只返回 `shifted: []`。因此 UI-SPEC §189 后半（「调整任务时长而侵入时间块时沿用相同确认」）与 §197（「向下拉长若产生跨默认时段或跨天，用同样的预览与小气泡确认」）**未实现**，resize 也不会推动后续任务。这是 B1 就存在的边界，B2 的范围是「插入路径」，没有扩到 resize；补的话要把 `resolveCalendarDrop` 的 `shifted` 计算搬进 resize 分支，并给 `buildDecision` 加一条 `kind: "resize"` 的入参。
2. **多选整组拖拽**（§184 的批量预览与 F10 末条）按方案不做。状态机留了位置：`DragSessionSource` 是单对象（`sessionId` / `taskId`），要扩成数组需要同时改 `preview.shifted` 的归属与撤销批次的粒度。
3. **周视图折叠**：F14 已按 D6 删死参数并回写规格，周视图不会再有折叠条。
4. **F13 月视图密度**留后续包。
5. **`preview.duration` 对 move 恒等于源时长**（不支持「拖边同时挪位置 + 改时长」），`resolveCalendarDrop` 的 `sourceDuration` 入参已就位。
6. **折叠条悬停 + 边缘滚动的相互影响**：折叠条贴在轨道上沿，指针悬停在它上面就一直在 56px 触发带里，展开后仍会继续滚。行为本身符合 §200（指针在边缘带就该滚），但它与 §128 的「悬停展开以便精确放置」在体感上互相拉扯。E2E 用「先移到中段让滚动停下再量刻度」绕开；产品侧是否在 hover 展开期间抑制滚动属设计决策，本轮不动。
7. **确认气泡在窄列里会盖住落点框下方的内容**（1200 宽日视图实测）。气泡是模态（`kind="action"`），盖住的部分本来就不可交互，接受。
8. **`useCalendarViewport` 保留的 window `dragstart`/`drop` 监听**不是排程残留，它守的是「从窗口外拖文件进来」期间不让恢复请求落地；`grep` 命中时看 §2.3。

## 10. 文档同步

- [`docs/PROJECT-GUIDE.md`](../PROJECT-GUIDE.md)：§2 拖拽条目整段重写为 pointer 单通道并删掉「`pointer-events: none` 会取消 DnD」「`dataTransfer` 保护模式空串」两条只属于池路径的限制；§5 代码地图删 `calendarDrag.ts` 一行、改写 `useDragSession`／`useCalendarViewport`／`calendarPlacement`／`e2e/phase1.spec.ts` 四行；§10 图层表加 12 档；§11 测试数量；§12「修改日历内的拖拽通道」整段重写。
- [`docs/design/UI-SPEC.md`](../design/UI-SPEC.md)：§128 回写「折叠与拖拽悬停展开只适用于日视图」。
- [`docs/reports/calendar-evaluation-2026-10-24.md`](calendar-evaluation-2026-10-24.md)：§4 的 F04／F09／F10／F14 标注「已收口（B1／B2）」并链到两份实施记录。
