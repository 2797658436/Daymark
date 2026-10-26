# 日历整改 B1 实施记录：日历内拖拽 pointer 化第一步

> 对应开工提示：[`calendar-b1-kickoff-prompt.md`](calendar-b1-kickoff-prompt.md)。方案基线：评估 F04／F09／F10（日历内部分）与 §6 的 D3（手写 pointer，不启用 `@dnd-kit`）、D5（中央松手按 overlap 提交）。
> 范围：**只把「日历内移动已排卡片」和「拖底边改时长」换成一套 pointer 自绘的 drag session**，并修掉静默丢弃 drop。任务池 → 日历、拖回任务池仍是原生 DnD，留给 B2。

## 1. 结果摘要

| 项 | 改前 | 改后 |
| --- | --- | --- |
| 日历内卡片移动通道 | 原生 HTML5 DnD（`draggable` + `onDragStart/onDragEnd` + `dragover` 算落点） | `useDragSession` 的 pointer 状态机（`pointerdown` → 5px 阈值 → `pointermove` 跟手 → `pointerup` 提交） |
| 改时长通道 | `CalendarSession.startResize` 里另写一份 pointer（与时间块重复） | 同一个 session，`kind: "resize"` |
| 拖拽状态归属 | 列级 `dragPreview` ＋ 网格级 `weekGhost`／`dayGhost` ＋ `CalendarDay.dragSourceId` 三处 | 一处 `useDragSession`，经 `DragSessionProvider` 下发；列级 `dragPreview` 只剩池路径使用（B2 收） |
| 落点算法 | 预览 `previewFromDrag` 用**全部** sessions，提交 `placeCalendarItem` 只取 `scheduled|missed`（评估 F09） | 只有一个 `resolveCalendarDrop`，输入集合统一为 `placeableSessions` |
| 卡片中央松手 | 不足 500ms 的 latch 时**静默丢弃**（评估 F04） | 一律按 `overlap` 提交；半秒 latch 保留为「明确想要重叠」的强调路径 |
| 插入让位 | 静态虚线幽灵 `.calendar-shift-preview` | **真卡片**在拖动中移动到 `insertionChanges` 给出的新位置（`top` 过渡），拖出即复原 |
| `window` 上兜底的 `dragend`/`drop` 监听 | 5 处（其中 3 处服务日历内） | 日历内 0 处（同步收尾）；池路径的 2 处保留到 B2 |

`npm run check` 四步：TypeScript 通过、Vite 构建通过、Vitest **416/416**（30 文件）、Playwright **58/58**、Rust **48/48**。四步的实测命令与结果见 §7。

## 2. 状态机契约（`src/hooks/useDragSession.tsx`）

```ts
type DragSessionPhase = "idle" | "picked" | "dragging" | "landing";
type DragSessionKind  = "move" | "resize";
```

`landing` 是「已经松手、写入正在飞」的那一段：它只有一个出口 —— 写入的 promise 结束后 `finish()` 把状态清回 `idle`。所以 `committed`／`cancelled` 不单独占一个 state，而是 `landing` 的两个**退出分支**（各自只决定副作用是否发生，不改变渲染）。

