# 阶段 4 P4-13 实施记录：日历的视觉层级与语义色收口

> 工作包：`docs/reports/phase-4-open-decisions.md` §9 拍板单开的 **P4-13**（提示词 `docs/reports/phase-4-p4-13-kickoff-prompt.md`）。
> 来源：① 用户报的「日视图实际记录叠加层盖住『今天』药丸」；② 用户要求的叠加层减重；③④⑤ 是 P4-12 §6.2／§6.3／§6.4 三条既有缺陷。
> 顺序依据：**在 P4-10（原生验收与发布）之前**完成 —— 顺序是 `P4-13 → P4-10`，发布包才含修复。

---

## 1. 范围与交付清单

### 1.1 修改的代码

| 文件 | 改动 |
| --- | --- |
| `src/styles.css` | ① 新增 `:root` 的图层表注释，并把 **7 处 `z-index`** 重排（见 §2）；② 新增 `--actual-record-surface`、`--deemphasized-surface` 两个语义 token，并给深色主题**覆盖** `--actual-record-text`；③ `.calendar-actual-record` 底色改用 `--actual-record-surface`；④ `.calendar-session.planned-outline` 的整卡 `opacity: .62` 换成显式去强调色；⑤ 两条基于 `rem` 的 `@container (max-height: …)` 取代原来那条（含一条**死规则**的）容器查询；⑥ `.calendar-time-block time` 的 `--muted` → `--muted-strong`。**全局 token（`--action*`／`--accent*`／`--muted*`／`--panel*`／`--line*`）的值一个没动。** |

### 1.2 修改与新增的测试

| 文件 | 改动 |
| --- | --- |
| `e2e/phase1.spec.ts` | **新增 2 条用例**：`phase 4 M13 keeps the sticky calendar headers above the track content`（图层遮挡回归，`document.elementFromPoint`）与 `phase 4 M13 keeps the calendar page clean with the de-emphasised plan, the actual record and the time block`（开启「显示实际记录」的 axe + 逐处实测对比度，含「滚到有内容的时段」轮次）。新增夹具 `calendarDeemphasisedWorkspace()` 与 3 个页面侧助手（`scrollIntoCalendarSafeArea`／`hitTestAtCenterOf`／`measureCalendarContrast`）。**没有放宽任何既有断言。** |
| `scripts/visual-evidence.mjs` | `crop` 支持数组（一次拍多处近景）；新增 `frameBelowHeader()`（近景先滚进吸顶头下方的安全区）；`measureActualRecord()` 在日视图改以**日期头**（而非分隔条）为安全顶；新增 `measureTodayPill()`／`frameTodayPill()` 与 `today-pill-*` 场景；`actualRecordWorkspace()` 扩充（1.5 小时记录 + 待回顾时段 + 时间块）；`scale` 从硬编码 200 改成**场景参数**（100／200）；P4-13 的两个场景族用 1200×900 视口。 |

**没有**新增依赖、没有新增 SQLite 迁移或字段（schema 仍 v7）、没有新增 Tauri Command、没有改统计口径、没有改 D1–D6 与 P4-07／P4-08／P4-11／P4-12 的结论、没有碰 `useCalendarViewport`、没有碰 `src-tauri/`。

---

## 2. §1 图层：吸顶日期头被轨道内容压住

### 2.1 先复现（用户报的现象必须自己量一遍）

用命中测试量「谁画在最上面」：日视图、锚点日 = 今天、记录 09:00–10:30，把叠加层滚到吸顶头部带里（滚动容器顶部往下 40–92px），然后问药丸中心点上是哪个元素。

**⚠️ 关键陷阱：叠加层是 `pointer-events: none`，命中测试会直接跳过它。** 不打开它时，`elementFromPoint` 在药丸中心返回的就是药丸 —— 缺陷明明还在，用例却是绿的。所以探针（与 E2E 用例）都**临时**把叠加层的 `pointer-events` 打开再问一次；这只改样式，不改产品代码，也不影响绘制顺序。

```
改前（HEAD）· 临时打开叠加层命中：
  hit: "span."        ← 命中的是叠加层里的「实际」标签
  stack: ["span.", "article.calendar-actual-record.ended", "span.today-number", "header.", …]
                          ↑ 叠加层排在药丸前面 = 画在它上面

改后（本包）· 同样临时打开：
  hit: "span.today-number"   ·  命中在 `.calendar-day.today > header` 里
```

完整输出：[`layer-probe-100-before.txt`](phase-4-p4-13-implementation/layer-probe-100-before.txt)、[`layer-probe-100-after.txt`](phase-4-p4-13-implementation/layer-probe-100-after.txt)、[`layer-probe-200-before.txt`](phase-4-p4-13-implementation/layer-probe-200-before.txt)、[`layer-probe-200-after.txt`](phase-4-p4-13-implementation/layer-probe-200-after.txt)。

**比用户看到的更广**：日视图的 `.calendar-day > header` 是 `z-index: 4`，而轨道内容从 5 一路排到 10 —— 4 被**全体**压住，不只是叠加层（7）。周视图的吸顶头是 12 所以没事，只有日视图那一档给低了。`git blame` 指向 2026-09-02 的 `54c621b`（与本包无关）。

### 2.2 完整的层级表（改后）

整个日历的堆叠上下文由 `.calendar-viewport`（`container-type: inline-size` → 自带 layout containment）建立。**下面这些 `z-index` 全是同一个上下文里的数值比大小** —— 不是「跨上下文」问题，加 `isolation: isolate` 一个像素都不会变。`.calendar-session`／`.calendar-actual-record`／`.calendar-time-block` 的 `container-type: size` 只让它们成为**自己子树**的上下文，不改变它们和兄弟的先后。

| z-index | 元素 | 说明 | 本包 |
| --- | --- | --- | --- |
| 0 | `.calendar-past-region` | 轨道内容：已过去区域的底色 | — |
| 1 | `.calendar-time-block` | 轨道内容：时间块 | — |
| 2 | `.calendar-session` | 轨道内容：计划卡 | — |
| 4 | `.calendar-session:hover` | 轨道内容：悬停抬升 | — |
| 5 | `.calendar-session.current-schedule` | 轨道内容：当前安排 | — |
| 6 | `.calendar-session.pending-review`／`.concurrent-expanded-list`／`.simultaneous-count` | 轨道内容 | — |
| 7 | `.calendar-actual-record`／`.concurrent-summary` | 轨道内容：实际记录叠加层 | — |
| 8 | `.calendar-now-line`／`.drag-expanded-region`／`.calendar-session.targeted-session`／`.blank-range-preview` | 轨道内容 | — |
| 9 | `.collapsed-time-gap`／`.calendar-session.overlap-target`／`.blank-hover-cue` | 轨道内容 | — |
| 10 | `.expanded-gap-toggle` | 轨道内容 | — |
| **19** | **`.calendar-day > header`（含「今天」药丸）／`.day-head-spacer`** | **吸顶日期头**（日视图，`top: 40px`；时间轴一侧的占位块） | **4 → 19；5 → 19** |
| **20** | **`.continuous-day-separator`／`.week-sticky-header`** | **吸顶分隔条（日视图）与周视图吸顶头** | **8 → 20；12 → 20** |
| **22** | **`.with-detail > .calendar-date-details`** | 窄容器下的覆盖式日期详情面板 | **18 → 22** |
| **24** | **`.calendar-insert-line`／`.calendar-shift-preview`** | **临时层**：插入线、位移预览 | **位移预览 18 → 24** |
| **30** | **`.back-to-now`** | 浮动按钮「回到现在」 | **16 → 30** |
| 35 | `.calendar-drag-preview`／`.calendar-drag-ghost` | **临时层**：拖拽预览与落点幽灵 | — |
| （40） | `.blank-action-bubble` | 空白区操作气泡；它挂在 `.floating-panel`（`position: fixed; z-index: 100`）里，**不属于**日历这个上下文 | — |

