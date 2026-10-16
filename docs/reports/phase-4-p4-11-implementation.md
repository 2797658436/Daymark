# 阶段 4 P4-11 实施记录：日历页网格 ARIA 结构修正

> 工作包：`docs/reports/phase-4-open-decisions.md` §7.2 拍板单开的 **P4-11**（提示词 `docs/reports/phase-4-p4-11-kickoff-prompt.md`）。  
> 对应验收：**AC14** 的自动无障碍部分（浅／深 × 960×200% 逐页 axe）—— 把 P4-09 钉住的两条日历违规归零。  
> 规格依据：`docs/specs/0005-phase-4-daily-workflow-and-reliability.md` §10（M12）、§12（S0–S3 分级）。  
> 顺序依据：本包**在 P4-10（原生验收与发布）之前**完成 —— 发布包包含修复，AC14 的 axe 证据干净；`phase-4-open-decisions.md` §7.2 已写明「不要在 P4-10 的隔离验收跑完之后再合入」。

---

## 1. 范围与交付清单

### 1.1 修改的代码

| 文件                               | 改动                                                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/App.tsx`（`MonthCalendar`）   | 42 个格子按 6 行分组：`role="grid"` 的子节点变成 7 个 `role="row"`（表头 1 行 + 日期 6 行），`columnheader`／`gridcell` 落到行里。                                                       |
| `src/App.tsx`（`CalendarDay`）     | 周视图的 `.day-track` 从 `role="gridcell"` 改为 `role="group"`，选中态从 `aria-selected` 改为 `aria-current`；日列本身加 `role="group"` + 日期名。日视图（无 `onWeekGridNavigate`）行为不变。 |
| `src/App.tsx`（`CalendarSession`） | 删掉纯展示状态图标上多余的 `aria-label`（axe `aria-prohibited-attr`，见 §7.1）。                                                                                             |
| `src/styles.css`                 | `.month-calendar` 外层改为单列 7 行，新增 `.month-calendar-row`（7 列）；窄容器下的 `.with-detail .month-calendar` 规则改指向行。**几何不变**（§4.3 逐字节证明）。                               |

### 1.2 修改与新增的测试

| 文件                            | 改动                                                                                                                                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/App.test.tsx`            | 月视图结构回归（7 行 × 7 格、`grid` 下无非 `row` 子节点）；周视图两处 `getByRole` 由 `gridcell` 改 `group`、`aria-selected` 改 `aria-current`；周键盘用例补 `ArrowUp`／`ArrowLeft`／`PageDown` 断言（§6）。                                                                                        |
| `e2e/phase1.spec.ts`          | 逐页 axe 用例：`KNOWN_CALENDAR_DEFECT`／`KNOWN_CALENDAR_DEFECT_MONTH` 两个常量**删除**，日／周／月三条视图一律断言 `[]`（日视图此前从未被 axe 覆盖）；M6 用例里周网格的 `gridcell` 查询改 `group`；**新增** 1 条用例 `phase 4 M12 keeps the calendar page clean with session status icons and all-day markers`。 |
| `scripts/visual-evidence.mjs` | 加 4 个日历页场景（周／月 × 1200／960）与 `--out <dir>`（P4-09 的 AC14 截图清单里本来就没有日历页）。                                                                                                                                                                                   |

**没有**新增依赖、没有新增 SQLite 迁移或字段（schema 仍 v7）、没有新增 Tauri Command、没有改统计口径、没有改 D1–D6 与 P4-07／P4-08 的结论、没有改 P4-04／P4-05 的滚动仲裁。

---

## 2. 语义模型决策（本包的核心）

### 2.1 月视图：标准 6×7 表，无争议

`grid → row → columnheader／gridcell`。表头那一行也必须是 `role="row"` —— `columnheader` 的必需上下文同样是 `row`，P4-09 记录的 49 个违规节点里 7 个正是表头。

改法是**把 7 列搬到行上**：外层 `.month-calendar` 只排 7 行（`grid-template-rows: 42px repeat(6, …)`，单列），每行 `.month-calendar-row` 自己排 7 列。几何与改前完全等价：

