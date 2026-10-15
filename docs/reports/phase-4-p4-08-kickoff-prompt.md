# 阶段 4 P4-08 开工提示词：日／周／月回顾页面、下钻与回顾偏好

> 用法：整段复制到新会话作为开场提示。上一工作包 P4-07（周期统计引擎）已完成、已提交并通过独立复核（`27f9251` + `e40709a`）。

---

你在 Daymark 仓库（F:\PythonProject\Daymark）继续阶段 4。现在开工 **P4-08：日／周／月回顾页面、下钻、图表等价数据与回顾偏好**。

## 先读（按顺序，不要跳过）

1. `AGENTS.md` —— 工作规则（含仓库清理约定）。
2. `CONTEXT.md` —— 领域语言与产品原则。重点「回顾」「进度」「进度事件」「执行记录」「实际投入」「未执行时段」「待回顾」「待续」「里程碑达成条件」。页面只呈现既有事实，**不评分、不算连续天数、不把未记录读成失败**。
3. `docs/PROJECT-GUIDE.md` —— §4 运行时数据流、§5 代码地图、§8 设置持久化、§10 主题与基础无障碍、§11 测试体系、§12 常见修改入口，以及末尾的「文档同步协议」。
4. `docs/specs/0005-phase-4-daily-workflow-and-reliability.md` —— **逐字读 §7.1／§7.2／§7.4**、§3（用户路径与界面原则）、§9（模块划分：`src/components/review/` 一行）、§10 的 P4-08 行、§11 的 **AC13／AC14**、§13、§14。
5. `docs/reports/phase-4-p4-07-implementation.md` —— **§3 契约**（引擎已给出的类型，照抄不要重造）、§5 刻意行为变化、§7 未做与边界、§8 发现的不一致、**§9 仍需用户决定**。
6. `docs/reports/phase-4-open-decisions.md` —— §0.5 是已拍板的 D1–D6；本包**不要**改动其中任何一条。
7. `src/lib/review.ts` —— 引擎现状（`buildReview`／`buildReviewFromIndex`）。
8. `src/App.tsx` 的 `ReviewPage`（约 1767 行）与导航表第 52 行 —— 这是本包要替换掉的现状。

## 引擎已经给好的东西（直接用，不要重算）

```ts
type ReviewPeriod = "day" | "week" | "month";
interface ReviewQuery { period: ReviewPeriod; anchorDate: string; projectId: string | null }

function reviewRange(period, anchorDate): { startDate: string; endDate: string }
function buildReview(workspace, query, now: Date): ReviewResult
function buildReviewFromIndex(index: WorkspaceIndex, query, now: Date): ReviewResult
```

`ReviewResult` 含 `days`（周期内每一天，含空白天，便于画零基线）／`progress`／`actual`／`plan`／`pendingReview`／`notAdvanced`／`carryoverTaskIds`／`tasks`（`ReviewTaskDetail[]`）／`milestones`／`notes`。字段明细见 P4-07 报告 §3。

**三条硬规矩**：

- 页面**只建一次索引**（`createWorkspaceIndex`），用 `buildReviewFromIndex`，不要每行再扫全量数组。
- `ReviewResult` 是**只读投影**：`tasks[].taskId`／`milestones[].milestoneId` 是原始 ID，派生记录不是可保存对象；行级动作把原始 `Task`／`Project` 交给 `App`。
- **不得在页面里另写统计公式**。规格 §7.4 明确：月历摘要、今日待回顾、回顾共享底层事实选择器，「不能维护三份不一致算法」。发现引擎缺某个派生值时，加进 `review.ts`／`workspaceSelectors.ts`，不要在组件里补算。

## 交付范围

### 1. 新增 `src/components/review/`

把 `App.tsx` 里的 `ReviewPage` 迁出并扩展成周期页面（`App.tsx` 只保留路由与回调）。按规格 §7.4 的**页面顺序**：

**① 成果与待续** → **② 投入和进度图** → **③ 任务／项目明细**

- **周**显示七日图；**月**显示自然月日期概览；日就是那一天。
- **净负进度必须有零基线与文字说明，不能用正向热度暗示**（不要用"越深越好"的色阶）。
- **投入图只用分钟，进度图只用百分点** —— 两个单位不能混进同一张图。
- **所有图表都要有等价数值表**，不依赖悬停（悬停是增强，不是唯一入口）。
- 空周期不绘制全零图表，也不把「未记录」解释为失败（现有页面的 `EmptyState` 文案可沿用）。

### 2. 周期选择与回顾偏好（P4-05 已备好字段，本包接线）