| 状态 | 事件 | 下一步 | 副作用 |
| --- | --- | --- | --- |
| `idle` | 卡身 `pointerdown`（`button === 0`，且目标不在 `button/input/.session-task-progress/.session-elapsed/.concurrent-summary/.simultaneous-count` 里） | `picked` | 记 `grabOffsetY`、`setPointerCapture`、挂 5 个 window 监听（`pointermove`／`pointerup`／`pointercancel`／`keydown`(capture)／`blur`） |
| `idle` | 手柄 `pointerdown`（`.resize-handle`） | `picked`（`kind: "resize"`） | 同上；`preventDefault` + `stopPropagation` |
| `picked` | `pointermove`，位移 < 5px | `picked` | 无（留给 click 打开待回顾气泡） |
| `picked` | `pointermove`，位移 ≥ 5px | `dragging` | `document.body.dataset.calendarDragging = "true"`、`viewport.beginDrag()`（滚动仲裁降级）、`preventDefault` |
| `dragging` | `pointermove` | `dragging` | 重算 `preview`（落点／模式／后移集合）、发布 `delta` |
| `dragging` | 指针停在某张卡中央 **500ms** | `dragging` | `latched = true`，落点吸附到目标卡起点，读数变「同时安排」 |
| `dragging` | 指针离开中央／离开目标卡 | `dragging` | 清 latch 与计时器 |
| `picked` | `pointerup` | `idle` | 只有 `finish()`：拆监听、释放 capture、清状态。**click 照常派发**（待回顾气泡） |
| `dragging` | `pointerup`，指针在任务池 | `landing` | `suppressClick`(400ms)、`viewport.endDrag()`、`onCancelSession()` → `finish()` |
| `dragging` | `pointerup`，`kind === "resize"` | `landing` | `onResize(session, duration)` → `finish()` |
| `dragging` | `pointerup`，卡身 | `landing` | `onCommit(intent)` → `finish()`；`commit: true` 时中央一律 `overlap`（D5） |
| 任意 | `Escape`（capture，`stopPropagation`）／`pointercancel`／`window.blur` | `idle` | `cancelGesture()`：`viewport.endDrag()`（仅 `started` 过）、`suppressClick`、`finish()` |
| 任意 | 组件卸载 | — | 拆监听、清计时器、删 `body.dataset.calendarDragging`（不等 window 事件兜底） |

对外 API（`DragSessionApi`）：`phase`／`sourceId`／`preview`／`delta`／`kind`、`beginMove`、`beginResize`、`suppressClick`、`cancel`。`sourceId` 的原值是 `state.source?.sessionId` —— `CalendarSession` 用它决定 `.is-dragging-source`。

`suppressClick(sessionId)` 解决「拖完松手时浏览器还会补一次 click」：松手时记下 `{ sessionId, until: now + 400ms }`，卡片 `onClick` 第一件事就是问它，命中则不打开待回顾气泡（回归红线 §40）。

## 3. 与时间块实现（`CalendarTimeBlock`）的复用关系

时间块是 A 轮已验证过的参照实现，B1 照抄它的四条行为，但**没有把两者的状态机合并**：

| 行为 | 时间块（既有） | 已排卡片（B1） | 关系 |
| --- | --- | --- | --- |
| 两轴跟手 | 自身 `style.top/height` + 列内位移 | `transform: translate(dx, dy)`（`.is-dragging-source` 因此**不能**有 `transform` 过渡，否则落后指针 ~120ms） | 同一观感，载体不同：卡片的位置由时间轴算出，只能靠 transform 叠加 |
| 落点框另画 | `.calendar-drag-preview` | 同一个 class | 直接复用 |
| 落点框不矮于卡片 | `min-height: calc(1.875rem + 2px)` | 同一条规则 | 直接复用 |
| 换格 150ms 过渡 | `transition: top/height 150ms` | 同一条规则 | 直接复用 |
| 松手瞬时收到 | 本地 `landed` 覆盖显示 | `pendingPlacement`（跨列时目标列先画一份） | 语义相同、状态源不同（见 §5） |
| 拖动中读数 | `DragTimePreview` | 同一个组件 | 直接复用，且本轮修了它的定位缺陷（§9.2） |

`.calendar-session` 原有的 `transition: top .2s …` 正好被 §171 的让位复用：真卡片从旧位置滑到 `insertionChanges` 给的新位置，不需要另写动画。

## 4. 同口径纯函数（`src/lib/calendarPlacement.ts`）

```ts
/** 预览与提交共用的一份落点描述。 */
export interface CalendarDropIntent {
  date: string; startMinute: number; taskId: string; sessionId: string;
  mode: CalendarDropMode; targetSessionId: string; targetRatio?: number | null;
}

/** 某一天参与落点的时段集合：scheduled | missed。预览、提交、让位都读它。 */
export function placeableSessions(sessions: ExecutionSession[], date: string): ExecutionSession[];

/** 落点与后移的唯一算法。commit=true 表示松手（中央按 overlap，D5）。 */
export function resolveCalendarDrop(input: {
  sessions: ExecutionSession[]; sourceSessionId: string; sourceDuration: number;
  pointerMinute: number; targetSessionId?: string; targetRatio?: number | null;
  requestedMode?: CalendarDropMode; overlapLatched?: boolean; commit?: boolean;
}): { startMinute: number; mode: CalendarDropMode; targetSessionId: string; shifted: SessionPlacementChange[] };
```

