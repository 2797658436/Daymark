# 阶段 4 P4-10 开工提示词：原生验收、安装升级、隔离恢复、文档同步与发布记录

> 用法：整段复制到新会话作为开场提示。上一工作包 P4-09（长列表测量、全模块回归、修复预算超标项）已完成、已提交并通过独立复核（`03640af` + `4748850`）。
> **这是阶段 4 的最后一个工作包。**

---

你在 Daymark 仓库（F:\PythonProject\Daymark）继续阶段 4。现在开工 **P4-10**。

## 先读（按顺序，不要跳过）

1. `AGENTS.md` —— 工作规则（含仓库清理约定）。
2. `CONTEXT.md` —— 领域语言与产品原则。
3. `docs/PROJECT-GUIDE.md` —— §9 备份与恢复协议、§11 测试体系、§12 常见修改入口、§13 风险与决策，以及末尾的「文档同步协议」。
4. `docs/specs/0005-phase-4-daily-workflow-and-reliability.md` —— §10 的 P4-10 行、**§11 的 AC17／AC18**、**§12 全部**（发布前的隔离环境要求、交付记录清单、版本号同步、回退做法）、§13、**§14 的完成定义**。
5. `docs/reports/phase-4-p4-09-implementation.md` —— **§7（S2／S2／S3 三个未达标项）**、§9（3 条待定）、**§12（独立复核补记，含真机复测要求）**。
6. `docs/reports/phase-4-open-decisions.md` —— §0.5／§5／§6 已拍板项，**不要改**。
7. `scripts/with-msvc-env.sh` 的头部注释 —— 为什么要套它，以及它会踩什么坑。

## 交付范围

### 1. 打包与可追溯安装包

- **必须套 MSVC 环境**：`scripts/with-msvc-env.sh npm run tauri build`。
  裸跑会让 rustc（`x86_64-pc-windows-msvc`）按名字命中 Git Bash 自带的 GNU `link.exe`，报 `link: missing operand` 之类**与真实原因无关**的错误。release 依赖已缓存时约 2 分 20 秒。
- 产物：`src-tauri/target/release/bundle/nsis/Daymark_<版本>_x64-setup.exe`；裸可执行文件在 `src-tauri/target/release/daymark.exe`。仓库惯例是复制一份到 `artifacts/`（该目录已 gitignored）交给用户实测。
- **记录 SHA256 与安装包路径**（规格 §12 的交付记录要求）。
- ⚠️ `artifacts/` 里现有 `Daymark_0.1.0_x64-setup.exe`（2026-10-15 20:51）—— 那是**上一份已验证安装包**，也就是**回退目标**，**不要覆盖它**。

### 2. 隔离环境验收（AC17／AC18）

规格 §12 写得很硬：**「不能在唯一的个人数据库上覆盖恢复来获取测试证据」**。必须在**独立 Windows 账户**或**明确隔离的数据环境**里完成：

- 旧 v7 备份恢复；
- **缺少新偏好的恢复**（旧设置文件没有 P4-05／P4-07／P4-08 新增的字段）；
- 损坏备份拒绝；
- 恢复偏好失败回滚；
- **实际托盘与提醒**（AC17）：关闭驻留托盘、显式退出、提醒后恢复、目标不存在时的回退；
- **升级后重新启动**（AC18）：干净安装、覆盖升级。

**动手前先决定并写清怎么隔离**（新建 Windows 用户账户 / 把 `APPDATA` 指向临时目录 / 单独的数据目录）。这是本包最容易糊弄过去的一环 —— 不要用「跑了一遍没事」代替隔离证据。

### 3. 回退验证

规格 §12：schema 不变，回退使用**上一份已验证安装包**；先手动备份当前数据与设置，**退出托盘进程**，再替换版本。旧版本可能忽略新增偏好，但**不应改变核心数据**。

**发布前必须实测往返兼容，不能仅凭 schema 相同就宣布安全。**

### 4. 真机复测性能

P4-09 §12 的补记：搜索与月回顾是**压线达标**（带负载时月回顾 max **93.7ms** / 预算 100，搜索 p95 **183.4ms** / 预算 200）。

**真机复测至少跑两次（一次机器空闲、一次带负载）**，不要只看一次读数。命令：`node scripts/measure-perf.mjs`（生产构建 + 真实 Chromium，结果落 `output/`）。

### 5. 版本号同步（若调整）

规格 §12：版本号若调整，要同步 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 及锁文件相关版本；**先确认原有 `Cargo.toml` 改动的归属**。

- ⚠️ `src-tauri/Cargo.toml` 的 `[build-dependencies]` 里有一行 `indexmap = { version = "1.9", features = ["std"] }` —— **它是必需的**（没有它 `schemars 0.8` 会以 `error[E0107]` 编译失败）。动 Cargo.toml 时不要顺手删，护栏测试 `src/lib/nativeBuildConfig.test.ts` 盯着它。
- 若决定保持 `0.1.0` 不动，就在报告里写明「未调整版本号」及理由。

### 6. 文档同步与交付记录