三条规则（写进 `styles.css` 的注释里，长期有效）：

1. **吸顶头永远高于轨道内容**（19／20 > 0–10）。否则内容滚到头部下方时会盖住日期与「今天」。
2. **临时层永远高于吸顶头**（24／35 > 20）。拖拽反馈（插入线、位移预览、落点幽灵）不能被吸顶带挡住 —— 这也是 `.calendar-shift-preview` 必须跟着抬到 24 的原因（它原来是 18，抬完吸顶头就反超了）。
3. **分隔条高于日期头**（20 > 19）：分隔条是「这一块是哪一天」的更大粒度标尺，压在日期头上方。

### 2.3 改了什么、为什么

| 选择器 | 旧 | 新 | 理由 |
| --- | --- | --- | --- |
| `.calendar-day > header` | 4 | **19** | 用户报的那一档。抬到 19 而不是「比 7 大一点」：它要同时压住 5／6／7／8／9／10 全部轨道内容，给到 10 以上的最低整档就是 19（18 留给「覆盖面板」，20 留给分隔条）。 |
| `.day-head-spacer` | 5 | **19** | 时间轴那一侧的吸顶占位块与日期头是**同一条带**，两档不一致会出现「轴一侧的格线从日期头下钻出来」。 |
| `.continuous-day-separator` | 8 | **20** | 它本来就是吸顶的（`top: 0`），8 只比叠加层大 1 —— 抬到日期头之上才符合「分隔条压日期头」。 |
| `.week-sticky-header` | 12 | **20** | 周视图本来没被压住（12 > 10），抬到 20 是为了让「两条吸顶带」同档，避免以后有人只改一条。 |
| `.with-detail > .calendar-date-details` | 18 | **22** | 它是覆盖式面板，必须高于两条吸顶带。当前布局用 `padding-right` 给它留白、与日历不重叠，所以 18 也没出过事 —— 但层级上不该低于吸顶头，顺手收口。 |
| `.calendar-shift-preview` | 18 | **24** | 临时层。原来 18 只比周吸顶头（12）大，抬完吸顶头（19／20）就反超了；不抬会让「插入并后移」的位移预览被日期头挡住。 |
| `.back-to-now` | 16 | **30** | 浮动按钮，本来就该在吸顶带之上（16 只比周吸顶头 12 大）。30 同时低于拖拽层（35），拖拽时不会挡住跟手的幽灵框。 |

### 2.4 回归判据

`e2e/phase1.spec.ts` 的 `phase 4 M13 keeps the sticky calendar headers above the track content`：日视图（100%／200% 两档缩放 × 有／无叠加层两种状态 × 叠加层命中打开／不打开）断言药丸中心命中的是药丸自己或它的后代；周视图断言吸顶头里的日期按钮中心命中的是吸顶头；月视图没有吸顶头（表头是普通网格行），做一次「表头行仍可命中」的冒烟断言。

**反向验证**（把 `src/styles.css` 退回 `HEAD`）用例立刻变红：

```
Error: 100% · 日视图 · 有叠加层 · 药丸中心命中的是 span.review-summary，而不是日期头 header.；
       堆叠顺序 ["span.review-summary","span.today-number","header.","time.session-time","article.calendar-session.planned-outline"]
```

完整输出：[`e2e-m13-reverse.txt`](phase-4-p4-13-implementation/e2e-m13-reverse.txt)。

---

## 3. §2 叠加层减重：满饱和橙 → 淡底 + 深字 + 左侧色条

### 3.1 取值与理由（**这一节的核心结论：比例不是问题，前景必须跟着底走**）

提示词建议把 `color-mix(--accent 82%, --panel)` 改成 28%。实测后**只照抄比例会踩坑**：

| 主题 | `--panel` | 28% 混出来的底 | P4-12 的「两主题共用深色前景」`#23150d` |
| --- | --- | --- | --- |
| 浅色 | `#ffffff` | `#f2d5c8`（淡桃） | **12.77** ✅ |
| 深色 | `#252523` | `#5e4232`（**深褐**） | **1.943** ❌ |

也就是说：P4-12 那句「两主题混出来的底都是中间调的橙、所以可以共用同一个深色前景」**只在 82% 这个比例下成立**。底色一淡，浅色主题往白走、深色主题往黑走，两个方向相反 —— 共用前景必然有一头不达标。实测输出：[`overlay-28-shared-foreground.txt`](phase-4-p4-13-implementation/overlay-28-shared-foreground.txt)。

所以本包把叠加层的**表面与前景做成一对称对的语义 token**：

```css
:root {
  /* 底色两个主题方向相反 → 前景必须成对声明 */
  --actual-record-surface: color-mix(in srgb, var(--accent) 30%, var(--panel));
  --actual-record-text: #23150d;
}
:root[data-theme="dark"] {
  --actual-record-text: #ffd9c2;   /* P4-12 的「故意不覆盖」在这里不再成立 */
}
```

`--actual-record-surface` 只声明一次：`var(--accent)` 与 `var(--panel)` 都随主题变，混色结果自动跟随（实测：浅 `#f2d2c4`、深 `#624433`）。

**比例取 30%**：28% 与 30% 在浅色下几乎不可区分（`#f2d5c8` vs `#f1d2c4`），取 30% 是因为它让最低的一档（深色 6.665）也高出 4.5 门槛 48%，余量更大；同时 30% 的淡桃底与「去强调」后的计划卡（近白）仍一眼可分。**真正必须改的是深色主题的前景，不是比例。**

### 3.2 实测对比度（改前 / 改后）

`getComputedStyle` 取浏览器**解析后**的颜色（`color-mix` 已解析成 `color(srgb …)`），按 WCAG 2.x 相对亮度公式算，与 axe 同一套口径。字号／字重来自 960×720 + 200% 界面缩放。

| 主题 | 叠加层底色 | 改前前景 | 改前 | 改后前景 | 改后 | 门槛 |
| --- | --- | --- | --- | --- | --- | --- |
| 浅色 | `#da845e` → **`#f2d2c4`** | `#23150d` | **6.284** ✅ | `#23150d` | **12.487** ✅ | 4.5:1 |
| 深色 | `#cb794e` → **`#624433`** | `#23150d` | **5.390** ✅ | `#ffd9c2` | **6.665** ✅ | 4.5:1 |

- 字号 23.04px、字重 600 —— **不属于**大字号豁免（`23.04px < 24px`），门槛就是 4.5:1。
- 左侧 4px 色条与 1px 描边继续用 `--accent-strong`：浅色 `#a94724` 落在 `#f2d2c4` 上约 **4.1:1**、深色 `#ffb48d` 落在 `#624433` 上约 **5.1:1**（按同一公式手算；非文本边界的门槛是 3:1）。「这是实际记录」仍然一眼可辨。
- 原始输出：[`contrast-before.txt`](phase-4-p4-13-implementation/contrast-before.txt)、[`contrast-after.txt`](phase-4-p4-13-implementation/contrast-after.txt)。

