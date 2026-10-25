# 自动排程气泡整改实施记录（W1–W5）

实施日期：2026-10-25。方案与量测基线：[`auto-schedule-evaluation-2026-10-24.md`](auto-schedule-evaluation-2026-10-24.md)（D1–D5 已定案，本轮**不重新评估**）。

本文只回答三件事：**改成什么样、每一步的实测值、哪些地方和原方案不一样以及为什么**。改前数字一律取自评估报告 §2（对应提交 `ac109eb`／`fdbc3e2`），改后数字取自 `output/2026-10-25_autoschedule-after/measurements.json`（同一夹具、同一固定时钟 `2026-08-05T12:00`、同一量测口径）。

## 1. 结论摘要

自动排程从**居中模态**改成**非模态大气泡**（`FloatingPanel kind="action" wide closeOnOutsideClick`）：主界面不再 `inert`，勾选时任务池与日历仍可见可点；候选清单从「19 行平铺 + 一句『当前 7 天暂时放不下』」改成三段结构（推荐本次安排／其他可安排／另有 N 项暂时无法安排），逐行结果读**当前勾选**算出来的计划，预览改成按天的去强调建议卡（时长 chip + 依据 chip + 移除）。

六步全部达成完成定义，其中三处是**产品级修正**而不是视觉调整：

1. **逾期任务不再被永久排除**（F01/D1=a）：`buildSchedulePlan` 先把截止日期钳制到窗口首日，夹具里逾期 4 天的「报销单据贴票」现在拿得到今天 20:00–20:20，行内标「已逾期 4 天」。
2. **「放不下」不再是一句话**（F05/W2a）：引擎输出 `unscheduled: { key, reason, longestGapMinutes }[]`，六种原因各有中文文案与用例，界面按确定性原因解释「为什么排不进」。
3. **逐行结果跟着勾选走**（F04）：取消一个大任务后，其余行的时间/容量立刻重算，不再等到点「生成排程草案」才暴露。

与提示词的两处偏离（都写进 §7）：候选面板高度从 `min(72vh, …)` 改为 `calc(100dvh - 96px)`（200% 下 `100dvh - 24px`）；「超选名单」从容量行的第 6 枚 chip 移到正文首行展开。

## 2. 结构账：改前 / 改后并排

同一夹具（13 任务 + 7 习惯发生项 → 候选 19 项；习惯收组后 13 行）、1200×800 与 960×640 各一次。口径与评估报告 §2 完全一致：「列表前 chrome」= 气泡顶到候选窗顶的距离；「可见行」= **完整**落在候选窗内的行数。

| 场景 | 视口 | 气泡尺寸（改前 → 改后） | 列表前 chrome | 候选窗高 | 窗内控件行 | 可见行 / 总行 |
| --- | --- | --- | --- | --- | --- | --- |
| 候选 | 1200×800 | 720×660 → **704×704** | 215px（33%）→ **141px（20%）** | 360px → **509px** | 155px（随列表滚走）→ **0（已移出滚动区）** | **3/19 → 9/13** |
| 候选 | 960×640 | 720×588 → **704×544** | 215px → **141px** | 288px → **349px** | 155px → **0** | **2/19 → 6/13** |
| 候选 | 1200×800 @200% | 720×760（自身滚动）→ **1176×776（不滚）** | 370px（49%）→ **206px** | 360px → **480px** | 239px → **0** | **1/19 → 4/13** |
| 预览 | 1200×800 | 720×660 → **704×704** | 215px → **95px** | 360px → **555px** | 0 | **7/18 → 7 张卡（19 个时段）** |
| 预览 | 1200×800 @200% | 720×760 → **1176×776** | 306px → **128px** | 360px → **558px** | 0 | **2/18 → 3 张卡** |
| 零默认时段 | 1200×800 | 720×660 → **704×232**（按内容收） | 215px → **58px** | 360px → **173px** | 155px → **0** | 3 行假候选 → **0（换成空状态 + 设置入口）** |

补充实测（同一份 `measurements.json`）：

