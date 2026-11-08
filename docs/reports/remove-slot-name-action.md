# 移除「可用时间」空闲块名称 — Agent 行动文档

> 生成时间：2026-11-08。目标仓库：`Daymark`（本文件所在工作树）。
> 本任务为**产品行为变更**（设置 → 可用时间 → 编辑 的 A3 设计器）。执行前先读 `docs/PROJECT-GUIDE.md`（AGENTS.md 要求），再按本文档执行。

---

## 0. 预检（必须做）

1. `git status` 确认工作树状态。**当前工作树有一批用户未提交改动**（`src/App.tsx`、`src/App.test.tsx`、`src/lib/availability.ts`、`src/lib/settings.ts`、`src/styles.css`、`e2e/gui-optimization.spec.ts`、`docs/PROJECT-GUIDE.md`、`docs/design/UI-SPEC.md` 等）。**不得回退、覆盖、rebase 或清理这些改动**；本文档的行号以当前工作树为准，执行时以符号名／文本内容定位，行号漂移就重找。
2. 通读 `docs/PROJECT-GUIDE.md` 的「文档同步协议」与 §「修改设置 / 修改弹窗交互」条目（弹窗交互改动要同时看 `AvailabilityDialog`／`AvailabilityDesigner`、`AppShell.saveAvailability`、`App.test.tsx` 的 A3 用例与 `e2e/gui-optimization.spec.ts` 的两级浮层几何）。

## 1. 目标（用户已拍板）

1. **空闲块上去掉名称，只显示时间**（如 `19:00–22:00`）。
2. **「编辑可用时间」气泡里的「名称」输入框一并移除**——名称已无任何显示位，输入框没有存在意义。
3. **牵连的显示位一起去掉**：日历日视图「可用时间」模式下默认窗口带子上的名称文字、死 CSS。
4. **数据字段 `DefaultTimeSlot.label` 保留不动**（见 §4 红线）。旧数据里的名称留在库里成为惰性字符串，不做迁移、不清理。

## 2. 现状事实（已核查）

「设置 → 可用时间 → 编辑」打开的是「可用时间」A3 弹窗（`AvailabilityDialog` + `AvailabilityDesigner`）。名称相关的全部面：

| # | 位置 | 现状 | 处置 |
|---|------|------|------|
| 1 | `src/App.tsx` ~4206 `const name = block.label && …` | 块内名称取值 | 删 |
| 2 | `src/App.tsx` ~4218 `{name && px >= AVAILABILITY_COMPACT_PX && <span className="availability-slot-name">…}` | 块内名称显示（唯一被删的可见文字） | 删 |
| 3 | `src/App.tsx` `AvailabilitySlotEditor`（~2687–2713）：`label` state（~2690）、`onSave` 里的 `label: label.trim() || "可用时间"`（~2698）、`<label>名称<input/></label>`（~2701） | 编辑气泡的名称输入框 | 删 |
| 4 | `src/App.tsx` ~4220 铅笔按钮 `title="编辑名称、时间与星期"` | 悬停提示含"名称" | 改为 `"编辑时间与星期"` |
| 5 | `src/App.tsx` ~2200 `<div className="default-slot"><span>{slot.label}</span></div>` | 日视图「可用时间」默认窗口带子上写名称 | 删内部 `<span>`，**保留 `<div>` 本体** |
| 6 | `src/styles.css` ~1356 `.availability-slot-name` | 死样式 | 删 |
| 7 | `src/styles.css` ~931 `.default-slot span` | 随 #5 变死样式 | 删 |
| 8 | 注释：`App.tsx` ~2682/2684/2694（编辑器 docstring）、~4259（"名称与起止一起改"） | 提到名称 | 按新事实改写 |

已核查**不含**名称、无需改动的面（别顺手动）：

- 块的 `aria-label`/`title`（`App.tsx` ~4205：`周X 19:00–22:00 空闲`）本来就不含名称，测试全部依赖它。
- 帮助气泡「操作说明」（`App.tsx` ~3932 两组八条）无名称字样。
- 灰色折叠带（`X 小时已折叠`／`含 N 段空闲`）不属于空闲块，**本次不动**。
- `is-compact`／`can-stack` 两个 class 在 CSS 与测试里零引用（`is-tiny` 有 CSS：小字号 + 隐手柄，必须留）。可选清理见 §3.6。

牵连测试面（已核查）：

- `src/App.test.tsx` ~2100–2114 `edits the window name and weekdays from the block pencil` ——**唯一**触碰名称输入的用例，必须重写（§5.1）。
- `e2e/gui-optimization.spec.ts` ~21–22 注释提到"名称／起止／星期"，仅注释，改注释即可；断言（点铅笔、验几何）不受影响。
- `e2e/phase1.spec.ts` ~3352 用 `.default-slot` 元素做滚动几何定位，只依赖 `<div>` 存在——#5 删 span 不影响它。
- 其余出现 `晚间专注`／`晨间` 等 label 的测试全是夹具数据或数据断言（`objectContaining({ label: … })`），不是显示断言，不动。

