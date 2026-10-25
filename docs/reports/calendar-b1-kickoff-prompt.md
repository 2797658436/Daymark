# 日历整改 B1 开工提示词：拖拽 pointer 化第一步（日历内移动 + 改时长）

> 用法：整段复制到新会话作为开场提示。前置：A 轮四步（A1–A4）已完成并绿；开工前先读 A4 的实施报告拿「选择器/aria-label 变更清单」。方案基线见 `docs/reports/calendar-evaluation-2026-10-24.md`（下称**评估**）的 **F04、F09、F10（日历内部分）** 与 §6 的 **D3、D5**，对应 §5.3 的第一步提交。

---

你在 Daymark 仓库（F:\PythonProject\Daymark）开工**日历整改 B1：把「日历内移动已排卡片」和「拖底边改时长」统一到一套 pointer 自绘的 drag session**，并修掉静默丢弃 drop（F04/D5）。**本步不碰「任务池→日历」与「拖回任务池」**——那两条本步仍走 HTML5 DnD，留给 B2；两步之间仓库必须始终全绿。

## 先读（按顺序，不要跳过）

1. `AGENTS.md`。
2. 评估 §4 的 **F04、F09、F10**（两套通道/五处状态/三遍计算的逐条证据与行号）、§5.3、§5.4、§6 的 D3（手写 pointer，不启用 @dnd-kit）与 D5（静默丢弃按 overlap 提交）。
3. `docs/design/UI-SPEC.md`「拖拽排程」段全文（§166–199）——本步要对齐的是 §169（两轴跟手 + 落点框不矮于卡片 + 换格过渡 + 松手瞬时收到）、§171（真卡片让位）、§166/168（拖拽中精确时间读数）、§170/172/173（插入/重叠语义）、§189/190（撤销）。
4. `docs/PROJECT-GUIDE.md` §2 拖拽相关条目（影子副本、落点先画、`pointer-events:none` 会让浏览器取消拖拽那条警告——**换 pointer 后这条警告失效，但不要在 B1 里删注释，B2 收尾时统一清**）、§10 图层表、§12「修改测试基础设施」。
5. 现状代码：`src/App.tsx` `CalendarDay` 的四个 DnD 处理器与 `previewFromDrag`（1449–1526）、`CalendarSession` 的 `draggable/onDragStart/onDragEnd` 与 `startResize`（1776–1811）、`CalendarTimeBlock` 的 pointer 三态实现（1591–1720，**这是本步的参照实现：两轴跟手、`landed` 瞬时到位、`columnShift` 整列吸附都已验证**）、`weekGhost/dayGhost`（1092/1240 与 1217/1274 渲染）。
6. 纯函数层：`src/lib/timelineDrag.ts`（吸附/钳制/`DRAG_TARGET_MIN_PX`）、`src/lib/calendarPlacement.ts`（`insertionChanges`/`concurrentLayouts`）、`src/lib/pendingPlacement.ts`、`src/lib/calendarDrag.ts`（**本步不删，B2 删**）。
7. 测试现状：`src/App.test.tsx` 211/231/262 行三条 DnD 用例与 1840/1858 行时间块 pointer 用例；`e2e/gui-optimization.spec.ts` 296 行真原生拖拽护栏与 365 行落点框用例；`e2e/phase1.spec.ts` 42/462/538 行。

## 交付范围

