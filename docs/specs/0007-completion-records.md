# 完成记录（完成签到）技术方案

版本：1.1；编制日期：2026-10-24；状态：**规划草案，尚未实施**。

修订：v1.1 落入 2026-10-24 四项确认——回顾页图片为缩略图＋只读放大；主观反馈统一归入完成记录并修订 UI-SPEC；已撤回记录不入统计但保留明细；设置页新增「完成后询问记录」开关（默认开）。第 11 节开放问题随之关闭。

基线：本地提交 `b49242b`（任务池 B 方案与进度气泡精简）。GUI 方向已在 2026-10-24 与用户对齐：任务达到 100% 后弹出锚定的「完成记录」气泡，可记录适应程度、小结、感受标签与图片，并可撤回完成；交互预览见会话可视化 `task-completion-bubble.html`（预览中预选「合适」只为展示选中态，真实默认不预选）。本方案按现有产品方向制定，新增表、命令与界面均为拟议设计；实施任务进入 GitHub Issues 后，以 Issue 确认范围与本文版本共同作为验收依据。

## 1. 目标与阶段边界

当前实现里「完成」只是一个进度事实：`Database::update_task_progress()` 在写入 `to_progress = 100` 的进度事件时把任务置为 `completed`（[database.rs](../../src-tauri/src/database.rs) 的 `update_task_progress`），界面随即把任务移出活动任务池，用户没有机会留下「这次完成得怎么样」的任何信息，也没有反悔入口之外的记录载体。本方案补上这一环，并把主观反馈收敛到**唯一**一处，避免与既有「本次小结」长出两套口径。

### 1.1 必须交付

| 模块 | 结果 | 优先级 |
| --- | --- | --- |
| M1 完成触发与气泡 | 普通任务在任何入口达到 100% 后打开锚定完成气泡；完成瞬间任务行短暂保留供锚定；气泡内含适应程度、小结、感受标签、图片、撤回与保存 | P1 |
| M2 持久化与图片 | schema v8 新增 `completion_records` 与 `completion_images`；图片压缩后以 BLOB 入库，随现有备份／恢复自动迁移；提供按需取图命令 | P1 |
| M3 撤回与历史 | 「撤回完成」原子地写回退进度事件并把记录标记为已撤回；文字、标签与图片保留在历史中，不删除用户内容 | P1 |
| M4 事后入口 | 「今日完成」行可点开补写／编辑；回顾的任务明细卡可查看任意周期的记录并编辑未撤回者（已撤回只读）；回顾内图片缩略图可点击只读放大 | P2 |
| M5 回顾联动 | 回顾引擎只读投影完成记录：日明细列出记录与缩略图，周／月给出适应程度分布与常见标签聚合；已撤回记录不入聚合 | P2 |
| M6 设置开关 | 设置页新增「完成后询问记录」，默认开启；关闭后完成不再弹气泡，事后补写入口保留 | P2 |

### 1.2 本阶段不交付

- 重复习惯（`kind = "habit"` 的内部任务）的完成记录；习惯发生项已有自己的完成／跳过状态，不叠加主观记录。
- 图片「另存为」导出与完成气泡内的大图查看：气泡只负责采集（缩略图＋移除），查看统一放在回顾页的只读放大浮层。
- PNG／CSV 回顾导出本身尚未实现（[0005 方案](0005-phase-4-daily-workflow-and-reliability.md) §1.2 已声明）；本方案只约定其实现时主观字段的默认导出策略。
- 任务删除及其历史保留策略尚未实现；本方案只用外键级联预留语义，不新造删除流程。
- AI 摘要、情绪推断、跨设备同步、完成记录搜索。
- 「本次小结」新增满意度星级：见 §7，主观反馈统一归入完成记录，UI 规范相应修订。

### 1.3 不可破坏的约束

