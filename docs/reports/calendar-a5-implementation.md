# 日历整改 A5 实施记录：三档信息分层、卡片零溢出、200% 刻度与周今日药丸

> 对应开工提示：[`calendar-a5-kickoff-prompt.md`](calendar-a5-kickoff-prompt.md)。方案基线：评估 F15／F16／F17 与 D7／D8。范围只含执行卡分层、时间轴首列、周今日药丸与文档回写，**未碰拖拽通道**。

## 1. 结果摘要

| 硬判据（`residuals.json`） | 改前 | 改后 |
| --- | --- | --- |
| 日 1200×800@100% 溢出卡 | 7 | **0** |
| 日 1200×800@200% 溢出卡 | 11 | **0** |
| 周 1200×800@100% 溢出卡 | 9 | **0** |
| 周 1200×800@200% 溢出卡 | 13 | **0** |
| 日／周时间轴裁切（100% + 200%） | 日 17/周 24 条 ×9px | **0 / 0** |
| 周「今天」药丸对比度 | 浅 3.61 / 深 2.47 | **浅 4.89 / 深 6.95**（27×27px 不变） |

- `npm run check` 四步全绿：`tsc --noEmit && vite build` 通过、Vitest **407/30**、Playwright **55/55**、Rust **48/48**（[`check.log`](../../output/2026-10-26_calendar-a5/check.log)）。
- 结构账不退化：chrome **108 / 176**、日视图吸顶 **44 / 88**、compact **10.17h / 1.69 屏**、standard **7.26h / 2.32 屏**（100% / 200%）。
- 周列宽：**141 / 111 / 74 / 95**（1200@100、960@100、1200@200、选中日详情）。1200 与 960 保持原值；200% 从 82 → 74 是首列从 58px 长到 116px 的必然结果（见 §5）。`clippedUntitledCount = 0`。

## 2. 三档设计（D8）

档位跟随**缩放预设**（`data-calendar-zoom`，60／84／108px/小时），而不是单张卡的会话分钟数；同一个档位里再按**卡片内容盒高度**逐行放出信息。

| 档 | hourHeight | 使用场合 | 卡片要回答 | 内容清单（自上而下） |
| --- | --- | --- | --- | --- |
| 紧凑 | 60 | 扫一天/一周的形状：找空档、看并行、看逾期 | 这是什么 + 什么状态 | 标题 1 行（省略 + `title`）＋ 左缘 3px 分类色条 ＋ 状态图标角标 |
| 标准 | 84 | 日常工作视图：知道几点到几点做什么 | 几点–几点 + 是什么 + 什么状态 | 起止时间 1 行（放得下时）＋ 标题 1–2 行 ＋ 状态图标 + 短词；进度改画**卡底 2px 填充**，不占行 |
| 详细 | 108 | 逐日复盘/编辑：归属、进度、动作 | 标准的全部 + 属于哪个项目、推进了多少 | 标准清单 ＋ 项目行 + 进度百分比 ＋（待回顾时）回顾摘要；悬停/聚焦动作条照旧 |

### 2.1 行预算（内容盒，单位 rem）

行高统一 `1.125rem`（100% 18px / 200% 36px）。断点值 = 行数 × 行高 + 2px 边框容差；行数取「该档最多同时出现的行」，因此永远不会为了多放一行而把最后一行压出卡外。

| 内容盒高度 | 100% | 200% | 放出的行 |
| --- | --- | --- | --- |
| `2.25rem + 2px` | 38px | 74px | 起止时间（非紧凑档） |
| `3.375rem + 2px` | 56px | 110px | 状态行（图标 + 短词 + 截止旗），否则只留右上角图标 |
| `4.5rem + 2px` | 74px | 146px | 标准档标题第 2 行；详细档「项目 + 百分比」行 |
| `5.625rem + 2px` | 92px | 182px | 详细档「待回顾」摘要 |
| `6.75rem + 2px` | 110px | 218px | 详细档标题第 2 行（为摘要留出第 6 行） |

实测（`audit.json` 的卡片高度 − 上下内边距 12px − 边框 2px）：

| 场景 | 盒子 | 内容盒 | 实际显示 |
| --- | --- | --- | --- |
| 标准 30 分钟 @100% | 42px | 28px | 标题 + 图标角标（1 行） |
| 标准 60 分钟 @100% | 84px | 70px | 时间 + 标题 + 状态（约 3.9 行容量，标题仍 1 行） |
| 标准 90 分钟 @100% | 126px | 112px | 时间 + 标题 2 行 + 状态 |
| 详细 60 分钟 @100% | 108px | 94px | 时间 + 标题 + 状态 + 项目/百分比 + 回顾摘要 |
| 详细 90 分钟 @100% | 162px | 148px | 上述 6 行全部放下 |
| 标准 30 分钟 @200% | 62px（最小档） | 36px | 标题 + 图标角标（恰好 1 行） |
| 标准 60 分钟 @200% | 84px | 58px | 仅标题（放不下第 2 行） |
| 标准 90 分钟 @200% | 126px | 100px | 时间 + 标题（2 行） |