1. **新增 `useDragSession` hook**（放 `src/hooks/`）：单一状态机 `idle → picked(5px 阈值) → dragging → landing → committed/cancelled`；持有被抓对象（session id + 抓取偏移）、当前落点（date/startMinute/duration/mode/targetSessionId）、预览几何。**列级 `dragPreview`、网格级 `weekGhost/dayGhost`、`CalendarDay.dragSourceId` 三处状态全部收进它**；清理在 session 结束时同步做，不再靠 5 个 window `dragend/drop` 监听兜底（本步先收日历内那三处，池相关的两处留 B2）。
2. **`CalendarSession` 换 pointer**：删 `draggable/onDragStart/onDragEnd`；卡身 `onPointerDown` 拾起（5px 阈值区分点击；按钮/进度条/resize 把手/编辑按钮不触发，沿用 `pointsAtBlankTrack` 的思路做命中排除）；拖动中**半透明真卡两轴跟手**（参照 `CalendarTimeBlock` 的写法），落点虚线框另画（整列吸附、按真实时长但**不矮于卡片**、换格 150ms 过渡、松手瞬时收到——四条照抄时间块已验证的行为）。
3. **拖拽中时间读数**：复用 `src/components/ui/drag-time-preview.tsx`，拖动与改时长都贴卡显示 `09:00–10:30 · 90 分钟`（越界翻转/贴边行为现成）。
4. **真卡片让位（§171）**：插入预览期间，被推后的真卡片用 transition 移到 `insertionChanges` 给出的新位置（现在只有静态虚线幽灵 `.calendar-shift-preview`）；拖出有效区域全部复原；松手后才提交。
5. **F04/D5**：删掉 `App.tsx:1513` 的静默丢弃分支——卡片中央松手一律按 overlap 提交（与半秒 latch 同语义）；latch 保留为「明确想要重叠」的强调路径（目标卡 `overlap-target` 缩放反馈不变）。
6. **预览与提交同口径**：`previewFromDrag` 与 `placeCalendarItem` 共用同一个纯函数算落点与后移，输入集合统一为 `scheduled|missed`（修评估 F09 指出的「预览用全部 sessions、提交只取子集」）。
7. **测试**：`App.test.tsx` 211/231/262 三条改 pointer 序列（`userEvent.pointer` 或 `fireEvent.pointerDown/Move/Up`）；新增 4 条——让位 transition 存在（反向验证：去掉 transition 即失败）、拖拽中读数渲染、中央 <500ms 松手产生 overlap、取消后真卡复原；`e2e/gui-optimization.spec.ts:365` 改 pointer 驱动（落点框不矮于卡片 + 换格过渡保留）；**296 行真原生拖拽护栏本步保留**（池→日历仍是 DnD），B2 再删。

## 明确不做（越界即停并回报）

- 不碰「任务池→日历」「拖回任务池」（B2）；不删 `calendarDrag.ts`（B2）；不做跨时段/跨天确认气泡、拖入时间块确认、拖回池落区（B2）。
- 不做多选整组拖拽（后续包）；不改吸附粒度设置与 Alt 反转语义（只换载体）。
- 不改提交路径：仍 `applyExecutionSessionChanges` 单事务 + 整组撤销 + 5 秒提示（`Ctrl+Z` 行为不变）。
- 不改图层表数值（拖拽预览/落点仍在 24/35 档）；不新增依赖（**不启用 @dnd-kit**，D3）。
- 不动用户未提交修改。

## 必须保持（回归红线）

- 空白时段三手势：hover `＋`、单击三入口气泡、纵向框选（pointer 通道共存，不要互相抢 `pointerdown`）。
- 待回顾气泡「只在明确手势后打开」（点卡身 / 聚焦入口回车）——**卡身改成 pointer 拾起后，单击仍必须能打开待回顾气泡**（5px 阈值内算点击）；`gui-optimization.spec.ts:418` 盯着它。
- 键盘契约：卡片 `Enter` = 编辑时间不变；周视图方向键网格不变。
- M5（`phase1.spec.ts:538`）插入原子提交与空白框选、M4 折叠拖拽展开、撤销提示五秒/悬停暂停。

## 验证

```powershell
npm run check
node scripts/run-e2e.mjs --workers=1
node output/2026-10-24_calendar-assessment/probe.mjs
```

- 真指针 E2E 至少覆盖：跨列移动（日↔周各一）、改时长、插入后移让位、中央松手 overlap、拖出复原、`Ctrl+Z` 整组撤销；每条断言「提交后落库时间 = 预览显示时间」（同口径的直接证据）。
- probe 复拍 `cal-day-full-1200`、`cal-week-1200` 确认静态视觉零变化（本步只换输入通道）；另用一段临时脚本拍「拖动中」一帧（跟手卡 + 落点框 + 读数 + 让位）落 `output/<今天日期>_calendar-b1/`，**逐张看**。
- 960×200% 浅/深 axe 与 M13 遮挡用例全绿。

## 完成定义

1. 代码 + 测试落地，`npm run check` 四步全绿；B1 结束时仓库里 DnD 只剩池相关两条路径。
2. 写 `docs/reports/calendar-b1-implementation.md`：状态机契约（状态×事件×副作用表）、与时间块实现的复用关系、同口径纯函数的签名、验证实测、反向验证、遗留（B2 清单）。
3. 文档同步：PROJECT-GUIDE §2 拖拽条目改为「日历内已 pointer 化、池路径仍 DnD（B2）」、§5 代码地图加 `useDragSession`、§11 测试数量、§12 修改入口。
4. 不 `git commit`；不动用户未提交内容。
5. 汇报：状态机表、验证实测、B2 交接点（池路径要接的 session 事件名、296 行护栏何时可删）。