- `.month-calendar [role="gridcell"]:nth-child(7n) { border-right: 0 }` 仍然成立（每行恰好 7 个格子，第 7 个就是 `:nth-child(7n)`）；
- 行内格子默认 `align-items: stretch`，高度仍由行轨道给出，所以「固定六行、切月不跳高」的既有行为不变；
- 窄容器覆盖层规则 `.with-detail .month-calendar { grid-template-columns: repeat(7, …) }` 改指向 `.month-calendar-row`（否则那 7 列会落在外层的单列上，格子被压成一列）。

### 2.2 周视图：在 A／B／C 之间选 **B（不当网格）**

| 方案      | 做法                                           | 本包结论                                     |
| ------- | -------------------------------------------- | ---------------------------------------- |
| A 单行网格  | `grid → row → 7 × gridcell`                  | **不选**                                   |
| B 不当网格  | 去掉 `role="gridcell"`，日列与时间光标用 `group` + 可访问名 | **选它**                                   |
| C 真二维网格 | 渲染时间行，做成 7 × N 的 grid                        | **不选**（提示词已排除：与「连续时间轴」的既有实现冲突，等于重做周视图渲染） |

**为什么是 B：**

1. **A 会声称一个不存在的结构，而且这个谎是有代价的。** 周视图 DOM 里只有 7 个日列，每列是一条 24 小时连续时间轴，没有「行」。方案 A 只能给出「第 1 行、共 1 行」这个恒为真的行维度，而它换来的「列号」信息其实**已经写在元素的可访问名里**（`2026-08-12 09:00 空白时间`），屏幕阅读器本来就能念出日期与时间。用一个假的表格结构换一句已经能听到的话，不划算。
2. **A 的「最小改动」是假的。** 要把 7 个日列包进一行，就必须加一层 wrapper；而 `.week-body` 本身是 CSS 网格（`58px repeat(7, …)`），wrapper 要么用 `display: contents`（提示词已明确禁止：部分引擎会把它从无障碍树里摘掉、role 直接失效），要么真的重排 CSS 网格列。后者会牵动 `.week-body`、`.time-axis`、`.calendar-day` 的列定义与窄容器规则 —— 与「不改视觉」的边界直接冲突，风险远大于收益。
3. **A 的方向键语义也不自洽。** 在 1 行网格里 `ArrowUp`／`ArrowDown` 标准含义是「上下移动一行」，而这里的上下是「在同一列里挪 15 分钟」。ARIA 网格模式套不住这套交互，套上去反而给屏幕阅读器用户一个错误的预期。方案 B 干脆不声称模式，把「方向键怎么走」交给键盘说明（§2.4）。
4. **B 是诚实的**：7 个日列各自是一条时间轴 —— 这正是 `group`（一组相关内容）能表达的东西。

**B 的具体形态：**

```html
<div class="calendar-day" data-day-date="2026-08-03" role="group" aria-label="2026-08-03 8月3日星期一">
  <div class="day-track" role="group" tabindex="-1"
       aria-label="2026-08-03 09:00 空白时间"
       aria-current="true">   
    …
  </div>
</div>
```

- **日列**（`.calendar-day`）拿到了名字。这是顺带修掉的真实缺口：周视图的日期头在**另一个吸顶容器**（`.week-date-headers`）里，日列自身此前在无障碍树里是**无名的**，屏幕阅读器用户浏览列内容时没有任何日期上下文。
- **时间光标**（`.day-track`）的可访问名**一字未改**（`日期 + 时间 + 空白时间`），所以既有键盘用例里的 `toHaveAccessibleName(...)` 断言原样保留。
- **选中态改 `aria-current`**：`aria-selected` 在 `group` 上是非法属性（会触发 `aria-allowed-attr`）；「当前这一列正是右侧详情展示的那一天」用 `aria-current="true"` 表达更贴切。未选中时不输出该属性（不用 `aria-current="false"`）。

### 2.3 非单元格子节点怎么标注（P4-09 §4.2 点名的难点）