## 3. 改动清单（按序执行）

### 3.1 `src/App.tsx` — `AvailabilityDesigner` 块内名称（表格 #1、#2）

删掉：
```tsx
const name = block.label && block.label !== "可用时间" ? block.label : "";
```
删掉（含其前置条件）：
```tsx
{name && px >= AVAILABILITY_COMPACT_PX && <span className="availability-slot-name" title={name}>{name}</span>}
```
时间行 `<span className="availability-slot-time">…` **原样保留**。

### 3.2 `src/App.tsx` — `AvailabilitySlotEditor` 去掉名称输入（表格 #3、#8）

- 删 `const [label, setLabel] = useState(slot.label);`
- `onSave` 改为保留原 label 往返：`onSave({ ...slot, start, end, weekdays: [...weekdays].sort((l, r) => l - r) })`（去掉 `label: label.trim() || "可用时间"` —— `slot` prop 本身就带原 label，见调用处 ~4255 的 `label: slots.find(…)?.label ?? "可用时间"`，**该行不动**）。
- 删 `<label>名称<input …/></label>`。
- 改写 docstring（~2681–2685）与行内注释（~2694）：编辑气泡只改**起止与适用星期**，不再有名称字段；原注释里"名称可以留空、空名回落成「可用时间」"的说法随字段一起删。
- `App.tsx` ~4259 注释"名称与起止一起改"改为"起止一起改"之类，按新事实。
- ~4264 的 `renamed` 链（`{ ...slot, label: next.label, … }`）**不动**——`next.label` 现在就是原 label 的往返，写回无害；动它反而扩面。

### 3.3 `src/App.tsx` — 铅笔提示语（表格 #4）

`title="编辑名称、时间与星期"` → `title="编辑时间与星期"`。

### 3.4 `src/App.tsx` — 日视图默认窗口带子（表格 #5）

```tsx
// 之前
<div key={slot.id} className="default-slot" style={style}><span>{slot.label}</span></div>
// 之后（div 保留：e2e 几何与"可用时间区域"视觉依赖它）
<div key={slot.id} className="default-slot" style={style} />
```

### 3.5 `src/styles.css` — 死样式（表格 #6、#7）

删 `.availability-slot-name { … }`（~1356）与 `.default-slot span { … }`（~931）。`.default-slot` 本体（~930）保留。

### 3.6 可选清理（允许跳过）

`App.tsx` ~4204 的 class 三元里 `is-compact`／`can-stack` 在删掉名称后无任何 CSS／测试引用，可精简为只保留 `is-tiny` 与 `is-selected` 的判定；若想最小 diff，保持原表达式也完全无害。二选一，别做第三种。

## 4. 红线（不许动）

1. **`DefaultTimeSlot.label` 数据字段全链路保留**：`src/lib/settings.ts` 的类型（`interface DefaultTimeSlot`）、`normalizeTimeSlots` 的校验、`DEFAULT_SETTINGS.defaultTimeSlots`（`label: "晚间专注"`）；`src/lib/availability.ts` 的 `addAvailability`（新块 label "可用时间"）、快速预设、**`mergeAvailability` 的合并键**（同起止不同名不并段）、`replaceAvailability` 的 label 原样写回。名称从此只是内部合并键，不再显示、不再可编辑。
2. 不做数据迁移、不清理存量 label、不改 `foldedRanges` 相关任何东西。
3. 块的 `aria-label`/`title`（`周X … 空闲`）、`role="group"`、`aria-selected`、对话框名「编辑可用时间」、「可用时间」弹窗标题全部不变——绝大多数测试与 e2e 靠它们定位。
4. 灰色折叠带、帮助气泡、日视图折叠逻辑（`availabilityFolds` 等）不动。
5. 保留用户未提交改动（§0.1）。

## 5. 测试同步

### 5.1 重写 `src/App.test.tsx` ~2100–2114

原用例清空名称输入后断言 label 回落 `"可用时间"` ——名称输入没了，该用例改成一个**真实的时间／星期编辑**往返，并把"无名称输入"钉成回归：

```tsx
it("edits the window time and weekdays from the block pencil without a name field", async () => {
  const user = userEvent.setup(); const backend = new MemorySettingsBackend();
  render(<App settings={new SettingsRepository(backend)} native={createNativeApi()} />);
  await openAvailability(user);
  stubTrack(360);
  await user.click(screen.getByRole("button", { name: "编辑 周一 19:00–22:00" }));
  const edit = screen.getByRole("dialog", { name: "编辑可用时间" });
  // 名称输入随名称显示一并移除。
  expect(within(edit).queryByLabelText("名称")).toBeNull();
  // ……在这里改结束时间（TimeField）或勾掉一个星期，点「保存」……
  await user.click(within(edit).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑可用时间" })).toBeNull());
  await user.click(screen.getByRole("button", { name: "完成" }));
  await waitFor(() => expect(slotsOf(backend)).toContainEqual(
    expect.objectContaining({ start: "19:00", end: "<改后的结束>", weekdays: [<改后的星期>] })));
  // label 不被编辑器改写：原值原样往返。
  expect(slotsOf(backend)).toContainEqual(expect.objectContaining({ label: "晚间专注" }));
});
```

