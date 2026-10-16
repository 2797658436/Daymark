# 阶段 4 P4-13 开工提示词：日历的视觉层级与语义色收口

> 把 P4-12 报告 §6.2／§6.3／§6.4 三条既有缺陷 + **用户报的图层缺陷** + **叠加层减重**合成一包（同一片区域，一次前后对照两主题复测最省）。
> **必须在 P4-10 之前完成** —— 现在的顺序是 **P4-13 → P4-10**（P4-11、P4-12 已完成）。

---

你在 Daymark 仓库（F:\PythonProject\Daymark）开工 **P4-13**。

## 先读

1. `AGENTS.md` —— 工作规则（含仓库清理约定）。
2. `docs/PROJECT-GUIDE.md` —— §5 代码地图、**§10 主题与基础无障碍**、§11 测试体系、文档同步协议。
3. `docs/design/UI-SPEC.md` —— **§视觉令牌基线**（「禁用态使用满足对比度的**专用语义色**而不是整体降低透明度」）、日历层级与「实际记录用实色层、计划退为淡虚线轮廓」的相关段落。
4. `docs/reports/phase-4-p4-12-implementation.md` —— **§6.2／§6.3／§6.4** 三条缺陷的完整描述与实测数值，以及 §5 的视觉证据做法。
5. `docs/reports/phase-4-p4-11-implementation.md` §4.3 —— 「结构改了但视觉不该变就用逐字节截图证明」的做法。

## 交付范围（五项，同一片区域，一起复测）

### 1. 日视图日期头被压住（**用户报的图层缺陷**）

**现象**：日视图里那块实际记录叠加层会盖住「今天」药丸。用户怀疑是图层问题，并说存在很久了。

**已查证的事实**（你可以直接采信，但**请自己复核一遍**）：

- `.calendar-viewport`（`src/styles.css:206`，`container-type: inline-size`）建立整个日历的堆叠上下文；日视图的日期头与实际记录**就在同一个堆叠上下文里**，所以是**纯粹的数值比大小**，不是"跨上下文"问题。`.calendar-actual-record` 自己的 `container-type: size` 只让它成为**子树**的上下文，不改变它和日头的先后。
- `.calendar-day > header { position: sticky; z-index: 4 }`（`src/styles.css:254`）—— 那个「今天」药丸在这里面。
- `.calendar-actual-record { z-index: 7 }`（`src/styles.css:303`）。
- **7 > 4**，所以盖住。`git blame` 指向 2026-09-02 的 `54c621b`，**与 P4-12 无关**（P4-12 只改颜色）。

**比用户看到的更广 —— 这才是重点**：日头 `z-index: 4` 被 **5／6／7／8／9／10 全体**压住，不只是叠加层：

| 压住日头的 | z-index |
| --- | --- |
| `.calendar-session.current-schedule` | 5 |
| `.calendar-session.pending-review` | 6 |
| `.calendar-actual-record` | 7 |
| `.calendar-now-line`、`.drag-expanded-region`、`.continuous-day-separator` | 8 |
| `.collapsed-time-gap` | 9 |
| `.expanded-gap-toggle` | 10 |

而**周视图的吸顶头是 12**（`.week-sticky-header`），所以没事 —— **只有日视图那一档给低了**。

**修法方向（建议，不是命令）**：**别动叠加层**，把「吸顶日期头」整带抬到轨道最高层之上、临时拖拽层之下：

- `.calendar-day > header`、`.day-head-spacer`：4 → **19**
- `.continuous-day-separator`、`.week-sticky-header`：统一到 **20**（分隔线高于日头）
- `.back-to-now`：提到 **~30**（它是浮动按钮，本来就该在最上面）

⚠️ **只加 `isolation: isolate` 没用** —— 同一个堆叠上下文里错的是数值，不是上下文。请在报告里给出**完整的层级表**（谁在谁上面、为什么），并把"临时层（拖拽预览／插入线／位移预览 18／24／35）永远高于吸顶头"这条规则写清楚。

**回归判据（关键）**：`toBeVisible()` **查不出遮挡**。请用 `document.elementFromPoint(药丸中心点)` 断言命中的是药丸自己（或其后代），而不是叠加层。并覆盖**有叠加层／无叠加层**两种状态。

### 2. 叠加层减重（**用户明确要求**）

