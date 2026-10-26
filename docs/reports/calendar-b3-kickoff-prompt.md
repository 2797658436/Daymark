# 日历整改 B3 开工提示词：改时长接入让位与确认气泡、折叠展开期间抑制边缘滚动

> 用法：整段复制到新会话作为开场提示。前置：B1–B2 已完成并验收、已提交（`8adddaf`）。方案基线见 `docs/reports/calendar-evaluation-2026-10-24.md`（下称**评估**）的 **F21、F22** 与 §6 的 **D12、D13**。本包是 B 轮的收口小包，**不引入新通道、不改状态机五态结构**。

---

你在 Daymark 仓库（F:\PythonProject\Daymark）开工**日历整改 B3：把「拖底边改时长」接进 B2 已经建好的让位与确认体系，并消掉折叠悬停展开与边缘自动滚动在轨道上沿的互相拉扯**。两件事都是 B2 报告 §9 记下的口子，用户已裁决补齐（D12/D13）。

## 先读（按顺序，不要跳过）

1. `AGENTS.md`。
2. 评估 §4 的 **F21、F22**、§5.3（B 轮验收口径）、§6 的 **D5、D12、D13**。
3. `docs/reports/calendar-b2-implementation.md` §3（状态机五态契约与 `buildDecision` 签名）、§4（`dropImpact`／`dragEdgeScrollVelocity`）、§9.1 与 §9.6（本包要收的两个口子）、§10 遗留清单。
4. `docs/reports/calendar-b1-implementation.md` §2（`picked` 的 5px 阈值与 `suppressClick`）、§6（让位与读数）。
5. `docs/design/UI-SPEC.md`「拖拽排程」段 **§189 后半**（改时长侵入时间块沿用相同确认）与 **§197**（向下拉长让位 + 跨默认时段／跨天用小气泡确认）——这两条是本包的规格依据，**文本不改，实现补齐**。
6. `src/hooks/useDragSession.tsx`：`computePreview` 对 `kind === "resize"` 的提前返回、`pointerup` 的 resize 分支、rAF 边缘滚动循环与 `insideViewport` gate。
7. `src/lib/calendarPlacement.ts`：`resolveCalendarDrop`（`sourceDuration` 入参已就位）、`dropImpact`、`insertionChanges`。
8. `src/App.tsx`：`buildDragDecision` 的两条分支、`dragExpandedGapKey`／`expandedGapKeys` 的状态归属（日视图折叠悬停展开）、`onResize` 的提交路径与撤销批次。
9. 视觉参照：`output/2026-10-26_calendar-b2/boundary-confirm.png`（气泡形态与锚点）。

## 现状账（改前基线）

- `kind === "resize"` 在 `pointerup` 提前返回、`computePreview` 对 resize 只返回 `shifted: []`：拉长卡片**不会推动后续任务**、侵入时间块或推出默认时段时**没有任何提示**，直接落库。UI-SPEC §189 后半与 §197 因此是空头承诺。
- 折叠条贴在轨道上沿：指针悬停它触发 §128 的半秒展开，同时它一直在 56px 边缘触发带里，§200 的边缘滚动继续跑——展开与滚动同时发生，落点边展开边往上跑（B2 的 E2E 用「先移到中段再量」绕开，产品侧未决）。

## 交付范围

### 1. 改时长接入让位与确认（F21，D12）

- `computePreview` 的 resize 分支不再返回空 `shifted`：把 `resolveCalendarDrop` 的后移计算接进去（`sourceDuration` 入参已就位），**拉长时同列后续时段按插入语义让位**（真卡 `top` 过渡、`data-yielding`，与 move 完全同一条路）；缩短只释放空档（§198 不变）。
- `buildDecision` 增加 `kind: "resize"` 入参，两条分支照旧但允许 resize 触发：
  - 侵入时间块（拉长后的区间覆盖某个 `.calendar-time-block`）→ `kind: "block"`，气泡两选项「仍然安排／取消」（**不给**「放到时间块之后」：改时长没有"之后"语义）；
  - 拉长把后续时段推出默认时段／推去别的日期（`dropImpact` 非空）→ `kind: "boundary"`，气泡文案沿用「会影响 N 项已有安排／它们会被推出默认时段／会被推到 X」。