- 计划时段、实际执行记录与进度事件继续分离；完成记录是**第四类**事实，只引用进度事件，不改写任何既有事实。
- 回顾引擎保持只读投影：不新增写入、不从当前值反推历史；完成记录聚合与既有九项口径并列，不替换它们。
- 「曾完成任务数」等既有指标继续以进度事件为准（周期内至少一次 `toProgress = 100`），不受完成记录是否存在、是否撤回影响。
- 所有核心写入继续走原生串行队列与写后备份；新增命令必须复用同一事务与错误语义。
- 迁移只增不改：已发布的 schema v1–v7 语义不动，新表走 v8。

## 2. 基线证据

| 事实 | 当前证据 | 对设计的影响 |
| --- | --- | --- |
| 完成＝进度事件到 100 | [database.rs](../../src-tauri/src/database.rs) `update_task_progress`：`status = CASE WHEN ?1 = 100 THEN 'completed' …` | 触发判断放在前端提交成功后；后端不主动产生 UI 状态 |
| 进度提交集中在 `updateProgress` | [App.tsx](../../src/App.tsx) `updateProgress`（约 321 行），各页面经 `onProgress` 回调汇入 | 在该函数统一判断 100% 并携带锚点，避免每个页面各写一套触发 |
| 共享气泡已有模态／动作两种语义 | [floating-panel.tsx](../../src/components/ui/floating-panel.tsx) | 完成气泡用 `editor` 语义：背景 inert、Esc 关闭、外部点击只吞不关 |
| 「今日完成」已存在但不可交互 | [App.tsx](../../src/App.tsx) `completedToday`（约 546、659 行） | 行改为按钮，作为当天记录的补写／编辑入口 |
| 项目已完成组只显示「已完成」chip | [App.tsx](../../src/App.tsx) 约 2202 行 | 第一版不加视觉噪声，历史入口放在回顾明细 |
| 回顾唯一统计入口 | [review.ts](../../src/lib/review.ts) `buildReview`／`buildReviewFromIndex` | 完成记录投影加入同一引擎，页面不自算 |
| 满意度／感受标签尚未实现 | 全仓 `src/` 无「满意度／satisfaction／感受」实现 | 主观反馈没有历史包袱，可直接归入完成记录 |
| 导出与任务详情历史尚未实现 | 全仓无 CSV／PNG 导出、无主任务详情「历史记录」组件 | 本方案不为未实现界面预留复杂接缝，只在 §7、§6 约定未来策略 |
| schema 版本为 7 | [database.rs](../../src-tauri/src/database.rs) `CURRENT_SCHEMA_VERSION = 7`、[迁移目录](../../src-tauri/migrations/) | 新表走 `008_completion_records.sql` |

## 3. 用户路径与界面原则

### 3.1 触发矩阵

| 入口 | 触发动作 | 气泡锚点 | 说明 |
| --- | --- | --- | --- |
| 任务池 | 百分比气泡内「完成」或滑块到 100 | 行内百分比按钮 | 进度气泡先卸载再开完成气泡，沿用「先卸 action 再开 editor」的既有做法 |
| 项目详情 | 行内进度控件到 100 | 该进度控件 | 项目页主从分栏内锚定 |
| 今日页 | 「现在／待回顾／接下来」行内进度控件到 100 | 该进度控件 | 与任务池同构 |
| 日历 | 会话卡进度控件到 100 | 会话卡 | 窄屏覆盖面板内同样锚定 |
| 结束本次（FinishDialog） | 提交时把进度设为 100 | 关闭对话框后锚到今日页对应行；今日页不可见时居中 | 模态对话框不能与气泡同帧叠开 |
| 重复习惯内部任务 | 不触发 | — | 发生项状态已表达完成／跳过 |

规则：

- 触发条件为 `toProgress === 100 && fromProgress < 100 && task.kind !== "habit"`，且提交成功；提交失败不弹。偏好 `completionRecordPrompt = false` 时不自动弹出（§8），完成事实照常写入。
- 同一时刻只允许一个完成气泡。气泡打开期间另一个任务也到 100% 时，后者不自动弹出，只进入「今日完成」的待补写状态，避免叠层与丢草稿。
- 气泡打开期间，刚完成的任务**保留**在任务池原分组中并显示完成态（绿底、对勾、100%）；气泡关闭后该行以 160ms 淡出离开活动池。非任务池页面触发时不要求任务池打开。
- 气泡不重复任务标题（锚定行已提供上下文）；头部为对勾图标＋「已完成」＋`75% → 100% · 今天 14:32` 的事实行。

