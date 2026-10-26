# 日历整改 B3 实施记录：改时长接入让位与确认、折叠展开期间抑制边缘滚动

> 对应开工提示 [`calendar-b3-kickoff-prompt.md`](calendar-b3-kickoff-prompt.md)。上游：[评估报告](calendar-evaluation-2026-10-24.md) 的 **F21／F22** 与 §6 的 **D12／D13**；前两步见 [`calendar-b1-implementation.md`](calendar-b1-implementation.md)、[`calendar-b2-implementation.md`](calendar-b2-implementation.md)。
> 范围：把「拖底边改时长」接进 B2 已经建好的让位与确认体系，并消掉折叠条悬停展开与边缘自动滚动在轨道上沿的互相拉扯。**不引入新通道、不改状态机五态结构、不改图层表、不动提交事务与撤销栈的粒度**（一次手势 = 一个撤销项）。
> 规格依据是 UI-SPEC §189 后半与 §197（**文本一个字都没改，本包是补齐实现**）与 §128 的一句补充。

## 1. 结果摘要

| 项 | 改前（B2 结束） | 改后（B3） |
| --- | --- | --- |
| 拉长时后续时段 | 不动（`computePreview` 对 resize 只返回 `shifted: []`） | 按插入语义级联后移，真卡 `top` 过渡 + `data-yielding`（与 move 完全同一条路） |
| 缩短时后续时段 | 不动 | 不动（`resizeChanges` 判据是「新结束分钟越过了谁」，天然返回空，§198） |
| 拉长压住时间块 | 直接落库，零提示 | 松手停在 `deciding`，气泡只有「仍然安排／取消」（没有「放到时间块之后」，改时长没有「之后」语义） |
| 拉长把后续安排推出默认时段／推过午夜 | 直接落库 | boundary 气泡「会影响 N 项已有安排／它们会被推出默认时段／会被推到 X」，确认才提交 |
| 取消改时长 | —（没有可取消的确认） | `idle` + **零副作用**（时长、后续时段、库内写入一样都没动） |
| 提交粒度 | 单字段 `updateExecutionSession` | 有让位时 `applyExecutionSessionChanges` **一次写**（时长 + 让位），**一个撤销项**；没有让位时仍走原单字段写入 |
| 折叠条悬停展开期间 | 展开与边缘滚动同时发生，落点边展开边往上跑 | 边缘滚动速度直接 0；展开结束且指针离开后立即恢复 |

实测：`tsc --noEmit` 零诊断、`vite build` 通过、Vitest **419/419**（29 文件）、Playwright **62/62**（1 worker，2.4min）、静态 18 张与 B2 的 `probe/` **逐字节相同**。命令与读数见 §7。

## 2. 改时长的让位与确认契约

### 2.1 预览（`useDragSession.computePreview` 的 resize 分支）

改前对 resize 只返回一份「时长变了、其余照旧」的空预览。现在它和 move／create 一样读同一个纯函数：

```ts
const sessions = optionsRef.current.sessionsFor(source.date);   // 与提交同一套集合
const shifted = gesture.session
  ? resizeChanges({ sessions, session: gesture.session, startMinute: source.startMinute, duration })
  : [];
return { kind, date: source.date, startMinute: source.startMinute, duration,
         mode: "place", targetSessionId: "", targetRatio: null, latched: false, shifted,
         collapsedGapKey: null, blockId: null };
```

`shifted` 的结构与插入的完全相同（`{ session, startMinute }[]`），所以卡片渲染层不用分手势：`CalendarDay` 把 `columnPreview.shifted` 摊到每张真卡上，命中即 `data-yielding` + 新 `top`。

### 2.2 松手：先问决策，再决定走哪个出口

