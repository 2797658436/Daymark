# 阶段 4 P4-12 实施记录：实际记录叠加层的文字对比度

> 工作包：`docs/reports/phase-4-open-decisions.md` §7.2 拍板单开的 **P4-12**（提示词 `docs/reports/phase-4-p4-12-kickoff-prompt.md`）。  
> 来源缺陷：P4-11 探针发现的既有问题，完整描述与实测数值在 [`phase-4-p4-11-implementation.md`](phase-4-p4-11-implementation.md) §7.1。  
> 顺序依据：**在 P4-10（原生验收与发布）之前**完成 —— 顺序是 `P4-12 → P4-10`，发布包才含修复。

---

## 1. 范围与交付清单

### 1.1 修改的代码

| 文件 | 改动 |
| --- | --- |
| `src/styles.css` | 新增一个**只给这个叠加层用**的前景色 token `--actual-record-text`（`:root` 里声明一次，`[data-theme="dark"]` **故意不覆盖**）；`.calendar-actual-record` 的 `color` 由 `var(--action-text)` 改为 `var(--actual-record-text)`。全局 token（`--action`／`--action-hover`／`--action-text`／`--accent`）的值**一个都没动**。 |

### 1.2 修改与新增的测试

| 文件 | 改动 |
| --- | --- |
| `e2e/phase1.spec.ts` | **新增** 1 条用例 `phase 4 M12 keeps the calendar page clean with the actual-record overlay`（夹具 `calendarActualRecordWorkspace()`：在 P4-11 的富夹具上加一条已结束的 `executionRecords`，并**显式开启**「显示实际记录」）。同时把 P4-11 那条用例里「不开启实际记录」的注释改成指向本包。 |
| `scripts/visual-evidence.mjs` | 新增 `actualRecordWorkspace()`、`frameActualRecord()`、`capture()` 的 `crop` 选项，以及 2 个场景（浅／深各一张全页 + 一张叠加层近景）。 |

**没有**新增依赖、没有新增 SQLite 迁移或字段（schema 仍 v7）、没有新增 Tauri Command、没有改统计口径、没有改 D1–D6 与 P4-07／P4-08／P4-11 的结论、没有碰 `src-tauri/`。

---

## 2. 缺陷与修法

### 2.1 缺陷

浅色主题 + 开启「显示实际记录」时，叠加层把 `color: var(--action-text)` 用在一个**被稀释过的**底上：

```css
.calendar-actual-record {
  background: color-mix(in srgb, var(--accent) 82%, var(--panel));
  color: var(--action-text);            /* ← 错在这里 */
}
```

`--action-text` 是给**实色** `--action` 按钮配的（浅色下是白字）。82% 的 accent 与浅色面板混出来的底是 `#da845e`，白字压不住。**这不是「颜色没挑好」，是设计 token 配错了对象。**

### 2.2 选定的修法：方案 A（专用前景 token，两主题都取深色）

| 方案 | 结论 |
| --- | --- |
| **A 文字改深** | **选它** —— 见下 |
| B 底色换成实色 `var(--action)` | 不选。视觉会从「半透明橙」变成「实心砖红」，是明显的观感变化 |
| C 提高混色比例 | 不选。「调到多少才够」随 `--accent` 变化而漂移，脆 |

**为什么是 A：**

1. **改动最小、保住现有观感。** 半透明橙的底一个像素没动，只换了字色 —— 视觉证据可以逐字节证明「只有该变的地方变了」（§5）。
2. **深色主题本来就用深字、本来就达标。** 它的 `--action-text` 就是 `#23150d`，所以把新 token 取成同一个值，**深色主题的渲染结果一个像素都不变**（§5 实测：深色 4 张图逐字节相同）。
3. **「两主题都取深色」不奇怪，因为底在两主题下都是中间调的橙。** 浅色混出 `#da845e`、深色混出 `#cb794e` —— 亮度接近，需要的字色自然也接近。反过来，白字在两主题下都**不**达标（浅 2.82、深 3.30），所以「两个主题各用各的 `--action-text`」这条路本来就走不通。

### 2.3 改动