要点：时间改法沿用同文件既有 `chooseTime`／`TimeField` 交互；断言里的 label 用**夹具原值**（`DEFAULT_SETTINGS` 是 `"晚间专注"`），证明编辑器不再碰 label。改动后用例名可自拟，但"无名称输入"的断言必须留。

### 5.2 可选回归（建议加一条，成本低）

在 A3 用例区（`openAvailability` 同组）加：默认夹具的 label 是自定义名（`晚间专注`），断言设计器里 `screen.queryByText("晚间专注")` 为 `null`、块内只有时间文本——把"块上不显示名称"钉死。

### 5.3 其他

- `e2e/gui-optimization.spec.ts` ~21–22 注释"（名称／起止／星期）"→"（起止／星期）"。断言不改。
- 其余测试（availability.test.ts / settings.test.ts / calendarTimeline.test.ts / scheduling.test.ts / useCalendarViewport.test.tsx）全在数据层，**不受影响，不要动**。

## 6. 文档对齐（与代码同一批提交改）

1. `docs/design/UI-SPEC.md` ~441 末句"块高 <26px 只写时间、<40px 一行，再高才允许「名称 + 时间」两行。"→ 改为块内**只写时间**的表述（名称已随字段移除）。
2. `docs/PROJECT-GUIDE.md` ~44"块上铅笔是这条窗口唯一的完整编辑入口（名称／起止／适用星期，**名称可以留空**，空名回落成「可用时间」）"→"（起止／适用星期）"。
3. `docs/PROJECT-GUIDE.md` ~57"设置页可编辑零个或多个可用时间（名称、起止时间、适用星期）"→ 去掉"名称、"。
4. `docs/PROJECT-GUIDE.md` ~373 `defaultTimeSlots` 条目里两处"名称"字句去掉；该条对旧 7×24 网格的描述已经过时，本次只修名称相关字句，其余陈旧处不扩面重写。
5. `docs/PROJECT-GUIDE.md` ~456 的历史测试记录（"块内两行＝窗口名＋压缩时间"）是**带日期的既成记录，不改写**。若走"需要更新文档了"的完整文档同步协议，另行处理。
6. `src/App.tsx` 内注释见 §3.2。

## 7. 验证（全部通过才算完）

> 环境坑（PROJECT-GUIDE 实录）：**Vitest 必须在 PowerShell/cmd 跑，Git Bash 里会全红**（盘符大小写导致 runner 双载）；`tsc --noEmit` 偶发 `bcrypt.dll` panic 属瞬时 DLL 占用，原命令重试一次即可。

1. `npx tsc --noEmit`
2. `npx vitest run`（重点：A3 十条、重写后的铅笔编辑用例）
3. `node scripts/run-e2e.mjs --workers=1 e2e/gui-optimization.spec.ts e2e/phase1.spec.ts`
4. 视觉证据（AGENTS.md 浏览器规则：默认 headless、单会话、`finally` 清理）：用 `scripts/visual-evidence.mjs` 或一次性探针把 **设置 → 可用时间弹窗**（含悬停块出铅笔）与 **日视图「可用时间」模式的带子** 截进 `output/<YYYY-MM-DD>_remove-slot-name/`，覆盖 960×640 与 200% 缩放、浅／深两色；**逐张打开图检查** UI-SPEC：4px 间距栅格、12–28px 字号、文字不裁切不重叠、命中区 ≥44px、对比度 ≥4.5:1。截图证明版式，审美留给用户。
5. 收尾核查：`Get-Process chrome,msedge,node -ErrorAction SilentlyContinue`；`Get-NetTCPConnection -State Listen | Where-Object LocalPort -in 1420,4174,4175,4176,4177`——不留任何后台进程／服务器。

## 8. 验收标准

- [ ] 空闲块上只有 `HH:MM–HH:MM`（加悬停铅笔／× 图标），任何缩放高度都不出现名称。
- [ ] 「编辑可用时间」气泡只有开始／结束／适用星期 + 取消／保存；`queryByLabelText("名称")` 为 null。
- [ ] 日视图「可用时间」带子是纯色区域，不写任何文字。
- [ ] 新增块（悬停「＋」）存 `label: "可用时间"`、旧 label 原样保留、相邻段合并行为与改前一致。
- [ ] `npx tsc --noEmit`、`npx vitest run`、指定 e2e 全绿。
- [ ] 文档 §6 三处字句与代码一致。
- [ ] 用户未提交改动原样在；无 commit（用户没要求就不提交）。
