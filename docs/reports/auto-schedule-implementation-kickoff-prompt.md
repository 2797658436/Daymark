# 自动排程气泡整改开工提示词（W1–W5）

> 用法：整段复制到新会话作为开场提示。评估与量测基线在
> [`docs/reports/auto-schedule-evaluation-2026-10-24.md`](auto-schedule-evaluation-2026-10-24.md)，
> 本文只负责把已定案的方案变成代码，**不重新评估、不重新拍板**。
> D1–D5 已于 2026-10-24 全部按推荐项定案（见评估报告 §6），开工后不要再把这些问题抛回给用户。

---

你在 Daymark 仓库（F:\PythonProject\Daymark）开工**自动排程气泡整改**，共六步：W2a → W1 → W2b → W3 → W4 → W5。

## 先读

1. `AGENTS.md` —— 工作规则（浏览器取证、仓库清理、视觉验收流程）。
2. `CONTEXT.md` —— **「自动排程」「单次投入时长」「任务池」「执行时段」「待续任务」**五条定义。自动排程的领域边界是「仅追加到空档，不调整已有安排」，任何改动不得让它变成重排器。
3. `docs/PROJECT-GUIDE.md` —— §5 代码地图、§10 主题与无障碍（**两条 axe 硬约束**）、§11 测试体系、§12 常见修改入口、文档同步协议。
4. `docs/design/UI-SPEC.md` —— **「自动排程交互」整段（200–219 行）**是本次的验收规格；另读「详情编辑与确认层级」「项目页面」§344（「安排项目」入口）。
5. `docs/reports/auto-schedule-evaluation-2026-10-24.md` —— **全文**。§2 的结构账是改前基线，§3 是设计语言，§4 是问题清单（F01–F14），§5 是工作包，§6 是定案，§8 是实施顺序与完成定义。
6. `docs/reports/calendar-evaluation-2026-10-24.md` §3 —— 已优化页面的十条设计语言（与评估报告 §3 同源）。
7. 代码（行号以当前工作区为准，开工先核对）：
   - `src/App.tsx`：`AutoScheduleDialog`（约 2516–2545）、`SchedulePreview`（约 2918–2920）、`ConfirmDialog`（约 2764）、任务池头「自动排程」按钮（约 947）、五处入口接线（约 584/587/599/618）与渲染接线（约 684）、`scheduleDeadlineForTask`（约 2547）、`sessionFromAllocation`（约 2838）。
   - `src/lib/scheduling.ts` 全文（174 行）与 `src/lib/scheduling.test.ts`。
   - `src/styles.css:1051` 的 `.schedule-*` 段；对照先例 `styles.css:1483-1496`（`.review-detail-panel` 的头/滚动体/底三段）、`1570-1583`（`.floating-panel` 基线、`-wide`、sticky 底、40px 图标按钮）、`1616`（sticky 头）、`523-527`（`.pool-empty`）。
   - `src/components/ui/floating-panel.tsx` 与 `overlay-host.tsx` —— 三种 `kind` 的语义差别（`editor` 锁背景、`action` 不锁、`confirm` 锚定危险确认）。
8. 证据：`output/2026-10-24_autoschedule-assessment/` 的 `probe.mjs`、`measurements.json` 与 15 张截图；归档副本在 `docs/reports/auto-schedule-evaluation-2026-10-24/`。

## 一、已定案，不再讨论

| 编号 | 定案 | 对你的约束 |
| --- | --- | --- |
| D1=a | 逾期任务按「窗口首日」参与排档 | `scheduling.ts` 的截止过滤先钳制 `deadline = max(deadlineLocal, startDate)`；行与卡加「已逾期 N 天」标记（复用 `deadlineLabel`，`App.tsx` 约 2887） |
| D2=a | 非模态大气泡 | `FloatingPanel kind="action" wide closeOnOutsideClick`；**不 inert 主界面**；结构照 `.review-detail-panel` 拼 |
| D3=a | 预览不做拖动 | 只给「移除单项 + 返回选择改勾」两条路径 |
| D4=a | 「需要连续时段」不做 | 不动 schema；原因枚举**预留** `continuous-unavailable` 一位但不实现；`UI-SPEC:206` 已标注后续阶段，别再改回去 |
| D5=a | 习惯发生项收组 | 候选里按 `habitId` 一组一行、整组一个复选、展开逐日可单独取消；预览仍按日列卡 |

## 二、已查证的事实（可直接采信，动手前自己复核一遍）

