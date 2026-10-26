# 日历整改 A6 实施记录：日视图密度重定标、卡片字号随档与六项视觉统一

> 对应开工提示：[`calendar-a6-kickoff-prompt.md`](calendar-a6-kickoff-prompt.md)。方案基线：评估 F18／F19／F20 与 D9／D10／D11。范围只含日视图密度、卡片字号、六项统一与文档回写，**未碰拖拽通道**（B 轮）。

## 1. 结果摘要

| 硬判据（`output/2026-10-26_calendar-a6/`） | 改前（A5 收口态） | 改后 |
| --- | --- | --- |
| 日视图三档预设（标准 168 / 紧凑 84 / 详细 216） | 84 / 60 / 108 | **168 / 84 / 216** |
| `CALENDAR_SCALE_RANGE.day` | 28–192 | **28–240** |
| 日 standard 一屏 / 一天（audit 口径） | 7.26h / 2.32 屏 | **3.63h / 4.50 屏**（612px 净视口口径 **4.81 屏**） |
| 日 compact 一屏 / 一天 | 10.17h / 1.69 屏（旧 60） | **7.26h / 2.32 屏**（新 84） |
| 日 detailed 一屏 / 一天 | 5.65h / 2.94 屏（旧 108） | **2.82h / 5.75 屏**（新 216） |
| 日／周 × 100%/200% 溢出卡 | 0 / 0 / 0 / 0 | **0 / 0 / 0 / 0** |
| 时间轴刻度裁切（日 / 周） | 0 / 0 | **0 / 0** |
| 日视图横溢链 | `720/718 → 662/660 → 654/644 → 32/20` | **0**（四场景） |
| 今日药丸对比度 | 4.89 | **4.89**（未改色） |
| 周吸顶总高 | 122px | **88px**（日期头 44 + 全天区 44） |
| 周列宽（1200 / 960 / 1200@200 / 选中） | 141 / 111 / 74 / 95 | **141 / 111 / 74 / 95** |
| 周视图一屏 | 7.81h | **7.81h**（presets 未动） |
| 紧凑档最小卡 / 30 分钟格 | 32px / 42px | **24px / 42px（100%）**、**42px / 42px（200%）** |
| 天/周卡片字号的实测档位 | 12/18 全档 | **日 12/18、14/22、16/26；周 12/18、13/20、14/22** |

- `npm run check` 四步全绿：`tsc --noEmit && vite build` 通过、Vitest **409/30**、Playwright **56/56**、Rust **48/48**（[`check.log`](../../output/2026-10-26_calendar-a6/check.log)）。
- 唯一保留的既有横溢是周视图 200% 的 74px 窄列（now 标签、时间块文字与「另外 N 项」胶囊），21 条与 A5 同源，按 F20⑧ 接受；日视图横溢链已归零。
- `smallTextCount = 0`；`clippedCount = 0`（日/周四场景 + 三档 + 深色 + 960/200%）。

## 2. 日视图密度重定标（D9）与档位忠实迁移

`src/lib/settings.ts`：

```ts
CALENDAR_SCALE_RANGE.day = [28, 240];
CALENDAR_SCALE_PRESET.day = { compact: 84, standard: 168, detailed: 216 };
CALENDAR_SCALE_PRESET.week = { compact: 60, standard: 84, detailed: 108 }; // 不动
DEFAULT_SETTINGS.calendarScale = { day: 168, week: 84, month: 120 };
```

迁移只作用于**日视图**，且必须同时满足：用户点过档位（Store 里存在 `calendarZoom.day`）＋ 连续值恰好停在该档的旧预设（60／84／108）。命中时改写到同一档的新预设（60→84、84→168、108→216）；72、99 这类用户自己滚出来的值原样保留；`calendarZoom.day` 缺失时 84 也保留（无法区分旧默认与手感值）。迁移发生在 `normalizeCalendarScale`，**不主动回写 Store**；用户下一次切换任何偏好时会随整份设置写入。

`settings.test.ts` 四条实测：

| 存储 | 档位 | 结果 |
| --- | --- | --- |
| `calendarScale.day = 84` | `calendarZoom.day = "standard"` | **168** |
| `calendarScale.day = 108` | `calendarZoom.day = "detailed"` | **216** |
| `calendarScale.day = 60` | `calendarZoom.day = "compact"` | **84** |
| `calendarScale.day = 72 / 99 / 167` | 任意档位存在 | **原样保留** |

另补两条边界：`calendarZoom` 里没有 `day` 时 84 保留；迁移幂等（已经 168／216 的不会二次改写）。E2E 用真实 Store 重载验证了渲染值为 216、而本地存储仍是 108（读取层迁移，不回写）。

## 3. 卡片字号随档（D10）