三条入口都走它：

1. `useDragSession.computePreview(…, commit: false)` —— 拖动中的预览；
2. `useDragSession` 松手时的 `computePreview(…, commit: true)` —— 提交前算的那一次；
3. `CalendarDay.previewFromDrag`（池路径的原生 `dragover`／`drop`）—— 顺带把 B2 的那条路也收进同一口径。

`placeableSessions` 解决了 F09：以前预览读 `workspace.executionSessions` 全量、提交只取 `scheduled|missed`，取消／跳过／完成的历史会让预览给出错误的让位。现在两边读同一份，`CalendarDay` 的 `sessions` 也直接用它。

## 5. F09／F04／D5 的落地细节

- **中央松手不再静默丢弃**：`commit: true` 且 `targetRatio ∈ [.25, .75]` 时，`mode` 直接是 `overlap`、`startMinute` 取目标起点。半秒 latch 仍然存在，但它现在只影响**拖动中**的读数与落点吸附（`commit: false` 时中央停在 `place`，提示「悬停 0.5 秒以同时安排」），不再是「提交与否」的开关。
- **预览与提交只算一次**：松手时**不**复用拖动中那份 `preview`，而是用同一个 `computePreview(gesture, x, y, altKey, true)` 重算 —— 唯一的差别是 `commit` 标志。这样「指针最后落在哪」与「提交什么」不会因为拖动中最后一次 `pointermove` 丢失而分叉。
- **`targetRatio` 传进 `CalendarDropIntent`**：`onPlace` 的旧签名只有 `mode`，`App` 侧无法复算边缘判定；现在把 ratio 一起带上，`placeCalendarItem` 与预览读的是同一组输入。
- **命中判定读原计划几何**（`sessionAtPoint`）：插入预览会把目标卡真的往后推（§171），若按 DOM 当前位置判定，指针停在原上沿时目标会从指针下消失 —— 预览会在「插入」和「放置」之间闪，松手重算又得到另一个落点。所以目标命中用「当天时段 + 轨道分段」算出的原始几何，只有卡片**宽度**读 DOM。

## 6. 让位与读数（UI-SPEC §166/168/171）

- **让位**：`CalendarDay` 把 `activePreview.shifted` 摊到每张卡上，命中的卡按 `startMinute` 重算 `startLocal/endLocal` 再交给既有 `positionForRange`，并打 `data-yielding="true"`。`.calendar-session` 已有的 `top .2s` 过渡负责滑过去；预览清空时同一份计算回到原值，卡自己滑回去。**没有一行新动画代码。**
- **读数**：`readoutActive = isResizing || (isMoving && preview)`，文案 `09:00–10:30 · 90 分钟`，仍然走 `DragTimePreview`（越界翻转／贴 8px 边／190px 预留现成）。

## 7. 验证实测

命令与结果（本机 Windows，PowerShell）：

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | **通过**（见下方说明） |
| 生产构建 | `node node_modules/vite/bin/vite build` | 通过，`dist/assets/index-*.js` 592 kB / `index-*.css` 187 kB |
| 组件测试 | `npm run test`（Vitest） | **416/416**，30 个文件，52.8s |
| E2E | `node scripts/run-e2e.mjs --workers=1` | **58/58**，1 worker，2.4min |
| Rust | `npm run test:native` | **48/48**，19.85s |

> 本机 `npm run build` 里的 `tsc --noEmit` 会因 `typescript@7` 原生编译器加载 `bcrypt.dll` 失败（`winapi error #5`）而 panic，与代码无关（既有环境坑，见 PROJECT-GUIDE §11）。同一份 `tsconfig.json` 用隔离环境里的 `typescript@5.9.3` 跑 `--noEmit` 退出码 0，**零诊断**。