P4-12 把字色从白换成深（2.82 → 6.29 ✓），但代价是这块**从"高亮"读成了"实体"**，观感变沉。用户看的是 200% 的证据图（`docs/reports/phase-4-p4-12-implementation/actual-record-day-1200-200-light.png`），觉得"太大太不协调"；100% 下（`output/actual-record-100/`）是正常尺寸，但仍是最重的元素。

**建议方向**：把**满饱和橙**换成**淡底 + 深字 + 保留左侧 4px 色条**：

- `background: color-mix(in srgb, var(--accent) 28%, var(--panel))`（淡桃色）—— 而不是现在的 82%
- 前景继续用 P4-12 引入的 `--actual-record-text`（深色）
- **保留** `border: 1px solid var(--accent-strong)` 与 `border-left-width: 4px` —— 「这是实际记录」仍然一眼可辨

这样对比度反而更高（约 10:1），但视觉重量掉一大截，而且计划卡（白底描边）与实际记录（淡桃底 + 色条）仍然分得清。

**但请你自己验一遍**：混色比例（28%）要**实测**确认浅／深两色都 ≥ 4.5:1，并且**视觉上确实比改前轻**。若 28% 太淡到与计划卡混淆，就在 28%–82% 之间取一个既达标又分得清的值，把**取值理由与实测数值**写进报告。

⚠️ **不要顺手改回 `opacity`** —— 那正是第 3 项要修掉的写法。

### 3. `.planned-outline { opacity: .62 }`（P4-12 §6.2）

`src/styles.css:276`：开启「显示实际记录」时整卡降透明度（M2 的「计划变幽灵、实际凸显」）。它把里面的 `--muted` 文字一起稀释，浅色下压到 **2.38–2.48**：

| 元素 | 实测 | 门槛 |
| --- | --- | --- |
| `.pending-review > .session-time` | 2.38 | 3:1（24px 大字） |
| `.session-review-trigger > span` | 2.48 | 3:1 |
| `.pending-review > .session-state > .session-progress-value` | 2.48 | 3:1 |
| `.review-summary` | 2.48（浅）／3.88（暗） | 4.5:1 |

**UI-SPEC 明确禁止这种写法**：「禁用态使用满足对比度的**专用语义色**而不是整体降低透明度」。所以这是**与既有规格的偏离**，不只是数值问题。

**要做**：把整卡 `opacity` 换成**显式的去强调语义色**（可以新增 token，例如 `--deemphasized-surface`／`--deemphasized-text`），保持「计划退居背景、实际凸显」的**观感意图**，但让每一处文字都达标。**逐个复测上表四个元素**（含暗色的 `.review-summary` —— P4-12 §8.3 说暗色那条来自早先一次滚动态、没重新取证，本包请补上）。

### 4. 200% 缩放下叠加层标题行被压成 0 高（P4-12 §6.3）

`.calendar-actual-record` 是 `display: grid; align-content: start`。200% 下正文行高 44px、三行要 132px，而 1 小时的叠加层只有 72px（内容 62px）；只有 `strong` 带 `overflow: hidden`（自动最小尺寸为 0），于是它**独自吸收全部缺口** → `grid-template-rows` 实测 `44px 0px 44px`，标题被裁没。100% 下正常（`22px 17.98px 22px`）。

**要做**：让三行按可用高度**整体收缩或按优先级逐行隐藏**（`@container` 已经有 `max-height: 28px` 的先例），**不要**让某一行单独被压成 0。与第 2 项同一片区域，改完一起复测。

### 5. `.calendar-time-block > time` 的对比度 4.21（P4-12 §6.4）

`src/styles.css:455`：`.calendar-time-block time { color: var(--muted) }`，底色 `color-mix(in srgb, var(--panel-strong) 88%, var(--muted))` = `#e9e8e5`，`--muted` `#706d66` 落在上面只有 **4.21**（< 4.5，`.68rem` → 200% 下 21.76px，常规字重，不属大字号豁免）。与「显示实际记录」无关，是独立的浅色主题问题。

**要做**：换成达标的语义色（可与第 3 项的新 token 共用）。

## 明确不做（越界即停并回报）

- **不改现有全局 token 的值**（`--action`／`--action-text`／`--accent`／`--muted` 等一律不动）—— 允许**新增**语义 token。
- 不改布局结构、间距、字号、缩放范围与预设（第 4 项是**内容在已有盒子内如何分配**，不是改尺寸）。
- 不改统计口径、D1–D6、P4-07／P4-08／P4-11／P4-12 的已拍板结论。
- 不改 P4-04／P4-05 的滚动仲裁与「程序性滚动不写偏好」闸门。
- 不新增依赖；不碰 `src-tauri/`。
- **不要顺手修** `.calendar-insert-line`（它目前有可见文字、不违规）或别的页面。