---

## 4. §3 计划卡的整卡 `opacity` → 显式去强调色

### 4.1 缺陷与偏离

`src/styles.css` 里 `.calendar-session.planned-outline { … opacity: .62 }`（**只在开启「显示实际记录」时**加上）把整卡（含里面的 `--muted` 文字）朝卡片背后的底色稀释。UI-SPEC §视觉令牌基线明确写着「禁用态使用满足对比度的**专用语义色**而不是整体降低透明度」——所以这不只是数值问题，是与既有规格的偏离。

**量它的口径很重要**：只读 `color` 与 `backgroundColor` 会**假绿**（浅色算出 4.83，看着达标）。必须把祖先的 `opacity` 一起合成：卡片是一个 opacity 分组，组内文字压在卡片底上，整组再按 opacity 合成到背后的底上。按这个模型算出来的浅色值 **2.375** 与 P4-12 §6.2 记录的 **2.38** 是同一个数（合成出的前景 `rgb(166,164,160)` = P4-12 记的 `#a6a4a0`）。

### 4.2 改法

```diff
-.calendar-session.planned-outline { border-style: dashed; background: color-mix(in srgb, var(--accent-soft) 38%, var(--panel)); opacity: .62; }
-.calendar-session.planned-outline:focus-within, .calendar-session.planned-outline:hover { opacity: 1; }
+.calendar-session.planned-outline { border-style: dashed; background: var(--deemphasized-surface); color: var(--muted-strong); }
+.calendar-session.planned-outline:focus-within, .calendar-session.planned-outline:hover { background: color-mix(in srgb, var(--accent-soft) 78%, var(--panel)); color: var(--text); }
```

新增一个**表面** token（`--deemphasized-surface`：浅色 `accent-soft 22%` → `#fefaf7`；深色 `accent-soft 26%` → `#2e2824`）；文字复用已有的 `--muted-strong`（「浅底上的次要文字」语义色，与 §5 的时间块共用同一个）。悬停／聚焦时恢复常规计划卡底色与 `--text`，保住原来「hover 时提回前台」的交互意图。

### 4.3 实测（含 P4-12 §8.3 欠的那一条）

| 元素 | 门槛 | 浅色改前 | 浅色改后 | 深色改前 | 深色改后 |
| --- | --- | --- | --- | --- | --- |
| 计划卡 · 标题（`strong`，24px/600） | 3 | 4.322 | **7.383** | 5.753 | **8.855** |
| 计划卡 · 起止时间（`.session-time`，24px/400） | 3 | **2.375** ❌ | **4.973** | 3.661 | **7.264** |
| 计划卡 · 状态标签（`.session-review-trigger > span`） | 3 | **2.375** ❌ | **4.973** | 3.661 | **7.264** |
| 计划卡 · 进度值（`.session-progress-value`） | 3 | **2.375** ❌ | **4.973** | 3.661 | **7.264** |
| 计划卡 · 回顾摘要（`.review-summary`，21.76px/400） | **4.5** | **2.375** ❌ | **4.973** | **3.661** ❌ | **7.264** |

- 24px 的四项按 WCAG 属**大字号**（门槛 3），21.76px 的 `.review-summary` 属常规字号（门槛 4.5）。改后四项都到 4.973，**连最严的 4.5 也过了**。
- **P4-12 §8.3 的欠账补上了**：那一条说「暗色 3.88 来自早先一次滚动态、本轮没有重新取证」。本包用同一夹具重新取证，实测 **3.661**（P4-12 的 3.88 与它差 6%，成因是当时那次滚动位置下卡片背后的底不同）。改后 **7.264**。
- 观感意图（「计划退居背景、实际凸显」）保持：底色几乎没变 —— 改前 `accent-soft 38%` 经 62% 透明度合成后是 `#fef9f6`，改后不透明的 `--deemphasized-surface` 是 `#fefaf7`，逐通道差 ≤ 2（见 §7 的逐像素对比）。变的是**卡内每一处内容不再被稀释**。

---

## 5. §4 200% 缩放下叠加层标题行被压成 0 高

### 5.1 缺陷

`.calendar-actual-record` 是 `display: grid; align-content: start`，三行文字各自成行。200% 缩放下正文行高是 **44px**（界面缩放就是把根字号设成 `200%`），三行要 132px；而 1 小时的叠加层只有 72px（内容盒 62px）。只有 `strong` 带 `overflow: hidden`（自动最小尺寸为 0），于是它**独自吸收全部缺口**。

实测（1.5 小时记录，与截图样本同长；`overlayHeight = 108`，内容盒 98px）：

| 缩放 | 改前 `grid-template-rows` | 改后 |
| --- | --- | --- |
| 100%（行高 22px） | `22px 22px 22px` | `22px 22px 22px`（不变） |
| 200%（行高 44px） | **`44px 10px 44px`** ← 标题被压成 10px | **`44px 44px`** + `time { display: none }` |

P4-12 §6.3 记录的 1 小时情形更极端：改前 `44px 0px 44px`（标题**0 高**）、改后 `44px`。原始输出：[`layer-probe-200-before.txt`](phase-4-p4-13-implementation/layer-probe-200-before.txt)、[`layer-probe-200-after.txt`](phase-4-p4-13-implementation/layer-probe-200-after.txt)。

### 5.2 改法与优先级

```css
@container (max-height: calc(4.125rem + 9px)) { .calendar-actual-record time { display: none; } }
@container (max-height: calc(2.75rem + 9px)) { .calendar-actual-record span { display: none; } }
```

- **断点用 `rem`**：行高是 `1.375rem`，而界面缩放就是把根字号设成 100%–200%，所以容器查询里的 `rem` 自动跟着缩放走 —— 同一段 1 小时的记录在 100% 下留两行、在 200% 下只留标题，不需要按缩放写两套规则。
- 数字来自内容盒：`容器高 − 8px 内边距 − 2px 边框`，所以断点是「行高 × 行数 + 10px」再让 1px 容差。
- **优先级：标题 > 「实际」标签 > 起止时间**。起止时间在计划卡上也有，「实际」才是这一层的身份标签，所以先隐藏时间行。
- 结果：100% 下三行仍然都显示（`22px 22px 22px` 未变），只有「放不下」时才逐行让位 —— 不会再出现「某一行被单独压成 0」。

### 5.3 顺带发现的**死规则**

原来那条 `@container (max-height: 28px) { .calendar-actual-record { align-content: center; padding-block: 2px; } … }` 里的**第一条声明从来没生效过**：容器查询只对**容器的后代**生效，而 `.calendar-actual-record` 自己就是那个容器（`container-type: size`），它不会是自己的后代。实测 `getComputedStyle(overlay).alignContent` 在 100%／200%、改前／改后一律是 `start`（见探针输出里的 `"alignContent": "start"`）。所以那 28px 规则实际只做了「隐藏 span 与 time」一件事 —— 也就是本包新写的那两条规则所覆盖的同一件事。`.calendar-time-block` 里那条 `@container (max-height: 26px) { .calendar-time-block { … } }` 是**同一个错法**，本包**不动它**（只记录，它同样只靠 `.calendar-time-block time { display: none }` 生效）。