### 7.1 真指针 E2E 覆盖（`e2e/phase1.spec.ts`）

| 要求 | 用例 | 断言要点 |
| --- | --- | --- |
| 周视图跨列移动 | 「scheduled session can move and return to the pool…」（改写） | 真实 `mouse.down/move/up` 跨列；断言旧列清空、新列时间变化、`data-drag-phase` 收回到 `idle` |
| 日视图跨日移动 | 「a session moves to the next day and resizes…」 | 拖到次日 15:00；读数 `15:00–16:00 · 60 分钟` = 落库 `startLocal/endLocal/localDate` |
| 改时长 | 同上后半段 | 手柄下移 56px（28px/小时）→ 读数 `15:00–18:00 · 180 分钟` = 落库 `endLocal` |
| 插入后移让位 | 「edge insert yields the real cards…」 | `data-yielding="true"` + `top` 从 10:00 移到 11:00／12:00（`toBeCloseTo`）；**且实测 `transitionProperty` 含 `top`、`transitionDuration ≠ 0s`** |
| 拖出复原 | 同上 | 移到任务池上：`data-yielding` 消失、`style.top` 回到原值、库内时间未变 |
| 中央松手 overlap | 同上 | 不足 500ms 松手，读数先显示「悬停 0.5 秒以同时安排」，落库 = 目标卡起点（10:00–11:00），目标卡不动，撤销项是「撤销同时安排」 |
| Ctrl+Z 整组撤销 | 同上 | 一次撤销让源卡回 14:00、两张目标卡回 10:00／11:00 |
| 池路径护栏保留 | `gui-optimization.spec.ts:297` | 真实原生拖拽仍活着（`dragstart` 后没有紧跟着 `dragend`） |
| 落点框不矮于卡片 + 换格过渡 | `gui-optimization.spec.ts:365`（改 pointer 驱动） | 15 分钟卡：落点框高 ≥ 卡片高且 ≥ 32px；换格后 `top` 变大且 `transitionProperty` 含 `top` |

### 7.2 组件测试（`src/App.test.tsx`）

- 改写 3 条：`pointerdown/move/up` 序列取代 `dispatchEvent("dragstart"…)`。
- 新增 6 条（其中「pointer 移动 + 读数 + `landing` 覆盖」取代原来的「landed slot while the write is in flight」，**净增 5** → Vitest 409 → 416）：pointer 移动 + 读数 + `landing` 覆盖、**指针穿过滚动容器时减掉轨道上沿**（真浏览器的回归：jsdom 里 `top` 恒为 0 时这条会绿，正是它盖住了原来的 bug）、插入让位 + 拖出复原 + 库内零写入、让位后提交与预览同点、中央 <500ms 松手落 `overlap`、手柄改时长。
- 纯函数层新增 2 条：`placeableSessions` 的集合口径、`resolveCalendarDrop` 的「预览 place / 提交 overlap」与两边缘一致性。

### 7.3 视觉证据（`output/2026-10-26_calendar-b1/`）

静态外观用「改前／改后同脚本同参数」两次拍摄比对。**不要拿 `output/2026-10-26_acceptance/` 当基准** —— 那批图是另一版探针（不同 `calendarScale` 种子），日视图差 29%，与代码无关。本轮的做法是字节级备份 → `git checkout HEAD -- src/App.tsx src/styles.css src/components/ui/drag-time-preview.tsx` → 构建 → 拍 `before/` → 恢复（`sha256sum -c` 三个文件全 OK）→ 构建 → 拍 `after/`：

| 对比 | 结果 |
| --- | --- |
| `after` vs `after2`（**同一份代码两次拍摄**，确定性对照） | 18 张**逐字节相同** |
| `before`（HEAD 代码）vs `after`（B1 代码） | 18 张**逐字节相同** —— 静态视觉零变化 |

即：本步确实只换了输入通道，日／周／月／三种密度／200%／浅色全部零像素差。

拖动中的状态用 `drag-probe.mjs` 另拍 6 张（headless、单 browser、`finally` 清理、走 `dist` + `vite preview`），`drag-detail.mjs` 再给 2x 放大 + DOM 量测：