```diff
 :root {
   --action: #a94724; --action-hover: #873718; --action-text: #ffffff;
+  /* P4-12：实际记录叠加层的专用前景。它坐在 color-mix(--accent 82%, --panel) 上 ——
+     浅／深两主题混出来的底都是**中间调的橙**（浅 #da845e / 深 #cb794e），所以两主题
+     共用同一个深色前景，深色块里**故意不覆盖**它。不能沿用 --action-text：那是给
+     **实色** --action 按钮配的（浅色下是白字），落到被稀释过的底上只有 2.82:1。 */
+  --actual-record-text: #23150d;
   …
 }
```

`.calendar-actual-record` 里 `color: var(--action-text)` → `color: var(--actual-record-text)`。三行文字（`span`「实际」／`strong` 标题／`time` 起止时间）都是 `color: inherit`，一处改动全覆盖。

### 2.4 实测对比度（改前 / 改后）

用 `getComputedStyle` 取浏览器**解析后**的颜色（`color-mix` 已被解析成 `color(srgb …)`），按 WCAG 2.x 相对亮度公式算；与 axe 自己的口径完全一致（axe 对同一个元素报的也是 2.82）。

| 主题 | 叠加层底色 | 改前前景 | 改前对比度 | 改后前景 | 改后对比度 | 门槛 |
| --- | --- | --- | --- | --- | --- | --- |
| 浅色 | `#da845e` | `#ffffff` | **2.82** ❌ | `#23150d` | **6.29** ✅ | 4.5:1 |
| 深色 | `#cb794e` | `#23150d` | **5.37** ✅ | `#23150d` | **5.37** ✅ | 4.5:1 |

- 字号 23.04px、字重 600 —— **不属于**大字号豁免（axe 判为 `font size: 17.3pt (23.04px), font weight: normal`），门槛就是 4.5:1。
- 参考：白字在深色底上是 **3.30**（也不达标），所以深色主题从来没用过白字。
- axe 原始输出：[`axe-960x200-before-scrolled.txt`](axe-960x200-before-scrolled.txt)（浅色／日视图，`2.82`，命中 `.calendar-actual-record > strong`）与 [`axe-960x200-after-scrolled.txt`](axe-960x200-after-scrolled.txt)（零违规）。

---

## 3. 验收口径：为什么「先断言元素出现」还不够

P4-09 的教训是**夹具没开「显示实际记录」**，元素不渲染，`color-contrast` 规则就不跑。本包在实现过程中发现这个坑还有**两个孪生兄弟**，所以新用例的断言写成五步：

1. 叠加层**真的渲染出来了**（夹具里必须真的有已结束的 `executionRecords`）；
2. 它**真的在屏幕上**（`toBeInViewport({ ratio: 0.9 })`，按 IntersectionObserver 算，会扣掉祖先滚动容器的裁剪）；
3. `strong` 的**实测对比度 ≥ 4.5:1**（同一套 WCAG 公式，前景 vs 叠加层底色）；
4. axe **确实评估过**叠加层（节点进过 violations／incomplete／passes／inapplicable 之一）；
5. 最后才断言整页零违规。

### 3.1 第 2 步的必要性：axe 根本不评估屏幕外的元素

`color-contrast` 只检查**已渲染且在屏幕上**的元素。元素渲染了但滚出视口时，它**连四个桶都不进** —— 不是「通过」，是「没被看过」。960×720 + 应用内缩放 200% 下日视图的可视窗口只有约 3 小时，而叠加层默认落在窗口外：

```
===== before / light / 日 =====
.calendar-actual-record 命中 1 个
axe 是否评估了 .calendar-actual-record：否（元素不在视口里，color-contrast 根本不会跑）
violation ids: （零违规）          ← 缺陷还在，却报零违规
```

完整输出：[`axe-960x200-before.txt`](axe-960x200-before.txt)。同一份代码把叠加层滚进屏幕后再跑，立刻报出 2.82（[`…-before-scrolled.txt`](axe-960x200-before-scrolled.txt)）。**这就是「夹具太穷」的第二个形态：夹具够了，但视口太窄。**

