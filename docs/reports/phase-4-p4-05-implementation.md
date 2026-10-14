# 阶段 4 P4-05 实施报告：新偏好与合法值配置、日历浏览位置持久化及旧设置恢复

日期：2026-10-14。对应工作包：P4-05（`docs/specs/0005-phase-4-daily-workflow-and-reliability.md` §10），依赖：P4-04。
状态：**代码、测试与验证已完成**；AC05 的「退出重开各自恢复」在本包补齐后成立。

## 1. 范围

按开工提示词交付八项：

1. 新增 `calendarPositions` 偏好：`{ day: CalendarPosition | null, week: CalendarPosition | null }`，默认两项皆 `null`。
2. 规范化（「合法值配置」）：`date` 必须是真实有效的本地日期，`minute` finite 且 0–1440，`viewportRatio` finite 且 0–1；任一项不合法该项回退 `null`；未知字段忽略。
3. 写入：用户滚动停止 300ms 后的采样值经 `SettingsRepository` 的 `writeQueue` 串行写入（沿用既有顺序写入，未另建通道）；程序性滚动不写偏好。
4. 跨启动恢复：设置加载后把偏好里的 `calendarPositions` 播种到 `useCalendarViewport` 的内存位置。
5. 恢复备份后对齐：协调恢复换掉偏好后，内存浏览位置随之换掉，不残留恢复前的位置。
6. 旧设置／旧备份缺少该字段 → 默认值，不抛错、不伪造位置。
7. 备份：新偏好随现有 `backup_preferences` 一并备份；**未**扩充 SQLite 核心表、**未**新增迁移（schema 仍为 v7）、**未**新增 Tauri Command、**未**新增依赖。
8. AC07 保持成立，并为 `calendarPositions` 补同类回归。

明确未做（越界项）：不改排程事实；不改 `useCalendarViewport` 的仲裁优先级、generation 语义与采样口径（取视口中心、折叠条取中点）；不动 M10／M11；不改缩放范围与预设；**未**新增 `PageId = "deadlines"`（无对应页面时先加会产生点不到的死入口，规格 §6.2 也要求三处同步点一致，留给 P4-06）。

## 2. 交付清单

| 文件 | 变更 |
| --- | --- |
| `src/lib/settings.ts` | 新增 `CalendarPosition`／`CalendarPositions`／`ReviewPeriod` 类型、`calendarPositions` 默认值与 `normalizeCalendarPositions`（含 `normalizeCalendarPosition`）；按 §4.4 的决策补 `reviewPeriod`／`reviewAnchorDate` 的默认值与规范化。 |
| `src/hooks/useCalendarViewport.ts` | 位置类型改由设置层提供并再导出（不再两处各写一份）；新增 `seedCalendarPositions()`；新增 `onPositionSettled` 回调与「程序性滚动不写偏好」闸门（`programmaticSettleTopRef`／`userScrollRef`／`markProgrammaticSettle()`）。 |
| `src/App.tsx` | 设置加载后 `seedCalendarPositions(savedPreferences.calendarPositions)`；新增 `rememberCalendarPosition` 并经 `persist`（同一条 `writeQueue`）写入；`CalendarPage` 接线。 |
| `src/lib/settings.test.ts` | +4 个用例（位置规范化、非法字段拒绝、保存重载恒等、回顾偏好占位）；并把顺序写入用例的载荷扩到新字段。 |
| `src/hooks/useCalendarViewport.test.tsx` | +4 个用例（用户滚动才写偏好、三日缓冲平移不写、缩放锚点补偿不写、播种与覆盖）。 |
| `src/App.test.tsx` | 替换 1 个 P4-04 用例为 3 个（程序性定位不写偏好、用户滚动写入并跨启动恢复、协调恢复后内存对齐）。 |
| `e2e/phase1.spec.ts` | +1 个 AC05 用例（日／周各自跨重启恢复，月视图仍置顶）。 |
| `docs/reports/phase-4-p4-05-implementation.md` | 本报告。 |
| `docs/PROJECT-GUIDE.md` | 按文档同步协议更新 §8／§9／§11／§12，并移除「退出重开不恢复」边界。 |

前端部分无新增依赖、无 SQLite 变更、无 Tauri Command、无 Rust 改动。

## 3. 契约