- 改前几何（`measurements.json`）：1200×800 气泡 720×660，列表前 chrome 215px，候选窗 360px（`max-height:45vh`）且窗内还有 155px 控件行 → 可见 3/19 行；960×640 见 2 行；200% 见 1 行且气泡自身滚动（848>758）、footer y=764–843 在 800px 视口外。
- 字号：候选行第二行 9.984px（`.modal label` 的 `.78rem` × `small{font-size:smaller}`，`styles.css:729`）；复选框 16×16。
- axe：预览步 1 条 serious `scrollable-region-focusable`（`.schedule-preview` 可滚无焦点入口）。
- **F01 根因**：`scheduling.ts` 的 `eligible` 过滤里 `(!item.deadlineLocal || gap.date <= item.deadlineLocal)` —— 逾期任务的截止日早于窗口首日，`eligible` 恒空，于是永远「当前 7 天暂时放不下」。
- **F04 根因**：候选行第二行读的是 `recommended`（全量计划），不是当前勾选的 `plan`；`buildSchedulePlan` 已返回 `unscheduledKeys` 但界面没接。
- 筛选行/搜索行/按钮行渲染在 `.schedule-candidates` **内部**，会随列表滚走（`candidates-scrolled` 场景里搜索框 y=-818）。
- 预选 = 推荐组合 = 容量充裕时「所有放得下的都勾上」（夹具 19 行勾 18）；没有分组、没有「恢复推荐」。
- 零默认时段时 19 行全「放不下」、主按钮禁用、无任何引导（`no-slots.png`）。

## 三、交付范围（按顺序，每步绿了再走下一步；不 git commit）

### W2a · 引擎输出（约 0.5 天）

- `scheduling.ts`：截止钳制（D1=a）；`SchedulePlan` 增加 `unscheduled: { key, reason, longestGapMinutes }[]`，`reason ∈ { below-minimum, no-slots, no-gap-that-day, fixed-start-busy, deadline-no-gap, gaps-too-short }`（预留 `continuous-unavailable` 不实现）；保留 `unscheduledKeys` 兼容字段。**排序口径与空档扣除算法一个字不改。**
- `scheduling.test.ts`：补逾期一条 + 六种原因各一条；旧用例不改断言即通过。
- 完成定义：`npx vitest run src/lib/scheduling.test.ts` 全绿。

### W1 · 容器与空间（约 1 天，D2=a）

- `AutoScheduleDialog` → 重写为 `SchedulePanel`：`FloatingPanel kind="action" wide closeOnOutsideClick`，`titleId` 指到头标题；类名 `.schedule-panel`，结构 `.schedule-head / .schedule-capacity / .schedule-toolbar / .schedule-body / .schedule-foot`（flex 列、`padding:0`、`overflow:hidden`、`max-height:min(72vh, 100dvh - 24px)`，照 `styles.css:1483`）。
- 头：返回箭头（仅预览步）+ `h2`（候选步「自动排程」、预览步「排程草案」）+ 一行副标题（`未来 7 天 · 可用 X · 已锁 N 个既有安排与时间块`）+ 「规则」`<details>`（收起态零高度，内含「仅追加到空档，不调整已有安排或时间块」）+ 关闭按钮。**删 44px 图标块与整行解释段。**
- 筛选 + 搜索 + 「恢复推荐」「清空」合并为头部一行，**不放进滚动区**。
- 候选窗 `flex:1` + 内部滚动 + `tabIndex=0 role="region"` + 底边淡出（`.review-detail-body.is-scrollable` 的 mask 做法）；行高 44，单行 = 复选 + 标题 + 右侧结果 chip。
- 底栏 sticky（`.floating-panel .form-actions` 已有规则，但本面板 `padding:0`，sticky 偏移要写 0 而不是 -16px）。
- 入口接线改为一个 `scheduling: { taskId: string | null; projectId: string | null } | null` 状态；锚点靠 `FloatingPanel` 的 trigger 回退（点击按钮即 activeElement），不要新传 rect。
- 测试同步：`App.test.tsx` 4 处 `getByRole("dialog", { name: "自动排程 Lite" })`（1113、1764、1791、2597）与 `e2e/phase1.spec.ts:112–116` 改名称「自动排程」。
- 完成定义：probe 复测 1200×800 可见 ≥8 行、960×640 ≥6 行、200% ≥3 行且主按钮与筛选行常驻、无横向滚动；滚到中段筛选仍可见；点空白关闭不丢数据；焦点归还触发按钮。

### W2b · 候选语义（约 1 天）

