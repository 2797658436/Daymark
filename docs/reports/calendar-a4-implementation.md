# 日历整改 A4 实施记录：单条吸顶日期带、有效日折叠、上一天带子与密度预设

实施日期：2026-10-25。范围：`docs/reports/calendar-a4-kickoff-prompt.md` 的交付 1–5（F05 吸顶日期带、F08 有效日折叠、F08③ 上一天吸顶带、D4 密度预设、F11 视觉对齐）。上游评估见 [`calendar-evaluation-2026-10-24.md`](calendar-evaluation-2026-10-24.md)，A1／A2／A3 的既有改动见 [`calendar-a1-implementation.md`](calendar-a1-implementation.md)、[`calendar-a2-implementation.md`](calendar-a2-implementation.md) 与 [`calendar-a3-implementation.md`](calendar-a3-implementation.md)。全程未 `git commit`，未动用户工作区里 A1–A3 留下的未提交修改。

## 1. 结果摘要

| 交付 | 状态 | 一句话结果 |
| --- | --- | --- |
| 1 · F05 44px 吸顶日期带 | 完成 | 分隔条（40）+ 日头（52）+ 时间轴占位块合并成**一条 44px 带**，带上有「日期 · 周几 · 今天 · N 项安排 · 投入 Hh Mm」；`z-index` 19／20 两档合并为 20，M13 两条用例仍绿。 |
| 2 · F08 有效日折叠 | 完成 | 全天模式下 `00:00–06:00` 与 `23:00–24:00` 在该日无安排／无时间块／无记录且「现在」不在其中时折成 44px 折叠带（文案「凌晨 · 无安排」「深夜 · 无安排」），带「展开整天」入口；默认时段模式语义一字未改。 |
| 3 · F08③ 上一天吸顶带 | 完成 | 三日缓冲的前一天不再渲染 1728px 网格，只留一条 44px 带子；带上有「展开」入口，向上滚到顶也触发展开，展开后保持不回缩，且**展开那一次手势不改锚点**。 |
| 4 · D4 密度预设 | 完成 | `CALENDAR_SCALE_PRESET` 日／周改为 compact 60 / standard 84 / detailed 108；`CALENDAR_SCALE_RANGE`（28–192）与月视图档位不动；老偏好里已存的连续值（含旧的 72）原样保留。 |
| 5 · F11 视觉对齐 | 完成 | 日历段渲染出的正文全部 ≥ `.75rem`（探针实测 `smallTextCount = 0`）；`.calendar-session` 改 10px 圆角 + `--line-soft` 描边 + 左侧 3px 分类色条；状态图标 + 文字双编码不变；全局 token 的值一个没动。 |
| 附带修正 | 完成 | ①「今天」药丸的白字压 `--accent` 在浅／深两主题分别只有 **3.61／2.47**（原先藏在 52px 日头里很少入镜，药丸上移到**每屏都在视口里**的吸顶带后才暴露）→ 改成同家族的「柔底 + 强墨」，实测 **4.89／6.95**；②`.calendar-session.missed` 的整圈 `border-color` 把左缘分类色条盖掉（2.67 < 3:1）→ 左色条改为在 `.missed` 之后重新声明，实测 **3.97／5.18**。 |
| 未达成 | 2 项 | `day-full-1200` 的 `visibleHours ≥ 8` 与 `scrollHeightsOfOneDay ≤ 2` 在 84px/小时 + 654px 窗口下**算术上不可能同时成立**，见 §9。 |

## 2. F05：一条 44px 吸顶日期带

### 2.1 组件与字段来源

`CalendarDayBand`（`src/App.tsx:1451`）取代原来的两层：

```
连续日面板（.continuous-day-panel）
├─ header.calendar-day-band           ← 唯一吸顶层（sticky top:0，z-index:20，2.75rem）
│  ├─ strong.calendar-day-band-date    「8月5日」 + span「周三」
│  ├─ span.calendar-day-band-today     「今天」药丸（只在锚点=今天时出现）
│  ├─ span.calendar-day-band-summary   「8 项安排 · 投入 6h」（带 title 全文）
│  └─ button.calendar-day-band-expand  「展开」（只有折叠的前一天带子有）
└─ .calendar-grid.day（时间轴 + 轨道）
```

**带上的数字全部来自既有纯函数，组件里不另算一遍**：

| 带上的段 | 来源 | 出处 |
| --- | --- | --- |
| 「8月5日」「周三」 | `formatShortDate` / `weekday`（`Intl.DateTimeFormat("zh-CN")`） | `App.tsx` 既有日期工具 |
| 「今天」药丸 | `date === toLocalDate(now)` | 与日头原来同一判据 |
| 「N 项安排」 | `calendarDaySummary(workspace, date, today).scheduledSessions.length` | `src/lib/calendarSummary.ts:101` 附近；`scheduledSessions` 已排除 `missed`／`cancelled`／`skipped` |
| 「投入 Hh Mm」 | 同一次 `calendarDaySummary` 调用新增的 `scheduledMinutes`（各时段本地起止分钟差求和，跨午夜按时段自身时长） | `calendarSummary.ts:22,101`；格式化用新增的 `formatCompactMinutes`（`2h10m`／`3h`／`45m`，0 返回空串） |
| 无障碍名 | `aria-label="8月5日星期三 · 8 项安排 · 投入 6h"`（折叠的前一天带子前缀「前一天 」） | 读屏与 `elementFromPoint` 用例都拿它定位 |

`count === 0` 时写「无安排」而不是「0 项安排」，投入为 0 时整段不出现（评估基准 3「同一句话不写两遍」）。

### 2.2 删掉的双层结构

- `.continuous-day-separator`（40px，`formatLongDate`）—— 删除。
- `.calendar-day > header`（52px，周几 + 日号药丸）—— 删除；`CalendarDay` 不再自带头部。
- `.day-head-spacer`（时间轴一侧的 52px 占位块）—— 删除；`CalendarTimeAxis` 的签名从 `{ timeline, spacerHeight }` 收成 `{ timeline }`，`.time-axis, .calendar-day { grid-template-rows: 1fr }`，时间轴与轨道天然同起点，不需要第二条占位。
- `+52px` 的面板高度补偿（`DayCalendarGrid` 给 `.calendar-grid` 加的额外高度）—— 一并去掉，轨道高度就是时间轴高度。

