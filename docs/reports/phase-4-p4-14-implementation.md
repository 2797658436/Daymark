# 阶段 4 P4-14 实现报告：回顾页「成果与待续」的保留判定、排版与密度收口

> 本包在规格工作包表之外（同 P4-11／P4-12／P4-13）。**没有改规格 §7.4 的段落顺序**，只动「成果与待续」这一段内部的排版与信息取舍。
> 测量条件除特别说明外均为：1440×900、浅色、100% 缩放、`output/review-seed.json` 的数据、`reviewAnchorDate: 2026-10-19`。

## 1. 保留判定

三块**一块都没删**。逐条复核后的结论：

| 块 | 保留理由 | 本包的处理 |
| --- | --- | --- |
| 待回顾 | 全页唯一的「补数据入口」。上面 267 分钟／+40 百分点可不可信，取决于这里有没有处理；`pendingReview` 是 `isPendingReview` 的投影，删掉就没有界面出口 | 保留；空时整块不渲染、降级为脚注；条目补了引擎算好的时长 |
| 里程碑 | 回顾页别处看不到的截止风险；`frozen` 的「到期冻结，后续推进不改写」是规格 §7.3 的验收点 | 保留；条数上标题，达成态加图标 |
| 继续推进 | `CONTEXT.md` 把「待续任务」定义成领域概念，`review.ts` 已算出 4 种 `carryoverReasons`，明细区也在用；删掉摘要块，「待续」就只剩顶部一个数字 | 保留；从「名单墙」改成「理由摘要 + 名单」 |

**复核结论**：三块的信息互不重叠 —— 待回顾回答「要不要补记录」，里程碑回答「有没有到期风险」，继续推进回答「还剩什么」。真正重复的是**总账行**，不是任何一块。

## 2. 删掉总账行（证据）

### 2.1 三个数字各出现两次（改前，实测文本）

| 位置 | 实测文本 |
| --- | --- |
| 顶部 `.review-stats` | `267 分钟实际投入` ／ `+40 百分点净进度 3 项有进度变化` ／ `1 项完成 2 项仍可继续` |
| `.review-outcome-summary`（总账行） | `3 项有进度变化 · 2 项仍可继续安排 · 1 项完成` |

三个数字一个不落，全部重复。删掉后实测：

```
stats: ["267 分钟实际投入", "+40 百分点净进度3 项有进度变化", "1 项完成2 项仍可继续"]
summaryExists: false
counts: { 项有进度变化: 1, 项仍可继续: 1, 项完成: 1 }
```

### 2.2 计数去了哪里

- 顶部 `.review-stats` 仍是「本期总账」；
- 块标题右侧是「这块有几条」（`待回顾 1`／`里程碑 1`）；
- `继续推进` **没有**再加总计数 —— 它的条数由理由摘要承担（`2 项进度未走完` 合计就是条数），加两遍又是新的重复。

同一句话在 `document.body.textContent` 里各出现 **1 次**（Vitest 用例 `states each headline count once instead of repeating a totals row` 守着）。

### 2.3 顶部统计卡：三块统一成两行（用户追加要求）

改前三个卡的文案行数不一致（第二张多一行 `2 项有进度变化`），高度虽然被 `min-height` 兜住，但视觉上「一个卡比旁边多一行」。改成固定两行：

```
267 分钟        +40 净进度          1 项完成
实际投入         3 项有进度变化       2 项仍可继续
```