---

## 6. §5 时间块的起止时间对比度

`src/styles.css` 的 `.calendar-time-block time { color: var(--muted) }`，底色是 `color-mix(in srgb, var(--panel-strong) 88%, var(--muted))`。字号 `.68rem` → 200% 下 21.76px、常规字重，**不属大字号豁免**，门槛 4.5:1。

| 主题 | 底色 | 改前 | 改后（`--muted-strong`） | 门槛 |
| --- | --- | --- | --- | --- |
| 浅色 | `#e9e8e5` | **4.213** ❌ | **6.255** ✅ | 4.5 |
| 深色 | `#3e3d39` | 5.435 ✅ | **6.625** ✅ | 4.5 |

与「显示实际记录」无关，是独立的浅色主题问题。改法与 §4 共用同一个「浅底上的次要文字」语义色（`--muted-strong`），没有新增 token。

---

## 7. axe 结果（含「滚到有内容的时段」这一轮）

### 7.1 新用例的轮次

`phase 4 M13 keeps the calendar page clean with the de-emphasised plan, the actual record and the time block`：960×720 + 200% 界面缩放、**显式开启「显示实际记录」**、夹具里**真的有**「待回顾」计划卡／时间块／`missed` 时段（P4-09 的教训：夹具太穷会漏真实违规）。

每一轮都**先滚到一段有内容的时段**再断言 —— 960×200% 下日视图只有约 3 小时的可视窗口，「初始位置」本身就会漏掉大半天：

| 视图 | 轮次 | 焦点元素 |
| --- | --- | --- |
| 日 | 滚到 14:00 | `.calendar-session.missed` |
| 日 | 滚到 07:00 | `.calendar-session.pending-review` |
| 日 | 滚到 16:00 | `.calendar-time-block` |
| 周 | 滚到 16:00 | `.calendar-time-block` |
| 周 | 滚到 07:00 | `.calendar-session.pending-review` |
| 月 | 初始位置（上半月） | 第一个 `gridcell` |
| 月 | 滚到底部（下半月） | 最后一个 `gridcell` |

共 7 轮 × 浅／深 2 色 = **14 次 axe**，全部零违规。每一轮的断言顺序是「焦点元素 `toBeVisible()` + `toBeInViewport({ ratio: 0.5 })` → 逐处实测对比度 → axe 零违规」，并且只对**这一轮真的放进了屏幕**的元素断言「axe 必须评估过它」（`overlayEvaluated`／`planEvaluated`／`timeBlockEvaluated`）—— 「零违规」不等于「量过了」，反过来也不该要求 axe 评估屏幕外的元素。

**反向验证**（把 `src/styles.css` 退回 `HEAD`）两条用例都变红：

```
Error: 浅色 · 日历（日）· 滚到 14:00（未推进 + 现在线） · 待回顾计划卡 · 起止时间（opacity×0.62，24px/400）
  Expected: >= 3
  Received:    2.375
```

完整输出：[`e2e-m13-reverse.txt`](phase-4-p4-13-implementation/e2e-m13-reverse.txt)、通过时的输出 [`e2e-m13-pass.txt`](phase-4-p4-13-implementation/e2e-m13-pass.txt)。

### 7.2 既有用例

P4-11 的两条日历 axe 用例（日／周／月 × 浅／深，含「有 `missed` 时段 → 渲染状态图标」那一态）与 P4-12 的 `actual-record overlay` 用例**原样保留**，全部继续通过。**没有放宽任何断言。**

---

## 8. 视觉证据：改前 / 改后对照

`node scripts/visual-evidence.mjs --only actual-record --out output/visual-p4-13-{before,after}` 与 `--only today-pill …`（1200×900 视口 + 固定数据、固定时钟 `2026-08-05T12:00`）。改前那组是在 `git checkout HEAD -- src/styles.css` 之后构建的，跑完立刻从字节级备份拷回（`sha256sum -c` 通过）。

48 张图入库在 [`docs/reports/phase-4-p4-13-implementation/`](phase-4-p4-13-implementation/)（`before/` 与 `after/` 两个子目录，各 24 张）。两个场景族 × 浅／深 × 100／200%：

| 场景族 | 产出 | 覆盖 |
| --- | --- | --- |
| `actual-record-day-1200-{100,200}-{light,dark}` | 全页 + 3 张近景（叠加层／待回顾计划卡／时间块） | §3 §4 §5 §6 |
| `today-pill-day-1200-{100,200}-{light,dark}` | 全页 + 1 张近景（日期头） | §2 |

### 8.1 逐像素对比（`--skip-build` 之外的独立工具，未引入依赖）

把两张同名 PNG 读进 Chromium 的 canvas 逐像素求差。完整输出：[`image-diff.txt`](phase-4-p4-13-implementation/image-diff.txt)。

| 近景 | 不同像素 | 最大通道差 | 差异区域 | 说明 |
| --- | --- | --- | --- | --- |
| 叠加层 `-crop`（623×108） | **97.1–97.4%** | 129–220 | 整块 | 底色与字色都换了：满饱和橙 → 淡桃底 + 深字 |
| 计划卡 `-crop2`（631×73） | 98.6% | **81–85** | 整卡 | 底色几乎不动（合成后逐通道差 ≤ 2）；变的是卡内文字／进度条／边框**不再被 62% 稀释** |
| 时间块 `-crop3`（625×72） | **0.85–1.9%** | 127–134 | 只在 `y 14–64` 的文字带 | 只有起止时间那几个字变了 |
| 日期头 `today-pill-…-crop`（639×52） | **87.1–98.3%** | 218–243 | 整块 | 改前拍到的是叠加层的橙色像素，改后是「今天 5」 |
| 全页（1200×900） | 6.7–14.9% | 139–243 | 日历区域 | 只动日历内部，导航／工具栏／任务池一个像素没变 |

### 8.2 这一包**必须**变视觉（与 P4-11 正好相反）

P4-11 的目标是「结构改了、视觉零变化」，用逐字节相同证明；本包**预期改视觉**，所以要说清变了哪几处、为什么必须变：

1. **叠加层底色**：`#da845e` → `#f2d2c4`（浅）／`#cb794e` → `#624433`（深）。用户明确要求「减重」——满饱和橙读成了实体块。
2. **叠加层字色**：浅色不变（`#23150d`）；深色 `#23150d` → `#ffd9c2`。**必须变**：底色从中间调橙变成深褐，深字在上面只有 1.943。
3. **叠加层行数**：200% 下从「标题被压成 10px」变成「按优先级隐藏时间行」——必须变，否则标题读不到。
4. **计划卡**：底色基本不动，卡内文字／进度条／边框恢复实色（改前被 62% 透明度稀释）。必须变：那些文字本来就不达标（浅色 2.375）。
5. **时间块起止时间**：`--muted` → `--muted-strong`，只有那几个字的像素变了。必须变：浅色 4.213 < 4.5。
6. **日期头**：改前被叠加层盖住（近景拍到的是一块橙色），改后是「今天 5」。必须变：这就是用户报的缺陷。

---

## 9. 未做与边界