| 视图 | compact | standard | detailed |
| --- | --- | --- | --- |
| 日 | **12px / 18px** | **14px / 22px** | **16px / 26px** |
| 周 | **12px / 18px** | **13px / 20px** | **14px / 22px** |

- 行高全部用 rem：日 `1.125 / 1.375 / 1.625rem`，周 `1.125 / 1.25 / 1.375rem`；字号用 `--session-font-size`、行高用 `--session-line-height`，由 `.calendar-page[data-calendar-view]` + `[data-calendar-zoom]` 两层选择器给出。
- 高度容器查询断点按视图 + 档位写死 rem 字面量（五档 = 行数 × 行单位 + 2px），条件里没有 `var()`：

| 断点档 | compact | 日 standard | 日 detailed | 周 standard | 周 detailed |
| --- | --- | --- | --- | --- | --- |
| 2 行（时间） | — | 2.75rem | 3.25rem | 2.5rem | 2.75rem |
| 3 行（状态） | — | 4.125rem | 4.875rem | 3.75rem | 4.125rem |
| 4 行（标题 2 行 / 项目） | — | 5.5rem | 6.5rem | 5rem | 5.5rem |
| 5 行（回顾摘要） | — | — | 8.125rem | — | 6.875rem |
| 6 行（详细标题 2 行） | — | — | 9.75rem | — | 8.25rem |

- `data-card-density` 的语义与悬停动作条阈值未变；M2 的 `.session-status-icon` 红线未变。
- 实测（[`measurements.json`](../../output/2026-10-26_calendar-a6/measurements.json)）：日 100% 三档 `14px/22px`、`12px/18px`、`16px/26px`；周 100% `13px/20px`；日 200% standard `28px/44px`。新增 E2E 在 200% 下断言 60 分钟卡同时露出时间与标题、`scrollHeight − clientHeight ≤ 1`。

## 4. 六项视觉统一（F18／F20）

| # | 改前 | 改后 | 实测 |
| --- | --- | --- | --- |
| 1 周吸顶 | 日期头 52 + 全天区 70 = **122px** 双行；全天区多行胶囊 | `.week-date-headers` 与 `.week-all-day` 各 `2.75rem` 单行，共用 `--panel-strong` 底色与一条底边；胶囊一行放不下只留第一组 +「+N」chip，点开仍是 A3 的 `FloatingPanel` 名单 | 1200/960 吸顶 **88px**；200% 默认折叠保留（吸附区 176px = 88 + 88） |
| 2 折叠条 | `COLLAPSED_GAP_HEIGHT = 44` 固定 px，CSS 用 `2.75rem`；200% 下 44 vs 88 分叉 | `collapsedGapHeight(scale) = round(44 × scale / 100)` 单一来源；`createCalendarTimeline({ collapsedGapPx })`、CSS 变量 `--collapsed-gap-height`、日期带与折叠条共用 | 100% **44px**、200% **88px**（`audit` 的 `bands` 与 `stickyBandCoveredPx`） |
| 3 轴横溢 | `.time-block-delete::before` 向右/下扩 12px，按钮 `scrollWidth 32 / clientWidth 20` → 卡片 +10 → 轨道 +2 | 命中区只向上/向左扩（`inset: -12px 0 0 -12px`），时间块再 `overflow: hidden` | 日视图四场景 `hOverflow = 0`；`.time-block-delete` 不再出现在溢出链 |
| 4 状态条右组 | 复选框标签与「显示 ⋯」按钮垂直不齐 | `.calendar-status-end` 中线对齐；`.actual-record-toggle` 改 `inline-flex` + `align-items: center` | 100% 两孩子高 34、标签内 checkbox / 文字中心 **83 / 83**；200% **134 / 134** |
| 5 高卡空白 | 进度条 `absolute; bottom: 0` 钉底，内容与进度之间一大片空 | 进度条进文档流、紧跟最后一行内容（标准 2px / 详细 4px，margin-top 2px）；紧凑档仍不画 | `position: relative`；进度与内容间 2px、卡底 padding 8/16px（≤1 行高）。90 分钟详细卡剩余的是**时长几何**（见 §8.5） |
| 6 最小卡重叠 | compact 最小卡 32px；200% 下 62px > 30 分钟格 42px | compact 最小卡 `1.375rem + 2px`（100% **24px**）；200% 收回 `1.25rem + 2px`（**42px**），等于 30 分钟格 | 100% 24 ≤ 42；200% 42 = 42；compact 卡裁切 0 |

> 「+N」chip 只承担入口，不改变数据：完整名单仍是 A3 的全天标记浮层；`App.test.tsx` 的全天区用例改成断言「第一组 + `+N`」，`phase1.spec.ts` 的 M6 用例继续通过。

## 5. 结构账（`audit.mjs`，复跑于最终代码树）