### 2.3 图层表与三档规则

`src/styles.css` 的图层表里原 19（吸顶日期头 + 占位块）与 20（分隔条 + 周吸顶头）**合并成一档 20**：

| 档 | 元素 | 说明 |
| --- | --- | --- |
| 0–10 | 轨道内容（当前安排 5／待回顾 6／实际记录 7／当前时间线 8／折叠区间 9／展开按钮 10） | 不变 |
| **20** | **`.calendar-day-band`（含「今天」药丸）／`.week-sticky-header`** | 19 与 20 合并：带子内部不再需要「分隔条压日期头」这一层关系 |
| 22 | 覆盖式详情面板 | 不变 |
| 24／35 | 临时拖拽层 | 仍高于吸顶带 |
| 30 | 「回到现在」浮动按钮 | 不变 |

三档规则逐条复核：吸顶带（20）> 轨道内容（0–10）✓；临时层（24／35）> 吸顶带 ✓；原「分隔条 > 日期头」这一条随两层合并而**消失**（同一条带内部没有先后问题）。回归判据仍是 `document.elementFromPoint`，见 §8.4 与 §8.5。

## 3. F08：有效日折叠（全天模式）

### 3.1 判定：只看该日真实存在的事实

`DayCalendarGrid` 在 `calendarDayMode === "fullDay"` 时收集**占用区间**（`src/App.tsx:1495`）：

| 事实 | 取法 | 备注 |
| --- | --- | --- |
| 执行时段 | `executionSessions` 中 `localDate === date` 且状态不是 `cancelled`／`skipped` | `end <= start` 视为到 `24:00`（跨午夜时段） |
| 时间块 | `timeBlocks` 中 `localDate === date` | 同上 |
| 实际记录 | `actualRecordSlice(record, date, now)` 的起止分钟 | 与轨道上真正画出来的那一段同源，跨日记录按当天窗口切 |
| 进行中的时段 | `sessionContains(session, now)` | 保证「正在做」的那一段一定展开 |
| 被显露的目标时段 | `focusSessionId` 对应时段 | 跨页跳转／提醒定位不能落在折叠条里 |

交给 `fullDayEffectiveRanges({ occupiedRanges, currentMinute })`（`src/lib/calendarTimeline.ts:86`）：从 `[{0,1440}]` 起，对 `FULL_DAY_FOLD_RANGES`（`0–360`、`1380–1440`）逐条判断——**被占用**或**当前时间落在其中**就不折，否则从有效范围里减掉。`currentMinute` 只在锚点日=今天时传入，非今天传 `null`（昨天的凌晨该折就折）。

### 3.2 折叠带怎么进布局

`createCalendarTimeline` 新增 `fullDayRanges` 入参：`mode === "fullDay"` 时用它替代写死的 `[{0,1440}]` 作为 `defaultRanges`，其后的补集、临时展开、显露与像素映射**一行未改** —— 折叠段仍然是既有的 `collapsed: true` 段，高度仍是 `COLLAPSED_GAP_HEIGHT = 44`。

关键的一处是 `DayCalendarGrid:1542`：

```ts
const foldsEffectiveDay = preferences.calendarDayMode === "fullDay"
  && !fullDayRanges?.some((range) => range.start === 0 && range.end === 1440);
const activeTimeline = preferences.calendarDayMode === "defaultSlots" || foldsEffectiveDay ? timeline : undefined;
```

- 全天模式**没有折叠任何东西时仍然走原来的百分比布局**（不建映射，零像素差），只有真折了才切到分段映射 —— 折叠条、卡片偏移与滚动采样必须共用同一套像素，否则三者各自换算。
- 判据看「有效范围是否还覆盖整天」，而不是「当前有没有折叠条」：两端都折时范围会合成一整段 `[{360,1380}]`（数条数会算错），而用户手动展开整天后范围仍是拆开的，映射要留着，「收起凌晨／收起深夜」才继续点得到。

### 3.3 文案与入口

| 元素 | 全天模式（新增） | 默认时段模式（不变） |
| --- | --- | --- |
| 折叠条主体 | `凌晨 00:00–06:00 · 无安排` / `深夜 23:00–24:00 · 无安排`（可见文字「凌晨」+「无安排」） | `00:00–09:00 · 0 项安排` |
| 类名 | `.collapsed-time-gap.effective-day-gap` | `.collapsed-time-gap` |
| 主按钮 | `button.collapsed-gap-main`（点击=临时展开该段，拖拽悬停 500ms 展开、拖离回缩、成功投放后保留 —— 全部沿用既有机制） | 同左 |
| 整天入口 | 第一条折叠条上多一枚 `button.effective-day-expand`「展开整天」（一次展开该日全部折叠段） | 无 |
| 收起 | `收起 00:00–06:00`，可见文字「收起凌晨」／「收起深夜」 | 「收起非默认时段」 |

「展开整天」与所有临时展开一样**只活在 React 状态里**，不落偏好（UI-SPEC §129）；E2E 与组件测试都断言 `JSON.stringify(preferences)` 不含 `expandedGap`。

### 3.4 默认时段模式的语义边界

`defaultSlots` 的 `defaultRanges` 仍由默认时段合并得出，`fullDayRanges` 在该模式下是 `undefined`、`createCalendarTimeline` 不读它；`currentRange`（今天 ±60 分钟）也仍只在 `defaultSlots` 下参与展开。M4 用例的可访问名（`00:00–19:00 · 1 项安排`、`收起 00:00–19:00`）因此一字未改。

## 4. F08③：上一天只留一条带子

### 4.1 渲染门与展开

`ContinuousDayView`（`src/App.tsx:1436`）：

