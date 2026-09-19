# 阶段 4 P4-01 基线报告：固定基线、核对文档差异、记录缩放与滚动现状

日期：2026-09-10。对应工作包：P4-01（`docs/specs/0005-phase-4-daily-workflow-and-reliability.md` §10），依赖：无。
性质：**检测、记录与建样本**。本报告不改动产品代码、不改动既有文档结论。
状态：**P4-01 四项产出已全部完成**（固定基线、建立可重复样本、记录缩放与滚动行为、核对文档差异）。待决定事项集中在第 8 节。
相关记录：执行期间发现并处理了一起 git 对象库事故，另见 [`git-object-store-incident-2026-09-10.md`](git-object-store-incident-2026-09-10.md)。

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

这正是规格 M9 §5.2 要求"单一滚动仲裁"要消除的那类缺陷。不过 108px 在多次运行中恒定，与竞态应有的随机性不完全吻合，因此它只是**最可疑的候选**。

### 3.4 判定结论：是 flaky（时序竞态），不是确定性产品缺陷

判定实验：单跑该用例 `--repeat-each=5`，结果 **1 通过 / 4 失败**，4 次失败都落在同一断言（`phase1.spec.ts:339`）、位移恒为 108px。

推理：用例本身不稳定 → 属时序竞态。108px 之所以恒定，是因为竞态是**二值**的（App 的首次自动定位要么在用例测量 `before` 之前落地、要么在其后），而 5 次运行时刻相近、"当前时间"一致，故位移一致。

据此得到的处置方向（供 P4-04 起手）：

- **不需要重写缩放数学**：§3.2 的三次探针证明锚点补偿算法正确（位移 0，`scrollTop` 增量精确等于轨道高度增量 × 锚点比例）。
- **要做的是滚动仲裁**：让 App 的首次自动定位与外部／程序性滚动有明确优先级与 generation 失效机制，与规格 M9 §5.2 的要求一致。
- **用例自身也要收敛**：应先断言滚动已稳定再触发缩放，否则 AC05–AC07 没有可靠的回归网。

尚未定位的细节：按 48→52 的比例反解，108px 对应锚点分钟约 09:55，与"自动定位到当前时间"并不吻合，说明还有第二个因素参与。需在 P4-04 就地插桩确认，本报告不臆测。

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

## 6. 可重复样本（已交付）

新增 [`scripts/fixtures/perf-sample.mjs`](../../scripts/fixtures/perf-sample.mjs) —— 纯确定性生成器，按规格 §8 口径产出 100 项课程 / 1,000 项任务 / 10,000 条混合历史记录。

```powershell
node scripts/fixtures/perf-sample.mjs                                        # 打印统计，不落盘
node scripts/fixtures/perf-sample.mjs --out output/perf-sample.json          # 落盘（output/ 已被 .gitignore 覆盖）
node scripts/fixtures/perf-sample.mjs --anchor 2026-09-10 --seed 20260910    # 完全冻结
node scripts/fixtures/perf-sample.mjs --courses 5 --tasks 30 --history 200   # 缩量
```

实测结果（`--anchor 2026-09-10 --seed 20260910`）：

| 项 | 值 |
| --- | --- |
| `projects` / `courses` | 100 / 100 |
| `tasks` | 1,000（项目内 900 + 独立 95 + 习惯内部 5） |
| 历史记录合计 | 10,000（执行时段 3,000 / 实际记录 1,500 / 进度事件 5,000 / 时间块 300 / 习惯发生项 200） |
| 其他 | 里程碑 124、到期结果 64、习惯 5、挽救提示 25、未结束执行记录 1 |
| 体积 | JSON 约 2.87 MB |
| workspace sha256（前 16 位） | `24d758200a0ea94d` |

已验证的性质：