- **不改现有全局 token 的值**：`--action`／`--action-hover`／`--action-text`／`--accent`／`--accent-strong`／`--accent-soft`／`--muted`／`--muted-strong`／`--panel`／`--line` 的值**一个没动**（`git diff src/styles.css` 里没有任何一行是改这些值的）。
- 本包新增 2 个 token（`--actual-record-surface`、`--deemphasized-surface`），并**给深色主题覆盖了 `--actual-record-text`**。这是 P4-12 引入的 token，P4-12 的「深色块里故意不覆盖」在本包被推翻 —— 理由是底变了（§3.1 有实测：不覆盖的话深色只有 1.943）。**这是本包唯一被改值的 token，且属于本包的修复范围。**
- **不改布局结构、间距、字号、缩放范围与预设**。§5 只改「内容在已有盒子内如何分配」（隐藏哪些行），**没有**动 `min-height`／`padding`／`font-size`。
- **不改统计口径、D1–D6、P4-07／P4-08／P4-11／P4-12 的已拍板结论**；没碰 `useCalendarViewport` 的滚动仲裁与「程序性滚动不写偏好」闸门。
- **不新增依赖**、**不碰 `src-tauri/`**（`npm run test:native` 38 条与改前一致，Rust 侧零改动）。
- **不修 `.calendar-insert-line`**（它目前有可见文字、不违规），也不碰别的页面。
- 未在真机桌面（Tauri release + NSIS）上复测 —— 属 P4-10。

---

## 10. 发现的不一致与仍需用户决定

### 10.1 本包已顺手收口的（都属于「层级」这一片）

1. `.with-detail > .calendar-date-details` 18 → **22**：它是覆盖式面板，原来只比周吸顶头（12）大，抬完吸顶带后会被反超。
2. `.calendar-shift-preview` 18 → **24**：临时层，必须永远高于吸顶头（§2.2 规则 2）。
3. `@container` 的**死规则**（§5.3）：`.calendar-actual-record { align-content: center }` 与 `.calendar-time-block { padding-block: 2px; align-content: center }` 从来没生效过。前者随本条重写一并删除；后者**保留原样**（只记录，不在本包边界内）。

### 10.2 本包**未修**、留给用户决定的

1. **`.calendar-time-block` 的 `min-height` 不随界面缩放走**（实际值是 **`28px`**，不是 `22px` —— 后者是 `padding` 的横向值与 `.calendar-actual-record` 的值）。200% 下一段极短记录会被这个下限钳住，而单行文字需要 44px，标题仍被裁。**状态：已评估、本轮不做** —— 换成 rem 的两轮实测都在 200% 下把标题从 12px 压成 0px（回归）；真正要动的是 `@container (max-height: 26px)` 的 px 阈值，而三种阈值的代价不同，属设计决策。理由、三次实测与三种方案见 **§12.1**。
2. **`.calendar-time-block` 的同类死规则**（`@container (max-height: 26px)` 里的 `.calendar-time-block { … }`，见 §5.3）—— 不影响功能，留着容易误导后来人。
3. **`.calendar-session` 的容器查询是 px 断点**（`124px`／`112px`／`100px`／`88px`）。这些断的是**卡片宽度**（px，不随界面缩放走），所以逻辑上没问题；但它们与叠加层新用的 `rem` 断点是两套口径，值得在 UI-SPEC 里写明「按宽度隐藏用 px、按行数隐藏用 rem」的分工。
4. **`opacity` 在别处还有 3 处**（`.calendar-shift-preview` 的 `.55`、`.calendar-time-block.is-resizing` 的 `.55`、`.calendar-session.is-resizing` 的 `.85`）。它们都是**拖动中的临时态**（不是「去强调」），没有承载必须达标的文字，本包**不动**；但 UI-SPEC 那条「不用整体透明度做去强调」目前只有本包这一处被写实，其余几处建议在下一轮收口时一起过一遍。

---

## 11. 验证记录

### 11.1 `npm run check`（四步全绿，2026-10-17）

| 步骤 | 结果 |
| --- | --- |
| `npm run build`（`tsc --noEmit` + `vite build`） | 通过；dist CSS **81.67 kB** / JS **465.79 kB**（P4-12 基线 81.35 / 465.79；本包 +0.32 kB CSS、JS 不变） |
| `npm run test`（Vitest） | **293 / 24 文件**全通过（与 P4-12 基线一致：本包只改样式与 E2E） |
| `npm run test:e2e`（Playwright） | **43** 全通过（P4-12 基线 41；本包 +2 条 M13 用例） |
| `npm run test:native`（Rust） | **38** 全通过（无原生改动） |

原始日志：[`npm-run-check.txt`](phase-4-p4-13-implementation/npm-run-check.txt)。

### 11.2 本包自建的复现入口

| 入口 | 用途 |
| --- | --- |
| `node scripts/run-e2e.mjs --workers=1 -g "phase 4 M13"` | 跑本包新增的两条用例 |
| `node scripts/visual-evidence.mjs --only actual-record --out output/visual-p4-13-after` | 重拍叠加层／计划卡／时间块截图（`--skip-build` 可复用 dist） |
| `node scripts/visual-evidence.mjs --only today-pill --skip-build --out output/visual-p4-13-after` | 重拍「日期头 vs 叠加层」的遮挡对照 |
| `.workbuddy-ai/tmp/p4-13-layer-probe.mjs [--skip-build] [--scale=100\|200]` | 图层探针：命中测试（含临时打开叠加层命中）＋ `grid-template-rows` 行分配。**未入库**（过程工具） |
| `.workbuddy-ai/tmp/p4-13-contrast-probe.mjs [--skip-build]` | 逐处对比度探针：把整卡 `opacity` 一起合成，打印前景／底色／opacity／字号／门槛。**未入库** |
| `.workbuddy-ai/tmp/p4-13-image-diff.mjs <改前目录> <改后目录>` | 逐像素对比：不同像素数／占比／最大通道差／差异外接框。**未入库** |

### 11.3 未在本包验证

- 真机桌面（Tauri release + NSIS）下的 axe 与缩放矩阵 —— 属 P4-10。
- 屏幕阅读器实机朗读 —— 本包只给出「axe 零违规 + 实测比值达标」这一层证据。
- §10.2 的四条都**没有**修，只记录。

---

## 12. 汇报摘要