| 阶段 | move／create | resize |
| --- | --- | --- |
| `pointerup` | `buildDecision(intent)` → 非空进 `deciding`，否则 `commitIntent(intent)` | `buildDecision(intent)` → 非空进 `deciding`，否则 `commitResize(preview)` |
| `deciding` 确认 | `commitIntent(decision.intent)` → `onCommit` | `commitResize({ ...preview, duration: decision.resizeDuration })` → `onResize` |
| `deciding` 取消 | `dismissDecision()` → `idle` | 同（`resizeDuration` 只影响确认出口） |
| 「放到时间块之后」 | 有（`afterIntent`） | **没有**（`afterIntent: null`，按钮不渲染） |

`DragDecision` 因此多一个字段，它是两条出口的**唯一开关**：

```ts
interface DragDecision {
  kind: "boundary" | "block";
  reason: "outside-slots" | "cross-day" | "block";
  anchor: { x: number; y: number };
  count: number;
  dates: string[];
  blockTitle: string;
  intent: CalendarDropIntent;          // resize 时只用来描述「哪天、从哪开始」，不参与提交
  afterIntent: CalendarDropIntent | null;
  resizeDuration: number | null;       // 非空 = 这次决策来自 resize，确认后走 onResize
}
```

`commitResize` 与 `commitIntent` 的分工：前者 `phase: "landing"` 期间保留 `preview`（卡片停在拖出来的高度上等写入回来），调用 `onResize(session, duration)`，失败时把 `committed` 撤回、`finish()` 收尾；后者不变。

### 2.3 App 侧的两条判据

`buildDragDecision` 两条分支照旧，只是判据换了对象：

| 分支 | move／create | resize |
| --- | --- | --- |
| 时间块（`kind: "block"`） | `preview.blockId` 命中 `workspace.timeBlocks` | `blockOverlapping({ blocks, date, startMinute, duration })` —— **看拉长后的区间**盖住哪个块 |
| 越界（`kind: "boundary"`） | `dropImpact({ date: intent.date, shifted: preview.shifted, defaultRanges })` | 同一个函数，`shifted` 换成这次拉长推开的那一段 |

为什么时间块不能沿用指针命中：拖底边时**指针一直停在卡片下缘**，被盖住的时间块往往在卡片中段，按指针判会整个漏掉（`blockOverlapping` 的用例就是照这个场景写的）。

为什么 resize 只可能判出 `outside-slots` 或 `cross-day`、而不会像 move 那样两个都常见：resize 不改 `date`（永远是 `source.date`），所以「落点换天」不存在；但**被推走的时段可以越过午夜**（`dropImpact` 的判据是 `start >= 1440 || end > 1440`），23:00 之后被推后一小时就会判出 `cross-day`。周视图与全天模式的 `defaultRanges` 为空，于是只剩 `cross-day` 这一条 —— 与 B2 的既有口径一致，也符合 kickoff 的「不新增打扰」。

### 2.4 提交：一次事务、一个撤销项

```ts
const resizeCalendarSession = async (session: ExecutionSession, duration: number) => {
  const sessions = placeableSessions(workspace.executionSessions, session.localDate);
  const shifted = resizeChanges({ sessions, session, startMinute: timeMinutes(session.startLocal), duration });
  if (shifted.length === 0) { await moveSession(session, session.localDate, session.startLocal, duration); return; }  // 与 B2 完全一致
  const next = moveSessionTo(session, session.localDate, session.startLocal, duration);
  const updates = [next, ...shifted.map((change) => moveSessionTo(change.session, at.date, at.time, sessionDuration(change.session)))];
  await commit(() => native.applyExecutionSessionChanges({ create: [], update: updates, deleteIds: [] }));
  pushUndo({ label: "撤销时间修改", run: () => native.applyExecutionSessionChanges({ create: [], update: previous, deleteIds: [] }) });
};
```

让位集合在提交时**按同一份纯函数重算一次**（与拖动中的预览同口径，输入集合都是 `placeableSessions`），所以「拖动里看到谁让位」与「落库后谁真的让位」不会分叉。分成两次写会留下「时长已经变了、后面还没让位」的中间态，撤销也得分两次 —— E2E 与组件用例都断言 `applyExecutionSessionChanges` **只被调用一次**、且同一次调用的 `update` 里同时出现两张卡。

