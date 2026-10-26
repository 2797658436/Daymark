# 日历整改 A5 开工提示词：执行卡三档信息分层重设计、卡片零溢出、200% 刻度与周今日药丸

> 用法：整段复制到新会话作为开场提示。前置：A1–A4 已完成、已验收（验收见本提示词「验收结论」一节）。方案基线见 `docs/reports/calendar-evaluation-2026-10-24.md`（下称**评估**）的 **F15、F16、F17** 与 §6 的 **D7、D8**。本包是 A 轮与 B 轮之间的收口小包，**不碰拖拽**。

---

你在 Daymark 仓库（F:\PythonProject\Daymark）开工**日历整改 A5：让执行卡在三个密度档下都"装得下、看得懂"**。A1–A4 把 chrome、吸顶、列宽、落点都收口了，但逐张看截图会发现日历页上最扎眼的东西是卡片本身：30 分钟的卡在 standard 档把标题和状态压出卡外，待回顾卡的内容直接浮在网格上，200% 下几乎所有卡都裁切、时间轴刻度丢首位数字。本包重设计三档信息分层（按使用场合，而不是按会话分钟数），并收掉三处独立缺陷。

## 验收结论（A1–A4，2026-10-26 总 Agent 复验）

- 四轮数字全部独立复现：chrome 184/237/453 → 108/108/176；网格内吸顶 92 → 44；周 1200 列宽 94 → 141；一天屏数 2.99/4.74/5.59 → 2.32/3.07/2.59；`npm run check` 四步全绿（Vitest 407/30、Playwright 55/55、Rust 48/48）。
- 复验证据在 `output/2026-10-26_acceptance/`（probe/audit/residuals 三套量测 + 最终树截图）。
- 已知既有用例抖动：`phase1.spec.ts:361`（M2）与 `completion-records.spec.ts:212` 对真实时钟敏感，**午夜 00:00–00:01 窗口内会红**（M2 的 00:00–00:01 会话在那一分钟里还是「当前安排」）；其余时间全绿。不要为此改断言，除非顺手给这两条也固定时钟。

## 先读（按顺序，不要跳过）

1. `AGENTS.md`（截图逐张看、headless、清理进程的要求）。
2. 评估 §3 基准 3/9/10、§4 的 **F15、F16、F17**、§5.2 第 4 步（验收口径已按 D7 改写）、§6 的 **D7、D8**。
3. `docs/reports/calendar-a4-implementation.md` §6（卡片语言与配色实测方法）、§11（它记下的「短卡片内容溢出」就是本包的 F15）、§13.1（选择器变更表）。
4. `docs/PROJECT-GUIDE.md` §10「按容器隐藏信息有两套断点口径」（**宽用 px、高用 rem** 那条，本包是它的第一次完整落地）、§12「修改日历某层配色」清单。
5. `docs/design/UI-SPEC.md` 日历视图段「执行卡片根据可用高度自动调整信息量」三条与「拖拽排程」段第 201 行（A4 删掉日期分隔条后这句已过期，本包顺手改写）。
6. `src/App.tsx` 的 `CalendarSession`（约 2000–2090 行）：`density` 的判据、`status`/`showDetails`/`review-summary`/`session-project` 的渲染条件、`data-card-density` 的消费方（悬停动作条阈值）。
7. `src/styles.css`：`.calendar-session`（约 754 行起，`container-type: size` 已存在）、`.calendar-session.pending-review` 的 `overflow: visible`（759 行）、宽度容器查询 124/112/100/88px、`.time-axis` 与 `.calendar-grid`/`.week-date-headers`/`.week-all-day` 里硬编码的 `58px` 首列、`.today-number`（735 行）。
8. 量测脚本：`output/2026-10-26_acceptance/residuals.mjs`（卡片裁切/溢出、刻度裁切、药丸对比度三笔账，本包的验收判据就是它归零）。

## 现状账（改前基线，`output/2026-10-26_acceptance/residuals.json`，夹具时钟 12:00）

| 场景 | 裁切/溢出卡数 | 最坏裁切 | 刻度左裁 | 周今日药丸 |
| --- | --- | --- | --- | --- |
| 日 1200×800@100% | 7 | 37px（30 分钟 standard 卡，标题+状态压出） | 0 | — |
| 日 1200×800@200% | 11 | 100px（30 分钟卡连时间行都压出） | 17 条 ×9px | — |
| 周 1200×800@100% | 9 | 待回顾卡 `review-summary` 浮出卡外 +34px | 0 | **3.61:1** |
| 周 1200×800@200% | 13 | 364px | 24 条 ×9px | **3.61:1**（深色按同法 2.47） |