```ts
const collapsedPrevious = date === previousDate && !previousExpanded;
<section className={`continuous-day-panel ${collapsedPrevious ? "is-previous-collapsed" : ""}`}>
  <CalendarDayBand … collapsed={collapsedPrevious} onExpand={collapsedPrevious ? expandPreviousDay : undefined} />
  {!collapsedPrevious && <DayCalendarGrid … />}
</section>
```

`.continuous-day-panel.is-previous-collapsed { min-height/height: 2.75rem }` —— 前一天从 1728px（现 1516px）收成**一条 44px**。展开有两个入口：带子上的「展开」按钮（`aria-label="展开前一天 8月4日星期二"`），以及**停在内容顶端时继续向上滚**（`onWheel`，`deltaY < 0` 且非 `Ctrl`）。展开后 `expandedPreviousDate` 记住的是**日期**，锚点一变自然失效，且没有任何回缩路径。展开状态不写偏好。

### 4.2 展开时视口不跳

`useLayoutEffect`（`App.tsx:1381`）在展开后把新增高度补进 `scrollTop`：`axis.scrollTop = info.scrollTop + delta` 并上报 `onProgrammaticPosition()`（这次滚动不是用户滚动）。**用户停在顶端（`info.scrollTop === 0`）时不补** —— 那一次滚动的意图就是「把昨天铺在下面给我看」，补回去等于什么都没发生。

### 4.3 展开那一次手势不改锚点（过程中发现并修掉的不确定行为）

三日缓冲原有的平移判据是 `axis.scrollTop < middleStart` ⇒ 锚点退一天。带子展开后前一天整块网格压在视口上方，`scrollTop` **天然**低于中段起点 —— 于是否发生平移取决于「点按钮前停在哪」：停在中间（补了 `scrollTop`）不跳，停在顶端就跳。实测探针里点一次「展开」，标题从「8月5日 周三」变成「8月4日 周二」。

修法是把这一次越界吞掉（`suppressPreviousShift`）：`expandPreviousDay` 置位，`onScroll` 在 `scrollTop < middleStart` 且该位为真时清位并返回；任何一次 `scrollTop >= middleStart` 的滚动也会清位。于是：

- 点「展开」／顶端向上滚触发展开 ⇒ **只展开，不改锚点**；
- 之后用户先滚回今天、再向上越过中段起点 ⇒ 仍按 A1 之前的三日缓冲语义平移锚点（E2E 新增断言钉住这一条）。

### 4.4 采样与「折叠条取中点」

`measureTracks`（`src/hooks/useCalendarViewport.ts:726`）在日视图里先找 `.calendar-day-band.is-collapsed`：带子不是时间网格，但它代表**一整天都折叠在这里**，于是按带子自身高度合成一条轨道，分段为 `{ start: 0, end: 1440, collapsed: true }`：

```ts
tracks.push({ date: trackDate, offsetTop: bandRect.top - viewport.top + viewport.scrollTop,
  height: bandRect.height, segments: [{ start: 0, end: 1440, collapsed: true, gapKey: "0-1440", top: 0, height: bandRect.height }] });
```

- 采样落在这条带子上 ⇒ 走既有的「折叠段取中点」分支 ⇒ `minute = 720`，不随 1px 滚动跳变；
- 恢复时 `scrollTopForCalendarPosition` 落回带子的像素中点，**不需要先展开前一天**；
- 带子不在采样点之下时（正常 600px 视口里中心永远落在锚点日轨道上）它只是候选轨道里最近的一条，`pickTrack` 的边界钳制 + `viewportRatio` 记录边缘屏幕比例，恢复仍回到顶端。

新增用例（`src/hooks/useCalendarViewport.test.tsx`）：

1. `samples the previous-day sticky band as one collapsed strip and round-trips from its top` —— 纯函数：44px 带子 + 0–1440 折叠段，中心落在带上取 720，恢复落回 `scrollTop = 0`，重采样仍是 720。
2. `samples and restores the collapsed previous-day band at the top of the day axis` —— 组件级：把 harness 的日视图改成「前一天只有带子」的真实结构（`daySpecs` 同步改成 44/90/1288 的偏移），用 80px 高视口让中心真的落进带子，断言采样与偏好写入拿到的是**前一天 720**，卸载重开后恢复仍停在带子（`scrollTop 0`）而不是被拽回今天 12:00。

## 5. D4：密度预设与迁移说明

```ts
// src/lib/settings.ts:282
day:  { compact: 60, standard: 84, detailed: 108 },
week: { compact: 60, standard: 84, detailed: 108 },
month:{ compact: 80, standard: 120, detailed: 160 },   // 不动
CALENDAR_SCALE_RANGE = { day: [28,192], week: [28,192], month: [52,160] }   // 不动
```

迁移语义（`settings.test.ts` 三条断言）：

| 输入 | 结果 | 为什么 |
| --- | --- | --- |
| 缺失 `calendarScale` | 日／周 84、月 120 | 默认值直接取新预设 |
| 只有 `calendarZoom: "compact"`、没有连续值 | 60 | 档位→预设的新映射 |
| 已存 `{ day: 72, week: 48 }` | 原样保留 72／48 | 72 与 48 都仍在 28–192 内，`normalizeCalendarScaleValue` 不判非法 → **不覆盖用户自己滚出来的比例** |
| 已存 72 后点「详细」 | 108 | 点档位是明确意图，按新预设写值 |

`DEFAULT_SETTINGS.calendarScale` 同步改为 `{ day: 84, week: 84, month: 120 }`。因为默认小时高从 72 抬到 84，`App.test.tsx` 里两处按像素反推分钟的用例改为**显式写入** `calendarScale.day = 72`（拖拽落点两条）与把滚轮缩放断言从 84→88 一档，避免把「预设变了」误读成「吸附算错了」。

## 6. F11：视觉对齐与配色实测

### 6.1 字号