### 3.2 气泡结构（宽 23rem，锚定，非模态背景可 inert）

自上而下：

1. 头部：成功图标、「已完成」、进度变化与时间、关闭按钮（44px 命中）。
2. 适应程度：三档单选「轻松／合适／吃力」，可空（真实默认不预选）；选中态用强调边框＋淡底＋对勾，不只靠颜色。
3. 完成小结：单段文本，≤280 字，占位句「这次是怎么完成的？下次要注意什么？」。
4. 感受标签：默认折叠的「感受标签」开关，展开后多选胶囊；默认词表沿用 UI 规范既有八词：专注、顺利、有收获、比预计难、被打断、疲惫、卡住、想继续。
5. 完成图片：缩略图（68px）＋「粘贴图片」虚线瓦片；支持剪贴板粘贴、拖拽、本地文件选择；上限 3 张；每张带移除按钮（44px 命中区）。气泡内缩略图**不提供放大**——采集与查看分离，查看统一在回顾页（§6）。
6. 页脚：左「撤回完成」（安静按钮，提示回到完成前进度），右主按钮「保存记录」（编辑已存记录时为「保存修改」）。

交互细则：

- `closeOnOutsideClick = false`：带草稿与图片，误点背景不丢内容。
- Esc／关闭按钮：无改动直接关闭（未保存则记为跳过，底部提示可「补写」）；有改动时气泡内出现一行确认「放弃这次填写？／继续填写／放弃」。
- 保存：原子写入记录与图片 → 关闭气泡 → 底部提示「完成记录已保存」，附「撤回完成」动作。
- 撤回完成：不二次确认（可逆且保留内容）；写回退事件＋标记已撤回 → 关闭气泡 → 提示「已撤回完成，进度回到 N%」，附「重新完成」。
- 键盘：打开后焦点落在适应程度当前值（无值时落「合适」）；Tab 在气泡内循环；关闭后焦点归还触发控件。
- 960×640 与 200% 缩放：气泡宽度 `min(23rem, 100vw - 24px)`，字段纵向堆叠不换行裁切；图片瓦片换行不溢出。

### 3.3 事后入口

| 入口 | 可见条件 | 行为 |
| --- | --- | --- |
| 今日页「今日完成」行 | 当天有到 100 的进度事件 | 行改为按钮，副行显示 `完成于 14:32 · 合适 · 2 张图片` 或「未填写完成记录」；点击打开气泡编辑／补写，锚定该行 |
| 回顾明细·任务卡 | 周期内该任务有完成记录 | 「完成记录」卡列出记录（含已撤回标记）；未撤回记录提供「编辑」打开气泡，锚定明细面板；缩略图可点击只读放大；已撤回记录整体只读 |
| 任务池／项目页 | — | 第一版不加入口，避免已完成区域变吵 |

已撤回的记录不出现在「今日完成」（任务已回到活动池），但保留在回顾明细中并带「已撤回」标记，可查看、不可再编辑其适应程度之外的字段？——见 §5.3：已撤回记录整体只读。

## 4. 数据模型与迁移

### 4.1 新表（schema v8，`008_completion_records.sql`）

