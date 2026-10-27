# 日历整改 C3 实施记录：区分「现在的时间」与「任务进度」

> 对应开工提示：[`calendar-c3-kickoff-prompt.md`](calendar-c3-kickoff-prompt.md)。决策依据 **D14**（评估 §6）：双层条 + 剩余时间。纯呈现改动：**未碰数据模型（`task.progress`、session 时间字段）、未碰 `sessionContains` 判定、未碰拖拽状态机、未碰布局骨架与密度定标（84/168/216 与字号随档原样）**。C1／C2 的未提交修改保留在工作区。

## 1. 结果摘要

| 判据 | 改前 | 改后 |
| --- | --- | --- |
| 进行中卡的两条 bar | 同位同宽同形态、仅靠颜色分（accent 2px 内缩胶囊 vs success 2px 圆角条，都在卡底） | **卡顶满宽平头帽 = 任务进度（success）／卡底内缩圆角胶囊 = 时间已进行（accent）**，位置、宽度、形态三重分离 |
| 「剩余 X 分钟」文字 | 无 | 进行中的卡按档放出（standard/detailed 第 5 行档；compact 只留双层条不出文字） |
| 无障碍 | 两条仅 `aria-label`，无百分比读法 | 各带 `aria-label` + `aria-valuetext` + `title`（「时间已进行 50%」「任务进度 35%」句式）；剩余文字为正文节点，读屏可见 |
| now 线 | 2px **虚线** | 2px **实线**（accent-strong），端点圆点与时间胶囊不动 |
| past-region | muted 8%→2% | muted **18%→5%**（加深；卡片不透明且压在遮罩之上，正文对比度不受影响，读数见 §5） |
| `residuals.mjs` 四场景溢出卡／轴裁切 | 0／0 | **0／0**（不退化；周 200% 的 21 条横溢为 A6 既有接受项，逐字未变） |
| `npm run check` | — | 四步全绿：Vitest **428/29 文件**、Playwright **63/63**、Rust **48/48**（[`check.log`](../../output/2026-10-27_calendar-c3/check.log)） |

## 2. 双层条的最终几何

| 元素 | 类名 | 定位 | 高度（compact／standard／detailed） | 颜色 token | 形态 |
| --- | --- | --- | --- | --- | --- |
| 任务进度（所有非月视图卡） | `.session-task-progress` | `position: absolute; top: 0; inset-inline: 0`（padding box 满宽，被卡片 10px 圆角与 `overflow: hidden` 裁切） | 2／3／4px | 填充 `--success`，轨道 `color-mix(--muted 22%)` | 平头满宽帽 |
| 时间已进行（仅进行中的卡） | `.session-elapsed` | `position: absolute; inset-inline: .375rem; bottom: .4375rem`（compact：`.25rem`／`.0625rem`，贴 24px 最小卡的底缘） | 2px（全档） | 填充 `--accent-strong`，轨道同上 | 内缩圆角胶囊（999px） |

- 两条都是绝对定位：`z-index: 2`，压在卡片背景之上、状态角标（z3）与编辑铅笔（z2、DOM 更后）之下；**不再进文档流**——这推翻 A6／F20④「进度条进流紧跟最后一行」的口径，高卡底部留白回到「卡高 = 时长」的纯几何（A6 §8.5 已把那种留白定性为时长几何，D14 的分离优先级更高）。释放出的 4px 流内高度让所有裁切判据只松不紧。
- 紧凑档从「什么都不画」改为「只画双层条、不出文字」——任务书允许项（「compact 允许只保留双层条不出文字」），并让六格矩阵的 compact 格有可核对的内容。
- 拖拽护栏不变：`.session-task-progress`／`.session-elapsed` 仍在卡片 `onPointerDown` 的 `closest()` 排除列表里（UI-SPEC「进度条只执行自身操作」）。

## 3. 「剩余 X 分钟」与按档断点

- 计算：`remainingMinutes = ceil((end − now) / 60s)`，仅 `sessionContains(session, now)` 为真时渲染 `<span className="session-remaining">`；<60 分 → 「剩余 X 分钟」，≥60 → 「剩余 X 小时 Y 分」（整小时省略「Y 分」）。DOM 序：meta 行之后、时间胶囊之前；`title` 写完整口径（「本时段共 N 分钟，还剩 M 分钟」）。
- 显隐沿用 A5 的行预算法（第 5 行档 = 5 × 行单位 + 2px，条件里只有 rem 字面量）：日 standard `6.875rem`、日 detailed `8.125rem`（与「待回顾」摘要共用档位——两态互斥）、周 standard `6.25rem`、周 detailed `6.875rem`。这四个值都落在 UI-SPEC 既有五档阶梯的空位上，阶梯表不用改。
- 宽度口径：并入既有 `@container (max-width: 112px)` 逐级隐藏组（与项目行／进度值同档），周 960（111px 列）与周 200%（74px 列）不出文字，双层条仍在。
- 颜色 `--muted-strong`（不是 `--muted`）：见 §5 对比度。

