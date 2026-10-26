# 日历整改 A6 开工提示词：日视图密度重定标（84/168/216）、卡片字号随档、六项视觉统一

> 用法：整段复制到新会话作为开场提示。前置：A1–A5 已完成并验收（A5 验收见评估 §5.5 的验收记录）。方案基线见 `docs/reports/calendar-evaluation-2026-10-24.md`（下称**评估**）的 **F18、F19、F20** 与 §6 的 **D9、D10、D11**。本包仍**不碰拖拽通道**（B 轮）。

---

你在 Daymark 仓库（F:\PythonProject\Daymark）开工**日历整改 A6：把日视图的"标准"放大到用户读得舒服的尺寸，并让日历的字号与吸顶语言对齐全站**。用户在 A5 验收后的原话：「目前标准的话太挤了，标准应该为紧凑，然后标准至少还要再放大 2 倍」；裁决见 D9/D10/D11：日视图 presets 84/168/216、卡片字号随档 12/14/16px、周视图 presets 不动、六个便宜统一项搭同一班车。

## 先读（按顺序，不要跳过）

1. `AGENTS.md`。
2. 评估 §3 基准、§4 的 **F18/F19/F20**、§5.2 第 4 步（D7 口径）、§6 的 **D7/D8/D9/D10/D11**。
3. `docs/reports/calendar-a5-implementation.md` §2（三档设计表与 rem 行预算）、§2.4（JS 只留钩子）、§9（未收口项）。
4. `docs/PROJECT-GUIDE.md` §8（`calendarScale` 迁移语义）、§10「按容器隐藏信息有两套断点口径」与图层表。
5. `docs/design/UI-SPEC.md` 日历段：密度三档、执行卡信息分层、周视图吸顶与全天区三条。
6. `src/lib/settings.ts`：`CALENDAR_SCALE_RANGE`／`CALENDAR_SCALE_PRESET`／`DEFAULT_SETTINGS.calendarScale`／规范化函数；`src/lib/settings.test.ts` 的预设恒等与迁移用例。
7. `src/App.tsx` 的 `CalendarSession`（行渲染与 `data-card-density`）、`WeekDateHeaders`／`WeekAllDayArea`／`.week-sticky-header` 结构、`CalendarTimeAxis`。
8. `src/styles.css`：`.calendar-session` 容器查询块（A5 的 rem 断点）、`--calendar-gutter`、`.week-date-headers`／`.week-all-day`／`.week-sticky-header`、`.collapsed-time-gap`、`.calendar-status-end`、`.calendar-time-block` 与 `.time-block-delete`、`.calendar-toolbar`。
9. 量测脚本：`output/2026-10-26_calendar-a5/residuals.mjs` 与 `output/2026-10-26_acceptance/audit.mjs`／`probe.mjs`／`probe-a3.mjs`。

## 现状账（改前基线）

- 日视图 presets 60/84/108；standard 84px/小时下卡片正文 **12px（.75rem）**——全站最小（body 14px、任务池标题 13.1px）。60 分钟卡 84px 高、3 行 18px 行预算，"字小、行贴、卡里留空"。
- 一屏/一天（1200×800、净视口 612px、折叠日 17h+88px）：60 → 10.17h/1.69 屏；84 → 7.26h/2.32 屏；168 → 3.64h/4.80 屏；216 → 2.83h/6.15 屏。
- 周吸顶 122px 双行（日期头 52 + 全天区 70），日视图已是单条 44px 带：两种吸顶语言。
- 折叠条高度 `COLLAPSED_GAP_HEIGHT = 44` 是 px 常量（CSS 与 `calendarTimeline` 各用一次），日期带是 2.75rem：200% 下 44 vs 88 不等高。
- 日视图连续轴仍有同一条 2px 横溢：`.time-block-delete` 的 `scrollWidth 32 / clientWidth 20` 撑宽卡片再逐层上传。
- 状态条右组：复选框+标签顶对齐、「显示 ⋯」按钮满高 2.125rem，垂直不齐。
- 详细档高卡：内容顶对齐 + 进度条 `absolute` 钉底，中间一大片空。

