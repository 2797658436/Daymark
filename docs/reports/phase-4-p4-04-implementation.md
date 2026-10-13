# 阶段 4 P4-04 实施报告：日历滚动仲裁与逻辑浏览位置（内存版）

日期：2026-10-13。对应工作包：P4-04（`docs/specs/0005-phase-4-daily-workflow-and-reliability.md` §10），依赖：P4-01。
状态：**代码、测试与验证已完成**；位置持久化（Store）留给 P4-05。

## 1. 范围

按开工提示词交付四项：

1. 新增 `src/hooks/useCalendarViewport.ts`：日／周共用的**单一滚动仲裁入口**，实现规格 §5.2 的优先级 1–6；视图／日期每变一次递增 generation，过期的 `requestAnimationFrame` 与 `ResizeObserver` 回调一律 no-op。
2. 新增 `CalendarPosition` 逻辑坐标（`{date, minute, viewportRatio}`）与日／周各自的**内存**记忆；月视图不存时间轴坐标，沿用日期锚点并在进入时置顶。
3. 采样取视口中心对应的日期／分钟；中心命中折叠条时取该条时间区间中点，恢复不展开整段非默认时间；像素一律由 `src/lib/calendarTimeline.ts` 的分钟／像素映射产出。布局未测量时等轨道可测量再恢复。
4. 程序性滚动不写偏好；用户滚动停止 300ms 后采样；切页时刷新最后一次内存值。

明确未做（越界项）：不写 Tauri Store、不新增偏好字段、不新增迁移／Command／依赖；不改排程事实与拖拽／插入后移／撤销语义；不动 M10／M11；不重新引入全局 `overflow: clip`，未关闭浏览器滚动锚定。

## 2. 交付清单

| 文件 | 变更 |
| --- | --- |
| `src/hooks/useCalendarViewport.ts` | **新增**（约 560 行）。纯换算 + 内存记忆 + 仲裁 hook。 |
| `src/hooks/useCalendarViewport.test.tsx` | **新增**，14 个用例。 |
| `src/lib/calendarTimeline.ts` | 导出 `segmentOffsetAtMinute`／`segmentMinuteAtOffset`／`clockMinutes`，`createCalendarTimeline` 改为调用它们（映射仍只有一份实现）。 |
| `src/App.tsx` | `CalendarPage` 接入 hook；删除自带的首次定位／缩放锚点两段 `useLayoutEffect`；`returnToNow`、`focusSessionId` 显露、拖拽边缘自动滚动改走仲裁入口；`ContinuousDayView` 的缓冲定位改为 `useLayoutEffect` 并上报程序化写入；折叠分段补 `data-collapsed`。 |
| `src/App.test.tsx` | 新增 3 个用例（折叠标记、位置不落偏好、日↔周往返恢复）。 |
| `e2e/phase1.spec.ts` | 新增 AC05 用例 1 个。 |
| `docs/reports/phase-4-p4-04-implementation.md` | 本报告。 |
| `docs/PROJECT-GUIDE.md` | 按文档同步协议更新。 |

无新增依赖、无 SQLite 变更（schema 仍为 v7）、无 Tauri Command。

## 3. 契约

```ts
interface CalendarPosition { date: string; minute: number; viewportRatio: number }
type TimelineView = "day" | "week";

const CALENDAR_SCROLL_PRIORITY = {
  drag: 1, reveal: 2, zoomAnchor: 3, bufferShift: 4, restore: 5, initial: 6,
} as const;

useCalendarViewport({ view, date, now, scale, slots, dates, rootRef }) => {
  readGeneration(): number;
  flush(): void;                                   // 采样并写入内存（切页／卸载前）
  revealNow(): void;                               // 优先级 2
  revealSession(sessionId: string): void;          // 优先级 2
  captureZoomAnchor(measurement): void;            // 优先级 3（写比例之前调用）
  noteProgrammaticPosition(): void;                // 优先级 4（应用自己刚写过位置）
  positions(): CalendarPositions;                  // 只读内存
}
```