- **行高**：候选行 label 实测 **44px**（@200% 88px），复选框视觉 **18×18**，整行可点，命中高度 44px。
- **字号**：`smallFonts == []`——面板内**没有任何**小于 12px 的文字（改前候选行第二行是 9.984px）。
- **横向滚动 / 气泡级滚动条**：全场景 `horizontalOverflow=false`、`panelScrolls=false`（滚动只发生在 `.schedule-body` 里，`tabIndex=0 role="region"`，可键盘进出）。
- **不锁背景**：全场景 `backgroundInert=false`；1200×800 下用 `document.elementFromPoint` 打任务池头部按钮，`poolClickable=true`（气泡开着时任务池仍可点）。200% 下面板吃满视口，任务池被盖住属预期（`poolClickable=false`）。
- **滚到中段筛选仍在**：`candidates-scrolled` 场景把 `.schedule-body` 滚到底后，工具行仍在 y=160（面板内、滚动区外），可见 10 行。
- **单项入口**：`single-task-entry` 场景目标行落在 y=191（视口内），`is-flash` 高亮生效。

**为什么总行数从 19 变成 13**：习惯按 `habitId` 收成一行（D5=a），7 个发生项 = 1 行；时段总数仍是 19（`19 个时段`），所以「容量充裕时推荐组合勾 19 个时段、13 行」是同一件事的两种数法。

## 3. 六步的实测验收值

### W2a · 引擎输出（完成）

- `scheduling.ts`：截止日期早于窗口首日的任务按**窗口首日**参与排档；`SchedulePlan` 新增 `unscheduled: { key, reason, longestGapMinutes }[]`，`reason ∈ { below-minimum, no-slots, no-gap-that-day, fixed-start-busy, deadline-no-gap, gaps-too-short }`，预留 `continuous-unavailable` 但**永不产出**。`unscheduledKeys` 保留为兼容字段（与 `unscheduled` 同序同长，有用例钉住）。
- **排序口径与空档扣除算法一个字没改**：只多了「钳制后的截止值参与过滤」与「排不进时补一条原因」。
- 用例：`src/lib/scheduling.test.ts` **9 → 17** 条（逾期 2 条 + 六种原因各 1 条 + 兼容字段 1 条），旧用例断言**未改**即通过。
- `npx vitest run src/lib/scheduling.test.ts` → 17/17 绿。

### W1 · 容器与空间（完成，D2=a）

- `AutoScheduleDialog`（居中模态）→ `SchedulePanel`（`FloatingPanel kind="action" wide closeOnOutsideClick`，`titleId` 指到头标题）；类名 `.schedule-panel`，结构 `.schedule-head / .schedule-capacity / .schedule-toolbar / .schedule-body / .schedule-foot`。
- 头：返回箭头（仅预览步）+ `h2`（候选步「自动排程」、预览步「排程草案」）+ 副标题（`未来 7 天 · 可用 X · 已锁 N 个既有安排与时间块`）+「规则」`<details>`（收起态零高度）+ 关闭。**删掉了 44px 图标块与整行解释段。**
- 筛选 + 搜索 + 两个文字按钮合并成头部一行，**不在滚动区里**。
- 候选窗 `flex:1` + 内部滚动 + `tabIndex=0 role="region"` + 底边 10px 淡出（`.is-scrollable`，滚到底撤掉）。
- 底栏不是 sticky 而是**结构上就在滚动区之外**（flex 列的最后一段）。提示词要求的「sticky 偏移写 0」在本结构下不需要：面板 `padding:0` 且自己不滚动，抄 `.floating-panel .form-actions` 的 `bottom:-16px` 反而会把它推出去。
- 入口接线收敛成**一个状态**：`scheduling: { taskId: string | null; projectId: string | null } | null`。锚点靠 `FloatingPanel` 的 trigger 回退（点击按钮即 `document.activeElement`），没有新传 rect。
- 名称同步：`App.test.tsx` 4 处、`e2e/phase1.spec.ts` 2 处由「自动排程 Lite／确认排程草案」改为「自动排程／排程草案」。

