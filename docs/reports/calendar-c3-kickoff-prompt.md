# 日历整改 C3 开工提示词：区分「现在的时间」与「任务进度」

> 用法：整段复制到新会话作为开场提示。决策依据 **D14**（评估 §6）：用户 2026-10-27 实测反馈「目前最大问题就是没有区分目前的时间和进度」，裁决为**双层条 + 剩余时间**方案。
> 本包是纯呈现改动：**不改数据模型（`task.progress`、session 时间字段语义一条不动）、不改拖拽、不改布局骨架**。C1–C4 四包相互独立。

---

你在 Daymark 仓库（F:\PythonProject\Daymark）开工**日历整改 C3：让「时间进行到哪了」和「任务完成了多少」在日历卡片和日轨道上一眼可分**。

## 先读（按顺序，不要跳过）

1. `AGENTS.md`。
2. 评估 §5.5 的 C 轮索引、§6 的 **D14**；`docs/reports/calendar-a5-implementation.md`（三档信息分层的按档设计方法——本包的「剩余 X 分钟」文字按档取舍沿用同一套思路）。
3. `src/App.tsx`：`CalendarSession` 卡片渲染（2330 文字进度、2331 `.session-elapsed` 时间已进行条、2334 `.session-task-progress` 任务进度条）、`current` 判定 `sessionContains(session, now)`（2247）、elapsed 百分比计算（2250）；日轨道的 now 线与过去区域（2019）。
4. `src/styles.css`：`.calendar-past-region`（766，8%→2% muted 渐变）、`.calendar-now-line`（767–770，虚线 + 端点 + 时间胶囊）、`.session-elapsed`（910、915，accent 色）、`.session-task-progress`（912–916，success 色）、紧凑档隐藏规则（830–834）。
5. `docs/design/UI-SPEC.md` 的视觉基线（4px 网格、12–28px 字阶、对比度 ≥4.5:1、状态不得只靠颜色传达）。

## 现状账（改前基线）

- 页面级：今天的日列有 `calendar-now-line`（**虚线** 2px accent + 右端 10px 圆点 + 左上时间胶囊）和 `calendar-past-region`（8%→2% 的很淡的渐变遮罩）。周视图今天的列同样渲染（同一 `CalendarDay` 路径）；月视图没有（只有 `.today` 类）。
- 卡片级：**两条细条长得几乎一样**——`.session-elapsed`（仅进行中的卡，accent 色，卡底部绝对定位）和 `.session-task-progress`（所有卡，success 色，同一区域）。用户无法分辨哪条是「时间过了多少」、哪条是「任务做了多少」；进行中的卡也没有「还剩多久」的文字。
- 颜色语义现状：accent=时间、success=任务进度，但两条同宽同位，仅靠颜色区分——**违反「状态不得只靠颜色传达」**的既有基线。

## 交付范围

### 1. 进行中卡片：双层条 + 剩余时间（D14 主项）

- 进行中的卡（`sessionContains(session, now)`）同时渲染两条**位置分离**的条：
  - 「时间已进行」条：accent 色，保持卡底部；
  - 「任务进度」条：success 色，移到卡顶部（或与时间条之间留 ≥4px 分隔并加不同高度/形态，例如任务进度条更细或带端点帽）——两条不得再同位同宽同形态；
  - 文字「剩余 X 分钟」（<60 分钟显示分钟、≥60 分钟可用「X 小时 Y 分」），按档取舍：standard/detailed 显示，compact 允许只保留双层条不出文字（与 A5 的按档信息分层一致，具体断点用既有的容器查询 rem 方案）。
- 未进行的卡：只保留「任务进度」条（位置与新布局一致）；已结束的卡不新增内容。
- 无障碍：两条各有 `aria-label`/`title`（「时间已进行 45%」「任务进度 60%」句式）；剩余时间文字对读屏可见。

### 2. 页面级现在时刻强化

- `calendar-now-line` 从虚线改**实线** 2px（accent），端点圆点保留或略加大；时间胶囊不动。
- `calendar-past-region` 遮罩加深（自定幅度），硬约束：加深后**过去区域里的卡片正文对比度仍 ≥4.5:1**（用探针实测，读数写进实施记录）；遮罩不得吃掉点击（既有 `pointer-events` 语义不变）。
- 周视图今天列同步生效（同一路径，验证即可）；月视图不加。

### 3. 图例与规格

- UI-SPEC 合并式补一段：两种条的语义、颜色、位置与按档行为（一句话级别，不重写章节）。
- 不新增设置项；不做「隐藏任务进度条」开关（若日后需要另立包）。

## 明确不做（越界即停并回报）

- 不改 `task.progress` 的计算/写入路径，不改 session 时间字段，不改 `sessionContains` 判定。
- 不动拖拽状态机、气泡、布局骨架、密度定标（A6 的 84/168/216 与字号随档不改）。
- 不做月视图 F13（后续包）。
- 不 `git commit`；开工先 `git status` 确认并**保留用户未提交修改**。

## 验证

```powershell
npm run check
node output/2026-10-26_calendar-a6/residuals.mjs   # 卡片溢出/裁切四场景必须保持 0
```

- 截图落 `output/<今天日期>_calendar-c3/` 并**逐张看**：进行中的卡在 compact/standard/detailed × 日/周 六格矩阵（每格能看到双层条与剩余文字的取舍）、past-region 加深前后的同场景对照、now 线实线效果。
- 对比度探针：past-region 内卡片正文、剩余时间文字、两条 bar 与卡底的区分度，读数写进实施记录。
- 组件测试新增：进行中的卡渲染两条 bar（不同类名/位置）+「剩余」文字按档出现；未进行的卡只有任务进度条；既有 419 条 Vitest / 62 条 E2E 全绿（涉及卡片 DOM 的断言同步更新，不许删断言）。

## 完成定义

1. 上述判据全绿；实施记录 `docs/reports/calendar-c3-implementation.md` 写明：双层条的最终几何（位置/高度/颜色 token）、按档断点、对比度读数、未收口项与回退方法。
2. UI-SPEC 与 PROJECT-GUIDE 合并式回写完成。
3. 不 `git commit`；保留工作区其它未提交修改。