## 3. 边缘滚动的 gate

```ts
const gapExpanding = Boolean(gesture.preview?.collapsedGapKey)          // ① 半秒等待期：指针还压在折叠条上
  || Boolean(optionsRef.current.edgeScrollHoldRef?.current);            // ② 展开之后：那条折叠条已经不存在了
const velocity = insideViewport && !gapExpanding
  ? dragEdgeScrollVelocity({ clientY: gesture.lastY, viewportTop: rect.top, viewportBottom: rect.bottom })
  : 0;
```

两段窗口各有不可替代的作用，反向验证（§7.2）分别去掉过：

| 窗口 | 输入来源 | 去掉之后 |
| --- | --- | --- |
| ① 半秒等待期 | `preview.collapsedGapKey`（状态机自己算的几何，`gapKeyAtPoint`） | 滚动把折叠条从指针下面卷走，**展开根本不会发生**（E2E 红在「展开后那张卡可见」） |
| ② 展开之后 | `edgeScrollHoldRef`（`DayCalendarGrid` 的 `dragExpandedGapKey`） | 指针轻推 3px 让 `collapsedGapKey` 变空，内容立刻被卷到顶（E2E 红在 `scrollTop`：期望 80、实测 **0**） |

ref 的写入规则（`DayCalendarGrid`）：

```ts
const holdWrittenRef = useRef(false);
useEffect(() => {
  const hold = dragExpandedGapKey !== null;
  if (hold === holdWrittenRef.current) return;   // 只在**本网格**的展开态真的变化时写
  holdWrittenRef.current = hold;
  edgeScrollHoldRef.current = hold;
}, [dragExpandedGapKey, edgeScrollHoldRef]);
useEffect(() => () => { if (holdWrittenRef.current) edgeScrollHoldRef.current = false; }, [edgeScrollHoldRef]);
```

「只在真的变化时写」不是优化：三日缓冲有三块网格共用一个出口，每次渲染都无条件写会让「一块展开」被「另一块本来就是收起」覆盖掉。

传递链：`AppShell` 的 `gapExpansionHoldRef`（`useRef(false)`）→ `CalendarPage` → `ContinuousDayView` → 三块 `DayCalendarGrid`；`useDragSession` 只通过 `DragSessionOptions.edgeScrollHoldRef` 读它。**没有新建第二套状态** —— 写它的还是日视图那个既有的 `dragExpandedGapKey`；用 ref 而不是布尔 prop 是因为这个值每帧在 rAF 循环里读，不值得为它加一次重渲染。

§200 的其余语义一字未动：`dragEdgeScrollVelocity` 的二次爬升（1 → 22 px/帧）、触发带 56px、回中央立即 0、`insideViewport` gate 全部原样，B2 那条单调性用例照旧通过。指针**离开**刚展开那一段（`hoveredGapKey` 变空）时展开收起、ref 归 `false`，滚动立刻恢复 —— 这条由同一条 E2E 的后半段钉住。

## 4. 纯函数（`src/lib/calendarPlacement.ts`）

```ts
/** 让位的唯一级联：插入与改时长共用。 */
function cascadeChanges(sessions, sourceId, fromMinute: number, occupiedUntil: number): SessionPlacementChange[]

export function insertionChanges(sessions, sourceId, targetId, edge, sourceDuration): SessionPlacementChange[]  // 行为未变

export function resizeChanges(input: {
  sessions: ExecutionSession[];    // 与提交同一套集合（placeableSessions）
  session: ExecutionSession;       // 正在改时长的那一份，旧时长由它自己给出
  startMinute: number;             // 改时长不动开始时间
  duration: number;                // 拖出来的新时长
}): SessionPlacementChange[] {
  const previousEnd = input.startMinute + sessionMinutes(input.session);
  return cascadeChanges(input.sessions, input.session.id, previousEnd, input.startMinute + input.duration);
}

export function blockOverlapping(input: { blocks: TimeBlock[]; date: string; startMinute: number; duration: number }): TimeBlock | null
```

