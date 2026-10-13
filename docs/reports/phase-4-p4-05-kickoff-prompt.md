# 阶段 4 P4-05 开工提示词

用途：把下面代码块整段复制给新的 agent 会话，即可在 Daymark 仓库开工 P4-05（新偏好与合法值配置、日历浏览位置持久化及旧设置恢复）。
编制日期：2026-10-13。前置：P4-04 已由独立复核确认通过（见 `docs/reports/phase-4-p4-04-implementation.md` §9）。
依据：`docs/specs/0005-phase-4-daily-workflow-and-reliability.md` §5／§9／§10／§11，`docs/PROJECT-GUIDE.md` §8／§9。

---

```
你在 Daymark 仓库（F:\PythonProject\Daymark）继续阶段 4。上一工作包 P4-04（日历滚动仲裁与逻辑浏览位置，内存版）已完成并通过独立复核，现在开工 P4-05：新偏好与合法值配置、日历浏览位置持久化及旧设置恢复。

## 先读（按顺序，不要跳过）
1. AGENTS.md —— 工作规则
2. CONTEXT.md —— 领域语言与产品原则
3. docs/PROJECT-GUIDE.md —— §8 设置持久化、§9 备份与恢复协议（偏好快照与协调恢复）、§11 测试体系、§12 常见修改入口，以及末尾的「文档同步协议」
4. docs/specs/0005-phase-4-daily-workflow-and-reliability.md —— 逐字读 §5.1／§5.2（位置与采样节奏）、§9（新增偏好与兼容策略）、§10 的 P4-05 行、§11 的 AC05／AC07／AC16
5. docs/reports/phase-4-p4-04-implementation.md —— 前置事实。**重点 §4.4（程序性滚动与内存值的交互，明确点出 P4-05 需要加一道「程序性滚动不写偏好」的闸门）与 §7（P4-05 待办清单）**，以及 §9 独立复核
6. src/hooks/useCalendarViewport.ts、src/lib/settings.ts、src-tauri/src/lib.rs 的协调恢复段

## 交付范围
1. 新增 `calendarPositions` 偏好：`{ day: CalendarPosition | null, week: CalendarPosition | null }`，默认两项皆 null。
2. 规范化（「合法值配置」）：date 必须是**真实有效的本地日期**（拒绝 2026-02-30 这类只过格式不过日历的值）；minute 必须 finite 且在 0–1440；viewportRatio 必须 finite 且在 0–1；任一项不合法 → 该项回退 null；未知字段忽略。
3. 写入：用户滚动停止 300ms 后的采样值经 `SettingsRepository` 的 `writeQueue` 串行写入（沿用既有顺序写入，不要另建通道）；**程序性滚动（恢复记忆、三日缓冲平移、进入视图定位、缩放锚点补偿）不得写偏好** —— 这是 P4-04 §4.4 点名要补的闸门。
4. 跨启动恢复：设置加载后把偏好里的 calendarPositions 播种到 useCalendarViewport 的内存位置，此后内存与偏好保持一致（不要出现两套真相）。
5. 恢复备份后对齐：原生协调恢复写入 Tauri Store 后，`SettingsRepository.normalize()` 已让 React 采用恢复后的偏好 —— 内存浏览位置也必须随之对齐，不得残留恢复前的位置。
6. 旧设置／旧备份缺少该字段 → 用默认值（不得抛错、不得伪造位置）。回退后允许丢失新浏览偏好，不允许丢失核心事实。
7. 备份：新偏好随现有 `backup_preferences` 一并备份；**不扩充 SQLite 核心表、不新增迁移**（schema 保持 v7）、不新增 Tauri Command、不新增依赖。
8. 顺带确认 AC07（所有缩放预设经规范化／保存／重载恒等；非法偏好安全回退）仍成立，并为 calendarPositions 补同类回归。

## 关于规格 §9 里的其余新偏好（必须明确决策并记录）
§9 还列出 `reviewPeriod`（默认 week）、`reviewAnchorDate`（默认 null）与 `PageId` 增加 `deadlines`。本包**至少**交付 calendarPositions；另外三项的消费者是 P4-06（截止事项页）与 P4-08（回顾页）：
- **不要**在没有对应页面时先加 `deadlines` 导航项 —— 会产生点不到的死入口（规格 §6.2 也要求 PageId 三处同步点一致，先加页面再加）。
- `reviewPeriod`／`reviewAnchorDate` 可以现在只加默认值与规范化（无 UI），也可以整体留给 P4-08 —— **二选一，并在报告里写明选了哪个及理由**，不要含糊带过。

## 明确不做（越界即停并回报）
- 不改排程事实；不改 useCalendarViewport 的仲裁优先级、generation 语义与采样口径（取视口中心、折叠条取中点）—— 本包只加「谁可以写偏好」这一层。
- 不动 M10 截止事项页、M11 回顾（P4-06～P4-08）。
- 不改缩放范围与预设（`CALENDAR_SCALE_RANGE`／`CALENDAR_SCALE_PRESET` 已是唯一源，只需保证不回退）。

## 必须保持（回归红线）
P4-04 交付的全部仲裁行为与既有回归：拖拽／拉伸及其自动滚动、Ctrl+滚轮指针锚点缩放、折叠条临时展开、插入后移与整体撤销、连续日跨午夜三日缓冲、跨页目标显露（今日页→日历时段、提醒恢复）、「回到现在」、月视图进入置顶；以及 AC05 的「日↔周切换十次不累计漂移」。缩放前后所有计划对象的序列化结果必须完全一致。

## 验收
- AC05 的「退出重开各自恢复」：日／周各自重载后回到各自位置；月视图进入置顶。（P4-04 只做了内存态，本包补齐持久化，这一条才算满足。）
- AC07：所有缩放预设与新增位置偏好保存重载恒等；非法偏好安全回退。
- AC16 相关部分：设置慢写顺序、错误重试、旧备份恢复不会覆盖新状态。
- 阈值沿用规格 §5.3：固定窗口与布局下恢复逻辑时间误差 ≤1 分钟或 2 CSS px（取较宽松的可测量者）。

## 验证
npm test
npm run test:e2e
npm run build
- 本机 Playwright **自带 Chromium 已可用**（`chromium-1228`），可直接 `npm run test:e2e`；仓库报告惯例加 `--workers=1`。
- `npm run test:native` 在本机**无法编译**：第三方 crate `schemars 0.8.22` 在 rustc 1.97.1 下报 E0107，发生在 daymark 自身编译之前；2026-10-13 独立复核确认与任何改动无关，`scripts/with-msvc-env.sh` 也不能绕过（成因见 P4-04 报告 §9.3）。本包不涉及 Rust，跳过并在报告中写明。`npm run check` 因此无法整体跑通，各步分开执行并记录。
- 另：`src/App.test.tsx` 的 Ctrl+滚轮缩放用例在满载并行下曾出现一次 `waitFor` 超时（隔离与重跑均通过）。若你在实现中遇到它偶发失败，先确认是否为同一负载问题，不要误判为本包回归，也不要为它放宽断言。

## 完成定义
1. 代码与测试：设置规范化用例（非法日期／越界 minute／越界 ratio／未知字段）、写入门闸用例（程序性滚动不写偏好）、重载 E2E（日／周各自位置跨启动恢复、月视图置顶）、备份偏好快照与协调恢复对齐用例。对每个关键行为做反向验证（去掉修复即失败）。
2. 写 docs/reports/phase-4-p4-05-implementation.md（范围、交付清单、契约、刻意行为变化、验证实测数字、未做与边界）。
3. 按「文档同步协议」更新 PROJECT-GUIDE：§8 偏好列表加 `calendarPositions`、§9 备份说明、§11 测试数量、§12 修改入口，并**移除已知边界里「退出重开不恢复」那一条**（P4-04 报告 §7 与 PROJECT-GUIDE 均已写下该边界）。
4. 不改动用户的未提交内容（注意：工作区里已有 P4-04 的未提交改动与新增文件，属正常状态，不要回退、不要顺手整理）。未经明确要求不要 git commit。
5. 汇报：改了哪些文件、验证实测结果、是否发现代码／规格／文档不一致、仍需用户决定的事项。
```