| 子节点                                                                               | 位置                                      | 决定                                                                 | 理由                                                                                                                                                                 |
| --------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 时间轴 `.time-axis`（周）                                                               | `.week-body` 的直接子元素，与 7 个日列并列           | **保持普通布局容器**：无角色、无 `aria-hidden`、无 `aria-label`                    | 它是视觉标尺而不是单元格；`role="grid"` 移除后没有任何必需上下文需要满足（axe 改前改后都没报过它）。整日刻度的文字是「一周从 00:00 到 24:00」的唯一说明，把它 `aria-hidden` 掉是**减少信息**而不是降噪。日视图共用同一个组件，隐藏会连带影响日视图。                |
| 全天区 `.week-all-day`                                                               | 吸顶头部 `.week-sticky-header` 里，**不在**网格体内 | **保持** `<section aria-label="全天标记">`（region + 名字），里面的旗帜／菱形仍是带名字的按钮 | 它本来就在网格体外，与 `grid` 的必需子元素无关；既有语义（一个有名字的区域 + 可聚焦按钮）是对的，没有需要修的地方。                                                                                                    |
| 周日期头 `.week-date-headers`                                                         | 同上，吸顶头部                                 | **保持**普通 `div` + 7 个按钮                                             | 每个日期头本身就是可聚焦按钮（`打开 2026-08-05 … 日视图`），语义完整；容器不需要额外角色。                                                                                                              |
| 拖拽预览 `.calendar-drag-ghost`（周）／`.calendar-drag-preview`（日列内）                      | 网格体内／日列内                                | **保持** `role="status"` + `aria-label="拖拽排程预览"`                     | UI-SPEC「无障碍、缩放与高密度数据」明确要求：拖拽的拾起、合法落点、放置和取消通过**礼貌级实时区域**播报。实时区域不是单元格，在任何容器角色下都合法；`role="status"` **不能**换成 `aria-hidden`（那会删掉规格要求的能力）。                               |
| 插入线 `.calendar-insert-line`、后移预览 `.calendar-shift-preview`、落点虚线框、当前时间线、折叠条、空白选择预览 | 日列内                                     | **保持现状**                                                           | 它们要么已有 `aria-hidden="true"`（纯视觉），要么是可聚焦的按钮（折叠条、展开入口）。插入线是「无角色的 div + aria-label + 可见文字」，实测不触发 `aria-prohibited-attr`（axe 该规则只在元素**没有可见文字**时才判违规）—— 见 §7.2 的同类风险提示。 |

### 2.4 键盘语义不变（回归红线）

方向键、`PageUp`／`PageDown`、`Enter`／空格、`Tab` 进出的**行为**一行未改，改的只是承载它们的角色的名字。周视图「上下改分钟、左右换日列」这套交互不在任何 ARIA 模式里，因此它本来就只能靠快捷键说明表达 —— UI-SPEC §133 已经写明这条口径，本包**没有**改 UI-SPEC：方案 B 与既有规格文本一致，不需要新增文案。

---

## 3. DOM 结构改前／改后

### 3.1 月视图

```html

<div class="month-calendar" role="grid" aria-label="月历">
  <div role="columnheader" aria-label="周一">周一</div> …×7
  <div role="gridcell" data-month-date="2026-07-27" …>…</div> …×42
</div>


<div class="month-calendar" role="grid" aria-label="月历">
  <div class="month-calendar-row" role="row">
    <div role="columnheader" aria-label="周一">周一</div> …×7
  </div>
  <div class="month-calendar-row" role="row">
    <div role="gridcell" data-month-date="2026-07-27" …>…</div> …×7
  </div>
  …共 6 个日期行
</div>
```

### 3.2 周视图

```html

<div class="calendar-viewport week-viewport" role="region" aria-label="日历时间网格">
  <div class="week-calendar-layout"><div class="week-calendar-main">
    <div class="week-sticky-header">
      <div class="week-date-headers" aria-label="周日期头">…7 个按钮…</div>
      <section class="week-all-day" aria-label="全天标记">…</section>
    </div>
    <div class="calendar-grid week week-body">
      <div class="time-axis without-header">…</div>
      <div class="calendar-day" data-day-date="2026-08-03">
        <div class="day-track" role="gridcell" tabindex="-1"
             aria-label="2026-08-03 09:00 空白时间" aria-selected="false">…</div>
      </div>
      …×7
    </div>
  </div></div>
</div>


<div class="calendar-grid week week-body">            
  <div class="time-axis without-header">…</div>        
  <div class="calendar-day" data-day-date="2026-08-03"
       role="group" aria-label="2026-08-03 8月3日星期一">
    <div class="day-track" role="group" tabindex="-1"
         aria-label="2026-08-03 09:00 空白时间">…</div>
  </div>
  …×7
  <div class="calendar-drag-ghost" role="status" aria-label="拖拽排程预览">…</div>
</div>
```

### 3.3 CSS

