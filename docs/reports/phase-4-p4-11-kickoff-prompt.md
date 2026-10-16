# 阶段 4 P4-11 开工提示词：日历网格的无障碍语义

> 这是一个**小工作包**，从 P4-09 记录下来的 S2 缺陷单独拆出（见 `docs/reports/phase-4-open-decisions.md` §7 ②）。
> 前置：P4-09 已完成、已提交并通过独立复核（`03640af` + `4748850`）。

---

你在 Daymark 仓库（F:\PythonProject\Daymark）开工 **P4-11**：把日历页的网格 ARIA 结构修对。

## 先读

1. `AGENTS.md` —— 工作规则（含仓库清理约定）。
2. `docs/PROJECT-GUIDE.md` —— §5 代码地图、§10 主题与基础无障碍、§11 测试体系、§12 修改入口、文档同步协议。
3. `docs/reports/phase-4-p4-09-implementation.md` 的 **§4.2**（缺陷的完整描述）与 §7（S2 的原文记录）。
4. `docs/reports/phase-4-open-decisions.md` §7 ② —— 为什么单独拆出这一包。
5. `e2e/phase1.spec.ts` 里 `KNOWN_CALENDAR_DEFECT` 附近的注释 —— 缺陷被逐条钉住的位置。
6. `docs/design/UI-SPEC.md` 里与日历、键盘导航相关的段落。

## 问题是什么

`e2e/phase1.spec.ts` 的 `phase 4 M12 has no automated accessibility violations on every page…` 在日历页钉住了两条 axe 违规：

- **周视图** `aria-required-parent`：`.day-track` 带 `role="gridcell"`（`src/App.tsx:1090`，仅在 `onWeekGridNavigate` 存在时加），但父级是 `role="region" aria-label="日历时间网格"`（`src/App.tsx:822`），**没有 `role="row"`／`role="grid"`**。
- **月视图** `aria-required-children` + `aria-required-parent`：`role="grid"`（`src/App.tsx:959`）的 42 个 `role="gridcell"` 与 7 个 `role="columnheader"` 都是**直接子元素**，没有行。

这是阶段 3 就存在的标记问题（既有 axe 用例只跑今日页壳与回顾页，从未覆盖日历页，所以一直没被抓住）。`KNOWN_CALENDAR_DEFECT` / `KNOWN_CALENDAR_DEFECT_MONTH` 这两个常量就是为了把事实钉在案 —— 任何**新增**违规仍会让用例失败。

**修好之后那两行会红，改成 `[]` 即可 —— 这就是本包完成的判据。**

## 先决定语义模型（本包的核心决策，不要跳过）

**月视图没有争议**：它**就是** 6×7 的表 → `grid → row → columnheader／gridcell`。

**周视图要难得多，因为它现在并不是一张网格。** DOM 里只有 7 个日列（每列是一条 24 小时连续时间轴），**没有"行"**；`role="gridcell"` 是硬加的，而它的可访问名是「日期 + 时间 + 空白时间」（例如 `2026-08-12 09:00 空白时间`）。三个候选：

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| **A 单行网格** | `grid → row → 7 × gridcell` | 最小改动；屏幕阅读器会念「第 1 行第 3 列，共 7 列」，**对"我在周几"这件事反而有用**。但等于声称了一个并不存在的表结构。⚠️ **不要用 `display: contents` 包一层** —— 它在部分引擎里会把元素从无障碍树里摘掉，role 直接失效；要动布局就得真改 CSS 网格结构。 |
| **B 不当网格** | 去掉 `role="gridcell"`，7 个日列改成 `role="group"`／列表语义 + `aria-label` | 语义最诚实（它确实不是表）。但**方向键在列间移动的既有交互就没有 ARIA 模式可依**，需要自己定义并写进快捷键说明。 |
| **C 真二维网格** | 渲染时间行，做成 7 × N 的 `grid → row → gridcell` | 语义最正统，但与「连续时间轴」的既有实现冲突，等于重做周视图的渲染 —— **本包不做**。 |

**建议**：月视图走标准重排；周视图**在 A 与 B 之间做出决定并写明理由**（我倾向 **B** —— 不为迁就一个 role 去声称一个不存在的结构；但若你更看重"最小改动 + 屏幕阅读器能报列号"，A 也站得住）。**不要选 C。**

**另外必须一并决定**：时间轴、全天区、拖拽预览这些**非单元格**子节点在新结构里怎么标注（`aria-hidden`？`role="presentation"`？还是保留各自的 `aria-label`？）。P4-09 报告 §4.2 点名了这一项，**它是这次重排真正的难点**，不要顺手糊过去。