| 图 | 看的是什么 | 实测 |
| --- | --- | --- |
| `drag-week-insert-yield.png` | 跟手卡（0.55 透明）＋落点框＋「插入并后移」＋两张真卡让位 | 跟手卡 `transform: translateY(-190px)`、z 34；落点框 z 35 高 62px（≥ 卡片 48px）；目标卡 `top` 356（11:00）、邻位 404（12:00） |
| `drag-week-center-hint.png` | 中央预 latch：「悬停 0.5 秒以同时安排」 | 落点停在指针分钟（10:30），卡片中央不吸附 |
| `drag-week-overlap-latch.png` | latch 后：「同时安排」＋落点吸到目标起点 | 读数 10:00–11:00 与落点框一致 |
| `drag-day-cross-day.png` | 日视图跨日：读数、虚线框跟着 15:00 走 | 8/6 列上 `松开放置` + `15:00–16:00 · 60 分钟` |
| `drag-resize-preview.png` | 改时长：卡片与读数同步长到 17:00 | 卡片 14:00–17:00，读数贴在卡底 |
| `drag-week-insert-200.png` | 960×200%：窄列下读数仍贴卡、不裁切 | 读数 250×52（rem 随 200% 放大），左对齐卡片 |
| `detail-week-insert-yield.png` | 2x 放大看清 1px 虚线与 12px 字 | 见 §9 |

## 8. 反向验证

**让位过渡**：把 `src/styles.css` 第 781 行 `.calendar-session` 的 `transition: top .2s …, height .2s …, …` 里的 `top .2s cubic-bezier(.2, 0, 0, 1), ` 暂时删掉，单独跑

```powershell
node scripts/run-e2e.mjs --workers=1 -g "edge insert yields"
```

结果 **1 failed**，红在正是这条新断言上：

```
Expected substring: "top"
Received string:    "height, transform, box-shadow, z-index"
> 316 |  expect(yieldTransition.property).toContain("top");
```

把备份 `cp` 回来（`sha256sum -c` OK）后同一条用例通过 —— 说明这条断言真的绑在过渡上，而不是「位置变了就算过」。

**指针纵坐标必须减轨道上沿**：这是 B1 中途抓到的一个真 bug（见 §9.3）。反向验证的做法是**不修** `useDragSession` 里的 `- track.getBoundingClientRect().top`，跑 `-g "next day and resizes"`：真浏览器里落点整体偏上 300+px（读数变成 09:xx），而 jsdom 单测因为轨道 `top` 恒为 0 仍然全绿 —— 这正是本轮补 `converts the pointer through the scrolled track's own top edge` 这条组件用例的原因。

其余反向验证沿用既有手段：`pointer-events: none` 那条护栏（`gui-optimization.spec.ts:297`）在改用 pointer 后**仍然必须通过**，它守的是池路径的原生 DnD；把 `.calendar-session` 的 `z-index: 34` 删掉，跟手卡会被下方卡片盖住但测试仍绿（视觉项，只以截图为准）。

## 9. 三处偏离、两处顺带修复

### 9.1 图层表新增一档 34（偏离「不改图层表数值」）

`.is-dragging-source` 需要浮在其它卡片（z ≤ 10）之上、落点框（35）之下——旧实现里**跟手的是幽灵不是卡片**，所以卡片只需要「变淡」，不需要抬层。现在跟手的是真卡，取 **34**，落在既有「24–35 临时层」区间内，图层表注释同步为「插入线／位移预览 24、跟手卡片 34、拖拽落点 35」。这是本步唯一改到 `z-index` 的地方，吸顶层（20）> 轨道内容（0–10）、临时层 > 吸顶层两条关系都未变。

### 9.2 读数条一直被摆错位置（既有缺陷，本轮修）

`DragTimePreview` 用 `position: fixed` + 视口坐标，但它原来渲染在 `.calendar-session` **里面**。而 `.calendar-session` 有 `container-type: size`（含 layout containment），拖动中的卡又带 `transform` —— 两者任一个都会让 fixed 后代的包含块变成这张卡。于是 `left/top` 被当成「卡片内的坐标」再叠一次卡片位置：实测卡片在 `(425, 310)`、读数被摆到 `(853, 676)`，也就是**跨了两列、低了 366px**。改时长路径（A 轮就有了）一直带着这个问题，只是组件测试读文本、E2E 读 `role=status`，谁都看不见位置。

