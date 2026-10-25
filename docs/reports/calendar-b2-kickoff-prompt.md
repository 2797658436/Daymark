# 日历整改 B2 开工提示词：拖拽 pointer 化第二步（任务池↔日历）与规格补齐收尾

> 用法：整段复制到新会话作为开场提示。前置：B1 已完成并绿；开工先读 `docs/reports/calendar-b1-implementation.md` 的状态机契约与交接点。方案基线见 `docs/reports/calendar-evaluation-2026-10-24.md`（下称**评估**）的 **F09、F10、F14** 与 §6 的 **D3、D6**，对应 §5.3 的第二步提交与收尾。

---

你在 Daymark 仓库（F:\PythonProject\Daymark）开工**日历整改 B2：把剩下两条 HTML5 DnD 路径（任务池→日历、拖回任务池）接入 B1 的 `useDragSession`，补齐 UI-SPEC「拖拽排程」段剩余目标，删除 DnD 遗留与周视图折叠死参数**。本包结束后全仓不再有 HTML5 DnD。

## 先读（按顺序，不要跳过）

1. `AGENTS.md`。
2. 评估 §4 的 **F09、F10、F14**、§5.3、§5.4、§6 的 D3/D6。
3. `docs/reports/calendar-b1-implementation.md` —— 状态机契约、同口径纯函数、交接点。
4. `docs/design/UI-SPEC.md`「拖拽排程」段未实现条目：§187/188 跨默认时段/跨天确认、§185/186 拖入时间块、§191 拖回池落区、§177 重叠区预演并排、§176 选中浮前与同组左右键、§126 折叠条适用范围；「任务卡交互」§67（两种拖拽语义：池拖入=新增时段、日历内拖=移动时段）。
5. 现状代码：`src/App.tsx` `TaskPoolRow.onDragStart`（约 1033）、`TaskPool.onDragOver/onDrop`（约 930–932）、`CalendarDay` 残留 DnD 处理器、`weekGhost/dayGhost` 渲染（1217/1274）、折叠死参数（1216 与 1296–1327 的周视图未接线部分）；`src/lib/calendarDrag.ts` 全份。
6. `e2e/phase1.spec.ts` 42–90（拖拽安排与撤销）、462–587（M4/M5）、`e2e/gui-optimization.spec.ts` 282–416（真原生拖拽护栏、落点框）。

## 交付范围

1. **池→日历接 pointer**：`TaskPoolRow` 卡身 pointer 拾起进入同一个 `useDragSession`（语义 = 新增一次执行时段，UI-SPEC §67）；拖动中池行变淡、日历显示落点框 + 读数；松手走同一条提交路径。**删除 `application/x-daymark-task`／`x-daymark-session`／`x-daymark-grab` 三个 dataTransfer 键与 `src/lib/calendarDrag.ts` 整份**（影子副本失去存在理由），`calendarDrag.test.ts` 一并删除。
2. **拖回任务池（§191）**：拖动日历卡片悬停任务池时，池显示「移回任务池」落区（虚线描边 + 文案 + 计数说明「只取消本次时段，保留任务与历史」）；松手 = 取消本次安排（既有语义），进同一撤销批次。删除池侧 `onDragOver/onDrop` 的 DnD 实现。
3. **跨默认时段/跨天确认（§187/188）**：落点导致插入/后移越过默认时段边界或跨天时，松手后在落点旁开锚定气泡（受影响数量 + 新日期），确认才提交、取消则全部复原；无跨界的普通插入直接提交不加确认（§188）。
4. **拖入时间块（§185/186）**：时间块参与落点命中；中央落点预览文案「与时间块同时安排」；松手后气泡三选项「仍然安排／放到时间块之后／取消」；「仍然安排」只覆盖本次，不改自动排程规则。
5. **重叠区预演（§177）与选中浮前（§176）**：拖入已有并行组时，预览提前显示松手后的并排/「另外 N 项」结果（用 `concurrentLayouts` 试算）；并行组内选中卡视觉浮前 + 同组左右方向键切换（键盘，不改日历顺序）。**多选整组拖拽不做**（后续包），但状态机要留出 group 接口位置而不实现。
6. **边缘自动滚动升级（§197）**：`dragEdgeScrollTop`（`useCalendarViewport.ts:157-164`）从「dragover 回调里线性 /4」改为 drag session 期间的 rAF 循环：距离边缘越近速度越快、指针回中央立即停；日视图跨午夜拖动时日期分隔带保持醒目并持续显示新日期/起止（§198）。
7. **F14/D6**：删除周视图路径上的折叠死参数（`App.tsx:1216` 未接线的 props 与相关类型），**合并式回写 UI-SPEC §126** 为「折叠与拖拽悬停展开只适用于日视图」；顺带清掉 B1 留下的「pointer-events:none 会取消 DnD」过时注释（PROJECT-GUIDE §2 对应条目同步）。
8. **测试收尾**：`e2e/phase1.spec.ts:42-90` 改 pointer 序列；462–587 按新语义复核（M4 折叠拖拽展开仍只日视图）；`gui-optimization.spec.ts:296` 真原生拖拽护栏**删除**（不再有浏览器取消拖拽的风险），365 保留；`useCalendarViewport.test.tsx:86-88,238-242` 的 dragstart/dragend 监听用例改 `beginDrag/endDrag`；新增 E2E：跨天确认气泡确认/取消、时间块三选项、拖回池落区、边缘滚动加速（断言速度随距离单调）。

