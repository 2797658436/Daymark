# 阶段 4 P4-06 开工提示词

用途：把下面代码块整段复制给新的 agent 会话，即可在 Daymark 仓库开工 P4-06（共享索引、截止事项投影与页面）。
编制日期：2026-10-14。前置：P4-05 已完成并通过独立复核（`docs/reports/phase-4-p4-05-implementation.md`）。
依据：`docs/specs/0005-phase-4-daily-workflow-and-reliability.md` §3／§6／§9／§10／§11，`docs/PROJECT-GUIDE.md`，`_quarantine/README.md`。

---

```
你在 Daymark 仓库（F:\PythonProject\Daymark）继续阶段 4。上一工作包 P4-05（日历浏览位置持久化与合法值配置）已完成并通过独立复核，现在开工 P4-06：共享索引、截止事项投影与页面。

## 先读（按顺序，不要跳过）
1. AGENTS.md —— 工作规则
2. CONTEXT.md —— 领域语言与产品原则。重点「截止日期」「截止标记」「截止任务视图」「项目截止日期」「项目里程碑」「里程碑达成条件」「任务分类」「优先级」——截止视图的呈现必须与这些定义一致
3. docs/PROJECT-GUIDE.md —— §5 代码地图、§6 核心领域模型、§8 设置持久化、§11 测试体系、§12 常见修改入口，以及末尾的「文档同步协议」
4. docs/specs/0005-phase-4-daily-workflow-and-reliability.md —— 逐字读 §6（M10 全部）、§3（导航与界面原则）、§9（新文件划分与兼容策略）、§10 的 P4-06 行、§11 的 AC08／AC09／AC10、§13
5. docs/specs/0004-m7-project-deadlines-and-milestones.md —— 里程碑达成条件与到期冻结的既有规则；本包的「派生当前是否达成」必须复用同一规则，不得另写一套
6. docs/reports/phase-4-p4-05-implementation.md（尤其 §7 未做与边界、§9 仍需用户决定）与 docs/reports/phase-4-p4-04-implementation.md §9（独立复核）

## 交付范围
1. 新增 `src/lib/workspaceSelectors.ts`：稳定索引（任务／项目／session／record 按 ID 的 Map）与共享选择器，**至少**包含「待回顾」的单一判断。规格 §7.4 要求月历摘要、今日待回顾、回顾共用底层事实选择器，P4-07 会复用它 —— 不得另建第二份判断。索引在 workspace 快照变更时重建一次，不要每行重复扫描全量数组。
2. 新增 `src/lib/deadlines.ts`：纯函数 `buildDeadlineItems(workspace, today, filter)` ＋ 分组与排序。严格按 §6.1：
   - `DeadlineItem` 结构照抄：`{ key, kind: "task"|"project"|"milestone", sourceId, projectId, date, title, state: "open"|"currentlyReached"|"frozenUnmet" }`；`key = kind + sourceId`
   - 分组：已逾期／今天／未来七天／以后。「未来七天」= tomorrow 至 today+7；边界**必须用本地日期运算**，禁止除以固定 24 小时推算（夏令时会错）
   - 排序：日期升序 → 类型固定顺序（任务／项目／里程碑）→ 原 `sortOrder` → 稳定 ID
   - 任务：默认显示 active 且具有截止日期的**普通**任务，**排除习惯内部任务**（`kind=habit`）；可显式显示 completed／paused，但**暂停对象不能被重新安排**；无截止日期的任务不出现
   - 项目：用它自己声明的 `deadlineLocal`，**不得**用子任务最后日期替代；项目没有完成字段 → 显示「当前任务 N/N 已完成」，**不得**声称项目历史上完成；无任务的项目仍可显示其截止日期
   - 里程碑：优先读冻结结果（`MilestoneOutcome`）；没有冻结结果时按 M7 同一规则派生当前是否达成；**冻结未达成的保留「到期未达成」，即使现在已推进也不改写**；默认显示 open ＋ frozenUnmet，可切换显示 currentlyReached；项目项不因任务达成计数自动隐藏
   - 不建立截止事项表、不新增 SQLite 字段
3. 新增 `src/components/deadlines/`：页面与行级动作，按 §6.2：
   - 筛选：类型、项目、状态、关键字 ＋ 日期分组；**搜索不改变原对象排序与内容**
   - 「无数据」与「筛选无匹配」是**两种不同空状态**，后者提供「清除筛选」
   - 任务动作复用**既有编辑气泡**与「预选任务的排程入口」；项目动作定位项目；里程碑动作定位项目内具体目标；**冻结目标只有查看／续排**
   - 选择安排后仍显示**现有草案并确认**，不能直接写入时段
   - 返回列表后恢复原筛选、焦点项与滚动；源对象不存在时刷新列表并显示中性提示
   - 筛选／焦点项／滚动位置**只放 App 层内存**（同会话跨页返回有效、重启不恢复），**不写 Store**，也不与搜索文本一并保存
4. `PageId = "deadlines"`：**三处同步，缺一不可**（§6.2 点名）：
   - `src/lib/settings.ts:5` 的 `PageId` 联合类型
   - `src/lib/settings.ts:175` 的 `lastPage` 硬编码 `isOneOf` 数组（**同一行另有 `"overview" → "today"` 历史别名，不要动它**）
   - `src/App.tsx:40` 的导航 `pages` 表
   - 只改类型不改校验数组会出现「类型检查通过、运行期被静默回退到默认页」的故障 → **必须**用设置规范化测试覆盖三处一致
   - 导航标签用「截止事项」；新增入口后重新检查最小窗口高度与 200% 缩放（§3、§13：导航自身可滚动，但**不能隐藏关键入口**）
5. 任务详情仍使用**原始 ID**；禁止把派生 `DeadlineItem` 当作可直接保存对象。

## 明确不做（越界即停并回报）
- 不新增 SQLite 迁移／字段（schema 仍 v7）、不新增 Tauri Command、不新增依赖。
- 不做 M11 日／周／月回顾（P4-07／P4-08）；`reviewPeriod`／`reviewAnchorDate` 的字段与规范化 P4-05 已就位（无 UI），本包**不要**动它们。
- 不改 P4-04／P4-05 的滚动仲裁与「程序性滚动不写偏好」闸门。
- 不改缩放范围与预设（`CALENDAR_SCALE_RANGE`／`CALENDAR_SCALE_PRESET` 是唯一源）。
- 不把截止页的筛选／焦点／滚动写进 Store。

## 必须保持（回归红线）
计划时段／实际执行／手动进度始终分离；时间流逝不自动记未推进；**里程碑到期结果不可改写**；P4-04／P4-05 的全部回归（AC05 日↔周十次不漂移、AC06 缩放与拖拽、AC07 预设恒等）；既有编辑气泡语义（草稿、提交互斥、失败保留草稿、输入法组合期 Enter／Escape 不误提交不误关）。

## 验收
- **AC08**：截止分组边界准确；已完成／暂停／习惯过滤符合规则；当前达成项默认隐藏且可切换显示。（纯函数 ＋ 组件）
- **AC09**：冻结目标不被当前达成覆盖，续排保留旧结果。（复用既有 Rust／浏览器回归 ＋ 新页面）
- **AC10**：截止页返回保留筛选、焦点、滚动（**同会话跨页**，重启不恢复）；安排必须预览确认。（E2E）
- 另：`PageId` 三处一致（设置规范化测试）；100／150／200% 与 960／1200 宽度下新增导航入口全部可达（AC14 相关）。

## 验证
npm run check
- 本机已可**整体跑通**（2026-10-14 实测四步全绿）：`build` → Vitest **191/18** → Playwright **31** → Rust **38**。
- 若 `test:native` 出现 `error copying object file … full.rmeta … 拒绝访问 (os error 5)`：那是 `src-tauri/target/debug/incremental` 的增量缓存问题，**不影响编译与结果**；删掉该目录即可。
- E2E 用 Playwright **自带 Chromium**（已装好），仓库惯例加 `--workers=1`。
- **不要**为了「让原生测试能编译」而删 `src-tauri/Cargo.toml` 里那行 `indexmap = { version = "1.9", features = ["std"] }` —— 它是必需的（`schemars 0.8` 的构建期依赖），有护栏测试 `src/lib/nativeBuildConfig.test.ts` 盯着它。

## 仓库清理约定（长期有效，用户明确要求）
见 `_quarantine/README.md`。要点：
- 清理一律先把要丢的东西 `mv` 进 `_quarantine/<YYYY-MM-DD>_<简短说明>/`，**不要**散删、**不要** `rm -rf`、**不要**在沙箱内删目录树（沙箱 safe-delete 会按文件与目录逐条进回收站，`node_modules` 这种会产生约 1.8 万条记录）。
- **Agent 只搬不丢**：批次验证通过后由用户在资源管理器里删掉那一个文件夹（回收站 +1 条）。
- `_quarantine/` 已在 `.gitignore` 里，不会污染 `git status`。
- 只放可再生内容（`node_modules/`、`dist/`、`src-tauri/target/`、`test-results/`、`output/`、缓存）；**绝不**放 `src/`、`docs/`、`.git/`、`.workbuddy-ai/`，以及用户未提交的改动。
- **当前 `_quarantine/2026-10-06_old-deps/` 已有一个未处理批次（65 MB）**：不要动它，也不要再新建批次（约定「同时最多一个未处理批次」）；等用户删。本包大概率不需要清理任何东西。

## 完成定义
1. 代码与测试：`deadlines.ts` 纯函数用例（分组边界含「未来七天」两端、排序、任务过滤与习惯内部任务排除、项目 N/N、里程碑冻结优先与默认隐藏）、`workspaceSelectors` 用例、页面组件用例、设置规范化用例（`PageId` 三处一致 ＋ 非法 `lastPage` 回退）、AC10 E2E。对每个关键行为做反向验证（去掉修复即失败）。
2. 写 `docs/reports/phase-4-p4-06-implementation.md`（范围、交付清单、契约、刻意行为变化、验证实测数字、未做与边界、发现的不一致）。
3. 按「文档同步协议」更新 PROJECT-GUIDE：§2 已实现能力、§5 代码地图（新增文件）、§8 偏好合法值、§11 测试数量、§12 修改入口、已知边界。
4. **工作区里已有 P4-05 的未提交改动**（`src/lib/settings.ts`、`src/hooks/useCalendarViewport.ts`、`src/App.tsx`、对应测试、`e2e/phase1.spec.ts`、`docs/PROJECT-GUIDE.md`、`.gitignore`），属正常状态：不要回退、不要顺手整理、也不要把它当成已提交的基线。未经明确要求不要 git commit。
5. 汇报：改了哪些文件、验证实测结果、是否发现代码／规格／文档不一致、仍需用户决定的事项。
```