> 200% 的提醒：界面缩放只放大根字号，小时高度仍是 84 CSS px，所以 60 分钟的盒子从「4 行」变成「1.6 行」。这正是 D8 要的「同一个 px 盒子自动少显示行」，而不是把行压出去。

### 2.2 最小档与 200%

- 卡片 `min-height: calc(1.875rem + 2px)`（100% 32px / 200% 62px），保证最小档在 200% 下仍有一条完整的标题行。
- 最小档固定保留：标题、分类色条、状态图标（`phase1.spec.ts` 的 `.session-status-icon` 红线）。状态短词、项目行、摘要、进度全部由高度查询控制。
- 状态图标是右上角角标（带一小块 `--panel` 底片，避免标题从下面穿过时糊在一起）；进入行版式后回到普通行。最小档时编辑铅笔让到角标左侧（`right: 20px`），两者都露得出来。

### 2.3 进度

- 标准档：`.session-task-progress` 改为 `inset-inline: 0; bottom: 0; height: 2px`，宽度 = 进度百分比，**零行高成本**。
- 详细档：回到 4px 粗条（`inset-inline: .375rem; bottom: .125rem`），与 2px 的「本时段已过去」细条继续分开。
- 紧凑档不画任务进度（与内容清单一致）。

### 2.4 JS 侧只留钩子

`CalendarSession` 现在**始终渲染**时间、标题、状态、项目/百分比、摘要与进度条；行的显隐全部交给 CSS。JS 的 `density` 只保留两个消费方：

1. `data-card-density`（悬停动作条的阈值与测试钩子）；
2. `showDetails` → 编辑按钮的 `data-action-visibility="visible|on-demand"`。

`App.test.tsx` 的 density 用例已改写为「断言盒子高度档位 + DOM 契约」；M2 对 `.review-summary` 的 `toHaveCount(0)` 改成 `not.toBeVisible()`（1 分钟卡仍然没有摘要，只是它现在在 DOM 里、由高度查询隐藏）。

## 3. F15：卡片零溢出

根因三条全部收口：

1. **不再按会话分钟数强制渲染行数**：`density` 只表「盒子高度档位」，行由容器查询决定。
2. **断点与内容同用 rem**：200% 下内容行 36px、断点 74/110/146…px，盒子不够就减少行，而不是裁切。
3. **删除 `.calendar-session.pending-review { overflow: visible }`**：待回顾仍靠 2px 描边 + `--accent-strong` 混色 + 图标区分；「待回顾」短词只在高度允许时出现。动作仍是点开的气泡，不回到卡内。

`residuals.mjs` 的三个判据（子元素越过卡底、`scrollHeight − clientHeight`、轴刻度左右裁切）在四个场景全部为 0。

## 4. F16：时间轴首列

- 新增 `--calendar-gutter: 3.625rem`（100% = 58px、200% = 116px），替换 `.calendar-grid`／`.calendar-grid.day`／`.week-date-headers`／`.week-all-day`／详情面板留白里所有 `58px`。
- `--calendar-min-week` 改为 `calc(var(--calendar-gutter) + 7 * var(--calendar-week-column))`：
  - 100%：58 + 7×112 = **842px**（不变）
  - 200%：116 + 7×56 = **508px**（旧口径 421px）
- A3 的停靠判据（原 `902 × 100/缩放`）按同一公式重算：100% 仍是 **902**；200% 是 `116 + 7×56 + 60×0.5 = **538**`（旧口径 451）。`AppShell` 的 `weekGridDesignWidth` 改为 `58 × 缩放/100 + 844 × 100/缩放`。
- 周列宽实测 141 / 111 / 74 / 95；200% 的 74 比旧 82 少 8px，正是首列多占的 58px 摊到 7 列（58/7 ≈ 8.3）。`clippedCount` 的 2–3 条都是 30px 并行卡的**带 `title` 单行省略**（`clippedUntitledCount = 0`）——旧代码在同样位置是纵向溢出（改前 residuals 里 `STRONG+95px`），只是旧探针没有量纵向。

## 5. F17：周「今天」药丸

```css
.today-number {
  flex: none;
  background: var(--accent-soft); color: var(--accent-strong);
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  width: 27px; height: 27px;
}
```

