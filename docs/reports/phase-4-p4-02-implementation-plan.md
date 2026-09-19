# 阶段 4 P4-02 实施方案：浮层宿主与编辑会话（任务／里程碑先行）

版本：1.0；编制日期：2026-09-10；状态：**方案待评审，尚未动代码**。
对应工作包：P4-02（`docs/specs/0005-phase-4-daily-workflow-and-reliability.md` §10），依赖 P4-01（已完成）。
依据章节：规格 §4（M8 统一语义、契约、状态转换）、§9（模块划分）。
前置事实：[P4-01 基线报告](phase-4-p4-01-baseline.md)。

## 1. 范围

**做**：建立浮层宿主与编辑会话两个抽象；把「编辑任务」「里程碑」两个编辑面先接上去；把 `FloatingPanel` 的视觉尺寸与模态语义分开。
**不做**（留给 P4-03）：项目、时间块、习惯、默认时段、导入的接入；输入法组合期的 Enter；慢请求与键盘的全量验证。
**禁止**：改保存协议、改 NativeApi、动 SQLite 与 schema。

## 2. 现状清单（带行号，实施前请以此为准）

### 2.1 两套并行的浮层机制

| 机制 | 位置 | 调用点数 | 语义 |
| --- | --- | --- | --- |
| `FloatingPanel` | `src/components/ui/floating-panel.tsx`（42 行） | 9 | 自称 nonmodal（L4 注释），实际已 `role="dialog"`（L41） |
| `modal-backdrop` + `useModalBehavior` | `src/App.tsx:1489` | 4 | 真模态：`.app-shell` inert + Esc + Tab 循环 + 焦点恢复 |

9 个 `FloatingPanel` 调用点：`新建重复习惯`(App.tsx:508)、`编辑任务`(534)、`添加时间块`(693)、`空白时段操作`(961)、`编辑时间：`(1214)、`创建项目／导入课程分集／读取 B 站公开视频`(1252)、`添加项目任务`(1258)、`里程碑`(1278)、`编辑默认时段`(1473)。

4 个真模态：`ContinueScheduleDialog`(1193)、`AutoScheduleDialog`(1386)、`FinishDialog`(1476)、`RestoreDialog`(1484)。

### 2.2 `FloatingPanel` 与规格描述的偏差（全部复核为真）

| 规格 §2 所述 | 实际代码 |
| --- | --- |
| 气泡拦截外部指针，Tab 仍可离开 | L36-37 用 window capture 吞 `click/pointerdown/pointerup`；**没有 Tab 循环，也没有 inert**，背景仍可被键盘聚焦 |
| 视觉尺寸与模态语义未分开 | `role="dialog"` 却没有 `aria-modal`；面板宽度靠 `wide` prop，语义靠外部约定 |
| Esc 是否可关靠猜业务状态 | L28 `if (!panel.querySelector("[aria-busy=true]")) close` —— 查询后代 DOM 推断提交中，而非显式 `busy` |
| 焦点所有权 | L7 挂载时抓 `document.activeElement` 当 trigger；L39 卸载时若 `trigger.isConnected` 才恢复；**无标题关联（无 `aria-labelledby`）** |

另有一处只覆盖两个按键的准陷阱：L29-32 在面板外按下 `Enter`/`Space` 时 `preventDefault` 并把焦点拉回第一个字段 —— 不是完整 Tab 循环。

### 2.3 `useModalBehavior` 的既知缺陷（规格 §4.1 点名）

`src/App.tsx:1504` 在清理时**无条件**执行 `shell?.removeAttribute("inert")`。两个浮层叠开时，关掉内层会解除外层的背景保护。宿主必须改成引用计数。

### 2.4 草稿与提交状态现状

每个编辑器各自持有 `useState` 管 `draft/busy/error`（如 `TaskEditorFields` 1522、`MilestoneForm` 1313、`ProjectEditor` 1295），**没有共享会话**；`key={editingTask.id}`(534) 在切换对象时整块重挂载，草稿随之丢弃，也因此**没有「旧请求不得关闭另一对象编辑器」的保护**。规格 §4.3 的提交互斥与「旧请求丢弃」目前不存在。

### 2.5 测试锁定面（改动前必须知道）

E2E 通过 `getByRole("dialog", { name })` 定位 **7 个气泡 + 2 个模态**：

- `e2e/gui-optimization.spec.ts`：`编辑默认时段`(12)、`创建项目`(23)、`里程碑`(28)、`编辑任务 保留原任务`(46)、`添加时间块`(54)、`添加项目任务`(77)，以及 59/68/71/75 行的 `getByRole("dialog")` 计数断言
- `e2e/phase1.spec.ts`：`自动排程 Lite`(89)、`空白时段操作`(495、539)、`getByRole("dialog")`(135)