根因三条：

1. **信息分层按"会话分钟数"判档，而不是按"卡片盒子装得下几行"**：`CalendarSession` 的 `density` 由时长×hourHeight 推档后**强制渲染**对应行数，盒子不够就压出去；`.pending-review` 还额外 `overflow: visible`，把压出去的部分画到网格上。
2. **200% 下内容行按 rem 翻倍、卡片盒子按 px 不变**：60 分钟的卡在 100% 装 4 行、200% 只能装 2 行，但渲染的行数不变 → 裁切随缩放线性恶化。
3. **时间轴首列是硬编码 `58px`**：字号按 rem 长大、列宽不长 → 200% 下「10:00」丢首位。

## 交付范围

### 1. 三档信息分层重设计（F15 主体，D8）

按**使用场合**定义三档各自要回答的问题，内容清单从问题推出，而不是从"能塞几行"推出：

| 档 | hourHeight | 使用场合 | 卡片要回答 | 内容清单（自上而下） |
| --- | --- | --- | --- | --- |
| 紧凑 | 60 | 扫一天/一周的**形状**：找空档、看并行、看逾期 | "这是什么 + 什么状态"；时间靠轴位置读 | 标题 1 行（省略+`title`）＋左缘分类色条＋状态图标角标 |
| 标准 | 84 | **日常工作视图**：知道几点到几点做什么 | "几点–几点 + 是什么 + 什么状态" | 起止时间 1 行＋标题 1–2 行＋状态（图标+短词）；**进度改画卡片底边 2px 填充**（零行高成本），不再占一行 |
| 详细 | 108 | **逐日复盘/编辑**：归属、进度、动作 | 标准的全部＋"属于哪个项目、推进了多少" | 标准清单＋项目行＋进度百分比；悬停/聚焦动作条照旧 |

实现要求（这是本包的核心约定）：

- **盒子装得下几行由高度容器查询决定，`container-type: size` 已经在了**：断点写 **rem**（行预算），内容也写 rem → 断点与内容同比例缩放，200% 下同一个 px 盒子自动少显示行，而不是裁切。宽度容器查询（124/112/100/88px）保持 px 口径不动（PROJECT-GUIDE §10 的两套口径）。
- `CalendarSession` 的 JS `density` 不再决定"渲染哪些行"，只保留给悬停动作条阈值与 `data-card-density` 测试钩子；行的显隐全部交给容器查询。改完 `App.test.tsx` 里按 density 断言行数的用例改为断言"盒子高度档位"。
- 最小档（盒子 < 约 1.75rem 行预算）必须仍有：标题＋分类色条＋状态图标——`phase1.spec.ts:393`（M2）断言 1 分钟卡上有 `.session-status-icon`，这条红线不许断。
- **`.pending-review` 的 `overflow: visible` 删除**（styles.css:759）：待回顾的区分靠 2px 描边＋`--accent-strong` 混色＋图标（都已有），「待回顾」短词只在高度查询允许时出现；动作仍是点开的气泡，不回到卡内。
- 进度底边填充：用卡片自身 `::after` 或既有进度条元素改 `position: absolute; bottom: 0; height: 2px`，宽度=进度百分比；与手动进度条（较粗那条）的语义区分保持 UI-SPEC 现状。

### 2. 200% 时间轴刻度不裁切（F16）

- 新增 `--calendar-gutter: 3.625rem`（100% = 58px），替换 `.calendar-grid`／`.calendar-grid.day`／`.week-date-headers`／`.week-all-day`／连续日轴里所有硬编码 `58px` 首列；`--calendar-min-week` 改写成 `calc(var(--calendar-gutter) + 7 * var(--calendar-week-column))`，A3 的 842/902 两笔账按新公式重算并写进报告。
- 验收：`residuals.mjs` 的 `axisClipped`／`weekAxisClipped` 在 100% 与 200% 都为 0；周视图列宽数字（141/111/82/95）允许因首列变宽而 ±2px 漂移，但 `clippedCount` 不得变差。