- 与日视图吸顶带 `.calendar-day-band-today` 同一家族；`flex: none` 保证 200% 窄列里仍是 27×27（此前会被压成 25×27）。
- 实测：浅色 **4.89**（`rgb(169,71,36)` on `rgb(251,232,218)`）、深色 **6.95**（`rgb(255,180,141)` on `rgb(73,49,38)`），见 `measurements.json` 的 `pill` 字段。
- 类名与可访问名未变，M12/M13 与 `App.test.tsx` 的取法不变。

## 6. 结构账

| 项目 | A4 收口态 | A5 后 | 判据 |
| --- | --- | --- | --- |
| chrome（日，100% / 200%） | 108 / 176 | **108 / 176** | 不退化 |
| 日视图吸顶（100% / 200%） | 44 / 88 | **44 / 88** | 不退化 |
| compact 一屏 / 一天 | 10.17h / 1.69 屏 | **10.17h / 1.69 屏** | ≥8h / ≤2 屏 |
| standard 一屏 / 一天 | 7.26h / 2.32 屏 | **7.26h / 2.32 屏** | ≥7h + 零裁切（D7） |
| 小字号（<.75rem） | 0 | **0** | 不退化 |
| 横向溢出（日视图） | 同一条 2px 链 | **同一条 2px 链** | 不新增；周视图滚动容器 `scrollWidth == clientWidth` |

## 7. 验证

### 7.1 `npm run check`

最终树：`EXIT 0`。四步计数：Vitest **407/30**、Playwright **55/55**、Rust **48/48**（`check.log`）。本次没有撞上午夜窗口。

### 7.2 量测脚本（headless、单 browser、finally 清理）

| 脚本 | 结果 |
| --- | --- |
| `output/2026-10-26_calendar-a5/residuals.mjs` | 四场景 `cards = 0`、`axisClipped = 0`、`weekAxisClipped = 0`、`pillContrast = 4.89` |
| `output/2026-10-26_acceptance/audit.mjs` | chrome 108/176、吸顶 44/88、compact 10.17/1.69、standard 7.26/2.32、smallText 0 |
| `output/2026-10-26_acceptance/probe.mjs` | 12 个日视图场景全部产出，卡片零溢出 |
| `output/2026-10-26_acceptance/probe-a3.mjs` | 周列宽 141/111/74/95；除既有的 `ref-settings-1200` 等待超时（与本包无关，A4 时期同一条探针也未通过）外全部产出 |

### 7.3 回归用例

- M2（`phase1.spec.ts:361`）：1 分钟待回顾卡仍有 `.session-status-icon`（aria-label「待回顾」）；摘要不可见。`phase1.spec.ts` 只把 `toHaveCount(0)` 改成 `not.toBeVisible()`，断言意图不变。
- M4（`phase1.spec.ts` 的折叠与拖拽展开用例）、A1 落点（`:985`）、A4 两条（`:597` / `:701`）全绿。
- M12 两条（状态图标 + 实际记录叠加层）、M13 两条（`elementFromPoint` + 14 轮 axe）、960×200% 浅/深逐页 axe 全绿。
- 落点框：`gui-optimization.spec.ts:366` 要求「虚线框不得矮于卡片」。卡片最小高度改到 rem 后，落点框的 `min-height: 32px` 在 200% 会变矮；本包把 `.calendar-drag-preview`／`.calendar-drag-ghost` 的 `min-height` 改成与卡片同一个 `calc(1.875rem + 2px)`（**只同步最小高度常量，未改拖拽通道与落点逻辑**）。100% 下仍是 32px，用例通过。

## 8. 截图与逐张检查

证据目录 `output/2026-10-26_calendar-a5/`，全部 headless（Chromium，`deviceScaleFactor: 1`；200% 是应用内根字号缩放）。逐张检查的是：卡片内容不越出卡底、标题省略有 `title`、状态不只靠颜色、时间轴刻度完整、药丸可读。审美判断留给用户。

| 截图 | 视口 / 缩放 | 检查结论 |
| --- | --- | --- |
| `cal-day-full-1200.png` | 1200×800 / 100% | 30 分钟卡只留标题 + 角标；60/90 分钟卡时间、标题、状态齐全；无溢出 |
| `cal-day-full-960.png` | 960×640 / 100% | 同上；任务池仍在右侧，无横向滚动 |
| `cal-day-full-200.png` | 1200×800 / 200% | 刻度「10:00」等首位不再丢；短卡只剩标题，90 分钟卡时间 + 标题；铅笔让到状态角标左侧 |
| `cal-day-compact.png` | 1200×800 / 100%，紧凑档 | 所有卡片只留标题 + 色条 + 图标；进度/时间不出现 |
| `cal-day-detailed.png` | 1200×800 / 100%，详细档 | 60 分钟卡出现项目 + 百分比 + 摘要；30 分钟卡仍只留标题 |
| `cal-day-full-1200-dark.png` | 1200×800 / 100%，深色 | 状态角标、进度条、时间文字对照正常 |
| `cal-week-1200.png` | 1200×800 / 100% | 今日药丸柔底强墨；10:00 待回顾卡有「待回顾」短词 + 摘要行不出现 |
| `cal-week-200.png` | 1200×800 / 200% | 刻度完整；窄列标题省略；药丸仍 27×27 |
| `cal-week-selected.png` | 1200×800 / 100% | 选中日详情打开后列宽 95，标题可换 2 行，无溢出 |
| `cal-week-1200-dark.png` | 1200×800 / 100%，深色 | 深色药丸 6.95，日期头与全天区可读 |