```diff
-.month-calendar { … display: grid; grid-template-columns: repeat(7, minmax(86px, 1fr));
-  grid-template-rows: 42px repeat(6, minmax(var(--calendar-month-row-height), 1fr)); }
+.month-calendar { … display: grid; grid-template-columns: minmax(0, 1fr);
+  grid-template-rows: 42px repeat(6, minmax(var(--calendar-month-row-height), 1fr)); }
+.month-calendar-row { display: grid; grid-template-columns: repeat(7, minmax(86px, 1fr)); }

 @container (max-width: 1040px) {
-  .with-detail .month-calendar { grid-template-columns: repeat(7, minmax(0, 1fr)); }
+  .with-detail .month-calendar-row { grid-template-columns: repeat(7, minmax(0, 1fr)); }
 }
```

---

## 4. axe 结果

### 4.1 逐视图原始输出（960×720 视口 + 应用内缩放 200%，生产构建 + 真实 Chromium）

样本比 E2E 的回顾夹具更「满」：2 个项目、2 个里程碑、4 个任务、4 个时段（含 1 个 `missed` → 会渲染状态图标）、1 条实际记录、2 条进度事件、1 个时间块，并**开启**「显示实际记录」（为的是把 §7.1 那条缺陷一起测出来）。原始输出入库在 [`axe-960x200-before.txt`](axe-960x200-before.txt)／[`axe-960x200-after.txt`](axe-960x200-after.txt)。

| 视图 | 改前（浅）                                                                   | 改前（深）                                               | 改后（浅）                       | 改后（深） |
| -- | ----------------------------------------------------------------------- | --------------------------------------------------- | --------------------------- | ----- |
| 日  | 零违规                                                                     | 零违规                                                 | 零违规                         | 零违规   |
| 周  | `aria-prohibited-attr` ×1、`aria-required-parent` ×7、`color-contrast` ×1 | `aria-prohibited-attr` ×1、`aria-required-parent` ×7 | `color-contrast` ×1（见 §7.1） | 零违规   |
| 月  | `aria-required-children` ×1、`aria-required-parent` ×49                  | 同左                                                  | 零违规                         | 零违规   |

- 改前 `aria-required-parent` 的 7 个节点就是 7 个 `.day-track`（`div[aria-label="2026-08-0X 09:00 空白时间"]`，`role="gridcell"`）；月视图的 49 个节点 = 7 个 `columnheader` + 42 个 `gridcell`。
- 改后**三条视图 × 两种主题**都不再有 ARIA 结构违规。唯一残留是 §7.1 的对比度缺陷，它只在「显示实际记录」打开时出现，**不在**验收口径内（验收夹具不开这一项）。

### 4.2 E2E 里的验收断言

`phase 4 M12 has no automated accessibility violations on every page at 960 and 200 percent in light and dark`：

- 7 个页面 × 浅／深；日历页再按 **日 → 周 → 月** 各断言一次 `[]`（改前这里跑的是两个「已记录缺陷」常量）；
- `KNOWN_CALENDAR_DEFECT`／`KNOWN_CALENDAR_DEFECT_MONTH` **已从代码里删除**，注释改写为「结构已按方案 B／标准重排修正，三条视图零违规」；
- 另加一条用例把「有状态图标」这一态单独钉住（P4-09 的回顾夹具里没有 `missed` 时段，所以那条用例看不见状态图标）。

### 4.3 视觉证据：改前／改后**逐字节相同**

`node scripts/visual-evidence.mjs --only calendar --out output/visual-p4-11-{before,after}`（生产构建 + 真实 Chromium + 固定数据 + 固定时钟 `2026-08-05T12:00`）：

| 文件                    | 尺寸       | 改前 SHA-256（前 12 位） | 改后     |
| --------------------- | -------- | ------------------ | ------ |
| `calendar-week-1200`  | 1200×760 | `891d37f13e8b`     | **相同** |
| `calendar-month-1200` | 1200×760 | `d30ae634d0a1`     | **相同** |
| `calendar-week-960`   | 960×760  | `c4935b6e1826`     | **相同** |
| `calendar-month-960`  | 960×760  | `45597301e561`     | **相同** |

4 张全部**逐字节一致**（用 `.workbuddy-ai/tmp/p4-11-image-diff.mjs` 比对，先比 SHA-256，不一致才退回 canvas 逐像素比对）。这比「看图差不多」强得多：结构重排对视觉的影响是 **0 个像素**。8 张图（改前／改后各 4 张）入库在本目录。