| 场景 | 小时高 | 一屏小时 | 一天屏数 | 吸顶 | 可用时间 | smallText |
| --- | --- | --- | --- | --- | --- | --- |
| 日·全天 1200 | 168 | **3.63** | **4.50** | 44 | 612 | 0 |
| 日·全天 960 | 168 | **2.68** | 5.96 | 44 | 452 | 0 |
| 日·上午/下午 1200 | 168 | 3.63 | 2.00 | 44 | 612 | 0 |
| 日·全天 200% | 168 | **2.96** | 5.17 | 88 | 500 | 0 |
| 日·紧凑 | 84 | **7.26** | **2.32** | 44 | 612 | 0 |
| 日·详细 | 216 | **2.82** | **5.75** | 44 | 612 | 0 |
| 周 1200 | 84 | **7.81** | 3.07 | **88** | 568 | 0 |
| 周 960 | 84 | **5.90** | 4.06 | 88 | 408 | 0 |
| 周 200% | 84 | **7.00** | 3.43 | 176 | 412 | 0 |

读法：`scrollHeightsOfOneDay` 的分母是 `continuous-day-axis` 的 `clientHeight`（654px）；kickoff 里 standard 的 **4.80 屏**来自 612px 净视口（2944 / 612 = 4.81），同一份数据两种分母，均写入本表。周视图 200% 的 176px 是两行 `2.75rem` 在 200% 下的 88 + 88（默认折叠全天区时 label 仍撑满 `2.75rem`），100% 的验收线是 88px。

`probe-a3` 的周列宽 141 / 111 / 74 / 95、`probe.mjs` 的卡片零溢出均与 A5 收口态逐字相同。

## 6. 验证

### 6.1 `npm run check`

最终树：`EXIT 0`。四步计数：Vitest **409/30**、Playwright **56/56**、Rust **48/48**（[`check.log`](../../output/2026-10-26_calendar-a6/check.log)）。本次包含：

- `settings.test.ts` 新增的「档位忠实迁移」；`calendarTimeline.test.ts` 新增的折叠条高度 44/66/88 与映射。
- `App.test.tsx` 日视图几何断言改到 168；全天区用例改为断言第一组 + `+N`；时间块拖拽用例按 168px/小时更新吸附结果。
- `e2e/phase1.spec.ts` 的 A4 用例更新到 168/216；A6 预设用例覆盖 84/168/216、旧 detailed 108 的迁移与周视图 48 不被改写；新增 200% standard 60 分钟卡「时间 + 标题」不裁切用例。
- 960×200% 浅/深逐页 axe、M12 状态与叠加层、M13 吸顶遮挡与 14 轮 axe 全绿（未跳过）。

### 6.2 量测脚本（headless、生产构建、固定时钟 `2026-08-05T12:00`、单 browser、finally 清理）

| 脚本 | 结果 |
| --- | --- |
| `output/2026-10-26_calendar-a6/residuals.mjs` | 四场景溢出卡 **0**、轴裁切 **0**、日横溢 **0**、周横溢 0（周 200% 的 21 条既有窄列溢出不计入日视图判据）、药丸 4.89、状态中心 83/83 与 134/134 |
| `output/2026-10-26_acceptance/audit.mjs` | 见 §5；`dayOverflow = 0`，`sticky` 周 88 |
| `output/2026-10-26_acceptance/probe.mjs` | 12 个日视图场景全部产出，卡片零溢出 |
| `output/2026-10-26_acceptance/probe-a3.mjs` | 周列宽 141/111/74/95；吸顶 88；除既有的 `ref-settings-1200` 等待超时（与本包无关）外全部产出 |

### 6.3 截图与逐张检查

证据目录 `output/2026-10-26_calendar-a6/`，全部 headless（Chromium，`deviceScaleFactor: 1`；200% 是应用内根字号缩放）。逐张用读图能力检查：

| 截图 | 视口 / 缩放 | 检查结论 |
| --- | --- | --- |
| `day-100-standard.png` | 1200×800 / 100% | 14px 正文；时间、标题、状态行齐全；进度条紧跟状态；无裁切 |
| `day-100-compact.png` | 1200×800 / 100% | 12px 标题、色条、状态角标；进度不画；24px 的 15 分钟卡完整 |
| `day-100-detailed.png` | 1200×800 / 100% | 16px 正文；30 分钟卡显示时间 + 标题 + 状态 + 4px 进度；无溢出 |
| `day-200-standard.png` | 1200×800 / 200% | 28px / 44px；30 分钟卡只留标题 + 角标（放不下时间），60 分钟卡时间 + 标题；无裁切 |
| `day-200-compact.png` | 1200×800 / 200% | 紧凑档 42px 卡与 30 分钟格同高，无重叠 |
| `day-100-standard-dark.png` | 1200×800 / 100% 深色 | 字号/进度/状态对照正常 |
| `day-960-standard.png` | 960×640 / 100% | 无横向滚动；正文不裁切 |
| `week-100-standard.png` | 1200×800 / 100% | 吸顶 88px；日期头与全天区同底色、单行；全天胶囊第一组 + 「+1」；13px 正文 |
| `week-200-standard.png` | 1200×800 / 200% | 全天区默认折叠；日期头「今天」仍折两行（F20⑧ 接受）；卡片标题省略但完整值在 title/aria-label |
| `week-100-standard-dark.png` | 1200×800 / 100% 深色 | 吸顶带与胶囊可读 |
| `crop-status-bar.png` | 1200×800 / 100% | 复选框与文字、右组与左侧分段同一中线 |
| `crop-week-sticky.png` | 1200×800 / 100% | 日期头 44 + 全天区 44；「全天 收起」单行不折 |
| `crop-week-sticky-200.png` | 1200×800 / 200% | 日期头 88 + 折叠全天区 88；行为与 A5 一致 |
| `crop-high-card.png` | 1200×800 / 100% | 90 分钟详细卡：进度条紧跟项目/百分比行（不再钉底）；下方剩余为时长几何 |