```sql
CREATE TABLE completion_records (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  progress_event_id TEXT NOT NULL UNIQUE REFERENCES progress_events(id) ON DELETE CASCADE,
  completed_at_utc TEXT NOT NULL,
  progress_before INTEGER NOT NULL CHECK (progress_before BETWEEN 0 AND 99),
  progress_after INTEGER NOT NULL DEFAULT 100 CHECK (progress_after = 100),
  fit TEXT CHECK (fit IS NULL OR fit IN ('light', 'fit', 'hard')),
  note TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  reverted_at_utc TEXT,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE TABLE completion_images (
  id TEXT PRIMARY KEY,
  completion_id TEXT NOT NULL REFERENCES completion_records(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL CHECK (sort_order BETWEEN 0 AND 2),
  mime TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  data BLOB NOT NULL,
  thumb BLOB NOT NULL,
  created_at_utc TEXT NOT NULL
);

CREATE INDEX idx_completion_records_task ON completion_records(task_id, completed_at_utc);
CREATE INDEX idx_completion_images_completion ON completion_images(completion_id, sort_order);
```

语义：

- `progress_event_id` 唯一：一次「到 100」的进度事件至多对应一条记录；撤回不删除记录，重新完成会产生新事件与新记录，历史天然成链。
- `tags` 存 JSON 数组文本（`string[]`），由 Rust 校验元素出自固定词表且去重；不用关联表，避免为八个词建第三张表。
- 外键级联只为**未来**的任务／事件删除预留语义；当前应用没有任务删除流程，不因此新增删除 UI。
- 图片以 BLOB 入库而非外部文件：现有备份是整库 SQLite 复制（[PROJECT-GUIDE §9](../PROJECT-GUIDE.md)），BLOB 让备份／恢复零改动地带上图片；代价是库体积增长，由 §5 的压缩与上限控制。

### 4.2 快照与命令

`WorkspaceSnapshot` 增加 `completionRecords: CompletionRecord[]`，其中**不含**图片字节，但含 `imageCount`（由 join 得出）与全部文本字段——回顾与今日页的列表只需要这些。图片通过按需命令获取，避免启动快照携带 MB 级 base64。

`NativeApi` 新增：

| 命令 | 语义 |
| --- | --- |
| `recordCompletion(record, images)` | 事务内插入记录与图片；校验 fit／tags／note 长度／图片张数与大小 |
| `updateCompletion(record, images)` | 事务内更新记录字段并**整体替换**图片集（删除旧行、插入新行） |
| `revertCompletion(recordId, event)` | 事务内：插入回退进度事件、更新任务进度与状态、置 `reverted_at_utc`；记录与图片保留 |
| `getCompletionImages(recordId)` | 返回该记录的图片元数据与 base64（`data`／`thumb`），供气泡与回顾缩略图懒加载 |

浏览器预览的后端替身（[native.ts](../../src/lib/native.ts) 的内存实现）同步补齐这四个方法，保证单元测试与 E2E 不依赖 Tauri。

### 4.3 校验与不变量

- `fit` 只接受 `light | fit | hard | null`；`note` 去首尾空白后 ≤280 字；`tags` ≤8 个且出自词表。
- 图片：每记录 ≤3 张；单张压缩后 ≤2 MiB；`mime` 只接受 `image/png | image/jpeg | image/webp`。
- `completed_at_utc`、`reverted_at_utc`、`created_at_utc`、`updated_at_utc` 均为 RFC 3339 UTC（`Z` 或 `+00:00`），沿用 `parse_utc_fact`。
- 同一 `progress_event_id` 重复提交返回明确错误「这次完成已经记录过了」，前端据此改为打开编辑态而不是报错横幅。
- 撤回要求记录 `reverted_at_utc IS NULL` 且任务当前进度为 100；回退事件的 `from_progress` 必须为 100、`to_progress` 必须等于 `progress_before`。

## 5. 图片管线

### 5.1 输入

1. **剪贴板粘贴**：气泡打开期间监听 `paste`，仅当 `clipboardData` 含 image 项时接管（文本粘贴进小结不受影响）。
2. **拖拽**：优先 HTML `drop`；若 Tauri 原生拖拽拦截外部文件（`dragDropEnabled` 默认行为），改用 `@tauri-apps/api/webview` 的 `onDragDropEvent` 取路径并经 `@tauri-apps/plugin-fs` 读字节——实施时先做最小探针确认走哪条路，再二选一落地，不两条都留。
3. **文件选择**：隐藏 `<input type="file" accept="image/*" multiple>`，由图片区文字按钮触发。