> 改前截图是在 `git stash push -- src/App.tsx src/styles.css` 之后构建的，取完立刻 `git stash pop`；`src/App.tsx` 的 SHA-256 在 pop 前后一致，`src/styles.css` 经 git 的 CRLF 归一化后与「HEAD + 本包改动」的重建结果**逐字节相同**（已单独核对）。



---

## 5. 键盘回归证据

| 路径 | 用例 | 覆盖 |
| --- | --- | --- |
| 周视图时间网格 | `src/App.test.tsx` › `moves week header and time-grid focus with keyboard without creating until Enter` | `ArrowDown`／`ArrowUp` 改分钟、`ArrowRight`／`ArrowLeft` 换日列、`PageDown`／`PageUp` 换周、焦点移动**不**打开气泡、`Enter` 打开「空白时段操作」并预填 `09:15–09:45`。**本包新补** `ArrowUp`／`ArrowLeft`／`PageDown` 三条断言（原来只测了 `ArrowDown`／`ArrowRight`／`PageUp`）。 |
| 周视图日期头 | 同上 | `ArrowRight`／`ArrowLeft`／`PageDown` 在日期头之间移动、`Enter` 打开日视图。未改。 |
| 周视图 `Tab` | 同上 + `opens a focused week session with Enter` | 日列里的卡片仍可聚焦并 `Enter` 打开编辑气泡。未改。 |
| 月视图网格 | `src/App.test.tsx` › `navigates the month grid without selecting until Enter` | 四方向键、`Home`／`End`、`PageUp`／`PageDown`、`Enter` 选中并打开右侧摘要、焦点与选中分离。未改。 |
| 月视图结构 | `src/App.test.tsx` › `renders month view as a fixed six-week grid starting on Monday` | **新增**断言：`grid` 下恰好 7 个 `row`、表头行 7 个 `columnheader`、6 个日期行各 7 个 `gridcell`、`grid` 下没有非 `row` 子节点。 |
| E2E 周／月键盘 | `e2e/phase1.spec.ts` › `phase 3 M6 exposes month summaries, week all-day overflow and keyboard navigation` | 月格方向键 + `Enter` 开详情；周日期头 `PageDown`；周网格 `ArrowDown` + `Enter` 开空白气泡（`gridcell` 查询已改 `group`）。 |
| 三视图 axe | `e2e/phase1.spec.ts` 的两条 M12 用例 | 日／周／月 × 浅／深，960×200%。 |

`npm run check` 四步全绿（见 §9）。**没有放宽任何既有断言**：改动只有「角色改名」「属性改名」和「新增断言」三类。

---

## 6. 测试查询改名逐条说明

周视图从「声称是网格」改成「不声称」之后，凡是按 `gridcell` 找周视图时间光标的查询都必须跟着改。逐条列在这里：

| 位置 | 改前 | 改后 | 为什么 |
| --- | --- | --- | --- |
| `src/App.test.tsx`（`shows two all-day deadline rows …`） | `getByRole("gridcell", { name: /2026-08-05 09:00 空白时间/ })` + `toHaveAttribute("aria-selected", "true")` | `getByRole("group", { name: … })` + `toHaveAttribute("aria-current", "true")` | 角色换名；`aria-selected` 在 `group` 上非法，选中态改由 `aria-current` 表达。断言强度不变（仍然断言「这一列被标成当前选中」）。 |
| `src/App.test.tsx`（`moves week header and time-grid focus …`） | `getByRole("gridcell", { name: "2026-08-12 09:00 空白时间" })` | `getByRole("group", { name: "2026-08-12 09:00 空白时间" })` | 同上。**可访问名一字未改**，所以同用例里 `toHaveAccessibleName("2026-08-12 09:15 空白时间")` 等 6 条断言原样保留。 |
| `e2e/phase1.spec.ts`（M6） | `getByRole("gridcell", { name: "2026-08-12 09:00 空白时间" })` | `getByRole("group", { name: … })` | 同上。 |
| `src/App.test.tsx` ×4、`e2e/phase1.spec.ts` ×2、`e2e/gui-optimization.spec.ts` ×1 的**月视图** `gridcell` 查询 | 未改 | 未改 | 月视图仍然是真正的网格，`gridcell` 是正确语义。 |
| `src/App.test.tsx` 的 `getAllByRole("columnheader", …)`、`monthGrid.querySelectorAll('[role="gridcell"]')` | 未改 | 未改（另加结构断言） | 同一份语义在新结构下依然成立（`querySelectorAll` 是后代查询，不要求直接子元素）。 |