> headless 的限制：Chromium 在 headless 下用 overlay 滚动条，`::-webkit-scrollbar` 不绘制；本包不改滚动条，不涉及该例外。没有打开 headed 浏览器。

## 7. 回退方法

本包没有数据模型、迁移、设置字段名或备份格式改动，回退只涉及以下源码（**不要** `git checkout` 整文件，A1–A5 的未提交修改也在这里）：

```powershell
git diff -- src/lib/settings.ts src/lib/settings.test.ts src/lib/calendarTimeline.ts src/lib/calendarTimeline.test.ts `
  src/App.tsx src/App.test.tsx src/styles.css e2e/phase1.spec.ts
```

按 hunk 撤回 A6 的改动：`settings.ts` 的日预设/区间/默认值与迁移；`calendarTimeline.ts` 的 `collapsedGapHeight` 与 `collapsedGapPx`；`App.tsx` 的折叠条接线、全天区 +N、进度条 DOM 顺序；`styles.css` 的字号变量、五档断点、周吸顶、折叠条变量、时间块裁剪、状态条对齐、进度进流、最小卡；测试与文档同步改回 60/84/108。

回退后重跑 `npm run check` 与 `residuals.mjs`，应回到 A5 基线（日 standard 7.26h/2.32、周吸顶 122、日横溢 2px 链）。

## 8. 未收口项与边界

1. **周 200% 的 74px 窄列**：3 张并行卡各约 30px，标题省略；日期头「今天」折两行。F20⑧ 明确接受，本包未动。
2. **周 200% 的 21 条横向溢出**：now 标签（96/54）、时间块文字（93/58）与「另外 N 项」胶囊（47/13）在 74px 列里溢出；A5 同源、评估接受，不计入日视图判据。
3. **任务池 200% 右栏裁切**：不在本包范围。
4. **月视图密度（F13）**：未动。
5. **高卡的时长几何空白**：进度条已进文档流、紧跟最后一行（内容与进度间距 2px，卡底内边距 8/16px）；90 分钟详细卡在 216px/小时下仍有约 190px 的剩余高度，那是「卡高 = 时长」的几何结果，不是内容与进度之间的留白。若要进一步消除，需要把卡高从时长解耦（会破坏时间轴语义），不在 A6 范围。
6. **200% 下 15 分钟卡**：compact 档最小卡 42px 仍高于 15 分钟格（21px），背靠背时会重叠约 21px；A5 §9 已记录同类问题，A6 只按 kickoff 收口 30 分钟格。
7. **未 `git commit`**；A1–A5 与用户工作区的未提交修改原样保留。

## 9. 文档同步

- `docs/design/UI-SPEC.md`：日/周密度分列（84/168/216 与 60/84/108）、字号 12–16px、五档 rem 断点、周吸顶 88px + 「+N」、紧凑档最小卡与 200% 例外。
- `docs/PROJECT-GUIDE.md`：§5 的 `App.tsx`／`settings.ts`／`calendarTimeline.ts`／`styles.css` 行；§8 的 `calendarScale` 区间、预设与档位忠实迁移；§10 的行数断点、尺寸单一来源例外与测试库存（409/56/48）。
- 评估 §5.5 与 §6 已由总 Agent 更新，本包未重复改动。

## 10. 证据清单

- `output/2026-10-26_calendar-a6/`：`shots.mjs` / `measurements.json`、`residuals.mjs` / `residuals.json` / `residuals.log`、`audit.json` / `audit.log`、`probe.log` / `probe-measurements.json`、`probe-a3-measurements.json`、`check.log`、14 张截图（含 4 张特写）。
- 量测脚本均为生产构建 + `vite preview`、固定时钟 `2026-08-05T12:00:00`、只写 localStorage、headless、单 browser、`finally` 关闭。