## 明确不做（越界即停并回报）

- 不做多选整组拖拽与批量预览（后续包）；不做周视图折叠（D6 已定删除）。
- 不改提交事务与撤销栈结构；不改吸附设置；不改图层表数值。
- 不引入 @dnd-kit 或任何新依赖（D3）。
- 不动用户未提交修改（UI-SPEC 回写必须合并式）。

## 必须保持（回归红线）

- 池→日历 = 新增时段、日历内拖 = 移动时段的**两种语义不得合并**（UI-SPEC §67）；池行单击/双击/多选等既有交互不受 pointer 拾起影响（5px 阈值 + 命中排除）。
- 撤销：一次拖拽引起的全部变化（含跨天确认后的后移）是一个撤销项；5 秒提示/悬停暂停/`Ctrl+Z` 不变。
- 待回顾气泡、空白三手势、键盘网格、M4/M5/M9 全部用例绿。
- 全仓 grep 不得再出现 `dataTransfer.setData`／`draggable`（除浏览器预览接缝外）。

## 验证

```powershell
npm run check
node scripts/run-e2e.mjs --workers=1
node output/2026-10-24_calendar-assessment/probe.mjs
```

- 真指针 E2E 全链路：池→日历新增、日历内跨列移动、改时长、插入后移、跨天确认（确认/取消两路）、时间块三选项、拖回池、并行预演、边缘滚动；每条断言落库 = 预览。
- probe 复拍日/周/月 × 1200/960 确认静态视觉零变化；临时脚本拍「池行拖起悬停日历」「拖回池落区」「跨天确认气泡」三帧落 `output/<今天日期>_calendar-b2/`，**逐张看**。
- 960×200% 浅/深逐页 axe + M13 两条全绿；`grep -rn "draggable\|dataTransfer" src/` 应只剩注释或零命中。

## 完成定义

1. 代码 + 测试落地，`npm run check` 四步全绿；HTML5 DnD 全仓清零。
2. 写 `docs/reports/calendar-b2-implementation.md`：DnD 清除清单（文件/键/用例）、状态机最终契约、规格补齐对照表（UI-SPEC §166–199 逐条 已实现/不适用）、验证实测、反向验证、遗留（多选整组、周视图折叠、F13）。
3. 文档同步：PROJECT-GUIDE §2（拖拽整段重写为 pointer 单通道）、§5 代码地图（删 `calendarDrag.ts`、加 `useDragSession` 最终形态）、§10/§12 相关条目、§11 测试数量；UI-SPEC §126 合并回写；评估文档 §4 F04/F09/F10/F14 状态标注为「已收口（B1/B2）」并链到两份实施报告。
4. 不 `git commit`；不动用户未提交内容。
5. 汇报：规格对照表、验证实测、后续包清单（F13、多选整组）、以及是否发现评估漏报的问题。