三个口径值得记住：

1. **`fromMinute` 取的是旧结束分钟**（不是旧开始）：只有原本在旧结束之后开始的时段才可能被让位，并排项（起点早于旧结束）一概不动 —— 否则一次拉长会把同时进行的那一项也推走，缩短时更会把并排项整体后移，直接违反 §198。
2. **缩短天然返回空**：`occupiedUntil = start + duration < previousEnd`，`cursor` 一开始就比所有候选的起点小（候选都被 `>= previousEnd` 过滤过），循环里一个 `start < cursor` 都不成立。
3. **`blockOverlapping` 只看预览所在那一天**，跨午夜的块按 `end <= start ? end + 1440 : end` 算结尾（既有口径）。它返回的是**块本身**（`title` 给气泡用），不是布尔。

`insertionChanges` 的既有用例（B1 的 2 条、B2 的边界用例）在重构后未改一行断言、全部通过 —— 这是「共用级联」不改变插入语义的证据。

## 5. 规格补齐对照

| 行 | 条目 | 状态 | 落点 |
| --- | --- | --- | --- |
| **189 后半** | 「仍然安排」只覆盖本次；**调整任务时长而侵入时间块时沿用相同确认** | ✅ | `blockOverlapping` + `resizeDuration`；气泡两选项（截图 `resize-block-confirm.png`） |
| 196 | 拖底边改时长 | ▫️ | B1 起就有；B3 只改它松手之后做什么 |
| **197** | **向下拉长让位 + 跨默认时段／跨天用小气泡确认** | ✅ | `resizeChanges` + `dropImpact(preview.shifted)`；周视图／全天模式 `defaultRanges` 为空时只剩跨天一条会打扰 |
| 198 | 向上缩短只释放空档 | ▫️ | 级联判据保证（§4 第 2 条） |
| **128**（相邻规格） | 拖动悬停折叠条约半秒展开 | ✅ 补一句 | 「悬停展开期间边缘自动滚动暂停，展开结束且指针离开折叠条后立即恢复」 |
| 200 | 靠近顶部／底部自动滚动，越近越快，回中央立即停 | ▫️ | 只多一条 gate；曲线、触发带、`insideViewport` 全不动 |
| 192／193 | 5 秒撤销提示、一次拖拽 = 一个撤销项 | ▫️ | resize 也满足：「时长 + 让位」一个撤销项（`Ctrl+Z` 一次全回） |

UI-SPEC 的 §189／§197 **文本未改**（本包是补齐实现）；只给 §128 追加了上面那句话。

## 6. 视觉证据（`output/2026-10-26_calendar-b3/`）

静态外观由 `output/2026-10-24_calendar-assessment/probe.mjs` 复拍，与 B2 的 `probe/` **18 张逐字节相同**（本目录的 `probe/` 是这一轮的产物，`measurements.json` 一并留档）。静态截图看不到的三件事由 `drag-probe.mjs` 拍（生产构建 + `vite preview` + 固定时钟，只写 `localStorage`；读数量化在 `drag-probe.json`）：

| 文件 | 看什么 |
| --- | --- |
| `resize-yield.png` / `-crop.png` | 拉长进行中：源卡从 10:00–11:00 拉到 12:00（半透明跟手），读数「10:00–12:00 · 120 分钟」，下面两张真卡同时让位（近景里能看出 12:00 那张已经落在读数之后、13:00 那张在它下面） |
| `resize-block-confirm.png` | 拉长压住 11:30–12:30 的「午休」后松手：「与时间块「午休」同一时段」＋正文＋**只有**「仍然安排／取消」两个按钮（`drag-probe.json` 的 `blockBubbleButtons` 就是这两个词） |
| `gap-hold-collapsed.png` | 指针（拖的是日历里的真卡）压在轨道上沿的「00:00–19:00 · 1 项安排」折叠条上：还没到半秒，条还在、`scrollTop = 60` |
| `gap-hold-expanded.png` | 同一手势半秒后：那一段已展开（视口里换成 00:00–04:00 的刻度），**`scrollTop` 仍是 60** |