> 结论：**没有为了让测试变绿而放宽任何断言**。三条查询改名都是「角色改名」的机械跟随，每条都在这里说明理由。

---

## 7. 发现的既有缺陷（P4-09 那两条之外）

探针用的是比 E2E 夹具更满的样本，因此照出了两条 P4-09 没看见的问题。两条都**不是** P4-09 引入的，也与本包要修的网格结构无关。

### 7.1 实际记录叠加层的文字对比度 2.82（**记录不改**）

- 现象：浅色主题 + 「显示实际记录」开启时，`.calendar-actual-record > strong` 是**白字配 `#da845e` 底色**，对比度 **2.82**，低于 4.5:1（字号 23.04px、常规字重，不属于大字号豁免）。axe `color-contrast`（serious，wcag2aa／1.4.3）。
- 成因：`src/styles.css` 的 `.calendar-actual-record { background: color-mix(in srgb, var(--accent) 82%, var(--panel)); color: var(--action-text); }` —— 82% 的 accent 与浅色面板混合后变浅，白字就压不住了。**与缩放无关**（100% 下字号更小，同样不达标）。
- **为什么不修**：修它必须改配色，而本包的边界明确写着「不改视觉：不为了 ARIA 去改配色」。它落在浅／深主题专项或 P4-10 之后的无障碍收口包里更合适。深色主题不违规。
- 影响面：只有用户主动打开「显示实际记录」时才会出现；计划层、任务卡、键盘路径都不受影响。
- 已做的处置：E2E 的两条日历 axe 用例**不开启**这一项（并在注释里写明原因），原始证据在 §4.1 的表里如实列出。

### 7.2 `span[aria-label]` 这一模式（本包**已修**，并留了护栏）

- 现象：`.session-status-icon`（纯展示的状态图标）挂着 `aria-label`，而 `span` 的隐式角色是 `generic`，ARIA 1.2 禁止 `generic` 被命名 → axe `aria-prohibited-attr`（serious，wcag2a／4.1.2）。**这不是「少个名字」而是「名字被丢弃」**：周视图在 960×200% 下每列不足 100px，容器查询 `@container (max-width: 100px)` 会把里面的状态文字 `display: none`，于是这个 span 既没有可见文字、名字又被丢弃，状态彻底读不到。
- 为什么 P4-09 没发现：它的逐页 axe 跑在回顾样本上，日历里没有 `missed` 时段，就不会渲染这个图标。
- **修法（纯 ARIA、零视觉）**：删掉那个多余的 `aria-label`。状态本来就写在卡片自己的可访问名里（`${task.title}，${start} 至 ${end}，${status.label}`），所以**没有丢信息**。可交互的「待回顾」入口是 `<button>`，`aria-label` 合法，保持不变。
- 护栏：新增 E2E 用例 `phase 4 M12 keeps the calendar page clean with session status icons and all-day markers`，夹具里带一个 `missed` 时段（会渲染该图标），并**先断言图标真的出现过**，避免空跑。
- 同类风险提示：`.calendar-insert-line` 也是「无角色的 div + aria-label」，它目前**有**可见文字（`插入并后移`），所以 axe 的 `has-visible-text` 检查放行、实测不违规。若将来它的文字被隐藏，就会触发同一条规则。

---

## 8. 未做与边界

- **不改视觉**：只做了 §3.3 那处结构性最小改动（把 42 个格子包进 6 行），并用逐字节截图证明 0 像素变化。配色、间距、字号、缩放范围与预设一律未动 —— 因此 §7.1 的对比度缺陷**记录不改**。
- **不改 D1–D6**（`phase-4-open-decisions.md` §0.5）与 **P4-07／P4-08** 的已拍板结论（同文 §5／§6）。
- **不改 P4-04／P4-05** 的滚动仲裁与「程序性滚动不写偏好」闸门；本包没碰 `useCalendarViewport`。
- **不新增依赖**、**不碰 `src-tauri/`**（`npm run test:native` 38 条与改前一致，Rust 侧零改动）。
- **不选方案 C**（真二维网格），理由见 §2.2。
- 日视图的 ARIA 结构**未改**：它本来就不是网格（`.day-track` 没有 `onWeekGridNavigate`，也就没有 `gridcell`），改前改后 axe 都零违规。本包只是把它**纳入**了 axe 覆盖（此前从未被检查过）。
- 未在真机桌面（Tauri release + NSIS）上复测 —— 属 P4-10。