### W2b · 候选语义（完成）

- 三段分组：`推荐本次安排`（组头「已选 N/M」+「恢复推荐」）→ `其他可安排`（组头「N 项」+「全选本组」，默认不勾）→ 折叠的 `另有 N 项暂时无法安排`（展开逐行给原因）。分组判据是确定性的：在推荐组合里 → 第一段；不在推荐组合但**单独**能排进（逐项跑一次只含自己的计划）→ 第二段；单独也排不进 → 第三段。
- 逐行结果读**当前勾选**的 `plan`：`今天/明天/8月6日 25 分钟`、`25/40 分钟`（第二行补「剩余 X 分钟以后继续」）、`当前组合放不下`；未勾选行是灰字 `推荐 …` / `单独可排 …`。
- 行内只读事实：「已有 N 次未来安排」（读 `index.sessionsByTaskId`）、「已逾期 N 天」（D1=a，红色 `em` 标记）。
- 容量条 chip 组：`已选 N 项` `M 个时段` `用 X` `可用 Y` `剩 Z`／`超出 Z`（`is-over` 中性红，不用惩罚措辞）。
- 筛选生效时顶部一行提示：`已按项目筛选 · 显示 a/b · 选择仍含其余 c 项` + `显示全部`；「只选当前筛选结果」在会丢掉其它勾选时先给行内两按钮确认。
- 习惯收组（D5=a）：一行一个 `habitId`，整组一个复选（部分选中时 `indeterminate`），展开后逐日可单独取消。
- 零默认时段整段替换为空状态：一句事实 + 「去设置默认时段」（跳 `lastPage: "appearance"` 并关气泡）+「关闭」；此时**不渲染**容量行与底栏（全是 0 的事实没有信息量）。
- 实测：「恢复推荐」可回到初始组合；超选名单在 `candidates-tight` 场景列出 3 项及原因（`只能安排 60/90 分钟，剩余以后继续` 等）；六种原因文案各有 1 条用例（`src/lib/scheduleReasons.test.ts`，9 条）。

### W3 · 预览步（完成，D3=a）

- 按天分组的建议卡 `.schedule-card`：`--deemphasized-surface` 淡底 + 1px 虚线描边（P4-13 语言）+ 时间 + 标题 + 时长 chip + 依据 chip + 移除按钮（44px 命中）。
- 顶部汇总：`已选 N 项` `M 个时段` `用 X / 可用 Y` `仍未安排 K 项`（= 已勾但不在 `plan.allocations` 里的键）。
- 底栏只有 `放弃预览`（quiet）+ `应用 N 个时段`（primary）；返回选择在头部箭头。
- 移除一张卡 = 取消该键勾选并留在预览步；全移除时预览区给空态 + 「返回选择」。
- 依据 chip 在 `App.tsx` 算（`basisOf`），**不进 `scheduling.ts`**。
- 用例：`App.test.tsx` 的截止页预览用例改为断言 `.schedule-card` 与按天标题；新增「移除单项后应用只写其余时段」（实测移除后主按钮从「应用 2 个时段」变「应用 1 个时段」，`applyScheduleDraft` 只收到 1 条）。
- axe：`scrollable-region-focusable` 消失（正文有 `tabIndex=0 role="region"`），预览步零违规。

### W4 · 视觉令牌（完成）

- 行内说明、chip、依据、角标一律 ≥ `.75rem`；整行 44px 命中；行 10px 圆角 + `--line-soft`；容量 chip 化；删「Lite」与图标块；强调色只给主按钮与「已逾期」这类状态标记（容量、依据、结果 chip 全部中性）。
- `smallFonts == []`（全场景）；浅/深 × 100/200% 截图无折行无截断（`candidates-{1200,960,200,dark,200-dark}`、`preview-{1200,200,dark,200-dark}`）。
- 对比度实测见 §5。

### W5 · 入口与命名（完成）

