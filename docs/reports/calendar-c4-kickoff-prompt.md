# 日历整改 C4 开工提示词：密度档切换保持滚动位置、并排卡片可自由错开时间

> 用法：整段复制到新会话作为开场提示。决策依据 **D16**（评估 §6）：用户 2026-10-27 实测反馈 #3、#4。
> 本包是 C 轮里唯一的**拖拽机制**改动，最重的一份，单独投喂、单独验收。红线：B1–B3 建立的状态机五态结构、让位/确认体系、一次手势=一个撤销项、预览与提交同口径——**全部不许回退**。C1–C4 四包相互独立。

---

你在 Daymark 仓库（F:\PythonProject\Daymark）开工**日历整改 C4：① 点「紧凑/标准/详细」切档后视口停在原来的逻辑时间上（不再跳到别的地方）；② 两张卡并排时，第二张可以被拖到与第一张部分错开的任意时刻（不再强制对齐目标卡起点）**。

## 先读（按顺序，不要跳过）

1. `AGENTS.md`。
2. 评估 §5.5 的 C 轮索引、§6 的 **D16**；`docs/reports/calendar-b1-implementation.md` §2（picked 阈值）、`calendar-b2-implementation.md` §3（五态契约、`buildDecision`）、`calendar-b3-implementation.md` §2（resize 与 move 共用出口）、§4（`cascadeChanges` 三口径）。
3. `src/hooks/useCalendarViewport.ts` 全文，重点：逻辑位置 `{date, minute, viewportRatio}` 与 `applyPosition`/`scrollTopForCalendarPosition`（124–135、469–485）、Ctrl+滚轮的 `captureZoomAnchor`/`compensateZoomAnchor`（530–539 及 zoomAnchorRef）、ResizeObserver 只在 client 尺寸变化时触发（581–600）。
4. `src/App.tsx`：`setZoom`（1366–1369）与密度分段按钮（1503）、`zoomWithWheel`（1454，唯一的 captureZoomAnchor 调用点）、`--calendar-hour-height` 内联下发（1462）。
5. `src/lib/calendarPlacement.ts`：`resolveCalendarDrop`（139–173，四分支：insert-before <0.25 / overlap 中段 / insert-after >0.75 / place 空档）、`cascadeChanges`（46）、`concurrentLayouts`。
6. `src/hooks/useDragSession.tsx`：`sessionAtPoint`（245–267，**x 只校验在整列轨道内、y 用原计划几何**）、overlap 的 0.5s 闩锁（150、363–385）、`computePreview` 的 snap（358–360）、`up` 提交路径（592–614）。

## 现状账（改前基线，均已实测定位）

- **切档跳位**：`setZoom` 按钮路径不经过任何锚点补偿（`zoomAnchorRef` 只有 Ctrl+滚轮写入）；切档只改内容高度（scrollHeight），浏览器保持 `scrollTop` 像素不变且往往不派发 scroll 事件，ResizeObserver 也因 client 尺寸未变而不触发——每小时像素从 84 变 216 时，同一 scrollTop 指到的逻辑时间漂移约 60%，用户看到的就是「跳到别的地方」。逻辑位置机制（`applyPosition`）已存在，只是没接到 scale 变化上。
- **并排卡无法错开**：`sessionAtPoint` 的 x 判定只看「在轨道内」，两张卡并排（`concurrentLayouts` 分 lane）时，拖第二张、指针哪怕在自己 lane 的空白时刻上，只要与第一张**时间区间**纵向交叠，第一张就成为 target；`resolveCalendarDrop` 随后只有三种出口——上/下 25% 边带插入（吸附到目标起点/终点，还会级联推移）、中段 overlap（`startMinute = targetStart`，**完全对齐第一张的开始时间**）。想把第二张放到 11:15 这种部分错开的时刻做不到；唯一的自由放置（place）只存在于与所有卡都不重叠的空档。

## 交付范围

### 1. 密度档切换保持逻辑位置（#3）

- `setZoom`（按钮路径）在写偏好**前**捕获锚点、scale 生效后补偿：优先复用 Ctrl+滚轮已有的 `captureZoomAnchor`/`compensateZoomAnchor` 通道；若该通道的锚点定义（指针位置）不适用按钮场景，就改用逻辑位置存取（切档前记 `{date, 视口中央 minute}`，`useLayoutEffect` 在 scale 变化后 `applyPosition` 恢复）——**选一条路，写清理由**。
- 三日缓冲（前/当/后三块网格）与周视图多列下同样成立；切档过程中不得触发「用户滚动」采样污染 viewport 记忆。
- 验收判据：任意滚动位置（含折叠带展开态、贴顶、贴底）点紧凑↔标准↔详细，切换前后**视口中央的逻辑分钟差 ≤1 分钟**，且用户正在看的卡片仍在视口内。探针读数写进实施记录。