## 验收

1. **图层**：`elementFromPoint` 断言日视图日期头（含「今天」药丸）**不被任何东西遮挡**，有／无叠加层两种状态都过；周／月视图的吸顶头同样不被遮挡。
2. **对比度**：第 2／3／5 项涉及的每一处都给出**实测数值**（浅／深），≥ 各自门槛。
3. **axe**：日历页在 **960×200%、浅／深**下零违规 —— **必须显式开启「显示实际记录」**，并**先断言目标元素真的渲染出来**（P4-09 的教训：夹具太穷会漏真实违规）。
   **另外加一轮「滚到有内容的时段」再跑一次 axe**：axe 的 `color-contrast` **不评估屏幕外的元素**（P4-12 §6.1／§3.1 —— 元素滚出视口时连 `violations`／`incomplete`／`passes`／`inapplicable` 四个桶都不进，规则根本没跑）。不加这一轮，日历下半天的状态永远不会被检查。
4. **视觉证据**：改前／改后对照（浅／深 × 100／200%），说明**哪些像素变了、为什么必须变**（这一包**预期会变视觉**，与 P4-11 相反 —— 但要精确说清变了哪几处）。
5. `npm run check` 四步全绿。

## 验证

```powershell
npm run check
```

- 本机基线（2026-10-16，P4-12 后）：build dist CSS 81.31 kB / JS 465.79 kB、Vitest **293/24**、Playwright **40**、Rust **38**。
- 看 axe 原始输出：`PW_TRACE=1 node scripts/run-e2e.mjs --workers=1 -g "M12 has no automated accessibility"`。
- 视觉证据脚本：`node scripts/visual-evidence.mjs --only calendar --out <目录>`（`--skip-build` 可复用 dist）。**P4-12 的 `actual-record-*` 场景硬编码了 `scale: 200`** —— 本包要拍 100% 对照的话，请把缩放做成场景参数，而不是每次手改。
- 若 `test:native` 出现 `os error 5`：删 `src-tauri/target/debug/incremental`，不影响结果。

## 仓库清理约定（长期有效，用户明确要求）

见 `AGENTS.md` 的 `### Repository cleanup` 与 `_quarantine/README.md`。要丢的一律先 `mv` 进 `_quarantine/<YYYY-MM-DD>_<简短说明>/`，不散删、不 `rm -rf`、不在沙箱内删目录树；**Agent 只搬不丢**，批次确认后由用户在资源管理器删那一个文件夹；同时最多一个未处理批次。

## 完成定义

1. 代码 + 用例（图层遮挡回归、开启实际记录的 axe、必要的对比度断言）。
2. 写 `docs/reports/phase-4-p4-13-implementation.md`：**完整的层级表与规则**（谁在谁上面、为什么）、减重的取值理由与实测对比度、§6.2 的新 token 方案、§6.3 的行分配策略、§6.4 的修法、改前／改后截图与「变了哪几处」、未做与边界、发现的不一致。
3. 按「文档同步协议」更新 PROJECT-GUIDE：§5、**§10（主题与无障碍 —— 把「不用整体透明度做去强调」这条写实）**、§11 测试数量、已知边界（把 §6.2／§6.3／§6.4 三条移除或改写）。
4. 截图入库到 `docs/reports/phase-4-p4-13-implementation/`（照 P4-09／P4-11／P4-12 的做法：`output/` 是 gitignored 的，报告引用那里就是死链）。
5. 不改动用户的未提交内容；未经明确要求不要 `git commit`（由总 Agent 复核后统一提交）。
6. 汇报：改了哪些文件、层级表与实测数值、是否发现新的不一致、仍需用户决定的事项。

## 附：三条提醒

1. **第 1 项的证据是"用户看到的现象"，不是你复现出来的** —— 请先用 `elementFromPoint` 或截图**自己复现一次**再动手，别直接照着上面的表改。
2. **这一包预期会改变视觉**（与 P4-11「零像素变化」正好相反）。所以不要试图证明"没变"，而要**精确说明变了哪几处、为什么必须变**，并给出前后对照。
3. **`isolation: isolate` 不是修法**。同一个堆叠上下文里错的是数值。
