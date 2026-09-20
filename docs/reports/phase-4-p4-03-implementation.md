# 阶段 4 P4-03 实施记录：剩余编辑面接入浮层宿主与编辑会话

版本：1.0；完成日期：2026-09-20；状态：**已实施并通过验证**。
对应工作包：P4-03（`docs/specs/0005-phase-4-daily-workflow-and-reliability.md` §10）。
前置事实：[P4-02 实施记录](phase-4-p4-02-implementation.md)（建立了宿主与编辑会话）、[P4-01 基线](phase-4-p4-01-baseline.md)。

## 1. 范围

P4-02 只把「编辑任务」与「里程碑」接上了编辑会话（规格 §10 依赖链里的先行样本）。P4-03 把余下的编辑面全部接入，使规格 §4.2 契约与 §4.3 状态转换对整个应用成立，而不是只对两个样本成立。

同时补齐规格 §4.3 最后一条前未处理项：**输入法组合期的 Enter／Escape**。

## 2. 交付清单

### 2.1 新增组件（均在 `src/App.tsx` 内）

| 组件 | 取代 | 说明 |
| --- | --- | --- |
| `TimeBlockEditor` | `添加时间块` 的内联表单 | 原来 5 个本地 state（标题／日期／起止／busy／error） |
| `HabitEditor` | `新建重复习惯` 的内联表单 | 含「每周选择」星期字段集 |
| `DefaultTimeSlotEditor` | `编辑默认时段` 的内联表单 | 偏好写入仍走 `onChange`，不引入新保存协议 |
| （`SessionEditPopover` 改造） | 精确时间气泡 | 改为草稿驱动，新增共享 `clockDuration` |
| （`ProjectsPage` 改造） | 新建项目／导入面板 | 9 个散落 state 收敛为一个 `ProjectImportDraft` ＋ 会话 |

### 2.2 修改的共享层

| 文件 | 改动 |
| --- | --- |
| `src/hooks/useEditorSession.ts` | 新增 `registerInRegistry` 选项（默认 `true`）；在 `onClose` 上写清「成功时不负责关闭面板」这一契约 |
| `src/components/ui/overlay-host.tsx` | 顶层键盘仲裁增加输入法组合分支（规格 §4.3） |

## 3. 两个必须写下来的契约

这两条都不是新功能，而是 P4-02 只存在于写法里、没写下来的约定。P4-03 期间第一条真的把人绊倒了，因此补进代码文档。

### 3.1 成功时的关闭由调用方的 `onSave` 包装负责

`useEditorSession` 在成功时调用 `onClose("saved")`，但**它不负责关闭面板**：调用方要在 `await onSave(...)` 之后再 `setX(null)`，失败则保持打开以显示错误。所以标准写法是

```ts
onClose: (reason) => { if (reason !== "saved") onCancel(); }
```

若反过来让 `onClose` 也去关闭，保存成功后模态会**留在原地**：`.app-shell` 仍是 `inert`，后续点击会被吞掉。P4-03 初期正是这样写，导致「创建习惯后点不到『安排今天』」的用例失败。

### 3.2 常驻会话必须退出活动会话注册表

规格 §4.1 把「导入流程取消保留按模式草稿」定为**显式例外**，因此导入的草稿不能随面板卸载而消失 —— 会话只能放在 `ProjectsPage`（常驻挂载），而不是面板内部。

代价是：面板关闭后会话仍在，草稿仍是 dirty，`hasUncommittedEditorDraft()` 会把一个「记住的草稿」误判成「正在编辑未提交」，从而拦住恢复备份。因此新增 `registerInRegistry: false`，并把理由写在选项文档里。

## 4. 输入法（规格 §4.3）

放在宿主而不是每个表单，是因为宿主本就独占顶层的 Esc／Tab 仲裁，输入法规则属同一层职责：

- 组合期间 `Enter` 只用于确认候选，**必须拦下默认动作**（否则会走浏览器的隐式表单提交）；
- 组合期间 `Escape` 属于输入法（取消候选），**不能关掉编辑器**。

两者都以 `event.isComposing`（`keyCode === 229` 为旧浏览器兜底）为条件，因此 textarea 里正常换行的 Enter、以及组合结束后的普通 Escape 都保持原语义。

## 5. 一处刻意的行为变化

导入面板**创建成功后清空整份草稿**，而原来的 `closeForm()` 只清当前模式并保留其它模式已输入的标题。

判断依据：规格 §4.1 点名的例外只有「取消保留草稿」；一次创建完成即该事务结束。取消路径的行为完全保持（E2E 与新增组件用例都锁定）。这一变化已在此记录，未在别处暗示为等价重构。

## 6. 验证

| 项目 | 结果 |
| --- | --- |
| `tsc --noEmit` | 通过 |
| Vitest | **147 passed / 13 files** |
| Rust（`cargo test --all-targets`） | **37 passed** |
| E2E（Playwright，`--workers=1`） | **24 passed** |

新增用例：

- `overlay-semantics.test.tsx`：组合期间 Enter 被拦、Escape 不关面板、组合结束后恢复原语义。**已验证禁用守卫时该用例会失败**（`expected false to be true`），不是空跑。
- `App.test.tsx`：导入连点只发一次请求、失败保留草稿且取消在提交中禁用；取消面板后各模式草稿分别保留且互不串味。

定位器面：所有 `FloatingPanel` 标签、字段标签与 `role` 均未改动，既有 Vitest 与 Playwright 的 `getByRole`／`getByLabel` 全部继续命中。

**未新增 E2E 用例**，理由：本轮接入没有改变任何跨页持久化或定位器面，既有 24 条 E2E（含 `gui-optimization.spec.ts` 的「取消保留导入草稿且模式互不串味」与「项目内添加任务」）已覆盖这些流程并全部通过；输入法组合按规格 §11 的验收矩阵归「组件＋桌面键盘」层，Playwright 也无法可靠合成组合事件。真实桌面键盘与输入法仍需 P4-10 的实机验收。

## 7. 未做与边界

- 「添加项目任务」在 P4-02 已通过 `TaskEditorFields` 接入（父级 `onUpdate` 包装负责关闭），P4-03 未改动。
- 「空白时段操作」的区间内联表单是动作气泡**同一面板内的子步骤**（规格 §4.1 允许），不另起编辑会话。
- `FloatingPanel` 仍未改名（等全部接入完成后统一命名，见 P4-02 §6）。
- 确认模态（继续安排／排程／结束本次／恢复备份）走 `ConfirmDialog` ＋ 宿主，不使用编辑会话，因为它们没有「草稿」语义。
- 规格 §5.2 描述的完整 `useCalendarViewport` 滚动仲裁仍属 P4-04；P4-03 未触碰滚动。