修法：读数改成 `createPortal(…, document.body)`（与 `FloatingPanel` 同一手法），并把理由写进组件注释。

### 9.3 改时长时读数停在卡片内部（本轮修）

卡片高度是 `height .16s` 过渡过去的，而 `followKey` 连续变化时量到的是**过渡起点附近**的矩形：停手后读数停在卡片 15:30 的位置上（实测卡片涨到 17:00、读数还在 15:30）。补一次 `transitionend`（`target === anchor` 才重量），用事件而不是逐帧轮询 —— jsdom 不派发 `transitionend`，组件测试不必包 `act()`。

### 9.4 指针分钟数没减滚动容器的上沿（本轮修，真浏览器才露）

`minuteAtTrackOffset(track, y)` 拿到的是**视口坐标**，`y` 必须先减掉轨道的 `top` 才能当「轨道内偏移」用。落地前漏了这一步，表现是真实浏览器里落点整体偏上（读数差几小时），而 jsdom 的所有 mock 都把 `top` 设成 0，全绿。现在 `computePreview` 里显式减，并补了对应组件用例（§7.2 第 2 条）。

### 9.5 池路径的 `dragPreview` 没有收进 hook

开工提示要求「三处状态全部收进 `useDragSession`」。落地时 `CalendarDay` 仍保留一个列级 `dragPreview`，但它现在**只服务任务池 → 日历的原生 DnD**（`previewFromDrag` / `onDragOver` / `onDrop`）——日历内的移动不再写它。B2 把池路径也换成 pointer 时，这个 state 与 `lib/calendarDrag.ts` 一起删。`weekGhost`／`dayGhost` 两条渲染分支已经合并成同一个 `.calendar-drag-preview`。

## 10. 遗留（B2 清单）

1. **池路径仍走原生 DnD**：`TaskCard.draggable` + `lib/calendarDrag.ts` 的影子副本 + `CalendarDay` 的 `onDragOver/onDrop/onDragLeave` + 5 个 window 监听（`dragend`／`drop` 等）。B2 接 `useDragSession` 时需要的 session 事件名已经就位：`beginMove(event, session)`（从池拖出时伪造一个「虚拟 source」）、`onCommit(intent)`、`onCancelSession(session)`（拖回池）；`previewFromDrag` 可以直接换成 `computePreview(…, commit: false)` 的同一份输入。
2. **`gui-optimization.spec.ts:297` 的真原生拖拽护栏**：只要池 → 日历还是 DnD 就必须留着；B2 换完 pointer 后连同它一起删（届时「拖拽源必须可命中」这条警告本身也失效，PROJECT-GUIDE §2 与 `styles.css` 里那条注释一并清理）。
3. **拖回任务池的落区视觉**：现在 `pointInTaskPool()` 只做几何判定 + 取消安排，没有高亮／「松开取消安排」提示，B2 补视觉。
4. **跨时段／跨天确认气泡、拖入时间块确认**：B2。
5. **多选整组拖拽**：后续包。
6. `useDragSession` 的 `preview.duration` 对 move 恒等于源时长（不支持「拖边同时改时长」）；`resolveCalendarDrop` 已经预留 `sourceDuration` 入参。

## 11. 文档同步

- `docs/PROJECT-GUIDE.md` §2：拖拽条目改为「日历内已 pointer 化、池路径仍 DnD（B2）」；§5 代码地图新增 `useDragSession`，并改 `calendarPlacement`／`drag-time-preview`／`useCalendarViewport`／`calendarDrag` 四行；§11 测试数量（409 → 416 / 56 → 58）与 B1 条目；§12 新增「修改日历拖拽通道」入口。
- `docs/design/UI-SPEC.md`：§166–173 的四条行为本步只换载体、不改语义，规格文本未动；图层表在 `styles.css` 注释里同步（24／34／35）。