日历段渲染出的文字全部抬到 `.75rem` 及以上：探针在 1200×800／960×640／200% 的日、周场景里逐个叶子节点量 `fontSize / rootFontSize`，**`smallTextCount = 0`**（`output/2026-10-25_calendar-a4/audit.json`）。改动集中在 `.calendar-session` 的 `time`/`strong`/`.session-*`、折叠条文案、`.expanded-gap-toggle`、`.calendar-day-band-*`、时间块与全天胶囊；`styles.css` 里 `.66/.68/.7rem` 的残留都在日历段之外（任务池、回顾、按钮内边距），本包不动。

### 6.2 卡片语言

```css
.calendar-session { border: 1px solid var(--line-soft); border-left: 3px solid var(--session-category, var(--accent-strong)); border-radius: 10px; }
```

- 圆角 7px → **10px**（评估基准 10 的 14px 是静止大卡，卡片在 24px–200px 高的时间轴里，取 10px 与描边/阴影同时成立）。
- 描边 `--accent` 系 → **`--line-soft`**。
- 左缘 **3px 分类色条**：`--session-category` 由 `CalendarSession` 按 `calendarProjectColor(projects, projectId)` 写入内联变量 —— `var(--chart-{(index % 6) + 1}-ink)`，无项目/未知项目回退 `--muted-strong`。
- 状态类（`current-schedule`／`pending-review`／`completed`／`missed`／`targeted-session`／`overlap-target`／`planned-outline`）各自改整圈 `border-color`，因此新增一条**后置**规则把这七类的 `border-left-color/style/width` 钉回分类色：状态靠描边粗细、虚实与底色区分，色条只表分类。
- 状态图标 + 文字双编码保持现状。

### 6.3 分类色的真实来源（与开工文档的出入）

开工提示写「分类色来源与任务池色条同源」。**任务池没有色条**（`grep` 全仓无 `.task-card` 一侧的分类色边），项目身份色唯一成文的使用处是回顾页：`review-page.tsx:384` 的 `projectColorOf`（扇区/色点用 `--chart-N`）与 `:390` 的 `projectInkOf`（**文字**用 `--chart-N-ink`）。日历卡片是「文字压在卡底上的小面片」，因此对齐 `projectInkOf` 的取法（同色相深版，P4-13 立过规则：**扇区原色当正文只有 2.4–3.9:1，过不了 AA**）。这条出入按「与回顾项目身份色同源」执行，未新增 token、未改全局值。

### 6.4 对比度实测（headless Chromium + 生产构建，WCAG 相对亮度自己算）

| 目标 | 类型 | 阈值 | 浅色 | 深色 |
| --- | --- | --- | --- | --- |
| 吸顶日期带 · 日期 | 文字 | 4.5 | **14.94** | **12.26** |
| 吸顶日期带 · 当日摘要 | 文字 | 4.5 | **7.28** | **8.51** |
| 吸顶日期带 · 「今天」药丸 | 文字 | 4.5 | **4.89**（改前白字压 `--accent` 只有 **3.61**） | **6.95**（改前 **2.47**） |
| 折叠带 · 文案 | 文字 | 4.5 | **13.19** | **10.00** |
| 分类色条 #1（毕业设计） | 边界 | 3 | **3.97** | **5.18** |
| 分类色条 #2（Rust 系统编程） | 边界 | 3 | **4.05** | **6.63** |
| 分类色条 #3（独立任务 `--muted-strong`） | 边界 | 3 | **6.70** | **7.79** |

原始数据：`output/2026-10-25_calendar-a4/measurements.json` 的 `cal-day-full-1200.palette`／`cal-day-full-1200-dark.palette`。量法：文字取自身不透明背景（药丸压 `--accent-soft`，不是压带子底色），色条取所在卡片背景；`border-left-color` 与背景按 WCAG 公式算比值。

「今天」药丸的改法值得单独记一句：**元素上移到常驻可见位置之后，原本永远不会被 axe 看到的配色才暴露出来**。这跟 §10 里 axe「不评估屏幕外元素」是同一条规律的反面 —— 常驻吸顶的东西必须按常驻可见的标准量对比度。

## 7. 结构账：改前 / 改后

### 7.1 A4 自身的账（A3 收口态 → A4 收口态）

A1–A3 已经把「网格前 chrome」从 184px 压到 108px（200% 下 453 → 176）。A4 只动网格**内部**：

| 场景（1200×800，日·全天） | 吸顶占用 | 可画时间的高度 | 一天轨道高 | 一天=几屏 | 一屏小时数 |
| --- | --- | --- | --- | --- | --- |
| A3 收口态（72px/h、双层吸顶、不折） | 92 | 564 | 1728 | 2.64 | 7.83 |
| A4 收口态（84px/h、单条带、折凌晨/深夜） | **44** | **612** | **1516** | **2.32** | 7.26 |
| A4 收口态 · 紧凑档（60px/h） | 44 | 612 | 1108 | **1.69** | **10.17** |
| A4 收口态 · 详细档（108px/h） | 44 | 612 | 1924 | 2.94 | 5.65 |
| A4 收口态 · **一段都不折**的日（84px/h，凌晨与深夜各有安排） | 44 | 612 | **2016** | 3.08 | 7.26 |

拆开看 A4 的三个来源：吸顶合并 **+48px** 可用高度（564 → 612，+8.5%）；有效日折叠把一天从 24 小时压到 17 小时 + 88px（2016 → 1516，**−24.8%**，未折叠的日仍是 2016 —— 这一条第一次实测是 **2068**，`+52px` 的日头补偿残留在 CSS 基线里没删干净，见 §10.7）；D4 把每小时从 72 抬到 84，**按设计**换掉约 12% 的一屏小时数换可读性。

### 7.2 与评估基线（2026-10-24，A 轮开工前）的整轮对照

`output/2026-10-24_calendar-assessment/audit.json` → `output/2026-10-25_calendar-a4/audit.json`（同名场景）：