- 三段分组：`推荐本次安排`（= 全量 `recommended` 的组合，默认勾选，组头带「已选 N/M」+「恢复推荐」）→ `其他可安排`（全量排不进但**单独**能排进的项，逐个跑一次只含自己的 plan 判定，默认不勾）→ 折叠的 `另有 N 项暂时无法安排`（展开逐行给 W2a 的原因文案）。
- 逐行结果读**当前勾选的 `plan`**：已勾 = `今天/明天/8月6日 25 分钟` 或 `25/40 分钟`（部分安排时第二行补「剩余 X 分钟以后继续」）或 `当前组合放不下`；未勾 = 灰字 `推荐 …`／`单独可排 …`。行内只读事实补「已有 N 次未来安排」（读 `index.sessionsByTaskId`）与「已逾期 N 天」（D1=a）。
- 容量条改 chip 组：`已选 N` `M 个时段` `用 X` `可用 Y` `剩 Z`；`plan.usedMinutes > available` 时最后一枚改 `超出 Z`，并追加一枚可展开 chip「K 项只能部分安排或放不下」，展开为**行内**名单 + 原因（**不要嵌套 FloatingPanel**：子气泡 portal 到 body 后会被父面板的外部点击守卫关掉，一律用行内展开）。
- 筛选生效时顶部一行提示：`已按项目筛选 · 显示 a/b · 选择仍含其余 c 项 · 显示全部`；「选择搜索结果」改名「只选当前筛选结果」，会丢弃其它勾选时先行内两按钮确认。
- 习惯收组（D5=a）；零默认时段整段替换为空状态（一句事实 + 「去设置默认时段」跳 `lastPage: "appearance"` 并 + 「关闭」），真无任务与筛选无结果沿用 `.pool-empty` 的两支语言。
- 完成定义：probe 夹具复测——逾期任务带标记出现且可勾；超选名单列出 2 项及原因；零时段空状态有设置入口；六种原因各有一条 Vitest 文案用例；「恢复推荐」可回到初始组合。

### W3 · 预览步（约 1 天，D3=a）

- 按天分组的建议卡 `.schedule-card`：`--deemphasized-surface` 淡底 + 1px 虚线描边（P4-13 的语言，浅色对比 4.97 已验证）+ 时间 + 标题 + 时长 chip + **依据 chip** + 移除按钮（40px 命中）。依据在 `App.tsx` 算：习惯 → 已逾期/临期（`deadlineLabel`）→ 高优先级 → 项目下一项（项目内 sortOrder 最小的活动任务）→ 按池序。**不进 `scheduling.ts`。**
- 顶部汇总含「仍未安排 K 项」（= 已勾但不在 `plan.allocations` 的键）；底栏只留 `放弃预览`（quiet）+ `应用 N 个时段`（primary）；返回选择在头部箭头。
- 移除一张卡 = 取消该键勾选，留在预览步；全移除时预览区给一句空态 + 返回选择。
- 完成定义：axe 零违规（`scrollable-region-focusable` 消失）；移除后「应用 N 个时段」与容量 chip 同步减一；`App.test.tsx:2597–2607` 改断言卡片与移除，并新增「移除单项后应用只写其余时段」。

### W4 · 视觉令牌（约 0.5 天）

- 行内说明 ≥`.75rem`；整行 44px 命中（复选框视觉 18px + 整行 label）；行 10px 圆角 + `--line-soft`；容量 chip 化；删「Lite」与图标块；强调色只给主按钮与「今天」。
- 两主题各量一次对比度（容量 chip、依据 chip、去强调卡底 + 深字），**合成祖先 opacity**；改前/改后各拍一套对照（probe 或 `scripts/visual-evidence.mjs`）。
- 完成定义：probe 的 `smallFonts == []`；浅/深 × 100/200% 截图无折行无截断；axe 浅深各一轮零违规。

### W5 · 入口与命名（约 0.5 天）

- 项目卡补次操作「安排项目」→ 同一气泡但 `projectId` 作用域（候选只列该项目、预选该项目推荐组合）；单项入口（今日/截止/回顾/项目详情）打开后把目标行滚进视口并高亮 1.5s；任务池在 `autoScheduleAssist` 且 N>0 时头下加一行中性提示「现在 N 项可以安排 · 查看」。
- 完成定义：入口用例全绿；probe `single-task-entry` 场景目标行在视口内。

## 四、明确不做（越界即停并回报）

- 不改 SQLite schema、不动 `applyScheduleDraft` 单事务与「撤销本次自动排程」的 undo 标签（测试依赖）。
- 不改 `buildSchedulePlan` 的排序与空档算法，只加输出；不做预览拖动（D3=a）；不做「需要连续时段」（D4=a）；不引入新依赖、不做虚拟化。
- 不动任务池、日历、设置页的既有控件；不动回顾/截止/项目页。
- **不回退任何既有改动**：评估基线对应的任务池改动已提交为 `ac109eb`（0.1.18 为 `fdbc3e2`）。开工时若工作树里出现新的未提交改动（用户可能在并行做事），先 `git status` 看清、在其上适配，**绝不 `git checkout`／`git stash` 掉它们**；`src/components/ui/number-field.tsx`／`time-picker.tsx` 本轮完全不要碰。
- 不 `git commit`、不 push；证据落 `output/2026-10-24_autoschedule-implementation/`（gitignored），入库截图另放 `docs/reports/auto-schedule-implementation-2026-10-24/`。