```ts
// src/lib/settings.ts —— 类型的单一出处（hook 再导出，避免两处定义）
interface CalendarPosition { date: string; minute: number; viewportRatio: number }
interface CalendarPositions { day: CalendarPosition | null; week: CalendarPosition | null }
interface AppSettings { /* … */ calendarPositions: CalendarPositions; reviewPeriod: ReviewPeriod; reviewAnchorDate: string | null }

// src/hooks/useCalendarViewport.ts
seedCalendarPositions(positions: CalendarPositions | null | undefined): void   // 权威覆盖内存位置
useCalendarViewport({ /* …P4-04 既有选项… */, onPositionSettled?: (view: TimelineView, position: CalendarPosition) => void })
```

- **位置的所有权不变**（P4-04 §3）：同一时刻只有一个滚动请求能落地，优先级 1–6 与 generation 语义未动。
- **写入的所有权**（本包新增）：模块级内存是位置的**单一真相**，`calendarPositions` 偏好是它的持久化镜像；只有用户滚动（或切页时「最后一次变化来自用户滚动」）才把内存值交给 `SettingsRepository`。
- `seedCalendarPositions` 是**权威覆盖**而不是「仅在为空时填充」：协调恢复把偏好换成备份快照后，内存必须跟着换成同一份。

## 4. 关键实现决策

### 4.1 「程序性滚动不写偏好」的闸门

P4-04 §4.4 点名要补的闸门落在 `useCalendarViewport` 里，判据是**位置**而不是调用栈：

- `markProgrammaticSettle(scroller)` 记下应用自己刚写下的 `scrollTop`，在四处调用：`applyPosition()`（恢复记忆、进入视图定位、尺寸真变时的重锚）、`noteProgrammaticPosition()`（三日缓冲平移）、缩放锚点补偿之后（优先级 3）、以及上面的重试路径。
- 滚动停止 300ms 落定时，若视口仍停在该位置上（容差 1px），这次位置变化判为程序性：**刷新内存、不写偏好**；否则判为用户滚动并交给 `onPositionSettled`。落定后标记即清除，用户随后的滚动照常写入。
- `flush()`（切页／视图切换时由 `CalendarPage` 调用）只在「该视图最后一次位置变化来自用户滚动」时才补写偏好 —— 否则一次切页就会把刚被恢复或首次定位过的程序性位置记成用户偏好。

**刻意放行的一项**：优先级 2 的「回到现在／目标时段显露」不被闸门拦截。提示词列举的四类程序性滚动（恢复记忆、三日缓冲平移、进入视图定位、缩放锚点补偿）不含它，而它是用户明确请求的落点；因此它落定后会写偏好。这一点在 §5 与 §7 都留了记录，需要改口径时改一处判据即可。

### 4.2 内存与偏好不出现两套真相

- 内存值**会**被程序性滚动刷新（它记录的就是视图实际所在的位置，P4-04 §4.4），因此「内存 = 视图实际位置」始终成立。
- 偏好只由用户滚动驱动，因此「偏好 = 用户最后挑选的位置」。两者语义不同、都不是另一方的副本，App 也不再保留第二份位置状态（没有新增 React state）。
- 跨启动／协调恢复走 `seedCalendarPositions`，把偏好写回内存。恢复备份当前是 `window.location.reload()`（`App.tsx` 的 `confirmRestore`），模块内存随之重建并由偏好播种，所以恢复后不可能残留恢复前的位置；用例额外覆盖了「不 reload 而直接换偏好」的情形。

### 4.3 规范化为什么按「项」回退

`normalizeCalendarPositions` 逐视图独立处理：一个视图的位置坏了不影响另一个；项内任一字段不合法就整项回退 `null`。日期用既有的 `isLocalDate()`（`Date.UTC` 回读三字段，拒绝 `2026-02-30`／`2026-13-01`／不补零），与 `calendarAnchors` 同一判据。`minute` 允许端点 0 与 1440（跨午夜时段），`viewportRatio` 允许端点 0 与 1。

### 4.4 规格 §9 其余新偏好的决策：`reviewPeriod`／`reviewAnchorDate` 现在只加默认值与规范化

**选择：现在加字段与规范化（无 UI、无消费者），不留给 P4-08。**

理由：