- `reviewPeriod`（默认 `"week"`）与 `reviewAnchorDate`（默认 `null`）已在 `settings.ts` 规范化，**本包负责读写**：
  - 首次进入默认当前周；此后记住周期与锚点。
  - 用户切换周期／翻页 → 经既有 `updatePreferences` 写偏好（沿用 SettingsRepository 的写入队列，不要另建通道）。
  - `reviewAnchorDate` 为 `null` 时按「当前周期」计算（`now` 注入）。
- 规格 §7.1 还有一句「从某日进入则临时聚焦该日，明确更新当前查询」。**现状没有任何「从某日进入回顾」的入口**：不要为了这句话凭空造一个入口；如果本包不新增，就在报告里明确写「该路径暂不存在」，不要假装支持。

### 3. 下钻与明细

- 点击或键盘激活**日期／项目／任务**，在页面内打开明细区，显示**原始事件时间、进度变化、实际起止、已记录备注**（`ReviewTaskDetail.events`／`recordedMs`／`runningCount` 等）。
- 键盘可达：明细区要能 Tab 进出、`Esc` 关闭，关闭后焦点回到触发元素（照既有编辑气泡与截止页的做法，不要另发明一套）。
- **回到汇总要保留查询与滚动**（同会话内有效、重启不恢复 —— 照 P4-06 截止页的处理：App 层内存 + `ref` 记滚动，不写 Store）。
- **未知对象引用显示「来源不可用」并保留仍成立的事实，不让整个页面崩溃**（照 `deadlineItemSourceExists` 的思路，自己实现一个等价的判据即可，别硬套截止页的类型）。

### 4. 移除兼容入口

规格 §7.4：「先保留 `buildSevenDayReview` 作为兼容入口，迁移调用者到新引擎后移除。」本包就是那个「迁移调用者」的时机：

- 把 `App.tsx` 里 `ReviewPage` 对 `buildSevenDayReview` 的调用换成 `buildReview`／`buildReviewFromIndex`。
- 然后**删掉 `buildSevenDayReview` 及其在 `review.test.ts` 里的兼容用例**（或改写为等价的新引擎用例）。
- 删之前确认全仓没有别的调用者（`grep -rn "buildSevenDayReview" src/ e2e/`）。P4-07 报告 §9.5 关于「第三个参数是否保持必需」的问题**随之作废**，不要再讨论。

### 5. 导航标签（需要你决定，给了建议）

导航第 52 行现在是 `{ id: "review", label: "7 天回顾" }`，页面标题是「最近 7 天回顾」。有了日／周／月之后这两个名字都不再准确。

- **建议**：导航标签改成「**回顾**」，页面标题按周期给出（如「本周回顾」「2026 年 8 月回顾」「8 月 5 日回顾」）。
- `PageId` 仍为 `"review"`，**`PAGE_IDS` 不用动**。
- 改名必须同步三处，缺一会出现"点得到但标题对不上"：`src/App.tsx` 导航表、`src/App.test.tsx:1870` 的导航逐项用例（`["review", "7 天回顾", "最近 7 天回顾"]`）、`e2e/phase1.spec.ts:131-132`。
- 若你选择不改名，就在报告里写明理由，并保证页面标题能区分周期。

## 明确不做（越界即停并回报）

- **不新增依赖**。图表用**纯 SVG／CSS**手写（现有页面就是 CSS 条），不要引入图表库 —— 规格 §9 与 §12 都写明本阶段不新增依赖。
- 不改 `review.ts` 的**统计口径**（P4-07 刚钉死，九项口径与 `notes` 都是它的输出）。页面只呈现。
- 不新增 SQLite 迁移／字段（schema 仍 v7）、不新增 Tauri Command。
- 不改 P4-04／P4-05 的滚动仲裁与「程序性滚动不写偏好」闸门；不改缩放范围与预设。
- 不改截止页（P4-06）与决议 D1–D6 的任何一条。
- 明细区的筛选／焦点／滚动**不写 Store**（与截止页同理）；只有 `reviewPeriod`／`reviewAnchorDate` 是偏好。
- 不做 M12 的长列表性能测量（P4-09）。

## 必须保持（回归红线）

计划时段／实际执行／手动进度始终分离；时间流逝不自动记未推进；里程碑到期结果不可改写；P4-04～P4-07 的全部回归（AC05 日↔周十次不漂移、AC06 缩放与拖拽、AC07 预设恒等、AC08～AC10 截止页、AC11／AC12 引擎口径）；既有编辑气泡语义；撤销提示的五秒收起与悬停暂停（`6229c73` 刚修，别回退）。

## 验收