## 4. 页面级现在时刻

- `.calendar-now-line::before`：`border-top: 2px dashed` → `2px solid var(--accent-strong)`；端点 10px 圆点与左上时间胶囊一字未动。
- `.calendar-past-region`：`linear-gradient(180deg, --muted 8% → 2%)` → `18% → 5%`；`z-index: 0`、`pointer-events: none` 不变——执行卡（z≥2）与时间块本来就画在遮罩之上且背景不透明，**加深只作用于轨道空白处**，卡片正文对比度与加深前逐字节相同（§5 实测）。
- 周视图今天列同路径生效（同一 `CalendarDay` 渲染，探针六格矩阵每格都量到实线 + 遮罩）；月视图按任务书不加。

## 5. 对比度读数（canvas 光栅化取真 sRGB，`c3-measurements.json`）

浅色主题（卡底 = `color-mix(--accent-soft 78%, --panel)`）：

| 项 | 读数 | 门槛 | 判定 |
| --- | --- | --- | --- |
| 卡标题（`--text`） | **13.7** | 4.5 | ✓ |
| 起止时间／状态行（`--muted`） | **4.5** | 4.5 | ✓（既有基线，恰在门槛） |
| 剩余时间文字（`--muted-strong`） | **6.7** | 4.5 | ✓ |
| accent 时间胶囊填充 vs 卡底 | **5.1** | 3（非文本） | ✓ |
| success 进度帽填充 vs 卡底 | **4.8** | 3 | ✓ |
| 未填充轨道 vs 卡底 | 1.3 | —（装饰） | 如实记录 |
| **past-region 内卡片**标题／时间 | **13.7／4.5**（与区域外同值） | 4.5 | ✓ 遮罩在卡下，加深不吃正文 |
| 遮罩上沿／下沿 vs 轨道底 | 1.3／1.1（改前 1.1／1.0） | —（氛围层） | 加深可见 |

深色主题：标题 11.2、时间 6.4、剩余 7.8、accent 条 7.4、success 帽 6.9、遮罩台阶 1.5／1.1（改前 1.2／1.0）。全部 ≥4.5（文字）／≥3（图形）。

## 6. 测试

- `App.test.tsx` 新增 2 条：①进行中的卡同时有 `.session-elapsed` + `.session-task-progress`（不同类名，位置分离由 CSS 承担、jsdom 只钉 DOM 契约）+「剩余 30 分钟」文字 + 两个可访问名各一；未开始的卡只有进度帽。②≥60 分钟折式「剩余 1 小时 30 分」。既有「shows the current time…」用例的两条 `progressbar` 断言改名为「时间已进行／任务进度」并加断「剩余 1 小时」——**未删任何断言**。
- `e2e/phase1.spec.ts` 新增 1 条「phase C3 …」：真实布局量两 bar 的 boundingBox（帽贴卡顶、胶囊贴卡底、相距 > 半卡高；帽宽 > 胶囊宽 + 8px）、剩余文字按档显隐（standard 显示 → 点「紧凑」隐藏但双层条仍可见 → 点「详细」恢复）、未开始卡只有帽、`::before` 计算值 `border-top-style: solid`。
- 回归：Vitest **428/428**（29 文件）、Playwright **63/63**、Rust **48/48**、`npm run check` 四步全绿；`residuals.mjs` 四场景溢出卡 0、轴裁切 0、日横溢 0、药丸 4.89、吸顶 44/88/88 全部与 A6 收口态一致。
- **既有竞态修复（超出本包改动面，如实记录）**：C3 全量首跑里 phase 3 M6 的「日期头 PageDown 移焦」断言 1/4 红。根因与 C3 无关（该夹具没有任何执行时段，C3 的卡片 DOM 改动不在路径上）：浮层宿主的焦点归还走 `requestAnimationFrame` 延迟一帧（`overlay-host.tsx:123`），Escape 后用例立刻 `header.focus()`，归还晚到一步把焦点抢回时间光标，PageDown 于是落错处理器。修法是在 Escape 后等两帧再继续（`e2e/phase1.spec.ts`，注释写明根因），复跑 `--repeat-each=4` 全绿。

## 7. 截图与逐张检查

证据目录 `output/2026-10-27_calendar-c3/`，全部 headless（Chromium，`deviceScaleFactor: 1`；200% 为应用内根字号缩放），单 browser、固定时钟 `2026-08-05T12:00`、`finally` 清理。逐张核对的是：双层条位置/宽度/形态分离、剩余文字按档取舍、卡片正文不被遮罩吃掉、实线 now 线。审美留给用户。