1. P4-05 的工作包名就是「新偏好与合法值配置」，规格 §9 把三项新偏好写在同一条兼容策略里（默认值、真实日期校验、未知字段忽略、旧设置缺字段安全回退）。三项在同一处一次落地，只跑一轮规范化与兼容回归，也不必在 P4-08 再动同一个文件的默认值／规范化。
2. 默认值由规格给定（`week`／`null`），没有设计猜测；`reviewAnchorDate` 与 `calendarAnchors` 共用同一套本地日期校验。
3. 这两项**不产生任何界面入口**，因此没有 `deadlines` 那种「点不到的死入口」风险：它们只是 `settings.json` 里的字段，旧应用读取时忽略未知字段，回退后丢失的也只是回顾偏好，不涉及核心事实。
4. 消费者仍在 P4-08（周期选择 UI 与回顾页），本包没有把「日／周／月回顾」写成已实现 —— PROJECT-GUIDE §8 明确标注为「字段已就位，消费者是 P4-08」。

**没有采纳的选项**：整体留给 P4-08。它会推迟兼容策略的落地，使 P4-08 同时承担「周期引擎 + 页面 + 偏好兼容」，而偏好兼容正是本包要单独验证的那一类改动。

`PageId = "deadlines"` 按提示词**未加**：规格 §6.2 要求类型、`normalizeSettings` 的 `lastPage` 校验数组、`App.tsx` 的导航表三处一致，而页面属 P4-06；先加会让三处之一指向一个不存在的页面。

## 5. 刻意行为变化

| 变化 | 原因 |
| --- | --- |
| 日／周浏览位置现在会写进偏好（此前完全不写 Store） | 规格 §5.1「先以 App 层内存保存，通过全部回归后再接入 Store」；AC05 的「退出重开各自恢复」要求持久化 |
| 偏好写入由「用户滚动」独占；`flush()` 也受同一判据约束 | 规格 §5.2「程序性滚动不立即触发偏好保存」；P4-04 §4.4 点名的闸门 |
| `App` 启动时用偏好播种内存位置 | 内存是单一真相，重启后必须从偏好恢复；恢复备份后也必须对齐 |
| `CalendarPosition`／`CalendarPositions` 的定义从 hook 移到 `settings.ts`（hook 再导出） | 它是 `AppSettings` 的字段，且与规范化同源；避免设置层与 hook 各写一份类型 |
| 进入视图且**没有**记忆时，首次定位产生的 scroll 事件不再被记为用户滚动 | 同一道闸门；P4-04 的内存值不受影响 |

P4-04 的仲裁行为与既有回归**全部保持**：优先级表、generation 失效、拖拽延后、等待可测量、用户滚动作废待处理请求、程序化写入不作废恢复、尺寸真变才重锚、月视图置顶、折叠条取中点，以及拖拽／拉伸与边缘自动滚动、Ctrl+滚轮指针锚点缩放、插入后移与整体撤销、三日缓冲、跨页目标显露、「回到现在」全部未动。

## 6. 验证

### 6.1 测试数量

| 层级 | 本次实测 | 本包增量 |
| --- | --- | --- |
| Vitest | **191 / 18 文件** | +10（settings +4、hook +4、App +2） |
| Playwright | **31**（自带 Chromium，`--workers=1`） | +1（AC05 跨重启恢复） |
| Rust | **38 passed / 0 failed** | 0（本包未改 Rust 代码） |
| `tsc --noEmit` + Vite 生产构建 | 通过（`dist` JS 420.73 kB / CSS 74.63 kB） | — |

命令：`npm test`、`node scripts/run-e2e.mjs --workers=1`、`npm run build`；另跑 `npm run check`（= `build` → `test` → `test:e2e` → `test:native`）四步串行，结果见 §6.5。

### 6.2 反向验证（去掉修复即失败）

逐项把修复代码改掉后重跑对应用例，全部如期失败：