- `Stat` 组件从 `value / label / note` 三个槽改成 `value / caption`：第一行「数字 + 单位」，第二行「这是什么」（可以是一个计数）。`detail` 参数只在需要行内追加时用，最终三块都没用它。
- 三块实测高度 **57 / 57 / 57**（1440 与 960 一致；1200/200% 下 126/126/126），不再是「有一块多一行」。
- **净进度的单位换成「净进度」**：`+10 百分点` 太长，一行放不下第二段说明。数字仍由 `formatPercentPoints` 统一格式化（符号 + 四舍五入），页面只把单位词换掉（`netDeltaValue`）。精确单位「百分点」仍在紧邻的图表标题里（`单位：百分点`）与明细区里，没有丢。
- `N 项有进度变化` **没有删**，它从第三行挪到第二行 —— 与 §2.2「删总账行不等于删数字」是同一条原则。
- 连带改了 3 处断言：`review-page.test.tsx` 两条、`e2e/phase1.spec.ts` 一条（`-10 百分点` → `-10 净进度`）。

## 3. 几何：改前／改后

`.review-outcomes` 高度、列数、以及「任意子块底边到卡片内容底」的空白（改前那截空白就是栅格形态造成的）：

| 场景 | 改前高 | 改后高 | 改前空白 | 改后空白 | 改前列 | 改后列 | 横向溢出 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 周 1440/100% | **293** | **188** | 131 | **24** | 2 | **3** | 0 |
| 月 1440/100% | **358** | **253** | 196 | **24** | 2 | **3** | 0 |
| 日 1440/100% | 176 | 186 | 14 | 24 | 2 | 3 | 0 |
| 周 960/100% | 293 | **188** | 131 | 24 | 2 | **2** | 0 |
| 周 1200/200% | **598** | **479** | — | 226 | 1 | **1** | 0 |

- 判据：周 ≤200 ✅（188）、月 ≤260 ✅（253）、空白 ≤24 ✅、1200/200% ≤540 ✅（479）、960 无横向滚动且列数 ≥2 ✅。
- **日视图从 176 涨到 186**：多了理由摘要那一行（约 18px），同时少了「需要你处理」那一块。这一条不在判据里，如实列出。
- 200% 那行的「空白 226」不是布局留白：单列时三块竖排，最后一块的底边到卡片底只差脚注与间距；`min(19rem,100%)` 在根字号 32px 下变成 608px，1200 窗口必然单列。

## 4. 三列 vs 两列：**保持三列**（没有触发回退规则）

回退规则的触发条件是「3 列让待回顾条目换行到 2 行以上」。实测（造了一条 09:00–10:00 的待回顾时段）：

| 列数 | 块宽 | 条目内容宽（任务 117 + 时间 121 + 时长 57 + 间距 24） | 是否换行 |
| --- | --- | --- | --- |
| 3 列 | **399** | 319 | **否**（同一行，余 80px） |
| 2 列 | 609 | 319 | 否 |

所以 3 列在 1440/100% 下放得下，不触发回退。列宽 399／399／399（内容宽 1238、间距 1.25rem×2）。

三块只落进两列时（960 窗口），第三块整行：

```css
@container (max-width: 59.5rem) { .review-outcome-grid > :last-child:nth-child(odd) { grid-column: 1 / -1; } }
```

阈值和列宽同源（3×19rem + 2×1.25rem = 59.5rem），**不是 px** —— 缩放改的是根字号，px 阈值在 200% 下会判错（P4-13 的老账）。

> 踩过一次：先写成无条件的 `> :last-child:nth-child(odd)`，结果 1440 下三列也把第三块拽成整行（三块的最后一个永远是奇数号）。截图确认后改成上面的容器查询。

## 5. 理由摘要：派生值在哪、文案怎么共享

- **派生值**：`src/lib/review.ts` 的 `carryoverSummary: ReviewCarryoverSummary[]`，按 `CARRYOVER_REASON_ORDER`（`pendingReview` > `notAdvanced` > `skippedOccurrence` > `incompleteAdvance`）计数，只保留 `count > 0`。组件里不再 `filter` 一遍。
- **排序**：`carryoverTaskIds` 也按同一条优先级排序（同一任务命中多条时取最靠前的那条）；`review.tasks` 的数组顺序**没动**。
- **文案**：`CARRYOVER_REASON_LABEL`（长句，明细区用）与 `CARRYOVER_REASON_SHORT`（短标签，摘要用）**都住在 `review.ts`**，`review-detail.tsx` 改成 `import { CARRYOVER_REASON_LABEL }`，模块内那份 `const` 已删除 —— 一个 `reason` 的两种文案只有一个出处。
- **一行放得下**：超过 2 类只列前 2 类 + `等 N 类`。实测 `1 项有待回顾 · 2 项进度未走完` 在 399px 列宽下是一行。