### 2. 并排卡片自由错开（#4，D16）

- **lane 命中**：`sessionAtPoint` 改为按卡片的实际渲染矩形（含横向 lane，来自 `concurrentLayouts` 的结果）判 target；指针落在 lane 之间的空白横向区域时**不构成命中** → 走 place（自由分钟 + 既有 snap/Alt 语义），即使纵向上与别的卡重叠。
- **中段 overlap 语义变更**：指针在某卡矩形中段（0.25–0.75）时，`startMinute` 从「= targetStart」改为「= 指针分钟（经 snap）」；0.5s 闩锁机制保留（闩锁后跟手显示 overlap 预演）。
- **边带插入语义不变**：上/下 25% 边带的 insert-before/insert-after 与级联让位（`cascadeChanges`）一条不改——推移重排是 B 轮验收过的核心行为。
- 预览与提交仍必须同口径：`computePreview` 与 `placeCalendarItem`（App.tsx:474–484 的 `resolveCalendarDrop(commit:true)`）走同一份规则；落库后并排显示由 `concurrentLayouts` 照常处理。
- 越界/时间块确认气泡的输入不变（`dropImpact` 看 `shifted`、`blockOverlapping` 看区间），但注意 overlap 落点变成指针分钟后，boundary 判定的入参要跟着用新 `startMinute`——用既有函数，不改判据本身。
- resize 通道不受影响（resize 不动 `date`/`startMinute`，B3 契约原样）。

### 3. 规格回写（合并式）

- `docs/design/UI-SPEC.md` 拖拽段：把「悬停卡片中段=与其对齐并排」的表述改为「悬停卡片中段=并排，开始时间取松手时刻（经吸附）；指针在并排卡之间的空白 lane 上=自由放置」；边带插入与让位的句子不动。
- `docs/PROJECT-GUIDE.md` §12 拖拽通道入口补 lane 命中与切档保位两条。

### 4. 测试

- `calendarPlacement.test.ts` 新增：中段 overlap 的 `startMinute` = 指针分钟；指针在 lane 空白 → place；边带插入与级联逐字回归既有用例。
- `App.test.tsx` 新增组件用例：两张并排卡，把第二张拖到与第一张错开 30 分钟的位置落库成功、`data-yielding` 不出现（没有级联）；切档保位用例（若可在 jsdom 断言逻辑位置恢复）。
- E2E 新增 1–2 条：真指针把并排第二张拖到错开时刻（断言落库时间与吸附）；任意滚动位置切档后中央分钟差 ≤1。
- **反向验证**（写进实施记录，必须先红后绿）：① 把 lane 命中改回「只看纵向区间」→ 新 E2E/组件用例应红；② 去掉切档补偿 → 保位用例应红。
- 回归红线：B1–B3 的全部拖拽用例（插入让位、时间块三选项、boundary 气泡、resize 让位与确认、拖回池、撤销粒度、边缘滚动）一条不许改断言；419+ Vitest、62+ E2E 全绿。

## 明确不做（越界即停并回报）

- 不做多选整组拖拽、不做「拖边同时挪位置+改时长」（既有未收口项）。
- 不改状态机五态结构、图层表、吸附/Alt 语义、提交事务与撤销粒度。
- 不动气泡/表单（C2）、布局骨架（C1）、卡片进度呈现（C3）。
- 不 `git commit`；开工先 `git status` 确认并**保留用户未提交修改**。

## 验证

```powershell
npm run check
node scripts/run-e2e.mjs --workers=1
node output/2026-10-26_calendar-a6/residuals.mjs   # 呈现零变化，四场景保持 0
```

- 截图落 `output/<今天日期>_calendar-c4/` 并**逐张看**：并排第二张拖到错开时刻的拖动中帧（落点框/预演 + 读数）与落库后帧；切档前后同场景对照帧（标注中央分钟）。静态 18 张 probe 应与上一轮**逐字节相同**（本包不改静态呈现；若 C1–C3 已合入则以那轮为基线）。

## 完成定义

1. 上述判据全绿；实施记录 `docs/reports/calendar-c4-implementation.md` 写明：切档保位选了哪条通道及理由、lane 命中的几何来源、中段 overlap 新语义的边界情况（跨 lane 拖动、三卡并排、snap 关闭态）、两条反向验证的红/绿记录、未收口项与回退方法。
2. UI-SPEC 与 PROJECT-GUIDE 合并式回写完成。
3. 不 `git commit`；保留工作区其它未提交修改。
