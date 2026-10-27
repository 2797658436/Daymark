# 日历整改 C4 实施记录：密度档切换保持滚动位置、并排卡片可自由错开

> 对应开工提示：[`calendar-c4-kickoff-prompt.md`](calendar-c4-kickoff-prompt.md)。决策依据 **D16**（评估 §6）：用户 2026-10-27 实测反馈 #3、#4。
> 红线核对：B1–B3 建立的状态机五态结构、图层表、吸附／Alt 语义、让位与确认体系、一次手势＝一个撤销项、预览与提交同口径——**逐条未回退**（回归读数见 §7）。未动气泡／表单（C2）、布局骨架（C1）、卡片进度呈现（C3）。未 `git commit`；C1／C2／C3 与用户的未提交修改原样保留在工作区。

## 1. 结果摘要

| 判据 | 改前 | 改后 |
| --- | --- | --- |
| 点「紧凑／标准／详细」后的视口中央逻辑分钟 | 无任何补偿：切档只改内容高度，`scrollTop` 像素不变、多半不派发 scroll，ResizeObserver 又因 client 尺寸未变而不触发；84→216 px/小时时同一 `scrollTop` 指到的时刻漂移约 60% | 108 组探针里 **85 组未被物理钳位，最大漂移 0.7 分钟**（日 58 组最大 0.4、周 27 组最大 0.7，判据 ≤1 全过）；其余 23 组是浏览器把 `scrollTop` 钳在 0／末尾的**物理不可达**样本，逐条如实记录（§5） |
| 正在看的卡 | 切档后可能被推出视口 | 中央时刻不动 ⇒ 卡仍在视口内（E2E `toBeInViewport` 钉住） |
| 切档是否污染 viewport 记忆 | — | 补偿走 `applyPosition`，内部即 `markProgrammaticSettle` ⇒ 只刷内存不写偏好；E2E 直接断言 `preferences.calendarPositions.week.minute` 切档前后逐字不变 |
| 并排第二张卡能否错开时刻 | 不能：`sessionAtPoint` 的 x 只看「在整列轨道内」，纵向一交叠就把第一张判成 target，中段 overlap 又 `startMinute = targetStart` | 能：横向按**实际并排栏**判命中，栏缝／自己那一栏的空白时刻 → 无命中 → `place`（自由分钟 + 既有吸附）；实测落库 10:45–11:45（§8 截图） |
| 中段（0.25–0.75）overlap 的落点 | `startMinute = targetStart`（强制对齐目标卡起点） | `startMinute = pointerMinute`（经当前吸附粒度），0.5s 闩锁只负责把读数确认成「同时安排」 |
| 上／下 25% 边带 | 插入并后移 + `cascadeChanges` 让位 | **一字未改**（E2E 断言 `data-yielding` 计数、库用例断 `shifted` 序列，读数见 §7） |
| 静态呈现 | — | C4 在静态渲染路径上的唯一产物是 `data-lane-*` 两个属性；**6 帧日／周 × 三档删掉属性后逐字节相同**（§6） |
| `npm run check` | C3 树：Vitest 428／Playwright 63／Rust 48 | 四步全绿：Vitest **431/29 文件**、Playwright **66/66**、Rust **48/48**（[`check.log`](../../output/2026-10-27_calendar-c4/check.log)） |

## 2. 切档保位：选了哪条通道，为什么

任务书给的两条候选：① 复用 Ctrl+滚轮的 `captureZoomAnchor`／`compensateZoomAnchor`；② 逻辑位置存取（切档前记 `{date, 视口中央 minute}`，scale 变化后 `applyPosition` 恢复）。