导出的纯函数（供测试与复用）：`sampleCalendarPosition`、`scrollTopForCalendarPosition`、`pickTrackForPosition`、`firstDefaultSlotMinute`、`initialCalendarMinute`、`dragEdgeScrollTop`，以及内存读写 `readCalendarPositions`／`resetCalendarPositions`。

**位置的所有权**：同一时刻只有一个请求能落地。高优先级请求会作废待处理的低优先级请求；拖拽（1）期间低优先级请求延后到 `dragend`／`drop`。缩放锚点补偿（3）是**同步**的（延后一帧会让指针下的时间先跳一下再回来），它落地即拥有控制权。

## 4. 关键实现决策

### 4.1 逻辑坐标而不是 `scrollTop`

日视图有 52px 日期头、折叠区间与三日缓冲，周视图有吸顶日期头与全天区，相同像素不是相同时间。采样取视口中心，恢复时用 `calendarTimeline` 的映射把 `minute` 重新算成像素。

- **折叠条**：中心落在折叠分段上时取该条时间区间**中点**。折叠条把整段非默认时间压成 44px，按像素内插会随 1px 滚动跳几小时；取中点既稳定，也保证恢复时不必展开它（实测再采样回到同一分钟，见 §5.1）。
- **中心不在任何轨道内**（日分隔条／面板头）：取最近轨道的边缘，并把 `viewportRatio` 记成该边缘**当时**的屏幕比例，恢复时能把边缘放回原处，而不是按 0.5 硬塞。
- **折叠分段信息**：折叠时间轴的分段补了 `data-collapsed`，采样据此判断是否取中点。

### 4.2 generation 与「让位于用户滚动」

- 视图／日期每变一次：刷新离开前的最后一次内存值 → `generation += 1` → 作废待处理请求。顺序由 `useLayoutEffect` 的声明顺序保证（先作废、再排新请求）。
- 待处理的恢复／首次定位会**让位于任何先发生的滚动**（用户拖动、键盘滚动或程序化写入都更权威）——这是阶段 3 那次 108px 位移的成因。
- 唯一例外：应用**自己**刚写下的那个位置。日视图进入时会把三日缓冲重新定位到中段（`scrollTop` 写入），它的 `scroll` 事件发生在同一帧、早于本请求的第一次尝试；不区分的话「进入日视图」永远恢复不了（实测表现：日视图恒定停在缓冲中段）。因此新增 `noteProgrammaticPosition()`：记下刚写入的 `scrollTop`，只有落在该位置上的 `scroll` 事件才被当作非用户滚动，两帧后失效。
- 拖拽状态由 `window` 上的 `dragstart`／`dragend`／`drop` 观察，不需要往深层组件传状态。

### 4.3 等布局可测量，不猜 DOM

`applyPosition` 在视口或轨道高度为 0 时返回「未落地」，请求保持待处理：同一帧内补几帧，之后交给 `ResizeObserver` 在尺寸真正变化时再推一次（`MAX_RESTORE_RETRIES = 3` 只是给「同一帧量不到高度」留的余量，不是固定延时）。`generation` 变化时重新订阅 observer，所以过期回调永远改不到新视图。

`ResizeObserver` 只在**视口尺寸真的变了**时才用上一次采样的位置重新落位（「窗口尺寸变化以时间保持为准」）。重新订阅时的首次回调、折叠展开等内容高度变化都不算尺寸变化 —— 否则日视图会拿上一次采样把**前一天**的同一时刻对到视口中央，直接触发一次反向的三日缓冲平移。这一条是实测出来的回归，见 §6。

### 4.4 采样节奏与内存

- 滚动事件里同步采样一次（供切页时刷新用），滚动停止 **300ms** 后写入「已停下」的内存值。
- 视图／日期变化时、以及组件卸载（切页）时，把最后一次采样刷新进内存 —— 因为 DOM 已经换过，事后再量就晚了。
- 内存是模块级（与 `pendingPlacement`、编辑会话注册表同一惯例），所以**切页仍在**；重启不恢复，持久化属 P4-05。
- 本工作包**完全不写 Store**，「程序性滚动不立即写偏好」按构造满足；内存值会被程序化滚动刷新（它记录的就是视图实际所在的位置），这一点在 P4-05 接 Store 时需要再加一道「程序性滚动不写偏好」的闸门。

