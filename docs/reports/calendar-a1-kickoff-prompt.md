# 日历整改 A1 开工提示词：日视图「进入即现在」

> 用法：整段复制到新会话作为开场提示。方案与量测基线见 `docs/reports/calendar-evaluation-2026-10-24.md`（下称**评估**），本包对应其中 **F01**，是 A 轮第 1 步（A 轮共 4 步：A1 进入即现在 → A2 一行 chrome → A3 周视图可读 → A4 日视图密度与视觉对齐）。

---

你在 Daymark 仓库（F:\PythonProject\Daymark）开工**日历整改 A1：修「打开日视图落在 00:00」**。这是用户三个体感里「日视图不好用」的第一根因，也是 A 轮里最小、最独立的一步：只碰滚动落点，不碰布局、不碰拖拽、不碰数据。

## 先读（按顺序，不要跳过）

1. `AGENTS.md` —— 工作规则；**浏览器默认 headless、一轮验证只开一个会话、finally 清理**；GUI 改动后必须逐张看截图并对照 `docs/design/UI-SPEC.md`。
2. `docs/reports/calendar-evaluation-2026-10-24.md` —— §1 结论、§2 结构账与证据边界、§4 的 **F01**（现象/根因/整改三条）、§5.1 轮次划分、§5.2 第 1 步、§5.4 每轮验证清单、§6 决策记录。
3. `docs/PROJECT-GUIDE.md` —— §4「日历滚动仲裁与浏览位置」（P4-04 优先级表 1–6、P4-05 写入闸门）、§10 图层表、§12「修改日历滚动／浏览位置」的同步清单。
4. `src/hooks/useCalendarViewport.ts` —— 重点 `applyPosition`（约 400–416 行，**407–408 行 `!track` 返回 true 是根因之一**）、`queue`／`pump`（350–398）、优先级表、`markProgrammaticSettle`（341–348）、首次定位 effect（447–457）。
5. `src/App.tsx` 的 `ContinuousDayView`（约 1226–1276）—— **1245–1256 行的 layout effect 直接写 `axis.scrollTop = middleStart` 是根因之二**；以及 `DayCalendarGrid`（1286–1328）。
6. `src/hooks/useCalendarViewport.test.tsx`（18 个用例）与 `e2e/phase1.spec.ts` 的 637/712/910 行三条 M9 用例 —— 本包的回归红线。

## 根因复述（开工前自己复测一遍再动手）

两条写入竞争且无仲裁：三日缓冲的 layout effect **直接写** scrollTop 到中间面板起点（当天 00:00），并声明「这是程序性滚动」；仲裁入口的首次定位（优先级 6）排在下一帧 rAF，而 `applyPosition` 在 `pickTrack` 取不到轨道时 `return true`——把「还没量到」当「已成功」，意图被丢弃。实测证据：`output/2026-10-24_calendar-assessment/audit.json` 里 `day-full-1200` 的 `scrollTop=1822` 恰为 `scrollHeight 5466/3`、`firstVisibleMinute=0`；截图 `cal-day-full-1200.png` 顶部是 00:00 且「回到现在」常亮。周视图无三日缓冲，落点正常（`firstVisibleMinute=478`）——**改完不得让周视图变坏**。

## 交付范围（只有这三件事）

1. `useCalendarViewport.ts` 的 `applyPosition`：`pickTrack` 取不到轨道时改 `return false`（保持待处理、继续补帧并交给 ResizeObserver），**不得返回 true**。确认 `MAX_RESTORE_RETRIES` 与 ResizeObserver 路径能兜住「一直量不到」的情况（量不到就保持待处理，不要空转烧帧）。
2. `App.tsx` 的 `ContinuousDayView`：三日缓冲的初始写入不再直接写 `scrollTop`，改为向仲裁入口提交一个**优先级 4** 的请求（与既有「三日缓冲平移」同档），让「进入恢复（5）／首次定位（6）」能排在它之后落地；`onProgrammaticPosition()` 的语义保持不变（程序性滚动不写偏好）。
3. 测试：`useCalendarViewport.test.tsx` 新增 2 条——① track 未就绪时意图保持待处理、就绪后落地（反向验证：把 `!track` 改回 `return true` 即失败）；② 三日缓冲写入走仲裁后，首次定位仍能落在现在/首安排。E2E 新增 1 条：进入日视图后断言视口中心分钟 ∈ 现在 ±90 分钟（锚点=今天）或首个安排 ±60 分钟（锚点≠今天），并断言周视图进入落点不退化。

## 明确不做（越界即停并回报）

- 不改布局、不改吸顶、不改密度预设、不改工具栏（那是 A2/A4）。
- 不改拖拽、不改 `calendarTimeline` 的分钟／像素映射、不改缩放范围与预设。
- 不改 P4-05 的写入闸门（只有用户滚动写偏好）与 `seedCalendarPositions`；「回到现在／目标显露」（优先级 2）写偏好是刻意放行，不要动。
- 不改 SQLite／Tauri／设置字段；不新增依赖。
- **不要动用户工作区里的未提交修改**（开工先 `git status`；当前有 `src/App.tsx`、`src/styles.css`、`docs/design/UI-SPEC.md`、`docs/design/UI-AUDIT.md` 等未提交内容与一份 `auto-schedule-evaluation` 未跟踪文档——若与你的改动冲突，停下回报，不要覆盖或顺手整理）。

## 必须保持（回归红线）

- M9 三条：日↔周切换十次不漂移、日／周浏览位置跨重启恢复、「回到现在」写进浏览位置（`e2e/phase1.spec.ts:637/712/910`）。
- `useCalendarViewport.test.tsx` 既有 18 条全绿（仲裁优先级、generation 失效、拖拽延后、程序性写入不作废、写入闸门与播种）。
- 刚过午夜的边界：`phase1.spec.ts:288`「日视图在午夜后打开仍保持今天」不得回退。
- 月视图不存时间轴坐标、进入置顶的行为不变。

## 验证

```powershell
npm run check
node output/2026-10-24_calendar-assessment/audit.mjs
node output/2026-10-24_calendar-assessment/probe.mjs
```

- `audit.json` 复测目标：`day-full-1200`／`day-full-960`／`day-full-200` 的 `firstVisibleMinute` 落在目标区间（夹具时钟 12:00 → 约 630–810 分钟），`week-*` 的落点不退化；把新数字写进实施报告并与评估 §2 结构账对照。
- 重拍 `cal-day-full-1200/960/200` 三张（probe 会自动产出），**逐张打开看**：顶部不得是 00:00 空网格；截图落 `output/<今天日期>_calendar-a1/`。
- headless 即可，本包不需要 headed 会话。
- E2E 惯例 `node scripts/run-e2e.mjs --workers=1`；不录 trace（`PW_TRACE=1` 才录）。

## 完成定义

1. 代码 + 测试按「交付范围」落地，`npm run check` 四步全绿（数字以你实测为准，写进报告）。
2. 写 `docs/reports/calendar-a1-implementation.md`：根因复测数据、改动清单（文件:行）、刻意行为变化、验证实测数字（改前/改后对照）、反向验证结果、未做与边界、发现的不一致。
3. 按 `docs/PROJECT-GUIDE.md` 末尾「文档同步协议」同步：§4 滚动仲裁段补一句「三日缓冲初始写入走优先级 4 请求」、§12 修改入口若措辞失效则修正；**不要**把本包写成已验收整轮。
4. 不 `git commit`（由总 Agent 复核后统一提交）；不动用户未提交内容。
5. 汇报：改了什么、验证实测、是否发现规格/文档与代码不一致、A2 开工前需要注意的交接点。