## 交付范围

### 1. 日视图密度重定标（D9）

- `CALENDAR_SCALE_PRESET.day = { compact: 84, standard: 168, detailed: 216 }`；**week 保持 `{ 60, 84, 108 }`**（周的职责是"一周容量"，168 下一屏只剩 ≈3.9h×7 列）；month 不动。
- `CALENDAR_SCALE_RANGE.day = [28, 240]`（week/month 不动）；`DEFAULT_SETTINGS.calendarScale.day = 168`。
- **档位忠实迁移**：加载时若 `calendarZoom.day` 存在且已存连续值**恰好等于该档旧预设**（60/84/108），改写为新预设（84→84 不变、108→216、60→84）；用户自己滚出来的其它连续值一字不动（沿用 D4/A4 的迁移语义）。`settings.test.ts` 补四条：旧 standard 84+tier=standard → 168；旧 detailed 108 → 216；旧 compact 60 → 84；已存 72/99 等非标值原样保留。
- 验收口径第三次改写（D7→D11）：**≥8h/≤2 屏挂到周视图 compact（60）**；日视图 compact(84) 的线是 ≥7h 且 ≤2.4 屏；standard/detailed 不设小时数线，只设「零裁切零溢出 + 该档内容清单完整」。

### 2. 卡片字号随档（D10）

| 视图 | compact | standard | detailed |
| --- | --- | --- | --- |
| 日 | 12px / 行高 18px | **14px / 22px** | **16px / 26px** |
| 周 | 12px / 18px | 13px / 20px | 14px / 22px |

- 日视图 standard 起对齐全站 14px 基准；周视图列窄（141px），14px 会每 8 字换行，故周取 12/13/14 并在 UI-SPEC 写明"按视图定字号"是刻意为之。
- 行高用 rem 表达（.75rem→1.125rem 等），A5 的高度容器查询断点改为**按档写死 rem 字面量**（compact 以 1.125rem 为行单位、standard 1.375rem、detailed 1.625rem，各 5 档断点 = 行数×行单位+2px），不要依赖容器查询条件里的 `var()`（Chromium 对条件内自定义属性解析不稳）；三组断点块用 `.calendar-page[data-calendar-zoom="…"]` 外层选择器区分。
- 200% 下 rem 翻倍、断点同步翻倍，行为与 A5 相同（盒子不够就少放行）；补一条 E2E：200% 下 standard 档 60 分钟卡显示「时间+标题」两行、不裁切。
- `data-card-density` 与悬停动作条阈值语义不变；M2 的 `.session-status-icon` 红线不变（最小档仍须有图标）。

### 3. 六项视觉统一（F18/F20）

1. **周吸顶并成一条带**：`.week-date-headers` 52px → 2.75rem；`.week-all-day` 改**单行** 2.75rem（胶囊一行排不下时收进「+N」chip，点开仍是 A3 的 `FloatingPanel` 名单），两行共用同一底色与一条底边，吸顶总高 122 → **88px**；200% 默认折叠全天区的行为保留。日期头单击选中/双击进日/图标按钮/键盘语义一字不改。
2. **折叠条与日期带同源**：`COLLAPSED_GAP_HEIGHT` 改成由 `preferences.scale` 推出的单一来源（`Math.round(44 * scale / 100)`），CSS 高度用同一值内联下发；`calendarTimeline` 的映射、采样、E2E 像素断言同步。PROJECT-GUIDE §10 记一条例外：折叠条高度不再追求 rem 纯度，改追"单一来源"。
3. **轴 2px 横溢**：`.time-block-delete` 改 `position: absolute`（卡内右上角），不再贡献 `scrollWidth`；验收 `residuals` 与 audit 的 `hOverflow` 链在日视图归零。
4. **状态条右组对齐**：`.calendar-status-end` 改 `align-items: center`，复选框标签行高与 2.125rem 按钮同高；100%/200% 截图里左右两组基线对齐。
5. **高卡空白**：标准/详细档的任务进度条进文档流（紧跟最后一行内容），不再 `absolute` 钉底；卡底留白不超过一个行高。紧凑档仍不画进度。
6. **200% 最小卡重叠**：standard 168 下 30 分钟格 84px ≥ 最小卡 62px，重叠自然消失；compact 84 下 30 分钟格 42px 仍小于 62px——把最小卡高度改成 `min(calc(1.875rem + 2px), 时段格高 + 20px)` 之外的方案不允许，改为：**compact 档最小卡降到 1.375rem + 2px（24px）**（该档只有一行 12px 标题，24px 装得下），重叠在两个档都归零。