| 场景 | 网格前 chrome | chrome 占比 | 网格内吸顶 | 可画时间的高度 | 一天=几屏 | 一屏小时数 |
| --- | --- | --- | --- | --- | --- | --- |
| 日·全天 1200 | 184 → **108** | 23.0% → **13.5%** | 92 → **44** | 488 → **612** | 2.99 → **2.32** | 8.03* → 7.79*（净视口 7.26） |
| 日·全天 960 | 237 → **108** | 37.0% → **16.9%** | 92 → **44** | 275 → **452** | 4.74 → **3.07** | 5.06 → 5.88（净视口 5.36） |
| 日·全天 200% | 453 → **176** | 56.6% → **22.0%** | 97 → **88** | 214 → **500** | 5.59 → **2.59** | 4.30 → 6.98（净视口 5.93） |
| 日·默认时段 1200 | 184 → **108** | 23.0% → **13.5%** | 92 → **44** | 488 → **612** | 1.10 → 1.10 | 7.63 → 7.42（净视口 7.26） |
| 周 1200 | 184 → **108** | 23.0% → **13.5%** | 122 → 122 | 458 → **534** | 2.98 → 3.07 | 8.06 → 7.81 |
| 周 960 | 184 → **108** | 28.7% → **16.9%** | 122 → 122 | 298 → **374** | 4.11 → 4.06 | 5.83 → 5.90 |
| 周 200% | 363 → **176** | 45.4% → **22.0%** | 204 → **160** | 197 → **428** | 4.31 → **3.43** | 5.57 → 7.00 |

\* 旧口径的「一屏小时数」没有减掉吸顶头压住的那一条（`visibleTrackPx` 直接取滚动窗口高）。新口径同时给出两个数：`visibleHours`（减掉吸顶带）与 `visibleHoursIncludingBand`（旧口径，便于跨轮比较）。**按旧口径 8.03 → 7.79 看着像退步，按同一条口径重算基线其实是 (654−92)/72 = 7.81 → (654−44)/84 = 7.26**，差额全部来自 D4 抬高的每小时像素。

周视图一栏是**不退化核对**：A4 没碰周视图，`stickyInsideGrid` 仍 122（200% 160），`screens` 因 84px/h 从 2.98 变 3.07（+0.09 屏），小时数与可用高度都变好。

### 7.3 横向溢出（A2/A3 红线）

`hOverflow` 在日视图仍是**同一条 2px**（`.continuous-day-axis` scrollWidth 720 / clientWidth 718 等），与 A3 收口态一致，A4 未新增横向滚动条；`day-slots-1200` 仍为 0。

## 8. 验证

### 8.1 `npm run check`（最终树）

四步全部退出码 0：

1. `tsc --noEmit && vite build` 通过（仅既有 chunk >500kB 提示）。
2. Vitest：**30 个文件 / 407 条全过**（A3 收口 395 → +12）。
3. Playwright：**55 条全过**（A3 收口 53 → +2），含 M4 折叠、M9 三条浏览位置、A1 落点、M13 两条遮挡／14 轮 axe。
4. `cargo test --all-targets`：**48 条全过**（本包纯前端，未动原生层）。

§10.7 那条 CSS 残留是在这轮全绿之后修掉的，修完重跑：`vite build` 通过、Playwright **55/55**（`node scripts/run-e2e.mjs --workers=1`，整轮）、Vitest **407/30**；原生层一行未动，Rust 48 沿用同轮实测。

### 8.2 新增与改写的测试

| 文件 | 变化 |
| --- | --- |
| `src/lib/calendarTimeline.test.ts` | +4：空凌晨/深夜折成 44px 且总高 `17×84+88`；有内容或「现在」落入时不折；「展开整天」等价于逐段展开；`defaultSlots` 不受 `fullDayRanges` 影响。 |
| `src/lib/calendarSummary.test.ts` | +2 断言组：`scheduledMinutes`（同日 120；跨午夜 22:30–01:15 = 165 + 45 = **210**）与 `formatCompactMinutes` 四档。 |
| `src/lib/settings.test.ts` | 预设规范化/保存重载恒等改到新三档（84/60/120、详细 108），并新增「已存连续值 72/48 原样保留」。 |
| `src/hooks/useCalendarViewport.test.tsx` | +2（§4.4），harness 的日视图结构与 `daySpecs` 偏移改成 A4 真实几何。 |
| `src/App.test.tsx` | +5：吸顶带字段与两层删除；有效日折叠 + 展开整天 + 收起 + 不落库；「现在」在凌晨／凌晨有安排时不折；前一天带子展开（含 `aria-label`、面板高度、锚点与偏好不变、不回缩）；顶端向上滚触发展开且 `Ctrl+滚轮` 不顺手展开。另按 §5 调整 3 处几何断言。 |
| `e2e/phase1.spec.ts` | +2：`calendar A4 merges the sticky date band, folds an empty day and buffers yesterday as a band`（真实布局下量 44px 带、折叠后轨道 1516px、展开整天 2016px、前一天 44px 面板、展开后锚点不变、再次越界才平移）；`calendar A4 density presets move to 60/84/108 without touching a stored scale`。共享的 `calendarCentreMinute` 改为**按 `.timeline-map-segment` 分段换算**（折叠条取中点），M9 两条与 A1 的落点断言因此继续成立。 |

### 8.3 探针与截图（headless、单 browser、生产构建 + `vite preview`、固定时钟 2026-08-05T12:00）

- `node output/2026-10-25_calendar-a4/audit.mjs` → `audit.json`（12 场景：日 全天/默认时段/quiet/**不折**/老 72/紧凑/详细 × 1200/960/200%，周三档）。
- `node output/2026-10-25_calendar-a4/probe.mjs` → 12 张截图 + `measurements.json`（含浅/深两主题的配色账）。

逐张检查结论：