### 3.2 第 3 步的必要性：axe 说「零违规」不等于「量过了」

叠加层里的文字**经常被 axe 判成 `incomplete`**（`Element's background color could not be determined because it is overlapped by another element`）—— 既不是通过也不是违规。所以「零违规」可能是「没量」，而 `incomplete` 又不该被当成通过。直接按同一套公式算一次比值，才能**确定地**钉住报告里的那个元素。

这也是为什么夹具的记录取 **30 分钟 × 48px/小时 = 24px 高**：叠加层 ≤ 28px 时容器查询会把「实际」和时间行隐藏，只剩标题 —— 与 P4-11 §7.1 实测到 2.82 的**同一个状态**（元素、字号逐项对得上）。记录更长时标题行会被 axe 判成 `incomplete`（§6.3 会解释为什么）。

**周视图尤其需要这条**：窄列里 axe 稳定把标题判成 `incomplete`（改前改后都一样，`violations` 桶始终是空的），所以**只有实测比值**能守住它 —— 见 [`axe-960x200-before-scrolled.txt`](axe-960x200-before-scrolled.txt) 与 [`axe-960x200-after-scrolled.txt`](axe-960x200-after-scrolled.txt) 里浅色／周视图的分桶。

### 3.3 反向验证（把修复去掉，用例必须红）

`git checkout HEAD -- src/styles.css` 后重跑同一条用例：

```
Error: 浅色 · 日历（日）· 实际记录标题对比度（前景 rgb(255, 255, 255) / 底色 color(srgb 0.855294 0.517647 0.369725)）
  Expected: >= 4.5
  Received:    2.82135907086268
```

用例自己算出来的 **2.82135907086268** 与 P4-11 §7.1 记录的 **2.82** 是同一个数。日志：`.workbuddy-ai/tmp/p4-12-e2e-reverse2.log`（过程文件，未入库）。

### 3.4 月视图按设计没有叠加层

工具栏在月视图里根本不显示「显示实际记录」开关，`.calendar-actual-record` 也不会渲染。用例对月视图断言的是 **`toHaveCount(0)`** —— 把「没渲染」明确写出来，免得被误读成「达标」。

---

## 4. axe 结果

### 4.1 逐视图（960×720 视口 + 应用内缩放 200%，生产构建 + 真实 Chromium）

| 视图 | 改前（浅） | 改前（深） | 改后（浅） | 改后（深） |
| --- | --- | --- | --- | --- |
| 日（不滚动） | 零违规（**叠加层没被评估**） | 同左 | 零违规（**叠加层没被评估**） | 同左 |
| 周（不滚动） | 零违规（叠加层被判 `incomplete`） | 零违规 | 零违规 | 零违规 |
| 月 | 零违规（无叠加层） | 零违规 | 零违规 | 零违规 |
| 日（**滚进屏幕**） | **`color-contrast` ×1**（`.calendar-actual-record > strong`，2.82） | 零违规 | 零违规 | 零违规 |
| 周（**滚进屏幕**） | 零违规（`incomplete`） | 零违规 | 零违规 | 零违规 |

原始输出：[`axe-960x200-before.txt`](axe-960x200-before.txt)、[`axe-960x200-before-scrolled.txt`](axe-960x200-before-scrolled.txt)、[`axe-960x200-after.txt`](axe-960x200-after.txt)、[`axe-960x200-after-scrolled.txt`](axe-960x200-after-scrolled.txt)。

### 4.2 E2E 里的验收断言

`phase 4 M12 keeps the calendar page clean with the actual-record overlay`：浅／深 × 日／周／月，960×200%，开启「显示实际记录」；日／周先断言「渲染 + 在屏幕上 + 对比度 ≥ 4.5 + axe 评估过」，再断言整页零违规；月视图断言叠加层不存在。

**没有放宽任何既有断言**：P4-11 的两条 axe 用例原样保留（其中一条只是改了注释里「缺陷记录不改」的说法）。

---

## 5. 视觉证据