## 5. 刻意行为变化

| 变化 | 原因 |
| --- | --- |
| 进入日／周视图时**总是**重新落位（有记忆恢复记忆，无记忆做首次定位），不再只在本次挂载的第一次生效 | 规格 §5.2 优先级 5：AC05 要求日↔周往返各回各位 |
| 非今天的日期进入时定位到「该日首个默认时段」（无时段则 09:00），而不是停在顶部 | 规格 §5.2 优先级 6 的后半句；此前只处理了「包含今天」的分支 |
| 「进入日视图」现在真的会把「现在」带到中央 | 此前该自动定位会被日视图自己的缓冲定位取消（见 §4.2），一直没有生效 |
| 三日缓冲的定位从 `useEffect` 改为 `useLayoutEffect` | 必须在同一帧内先于父级仲裁的恢复落地，否则一次迟到的 passive 定位会把恢复好的位置顶掉 |
| 拖拽边缘自动滚动的算式移入 `useCalendarViewport`（`dragEdgeScrollTop`） | 优先级 1 的算式与优先级表同源；行为与阶段 3 完全一致 |
| 月视图进入置顶 | 未变，仍是 `useLayoutEffect` 里 `scrollTop = 0` |

## 6. 验证

### 6.1 测试数量

| 层级 | 本次实测 | 本包增量 |
| --- | --- | --- |
| Vitest | **180 / 17 文件** | +17（14 新增文件 + 3 App 用例） |
| Playwright | **30** | +1（AC05） |
| Rust | **未能运行**（见 §6.4） | 0 |
| `tsc --noEmit` + Vite 生产构建 | 通过（`dist` JS 419.32 kB / CSS 74.63 kB） | — |

命令：`vitest run`、`node scripts/run-e2e.mjs --workers=1`（见 §6.3 的浏览器说明）、`tsc --noEmit && vite build`。

### 6.2 反向验证（去掉修复即失败）

逐项把修复代码改掉后重跑对应用例，全部如期失败：

| 变异 | 对应用例 | 结果 |
| --- | --- | --- |
| 去掉折叠分段的 `data-collapsed` | App「marks folded timeline segments…」 | 失败 ✓ |
| 去掉恢复／首次定位 | hook「restores the remembered position…」 | 失败 ✓ |
| 去掉「让位于用户滚动」守卫 | hook「lets any user scroll cancel a pending restore」 | 失败 ✓ |
| 去掉拖拽延后 | hook「defers a lower-priority restore until the drag ends」 | 失败 ✓ |
| 去掉 ResizeObserver 再推一次 | hook「waits for a measurable track…」 | 失败 ✓ |
| 去掉 generation 递增 | hook「increments the generation on every view and date change」 | 失败 ✓ |
| 去掉程序化写入抑制 | hook「does not treat the app's own programmatic positioning as a user scroll」 | 失败 ✓ |
| 去掉「只在尺寸真变时保持时间」 | hook「only re-anchors the visible time when the viewport size really changed」；E2E「task can be scheduled by one drag」 | 失败 ✓ |

### 6.3 AC05／AC06／AC07 实测

**AC05（新增 E2E，`--workers=1`，真实 Chromium）**：固定窗口 1200×760、比例 48px/小时、`page.clock` 固定到 2026-08-05 14:00，日↔周连续切换 10 次并每次测量视口中心对应的时间：

| 视图 | 10 次测量（分钟） | 与 14:00 的最大偏差 | 10 次极差 |
| --- | --- | --- | --- |
| 日 | 840 ×10 | **0 分钟（0px）** | **0px** |
| 周 | 838.75 ×10 | 1.25 分钟（**1px**） | **0px** |

阈值是「≤1 分钟或 2 CSS px，取较宽松者」，两项均在 2px 内且极差为 0（无累计漂移）。同一用例还断言 10 次切换后 `daymark.phase1.workspace` 序列化结果与切换前**逐字节相同**（切视图不改写任何排程事实），以及月视图离开再进入 `scrollTop === 0`（进入置顶）。