## 6. 待回顾条目补时长（§3.7，做了）

- `ReviewPendingSession = ExecutionSession & { durationMinutes: number }`，`pendingReview` 改成这个类型；**保留全部原字段**，所以 `.id`／`.localDate`／`.taskId` 的既有消费方与用例不受影响。
- 时长由 `src/lib/calendarPlacement.ts` 的 `sessionMinutes()` 算（跨午夜在那一处处理），不在组件里减时间戳。
- 页面渲染成 `60 分钟` 的 `.review-tag`，与「进行中」标签同一套外观。

## 7. 里程碑：达成态不只靠色差

`Check`（达成）／`CircleAlert`（未达成）图标 + 文字两重编码，**没有引入失败红**。`.review-tag` 从 `inline` 改成 `inline-flex` + `gap: 3px` 以容纳图标。

## 8. 无障碍与对比度

### 8.1 axe：4 组合 × 2 状态 = 8 轮，全部零违规

| 组合 | 三块齐全 | 空块降级（脚注） |
| --- | --- | --- |
| 1440/100% 浅 | 0 | 0 |
| 1440/100% 深 | 0 | 0 |
| 1200/200% 浅 | 0 | 0 |
| 1200/200% 深 | 0 | 0 |

每轮先断言 `.review-outcome-block` 数量 ≥ 3（夹具太穷会漏真实违规），并 `scrollIntoViewIfNeeded` 后再跑（axe 的 `color-contrast` 不评估屏幕外元素）。

### 8.2 对比度（合成祖先 opacity；`color(srgb …)` 先用 canvas 归一）

| 元素 | 字号/字重 | 浅色 | 深色 |
| --- | --- | --- | --- |
| 块标题计数 `.review-block-count` | 11.52px/500 | **5.162** | **7.676** |
| 理由摘要 `.review-carryover-summary` | 12.48px/400 | **7.664** | **9.357** |
| 待回顾时长标签 `.review-tag` | 11.52px/400 | **5.162** | **7.676** |
| 里程碑未达成 `.review-tag.is-unmet` | 11.52px/400 | **7.664** | **9.357** |
| 里程碑结果说明 `.review-milestone-note` | 11.52px/400 | **5.162** | **7.676** |
| 脚注 `.review-outcome-footnote` | 12.16px/400 | **5.162** | **7.676** |

全部 ≥ 4.5，`.72rem`／`.78rem` 不适用大字号豁免（门槛按 4.5 判）。原始数据见 [`a11y.json`](phase-4-p4-14-implementation/a11y.json)。

### 8.3 交互外观（§3.6 要求的现状说明）

| 类型 | 元素 | 可点 | `:focus-visible` |
| --- | --- | --- | --- |
| 任务胶囊 | `.review-task-chip` | 是 | 全局 `button:focus-visible`（2px `--focus`，offset 2px） |
| 文字链 | `.review-inline-link`（项目／里程碑／任务） | 是 | 同上 |
| 纯展示 | `.review-tag` | 否（不是 button） | 不适用 |

**没有新增第三种交互外观**；三者本来就有可见焦点环（全局规则），本包未改动。

## 9. 变了哪几处像素、为什么必须变

前后对照（浅色，`scripts/visual-evidence.mjs --only review`）：