`node scripts/visual-evidence.mjs --only actual-record --out output/visual-p4-12-{before,after}`（1200×760 视口 + 应用内缩放 200% + 开启「显示实际记录」，固定数据、固定时钟 `2026-08-05T12:00`）。改前那组是在 `git checkout HEAD -- src/styles.css` 之后构建的，跑完立刻从字节级备份拷回（`sha256sum -c` 通过）。

| 文件 | 尺寸 | 改前 SHA-256（前 12 位） | 改后 | 结论 |
| --- | --- | --- | --- | --- |
| `actual-record-day-1200-200-light` | 1200×760 | `c03c7904cd35` | `c69c04f4b856` | **不同**（预期） |
| `actual-record-day-1200-200-light-crop` | 623×145 | `315f2d6865cd` | `09902afc3002` | **不同**（预期） |
| `actual-record-day-1200-200-dark` | 1200×760 | `4619ce8c5c37` | `4619ce8c5c37` | **逐字节相同** |
| `actual-record-day-1200-200-dark-crop` | 623×145 | `0e7fbc8a26ca` | `0e7fbc8a26ca` | **逐字节相同** |

浅色两张是「白字 → 深字」的直接对照，深色两张**逐字节相同** —— 这比「看图差不多」强：深色主题的渲染结果受影响的像素数是 **0**。8 张图入库在本目录（`-before`／`-after` 后缀）。

截图用 **2 小时**的记录（`calendarScale` 用默认 72px/小时），axe 与 E2E 用 **30 分钟 × 48px/小时**：两者量的是同一处配色，但 200% 缩放下 30 分钟的叠加层只有 24px 高、标题行会被裁掉一截，截图里看不出字形。截图只拍**日视图** —— 200% 下周视图的可见时间窗只有约 140px 高，2 小时的叠加层（144px）放不下。

---

## 6. 发现的既有缺陷（本包之外）

四条，都**不是** P4-12 引入的，也都超出了本包边界（改它们要动别的组件的配色或布局）。原始证据都在本目录。

### 6.1 `axe` 不评估屏幕外的元素（**口径问题，影响所有 axe 用例**）

`color-contrast` 只检查已渲染**且在屏幕上**的元素；元素不在视口里时，它连 `violations`／`incomplete`／`passes`／`inapplicable` 四个桶都不进。这不是本包引入的，但它是「用例假绿」的第二个成因 —— 现有的逐页 axe 用例都只看日历的**初始可视窗口**，滚出去的部分（实际记录叠加层、时间块、卡片次要文字）从来没被检查过。**建议**：给日历的 axe 用例加一次「滚到有内容的时段再断言」，或按视图分别滚动。

### 6.2 `opacity: .62` 把 `.planned-outline` 卡片里的次要文字压到门槛以下

- `src/styles.css:276`：`.calendar-session.planned-outline { … opacity: .62 }`，**只在开启「显示实际记录」时**加上（M2 的「计划变幽灵、实际凸显」效果）。
- 整卡降透明度会连带把里面的 `--muted` 文字一起稀释：浅色主题下前景变成 `#a6a4a0`，落在卡片底色上只有 **2.38–2.48**。
- axe 实测（浅色／日视图，960×200%，[`axe-960x200-other-findings-planned-outline.txt`](axe-960x200-other-findings-planned-outline.txt)）：

| 元素 | 实测 | 门槛 |
| --- | --- | --- |
| `.pending-review > .session-time` | 2.38 | 3:1（24px 大字） |
| `.session-review-trigger > span` | 2.48 | 3:1 |
| `.pending-review > .session-state > .session-progress-value` | 2.48 | 3:1 |
| `.review-summary` | 2.48（浅）／3.88（暗） | 4.5:1（21.76px 常规字重） |