**AC06**：现有 E2E 全部保持通过 —— 指针锚点缩放（M3，含日／周两段）、连续日跨午夜三日缓冲、折叠条临时展开与成功投放、插入后移与整体撤销、真实指针拖拽、落点虚线框、待回顾气泡。新增组合用例（AC05）额外覆盖「反复切视图后缩放与拖拽仍然正确」。

**AC07**：未回退。`CALENDAR_SCALE_RANGE`／`CALENDAR_SCALE_PRESET` 仍是唯一配置源，`src/lib/settings.test.ts` 的「预设必须落在合法区间内」回归保持通过；本包未触碰缩放规范化与滚轮钳制。

### 6.4 环境限制与偏差（影响结论可信度）

1. **Playwright 自带 Chromium 未安装且下载被限速**：`ms-playwright` 缓存为空，`playwright install chromium` 实测约 50 KB/s（183.6 MiB 需约 1 小时），无法完成。本次 E2E 用**系统 Chrome**（`channel: "chrome"`）跑同一套用例：临时配置 `playwright.chrome.config.ts`（已删除，内容与 `playwright.config.ts` 相同，仅多一行 `channel: "chrome"`），命令为 `node scripts/run-e2e.mjs --config=playwright.chrome.config.ts --workers=1`。**请在装有 Playwright 自带浏览器的环境用 `npm run test:e2e` 复跑确认。**
2. **Rust 原生测试在本机无法编译**：`cargo test --manifest-path src-tauri/Cargo.toml --all-targets` 在编译第三方 crate `schemars 0.8.22` 时失败（`indexmap 1.9.3` 的 `IndexMap<K, V, S>` 缺省类型参数问题，E0107），发生在 `daymark` 自身编译之前。本机 rustc/cargo 为 1.97.1，`Cargo.toml`／`Cargo.lock` 未被本包改动（`git status` 可证），因此判定为**环境／工具链问题**，与本次改动无关。`npm run check` 因此会在 `test:e2e` 与 `test:native` 两步失败；各步已分别执行并记录。
3. `npm run check` 未整体跑通，原因是上述两项环境限制，不是断言失败。

## 7. 未做与边界

- **不写 Store**：`calendarPositions` 偏好字段、跨启动恢复、非法偏好回退、恢复备份后与内存位置对齐 —— 全部属 P4-05。AC05 的「退出重开各自恢复」依赖持久化，本包只保证**内存态与仲裁正确**（切页仍在、日↔周往返各回各位），该项在 P4-05 完成前不满足。
- **月视图不存时间轴坐标**：只保证进入时置顶，与规格 §5.1 一致。
- **窗口尺寸变化**：只做到「视口尺寸真的变了就以时间保持为准」。日视图显示模式切换（全天↔默认时段）会让内容重排但视口尺寸不变，因此不重新落位 —— 规格只要求窗口尺寸变化，此项未扩展。
- **连续日的水平滚动**（`scrollLeft`）只在首次定位时归零，未纳入逻辑坐标；规格的 `CalendarPosition` 只有纵向与日期。
- **拖拽边缘自动滚动**仍由拖拽处理器直接驱动（它本身就是优先级 1 的控制权持有者），仲裁入口负责的是「拖拽期间把低优先级请求延后」。
- 临时展开、筛选、焦点等会话状态仍不进入位置记忆。

## 8. 发现的不一致

1. **规格 §5.2 优先级 6 的后半句此前未实现**：代码里只有「定位到当前时间」，没有「非今天回退日首个默认时段，无时段时 09:00」。本包补齐。
2. **`src/lib/calendarTimeline.ts` 的分钟／像素映射此前是 `createCalendarTimeline` 内部的闭包**，外部无法复用，容易催生第二套换算。本包把两个方向提取为导出函数，内部实现改为调用它们（行为不变，既有 5 个用例仍通过）。
3. `docs/PROJECT-GUIDE.md` §11 的测试数量滞后（写 Vitest 147／Rust 37／Playwright 25，实际 163／38／29，本次为 180／未测／30），已按本次实测订正。
4. 未发现规格与领域事实冲突之处；未新建 ADR（本包不引入新的长期架构决策，只是把既有滚动逻辑收敛到一个接缝）。