- `deciding` 态对 resize 与 move 同语义：确认 → `landing` 一次提交（**时长变化 + 后移 = 一个撤销项**）；取消 → `idle` 零副作用。读数在 resize 期间继续贴卡显示（B1 已做）。
- 周视图与全天模式的 resize 仍只可能判出 `cross-day`（`defaultRanges` 为空时的既有口径），不新增打扰。

### 2. 折叠展开期间抑制边缘滚动（F22，D13）

- `useDragSession` 的 rAF 循环加一条 gate：日视图的折叠条**正被悬停展开**（`dragExpandedGapKey` 非空，或展开动画未结束）时 `dragEdgeScrollVelocity` 直接返回 0；展开完成且指针离开折叠条后恢复。gate 的输入由 `ContinuousDayView` 经 provider 传入（ref 或布尔，不要新建第二套状态）。
- 不改 §200 的其余语义：指针在边缘带且没有展开发生时，爬升曲线与「回中央立即 0」一字不动；`insideViewport` gate 不动。

### 3. 测试

- 组件测试新增 3 条：resize 产生 `shifted` 且真卡 `data-yielding`；resize 侵入时间块 → `deciding` 且只有两选项；resize 越界气泡取消后时长与后续时段逐字段不变。
- E2E 新增 2 条：① 拉长穿过时间块 → 气泡 → 「仍然安排」落库 = 读数、`Ctrl+Z` 一次回到原时长与原位置；② 指针悬停轨道上沿折叠条 → 半秒后展开**且 `scrollTop` 在展开期间不变**；指针移到中段后边缘滚动恢复（单调性断言沿用 B2 那条用例的写法）。
- 回归红线：B2 的 60 条全绿（含越界确认取消零副作用、时间块三选项、拖回池落区、边缘滚动单调性）；M4／M5、960×200% 浅深 axe、M13 两条不跳过。

### 4. 文档回写（合并式）

- `docs/PROJECT-GUIDE.md` §2 拖拽条目补「resize 与 move 共用让位与确认」、§12「修改日历内的拖拽通道」补 resize 分支与边缘滚动 gate 两条入口。
- `docs/design/UI-SPEC.md`：**不改** §189／§197 文本（本包是补齐实现）；§128 补一句「悬停展开期间边缘自动滚动暂停，展开结束即恢复」。
- 评估 §4 的 F21／F22 标「已收口（B3）」、§5.5 索引与验收记录由总 Agent 维护，不要重复改。

## 明确不做（越界即停并回报）

- 不做多选整组拖拽（后续包）；不做「拖边同时挪位置 + 改时长」（`preview.duration` 对 move 恒等于源时长，B2 §9.5 已记）。
- 不改状态机五态结构、不改图层表、不改吸附与 Alt 语义、不改提交事务与撤销栈粒度（一次手势 = 一个撤销项）。
- 不碰 F13 月视图、任务池 200% 裁切、周 200% 窄列（已裁决接受/留后续）。
- 不 `git commit`；不动用户未提交修改。

## 验证

```powershell
npm run check
node scripts/run-e2e.mjs --workers=1
node output/2026-10-26_calendar-a6/residuals.mjs
```

- residuals 四场景溢出卡 0、日横溢 0、药丸 4.89、吸顶 44/88 不退化（本包不改呈现，只换拖拽行为）。
- 拍 3 张拖动中截图并**逐张看**：resize 让位（真卡下移 + 读数）、resize 侵入时间块的气泡（两选项）、折叠条悬停展开且视图不滚的对照帧（展开前后 `scrollTop` 同值）；落 `output/<今天日期>_calendar-b3/`。
- 静态 18 张 probe 截图与 B2 的 `probe/` 逐字节相同（本包不改静态呈现）。

## 完成定义

1. 上述判据全绿；实施记录 `docs/reports/calendar-b3-implementation.md` 写明：resize 的 shifted/decision 契约表、gate 的输入来源、两条反向验证（去掉 gate 应红在 scrollTop、resize 不接 shifted 应红在新用例）、未收口项与回退方法。
2. PROJECT-GUIDE 与 UI-SPEC 合并式回写完成。
3. 不 `git commit`；保留工作区其它未提交修改。