### 5.2 压缩与存储

- 前端用 canvas 归一化：最长边 ≤1600px；编码 `image/webp` 质量 0.85，编码器不可用时回退 `image/jpeg` 0.87。
- 缩略图：最长边 160px、webp 0.8，与全图同事务入库，列表渲染只取缩略图。
- 压缩后仍 >2 MiB 的单张被拒绝，图片区给出「这张图压缩后仍超过 2 MB，未添加」的就地说明，不弹全局错误。
- 命令边界用 base64 传输，入库转 BLOB；`getCompletionImages` 返回 base64 供 `<img src="data:…">`。
- 移除图片只在前端草稿态生效；保存时随整体替换落库；被替换掉的旧 BLOB 在事务内删除，不留孤儿行。

### 5.3 撤回后的内容

撤回**不删除**记录与图片：`reverted_at_utc` 置位后，记录在回顾聚合中失效（§6），在回顾明细中以「已撤回」标记只读展示；「重新完成」创建的是新记录，不复用旧记录的图片，避免把上一次的截图误认为这一次的证据。

## 6. 回顾联动

回顾引擎（[review.ts](../../src/lib/review.ts)）增加只读投影，页面不自算：

- `ReviewResult.completions: ReviewCompletionSummary[]`：周期内 `completed_at_utc` 落在周期内的记录，按 `(completedAtUtc, id)` 排序；字段含 `taskId、title、fit、tags、note、imageCount、reverted`。
- **日回顾**：`DateDetail` 的「记录」卡新增第三节「完成记录」，每行 `时间 · 任务 · 适应程度 chip · 标签 · 小结摘录 · 缩略图`；缩略图点击后在回顾页内以只读浮层放大（`FloatingPanel kind="action"`，Esc／点外关闭，**不提供另存为**）；无记录时整节不渲染（沿用「没话说就不渲染」规则）。
- **周／月回顾**：新增「完成感受」聚合卡，仅当周期内存在**未撤回**记录时渲染：
  - 适应程度分布：三根水平条＋计数（`轻松 2 · 合适 5 · 吃力 1`），零值档不画条但保留 0 计数文字；
  - 常见标签：按选择次数取前 3，附次数；
  - 一行口径：`N 条完成记录 · 其中 M 条已撤回（不计入感受）`（M=0 时省略后半句）。
- **聚合口径**：分布与标签只统计 `reverted_at_utc IS NULL` 的记录；已撤回记录只出现在明细列表与口径行中。
- **既有指标不动**：`progress.completedTaskIds` 仍以进度事件为准；撤回产生的回退事件照常计入净进度变化（它本身就是一次真实的手动调整）。
- **notes**：周期内存在已撤回记录时追加一条「有 M 条完成记录被撤回，未计入感受聚合」，保持口径可解释。
- **任务明细卡**：`TaskDetail` 增加「完成记录」卡，列出该任务周期内记录（含已撤回），每条附「编辑」按钮打开完成气泡（锚定明细面板）；已撤回记录只读，不提供编辑。
- **导出（未来）**：PNG／CSV 导出实现时，适应程度、标签、小结、图片数默认**不**导出，沿用 UI 规范「主观反馈需单独勾选」的策略；图片永不进入导出文件。

## 7. 与既有规范的关系

- UI-SPEC「本次小结显示可修正的实际投入、可拖动的任务进度与本次推进量，并提供可选的 1–5 星『本次满意度』、多选感受标签和自由评论」一条**修订为**：本次小结保留实际投入、任务进度与推进量及自由备注；满意度星级与感受标签移入完成记录（适应程度三档＋标签），不再在执行结束处重复询问。实施时同步修订 [UI-SPEC.md](../design/UI-SPEC.md) 与 [PROJECT-GUIDE.md](../PROJECT-GUIDE.md) 的对应表述。
- UI-SPEC「任务达到 100% 时自动标记完成，播放克制的完成动画」「完成操作提供即时撤销」两条由本方案落实：完成动画为行内对勾 320ms 一次性反馈，撤销即「撤回完成」。
- 任务池 B 方案记忆（项目优先行、单项目展开、百分比为进度唯一入口）不变；完成气泡是百分比气泡的下游，不新增常驻控件。