`drag-probe.json` 的实测：`resizeReadout = "10:00–12:00 · 120 分钟"`、`yieldingCards = [b3-follow-s: 548px, b3-later-s: 632px]`（两张都比原位下移了一小时 = 84px）、`blockBubbleButtons = ["仍然安排", "取消"]`、`gapScrollBefore/Hovering/Expanded = 60 / 60 / 60`。

四张（含近景）都逐张看过。两处需要说明：① 读数贴着**卡片**左下角（`DragTimePreview` 锚的是卡片不是指针），整页截图里会压住让位后那张卡的标题，所以补了 `resize-yield-crop.png`；② 折叠条必须落在视口上沿 56px 触发带里才有「两条规格同时成立」的窗口，而这一段正好被 44px 吸顶日期带盖住，所以 `gap-hold-collapsed.png` 里折叠条只露出下半截 —— 这本身就是 F22 为什么难发现的原因。

## 7. 验证实测

本机 Windows + PowerShell（Git Bash 下 `vitest` 会因盘符大小写把 `@vitest/runner` 加载两份，见 PROJECT-GUIDE §11）：

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `node <隔离 5.9>/typescript/bin/tsc -p tsconfig.json --noEmit` | **零诊断**（本机 `typescript@7` 原生编译器仍会 `bcrypt.dll` panic，与代码无关） |
| 生产构建 | `node node_modules/vite/bin/vite.js build` | 通过，`index-BX01HMUa.js` 598,800 B / `index-Yl352Tq1.css` 188,340 B（CSS 与 B2 同名同大小） |
| 组件测试 | `node node_modules/vitest/vitest.mjs run` | **419/419**，29 个文件，58.3s |
| E2E | `node scripts/run-e2e.mjs --workers=1` | **62/62**，1 worker，2.4min（最终树上的复跑；补上「展开后轻推 3px」那条断言之后） |
| residuals | `node output/2026-10-26_calendar-a6/residuals.mjs` | 四场景溢出卡 **0**、日横溢 **0**、今日药丸 **4.89**、吸顶 **44 / 88 / 88 / 176**、最小卡 42 / 62 / 32 / 62（周 200% 的 176 与 21px 窄列横溢是 A6 已裁决接受项，本包未改呈现） |
| 静态视觉 | `node output/2026-10-24_calendar-assessment/probe.mjs` | 与 B2 的 `probe/` **18 张逐字节相同**（最后一帧 `ref-settings-1200` 仍超时，B1／B2 同样，属既有探针问题） |

Rust **未复跑**：本包一行 Rust／迁移都没碰，`src-tauri` 的工作树与 B2 验收时逐字节相同（`git status` 里没有 `src-tauri/` 的改动），B2 的 `cargo test --all-targets` 48/48 仍代表当前树。

### 7.1 新增／改写的用例

| 层 | 用例 | 断言要点 |
| --- | --- | --- |
| Vitest | `yields the following cards while a resize grows through them and commits both in one write` | 拖动中读数「10:00–12:00 · 120 分钟」、邻位 `data-yielding="true"` 且 `top` 落在 12:00；松手后 `applyExecutionSessionChanges` **只有一次**、`update` 里两张卡同时在；撤销提示是「撤销时间修改」 |
| Vitest | `asks with exactly two options when a resize would cover a time block` | 气泡写「午休」、两个按钮在、「放到时间块之后」**不存在**、`data-drag-phase="deciding"` 且库内零写入；点「仍然安排」才写 `endLocal 12:00` |
| Vitest | `cancels a resize that would push a session out of the default slots without touching either` | boundary 气泡「会影响 1 项已有安排」；取消后 `updateExecutionSession` / `applyExecutionSessionChanges` **一次都没调**，两张卡的时间文本逐字未变 |
| Vitest | `pushes later sessions when a resize grows, but leaves shrinking and parallel runs alone` | `resizeChanges` 三组输入（拉长 90 → next 690 / later 750；同长与缩短 → `[]`；拉长 120 → 720 / 780） |
| Vitest | `finds the time block a resize covers even when the pointer sits on the bottom handle` | 区间覆盖、只认当天、跨午夜块按 24 小时算 |
| E2E | `calendar B3 resizes across a time block and undoes the length and the shifts in one step` | 真指针拉长 → 邻位 `data-yielding` 且 `top` 下移 84px → 松手出「重叠确认」两选项 → 「仍然安排」后落库 = 读数 → **一次** `Ctrl+Z` 把时长与后移一起撤回 |
| E2E | `calendar B3 holds edge scrolling while the folded bar expands and resumes after leaving it` | 悬停半秒后展开；展开期间 `scrollTop` 不变；**展开后指针仍在触发带里轻推 3px 也不能滚**；指针移出后落到下沿触发带，`scrollTop` 立刻增长 > 40px |