- `.review-summary` 与上面前三行是**同一个前景色**（`--muted` 被 62% 稀释后的 `#a6a4a0`）。它在多数滚动位置被 axe 判成 `incomplete`（[`axe-960x200-other-findings-review-summary.txt`](axe-960x200-other-findings-review-summary.txt) 里能看到这个节点与原因），只在部分几何下升级成违规；**暗色那个 3.88 来自早先一次滚动态，本轮没有重新取证**（§8.3）。
- **UI-SPEC 明确禁止这种写法**：`docs/design/UI-SPEC.md` §视觉令牌基线写着「禁用态使用满足对比度的**专用语义色**而不是整体降低透明度」。所以这不只是数值问题，是与既有规格的偏离。
- **本包不改**：`.planned-outline` 是 M2 的招牌观感，改它需要一次专门的前后对照与两主题实测（与 P4-12 当初被单开的理由一模一样）。**建议单开一包**：把整卡 `opacity` 换成显式的去强调色，并复测。
- 这也是本包那条新用例的夹具**不含「待回顾」时段**的原因 —— 不是为了变绿，而是那一态带着这条独立的缺陷，用例注释里写明了这一点。

### 6.3 200% 缩放下叠加层的标题行会被压成 0 高

- `.calendar-actual-record` 是 `display: grid; align-content: start`，三行文字各自成行。200% 缩放下正文行高是 **44px**，三行需要 132px，而 1 小时的叠加层只有 72px（内容 62px）。
- 只有 `strong` 带 `overflow: hidden`（自动最小尺寸为 0），于是在过约束的网格里它**独自吸收全部缺口**：`grid-template-rows` 实测为 `44px 0px 44px`，标题被裁到看不见。100% 缩放下实测 `22px 17.98px 22px`，正常。
- 实测（`.workbuddy-ai/tmp/p4-12-overlay-dom-probe.mjs`，过程工具）：日视图 1 小时记录 → `strong` 的盒子是 `606x0`；周视图同样 `0` 高。
- **本包不改**：边界写着「不改布局、间距、字号」。**建议**随 6.2 一起处理（同一片区域，改完一起复测）。

### 6.4 `.calendar-time-block > time` 的对比度 4.21（浅色）

- `src/styles.css:455`：`.calendar-time-block time { color: var(--muted) }`，底色是 `color-mix(in srgb, var(--panel-strong) 88%, var(--muted))` = `#e9e8e5`，`--muted` `#706d66` 落在上面只有 **4.21**（< 4.5）。
- 与「显示实际记录」无关，是独立的浅色主题问题（字号 `.68rem` → 200% 下 21.76px，常规字重，不属大字号豁免）。证据：[`axe-960x200-other-findings-time-block.txt`](axe-960x200-other-findings-time-block.txt)。
- **建议**并入 6.2 的收口包。

---

## 7. 未做与边界

- **不改配色体系**：`--action`／`--action-hover`／`--action-text`／`--accent` 的**值**一个没动；新增的 `--actual-record-text` 只被 `.calendar-actual-record` 使用（`grep -c actual-record-text src/styles.css` = 3：声明、注释、使用）。
- **不改布局、间距、字号、缩放范围与预设**。§6.3 的网格塌陷**记录不改**。
- **不改统计口径、D1–D6、P4-07／P4-08／P4-11 的已拍板结论**；没碰 `useCalendarViewport`。
- **不新增依赖**、**不碰 `src-tauri/`**（`npm run test:native` 38 条与改前一致，Rust 侧零改动）。
- 未在真机桌面（Tauri release + NSIS）上复测 —— 属 P4-10。
- §6 的四条**一条都没修**（越界即停并回报），只记录 + 给建议。

---

## 8. 验证记录

### 8.1 `npm run check`（四步全绿）

| 步骤 | 结果 |
| --- | --- |
| `npm run build`（`tsc --noEmit` + `vite build`） | 通过；dist CSS **81.35 kB** / JS **465.79 kB**（P4-11 基线 81.31 / 465.79；本包 +0.04 kB CSS、JS 不变） |
| `npm run test`（Vitest） | **293 / 24 文件**全通过（与 P4-11 基线一致：本包只改 E2E 与样式） |
| `npm run test:e2e`（Playwright） | **41** 全通过（P4-11 基线 40；本包 +1 条日历 axe 用例） |
| `npm run test:native`（Rust） | **38** 全通过（无原生改动） |

### 8.2 本包自建的复现入口