- **改了哪些文件**：`src/styles.css`（7 处 `z-index` + 2 个新 token + 深色前景覆盖 + 叠加层底色 + 计划卡去强调 + 两条 `rem` 容器查询 + 时间块字色）、`e2e/phase1.spec.ts`（+2 条 M13 用例、1 个新夹具、3 个页面侧助手）、`scripts/visual-evidence.mjs`（数组 `crop`、近景安全区取景、日视图安全顶改日期头、`today-pill` 场景、`scale` 场景参数、P4-13 场景族 1200×900）；新增本报告与证据目录 `docs/reports/phase-4-p4-13-implementation/`（48 张改前／改后截图 + 9 份原始输出）。
- **图层**：完整的层级表见 §2.2。日视图日期头 4 → **19**、时间轴占位 5 → **19**、日分隔条 8 → **20**、周吸顶头 12 → **20**、覆盖详情面板 18 → **22**、位移预览 18 → **24**、回到现在 16 → **30**。三条规则：吸顶头 > 轨道内容、临时层 > 吸顶头、分隔条 > 日期头。
- **减重**：底色 `accent 82%` → `30%`（浅 `#f2d2c4` / 深 `#624433`），前景改成**按主题成对**（深色改为 `#ffd9c2`）。实测浅 **12.487**、深 **6.665**。**28% 本身不是问题** —— 28% + P4-12 的共用深色前景在深色下只有 **1.943**（已实测）。
- **计划卡**：整卡 `opacity: .62` → `--deemphasized-surface` + `--muted-strong`。浅色四项从 **2.375** 提到 **4.973**，深色从 **3.661** 提到 **7.264**（含 P4-12 §8.3 欠取证的那一条）。
- **200% 行分配**：`44px 10px 44px` → `44px 44px`（1.5 小时）；1 小时的 `44px 0px 44px` → `44px`。100% 下三行不变。
- **时间块**：浅色 **4.213 → 6.255**、深色 **5.435 → 6.625**。
- **axe**：960×200%、浅／深 × 日（3 轮）／周（2 轮）／月（2 轮）共 14 次全部零违规；两条新用例在改前代码上**都变红**。
- **发现的不一致**：① `@container` 有两条**死规则**（容器查询不作用于容器自身）；② 覆盖式详情面板（18）与位移预览（18）原来都低于新的吸顶带 —— 已分别抬到 22／24；③ `--actual-record-text` 的深色值必须被推翻（P4-12 的「两主题共用深色前景」只在 82% 下成立）。
- **仍需用户决定**：§10.2 的四条（`.calendar-time-block` 的 `min-height` 用 px、时间块同类死规则、两套容器查询断点口径的分工、其余 3 处 `opacity` 是否收口）。

---

## 12. 复核后跟进（2026-10-17）

> 来源：用户批准修 §10.2 的第 1／2／3 条，**第 4 条（另外 3 处 `opacity`）本包不动**（见 §12.6）。
> 边界：不新增依赖、不碰 `src-tauri/`、不改任何全局 token 的值、不改统计口径、不改布局结构／间距／字号／缩放范围与预设、不碰 P4-04／P4-05 的滚动仲裁。
>
> **第三轮（同日，回退）**：两次换单位都被实测否定 —— `1.375rem` 与 `1.75rem` 在 200% 下都会把短块标题从 12px 压成 **0px**（机制见 §12.1.3）。`min-height` 已**回退到原值 `28px`**，100%／200% 四个数与改前逐项一致（§12.1.5）。§12.1 因此从「改了什么」改写为「为什么不能只换单位、本轮不做」；§12.7 原第 1／2 条并入 §12.1。两轮「改前／改后」截图已移入 `_quarantine/2026-10-17_p4-13-followup-shots/`，探针原始输出保留在 `followup/`。

### 12.0 本包改了哪些文件

| 文件 | 改动 |
| --- | --- |
| `src/styles.css` | ① `.calendar-time-block` 的 `min-height` **已回退到原值 `28px`**（`28px → 1.375rem → 1.75rem` 两轮试值都因 200% 回归被否，见 §12.1）；那一段说明注释改成**结论**（「不要换成 rem」＋指向 §12.1）。② 删掉 `@container (max-height: 26px)` 里针对 `.calendar-time-block` **自身**的两条死声明（附一段说明注释）。**这两处之外一个字符没动。** |
| `scripts/visual-evidence.mjs` | `actualRecordWorkspace()` 加一个 **15 分钟短时间块**（10:45–11:00）。原夹具只有一个 1 小时块（11:30–12:30，天然高 72px）—— 两档缩放都高于任何下限，**拍不出 §1 的对照**。短块放在数组首位，`crop` 里的 `.calendar-time-block`（`first()`）取到的就是它。 |
| `docs/design/UI-SPEC.md` | 「日历视图」段（`143` 行）加一条：两套按容器隐藏的断点口径 —— 按宽度用 px、按行数用 rem。 |
| `docs/PROJECT-GUIDE.md` | §10（`410` 行）加一条同义条目并指向 UI-SPEC。 |
| `docs/reports/phase-4-p4-13-implementation/followup/`（新建） | 保留**探针原始输出** 10 份（两轮改前／改后 8 份 + 回退后 `-reverted` 2 份）、`npm run check` 日志、四份 `sha256` 记录；两轮「改前／改后」截图（`before/`、`after/`、`before-v2/`、`after-v2/`，各 16 张）已随本次回退**移入** `_quarantine/2026-10-17_p4-13-followup-shots/`（见 §12.1.5）。 |

**⚠️ 取「改前」的办法与提示词不同（这一条本身是个坑）**：提示词说「`git checkout HEAD -- src/styles.css` 取快照」，但 **P4-13 的代码改动到本包开工时还没提交**（`git status` 里 `src/styles.css`／`e2e/phase1.spec.ts`／`scripts/visual-evidence.mjs`／`docs/PROJECT-GUIDE.md` 都还是 `M`），`HEAD`（`ecabdde`）里是 P4-13 **之前**的样式。照提示词做会把 P4-13 的改动一起退掉，「改前」组就不再是「本包改动前」。所以改用 **P4-13 §8 的字节级备份法**：先把工作区的 `src/styles.css` 原样 `cp` 成备份，拍「改前」时拷回、拍完立刻换回改动版并用 `sha256sum` 核对。

第二轮同样走这条路：改前（`min-height: 28px`）`sha256 = 50e7a6df…`，改后（`1.75rem`）`sha256 = 4f4428ed…`，两次都做到 `src/styles.css` 与备份逐字节一致。记录见 [`followup/p4-13-followup-v2-sha-before.txt`](phase-4-p4-13-implementation/followup/p4-13-followup-v2-sha-before.txt) 与 [`…-v2-sha-after.txt`](phase-4-p4-13-implementation/followup/p4-13-followup-v2-sha-after.txt)（第一轮为 `p4-13-followup-sha-{before,after}.txt`）。测量完成后只改过注释文字（把「标题行拿到 40px」改成实测结论），样式值与 dist 产物哈希均未变。**第三轮回退后**，`min-height` 与 `-v2-sha-before.txt` 那版**样式值一致**（同为 `28px`），只有说明注释换成了结论文字，故文件哈希不同。

### 12.1 ① `.calendar-time-block` 的 `min-height`：**已评估，本轮不做**（保持 `28px`）

#### 12.1.1 结论先行

`28px` 是原值，也是现在的值。**两次「只换单位」的尝试都被实测否定**，代码已回退，本轮零变化（§12.1.5）。

- `1.375rem`：100% 下块高 22px（比原值矮 6px，标题只剩 6px）；200% 下 44px，内容盒 28px 越过 `@container` 的 26px 阈值 → `time` 显形 → 标题 **0px**。
- `1.75rem`：100% 下正好 28px（这一档确实零变化）；200% 下 56px，内容盒 40px 同样越过 26px → `time` 显形 → 标题**仍是 0px**。

也就是说：**任何「抬 min-height」的改法，在 200% 下都会让标题从 12px 变成 0px，是回归。** 根因不在单位，在那条用 px 写的容器查询阈值（§12.1.3）。