| 图 | 变化 |
| --- | --- |
| [`before-review-week`](phase-4-p4-14-implementation/before-review-week.png) → [`after-review-week`](phase-4-p4-14-implementation/after-review-week.png) | ① 总账行整行消失（卡片矮 30px）；② 「需要你处理」那块换成一行脚注；③ `继续推进` 多一行理由摘要；④ 顶部统计卡三块都压成两行（见 §2.3、[`stats-two-lines`](phase-4-p4-14-implementation/stats-two-lines.png)） |
| [`before-review-day`](phase-4-p4-14-implementation/before-review-day.png) → [`after-review-day`](phase-4-p4-14-implementation/after-review-day.png) | 同上的 ①③；日视图三块只剩「继续推进」，空块说明进脚注 |
| [`before-review-month`](phase-4-p4-14-implementation/before-review-month.png) → [`after-review-month`](phase-4-p4-14-implementation/after-review-month.png) | 同上 |

另外单独取了三块齐全／两列／200% 的近景：

- [`card-light-3blocks`](phase-4-p4-14-implementation/card-light-3blocks.png)／[`card-dark-3blocks`](phase-4-p4-14-implementation/card-dark-3blocks.png)：三块等宽一行，标题带条数，里程碑带图标；
- [`card-light-footnote`](phase-4-p4-14-implementation/card-light-footnote.png)／[`card-dark-footnote`](phase-4-p4-14-implementation/card-dark-footnote.png)：空块降级成一行脚注；
- [`card-960-two-columns`](phase-4-p4-14-implementation/card-960-two-columns.png)：两列 + 第三块整行；
- [`card-1200-200-one-column`](phase-4-p4-14-implementation/card-1200-200-one-column.png)：200% 单列。

**必须变的三处**：① 总账行（与顶部完全重复）；② 空块从 47px 的块变成一行脚注（省掉整块）；③ 两栏栅格 → 等宽自适应（空白不是 padding 造成的，是栅格形态造成的，改 padding 治不了）。

## 10. 发现的新不一致（本包顺手修了 1 个）

**`scripts/visual-evidence.mjs` 的 `review-day` 场景从「日视图合并卡」改版起就是坏的**：它 `await page.locator(".review-charts").waitFor()`，而日视图那时起已经不再渲染 `.review-charts`（合并成 `.review-merged`）。也就是说 P4-09 之后这个场景一直在超时，只是没人跑过 `--only review`。本包改成等 `.review-merged`，并加了注释说明原因。

## 11. 未做项

无。§3.7（待回顾条目补时长）做了，见 §6。

## 12. 测试与检查

| 项 | 结果 |
| --- | --- |
| Vitest | **304**（24 文件），改前 301 → 净增 3（去重／空块／全空各 1），另有 1 条改写（待回顾时长与里程碑图标） |
| Playwright | **44** |
| Rust | 38 |
| `npm run check` | 四步全绿（dist CSS 116.13 kB／JS 499.37 kB） |

**两次偶发失败，都与本包无关，记录在此**：

1. `npm run check` 第一次跑到 `src/App.test.tsx > phase 4 P4-04 calendar viewport arbitration > writes a user-scrolled browsing position into preferences…` 超时；单跑通过、完整重跑通过 —— 机器负载导致的 `waitFor` 抖动。
2. 完整 E2E 第一次 43/44，`gui-optimization.spec.ts > a real native drag…` 报「拖拽根本没有开始」；单跑通过（10.8s），第二次完整跑 44/44。同一现象在 P4-13 之后就存在。

## 13. 仍需用户决定

1. **日视图高了一点**（176 → 186）：多的是理由摘要那一行。如果希望日视图更矮，可以只在周／月显示摘要行。
2. **三列在 1440 下的块宽 399px**：待回顾条目余量约 80px。任务名更长时仍可能换行 —— 那时再触发回退规则（2 列 + 第三块整行）只需要改一行容器查询。
3. 本包**没有 commit**（按开工提示词 §8.5「未经明确要求不要 git commit」）。