**选了 ②（逻辑位置通道）**，落点在 [`src/hooks/useCalendarViewport.ts:558-571`](../../src/hooks/useCalendarViewport.ts#L558)。三条理由：

1. **按钮路径没有可锚的指针位置**。`captureZoomAnchor` 的锚点定义就是「指针下那一刻不动」，全仓唯一调用点是 `zoomWithWheel`（`App.tsx` 的滚轮通道）；把密度按钮硬塞进这条通道，得先给一个不存在的坐标编一个语义。
2. **验收判据与逻辑位置同构**。判据是「视口中央的逻辑分钟差 ≤1 分钟」，而 `{date, minute, viewportRatio}` 正是这份单一真相本身——`scrollTopForCalendarPosition` 与尺寸变化用的也是它（上面的 ResizeObserver 分支）。共用一份换算，才不会同一件事出现两套锚点。
3. **不污染偏好是硬要求**。`applyPosition` 写完 `scrollTop` 后自己调 `markProgrammaticSettle`（`useCalendarViewport.ts:484`），因此这次定位不参与「用户滚动」采样；若走指针锚点通道，还得额外证明它不派发用户意图。

关键护栏（都在同一个 layout effect 里，顺序即语义）：

- `previousScaleRef` 让补偿**只在 scale 真变化时**动手，挂载与无关重渲染不参与。
- `scaleAnchorOwnedRef` 解决两条通道的争抢：Ctrl+滚轮那个 effect 排在前面且同步跑，落地时把这一档标成「归我」；密度 effect 看到 `scaleAnchorOwnedRef.current === scale` 就让开。**没有这条**，一次 `Ctrl+滚轮` 会被指针锚点和中央时刻各补偿一次，两次写入互相覆盖。
- `draggingRef` 期间不接管：拖动中改档的滚动归 B 轮的边缘滚动／让位通道，切档补偿插手会改到拖拽坐标系的基准。
- 位置来源优先取 `latestRef`（本轮已经「停下」的采样值），退回偏好里的 `calendarPositions[view]`（首屏或从未滚动过）。
- 落位是**同步**的（与 `compensateZoomAnchor` 同款）：延后一帧会让用户先看到跳位再回来。代价是量不到轨道时（`applyPosition` 返回 `false`）不重试，退回改前行为——密度按钮点击时布局早已测量完，实测 108 组里 `trackSame` 全真、无一次落空。

覆盖到的形态：日视图三日缓冲（基准取**中段面板**轨道，前／后一天各 44px 带子或整块面板都不参与读数）、周视图七列共享时间轴（基准取 8/5 那一列）、默认时段模式的折叠条与展开段（采样落在折叠条上时取区间中点，与产品 `sampleCalendarPosition` 同一判据）、折叠条展开态。

## 3. lane 命中的几何来源

`sessionAtPoint`（[`src/hooks/useDragSession.tsx:246`](../../src/hooks/useDragSession.tsx#L246)）现在把每张候选卡交给纯函数 `sessionHitAtPoint`（[`src/lib/calendarPlacement.ts:157`](../../src/lib/calendarPlacement.ts#L157)）判定，几何两个轴分开取：

| 轴 | 取法 | 为什么 |
| --- | --- | --- |
| 纵向 `top`／`height` | **原计划几何**：`trackRect.top + offsetForMinute(track, start)`，高度取 `max(计划高, rect.height)` | 与 B 轮同一口径。插入预览会把目标卡真的往后挪（UI-SPEC §171），按挪动后的位置判定，指针停在原上缘时目标会从指针下消失，预览在「插入」和「放置」之间闪，松手重算又得到不同落点 |
| 横向 `left`／`right` | **落库**的 `concurrentLayouts` 百分比 → `data-lane-left`／`data-lane-width` → `laneXSpan` 换算成像素，两侧各内缩 `CARD_LANE_GUTTER_PX = 4` | 渲染侧同一常量算的就是 `calc(left% + 4px)` / `width: calc(width% - 8px)`（`App.tsx:2110/2141`），命中面与可见卡片边缘严格同宽；栏与栏之间那 8px 不属于任何卡 |

**为什么不直接用 DOM 的 `rect.left/right`**：§177 的重叠预演（`previewLayouts`）会随指针临时改卡片宽度，按预演判定，指针停在列中央时目标卡反而被推到「预览栏」之外、从指针下消失——预览显示「同时安排」、松手却按 `place` 落库（实测差 30 分钟）。所以命中只看落库布局，预演只负责「看得见」。`App.tsx:2144` 的 `const hitLane = concurrency.get(session.id) ?? null` 明确取的是 `concurrency`（落库那套），不是同一行里给渲染用的 `layout`（预演那套）。

多卡同点命中时 `sessionHitAtPoint` 取**面积最小者**（并排组里窄卡优先）。旧的「`onPointer` 优先 + 面积」两级判据退化成一级：横向既然已由 lane 分开，就不需要再靠「指针压着哪一张」兜底。

## 4. 中段 overlap 新语义的边界情况

`resolveCalendarDrop`（`calendarPlacement.ts:202/211/212/215`）里 `startMinute` 的初值就是 `input.pointerMinute`，中段两条分支（未闩锁的 `place` 与闩锁／提交后的 `overlap`）都不再改写它——**预览与提交同口径由同一个函数保证**，边带两条分支仍写 `targetStart` / `targetStart + duration`。

- **跨 lane 拖动**（源卡在右栏，指针压进左栏中段）：命中左栏那张 → 0.5s 闩锁 → `overlap`，落点 = 指针分钟。截图 `centre-overlap-mid.png`：ratio 0.50、读数「10:30–11:30 · 60 分钟」、虚线框「同时安排」——落点是松手时刻而不是目标的 10:00。
- **三卡并排**（各 1/3 栏）：指针落在第三栏左沿外 3px 的**栏缝**里 → 三张都不命中 → `place`，落库 10:45–11:45，前两张不动；落库后 `concurrentLayouts` 按新的时间关系重新分栏（`three-lanes-seam-*.png`）。
- **未闩锁的中段悬停**：仍是 `place`（读数「悬停 0.5 秒以同时安排」），只是落点从 `targetStart` 变成指针分钟——B1 那条 `previews place in the middle but commits overlap (D5)` 用例**逐字未改**仍然通过，因为它把 `pointerMinute` 设成 600 = 目标起点，两种语义在那个夹具上重合。
- **旧入口**（调用方已决定 `overlap` 但没给 ratio）：同一条规则，取指针分钟（`calendarPlacement.ts:215`），新增断言钉住。
- **snap 关闭态**（按住 `Alt` 或偏好 `snapMinutes: "off"`）：吸附只作用在 `pointerMinute` 的求值上（`useDragSession.tsx:358-360` 的 `snapMinutesFor`／`snapTo`），lane 命中判的是几何——两者正交。关闭吸附时中段 overlap 落在**精确指针分钟**，`place` 亦然；既有 Alt 用例（`App.test.tsx:247-251`）未改并通过。
- **越界与时间块确认的入参**：`dropImpact` 读 `resolution.shifted`、`blockOverlapping` 读区间，两者吃的都是新 `startMinute`，判据函数本身一字未改。
- **resize 通道**：`resizeChanges` 不动 `date`／`startMinute`，B3 契约原样（三条 resize 用例逐字通过）。

## 5. 探针读数（108 组切档）

`output/2026-10-27_calendar-c4/scale-anchor.mjs`（生产构建 + `vite preview`、固定时钟 `2026-08-05T12:00`、headless、单 browser、`finally` 清理；共享夹具 `output/2026-10-26_acceptance/fixture.mjs` 的 `denseWeek()`）。矩阵＝**日(fullDay／默认时段) × 6 个起始档 × 6 个位置**（72）＋ **周 × 6 × 6**（36）＝ 108；位置为 贴顶／06:00／10:30／14:00／20:00／贴底，起始档为三档两两有序组合。

| 分组 | 组数 | 未钳位 | 未钳位最大漂移 | 钳位 | 钳位最大漂移 |
| --- | --- | --- | --- | --- | --- |
| 日 / 贴顶 | 12 | 6 | 0.1 | 6 | 81.6 |
| 日 / 06:00（默认时段时落在折叠条上） | 12 | 6 | 0.1 | 6 | 81.6 |
| 日 / 10:30 | 12 | 10 | 0.0 | 2 | 43.6 |
| 日 / 14:00 | 12 | 12 | 0.0 | 0 | — |
| 日 / 20:00 | 12 | 12 | 0.0 | 0 | — |
| 日 / 贴底 | 12 | 12 | 0.4 | 0 | — |
| 周 / 贴顶 | 6 | 3 | 0.7 | 3 | 111.6 |
| 周 / 06:00 | 6 | 6 | 0.6 | 0 | — |
| 周 / 10:30 | 6 | 6 | 0.6 | 0 | — |
| 周 / 14:00 | 6 | 6 | 0.6 | 0 | — |
| 周 / 20:00 | 6 | 3 | 0.4 | 3 | 101.0 |
| 周 / 贴底 | 6 | 3 | 0.4 | 3 | 151.6 |
| **合计** | **108** | **85** | **0.7** | **23** | **151.6** |

- 判据「≤1 分钟」在 **85/85 未钳位组**上成立（>1 分钟者 0 组）；`trackSame` 108 组全真（读数始终落在 8/5 那块基准轨道上，没有被三日缓冲平移污染）。
- 23 组钳位＝17 组 `scrollTop` 被钳在 0、6 组被钳在 `maxScroll`：目标档的内容高度放不下「同一刻居中」，中央时刻必然偏移，这是**像素层的物理上限**，不是补偿失效。E2E 因此不把它们塞进 ≤1 判据，改钉「钳位精确」（贴顶切档后 `scrollTop` 仍是 0），UI-SPEC 的密度条目里也写明了这个例外。
- 读数里的 `卡可见` 列是**信息项**：探针居中的是任意位置，被盯的 `s-5`（16:00）在切档前本来就可能不在视口内；「正在看的卡仍在视口内」由 E2E 那条（先居中到卡、再切最密的紧凑档、断 `toBeInViewport`）负责钉。

## 6. 静态呈现零变化的证明

任务书要求「静态 18 张 probe 与上一轮逐字节相同」。这一条**给不出干净结论**，原因不在 C4：C1／C2／C3 与本包同在一条未提交的工作区上，仓库里没有可回退重跑的「C3 收口态」提交，所以 18 张帧里 14 张日历帧的差异无法按轮次拆开。如实记录实测：

- 与磁盘上最后一份 18 帧基线（B3，`output/2026-10-26_calendar-b3/probe/`）逐字节比对：**4 张非日历帧（`ref-today`／`ref-projects`／`ref-review`／`ref-deadlines`）完全相同**，14 张日历帧有差异——差异属 C1（布局骨架／全天开关／回到现在）、C2（气泡与表单）、C3（双层条与遮罩），那三包的证据目录里逐张可查。另：`ref-settings-1200` 这一帧本轮**没拍到**（探针等 `设置` 标题 30s 超时），是既有探针的时序问题，不在本包口径。
- 替代证明（把 C4 自己那部分单独钉住）：`output/2026-10-27_calendar-c4/static-noop.mjs` 在**同一页、同一时刻**先等页面自比稳定，再删掉 `data-lane-left`／`data-lane-width` 复拍——日／周 × 三档 **6/6 帧逐字节相同**，且每帧都先断言「确实有 3 张卡带 lane 属性」（防「拿空页蒙过」）。
- 另外两处 C4 碰到的静态表达式是**值等价**的替换：卡片与虚线框的 `calc(...% + 4px)`／`calc(...% - 8px)` 里的字面量换成 `CARD_LANE_GUTTER_PX`（值仍是 4），渲染分支、CSS、类名一条未加。

## 7. 测试与回归

| 位置 | 新增／改写 | 钉什么 |
| --- | --- | --- |
| `src/lib/calendarPlacement.test.ts:71` | 新增「commits a centre overlap at the released minute, not at the target's start (D16)」 | 中段四路（未闩锁 place／闩锁 overlap／提交 overlap／旧入口 `requestedMode:"overlap"`）的 `startMinute` 全等于指针分钟 630，`shifted` 为空 |
| `src/lib/calendarPlacement.test.ts:85` | 新增「hits a card only inside its own side-by-side lane…」 | `laneXSpan` 的 4px 内缩（200px 轨道 → `{4,96}`／`{104,196}`）、栏缝与另一栏都不命中、命中时 ratio 按原计划几何、无并排布局时整栏可用（边带命中面不缩）、无命中 → `place` |
| `src/App.test.tsx:2632` | 新增「drops the second side-by-side card at a staggered minute…」 | 真 pointer 序列：预览「松开放置」、`data-yielding` 不出现（零级联）、一次 `applyExecutionSessionChanges` 写 10:30–11:30、撤销项标签「撤销时间修改」 |
| `src/App.test.tsx:2624` | **改写 1 条 B1 断言** | 中央松手落库的期望从 `10:00–11:00`（对齐目标起点）改成 `10:30–11:30`（松手时刻），注释写明 D16 |
| `e2e/phase1.spec.ts:459` | 新增「calendar C4 drops the second side-by-side card at a staggered minute inside its own lane」 | 真指针把并排第二张拖到 10:33 → 吸附 10:30 落库；`data-yielding` 计数 0；`Ctrl+Z` 整组复原；同页复跑边带插入仍让位（一条用例同时钉住新语义与不变项） |
| `e2e/phase1.spec.ts:1098` | 新增「…keeps the centre logical minute across density presets in the day view」 | 全天／默认时段两模式、多组中央时刻三档来回 ≤1 分钟；正在看的卡切到紧凑仍在视口；贴顶切档后 `scrollTop` 精确为 0；折叠条中点与展开态各一组；被物理钳位的转换跳过 ≤1 判据（改由 §5 探针与钳位用例负责） |
| `e2e/phase1.spec.ts:1151` | 新增「…in the week view, without writing the preference」 | 周视图两列共享轴同样保位，且断言 `preferences.calendarPositions.week.minute` 切档前后逐字不变 |
| `e2e/phase1.spec.ts:308` | **改写 1 处 B2 断言块** | 「edge insert yields the real cards, centre release overlaps…」的中央松手段：期望从目标起点改成 10:30–11:30 与读数「10:30–11:30 · 60 分钟」；同一用例的边带插入段逐字未动 |

**两处 B 轮断言的改写是任务书红线（「B1–B3 全部拖拽用例一条不许改断言」）与 D16 新语义的直接冲突**：那两条断言钉的正是「中段 overlap 对齐目标起点」，而这恰是本包要改掉的唯一一条落点规则。已把冲突与证据呈给用户，按裁定「**完全按任务书字面**」执行——只改写这 2 处（`App.test.tsx:2624` 与 `e2e/phase1.spec.ts:308` 的中央段），其余 B1–B3 拖拽用例（插入让位、时间块三选项、boundary 气泡、resize 让位与确认、拖回池、撤销粒度、边缘滚动、5px 拾起阈值、400ms 抑制点击）**断言逐字未改**，全量复跑通过。

回归读数：Vitest **431/431**（29 文件，C3 树 428 → +3）、Playwright **66/66**（63 → +3）、Rust **48/48**、`npm run check` 四步全绿（[`check.log`](../../output/2026-10-27_calendar-c4/check.log)）；`node output/2026-10-26_calendar-a6/residuals.mjs` 四场景溢出卡 0、日／周轴裁切 0、日横溢 0、药丸 4.89、吸顶 44/88/88 与 A6 收口态逐字一致（[`residuals.log`](../../output/2026-10-27_calendar-c4/residuals.log)），周 200% 的 21 条列内横溢为既有接受项、未变。

## 8. 反向验证（先红后绿）

两条都是**当场改源码跑红、再原样恢复**，红／绿日志留在证据目录；恢复后用 `md5sum` 与快照比对确认文件逐字节回到改动前。

**① 把 lane 命中改回「只看纵向区间」**（`sessionAtPoint` 里把 `data-lane-*` 换算那三行换成 `const layout = null`，即命中退回整列轨道）：

- 组件用例红：`Error: expect(element).toHaveTextContent()` — 期望「松开放置」，实到「**悬停 0.5 秒以同时安排**」（`src/App.test.tsx:2661`）→ [`reverse-1-unit.log`](../../output/2026-10-27_calendar-c4/reverse-1-unit.log)
- E2E 红：`expect(locator).toContainText` — 期望「松开放置」，实到「**同时安排**」（`e2e/phase1.spec.ts:519`）→ [`reverse-1-e2e.log`](../../output/2026-10-27_calendar-c4/reverse-1-e2e.log)
- 恢复后绿：`1 passed`（组件）＋ `3 passed`（含两条切档用例）→ [`reverse-1-unit-green.log`](../../output/2026-10-27_calendar-c4/reverse-1-unit-green.log)、[`reverse-green-e2e.log`](../../output/2026-10-27_calendar-c4/reverse-green-e2e.log)

**② 去掉切档补偿**（密度保位 effect 在 `previous === scale` 之后加一条恒真 return）：

- 两条切档 E2E 同时红：`全天 10:30：紧凑 档切档后的中央分钟漂移` 期望 ≤1、实到 **630**；`周 09:00：紧凑 档切档后的中央分钟漂移` 期望 ≤1、实到 **216**（`e2e/phase1.spec.ts:1074`）→ [`reverse-2-e2e.log`](../../output/2026-10-27_calendar-c4/reverse-2-e2e.log)
- 恢复后绿：同上一条的 `3 passed`。

630／216 这两个数就是「没有补偿时中央刻度跳到哪儿」的量级（日视图从 0 滚到最底、周视图整段位移），与 §5 探针里钳位组的表现同源但更极端——补偿被整体摘掉时，连原本能保住的中间位置也一起丢。

## 9. 截图与逐张检查

证据目录 `output/2026-10-27_calendar-c4/`，全部 headless（Chromium，viewport 1280×820，`deviceScaleFactor: 1`），单 browser、固定时钟 `2026-08-05T12:00`、生产构建 + `vite preview`、只写 localStorage、`finally` 清理；**未开 headed 浏览器**。12 张逐张看过，核对点与结论：

| 截图 | 场景 | 核对结论 |
| --- | --- | --- |
| `parallel-before.png` | 两张 10:00–11:00 并排 | 各占半栏（`data-lane` 0/50 与 50/50）、栏间留白均匀、「同时 2 项」角标一处、卡内三行文字无裁切 |
| `stagger-drag-mid.png` | 真指针把右栏那张拖到 10:45 | 源卡半透明且**两轴跟手**（停在右栏内），虚线落点框整列宽、不矮于卡片，读数「10:45–11:45 · 60 分钟」，预览「松开放置」，`data-yielding` 计数 0 |
| `stagger-drag-landed.png` | 松手落库 | 第二张变 10:45–11:45、第一张不动，两张仍并排（错开后 `concurrentLayouts` 重算），底部「撤销时间修改 (Ctrl+Z)」 |
| `centre-overlap-mid.png` | 跨栏压进左栏中段（ratio 0.50） | 闩锁后虚线框「同时安排」+ 两卡吸附聚拢，读数「10:30–11:30 · 60 分钟」＝松手时刻（不是目标 10:00） |
| `edge-insert-mid.png` | 上 25% 边带（ratio 0.13） | 「插入并后移」插入线 + 目标卡 `data-yielding` 真让位（计数 1）——B 轮语义未回退 |
| `three-lanes-before.png` / `three-lanes-seam-mid.png` / `three-lanes-seam-landed.png` | 三卡并排与栏缝 | 三栏各 1/3 时文字仍完整；指针在第三栏左沿外 3px 的栏缝 → 「松开放置」+ 读数 10:45–11:45 + 零让位；落库后第三张错开、前两张不动 |
| `density-standard/compact/detailed.png` | 日视图三档同场景对照（中央刻度 630） | 同一张 10:30 卡的**上沿始终停在视口中央**，只有轴标签密度变（10:00/11:00/12:00 → 08:00…14:00 → 10:00/11:00/12:00 拉大）；紧凑档卡高 24px 时只留标题行、无裁切；详细档放出 C3 的进度行 |
| `density-week.png` | 周视图切到详细 | 中央 630 → 630，今天列高亮与吸顶头不动 |

三条中央分钟读数（`shots.json`）：`density-standard centre=630 top=1523`、`density-compact centre=630 top=641`、`density-detailed centre=630 top=2027`、`density-week 630 → 630`。

发现一项**不在本包口径**的既有拥挤：窄栏（1/3）下拖动提示 chip（`.calendar-drag-preview` 的文案）与半透明源卡的 meta 行左右相邻，`three-lanes-seam-mid.png` 里 chip 压住了「待回顾」的首字。该 chip 的定位与卡片内联 lane 表达式在 B 轮就存在，C4 只把 `4px` 字面量换成同值常量（§6），像素等价；按 AGENTS.md「越界项另立后续」处理，未顺手改拖拽层样式。

> headless 限制：Chromium headless 用 overlay 滚动条，`::-webkit-scrollbar` 不绘制——本包不碰滚动条样式，不涉及该例外。

## 10. 未收口项与边界

1. **顶／底物理钳位**（§5 的 23 组）：目标档内容高度放不下「同一刻居中」时中央时刻必偏，判据在像素层不可达。已按「E2E 钉钳位精确 + 探针逐条记录」收口，UI-SPEC 密度条目写明例外；若要求边界也精确钉位，需要引入「切档时临时扩高轨道」或「按比例插值滚动」这类新机制，超出本包口径。
2. **切档补偿不重试**：`applyPosition` 量不到轨道时返回 `false`，本包选择同步落位、失败即退回改前行为（不排队重试）。与 `compensateZoomAnchor` 同款权衡，实测无一次落空。
3. **拖动中改档**：`draggingRef` 期间不接管补偿。用户边拖边点密度按钮这种组合从未被验收过，现状是拖拽坐标系不动、切档后按改前逻辑停在原像素位置。
4. **三日缓冲换日瞬间切档**：锚点被平移推走时，探针与 E2E 都先等基准轨道回到 8/5（`trackSame`／`reanchor`）再复采。产品层没有承诺「切档即钉住日期」，跨日边界那一分钟（1439）也从判据里避开——它正好命中换日判据 `scrollTop >= nextStart`，测到的会是平移而不是切档。
5. **周 200% 窄列（74px）**：21 条列内横溢为 A6 起的既有接受项，本轮逐字未变；列宽 <96px 时 `weekConcurrencyLimit` 把并排上限降到 2（`App.tsx:1346`），因此最窄一栏约 37px、减掉两侧 4px 描边后约 29px 可命中——比日视图紧，但命中判的是**整张卡**（含 44px 以上的卡高），本包没有新增小目标。
6. **拖动提示 chip 与源卡 meta 行拥挤**（§9 末段）：另立后续项。
7. **18 帧静态 probe 无法按轮次拆开**（§6）：需要一次提交（或显式 stash 出 C1–C3 基线）才能给出逐字节相同的日历帧对照。
8. 未 `git commit`；C1／C2／C3 与用户的未提交修改原样保留。

## 11. 回退方法

无数据模型、迁移、设置字段改动，回退只涉及 5 个源文件（**不要** `git checkout` 整文件——C1／C2／C3 与用户的未提交修改也在同一批文件里）：

```powershell
git diff -- src/lib/calendarPlacement.ts src/hooks/useDragSession.tsx src/hooks/useCalendarViewport.ts src/App.tsx
```

- `src/lib/calendarPlacement.ts`：`CARD_LANE_GUTTER_PX`／`laneXSpan`／`SessionHitCard`／`sessionHitAtPoint` 四个新导出（127–167）删掉；`resolveCalendarDrop` 里 4 处 `startMinute = input.pointerMinute` 改回 `targetStart`（中段）／保留 `place` 分支原样，即可回到 B 轮语义。
- `src/hooks/useDragSession.tsx:246`：`sessionAtPoint` 的 lane 换算两行退回「整列 + `onPointer` 优先」两级判据（`git diff` 里就是被删的那几行）。
- `src/hooks/useCalendarViewport.ts:558-571`：整段密度保位 effect 与 `scaleAnchorOwnedRef`／`previousScaleRef` 两个 ref 删除；`scaleAnchorOwnedRef.current = scale` 那一行也一并撤（它只为这条新通道服务）。
- `src/App.tsx`：`CARD_LANE_GUTTER_PX` 的 import 与 2110／2141 两处常量替换（换回 `4px`／`8px` 字面量即等价）、`hitLane`（2144）、`CalendarSession` 的 `lane` prop 与 `data-lane-*`（2396）。
- 测试：`calendarPlacement.test.ts` 2 条新用例、`App.test.tsx` 1 条新用例与 2624 那处期望、`e2e/phase1.spec.ts` 3 条新用例与 308 那条的中央段——回退时**必须**把 2624／308 两处期望一并改回目标起点，否则 B 轮语义下它们会红。

回退后重跑 `npm run check` 与 `residuals.mjs` 应回到 C3 树基线（Vitest 428、Playwright 63、切档跳位、中段强制对齐）。

## 12. 文档同步

- `docs/design/UI-SPEC.md`（合并式，只改相关条目）：① 拖拽段「悬停卡片中段」表述改为「中段=并排，开始时间取松手那一刻（经当前吸附粒度）；闩锁只把落点确认成并排」；② 新增「并排的卡片各自占一条横向栏…栏与栏之间的空白按空白时间自由放置」；③ 边带那条补一句「上／下 25% 边带的插入并后移与级联让位不受上面两条影响」；④ 密度条目补「切档保持视口中央的逻辑时刻」与顶／底物理钳位例外。
- `docs/PROJECT-GUIDE.md`：§12 拖拽通道入口补两条（并排错开与中段落点／密度切档保位），并把既有的「横向只看整列」硬约束订正为 lane 几何口径；§11 测试库存补 C4 计数与两处 B 轮断言改写。

## 13. 证据清单

`output/2026-10-27_calendar-c4/`：

- `scale-anchor.mjs`／`scale-anchor.json`／`scale-anchor.log` —— 108 组切档探针（含钳位分类）。
- `static-noop.mjs`／`static-noop.log` —— 6 帧「删 `data-lane-*` 后像素不变」的同页 A/B 证明（附「有并排卡 + 页面自比稳定」两条防空过判据）。
- `shots.mjs`／`shots.json`／`shots.log` + 12 张 PNG —— 并排错开四场景（各开独立页面）与切档三档对照、周视图对照。
- `probe/`（18 帧）＋ `probe.log` —— 与 B3 基线的逐字节比对（§6）。
- `reverse-1-unit.log`／`reverse-1-e2e.log`／`reverse-2-e2e.log`（红）与 `reverse-1-unit-green.log`／`reverse-green-e2e.log`（绿）—— 两条反向验证。
- `check.log`（四步全量）、`residuals.log`（A6 脚本在最终树复跑）、`pristine/`（反向验证前的两份文件快照，用于确认恢复逐字节一致）。