| 截图 | 看到什么 |
| --- | --- |
| `cal-day-full-1200.png` | 一条带子「8月5日 周三 · 今天 · 8 项安排 · 投入 6h」；09:00 卡片完整可见（改前它的起止时间被 92px 双层吸顶吃掉）。 |
| `cal-day-full-960.png` | 960×640 下带子与折叠后轨道同时成立，无横向滚动。 |
| `cal-day-full-200.png` | 带子按 rem 长到 88px，文案不裁；时间轴刻度左侧截断与改前**同一程度**（既有项，见 §11）。 |
| `cal-day-slots-1200.png`／`-960` | 默认时段模式的折叠条仍是 `00:00–09:00 · 0 项安排`／`13:00–19:00 · 7 项安排`，没有「凌晨」文案、没有「展开整天」——语义未变。 |
| `cal-day-actual.png` | 叠加层压在计划卡之上、吸顶带压在两者之上。 |
| `cal-day-compact.png`／`-detailed.png` | 三档对照：60／84／108 px/小时，带子与折叠条尺寸不变。 |
| `cal-day-previous-at-top.png` | 顶端第一屏：`8月4日 周二 · 无安排 · ⌄展开` 一条带子 + `8月5日 …` 带子 + `凌晨 · 无安排` 折叠条 + `展开整天`。 |
| `cal-day-previous-expanded.png` | 点「展开」后前一天网格铺开，标题仍是「8月5日 周三」（§4.3 的修正）。 |
| `cal-day-full-1200-dark.png` | 深色下带子、柔底药丸与分类色条都可读。 |

### 8.4 axe 与 M13

`npm run check` 的 Playwright 已含 960×200% 浅／深逐页 axe、M12 的日历两条、M13 的两条（`elementFromPoint` 遮挡 + 14 轮 axe）全绿。M13 的日视图命中目标从 `.calendar-day.today .today-number` / 容器 `.calendar-day.today > header` 改为 **`.calendar-day-band-today`** / 容器 **`.calendar-day-band`**（药丸搬到了带上）；`CALENDAR_CONTRAST_TARGETS` 另加两条带上文字（`found` 为空则跳过），因此浅/深两主题的吸顶带文字也被逐轮量到。

### 8.5 反向验证（三处，均已在验证后恢复）

| 临时改动 | 预期复现的旧现象 | 实测 |
| --- | --- | --- |
| `foldsEffectiveDay` 常量置 `false`（回到「全天模式永不建映射」） | 折叠条不再出现 | `folds an empty early morning…` 红：`Unable to find an accessible element with the role "button" and name "凌晨 00:00–06:00 · 无安排"` |
| `collapsedPrevious` 恒 `false`（前一天恢复整天网格） | 前一天面板不再是带子 | `renders the buffered previous day…` 红：`is-previous-collapsed` 类缺失（`Expected the element to have class: … Received:`） |
| `.calendar-day-band` 的 `z-index: 20 → 4`（P4-13 修前的档位） | 「今天」药丸被轨道内容盖住 | M13 用例红：`药丸中心命中的是 span.session-project，而不是日期头 header.calendar-day-band`，堆叠顺序里 `session-project` 排在药丸之前 |

三条都证明对应断言**不是空跑**；恢复后重跑 Vitest 407/407、M13 与 A4 两条 E2E 全绿。

## 9. 未达成的验收目标（算术上不可能，需要用户裁决）

开工提示的复测目标里两条在 1200×800 下**不能同时成立**：

- `day-full-1200` 的 `visibleHours ≥ 8`：净视口 612px ⇒ 需要 `每小时 ≤ 612/8 = 76.5px`；D4 定的 standard 是 **84px** ⇒ 实测 7.26 小时。
- `scrollHeightsOfOneDay ≤ 2`：需要一天 ≤ 1308px；standard 档即使折掉凌晨+深夜（17h×84+88 = 1516）仍超 ⇒ 实测 2.32 屏。

两条在 **compact 60** 上同时成立（10.17 小时、1.69 屏）。可选出路，按侵入性排序：

- **A.** 接受现状：standard 84 是「可读性优先」的档位，把 `≥8h / ≤2屏` 明确挂到 compact 档（文档与验收口径改写，代码不动）。
- **B.** 把 standard 调回 72（`≥8h` 达成 8.5，`≤2屏` 仍差一点：17×72+88=1312 → 2.01 屏，几乎达标）。
- **C.** 折叠范围从「凌晨 6 小时 + 深夜 1 小时」扩到「凌晨 + 22:00 之后」（或按 `defaultTimeSlots` 的有效活动带折叠），standard 档也能进 2 屏 —— 但这会改动 F08 的判定边界，属设计决策。

本轮按「预设值以开工提示为准」执行 D4，未擅自改档位数。

## 10. 过程中发现并修掉的问题

1. **`activeTimeline` 的门禁让全天模式的折叠完全失效**：原代码只在 `defaultSlots` 下把 timeline 传给 `CalendarDay`，全天模式走百分比布局 —— 折叠段算出来了却没人画。修成 §3.2 的 `foldsEffectiveDay`。
2. **展开前一天是否改锚点取决于停在哪**（§4.3）：`suppressPreviousShift` 吞掉展开那一次越界。
3. **「今天」药丸的白字对比度**（§6.4）：药丸常驻吸顶后才被 axe 看见。
4. **`.missed` 的整圈描边盖掉左缘分类色条**（2.67 < 3:1）：左色条改到 `.missed` 之后重新声明。
5. **测试夹具的闭包陷阱**：`stubDayAxisLayout` 里 `mockImplementation(() => fakeRect(viewportTop + panelTop - scrollTop, …))` 按引用读循环变量 `panelTop`，循环结束后**三条轨道都落在同一个偏移**，采样永远命中第一条带子（表现为 `date` 变成前一天、`viewportRatio` 变成 1）。改成每个元素各自捕获 `bandTop`/`trackTop`。
6. **`installLayout` 不钳负 `scrollTop`**：jsdom 允许把 `scrollTop` 设成负数，浏览器会钳到 0；带子的恢复值正是负数（`22 − 0.5×80`），补上钳制后用例才反映真实行为。
7. **`.calendar-grid` 的 `+52px` 日头补偿残留**（收尾自查时抓到，已修）：F05 删掉了 `.day-head-spacer`、`CalendarDay` 的头部与 `DayCalendarGrid` 的 `+52px` 高度补偿，但 `src/styles.css` 的基线规则 `height: calc(52px + (var(--calendar-hour-height) * 24))` 里那 52px 是同一件事的第四处写法，漏了。它只在**全天模式且一段都没折**时暴露：那条路径不建分段映射、没有内联高度，于是每天轨道底部多出 52px 空白（实测 **2068** 而不是 24×84=2016）。折了段或默认时段模式都走内联 `totalHeight`，所以 A4 前几轮审计（全是折叠态）看不见它。改成 `height: calc(var(--calendar-hour-height) * 24)`；`.calendar-grid.week-body` 本来就有同名覆盖，周视图不受影响。新增 `day-nofold-1200` 场景（`fixture.mjs` 的 `nightWeek()`：凌晨 02:00 与深夜 23:00 各一条安排 ⇒ 不折、不建映射）把这条路径钉成可复测的账 —— 改后实测 2016，其余 11 个场景（折叠 1516／紧凑 1108／详细 1924／默认时段 720／周三档）逐字不变，`smallTextCount` 仍 0，横向溢出仍是同一条 2px。**这一处改动之后重跑：Playwright 55/55、Vitest 407/30、`vite build` 通过**（原生层未动，Rust 48 沿用同轮实测）。