## 8. 设置与偏好

- 新增布尔偏好 `completionRecordPrompt`，默认 `true`，持久化在 `settings.json`（[PROJECT-GUIDE §8](../PROJECT-GUIDE.md) 列表追加一项；旧设置缺字段时规范化回退默认值，不做迁移）。
- 设置页位置：「提醒与行动」分区新增一行「完成后询问记录」，note 为「关闭后完成任务不再弹出记录气泡；仍可在『今日完成』和回顾明细里补写。」开关语义与既有 `SettingsToggleRow` 一致（含「恢复默认」）。
- 关闭时的行为：达到 100% 仍正常写入进度事件与完成状态，只是不打开气泡；「今日完成」行显示「未填写完成记录」并可补写——补写是用户主动动作，不受开关影响。
- 回顾页既有 `reviewPeriod`／`reviewAnchorDate` 偏好不变；完成感受卡不引入新的持久化状态。

## 9. 测试与验收

- Rust：v7→v8 升级测试（旧事实不丢不伪造）、记录／图片／撤回的事务测试、校验失败测试、备份恢复后图片仍在的集成测试。
- Vitest：`updateProgress` 到 100 触发气泡且携带锚点；`completionRecordPrompt = false` 时不触发但今日行仍可补写；习惯任务不触发；保存写入 mock 命令；撤回写回退事件并保留内容；今日行补写；回顾聚合排除已撤回；回顾缩略图放大浮层只读且可 Esc 关闭。
- Playwright：任务池完成→气泡→粘贴图片（用 `page.evaluate` 注入 DataTransfer 或剪贴板权限）→保存→今日行可见记录→撤回→行回 75%；960×640 与 200% 缩放截图无裁切。
- 视觉：浅色／深色各截完成气泡、今日完成行、回顾感受卡，按 [UI-SPEC](../design/UI-SPEC.md) 检查 4px 网格、12px 下限、对比度与 44px 命中区。
- 性能：含 20 条带图记录的快照启动时间不回归（图片不在快照内）；回顾页打开不因记录投影增加可感知延迟。

## 10. 实施顺序与依赖

1. M2 先行：迁移、Rust 模型与四个命令、native 替身、备份恢复测试——数据层稳定后界面才有落点。
2. M1：`updateProgress` 触发、任务池临时行、完成气泡组件与图片管线。
3. M3：撤回命令与提示链。
4. M4：今日完成行按钮化、回顾明细编辑入口与只读图片放大浮层。
5. M5：回顾引擎投影与感受卡、日明细节。
6. M6：设置项 `completionRecordPrompt`、设置页行与规范化回退。
7. 文档同步：UI-SPEC 修订、PROJECT-GUIDE 数据模型与迁移表更新、本方案状态改为已实施并记录基线提交。

## 11. 已确认结论（2026-10-24）

| # | 问题 | 结论 | 落点 |
| --- | --- | --- | --- |
| Q1 | 回顾页里的完成图片怎么展示？ | 日回顾与任务明细显示缩略图，点击在回顾页内只读放大，不提供另存为 | §6、M4 |
| Q2 | 主观反馈是否完全归入完成记录？ | 是；「本次小结」只保留实际投入、进度与备注，UI-SPEC 相应修订 | §7 |
| Q3 | 已撤回记录在回顾里的口径？ | 不入适应度／标签聚合，明细与口径行可见；完成数仍按进度事件事实计 | §6 |
| Q4 | 是否提供「不再弹出」开关？ | 设置页新增「完成后询问记录」，默认开启；关闭只影响自动弹出，不影响补写 | §8、M6 |