| 截图 | 场景 | 结论 |
| --- | --- | --- |
| `crop-matrix-day-{compact,standard,detailed}.png` | 日 × 三档（1200×800@100%） | compact：只有双层条无文字；standard/detailed：卡顶绿帽 + 「剩余 1 小时」+ 卡底橙胶囊；30 分钟并行卡（剩 15 分钟）在第 5 行档放不下 → 文字不出，符合按档取舍 |
| `crop-matrix-week-{compact,standard,detailed}.png` | 周 × 三档 | 全宽列道下 standard/detailed 出文字；compact 只双层条 |
| `crop-matrix-day-standard-200.png`／`crop-matrix-week-standard-200.png` | 200% | 日：28px 正文 + 剩余行仍放出；周：74px 窄列按 ≤112px 宽度规则收文字、双层条保留 |
| `region-day-standard-{before,after}.png`（+ `-dark` 两张） | past-region 前后对照（同页 `addStyleTag` 回退旧值） | 加深可辨（台阶 1.1/1.0 → 1.3/1.1），卡正文数值不变；now 线虚→实一目了然；深色同结论（1.2/1.0 → 1.5/1.1） |
| `matrix-*.png` 全页 8 张 | 各场景全景 | 无新增溢出/裁切/重叠 |

> headless 限制：Chromium headless 用 overlay 滚动条，`::-webkit-scrollbar` 不绘制——本包不改滚动条，不涉及该例外。未开 headed 浏览器。

## 8. 未收口项与边界

1. **12:00 时间胶囊（z8）压在进行中的卡中部**：now 线穿过卡片时胶囊盖住某一行（截图中盖「当前安排」/项目行）——虚线时代同款既有行为，不在本包口径，另立后续项。
2. **resize 握线与时间胶囊同区**：卡底 3–5px 的 24px 握线（accent-strong）与胶囊（7–9px）上下相邻、同色系——既有几何，胶囊位置按任务书「保持卡底部」未动。
3. **日 standard ≤45 分钟的卡不出剩余文字**（第 5 行档 112px 门槛）：与 A5「放得下才显示」一致；小时数大的档自动显形。
4. **紧凑档开始画双层条**：推翻 A5「紧凑档不画进度」口径、按 D14 允许项执行；UI-SPEC 已同步。若用户实测嫌 24px 卡太挤，回退只需把显隐规则改回 `:not([data-calendar-zoom="compact"])`。
5. 月视图 now 线／遮罩未加（任务书明确）；F13 月视图密度仍是后续包。
6. 未 `git commit`；C1／C2 与用户的未提交修改原样保留。

## 9. 回退方法

无数据模型、迁移、设置字段改动，回退只涉及四处源码（**不要** `git checkout` 整文件——C1／C2 的未提交修改也在这些文件里）：

```powershell
git diff -- src/App.tsx src/styles.css src/App.test.tsx e2e/phase1.spec.ts
```

- `src/App.tsx`：`remainingMinutes`/`remainingLabel` 与 `.session-remaining` 渲染；两条 bar 的 `aria-label`/`aria-valuetext`/`title` 文案。
- `src/styles.css`：`.session-task-progress` 卡顶帽与 compact 显隐规则、`.session-elapsed` compact 贴边、`.session-remaining` 基础隐藏 + 四个高度断点 + 112px 宽度规则、`.calendar-now-line::before` solid、`.calendar-past-region` 18%→5%。
- `src/App.test.tsx`：2 条新用例 + 改名断言；`e2e/phase1.spec.ts`：「phase C3」用例，以及 M6 的「Escape 后等两帧」稳定化（去掉它 M6 会回到 1/4 红的既有竞态，属修复而非本包回退项）。

回退后重跑 `npm run check` 与 `residuals.mjs` 应回到 C2 树基线（两 bar 同位、虚线、8%→2%）。

## 10. 文档同步

- `docs/design/UI-SPEC.md`：三档内容清单里的进度条句改写为卡顶帽口径；「当前安排」条目改写为双层条语义 + 剩余文字 + 无障碍句式；今天时间轴条目改写为实线 + 加深遮罩。五档 rem 阶梯表未动（新断点全部落在既有空位）。
- `docs/PROJECT-GUIDE.md`：§5 的 `App.tsx`／`styles.css` 两行补 C3；§11 测试库存补 C3 计数。

## 11. 证据清单

`output/2026-10-27_calendar-c3/`：`probe-c3.mjs`／`c3-measurements.json`（六格矩阵 + 前后对照 + 对比度读数量测脚本与结果）、`residuals.log`（A6 脚本在最终树复跑）、`check.log`（四步全量）、24 张 PNG（12 全页 + 12 近景）。量测均为生产构建 + `vite preview`、固定时钟 `2026-08-05T12:00:00`、只写 localStorage、headless、单 browser、`finally` 关闭。