### 3. 周「今天」日号药丸对比度（F17）

- `.today-number` 换成与日视图吸顶带药丸同一族：`--accent-soft` 底＋`--accent-strong` 字＋`color-mix` 描边，圆形外形与 27px 尺寸不变；浅/深两主题实测 ≥4.5:1 写进报告（A4 §6.4 的量法）。
- 类名保留（M12/M13 与 `App.test.tsx` 都按它取元素）；若改可访问名，同步所有用例。

### 4. 文档与口径回写（合并式）

- UI-SPEC 日历段「执行卡片根据当前缩放和可用高度自动调整信息量」三条：改写为「三档各自回答什么问题 + 行显隐由高度容器查询（rem 断点）决定 + 进度是底边填充」；删掉按 30/60 分钟分档的旧句。
- UI-SPEC:201「跨过午夜时保持日期分隔线醒目」：A4 已删分隔条，改为「跨午夜时由吸顶日期带与落点框承担日期归属提示」。
- PROJECT-GUIDE §5 的 `App.tsx`／`styles.css` 两行补本包改动；§10 的「高用 rem」口径补一个已落地的实例。
- 评估 §5.2 第 4 步验收行与 §6 D7 已由总 Agent 改写，不要重复改。

## 明确不做（越界即停并回报）

- 不碰拖拽通道与落点框（B 轮）；落点框「不得矮于卡片」的规则在卡片变矮后仍然成立，不要顺手改。
- 不改月视图密度（F13）、不改任务池 200% 右栏裁切（另记后续包）、不改 chrome（A2）、不改列宽与池覆盖判定（A3）。
- 不改 `CALENDAR_SCALE_PRESET`（60/84/108 已按 D7 定案）、不改 `CALENDAR_SCALE_RANGE`、不改设置字段。
- 不改图层表档位；不改 `calendarTimeline` 映射。
- 不动用户未提交修改；不 `git commit`。

## 必须保持（回归红线）

- `npm run check` 四步全绿；M12 两条日历用例、M13 两条（`elementFromPoint` + 14 轮 axe）、960×200% 浅/深逐页 axe 全绿。
- M2（`phase1.spec.ts:361`）与 M4（`:462`）全绿；A1 落点用例（`:984`）与 A4 两条（`:596/:700`）全绿。
- `data-card-density` 的消费方（悬停动作条、E2E 断言）行为不变；`title` 兜底（省略处带全文）不许丢。
- 状态双编码（图标+文字/边框）不许退化成纯颜色。

## 验证

```powershell
npm run check
node output/2026-10-26_acceptance/audit.mjs
node output/2026-10-26_acceptance/probe.mjs
node output/2026-10-26_acceptance/probe-a3.mjs
node output/<今天日期>_calendar-a5/residuals.mjs   # 从 acceptance 目录复制过去后跑
```

- **硬判据**：`residuals.json` 里日/周 × 100%/200% 四个场景 `cards = 0`、`axisClipped = 0`、`weekAxisClipped = 0`、`pillContrast ≥ 4.5`。
- 结构账不退化：`audit.json` 的 chrome 108/176、吸顶 44/88、compact 档 10.17h/1.69 屏、standard 档 7.26h/2.32 屏（D7 口径：≥8h/≤2 屏挂在 compact，standard 只要求 ≥7h 与零裁切）。
- 重拍并**逐张看**：`cal-day-full-1200/960/200`、`cal-day-compact/detailed`、`cal-week-1200/200`、`cal-week-selected`、深色日视图各一张；重点看 30 分钟卡、待回顾卡、200% 刻度与周今日药丸；截图落 `output/<今天日期>_calendar-a5/`。
- 三档各写一段「这档回答什么问题、装得下什么」的对照表进实施记录，并附 100% 与 200% 的实测行预算。

## 完成定义

1. 上述硬判据全绿，实施记录 `docs/reports/calendar-a5-implementation.md` 写明改前/改后四场景账、三档设计表、未收口项（任务池 200% 裁切等）与回退方法。
2. UI-SPEC 与 PROJECT-GUIDE 合并式回写完成；评估文档不再出现与本包冲突的旧句。
3. `npm run check` 四步全绿（若撞上午夜窗口导致的 M2/completion-records 红，重跑一次并在记录里注明，不改断言）。
4. 不 `git commit`；保留工作区里其它未提交修改。