顺带纠正 §10.2 第 1 条的一处事实错误：这条 `min-height` 一直是 **`28px`**，不是 `22px`（`22px` 是同一行 `padding: 6px 22px 8px 6px` 的值，以及另一个元素 `.calendar-actual-record` 的 `min-height`）。探针读到的 `minHeight` 在改前就是 `"28px"`。

#### 12.1.2 三次实测（同一夹具、同一探针）

夹具：日视图、`calendarScale.day = 72`、短块 10:45–11:00（15 分钟，天然高 18px，被 `App.tsx:1298` 的 1.25% 下限抬到 21.6px，再被 CSS `min-height` 兜住）。探针：`.workbuddy-ai/tmp/p4-13-layer-probe.mjs --scale=100|200` 的 E 段。

| `min-height` | 100% `strong` 高 | 100% `time` 的 `display` | 200% `strong` 高 | 200% `time` 的 `display` |
| --- | --- | --- | --- | --- |
| **`28px`**（原值／回退后） | **12px** | **`none`** | **12px** | **`none`** |
| `1.375rem` | 6px | `none` | **0px** | **`block`** |
| `1.75rem` | 12px | `none` | **0px** | **`block`** |

（`boxHeight`：`28px` 两档都是 28；`1.375rem` 为 22／44；`1.75rem` 为 28／56。`grid-template-rows`：`28px` 两档都是 `12px`；两个 rem 值在 200% 下都是 `44px 0px`。）

#### 12.1.3 机制：px 阈值 + 44px 时间行

三件事叠在一起：

1. `@container (max-height: 26px)` 按**内容盒**判定（P4-13 §5.3 已实测），而内容盒 = 块高 − 上下内边距 14px − 边框 2px。
2. `min-height` 一旦写成 rem，200% 下块高翻倍，内容盒就**越过 26px** → 查询不再命中 → `time` 从 `none` 变 `block`。
3. `time` 的行高是 `1.375rem`（200% 下 44px）。grid 两行共享内容盒，`time` 先拿满 44px；`strong` 带 `overflow: hidden`，其最小尺寸为 0，于是**只能拿到 0px**。

所以 `1.75rem` 的 40px 内容盒并没有「给标题 40px」——40px 全被 `time` 那一行吃掉，第二行是 0。它唯一改善的是时间行本身（44px 被裁到 40px，约 91% 可见）。相对改前的 12px，**标题 12 → 0 是实打实的回归**。

要真修，必须让 200% 下的查询**继续命中**，也就是把阈值换成 rem。但那会改变 100% 的隐藏范围 —— 见下一节。

#### 12.1.4 三种阈值方案的代价

阈值换成 rem 后，命中条件变成「内容盒 ≤ N rem」，而块高本身仍是 px（`--calendar-hour-height` 72px/小时，不随缩放走）。100% 下 `1rem = 16px`，200% 下 `1rem = 32px`：

| 阈值 | 100% 隐藏 `time` 的块高／时长 | 200% 隐藏 `time` 的块高／时长 | 相对现状改变了什么 |
| --- | --- | --- | --- |
| **`26px`（现状，不动）** | ≤42px／**≤35 分钟** | ≤42px／≤35 分钟 | — |
| `1.375rem`（22px／44px） | ≤38px／**≤31.7 分钟** | ≤60px／≤50 分钟 | 100%：**32–35 分钟**从「隐藏」变成「显示一条被裁的时间」；200%：短块恢复隐藏（**能修掉回归**） |
| `2.75rem`（44px／88px） | ≤60px／**≤50 分钟** | ≤104px／≤86.7 分钟 | 100%：**35–50 分钟**从「显示」变成「隐藏」；200%：**1 小时块的时间行也被隐藏** |

三种都各有代价，**没有免费的**：

- 保持 `26px`：100% 现状不变，但 200% 下只要有人把 `min-height` 抬成 rem 就回归；不抬则 200% 的短块标题永远被裁到只剩字形顶部（12px）。
- `1.375rem`：唯一能同时修掉 200% 回归的选项，代价是 100% 下 32–35 分钟这一档多出一条被裁的时间行。
- `2.75rem`：100% 与 200% 口径统一（都是「两行」），但隐藏范围大幅扩张，35–50 分钟这一档和 200% 的 1 小时块都会失去时间行。

这是**设计决策**（「短块在 200% 下应该显示什么」），不是单位换算。

#### 12.1.5 回退后的实测：四个数与改前一致

`min-height` 回退为 `28px` 后重跑探针（`--skip-build`，dist 已按新样式重建）：

| 缩放 | `boxHeight` | `grid-template-rows` | `time` 的 `display` | `strong` 高 |
| --- | --- | --- | --- | --- |
| 100% | **28px** | **`12px`** | **`none`** | **12px** |
| 200% | **28px** | **`12px`** | **`none`** | **12px** |

与改前那两版输出（`time-block-probe-100-before.txt`、`…-200-before.txt`，以及 `-before-v2`）逐项相同。1 小时块两档也仍是 71.98px／`22px 22px`／`block`／22px 与 71.98px／`44px 11.98px`／`block`／11.98px；`min-height` 的计算值两档都是 `"28px"`。

原始输出：[`followup/time-block-probe-100-reverted.txt`](phase-4-p4-13-implementation/followup/time-block-probe-100-reverted.txt)、[`…-200-reverted.txt`](phase-4-p4-13-implementation/followup/time-block-probe-200-reverted.txt)。

**证据处置**：两轮的「改前／改后」截图（`before/`、`after/`、`before-v2/`、`after-v2/`，各 16 张）在回退后不再对应任何代码差异，已整体 `mv` 到 `_quarantine/2026-10-17_p4-13-followup-shots/`（未删除，由用户在资源管理器里丢）。`followup/` 保留的是**探针原始输出**（它们记录的是机制，与最终取值无关）以及 `image-diff*.txt`／`visual-evidence-*.txt`／`sha256` 记录 —— 后三组描述的是已隔离的那批截图，仅作过程存档。

#### 12.1.6 结论

- **本轮不做**：`min-height` 保持 `28px`，`@container (max-height: 26px)` 一个字符不动，代码回到零变化。
- 要动它，先定「短块在 200% 下应该显示什么」（标题一行／时间一行／只图标），再选阈值 —— 三种取值的代价见 §12.1.4。
- §10.2 第 1 条的状态：**从「未修」改为「已评估、本轮不做，理由与方案见 §12.1」**。

### 12.2 ② 删掉 `@container (max-height: 26px)` 里的两条死声明

#### 12.2.1 删了哪两条、为什么

`src/styles.css:534`（改前）是：

```css
@container (max-height: 26px) { .calendar-time-block { padding-block: 2px; align-content: center; } .calendar-time-block time { display: none; } }
```

删掉的是 `.calendar-time-block { padding-block: 2px; align-content: center; }` 里的**两条声明**（整个内层规则块一起删），保留 `.calendar-time-block time { display: none; }`。

**为什么这两条是死的**：`@container` 只对容器的**后代**生效，而 `.calendar-time-block` 自己就是那个容器（`container-type: size`），它不可能是自己的后代。实测印证：探针在 100%／200%、改前／改后读到的 `alignContent` **一律是 `start`**、`paddingBlock` **一律是 `6px / 8px`** —— 那两条声明一次都没生效过（与 P4-13 §5.3 对 `.calendar-actual-record` 的同类结论一致）。