## 9. 独立复核（2026-10-13，复核者：另一 agent 会话）

对本报告的代码与结论逐项独立复核，结论：**P4-04 通过，可进入 P4-05**。差异与订正如下。

### 9.1 复核实测

| 项 | 报告 | 复核实测 | 结论 |
| --- | --- | --- | --- |
| `tsc --noEmit` + Vite 生产构建 | 通过（JS 419.32 kB / CSS 74.63 kB） | **通过**，字节数与报告完全一致 | 一致 |
| Vitest | 180（17 文件） | **180 / 17 文件通过** | 一致 |
| Playwright | 30（用系统 Chrome，因自带 Chromium 未装） | **30 / 30 通过，用自带 Chromium**（`node scripts/run-e2e.mjs --workers=1`） | 一致，且已按 §6.4 的请求复跑 |
| Rust | 未能运行 | 未能运行，原因已定位（见 §9.3） | 一致 |

§6.3 的 AC05 数字（日 840×10、周 838.75×10、极差 0px、workspace 逐字节不变、月视图置顶）由新增 E2E 用例 `phase 4 M9 keeps the logical browsing position across day and week switches` 覆盖，本次实跑通过（6.0s）。

### 9.2 订正：§6.4 第 1 条已不再适用

§6.4 称「Playwright 自带 Chromium 未安装且下载被限速」。复核时 `%LOCALAPPDATA%\ms-playwright` 已有 `chromium-1228` 与 `chromium_headless_shell-1228`，因此**直接 `npm run test:e2e` 即可**，无需 `channel: "chrome"` 的临时配置。§6.4 的复跑请求已履行并通过。

### 9.3 订正：§6.4 第 2 条的成因（结论「与本次改动无关」成立）

`npm run test:native` 失败**可复现**，且 `Cargo.toml`／`Cargo.lock`／`src-tauri/` 在本包中**零改动**（`git status` 可证），故 HEAD 同样失败 —— 「与本次改动无关」成立。但成因不是笼统的「工具链问题」，已定位到具体机制：

- `indexmap 1.9.3` 的 `build.rs` 在未启用 `std` feature 时走 `autocfg::new().emit_sysroot_crate("std")` 探测；该探测在 rustc **1.97.1** 下未能 emit `has_std`。
- 于是编译的是 `#[cfg(not(has_std))]` 那一份 `pub struct IndexMap<K, V, S>`（`S` 无默认值），而 `schemars 0.8.22` 写的是 `indexmap::IndexMap<K, V>` → E0107。
- **`scripts/with-msvc-env.sh` 不能绕过**（已实测，报同一错误）—— 它不是缺 MSVC 链接器的问题，而是依赖的 build script 探测失败。

影响：`npm run check` 无法整体跑通，`npm run tauri build` 在本机同样会失败。这是**先于本包存在**的仓库级风险，应在 P4-10（原生验收与发布）之前单独处理，不影响 P4-05（纯前端设置工作）。

### 9.4 观察到的一处偶发

全量 Vitest 首跑出现 **1 例失败**：`src/App.test.tsx` 的 `uses Ctrl plus wheel for continuous calendar zoom while an ordinary wheel only browses`（`waitFor` 断言 `data-calendar-scale` 超时）。该用例**隔离运行通过**（462ms）、`App.test.tsx` 单文件运行 **83/83 通过**、全量重跑 **180/180 通过**。判定为**满载并行下的时序抖动**，非本包回归；但本包新增了第 17 个测试文件、抬高并行负载，属诱因之一。留作回归背景，必要时后续单独收敛该用例的等待条件（不放宽断言）。

### 9.5 复核未发现的问题

`useCalendarViewport.ts` 的优先级表、generation 失效、拖拽延后、等待可测量、程序化写入区分等实现与规格 §5.2 一致；`calendarTimeline.ts` 的映射提取保留了**单一实现**（闭包改为调用导出函数，既有 5 个用例仍通过）；`App.tsx` 的接线完整（`captureZoomAnchor`、`revealNow`、`revealSession`、`flush`、`noteProgrammaticPosition` 均已接入）；文档同步按协议执行，未发现把未来功能写成已实现。
