# 阶段 4 P4-01 基线报告：固定基线、核对文档差异、记录缩放与滚动现状

日期：2026-09-10。对应工作包：P4-01（`docs/specs/0005-phase-4-daily-workflow-and-reliability.md` §10），依赖：无。
性质：**检测与记录**。本报告不修改产品代码、不改动既有文档结论；需要用户决定的项集中在第 7 节。

## 1. 基线固化

| 项 | 值 |
| --- | --- |
| 分支 | `main`，跟踪 `origin/main` |
| 已提交基线 | `9a2a2c0` feat(gui): add compact editors and improve planning workflows（2026-09-08 19:24:52 +0800） |
| 是否已推送 | **否**。`origin/main` 落后本地 1 个提交，`9a2a2c0` 未推送 |
| 上游基线 | `17246a3` feat(phase3): complete final acceptance work（2026-09-06 11:37:19 +0800） |
| 未提交改动 | `README.md`（+1 行，新增指向规格 0005 的链接）；`src-tauri/Cargo.toml` 仅索引 stat／换行符层，无实质 diff |
| 未跟踪 | `docs/specs/0005-*.md`、`docs/specs/0005-*.md.bak-20260910`（与正文差 53 行，为 v1.0→v1.1 修订前备份）、`output/`（31 个 PNG，含 `design-2026-09-10/` 与 `playwright/`） |
| 运行环境 | Windows；Node 22.22.2；RTX 4060 Laptop；沙箱内存在 `HTTP_PROXY=http://127.0.0.1:49695` |

### 1.1 待核对项关闭：`src-tauri/Cargo.toml`

规格 §2 的该项**可以关闭**。实测证据一致：

- `git diff --stat` 只列出 `README.md`，不含 `Cargo.toml`
- `git diff --ignore-cr-at-eol -- src-tauri/Cargo.toml` 为空
- `git diff --numstat` 无 `Cargo.toml` 行

结论：`git status` 中的 `M` 来自索引 stat／换行符层（`core.autocrlf`），无实质改动。打包时仍应遵守规格要求，不顺手覆盖此文件。

## 2. 测试基线实测（2026-09-10，本机）

命令：`npm run check`（`build → vitest → test:e2e → test:native`）。

| 层级 | 文档记载（2026-09-08） | 本次实测 | 一致性 |
| --- | --- | --- | --- |
| 生产前端构建（`tsc --noEmit` + Vite） | 通过 | 通过 | 一致 |
| Vitest | 125 | **125 / 125 通过**（11 个文件，45.0s） | 一致 |
| Rust | 37 | **37 / 37 通过**（1.01s） | 一致 |
| Playwright | 24 | **23 通过 / 1 失败** | **不一致** |
| `npm run tauri build` | 未记录 | 未运行 | — |

`npm run check` 因 E2E 失败在 `test:e2e` 处中断，`test:native` 未被执行；上表 Rust 数字由单独运行 `npm run test:native` 补测。

复核该结论的产品代码基线：
- `CURRENT_SCHEMA_VERSION = 7`（`src-tauri/src/database.rs:16`），与规格 §2 一致。
- `git diff --check` 无空白错误。

## 3. 基线红灯：M3 指针锚点缩放用例

**这是本次最重要的发现。规格 §11 把"现有 E2E"当作 M9 的回归基线，但该基线当前是红的。**

- 用例：`e2e/phase1.spec.ts:301`（在 `17246a3` 中为 `:302`）`phase 3 M3 zooms around the pointed time and keeps schedule facts unchanged`
- 失败断言：Ctrl+滚轮缩放后，指针所指时间在屏幕上的位置位移应 ≤2px，实测 **108px**
- 复现次数：HEAD 全量跑 2 次（分别在第一个与第二个缩放断言处失败，位移均为 108）；`17246a3` 单跑 1 次（同样 108）

### 3.1 是否由 `9a2a2c0` 引入：**否**

用 `git archive 17246a3` 解出上游提交到临时目录（未改动 `.git`）并单独运行该用例，**同样失败、同样 108px**。因此这是**基线自带**的红灯，不是上一个提交的回归。

### 3.2 锚点数学是否损坏：**否**