| 变异 | 对应用例 | 结果 |
| --- | --- | --- |
| 落定时不再判断 `programmatic`（总是写偏好） | hook「writes a settled position into preferences only when the user scrolled」、hook「…three-day buffer…」、hook「…zoom anchor compensation…」、App「keeps the app's own programmatic positioning out of preferences」 | 4 条失败 ✓ |
| 去掉 `applyPosition` 里的 `markProgrammaticSettle` | App「keeps the app's own programmatic positioning out of preferences」 | 失败 ✓ |
| 去掉 `noteProgrammaticPosition` 里的 `markProgrammaticSettle` | hook「does not write preferences when the three-day buffer shifts the axis」 | 失败 ✓ |
| 去掉缩放补偿后的 `markProgrammaticSettle` | hook「…zoom anchor compensation keeps the pointer's time in place」 | 失败 ✓ |
| 去掉 `App` 载入时的 `seedCalendarPositions` | App「writes a user-scrolled browsing position…next launch」、App「aligns the in-memory browsing position with a coordinated restore…」 | 2 条失败 ✓ |
| 去掉 `CalendarPage` 的 `onPositionSettled` 接线 | E2E「phase 4 M9 restores each timeline view's browsing position after a restart」 | 失败 ✓ |
| `normalizeCalendarPosition` 只按正则校验日期 | settings「rejects browsing positions…」 | 失败（`2026-02-30` 被放过）✓ |
| 去掉 `minute` 范围校验 | 同上 | 失败（`-1` 被放过）✓ |
| 去掉 `viewportRatio` 范围校验 | 同上 | 失败（`-0.1` 被放过）✓ |

### 6.3 AC05 实测（新增 E2E，真实 Chromium，`--workers=1`）

固定窗口 1200×760、比例 48px/小时、`page.clock` 固定到 2026-08-05 14:00。日视图与周视图各自滚动 240px（48px/小时下即 5 小时），等偏好落定（轮询 `localStorage` 的 `daymark.phase0.preferences`），测量视口中心对应的时间，然后**整页重载**再测一次：

| 视图 | 重载前中心时间 | 重载后中心时间 | 误差 |
| --- | --- | --- | --- |
| 日 | 1140 分钟（19:00） | **1140 分钟** | **0 分钟（0 px）** |
| 周 | 1102.5 分钟 | **1102.5 分钟** | **0 分钟（0 px）** |

阈值是「≤1 分钟或 2 CSS px，取较宽松者」，两项都落在 0 px。同一用例还断言：月视图切到再重载后 `scrollTop === 0`（不存时间轴坐标、进入置顶）。P4-04 的「日↔周切换十次不漂移」用例同时保持通过（见 §6.4）。

### 6.4 AC06／AC07 回归

- **AC06**：现有 E2E 全部保持通过 —— 指针锚点缩放（M3，日／周两段）、连续日跨午夜三日缓冲、折叠条临时展开与成功投放、插入后移与整体撤销、真实指针拖拽、落点虚线框、待回顾气泡，以及 P4-04 的日↔周十次往返。缩放前后所有计划对象的序列化结果仍逐字节一致（该断言在 AC05 用例内）。
- **AC07**：`CALENDAR_SCALE_RANGE`／`CALENDAR_SCALE_PRESET` 仍是唯一配置源，`settings.test.ts` 的「预设必须落在合法区间内」回归保持通过；本包未触碰缩放规范化与滚轮钳制。新增位置偏好同样满足「保存重载恒等 + 非法安全回退」（`keeps the browsing positions identical through save and reload`）。
- **AC16 相关部分**：顺序写入由 `SettingsRepository.writeQueue` 承担，顺序用例的载荷已扩到新字段（慢的旧写入不能盖掉新位置）；写入失败的「未保存／重试」路径由既有 `keeps changed settings visible and reports an unsaved write` 覆盖（位置写入与其它偏好共用同一条 `persist`，没有另建通道）；旧备份缺少该字段 → 默认值（`accepts day and week browsing positions and falls back per view`）；协调恢复不残留恢复前的位置（App 对齐用例）。

### 6.5 `npm run check`

四步串行执行，**exit 0，四步全绿**（总耗时 2m15s）。本包开工提示词里「`npm run test:native` 在本机无法编译」的前提**已不成立**，详见 §8.1。

实测记录：

```
npm run build   → tsc --noEmit + vite build 通过（JS 420.73 kB / CSS 74.63 kB）
npm test        → 191 passed / 18 files
test:e2e        → 31 passed (52.7s, --workers=1)
test:native     → 38 passed; 0 failed (27.87s)
```

`test:native` 这次出现一条既有告警（`error copying object file … full.rmeta … 拒绝访问 (os error 5)`，来自 `target/debug/incremental`），与 P4-04 §6.4 第 3 条记录的增量缓存问题同源，只影响增量写入、不影响编译与结果（38 通过）。

## 7. 未做与边界