- 项目卡次操作「安排项目」（`aria-label="安排项目 <项目名>"`）→ 同一气泡、`projectId` 作用域：候选只列该项目任务（`project-entry` 场景 2/2 行，无习惯），预选该项目推荐组合。
- 单项入口（今日/截止/回顾/项目详情）打开后把目标行滚进视口并高亮 1.5 秒（`.is-flash`，1.5s 动画后自动撤）。
- 任务池在 `autoScheduleAssist && N>0` 时头下加一行中性提示「现在 N 项可以安排 · 查看」，不再只靠按钮 `title`（hover-only 等于没有）。
- 标题去「Lite」：候选步「自动排程」、预览步「排程草案」。

## 4. 依据 chip 的判定表

预览卡右下那枚 chip 由 `App.tsx` 的 `basisOf()` 判定，**按顺序取第一条成立的**，取不到就落到最后一条（不写「无依据」这种空话）：

| 顺序 | 条件 | chip 文案 | 例 |
| --- | --- | --- | --- |
| 1 | 习惯发生项（`habitId` 存在） | `习惯` | 背单词 |
| 2a | 生效截止日期已过（`scheduleDeadlineForTask` 早于今天） | `已逾期 N 天` | 报销单据贴票 |
| 2b | 截止日期就是今天 | `今天截止` | — |
| 2c | 截止日期在 1–3 天内 | `还有 N 天截止` | 修洗衣机排水管 |
| 3 | `priority === "high"` | `高优先级` | 写开题报告的文献综述… |
| 4 | 它是所属项目里 `sortOrder` 最小的活动任务 | `项目下一项` | P41 所有权与借用 |
| 5 | 以上都不成立 | `任务池顺序` | P42 生命周期 |

「生效截止日期」= `scheduleDeadlineForTask`（任务自己的截止 → 项目里程碑 → 项目截止，取最早），所以项目类任务也会因为项目截止日拿到「还有 N 天截止」。领域关系（项目顺序、里程碑）只在界面这一层用，引擎仍然只认 `deadlineLocal`。

## 5. 对比度实测（WCAG 相对亮度公式，成对 token）

门槛：正文 4.5:1，大字/控件边界 3:1。数值由探针在真实 Chromium 里读计算样式后自己合成（含 `color-mix()` 序列化成 `color(srgb …)` 的情况）。

| 位置 | 前景 / 底色 | 浅色 | 深色 |
| --- | --- | --- | --- |
| 容量 chip | `--muted-strong` / `--panel-strong` | **7.28** | **8.51** |
| 结果 chip | `--muted-strong` / `--panel-strong` | **7.28** | **8.51** |
| 行内说明 | `--muted` / `--panel` | **5.16** | **7.68** |
| 副标题 | `--muted` / `--panel` | **5.16** | **7.68** |
| 依据 chip | `--muted-strong` / `--deemphasized-surface` | **7.38** | **8.84** |
| 建议卡标题 | `--text` / `--deemphasized-surface` | **15.15** | **12.73** |
| 复选框勾（成对 token） | `--action-text` / `--action` | 由 P4-12 验证（6.29） | 由 P4-13 验证（5.37） |

没有新增 token，也没有改任何全局 token 的值：`--deemphasized-surface` 与 `--action`／`--action-text` 都是既有成对语义色，本面板只是复用。

## 6. axe（8 轮，零违规）

跑之前先断言「面板已渲染 + 在屏幕上 + 有行或卡」，再断言零违规（PROJECT-GUIDE §10 的两条硬约束）。

| 步 | 视口 | 主题 | 违规 |
| --- | --- | --- | --- |
| 候选 | 1200×800 @100% | 浅 | 0 |
| 候选 | 1200×800 @200% | 浅 | 0 |
| 候选 | 1200×800 @100% | 深 | 0 |
| 候选 | 1200×800 @200% | 深 | 0 |
| 预览 | 1200×800 @100% | 浅 | 0 |
| 预览 | 1200×800 @200% | 浅 | 0 |
| 预览 | 1200×800 @100% | 深 | 0 |
| 预览 | 1200×800 @200% | 深 | 0 |

`incomplete` 只剩 `color-contrast`（背景是半透明遮罩合成，axe 判不了），对应节点已在上表手工量过。