1. **确定性**：同 `--seed` + 同 `--anchor` 连跑 3 次，sha256 与字节数完全一致；换 `--seed`（`0916ecf5…`）或换 `--anchor`（`f05cd9be…`）后哈希改变，证明种子确实生效。
2. **自校验**：内置领域不变量检查（id 唯一、本地日期合法、时钟合法、跨午夜必须"次日 + endLocal < startLocal"、`progress` 与最后一条进度事件一致、进度事件链 `from == 上一条 to`、里程碑达成条件恰好一种、最多一条未结束执行记录、引用完整性等），默认运行；当前全部通过。首次运行时正是它抓出了生成器自身的跨午夜计算错误。
3. **只读边界**：不连接 SQLite／Tauri／备份协议，只产出浏览器预览层可消费的 `workspace` + `preferences`，可直接写入 `localStorage` 的 `daymark.phase1.workspace` / `daymark.phase0.preferences`。

未做：把样本接入 E2E 或性能预算测量（属 P4-09）；未新增 npm script（保持单文件改动面）。

## 7. 环境注意事项（影响后续所有验证）

在本机沙箱内实测到两条会影响结论可信度的环境事实，后续工作包应沿用此规避方式：

1. **跨调用不保持后台进程**：在 Bash 中 `(... &)` 起的 Vite 会在该次调用结束后被回收。因此不能"先起服务、再分开跑测试"。凡需要 Vite 的验证必须在**同一次调用内**完成启停，或直接走 `npm run test:e2e`（`run-e2e.mjs` 自行管理生命周期）。
2. **存在 `HTTP_PROXY`／`HTTPS_PROXY`（`http://127.0.0.1:49695`）**：`curl` 访问 `127.0.0.1` 会走代理（服务不在时会返回 502 而非连接失败）。用 `curl --noproxy '*'` 才能得到真实连通性；Chromium 不受影响。
3. **Playwright 冷启动偶发超时**：`fullyParallel: false` 但默认 2 个 worker，两个 spec 文件并行冷编译时，各自文件的首个用例会在 `page.goto` 撞上 30s 超时。首次全量跑出现 2 例，重跑不复现。判定为环境性抖动，非产品缺陷。

## 8. 已决定事项与剩余待决

### 8.1 已办

| 事项 | 处置 | 证据 |
| --- | --- | --- |
| 提交并推送 | 已推送 3 个提交（`9a2a2c0` 补推 + 规格 0005 + 本报告） | `17246a3..8d77b11 main -> main`，远端 `refs/heads/main = 8d77b11` |
| `output/` 造成 `git status` 带噪 | `.gitignore` 由 `output/playwright/` 改为 `output/` | `git check-ignore -v output/perf-sample.json` → `.gitignore:14:output/` |
| M3 红灯性质未定 | 判定为 flaky（时序竞态），非确定性产品缺陷 | 第 3.4 节，`--repeat-each=5` → 1 通过 / 4 失败 |
| 可重复样本缺失 | 已交付 `scripts/fixtures/perf-sample.mjs` | 第 6 节，确定性 + 自校验均已验证 |

### 8.2 待决

1. **是否提交本轮新增与修改的内容。** 工作区现有：本报告的第 3.4／6／8 节修订（报告本体已在 `8d77b11` 提交）、新增 `?? docs/reports/git-object-store-incident-2026-09-10.md`、新增 `?? scripts/fixtures/`。仍按 `docs/PROJECT-GUIDE.md` 第七步：未获明确要求不自动提交。
2. **`docs/specs/0005-*.md.bak-20260910` 的去留。** 当前是 v1.0 的唯一副本，未提交；是否要归档进 `docs/` 或直接删除。
3. **git 对象库里的 broken link 是否现在处理。** 必须做 repack／prune，**只能在沙箱外的终端完成**（命令见事故记录第 3 节）。不处理只影响 `git maintenance` 的噪音，不阻断任何工作。
4. **P4-01 是否可直接收尾、进入 P4-02。** P4-02（浮层宿主与编辑会话，任务／里程碑先行接入）依赖 P4-01，可开工；但 M3 红灯的收口属于 P4-04，建议不要把它的修复塞进 P4-02。
4. **P4-01 剩余部分是否继续。** §6 的可重复样本（固定随机种子的性能夹具）与 §4.2 的缩放配置源统一，都可以在本工作包内完成；后者会改动 `src/lib/settings.ts`，同样需要你确认范围。