- 按「文档同步协议」更新 PROJECT-GUIDE：§2、§5、§11、§12、§13（风险与决策）、已知边界 —— **把 P4-09 的 S2／S3 未达标项写进已知边界**。
- 交付记录（规格 §12）必须包含：**提交、未提交改动清单、是否推送、测试环境和实际结果、安装包路径与 SHA256、已知缺陷、截图、回退方法**。
- §14 的完成定义：M8–M13 的代码、AC01–18 证据、通过的工程检查、隔离桌面验收、同步后的实现文档与可回退安装包。**真实使用结论要单独标注；未完成的观察不得写成「已证明长期有效」。**

## 明确不做（越界即停并回报）

- 不新增依赖、不新增 SQLite 迁移／字段（schema 仍 v7）、不新增 Tauri Command —— **除非 AC17 实机暴露了必须修的原生缺陷**，那时先回报再动。
- 不改统计口径；不改 D1–D6 与 P4-07／P4-08 的已拍板结论（见 `phase-4-open-decisions.md`）。
- 不改 P4-04／P4-05 的滚动仲裁与「程序性滚动不写偏好」闸门；不改缩放范围与预设。
- **不要在唯一的个人数据库上做覆盖恢复。**

## 可选（**先问用户再动**）

- **S2 日历网格 ARIA 缺陷**：`role="gridcell"` 缺 `role="row"`（axe `aria-required-parent` critical）。P4-09 建议并入本包或单独开一条。不阻塞发布，但会一直挂在 AC14 上。修它要重排周／月网格为 `grid → row → rowheader／gridcell`，并决定时间轴、全天区、拖拽预览的标注 —— **不是小改动**。
- **S3 1200×200% 下截止页筛选复选框第一次鼠标点击落空**：根因是焦点态改变了盒子尺寸（`getBoundingClientRect().y` 从 269.2 → 301.7，+32.5px），于是 `mouseup`／`click` 落到祖先容器上。只在那一格复现，键盘路径正常。
- **P4-09 §9 的另外两条**：sequential（最坏情况）口径是否算进预算；`output/` 里的过程文件是否要留档。

## 验收

- **AC17**：关闭驻留托盘、显式退出、提醒后恢复与目标不存在回退正常（**Windows 实机**）。
- **AC18**：干净安装、覆盖升级、数据备份及失败回滚可复现（**隔离 Windows 环境**）。

## 验证

```powershell
npm run check
```

外加：**打包**（套 MSVC）、**隔离环境验收**、**真机性能复测（至少两次）**、**回退往返实测**。

- 本机 `npm run check` 四步全绿（2026-10-16 实测：build dist JS 465.54 kB / CSS 81.24 kB、Vitest 293/24、Playwright 39、Rust 38）。
- E2E 已默认**不录 trace**（`PW_TRACE=1` 才录），`scripts/run-e2e.mjs` 启动前会把 `test-results/` 残留用 rename 挪进 `_quarantine/`。
- E2E 用自带 Chromium，惯例加 `--workers=1`。
- 若 `test:native` 出现 `error copying object file … 拒绝访问 (os error 5)`：删 `src-tauri/target/debug/incremental` 即可，不影响结果。
- 需要夏令时用例时：**`TZ=... node` 这种 shell 前缀在本机被沙箱剥掉**，必须在进程内 `process.env.TZ = "..."`（照 `src/lib/review.timezone.test.ts`），并先自检目标日时长防空跑。

## 仓库清理约定（长期有效，用户明确要求）

见 `AGENTS.md` 的 `### Repository cleanup` 与 `_quarantine/README.md`。要丢的一律先 `mv` 进 `_quarantine/<YYYY-MM-DD>_<简短说明>/`，不散删、不 `rm -rf`、不在沙箱内删目录树；**Agent 只搬不丢**，批次确认后由用户在资源管理器删那一个文件夹；同时最多一个未处理批次。

打包会在 `src-tauri/target/` 下留下大量 release 产物 —— 那是可再生内容，但**不要**在会话中途清理它（会拖慢后续构建），要清就等全部验收做完再整批搬走。

## 完成定义

1. **证据**：隔离环境验收记录（怎么隔离的、每一步的实际结果）、AC17／AC18 的证据、打包产物路径与 SHA256、真机性能复测（≥2 次）、回退往返实测结果。截图放在 `output/`（gitignored）。
2. 写 `docs/reports/phase-4-p4-10-implementation.md`（范围、交付清单、隔离方式、每项验收的实际结果、安装包与 SHA256、性能复测数字、回退结论、未做与边界、发现的不一致、仍需用户决定）。
3. 按「文档同步协议」更新 PROJECT-GUIDE，并把 S2／S3 未达标项写进已知边界。
4. 不改动用户的未提交内容；未经明确要求不要 `git commit`（由总 Agent 复核后统一提交）。
5. 汇报：改了哪些文件、验收实际结果、是否发现代码／规格／文档不一致、仍需用户决定的事项。

## 附：几条已经定案、不要再动的

- **D1–D6**（截止页不常驻任务池／关键字只匹配标题／同一天项目按标题排／`deadlineUrgency` 按日历日／「回到现在」写浏览偏好／导航位置不变）—— 见 `phase-4-open-decisions.md` §0.5。
- **P4-07 的五个引擎待定项**：四条保持、一条作废 —— 见同文件 §5。
- **P4-08 的五个页面待定项**：全部保持 —— 见同文件 §6。
- **`indexmap` 那一行**、**trace 默认关闭**、**`_quarantine` 约定** —— 都是踩过坑才有的护栏，别当"没用"删掉。