两条硬约束：

1. **编辑气泡必须保持 `role="dialog"` 且可访问名（`aria-label` 或 `aria-labelledby` 的文本）逐字不变**，否则上述定位器会大面积失效。
2. `gui-optimization.spec.ts:59` 用 `expect(getByRole("dialog")).toHaveCount(1)` 断言「不能叠开第二个编辑器」。`dispatchEvent` 会绕过 `pointer-events` 与 `inert`，因此**capture 阶段的外部指针守卫必须保留**，不能只靠 `inert`。

Vitest 侧：`floating-panel` 类选择器 0 处，行为断言走 role 与文案，相关断言仅 2 行 → 组件层可改空间较大。

## 3. 设计

### 3.1 三类语义（按「有没有草稿」划分，而不是按长相）

| 类别 | 判定 | 语义 | 现状归属 |
| --- | --- | --- | --- |
| 动作气泡 | 无草稿，选一个动作即关 | 非模态：可外点关闭、`role="dialog"`（保留 E2E 定位器）、**无** `aria-modal`、不进 inert | 仅 `空白时段操作`(961) |
| 编辑气泡 | 有草稿与保存／取消 | 紧凑模态：`role="dialog"` + `aria-modal="true"` + 标题关联 + Tab 循环 + 焦点恢复 + 背景 inert，视觉仍是锚点旁小气泡 | 其余 8 个 |
| 危险确认 | 不可逆操作 | 独立居中模态，复用宿主，保持现有不可取消语义 | 4 个 `modal-backdrop` |

`空白时段操作` 之所以不判为「只读信息气泡」：它不承载只读信息，而是动作入口；但语义上也不该拦住背景键盘操作。规格 §4.1 的两分法在这里需要第三个类别，**这一条请你确认**（见 §6）。

### 3.2 `src/components/ui/overlay-host.tsx`（新建）

- 在 `body` 的 Portal 中渲染；`App` 顶层挂一次 `<OverlayHostProvider>`。
- 维护**浮层栈**；对 `.app-shell` 的 `inert` 做**引用计数**：栈非空即 inert，清空才移除。彻底消除 2.3 的缺陷。
- 只管四件事：层级顺序、`inert` 归属、Tab 循环与 Esc 的**顶层唯一性**、焦点所有权（记录打开前焦点，栈清空后恢复）。
- 明确不承担：业务保存、数据库写入、气泡几何计算（几何仍归 `FloatingPanel`，见规格 §9 的职责表）。
- 对外 API（草签，评审时可改）：

```ts
type OverlayKind = "editor" | "action" | "confirm";
interface OverlayHandle {
  id: string;
  kind: OverlayKind;
  dismissible: boolean;      // submitting 期间为 false
  onDismiss(reason: "escape" | "outside"): void;
  returnFocusTo: HTMLElement | null;
}
useOverlayHost(): {
  register(handle: OverlayHandle): () => void;  // 返回注销函数
  isTop(id: string): boolean;
  layerCount: number;
};
```

### 3.3 `src/hooks/useEditorSession.ts`（新建，需新建 `src/hooks/` 目录）

落地规格 §4.2 的契约与 §4.3 的状态转换：

```ts
type EditorPhase = "editing" | "submitting" | "error";
type CloseReason = "cancel" | "escape" | "saved";
interface EditorSession<T> { key: string; initial: T; draft: T; phase: EditorPhase; error: string | null; trigger: HTMLElement | null }
```

必须保证的行为（逐条对应规格 §4.3）：

1. 提交时**同步**锁 `submitting`，再发一次请求；连点保存／Enter／Esc／取消在 submitting 期间全部无效且不关闭。
2. 请求闭包捕获 `key`；结果返回时若当前会话 `key` 不同，**丢弃结果**，不关闭也不覆盖另一个对象的编辑器。
3. 成功用返回快照关闭并显露保存对象；失败转 `error`，草稿原样保留、可重试。
4. `取消` 与 `Esc` 走同一个"明确放弃"路径；未提交修改不写库。
5. **例外**：导入流程"取消保留按模式草稿"继续保留，并写入测试（规格 §4.1）。
6. 数据恢复／工作区重载时先查活动会话：未提交则明确放弃或返回，提交中则等待（规格 §4.3 表末两行）。

`useEditorSession` 只依赖调用方传入的 `onSave`，**不引入新的保存协议**。