#### 12.2.2 剩下那条为什么是活的（实测）

`time` 是**后代**，所以 `.calendar-time-block time { display: none }` 有效。实测（改前，100%）：短块（高 28px）的 `timeDisplay` = **`"none"`** —— 命中了。

顺带把**判定用哪个盒子**也钉住了：容器查询按**内容盒**判定。短块 28px − padding 14px − 边框 2px = 内容盒 **12px ≤ 26px** → 命中；若按边框盒（28px > 26px）就不会命中，但实测命中，所以是内容盒。（`time` 高 0px、`strong` 12px 也印证 `time` 真的被隐藏了。）

**删除本身不改行为**：查询的**条件**没动，删掉的只是两条从未生效的自身声明。所以「剩下那条仍然生效」在 100% 下成立（实测 `display: none`）。**但只要 ① 把 `min-height` 抬成 rem，200% 下它就会被顶掉** —— 见 §12.1.3（本轮已回退，故不成立）。

### 12.3 ③ 两套断点口径写进文档

| 落点 | 内容 |
| --- | --- |
| [`docs/design/UI-SPEC.md`](../design/UI-SPEC.md)「日历视图」段（`143` 行，紧跟「时间分级以实际渲染高度为准」那条） | 新增一条：按容器隐藏信息两套口径不要混用 —— 断**宽度**用 **px**（`.calendar-session` 的 `124px`／`112px`／`100px`／`88px`，宽度不随界面缩放走）；断**可用高度（行数）**用 **rem**（`.calendar-actual-record` 的 `calc(4.125rem + 9px)`／`calc(2.75rem + 9px)`，行高随界面缩放走，写 px 会在 200% 下算错行数）。**并把时间块的 `min-height: 28px` 标成这条的例外**（第三轮回退后补写：它看似该用 rem，实则会制造 200% 回归，见 §12.1）。 |
| [`docs/PROJECT-GUIDE.md`](../PROJECT-GUIDE.md) §10（`410` 行，紧接「`@container` 只对容器的后代生效」那条） | 新增一条同义条目（两套口径都成立、别当成写错），并指向 UI-SPEC 的「日历视图」段；同样注明时间块 `min-height` 的例外。 |

### 12.4 `npm run check` 四步实测（2026-10-17，第三轮／回退后）

`npm run check` = `build && test && test:e2e && test:native`；E2E 按惯例单独加了 `--workers=1`（`npm run test:e2e` 本身不带这个参数），其余三步就是 `check` 里的原命令。

| 步骤 | 结果 |
| --- | --- |
| `npm run build`（`tsc --noEmit` + `vite build`） | 通过；dist CSS **81.61 kB** / JS **465.79 kB**（与基线和前两轮一致：`28px` 与 rem 的字符差被压缩器吸收） |
| `npm run test`（Vitest） | **293 / 24 文件**全通过（与基线一致）。首次执行有 1 条 `waitFor` 5s 超时（既有 flaky，与样式无关），立即重跑全绿 |
| `node scripts/run-e2e.mjs --workers=1`（Playwright） | **43** 全通过（与基线一致；本包未加用例） |
| `npm run test:native`（Rust） | **38** 全通过（无原生改动） |

原始日志：[`followup/npm-run-check-v3.txt`](phase-4-p4-13-implementation/followup/npm-run-check-v3.txt)（第二轮为 `npm-run-check-v2.txt`，第一轮为 `npm-run-check.txt`）。

### 12.5 本包自建的复现入口

| 入口 | 用途 |
| --- | --- |
| `node .workbuddy-ai/tmp/p4-13-layer-probe.mjs [--skip-build] [--scale=100\|200]` | 图层探针（P4-13 建）＋ 本包新增的 **E 段**：时间块的 `boxHeight`／`grid-template-rows`／`minHeight`／`paddingBlock`／`alignContent`／`time` 的 `display`／`strong` 高度。**未入库**（过程工具） |
| `node scripts/visual-evidence.mjs --only actual-record --out output/visual-p4-13-followup-before-v2` | 拍「改前」（先 `cp` 28px 字节级备份覆盖 `src/styles.css`） |
| `node scripts/visual-evidence.mjs --only actual-record --skip-build --out output/visual-p4-13-followup-after-v2` | 拍「改后」（换回 `1.75rem` 版并核对 sha） |
| `node .workbuddy-ai/tmp/p4-13-image-diff.mjs <改前目录> <改后目录>` | 逐像素对比。**未入库** |
| `node .workbuddy-ai/tmp/p4-13-v2-timeblock-detail.mjs --scale=100\|200` | 第二轮诊断：时间块及其 5 个子元素的盒子／`grid-row`／`line-height`，用来定位「内容盒 40px 为什么没给到标题」。**未入库** |

> 上表前两条 `visual-evidence` 是**当时**拍改前／改后的方法记录；对应截图已随回退移入 `_quarantine/2026-10-17_p4-13-followup-shots/`，命令本身仍可用于复现（`--only actual-record`）。

### 12.6 未做

1. **§10.2 第 4 条（另外 3 处 `opacity`）本包未动**：`.calendar-shift-preview` 的 `.55`、`.calendar-time-block.is-resizing[data-resize-edge="move"]` 的 `.55`、`.calendar-session.is-resizing` 的 `.85`。它们是**拖动中的临时态**，表达的是「正在动」而不是「不重要」，也不承载必须达标的文字 —— 与 UI-SPEC 那条「不用整体透明度做**去强调**」不冲突。用户已说明这条写进已知边界，由用户处理。
2. **`min-height` 本轮不做**：两轮 rem 试值（`1.375rem`／`1.75rem`）都在 200% 下制造了标题 12 → 0px 的回归，代码已回退到原值 `28px`（见 §12.1）。
3. **不把 `@container (max-height: 26px)` 的阈值换成 rem**：那会改变 100% 的隐藏范围（三种取值的代价见 §12.1.4），属设计决策。因此 200% 下短块标题仍是被裁的 12px —— 本轮只保证零回归，不保证修好。
4. 不新增依赖、不碰 `src-tauri/`、不改全局 token 值、不改统计口径与 D1–D6、不改 P4-07／P4-08／P4-11／P4-12／P4-13 的已拍板结论、不碰 P4-04／P4-05 的滚动仲裁与「程序性滚动不写偏好」闸门。
5. 未在真机桌面（Tauri release + NSIS）复测 —— 属 P4-10。

### 12.7 本包发现的另一处不一致（保留，未改）

> 原第 1 条（200% 下 `time` 与标题争同一行）与原第 2 条（`min-height` 取值）讲的是同一件事，已并入 §12.1。

**第 3 条（顺带发现，未改）：时间轴还有一条**独立的**、同样不随界面缩放走的 px 下限。**

`App.tsx:1298` 的 `height: ${Math.max(duration / 1440 * 100, 1.25)}%` —— 百分比看似随缩放走，但它的基准（`--calendar-hour-height`）本身是 px，所以这个下限折算下来是 `0.3 × hourHeight`（72px 时 = **21.6px**，恒等于 18 分钟的高度），**与界面缩放无关**。它目前低于 CSS 下限（`28px`），所以不是当前的约束方；但一旦有人把 CSS 下限调到 21.6px 以下，它就会接管。记录在此，本包不动（属 P4-13 之外的排程逻辑）。