## 11. 未做与边界

- **F13 月视图密度**：按开工提示留给后续包，本包未动月格。
- **B 轮拖拽（F04／F09／F10／F14）**：一行未改。折叠条的拖拽悬停展开、500ms latch、成功投放后保留都沿用 A4 之前的实现，只是全天模式现在也走这条路。
- **短卡片内容溢出（既有）**：`.calendar-session` 在 30 分钟卡片上仍会把标题压出下边界（`pending-review` 的 `overflow: visible` + 三行内容 > 42px），紧凑档 60px/小时下 90 分钟卡的「毕业设计」行也会贴到边框。改前（48/72/96 三档）同样存在，属**信息分层阈值**问题（`App.tsx:2020` 的 `density` 判据按 `hourHeight` 分档），不在 F11 的字号/圆角/色条范围内，留给后续包与 F13 一并处理。
- **折叠条高度是 44px 定值 px，日期带是 `2.75rem`**：200% 下带子 88px、折叠条仍 44px。`COLLAPSED_GAP_HEIGHT` 自 A1 之前就是 px（`calendarTimeline.ts`），改 rem 会同时改折叠映射与所有像素断言，本包不动。
- **周视图「今天」日号仍是白字压 `--accent`（`.today-number`）**：与 §6.4 同源，但周视图属 A3 范围，本包不改周视图；已记入 B 轮前的待办。
- **`continuousPanelStarts` 的兜底仍是 `scrollHeight / 3`**：三日缓冲不再等高，兜底值只在量不到面板（jsdom）时使用；真实浏览器走面板实测偏移。E2E 与探针里凡按 `scrollHeight/3` 反推中段起点的地方都已改成量面板 rect。
- **未 `git commit`**；A1–A3 的未提交修改原样保留。

## 12. A 轮整轮收口对照（评估 §5.2 第 4 步）

| 编号 | 评估里的问题 | 收口 | 实测证据 |
| --- | --- | --- | --- |
| F01 | 进入日视图落在 00:00 | A1 | `calendar A1 opens the day view at now…` E2E + `applyPosition` 的 `!track → return false` |
| F02 | 页头 + 工具栏两行 14 控件，chrome 23%–57% | A2 | chrome 184 → 108（200% 453 → 176），占比 23.0% → 13.5%（200% 56.6% → 22.0%） |
| F03 | 周 1200 列宽 94px | A3 | 141px（1200）、111px（960），`clippedCount 0` |
| F05 | 同一天写三遍日期、92px 双层吸顶 | **A4** | 吸顶 92 → **44**；`.continuous-day-separator`／`.calendar-day > header`／`.day-head-spacer` 三个选择器在 DOM 里计数为 0（组件测试 + E2E 各钉一次） |
| F06 | 200% 折行与横向溢出（min-width 用 px） | A2／A3 | `--calendar-ui-factor` 倒数收缩；A4 未新增溢出（§7.3） |
| F07 | 全天标记／月格 mid-glyph 截断 | A3 | 全天改计数胶囊 + 浮层；月格聚合行带 title |
| F08 | 一屏 6.8 小时、一天 3 屏、00–06 空网格占半屏 | **A4（部分）** | 空凌晨/深夜折掉（1728 → 1516，−24.8%）；一天 2.99 → 2.32 屏；**一屏小时数在 standard 档仍未到 8h**，见 §9 |
| F11 | 日历视觉语言与已优化页面脱节 | **A4** | `smallTextCount 0`；卡片 10px 圆角 + `--line-soft` + 3px 分类色条；配色两主题实测见 §6.4 |
| F12 | 周日期头单击直接跳日视图 | A3 | 单击选中 + 右侧详情，双击/图标按钮才进日视图 |
| F04／F09／F10／F14 | 拖拽通道与规格缺口 | **B 轮** | 本包未动 |
| F13 | 月视图密度 | 后续包 | 本包未动 |

## 13. B 轮开工前必须知道的交接点

### 13.1 选择器与结构变更（E2E／探针要按新名字找元素）

| 旧 | 新 | 影响面 |
| --- | --- | --- |
| `.continuous-day-separator` | **不存在** | 日视图吸顶改由 `.calendar-day-band` 承担；`scrollIntoCalendarSafeArea`、`visual-evidence.mjs` 的三处锚点已改 |
| `.calendar-day > header`（含 `.today-number`、`.calendar-day-band-today` 前身） | **不存在**（日视图侧） | 「今天」药丸 = `.calendar-day-band-today`；`.today-number` 现在**只在周日期头**出现 |
| `.day-head-spacer` | **不存在** | 时间轴与轨道同起点，无占位块 |
| `.continuous-day-panel` | 新增状态类 `.is-previous-collapsed`；子结构 = `header.calendar-day-band` + 可选 `.calendar-grid.day` | 前一天折叠时**没有** `.day-track`：任何 `panels[i]` 与 `scrollHeight/3` 的等分假设都不成立（本包已改 `e2e/phase1.spec.ts` 两处、`stubDayAxisLayout`、探针 `daySpecs`） |
| `.collapsed-time-gap`（默认时段） | 全天模式也会出现，多 `.effective-day-gap` 类；内部拆成 `button.collapsed-gap-main` +（第一条上）`button.effective-day-expand` | 拖拽悬停展开的 `dragenter` 仍挂在**外层 div**（`.collapsed-time-gap`）上，B 轮改拖拽时别只盯按钮 |
| `.calendar-session` | 新增内联 `--session-category`；`border-left` 3px 分类色 | 断言卡片描边/圆角的用例要按新值 |
| `CalendarTimeAxis` props | `{ timeline }`（原 `spacerHeight` 已删） | 组件内 API，不影响 DOM |