- **月视图仍不存时间轴坐标**：只保证进入时置顶（与规格 §5.1 一致）。
- **优先级 2 的显露会写偏好**：见 §4.1 末尾的说明。如果产品口径要求「任何应用发起的滚动都不写偏好」，改 `markProgrammaticSettle` 的调用点即可，但会牺牲「用户被带到某处后下次仍回到该处」。
- **拖拽边缘自动滚动**产生的 scroll 事件按用户手势处理（会写偏好）；拖拽期间低优先级请求仍被延后，仲裁语义未变。
- **`scrollLeft`** 仍只在首次定位时归零，未纳入逻辑坐标（规格的 `CalendarPosition` 只有纵向与日期）。
- **窗口尺寸真变时的重锚**会刷新内存但（作为程序性滚动）不写偏好；尺寸变化后用户再滚动才更新偏好。
- **日视图显示模式切换（全天↔默认时段）** 仍不重新落位（P4-04 既有边界）。
- **临时展开、筛选、焦点**等会话状态仍不进入位置记忆。
- **回顾偏好无 UI**：`reviewPeriod`／`reviewAnchorDate` 只做默认值与规范化，消费者是 P4-08；当前「7 天回顾」页面仍按最近七日固定计算，不读取这两项。
- **`PageId = "deadlines"` 未加**（属 P4-06）。

## 8. 发现的不一致

### 8.1 开工提示词里的原生层前提已过期（代码／环境，非本包引入）

提示词称「`npm run test:native` 在本机无法编译：第三方 crate `schemars 0.8.22` 在 rustc 1.97.1 下报 E0107 …… `npm run check` 因此无法整体跑通」。**该前提在本包开工时已不成立**：

- `src-tauri/Cargo.toml` 的 `[build-dependencies]` 已按 P4-04 §6.4 第 2 条显式声明 `indexmap`（带 `std`），并由 `src/lib/nativeBuildConfig.test.ts` 守住。
- 本包实测 `npm run test:native`：**38 passed / 0 failed**（22.54s），编译正常。
- 因此 `npm run check` 可以整体跑通（§6.5）。

本包按提示词的「各步分开执行并记录」照做了（`npm test`／`test:e2e`／`build`／`test:native` 分别执行），并额外跑了完整的 `npm run check`。**结论：P4-04 §9.3 的「`npm run check` 无法整体跑通」与开工提示词的同一表述都应视为过期**；P4-04 报告 §9 顶部 2026-10-14 的收尾说明（「已不再成立……实测四步全绿」）才是当前事实。这属于文档层面的滞后，本包已在 §6.5 与本报告留痕。

### 8.2 P4-04 的一条 App 用例与本包行为直接冲突（已按新行为替换）

`src/App.test.tsx` 的「keeps the browsing position in memory only and never writes it into preferences」断言 `backend.value` **不含** `calendarPositions` 字段。本包一旦让偏好承载浏览位置，该断言在语义上就不再成立（任何一次偏好保存都会写出该字段）。已把它替换为「程序性定位不写偏好」＋「用户滚动写入并跨启动恢复」＋「协调恢复后内存对齐」三条，覆盖范围比原来更宽：原来只证明「不写」，现在同时证明「该写的写、该挡的挡」。

### 8.3 文档滞后

- `docs/PROJECT-GUIDE.md` §2 与 §3 的已知边界写着「日／周各自的浏览位置……退出重开不恢复（`calendarPositions` 偏好与旧设置回退属阶段 4 P4-05）」——本包已按文档同步协议移除该条并改写为已实现能力。
- §8 的偏好列表、§9 的备份说明、§11 的测试数量、§12 的修改入口已同步。

## 9. 仍需用户决定

1. **优先级 2 的显露（「回到现在」／目标时段显露）是否也应不写偏好**：本包按提示词的字面范围放行（四类程序性滚动不含它）。若要一并拦住，改一处判据即可，但会改变「用户被带到某处后下次仍回到该处」的行为。
2. **`reviewPeriod`／`reviewAnchorDate` 的落点**：本包按 §4.4 的理由现在只加默认值与规范化；若希望整体留给 P4-08，需要回退这一小段（类型、默认值、规范化与对应用例）。
3. **`npm run check` 是否重新作为本阶段的统一门槛**：§8.1 表明原生层已可编译；本包已实测四步全绿，但开工提示词仍按「分开执行」要求。若确认以 `check` 为准，后续工作包可省掉这条例外说明。