## 交付范围

1. 按上面的决定重排月视图（必然）与周视图（按选定方案）的 ARIA 结构。
2. **保持全部既有键盘语义**：方向键在日列／月格间移动、`PageUp`／`PageDown`、`Enter`／空格激活、`Tab` 进出。**这是回归红线** —— 无障碍修复把键盘路径改坏是最典型的翻车方式。
3. **处理既有测试的语义查询**：`src/App.test.tsx` 里多处用 `getByRole("gridcell", { name: … })`（月视图 42 个格子、周视图「2026-08-12 09:00 空白时间」）。若周视图选了方案 B，这些查询要改成对应的新 role —— **改查询可以，但要在报告里逐条说明改了什么、为什么**；**不能为了让测试过而放宽断言**。
4. 把 `e2e/phase1.spec.ts` 的 `KNOWN_CALENDAR_DEFECT` / `KNOWN_CALENDAR_DEFECT_MONTH` 改成 `[]`，并把那段「这是已记录缺陷」的注释改写成「结构已按 X 方案修正」。
5. 若方案涉及快捷键说明或可见文案的变化，同步更新。

## 明确不做（越界即停并回报）

- **不改视觉**：不为了 ARIA 去改配色、间距、字号、缩放范围或预设。布局若必须调整，只允许「把 42 个格子包进 6 行」这类结构性的最小改动，并在报告里给出改前／改后的截图对比。
- 不改 D1–D6 与 P4-07／P4-08 的已拍板结论（`phase-4-open-decisions.md` §0.5／§5／§6）。
- 不改 P4-04／P4-05 的滚动仲裁与「程序性滚动不写偏好」闸门。
- 不新增依赖；不碰 `src-tauri/`。

## 验收

- 日历页在 **960×200%、浅／深两色**下 axe **零违规**（即 P4-09 钉住的那两条变成 `[]`）。
- 周视图与月视图的键盘路径**都有可执行的用例**，不是靠肉眼看。
- `npm run check` 四步全绿。

## 验证

```powershell
npm run check
```

- 本机基线（2026-10-16）：build dist JS 465.54 kB / CSS 81.24 kB、Vitest **293/24**、Playwright **39**、Rust **38**。
- 想看 axe 的原始输出：`PW_TRACE=1 node scripts/run-e2e.mjs --workers=1 -g "M12 has no automated accessibility"`。
- `scripts/visual-evidence.mjs` 可以复用（固定数据 + 固定时钟，产出 1200×760／960×760 的截图）。若本包改了日历结构，**加一张日历页截图**并入库到 `docs/reports/phase-4-p4-11-implementation/` —— 照 P4-09 的做法：`output/` 是 gitignored 的，报告引用那里就是死链。
- 若 `test:native` 出现 `os error 5`：删 `src-tauri/target/debug/incremental`，不影响结果。

## 仓库清理约定（长期有效，用户明确要求）

见 `AGENTS.md` 的 `### Repository cleanup` 与 `_quarantine/README.md`。要丢的一律先 `mv` 进 `_quarantine/<YYYY-MM-DD>_<简短说明>/`，不散删、不 `rm -rf`、不在沙箱内删目录树；**Agent 只搬不丢**，批次确认后由用户在资源管理器删那一个文件夹；同时最多一个未处理批次。

## 完成定义

1. 代码 + 用例（axe 例外归零、键盘路径回归、必要的查询改名并逐条说明）。
2. 写 `docs/reports/phase-4-p4-11-implementation.md`：**选定的语义方案与理由**（周视图 A/B 的取舍必须写清楚）、时间轴／全天区／拖拽预览的标注决定、DOM 结构改前改后对比、axe 结果、键盘回归证据、未做与边界。
3. 按「文档同步协议」更新 PROJECT-GUIDE（§5 代码地图、§10 主题与基础无障碍、§11 测试、已知边界里把这条 S2 移除或改写）。
4. 不改动用户的未提交内容；未经明确要求不要 `git commit`（由总 Agent 复核后统一提交）。
5. 汇报：改了哪些文件、axe 结果、是否发现新的不一致、仍需用户决定的事项。

## 附：与 P4-10（原生验收与发布）的顺序

开工前先想清楚这一条：

- **在 P4-10 之前完成** → 发布包包含修复，AC14 的 axe 证据干净。**推荐**。
- **在 P4-10 之后完成** → 0.1.0 带着这条 S2 发布，**发布说明里必须写明**（P4-10 提示词已要求）。
- **不要在 P4-10 的隔离验收跑完之后再合入** —— 那会让「已验证安装包」对应的代码与验收证据不一致。