### 13.2 可访问名（B 轮 E2E 重写要用的名字）

- 吸顶带：`8月5日星期三 · 8 项安排 · 投入 6h`；折叠的前一天：`前一天 8月4日星期二 · 无安排`。
- 展开前一天：`展开前一天 8月4日星期二`（可见文字「展开」+ 16px 图标）。
- 全天模式折叠条：`凌晨 00:00–06:00 · 无安排`、`深夜 23:00–24:00 · 无安排`、`展开整天`、`收起 00:00–06:00`（可见文字「收起凌晨」）。
- 默认时段模式折叠条保持原样：`00:00–19:00 · 1 项安排`、`收起 00:00–19:00`。
- 滚动容器仍是 `role="region" aria-label="连续日时间轴"`；面板 `aria-label={formatLongDate(date)}`。

### 13.3 与拖拽直接相关的行为不变量

1. 折叠条的 `dragenter` 500ms 展开、`dragleave` 回缩、成功 `drop` 后保留 —— 全天模式现在**也**走这条路（`effective-day-gap` 与默认时段的折叠条共用同一套 handler）。
2. 「有效日折叠」是**布局输入**，不是新事实：`occupiedRanges` 只读 `executionSessions`／`timeBlocks`／`executionRecords`，B 轮改拖拽时不要把折叠当成状态源。
3. 采样与恢复必须继续走 `.timeline-map-segment` 的分段映射（`data-collapsed` 语义未变，新增的只有全天模式的段）；E2E 里凡按整轨线性内插反推分钟的地方都要用 `calendarCentreMinute`（`e2e/phase1.spec.ts:33`）这一份实现。
4. 三日缓冲的平移判据没变（`scrollTop < middleStart` / `>= nextStart`），但**展开前一天会吞掉一次越界**（§4.3）；B 轮若把滚动手势并进 pointer 自绘，必须保留这个门。

## 14. 文档同步（已落地）

- `docs/PROJECT-GUIDE.md`：**§2** 能力总览新增三条（44px 单条吸顶带及其字段来源、全天模式的有效日折叠与「展开整天不落偏好」、前一天只留带子与展开门）＋卡片视觉语言一条，三视图那条补上新三档预设；**§4** 滚动仲裁段新增「折叠的前一天带子也是一条可采样的轨道」（含「三日缓冲不再等高，`scrollHeight/3` 的等分假设失效」这条硬约束）与「展开前一天不能顺带改锚点」；**§5** 代码地图改了 `App.tsx`／`calendarTimeline.ts`／`calendarSummary.ts`／`settings.ts`／`styles.css`（图层表 19/20 合并为 20）／`useCalendarViewport.ts` 六行；**§8** `calendarScale` 写清新预设与两种迁移行为、`calendarDayMode` 写明展开整天不写偏好；**§10** 图层表三档规则改两档，并新增「常驻吸顶元素必须按常驻可见标准量对比度」这条（含「今天」药丸 3.61／2.47 → 4.89／6.95 与 `.missed` 左色条 2.67 两个实例）；**§11** 测试库存改为 Vitest 407/30、Playwright 55、Rust 48，并补 A4 的新增用例清单与 `calendarCentreMinute` 改分段换算这件事；**§12** 「修改日历滚动／浏览位置」补两条硬约束，新增一行「修改日视图的吸顶带／折叠判定」。
- `docs/design/UI-SPEC.md`「日历视图」段：连续时间轴那条改成「一层 44px 吸顶带 + 前一天只留带子」；显示模式那条写进全天折叠的判定与「展开整天」；折叠条文案那条补「凌晨 00:00–06:00 · 无安排」／「收起 00:00–06:00」；临时展开那条明确「展开整天」与「展开前一天」都不写偏好；密度那条写进 60／84／108 与「老连续值不被预设覆盖」；分类色那条升级为卡片语言（10px 圆角 + `--line-soft` + 3px 分类色条 + 同色相深版的取色理由），并新增字号 ≥ `.75rem` 与常驻吸顶的对比度标准。
- A1/A2/A3 留在工作区里的未提交文档修改**逐段合并**，没有整段替换；全程未 `git commit`。

## 15. 证据清单

| 路径 | 内容 |
| --- | --- |
| `output/2026-10-25_calendar-a4/audit.mjs`／`audit.json` | 12 场景结构账（吸顶占用、折叠清单、前一天面板、图层残留、横向溢出、字号账、卡片尺寸与色条） |
| `output/2026-10-25_calendar-a4/probe.mjs`／`measurements.json` | 12 张截图 + 结构快照 + 浅/深两主题配色实测 |
| `output/2026-10-25_calendar-a4/fixture.mjs` | 共享夹具（`denseWeek`、`quietWeek`、`legacyScale`；`preference()` 不再写死 `calendarScale`，让 D4 预设生效） |
| `output/2026-10-25_calendar-a4/cal-day-*.png` | 日视图改后截图（1200／960／200%／默认时段／叠加层／紧凑／详细／quiet／前一天折叠与展开／深色） |
| `output/2026-10-24_calendar-assessment/audit.json` | A 轮开工前的基线账（§7.2 左列来源） |

复现命令：

```powershell
npm run check
node output/2026-10-25_calendar-a4/audit.mjs
node output/2026-10-25_calendar-a4/probe.mjs
node scripts/run-e2e.mjs -g "calendar A4"
```