### 3.4 `FloatingPanel` 的改造（最小改动面）

1. 新增显式 `busy: boolean` 与 `dismissible?: boolean` prop；Esc 判断改读 prop，删除 `[aria-busy=true]` 查询（保留 `aria-busy` 属性本身，供测试与 AT 使用）。
2. 新增 `titleId`（或 `headingId`）prop，把 `aria-labelledby` 关联到面板内标题；**不生成时回退到现有 `aria-label={label}`**，保证可访问名不变。
3. `aria-modal` 由宿主按 `kind` 注入，`FloatingPanel` 不自行决定。
4. **保留** capture 阶段的外部指针守卫（理由见 §2.5 第 2 条）。
5. 几何逻辑（12px 边距、翻转避让、ResizeObserver、视口内滚动）**一行不改** —— AC01 已通过，不在本工作包范围。

## 4. 分批实施与验收

每批独立可回归，批间不留半成品。

| 批 | 内容 | 验收 |
| --- | --- | --- |
| B1 | 建 `overlay-host.tsx`，把 `.app-shell` inert 从 `useModalBehavior` 迁到宿主（引用计数）；4 个模态改走宿主；**不动 `FloatingPanel`** | 现有 4 个模态行为不变；`npm run test:e2e` 中 phase1 的模态路径全绿 |
| B2 | 建 `useEditorSession`；接 `编辑任务`(534) 与 `里程碑`(1278)；`FloatingPanel` 加 `busy`／`titleId` | 新增组件测试：提交互斥、失败保留草稿、旧请求不串对象（AC03 的任务／里程碑部分） |
| B3 | 编辑气泡加 `aria-modal` + 标题关联 + Tab 循环（由宿主提供） | `getByRole("dialog", { name })` 全部定位器仍可用；新增 Tab 不落背景、Esc 后焦点恢复的断言（AC02） |
| B4 | 草稿策略收口：导入例外写测试；工作区重载时的会话处置 | 导入各模式草稿隔离（AC04）；重载不静默丢草稿 |

收尾串行运行：`npm run check`（**注意**：`test:e2e` 当前带 1 条 flaky 用例，见 P4-01 §3.4 —— 它是 M3 的滚动竞态，与本工作包无关，出现时按 P4-01 记录处理，不要为了让 CI 变绿而放宽断言）。

## 5. 风险

| 风险 | 缓解 |
| --- | --- |
| E2E 大面积依赖 `role="dialog"` + 可访问名 | B3 之前先跑一遍 `gui-optimization.spec.ts` 作冒烟；改动只加属性不改名字 |
| `aria-modal="true"` 引入新的 axe 问题（背景仍有可聚焦元素） | `inert` 与 `aria-modal` 同时生效；phase1 已有浅／深色 axe 用例，B3 后立刻跑 |
| 背景 inert 与 `dispatchEvent` 绕过导致「叠开第二个编辑器」断言失败 | 保留 capture 指针守卫（§3.4 第 4 条） |
| 输入法组合期 Enter 误提交 | 本工作包不改 Enter 行为，留 P4-03 |
| 新目录 `src/hooks/` 与既有单文件风格不一致 | 规格 §9 已指名该路径；只放 1 个文件，不批量搬迁 |

## 6. 待确认（评审时请定）

1. **动作气泡作为第三类语义**是否接受？规格 §4.1 只写了两类（只读信息气泡／编辑气泡），而 `空白时段操作` 两者都不属于。我建议单列"非模态动作气泡"，并保留 `role="dialog"` 以免改 E2E。
2. **4 个真模态是否一并迁进宿主**（B1）？我建议迁：否则 inert 归零逻辑被两套机制撕开，2.3 的缺陷仍会在"模态 + 编辑气泡"同时存在时复现。
3. **`FloatingPanel` 是否改名**？现在它同时承担"编辑气泡"与"动作气泡"两种语义，名字已误导。我建议本工作包不改名（改名会牵动 9 个调用点与 E2E），只在注释里写清职责；等到 P4-03 全部接完再统一命名。
4. **`src/hooks/` 目录**由本次新建，是否同意。

## 7. 不做的事（明确排除）

- 不重写浮层几何、不动 12px 边距与翻转逻辑。
- 不改保存协议、不改 `NativeApi`、不新增 Tauri Command。
- 不处理磁盘草稿恢复、崩溃恢复未提交编辑、只读安全模式（规格 §1.2 明确不在本阶段）。
- 不碰 M3 那条 flaky 滚动用例（属 P4-04）。