### 7.2 反向验证（三条，都红过）

1. **resize 不接 `shifted`**（把 `computePreview` 的 resize 分支改回 `shifted: []`），跑 `-t "yields the following cards while a resize"`：

   ```text
   Error: expect(element).toHaveAttribute("data-yielding", "true")
   Expected the element to have attribute: data-yielding="true"
   Received: null
   > 2443 |   expect(follow).toHaveAttribute("data-yielding", "true");
   ```

   还原后同一条通过 —— 新用例确实绑在「接进级联」这件事上，而不是「拉长成功就算过」。

2. **只留 gate 的第一段**（`gapExpanding = Boolean(preview.collapsedGapKey)`，去掉 ref），跑 `-g "B3 holds edge scrolling"`：

   ```text
   Error: 展开结束后指针还在上沿带里也不能滚
   Expected: 80
   Received: 0
   > 2974 |   expect(await axis.evaluate((element) => element.scrollTop), "展开结束后指针还在上沿带里也不能滚").toBe(before);
   ```

   展开成功、但视图被卷到顶（80 → 0）。这条正是 kickoff 要的「去掉 gate 应红在 `scrollTop`」。

3. **两段都去掉**（`gapExpanding = false`），同一条用例：

   ```text
   Error: expect(locator).toBeVisible() failed
   Locator: … .calendar-session filter hasText "折叠安排"
   Timeout: 3000ms — element(s) not found
   ```

   比第 2 条更早红：滚动把折叠条从指针下面卷走，**展开根本没发生**。所以两段窗口都是必需的，不是重复防御。

第 2 条反向验证顺带补上了一个覆盖缺口：原用例在展开后不再动指针，于是 `preview.collapsedGapKey` 一直是那一帧的旧值，第二段窗口（ref）其实没被行使。现在展开后**轻推 3px** 让状态机重算一次落点（`collapsedGapKey` 变空、只剩 ref 在挡），才真正把「展开之后」这段窗口钉住。

## 8. 偏离与顺带修复

1. **`insertionChanges` 抽出 `cascadeChanges`**：纯重构，行为由既有用例（B1 的 `calendarPlacement.test.ts` 两条 + B2 的越界 E2E）逐条守住；不抽的话就是 F21 的原病 —— 两条通道各写一遍级联，改时长那份忘了写。
2. **`DragDecision` 加一个字段而不是加一种 kind**：`kind` 仍然只有 `boundary | block` 两种，气泡的两种形态与文案完全复用；「确认后走哪条出口」用 `resizeDuration: number | null` 表达，`confirmDecision` 里一个分支就够。
3. **`onResize` 的接线从 `moveSession` 换成 `resizeCalendarSession`**：语义变了（可能要连带让位），所以入口换名而不是在 `moveSession` 里加判断。
4. **E2E 补了「展开后轻推 3px」**（见 §7.2 末段）：不是放宽或绕过，而是把「展开期间」这段窗口真的行使一次。
5. **`resize-yield` 的近景**：读数锚卡片不锚指针（B1 的 `DragTimePreview` 契约），整页截图必然压住下面那张卡的标题 —— 这是既有视觉，本包不改，用近景交代清楚。