### 4. 文档回写（合并式）

- UI-SPEC：密度三档数值与"按视图定字号"；执行卡信息分层表的行高/字号列；周视图吸顶改"一条 88px 双行带"；折叠条高度单一来源；删掉与 60/84/108 相关的旧句。
- PROJECT-GUIDE §5（`settings.ts`／`App.tsx`／`styles.css` 行）、§8（迁移语义补"档位忠实迁移"）、§10（折叠条例外）。
- 评估 §5.5 索引与 §6 决策已由总 Agent 更新，不要重复改。

## 明确不做（越界即停并回报）

- 不碰拖拽通道、落点框逻辑（B 轮）；落点框最小高度若因最小卡改动需同步，只同步常量。
- 不改周视图 presets、不改月视图（F13）、不改任务池 200% 裁切、不改周 200% 的 74px 列与日期头折行（评估 F20⑧，裁决为接受）。
- 不改设置字段名、不改 SQLite/备份格式；不 `git commit`；不动用户未提交修改。

## 必须保持（回归红线）

- `npm run check` 四步全绿；M2/M4/M12/M13、A1 落点、A4 两条、A5 的密度与零溢出用例全绿。
- `gui-optimization.spec.ts` 的缩放矩阵（会点三档）与 `phase1.spec.ts` 里所有显式写 `calendarScale` 的用例不受影响（它们写的是连续值，不走预设）。
- 拖拽悬停展开折叠条、跨日拖拽、`Ctrl+Z` 整组撤销行为不变。
- 状态双编码、`title` 兜底、图层表档位不变。

## 验证

```powershell
npm run check
node output/2026-10-26_acceptance/audit.mjs
node output/2026-10-26_acceptance/probe.mjs
node output/2026-10-26_acceptance/probe-a3.mjs
node output/<今天日期>_calendar-a6/residuals.mjs
```

- **硬判据**：residuals 四场景 `cards = 0`、轴裁切 0、日视图 `hOverflow` 链归零；audit 结构账：日 standard 一屏 ≈3.64h/4.8 屏、compact ≈7.26h/2.32 屏、detailed ≈2.83h；周视图数字与 A5 收口态逐字相同（7.81h、列宽 141/111/74/95、吸顶 88 替换 122）。
- 重拍并**逐张看**：日 100% 三档 + 200% standard + 深色、周 100%/200%、周吸顶带特写、状态条特写、高卡进度条进流特写；截图落 `output/<今天日期>_calendar-a6/`。
- 960×200% 浅/深逐页 axe 与 M13 两条全绿；新字号在 200% 下的对比度沿用既有 token，不改色值。

## 完成定义

1. 硬判据全绿；实施记录 `docs/reports/calendar-a6-implementation.md` 写明：改前/改后三档一屏一天账、迁移四条实测、六项统一逐项前后对照、未收口项（周 200% 窄列、池 200%、F13）与回退方法。
2. UI-SPEC 与 PROJECT-GUIDE 合并式回写完成。
3. 不 `git commit`；保留工作区其它未提交修改。