编写探针脚本完整复刻用例几何（week 视图、`calendarScale.week = 48`、指针停在 today 列 `day-track` 中心），结果：

| 步骤 | 缩放 | `calendar-viewport.scrollTop` | today 列 `day-track` 中心屏幕 Y | 位移 |
| --- | --- | --- | --- | --- |
| 起点 | 48 | 359 | 522 | — |
| 第 1 次 Ctrl+滚轮 | 48 → 52 | 359 → 407 | 522 | **0px** |
| 第 2 次 Ctrl+滚轮 | 52 → 56 | 407 → 455 | 522 | **0px** |

`scrollTop` 增量恰为轨道高度增量 × 锚点比例（96 × 0.5 = 48；96 × 0.5 = 48），命中 `src/App.tsx:643-645` 的 `anchorRatio` 分支（week 全天模式下 `.timeline-map-segment` 数量为 0，`anchorMinute` 为 null，不走 632-642 分支）。**指针时间锚点补偿本身工作正常。**

同时排除的假设：
- **非整页缩放**：`devicePixelRatio = 1`、`visualViewport.scale = 1`，缩放前后不变。
- **非文档级滚动**：`window.scrollY` 与 `document.scrollingElement.scrollTop` 全程为 0；`scrollHeight = clientHeight = 760`，文档不可滚动。`marker.scrollIntoView()` 没有带动祖先滚动。

### 3.3 已定位的可疑机制（尚未证实）

`page.reload()` 返回时日历**尚未挂载**（探针 A 快照：`dayTracks = 0`、`data-calendar-scale` 为 null）。App 的首次定位由 `src/App.tsx:616-627` 的**双 `requestAnimationFrame`** 执行，守卫 `didAutoScrollToNow` 只防止自身重复，**不感知外部对 `scrollTop` 的写入**。因此用例"reload 后手工写 `scrollTop`"与 App"挂载后自动定位当前时间"之间没有仲裁，两者先后顺序取决于时序。

这正是规格 M9 §5.2 要求"单一滚动仲裁"要消除的那类缺陷。但需注意：位移在多次运行中恒为 108px，与竞态应有的随机性并不完全吻合，**该机制目前只是最可疑的候选，不能作为结论**。判定实验（写入用例内、需用户授权）见第 7 节。

## 4. 核对文档差异（规格 §2 两项）

### 4.1 "唯一共享 UI 组件"——确认过时

`docs/PROJECT-GUIDE.md:149` 仍把 `button.tsx` 描述为"当前唯一共享 UI 组件"，而 `src/components/ui/` 现有 `button.tsx` 与 `floating-panel.tsx` 两个组件。属 M9／最终文档同步项。

### 4.2 缩放范围三方不一致——确认，且比规格描述的多一处

| 来源 | 日／周 | 月 |
| --- | --- | --- |
| `normalizeCalendarScale`（`src/lib/settings.ts:182`） | `[28, 192]` | `[52, 132]` |
| `calendarScaleForZoom` 预设（`src/lib/settings.ts:191-192`） | 48 / 72 / 96 | 80 / 120 / **160** |
| `docs/PROJECT-GUIDE.md:50`、`:244` | "每小时 28–96px" | 未写 |
| **新增**：滚轮钳制（`src/App.tsx:653`） | `Math.max(28, Math.min(192, ...))` | 提前 return，不适用 |

- 矛盾一：月 `detailed` 预设 **160 > 月上界 132**。
- 矛盾二（回退路径同样越界）：`src/lib/settings.ts:185` 校验失败时回退调用 `calendarScaleForZoom(view, zoom[view])`；当 `calendarZoom.month === "detailed"` 时，回退值恒为 160，**本身就是归一化函数拒绝的值** → 归一化会产出自己判为非法的结果。
- 新增矛盾三：滚轮缩放的钳制范围是 `App.tsx:653` 里的字面量 `28/192`，**第 4 处**重复的缩放范围定义，未与 `normalizeCalendarScale` 共用配置源。

实际行为推论（供 AC07 判定）：`calendarScale.month` 的 detailed 值走任何路径都会被判非法，再"回退"到同一个越界值 160 —— 数值上"保存重载恒等"，但**从未落在合法区间内**。AC07 的"所有预设保存重载恒等"与"非法偏好安全回退"目前靠两个错误互相抵消，而不是靠单一配置源成立。