## 9. 未收口

1. **拉长进折叠区不会触发折叠条展开**。resize 的 `collapsedGapKey` 恒为 `null`（`computePreview` 的 resize 分支不碰 `gapKeyAtPoint`），所以「拉长到 19:00 之后掉进折叠区」时那条折叠条只会原地不动，用户看不到自己拉进了什么。补的话要先把「指针在折叠条上」的定义从「指针」换成「卡片下缘」，那是另一个决策（悬停判定会与边缘滚动再打一次架）。
2. **改时长侵入时间块时没有落点框**（`preview.kind === "resize"` 不画 `.calendar-drag-preview`，卡片本身就是落点），确认气泡是唯一提示；气泡也没有「与时间块同时安排」这个措辞（那是 move 的预览文案）。
3. **「拖边同时挪位置 + 改时长」仍不支持**（`preview.duration` 对 move 恒等于源时长，B2 §9.5 已记）。
4. **多选整组拖拽**仍不做（B2 §9.2）。
5. **拒绝/接受边界**：指针停在刚展开那一段里时 gate 一直生效（即使已经远离折叠条的位置）；一旦移出该段就立刻释放。这与「展开结束且指针离开折叠条后恢复」一致，但「在展开出来的内容里贴着上沿放置」时不会滚 —— 有意为之（那正是需要精确放置的时候）。
6. **确认气泡在窄列里仍会盖住落点下方内容**（B2 §9.7，本包未动）。
7. **resize 的 `cross-day` 分支没有专门用例**：它走的是同一个 `dropImpact`，`cross-day` 的判据本身由 `calendarPlacement.test.ts` 既有那条（无默认时段时只判跨天）守住；`App.test.tsx` 的三条 resize 用例分别钉住「让位 + 一次写入」「时间块两选项」「越界取消零副作用（outside-slots）」。要更严可以再补一条「23:30 的那一项被推到次日」的组件用例。

### 回退方法

只涉及 5 个源文件，按层次回退：

```powershell
# 全部回退到 B2 收口（8adddaf）
git checkout -- src/hooks/useDragSession.tsx src/lib/calendarPlacement.ts src/App.tsx `
                src/App.test.tsx src/lib/calendarPlacement.test.ts e2e/phase1.spec.ts `
                docs/PROJECT-GUIDE.md docs/design/UI-SPEC.md docs/reports/calendar-evaluation-2026-10-24.md

# 只想停掉「改时长的确认」而保留让位：把 buildDragDecision 两处 resizeDuration 改成 null，
# 状态机就回到「resize 不弹气泡、直接 commitResize」。
# 只想停掉边缘滚动的 gate：把 gapExpanding 改成 false（回到 B2 行为）。
# 只想停掉让位而保留确认：computePreview 的 resize 分支 `shifted: []`（气泡随之消失，因为 dropImpact 不会命中）。
```

## 10. 文档同步

- [`docs/PROJECT-GUIDE.md`](../PROJECT-GUIDE.md)：§2 拖拽条目补「resize 与 move 共用让位与确认」整段；§5 代码地图的 `calendarPlacement.ts` 与 `useDragSession.tsx` 两行各补一句 B3 入口；§11 测试库存 414 → **419**、60 → **62** 并补 B3 明细；§12「修改日历内的拖拽通道」加 resize 分支与边缘滚动 gate 两条入口。
- [`docs/design/UI-SPEC.md`](../design/UI-SPEC.md)：§189／§197 **文本未改**；§128 追加「悬停展开期间边缘自动滚动暂停，展开结束且指针离开折叠条后立即恢复」。
- [`docs/reports/calendar-evaluation-2026-10-24.md`](calendar-evaluation-2026-10-24.md)：§4 的 F21／F22 标「已收口（B3）」并链到本文件；§5.5 的九份提示词索引（新增 B3 行）与 B 轮验收记录由总 Agent 维护，本包没有再去改它们。