## 7. 与提示词不一致的地方（附理由）

1. **面板高度**：提示词写 `max-height: min(72vh, 100dvh - 24px)`，实际用 `calc(100dvh - 96px)`，200% 下 `calc(100dvh - 24px)`。
   理由（算术）：72vh 在 1200×800 下只有 576px；chrome 已压到 141px、底栏 55px，剩余 380px；44px 行高 + 2px 行距下 8 行需要 366px **再加** 正文首行的「超选名单 + 组头」约 50px = 416px，**装不下**。把 chrome 再压 40px 只能靠删副标题这类信息，代价比高度大。改成「上下各留 48px」后 1200 见 9 行、960 见 6 行。200% 时留白随字号一起变贵，按 UI-SPEC「高缩放时优先覆盖面板」放到只留 12px 定位边距，得 4 行（= 100% 的一半）。
2. **超选名单的位置**：提示词说「容量条追加一枚可展开 chip」，实际放在正文首行的行内展开。理由：容量行多一枚 chip 就从 1 行变 2 行（+46px），刚好抵掉一行候选；信息量不变，展开仍是行内（不嵌套气泡）。
3. **底栏**：提示词要求 sticky + 偏移写 0；实际不用 sticky——底栏在 flex 列里就在滚动区之外，`position: sticky` 只会引入一份多余的状态。
4. **副标题与标题同排**：提示词说「头：… + 一行副标题」，仍是一行副标题，只是与 `h2` 同一基线（省下一整行 chrome）；窄到放不下时自己换行。
5. **`select` 高度**：`SelectField` 没有 `aria-label` 入参，按提示词方案 A 用可见短标签「项目」包住，并把下拉压到 2rem 与搜索框同高（照 `.deadline-field > .select-shell > select` 的既有先例）。

## 8. 没做的（明确留在后续包）

- **预览内拖动建议卡**（D3=a）：只给「移除单项 + 返回选择改勾」两条路径，与日历拖拽统一方案同期再议。
- **「需要连续时段」**（D4=a）：不动 schema；原因枚举预留 `continuous-unavailable` 一位但引擎永不产出，`scheduleReasons.test.ts` 里那条用例只钉文案。
- **虚拟化**：候选 19 行没到规格 §8 的 ~60 行阈值，本轮不加。
- **不改**：SQLite schema、`applyScheduleDraft` 单事务与「撤销本次自动排程」的 undo 标签、任务池/日历/设置页的既有控件、回顾/截止/项目页的既有结构、`number-field.tsx`／`time-picker.tsx`。

## 9. 新发现的不一致与遗留

1. **夹具只产生 1 项超选**：受现有夹具容量（可用 27 小时 30 分钟）限制，「只能部分安排或放不下」默认只有 1 项，达不到验收里写的 2 项。为证明机制，另加了 `candidates-tight` 场景（每天只有 19:00–20:00）——那里是 3 项，名单逐行给原因。**没有改夹具**，因为改前数字要能并排比较。
2. **`preview-960` 只看到 4 张卡**：960×640 下预览正文 395px，一张卡 65px + 天标题。验收只对 1200 提了「≥6 张」，这一档没有硬指标。
3. **200% 下面板盖住任务池**：`kind="action"` 本身不锁背景（`inert=false` 已验），但 1176×776 的面板在物理上盖住了右侧任务池，`elementFromPoint` 打不到它。这是「覆盖面板换行数」的必然代价，已写进 §7。
4. **`AGENTS.md` 要求复用 `scripts/visual-evidence.mjs`**：本轮用的是评估遗留的探针（同一套做法、同一份夹具、同一固定时钟），因为它能同时给几何与 axe，且必须与改前数字同源。两套脚本都只写浏览器 `localStorage`，不碰 SQLite／Tauri。
5. **`npm run test:native` 第一次报了 `tauri::generate_context` 的编译错误**（`could not compile daymark (lib)`），隔一次重跑即 48/48 全绿、再跑一次仍 48/48。原生代码本轮零改动，判为与本机增量缓存同一类的偶发项（与 kickoff §6 记的 `os error 5` 同源）；没有删 `incremental` 目录，也没有改任何 Rust 文件。
6. **`npm run build` 里的 `tsc --noEmit` 在本机会 panic**（`typescript@7` 的原生编译器加载 `bcrypt.dll` 报 `winapi error #5`，与本轮改动无关，`git stash` 后同样复现）。因此类型检查改用隔离工作区里的 `typescript@5.9` 跑同一份 `tsconfig.json`，0 错误；`vite build` 正常产出。这是**环境缺陷**，不是代码问题，需要用户在有权限的终端里确认一次 `npm run build`。