| 入口 | 用途 |
| --- | --- |
| `node scripts/run-e2e.mjs --workers=1 -g "actual-record overlay"` | 跑本包新增的验收用例 |
| `node scripts/visual-evidence.mjs --only actual-record --out output/visual-p4-12-after` | 重拍叠加层截图（`--skip-build` 可复用 dist） |
| `.workbuddy-ai/tmp/p4-12-contrast-probe.mjs` | 逐视图 axe 探针：打印**每个桶**里叠加层的命中、`getComputedStyle` 解析后的前景／背景、是否在屏幕上。支持 `--scroll`（滚进视口）、`--scroll-to=HH`（滚到整点，用来把别的缺陷挪进屏幕取证）。**未入库**（过程工具） |
| `.workbuddy-ai/tmp/p4-12-overlay-dom-probe.mjs` | 打印叠加层三个子节点的盒子与 `grid-template-rows`，用来定位 §6.3。**未入库** |

### 8.3 未在本包验证

- 真机桌面（Tauri release + NSIS）下的 axe 与缩放矩阵 —— 属 P4-10。
- 屏幕阅读器实机朗读 —— 本包只给出「axe 零违规 + 实测比值 ≥ 4.5」这一层证据。
- §6.2 的 `.review-summary` 在暗色主题下只在早先一次滚动态里被 axe 报成违规（3.88），当前几何下它稳定落在 `incomplete`。**这条需要在收口包里重新取证。**

---

## 9. 汇报摘要

- **改了哪些文件**：`src/styles.css`（新增 `--actual-record-text`，`.calendar-actual-record` 改用它）、`e2e/phase1.spec.ts`（+1 条验收用例与夹具、1 处注释订正）、`scripts/visual-evidence.mjs`（+2 场景、`crop` 选项、`frameActualRecord`）；新增本报告与证据目录 `docs/reports/phase-4-p4-12-implementation/`（8 张改前／改后截图 + 7 份 axe 原始输出）。
- **修法**：方案 A —— 给叠加层一个专用前景 token，浅／深两主题都取深色 `#23150d`（深色块里故意不覆盖，因为它本来就达标）。
- **对比度**：浅色 **2.82 → 6.29**；深色 **5.37 → 5.37**（不变）。白字在深色底上也只有 3.30，所以「两主题各用各的 `--action-text`」本来就走不通。
- **视觉**：浅色改前／改后不同（预期），深色 4 张**逐字节相同**。
- **发现的不一致（4 条，均未修）**：① axe 不评估屏幕外的元素（用例假绿的第二成因）；② `.planned-outline` 的整卡 `opacity: .62` 把卡片次要文字压到 2.38–2.48（浅）／3.88（暗），且与 UI-SPEC「不用整体透明度做去强调」相冲突；③ 200% 缩放下叠加层标题行的 `grid-template-rows` 塌成 `44px 0px 44px`，标题看不见；④ `.calendar-time-block > time` 浅色 4.21。
- **仍需用户决定**：① ②③④ 是否合成一包（建议命名 **P4-13**：`opacity` 去强调改成对比度安全的显式色 + 时间块字色 + 叠加层网格塌陷，一次前后对照两主题复测）；② 是否给日历的 axe 用例加「滚到有内容的时段」这一轮，避免屏幕外的状态继续不被检查；③ §8.3 里 `.review-summary` 暗色那条要不要在收口包里重新取证。

> **三条已于 2026-10-16 全部拍板**（见 `phase-4-open-decisions.md` §9）：① 合成 **P4-13**，提示词 `phase-4-p4-13-kickoff-prompt.md`；② **加**那一轮滚动，写进 P4-13 的验收；③ **要**，在 P4-13 里重新取证。
> 另外用户报了一条本包没查的既有缺陷（日视图的实际记录叠加层**盖住「今天」药丸**），已查明根因（`.calendar-day > header` 的 `z-index: 4` 被 5/6/7/8/9/10 全体压住，纯数值问题，`git blame` 指向 2026-09-02，与本包无关），一并并入 P4-13。
> 用户还要求给叠加层**减重**（P4-12 把白字换成深字后它从"高亮"读成了"实体"），也并入 P4-13。