## 五、验收（每条给实测数值）

1. 结构账复测：把 `output/2026-10-24_autoschedule-assessment/probe.mjs` **复制**到 `output/2026-10-25_autoschedule-after/probe.mjs` 再跑（脚本把截图与 `measurements.json` 写在自己所在目录；**不要在原目录跑，改前基线会被覆盖**），改后数字与评估报告 §2 的改前表并排写进实施报告；1200 ≥8 行、960 ≥6 行、200% ≥3 行且主按钮/筛选常驻、无横向滚动、无气泡级滚动条。
2. axe：候选步与预览步 × 浅/深 × 1200/100% 与 1200/200% 零违规；跑之前先断言目标元素渲染且在屏幕上（PROJECT-GUIDE §10 的两条硬约束）。
3. 对比度：新增/改色的每一处浅/深各给实测值，门槛 4.5（大字/控件 3）。
4. `npm run check` 四步全绿；Vitest 用例数**不减**（开工先跑一遍记基线，报告给前后两个数）；Playwright 单独跑 `node scripts/run-e2e.mjs --workers=1`。
5. 键盘：Tab 进出候选滚动区、Esc 关气泡、关闭后焦点回触发按钮；`kind="action"` 不锁背景（打开气泡时任务池仍可点）。

## 六、验证命令

```powershell
npx vitest run src/lib/scheduling.test.ts
npm test
npm run build
node scripts/run-e2e.mjs --workers=1
cp -r output/2026-10-24_autoschedule-assessment output/2026-10-25_autoschedule-after   # 复制探针，别在原目录跑
node output/2026-10-25_autoschedule-after/probe.mjs
```

- `test:native` 若报 `os error 5`：删 `src-tauri/target/debug/incremental`，与结果无关。
- probe 默认端口 4178；若被占用改脚本常量，不要杀别人的进程。

## 七、仓库清理约定（长期有效）

见 `AGENTS.md` 的 `### Repository cleanup` 与 `_quarantine/README.md`：要丢的一律先移进 `_quarantine/<YYYY-MM-DD>_<简短说明>/`，不散删、不 `rm -rf`；**Agent 只搬不丢**；走 `ops-batch`。

## 八、完成定义

1. 代码 + 用例（W2a–W5 各步的完成定义全满足）。
2. 写 `docs/reports/auto-schedule-implementation-2026-10-24.md`：改前/改后结构账并排表、六步各自的实测验收值、依据 chip 的判定表、对比度实测、axe 结果、未做项与新发现的不一致。
3. 截图入库 `docs/reports/auto-schedule-implementation-2026-10-24/`（候选 1200/960/200/深、预览 1200/200、零时段、超选、单项入口）。
4. 文档同步：`docs/PROJECT-GUIDE.md` §5（`App.tsx` 行里自动排程的描述、`scheduling.ts` 行补 `unscheduled` 输出）、§11 测试数量；`docs/design/UI-SPEC.md`「自动排程交互」段**加一句**「候选选择与草案预览在同一非模态气泡内完成，不锁背景；点空白或 Esc 关闭并丢弃本次勾选」——否则下次又会有人把它改回居中模态。
5. 汇报：改了哪些文件、结构账改前/改后、是否触发过任何回退、仍需用户决定的事项。

## 附：五条提醒

1. **`kind="action"` 的点空白即关是特性不是缺陷**：勾选是纯临时状态，关掉就丢，符合规格「临时修改不改变长期规则」；但 `busy`（应用提交中）必须不可关。
2. **不要在气泡里嵌套 `FloatingPanel`**（超选名单、规则说明、习惯展开都用行内展开/`<details>`）：子气泡 portal 到 `body`，父面板的外部点击守卫会把它当成「点在自己外面」而关掉父面板。
3. **`.floating-panel` 的 sticky 头/底规则带 -16px 偏移**（对应 16px padding）；本面板 `padding:0`，照抄会差 16px，要重写偏移。
4. **`SelectField` 没有 aria-label 入参**：项目筛选要么外面包 `<label>`（可见短标签「项目」），要么给 `id` + 外部 `label htmlFor`；别让它裸奔成无语义下拉。
5. **200% 的行数口径是「≥100% 的一半且 ≥3」**，不是和 100% 比绝对值；根字号翻倍后视口装下的逻辑行数必然减半，别为了凑行数缩字号或改 px 高度。