- **AC13**：日／周／月汇总与明细可核对，**当前进度不冒充历史**（引擎层已有 Vitest，本包补 E2E）。
- **AC14**：浅／深色、100／150／200%、960／1200 宽度下核心路径可完成 —— axe 自动检查 + 视觉检查。图表是新增的可视元素，**最容易在这里挂**：加完必须实跑 axe，并检查 200% 缩放下图表与数值表都还可用。
- 图表等价数值表、下钻保留查询与滚动、未知引用不崩页面：各自都要有可执行的用例（对关键行为做**反向验证**：去掉修复即失败）。

## 验证

```powershell
npm run check
```

- 本机四步全绿（2026-10-15 实测：build dist JS 440.26 kB / CSS 78.04 kB、Vitest 271/23、Playwright 34、Rust 38；本包会抬高这些数字，以你实测为准）。
- E2E 已默认**不录 trace**（`PW_TRACE=1` 才录）：trace 的 screencast 逐帧 jpeg 会让一次运行产出约 2,000 个文件，触发沙箱 safe-delete 的「单轮 50 条」上限，导致下次启动清空 `test-results/` 时被拒。`scripts/run-e2e.mjs` 会在启动前用 rename 把残留挪进 `_quarantine/`。排查失败时用 `PW_TRACE=1`。
- E2E 用自带 Chromium，惯例加 `--workers=1`。
- 若 `test:native` 出现 `error copying object file … 拒绝访问 (os error 5)`：是 `src-tauri/target/debug/incremental` 的增量缓存问题，删该目录即可，不影响结果。
- 不要删 `src-tauri/Cargo.toml` 里 `indexmap = { version = "1.9", features = ["std"] }` —— 它是必需的，有护栏测试 `src/lib/nativeBuildConfig.test.ts` 盯着。
- 需要夏令时相关用例时：**`TZ=... node` 这种 shell 前缀在本机被沙箱剥掉**，必须在进程内 `process.env.TZ = "..."`（照 `src/lib/review.timezone.test.ts`／`src/lib/calendarSummary.timezone.test.ts`），并先自检目标日时长防空跑。

## 仓库清理约定（长期有效，用户明确要求）

见 `AGENTS.md` 的 `### Repository cleanup` 与 `_quarantine/README.md`。要丢的一律先 `mv` 进 `_quarantine/<YYYY-MM-DD>_<简短说明>/`，不散删、不 `rm -rf`、不在沙箱内删目录树；**Agent 只搬不丢**，批次确认后由用户在资源管理器删那一个文件夹；同时最多一个未处理批次（当前 `_quarantine/` 下已有 playwright 残留批次，不要动它、也不要新建）。

## 完成定义

1. **代码与测试**：`src/components/review/` 的组件用例（周期切换、页面顺序、净负进度零基线、投入/进度单位不混、数值表与图表一致、下钻打开与关闭的键盘路径、未知引用不崩、回到汇总保留查询与滚动）、偏好读写用例（`reviewPeriod`／`reviewAnchorDate` 保存重载恒等、非法值回退）、AC13／AC14 的 E2E 与 axe。反向验证结果写进报告。
2. 写 `docs/reports/phase-4-p4-08-implementation.md`（范围、交付清单、契约、关键实现决策、刻意行为变化、验证实测数字、未做与边界、发现的不一致）。
3. 按「文档同步协议」更新 PROJECT-GUIDE：§2 已实现能力、§5 代码地图（新增 `src/components/review/`、`ReviewPage` 迁移、`buildSevenDayReview` 已移除）、§8 偏好（`reviewPeriod`／`reviewAnchorDate` 现在真的被读了）、§11 测试数量、§12 修改入口、已知边界（删掉「回顾引擎只产出数据，没有页面」那一条）。
4. 不改动用户的未提交内容；未经明确要求不要 `git commit`（由总 Agent 复核后统一提交）。
5. 汇报：改了哪些文件、验证实测结果、是否发现代码／规格／文档不一致、仍需用户决定的事项。

## 附：P4-07 留下的待定项里，与本包有关的三条

（其余两条见 P4-07 报告 §9；§9.5 因本包移除兼容入口而作废。）

- **§9.1 待续是否包含「只有待回顾、没有任何进度事件」的任务**：引擎目前按规格字面**包含**。本包直接呈现即可；若你发现它在页面上读起来别扭，记进报告，不要私自改引擎。
- **§9.3 `notes` 的中文措辞**：现在是引擎直接给出的口径说明（含设备时区名）。页面**原样展示**；要换成更短的 UI 文案就改引擎的 `notes` 并在报告里写明，不要只改组件、留下两套说法。
- **§9.4 `ReviewResult.milestones` 是否够用**：「成果」区若要显示里程碑目标条件的更多细节，可以在不改事实模型的前提下补字段 —— 但那是**引擎改动**，要单独说明，不要塞进页面里算。