## 5. 其余点名项核对（供 M9／M10／M11 使用）

| 规格所述 | 实测 |
| --- | --- |
| `PageId` 三处同步点 | 确认存在三处：`settings.ts:5` 联合类型（无 `deadlines`）、`settings.ts:143` 中 `lastPage` 的硬编码 `isOneOf` 数组（同行含 `"overview" → "today"` 别名）、`App.tsx:33` 的 `const pages` 导航表 |
| `review.ts` 固定最近七日 | 确认。`buildSevenDayReview(workspace, endDate)` 固定 7 个本地日（`review.ts:12`），是当前唯一导出入口 |
| 跨午夜实际投入全归开始日 | **确认**。`review.ts:27` 用 `localDate(new Date(record.actualStartUtc))` 整条归属，无按本地日边界拆分 |
| 已取消／跳过分列 | 部分。`review.ts:35` 把 `skipped` 与 `cancelled` 合并计入同一 `skippedCount` |
| "待回顾"派生与 App 共判 | 尚未。`review.ts` 只读 `session.status === "missed"` 显式事实，没有与 App 共享的待回顾派生选择器 |
| 月摘要与回顾各自遍历事实 | 确认。`calendarSummary.ts` 与 `review.ts` 分别遍历 `progressEvents`／`executionRecords` 等 |
| 设置规范化与串行保存接缝 | 确认（`settings.ts` 的 `normalizeSettings`、`writeQueue`） |

## 6. 可重复样本现状

**不存在。** `scripts/` 只有 `run-e2e.mjs` 与 `tauri-build-env.sh`；`e2e/` 与 `src/lib/*.test.ts` 中没有任何固定随机种子的性能样本（100 项课程 / 1,000 项任务 / 10,000 条历史记录）。规格 §8 的性能预算目前没有可执行载体，属 P4-01 未完成部分。

## 7. 环境注意事项（影响后续所有验证）

在本机沙箱内实测到两条会影响结论可信度的环境事实，后续工作包应沿用此规避方式：

1. **跨调用不保持后台进程**：在 Bash 中 `(... &)` 起的 Vite 会在该次调用结束后被回收。因此不能"先起服务、再分开跑测试"。凡需要 Vite 的验证必须在**同一次调用内**完成启停，或直接走 `npm run test:e2e`（`run-e2e.mjs` 自行管理生命周期）。
2. **存在 `HTTP_PROXY`／`HTTPS_PROXY`（`http://127.0.0.1:49695`）**：`curl` 访问 `127.0.0.1` 会走代理（服务不在时会返回 502 而非连接失败）。用 `curl --noproxy '*'` 才能得到真实连通性；Chromium 不受影响。
3. **Playwright 冷启动偶发超时**：`fullyParallel: false` 但默认 2 个 worker，两个 spec 文件并行冷编译时，各自文件的首个用例会在 `page.goto` 撞上 30s 超时。首次全量跑出现 2 例，重跑不复现。判定为环境性抖动，非产品缺陷。

## 8. 需要用户决定

1. **是否提交并推送。** 当前 `9a2a2c0` 未推送，工作区还有 `README.md` 改动、规格 0005 正文与 `.bak-20260910`、以及未跟踪的 `output/`（31 张 PNG）。按 `docs/PROJECT-GUIDE.md` 第七步，未获明确要求不自动提交。
2. **`output/` 与 `.bak-20260910` 的去留。** `output/` 未被 `.gitignore` 覆盖，会让 `git status` 长期带噪。
3. **M3 红灯的处置顺序。** 建议在启动 P4-04（逻辑滚动位置与仲裁）前先判定该用例失败的性质：是"用例与 App 自动定位的时序竞态"（改测试／加仲裁即可）还是产品缺陷（须进 M9）。这需要修改 `e2e/phase1.spec.ts` 或 `App.tsx`，**跨文件改动，等你确认后再动**。
4. **P4-01 剩余部分是否继续。** §6 的可重复样本（固定随机种子的性能夹具）与 §4.2 的缩放配置源统一，都可以在本工作包内完成；后者会改动 `src/lib/settings.ts`，同样需要你确认范围。