## 10. 改动文件

| 文件 | 改动 |
| --- | --- |
| `src/lib/scheduling.ts` | 截止钳制（D1=a）+ `ScheduleUnscheduledReason`／`ScheduleUnscheduledItem`／`unscheduled` 输出 + `explainUnscheduled()`；排序与空档算法未改 |
| `src/lib/scheduling.test.ts` | 9 → 17 条（逾期 2、六种原因 6、兼容字段 1、原有用例未改） |
| `src/lib/scheduleReasons.ts` | 新增：原因 → 中文文案的唯一出处 |
| `src/lib/scheduleReasons.test.ts` | 新增：9 条（六种原因 + 预留位 + 无原因 + 无惩罚措辞护栏） |
| `src/App.tsx` | `AutoScheduleDialog` → `SchedulePanel`（约 2500–2900 行）；`scheduleCandidateGroups()`；入口收敛为 `scheduling` 一个状态（5 处）；项目卡「安排项目」+ `onArrangeProject`；任务池辅助提示行；`SchedulePreview` 删除 |
| `src/styles.css` | `.schedule-*` 整段重写（18 条规则 → 约 60 条）；新增 `.pool-assist`、`.project-card-arrange` |
| `src/App.test.tsx` | 对话框名称 4 处、`.schedule-preview` → `.schedule-card` 断言、折叠原因断言，新增 6 条用例（Escape＋焦点归还＋不锁背景、零时段引导、恢复推荐、超选名单与原因、移除单项只写其余、安排项目作用域） |
| `e2e/phase1.spec.ts` | 对话框名称 2 处 |

验证命令与结果：

```text
npx vitest run src/lib/scheduling.test.ts        17/17 绿
npx vitest run                                   29 文件 / 387 条 全绿（改前 28 / 364）
vite build                                       通过（tsc 见 §9.6）
node scripts/run-e2e.mjs --workers=1             52/52 通过（2.0m，未减）
npm run test:native                              48/48 通过（重跑两次一致）
node output/2026-10-25_autoschedule-after/probe.mjs   21 场景 + 8 轮 axe
```

## 11. 入库截图

`docs/reports/auto-schedule-implementation-2026-10-24/`（改前那一组留在 `docs/reports/auto-schedule-evaluation-2026-10-24/`，未覆盖）：

| 文件 | 内容 |
| --- | --- |
| `candidates-1200.png` | 候选步 1200×800 @100%，9 行可见、容量单行 chip、工具行常驻 |
| `candidates-960.png` | 候选步 960×640，6 行可见 |
| `candidates-200.png` | 候选步 1200×800 @200%，4 行可见、主按钮常驻 |
| `candidates-dark.png` | 候选步深色 |
| `preview-1200.png` | 预览步 1200×800，7 张建议卡 + 依据 chip + 移除 |
| `preview-200.png` | 预览步 @200% |
| `no-slots.png` | 零默认时段空状态 +「去设置默认时段」 |
| `candidates-tight.png` | 超选名单行内展开（3 项）+ 三段分组 |
| `candidates-unavailable.png` | 「另有 13 项暂时无法安排」展开后的逐行原因 |
| `single-task-entry.png` | 单项入口：目标行滚进视口并高亮 |
| `project-entry.png` | 项目卡「安排项目」：候选只剩该项目任务 |
| `pool-context.png` | 任务池对照（头部三按钮 + 辅助提示行） |