---

## 9. 验证记录

### 9.1 `npm run check`（四步）

| 步骤 | 结果 |
| --- | --- |
| `npm run build`（`tsc --noEmit` + `vite build`） | 通过；dist CSS **81.31 kB** / JS **465.79 kB**（P4-09 基线 81.24 / 465.54；本包 +0.07 kB CSS、+0.25 kB JS） |
| `npm run test`（Vitest） | **293 / 24 文件**全通过（数量与 P4-09 基线一致：本包只**扩展**既有用例，未新增用例） |
| `npm run test:e2e`（Playwright） | **40** 全通过（P4-09 基线 39；本包 +1 条日历 axe 用例） |
| `npm run test:native`（Rust） | **38** 全通过（无原生改动） |

### 9.2 本包自建的复现入口

| 入口 | 用途 |
| --- | --- |
| `PW_TRACE=1 node scripts/run-e2e.mjs --workers=1 -g "M12 has no automated accessibility"` | 跑验收断言并保留 trace |
| `PW_TRACE=1 node scripts/run-e2e.mjs --workers=1 -g "status icons and all-day markers"` | 跑新增的「有状态图标」用例 |
| `node scripts/visual-evidence.mjs --only calendar --out output/visual-p4-11-after` | 重拍日历页截图（`--skip-build` 可复用 dist） |
| `.workbuddy-ai/tmp/p4-11-axe-probe.mjs` | 开发期用的逐视图 axe 探针（打印违规 id + 命中节点 HTML + 失败原因）。**未入库**：它是过程工具，验收的正式复现入口是上面两条 E2E 命令 |
| `.workbuddy-ai/tmp/p4-11-image-diff.mjs` | 改前／改后逐像素对照（先比 SHA-256，再退回 canvas 比对） |

### 9.3 未在本包验证

- 真机桌面（Tauri release + NSIS）下的 axe 与缩放矩阵 —— 属 P4-10。
- 屏幕阅读器实机朗读（NVDA／讲述人）—— 本包只能给出「axe 零违规 + 结构符合 ARIA 1.2 必需上下文」这一层证据，**不声称**已做过实机听读。

---

## 10. 汇报摘要

- **改了哪些文件**：`src/App.tsx`（`MonthCalendar` 分行、`CalendarDay` 角色改名、`CalendarSession` 删多余 `aria-label`）、`src/styles.css`（`.month-calendar`／`.month-calendar-row`）、`src/App.test.tsx`、`e2e/phase1.spec.ts`、`scripts/visual-evidence.mjs`（+4 个日历场景、`--out`）；新增本报告与证据目录 `docs/reports/phase-4-p4-11-implementation/`（8 张改前／改后截图 + 2 份 axe 原始输出）。
- **语义方案**：月视图走标准 `grid → row → columnheader／gridcell`（6 个日期行 + 1 个表头行）；周视图选 **方案 B（不当网格）** —— 日列与时间光标是 `group` + 可访问名，选中态 `aria-current`；时间轴保持普通容器，全天区／拖拽预览保持原有 region／`role="status"`。
- **axe 结果**：960×200% 下日／周／月 × 浅／深，ARIA 结构违规**全部归零**（改前周 7 个 `aria-required-parent`、月 1+49 个 `aria-required-children`／`parent`）。两条「已记录缺陷」常量已删除。
- **视觉**：改前／改后 4 张日历截图**逐字节相同**。
- **发现的不一致**：2 条 —— ① `.calendar-actual-record` 白字对比度 2.82（**需改配色，超出本包边界，记录不改**）；② `.session-status-icon` 的 `aria-prohibited-attr`（**已修**并加了护栏）；另有 1 条同类风险提示（`.calendar-insert-line`，当前不违规）。
- **仍需用户决定**：① §7.1 的对比度缺陷由哪个包收口（建议并入 P4-10 之后的主题／无障碍收口包，或与 P4-10 的真机复测一起处理）；② 是否要把「周视图方向键语义」正式写进 UI-SPEC 的快捷键说明（本包判定**不需要**：UI-SPEC §133 的既有文本已经覆盖）。