放大检查用到的裁图：`crop-card-0900.png`、`crop-card-1100.png`、`crop-detailed-1100.png`、`crop-compact-1400.png`、`crop-week200-headers.png`、`crop-week-pill.png`、`crop-week200-cards-final.png`。

> headless 的限制：Chromium 在 headless 下用 overlay 滚动条，`::-webkit-scrollbar` 不绘制；本包不改滚动条，所以不涉及该例外。没有打开 headed 浏览器。

## 9. 未收口项与边界

1. **200% 下最小卡会长过时段格子**：60 分钟以内的卡在 200% 会被 `min-height: 62px` 撑高（30 分钟格子 42px），背靠背时最多重叠约 20px。选择它是因为硬判据要求零裁切，而 36px 的行在 42px 盒子里无论如何放不下。内容顶对齐，下一张卡只盖住标题下方的空白；如果用户不接受重叠，替代方案是降低 200% 的行高（会牺牲可读性）或让小时高度随缩放增长（会改结构账与 D7）。
2. **周 200% 的 74px 列**：3 张并行卡各约 30px，标题只能显示 2–3 个字 + 省略号；全文在 `title` 与卡片的 `aria-label` 里。这是 A3 的 112px 列下限在 200% 的既有形态，本包只把首列加宽了 58px。
3. **周 200% 日期头的「今天」仍会折成两行**：这是既有的窄列行为；本包把药丸固定在 27px，不再让它被压扁，但没有重排日期头。
4. **任务池 200% 右栏裁切**：不在本包范围（开工提示明确另记后续包）。
5. **月视图密度（F13）**：未动。
6. **`probe-a3.mjs` 的 `ref-settings-1200` 等待超时**：既有探针问题（设置页标题选择器），与本包无关；其余 10 个场景都产出。
7. **未 `git commit`**；A1–A4 的未提交修改与用户工作区原样保留。

## 10. 回退方法

本包没有数据模型、迁移、设置字段或备份格式改动，回退只涉及四处源码：

```powershell
git diff -- src/App.tsx src/styles.css src/App.test.tsx e2e/phase1.spec.ts
```

按 hunk 撤回 A5 的改动即可（**不要** `git checkout` 整文件，A1–A4 的未提交修改也在这四个文件里）：

- `src/App.tsx`：`CalendarSession` 的行渲染、`nextDeadline`、`density` 注释；周列宽的 `gutter` 测量与 `weekGridDesignWidth` 公式。
- `src/styles.css`：`.calendar-session` 的容器查询块、`--calendar-gutter` 与 `--calendar-min-week`、`.today-number`、落点框最小高度、状态角标/编辑铅笔的让位规则。
- `src/App.test.tsx`：density 用例。
- `e2e/phase1.spec.ts`：M2 的 `.review-summary` 断言。

回退后重跑 `npm run check` 与 `residuals.mjs` 应回到改前基线（7/11/9/13 张溢出卡、刻度 17/24 条裁切、药丸 3.61）。

## 11. 文档同步

- `docs/design/UI-SPEC.md`：日历段「执行卡片根据可用高度自动调整信息量」三条改写为三档问题清单 + rem 高度查询 + 进度底边填充；删掉按 30/60 分钟分档的旧句；`拖拽排程` 段第 201 行改为「由吸顶日期带与落点框承担日期归属提示」。
- `docs/PROJECT-GUIDE.md`：§5 的 `App.tsx`／`styles.css` 两行补 A5；§10「按容器隐藏信息有两套断点口径」补本包作为「高用 rem」的完整落地实例（卡片 1.125rem 行预算、最小档、状态角标）。

## 12. 证据清单

- `output/2026-10-26_calendar-a5/`：`residuals.mjs` / `residuals.json` / `residuals.log`、`audit.json` / `audit.log`、`probe-measurements.json` / `probe.log`、`probe-a3-measurements.json` / `probe-a3.log`、`probe-a5.mjs` / `measurements.json` / `probe-a5.log`、`check.log`、10 张截图与 7 张裁图。
- 量测脚本均为生产构建 + `vite preview`、固定时钟 `2026-08-05T12:00:00`、只写 localStorage、headless、单 browser、`finally` 关闭。
