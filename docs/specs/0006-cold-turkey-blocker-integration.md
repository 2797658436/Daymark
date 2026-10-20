# 0006 · Cold Turkey Blocker 联动（执行时段开始/结束驱动外部封锁）

- 状态：待评审（调研已完成，实现未开始）
- 调研环境：Windows 11 (10.0.26200) / Cold Turkey Blocker **v4.6 Pro** / Daymark 0.1.5
- 调研日期：2026-10-19
- 调研方式：本机实物验证（进程、`C:\ProgramData\Cold Turkey` 数据库只读、从 `Cold Turkey Blocker.exe` 提取 UTF-16 字符串），非产品文档转述

> 实现前请先读 `docs/PROJECT-GUIDE.md`（AGENTS.md 的要求：改产品代码、数据模型、设置持久化、桌面行为之前必读）。
> 本文所有 Cold Turkey 结论**只在 v4.6 上验证过**；它没有对外承诺的稳定 CLI 契约，版本升级后需重跑第 8 节的验收脚本。

## 1. 需求

用户在 Daymark 里开始一段执行时段（用户口头称"沉静模式"）时，自动让 Cold Turkey Blocker 打开 2~3 个封锁；时段结束（用户点"结束并保存"）时自动关闭这些封锁。

## 2. 术语对齐（重要，避免实现错触发点）

Daymark 代码与文案里**不存在"沉静模式"这个词**（全仓 grep `沉静` 无命中）。与之对应的真实机制是：

| 用户说法 | 代码实体 | 位置 |
| --- | --- | --- |
| 开始这段执行 | `start_execution` → `create_execution_record` | `src-tauri/src/lib.rs:403`、`src-tauri/src/database.rs:488` |
| 结束并保存 | `finish_execution`（写 `actual_end_utc` + 一条进度事件） | `src-tauri/src/lib.rs:414`、`src-tauri/src/database.rs:519` |
| 前端调用 | `native.startExecution` / `native.finishExecution` | `src/lib/native.ts:195-197`，UI 调用点 `src/App.tsx:370`、`src/App.tsx:501` |

注意 `execution_records` 是**实际执行记录**：只有用户主动点开始才产生（界面文案原文"默认关闭；只有主动开始才形成实际执行记录"）。预排的 `execution_sessions`（status: `scheduled`/`missed`/`cancelled`）是计划，不是"正在执行"，不要用它们做触发源。

## 3. 结论摘要

| 能力 | 可行性 | 说明 |
| --- | --- | --- |
| 读封锁列表（名称、启用状态、锁类型、站点数、例外） | ✅ 可以 | 只读 `data-app.db`，已实测 |
| 命令行开启某个封锁 | ✅ 已实测可用 | `-start "<name>" -as-is`，6 次以上往返成功 |
| 命令行关闭某个封锁 | ✅ 已实测可用 | `-stop "<name>"` |
| 一次开 2~3 个封锁 | ✅ 可以 | 多次调用，需串行 + 回读校验（见 6.3） |
| 命令行往例外里加网址 | ❌ 实测 4 次均未生效 | `-add "<name>" -web "<URL>"`，见 9 |
| 命令行新建一个封锁 | ❌ 不支持 | 帮助原文："The block must already exist." |
| 用退出码/输出判断成败 | ❌ 不可用 | 恒为 0，且 GUI 子系统丢弃 stdout |
| 关闭"带锁"的封锁 | ❌ 设计上不允许 | 见 4.4，随机文本锁 / 设置密码会让 CLI 拒绝 |

**产品边界（必须在设置页写清）**：能被脚本关掉的封锁，就是能被用户随时关掉的封锁——这条路提供的是**便利**，不是**承诺**。要"中途不可逃"，只能用 `-start "<name>" -password <分钟数>`（开启即锁 N 分钟），此时 Daymark **也无法提前关闭**，结束只能等时间到。建议同时提供 soft / hard 两种模式，见 6.5。

## 4. Cold Turkey 侧事实

### 4.1 可执行文件

`C:\Program Files\Cold Turkey\Cold Turkey Blocker.exe`（路径含空格）。PE 头 `Subsystem = 2`（GUI），所以它内部那些 `Error: ...` 提示既不会进 stdout，也不会写日志文件——**任何失败都是静默的**。

### 4.2 从二进制提取的命令行帮助原文

```
  Starts the specified (non-device) block at all times, with no lock. Requires the block to be disabled or unlocked.
  -start "Block Name" -as-is
  Starts and locks the specified block for X number of minutes (X must be >= minutes left).
  -start "Block Name" -password X
  Starts and locks the specified (non-device) block with X number of random characters (words).
  -add "Block Name" -web "URL"
  Adds a URL to the exception tab of the specified (non-device) block if unlocked. The block must already exist.
  -stop "Block Name"
  Stops the specified (non-device) block if unlocked.
  -stop "Block Name" -password X
```

完整参数集（同一次字符串提取）：`-start -stop -toggle -pause -lock -add -random-text -start-delay-break -stop-delay-break -start-random-text-unblock -stop-random-text-break -reload-settings -delete-stats -notify -show-extension-install -end -tray -first-run -help`。除 `-start/-stop` 外均未实测。

### 4.3 实测行为

- 主程序未运行时带参启动：会拉起 GUI 主进程（实测 PID 24464）并应用该命令。
- 主程序已运行时带参：走第二实例转交，实测 5~7 秒内状态落库。
- 起/停可重复，无残留：多轮 `-start` / `-stop` 往返后数据库状态一致。

### 4.4 CLI 会被拒绝的三种情况（二进制里的错误原文）

```
Error: This block is locked and can't be stopped via command line.
Error: Block is not enabled.
Error: Permission denied. The settings password is set to prevent blocks from starting.
Error: Permission denied. The settings password is set to prevent blocks from changing.
Error: Block name is invalid. Can not add websites to a device block.
```

判定一个封锁能否被脚本控制：`lock == "none"` **且** 全局 `settings.password == ""` 且 `settings.passwordStrict` 不为 `settings`。本机现状：`停止看视频_`（`lock=none`）可控；`停止看视频`、`Edit`（`lock=randomText`）不可控。

### 4.5 状态读取

- 文件：`C:\ProgramData\Cold Turkey\data-app.db`
- 表：`settings(key TEXT, value TEXT)`，只有一行 `key='settings'`，`value` 是整份配置 JSON
- pragma：`journal_mode = delete`（**无 -wal 文件**）、`user_version = 4`、`page_size = 4096`

配置 JSON 结构：

```jsonc
{
  "blocks": {
    "<封锁名>": {
      "enabled": "false",          // 字符串，不是布尔
      "type": "continuous",
      "timer": "", "startTime": "2026,10,19,16,25",
      "lock": "none",              // none | randomText | password | delay ...
      "lockUnblock": "true", "restartUnblock": "true",
      "break": "none", "password": "", "randomTextLength": "30,words,show,keep,",
      "window": "lock@9,0@17,0",   // 时间窗：9:00~17:00
      "users": "all", "customUsers": [],
      "web": ["bilibili.com", ...],       // 黑名单站点
      "exceptions": ["file://*.*"],       // 例外（白名单）
      "apps": ["folder:F:/Naka", ...],    // 应用/文件夹封锁
      "schedule": []
    }
  },
  "settings":   { "password": "", "passwordStrict": false, "blockMode": "exit", "statsEnabled": "true" },
  "additional": { "paused": "false", "proStatus": "pro", "browserList": "chrome,msedge,firefox@@@ie,ddg" }
}
```

**只读访问**：用 `SQLITE_OPEN_READONLY` 打开，或整文件复制到临时路径再打开；绝不写这个库（`data-service.db` 里有 `hash(path, md5)` 完整性表，别去碰它）。所有布尔值都以字符串 `"true"/"false"` 存储，解析时别当 JSON 布尔。

## 5. Daymark 侧接线点

| 关注点 | 位置 |
| --- | --- |
| Tauri 命令注册表 | `src-tauri/src/lib.rs:740`（`generate_handler!`） |
| 触发点 | `start_execution` `lib.rs:403`；`finish_execution` `lib.rs:414` |
| 数据层 | `database.rs:488 create_execution_record`、`database.rs:519 finish_execution` |
| 命令参数携带 task 信息 | `ExecutionRecord`（含 `task_id`、`session_id`）→ 由 task 标题/项目映射到封锁集合 |
| 设置持久化 | `src/lib/settings.ts`：`load("settings.json", { autoSave: false })`，`AppSettings.preferences` 增加 `blocker` 段 |
| 依赖现状 | `Cargo.toml` 无 shell 插件；capabilities 仅 `core:default / store:default / dialog` |

推荐用 **Rust 侧 `std::process::Command`**（零新依赖、零新增 capability 授权）。注意：Rust 传参走 `CreateProcessW`，**中文封锁名不存在 PowerShell 那种控制台编码问题**（调研时踩到的乱码只影响 PowerShell 传参，不影响真正的 API 调用）。

## 6. 建议实现

### 6.1 模块

`src-tauri/src/blocker.rs`：

```rust
pub struct BlockerConfig { enabled: bool, exe_path: String, mode: Mode, profiles: HashMap<String, Vec<String>> }
pub enum Mode { Soft, HardMinutes }                 // Soft = -as-is + 结束时 -stop；Hard = -start -password N，不尝试 stop
pub fn list_blocks(exe_dir: &Path) -> Result<Vec<BlockInfo>>   // 读 data-app.db 只读，返回名称/enabled/lock/可控性
pub fn apply_start(cfg: &BlockerConfig, blocks: &[String]) -> Result<ApplyReport, BlockerError>
pub fn apply_stop(cfg: &BlockerConfig, blocks: &[String]) -> Result<ApplyReport, BlockerError>
```

### 6.2 触发时机

在 `start_execution` / `finish_execution` **成功写库之后**发起外部调用，并且绝不把 Cold Turkey 的失败变成执行记录的失败：数据先落库，联动结果作为一次非阻塞提示（沿用现有通知/行内提示风格）。

### 6.3 调用与校验（核心，因为失败是静默的）

1. 先读 DB 得到当前 `enabled`，**只对需要翻转的封锁发命令**（幂等，避免重复拉起）。
2. 串行执行，每个封锁一次 `Command::new(&exe_path).args(["-start", name, "-as-is"])`，`creation_flags(DETACHED_PROCESS)` 之类避免阻塞。
3. 发完轮询只读 DB，最多等 10 秒（实测 5~7 秒），确认 `blocks[name].enabled` 翻转到位。
4. 超时不翻转 → 记为"未生效"并在 UI 明确报出（多半是 4.4 的拒绝条件），不要静默重试第三次。
5. **不要用退出码判断成败**（实测恒为 0）。

### 6.4 孤儿封锁恢复

Daymark 启动时：若上次会话遗留了 `blocker.last_active` 且这些封锁现在仍 `enabled`，提示"检测到上次联动未正常结束，是否解除"，用户确认后再 `-stop`。`last_active` 存 `settings.json`（或 `execution_records` 关联表，但它是跨重启状态，放设置侧更合适）。

### 6.5 两种模式

- **Soft**（默认）：`-start "<n>" -as-is` … `-stop "<n>"`。结束由 Daymark 触发，用户也能手动关。
- **Hard**：`-start "<n>" -password <分钟>`（分钟取 `session_minutes`）。开启即锁死到点自解，Daymark 的"结束"只记录数据、不下达解锁命令。UI 必须说明此时"提前结束"不会解除封锁。

### 6.6 配置结构（写进 `settings.json` 的 `preferences.blocker`）

```jsonc
{
  "blocker": {
    "enabled": false,                       // 默认关，用户显式开启
    "exePath": "C:/Program Files/Cold Turkey/Cold Turkey Blocker.exe",
    "mode": "soft",
    "defaultProfile": "study",
    "profiles": {
      "study":  ["停止看视频_", "Distractions"],   // 每个 2~3 个，见 8 的 preflight
      "deep":   ["停止看视频_"]
    },
    "taskRules": [                          // 可选：按任务标题关键词覆盖 profile
      { "match": "Unit", "blocks": ["停止看视频_"] }
    ],
    "startBlocks": true, "stopOnFinish": true,
    "confirmBeforeApply": false,
    "lastActive": [], "lastActiveRecordId": null
  }
}
```

### 6.7 设置页需要提供的东西

- 开关（默认关）+ 一个"读取封锁列表"按钮：列出名称、当前 `enabled`、`lock`、`web/exceptions/apps` 数量，并把**不可脚本控制**的（`lock != none`，或设了设置密码）标灰并写明原因。
- 明确提示：联动依赖"该封锁未上锁"，且 Cold Turkey 是外部软件，Daymark 无法保证其行为。
- 若没装 Cold Turkey / 路径不存在：整个功能隐藏或置灰，并给出路径配置入口。

## 7. 不要做的事

- 不写 `data-app.db`，不生成/导入整份配置 JSON 去覆盖它（有并发写风险，且 Cold Turkey 在运行时会以内存态回写）。
- 不做"绕过封锁"的能力（删锁、改 `lock` 字段、杀进程、结束 ServiceHub.*）。这类需求请让用户在 Cold Turkey 界面自己做。
- 不把 Cold Turkey 当承诺装置卖点；文案区分 soft/hard。

## 8. 验收步骤（含可直接运行的脚本）

前置：在 Cold Turkey 界面新建一个**测试封锁**（建议保持本机已有的 `停止看视频_`，`lock=none`、站点若干、无设置密码）。

```powershell
# 1) 开启（封锁名带中文时用字符码构造，避开 PS5.1 控制台编码坑）
$n = [char]0x505C+[char]0x6B62+[char]0x770B+[char]0x89C6+[char]0x9891+'_'
Start-Process 'C:\Program Files\Cold Turkey\Cold Turkey Blocker.exe' -ArgumentList '-start',$n,'-as-is'
Start-Sleep 7
# 2) 回读状态（期望 enabled=true）
Copy-Item 'C:\ProgramData\Cold Turkey\data-app.db' "$env:TEMP\ct.db" -Force
# 用任意 SQLite 读 settings 表 key='settings' 的 JSON，检查 .blocks.$n.enabled
# 3) 关闭（期望 enabled=false）
Start-Process 'C:\Program Files\Cold Turkey\Cold Turkey Blocker.exe' -ArgumentList '-stop',$n
```

通过标准：

1. 2~3 个封锁能全部开启，回读全部 `enabled="true"`；`-stop` 后全部回 `"false"`。
2. Daymark 崩溃 / 强制结束后重启，能在提示下解除遗留封锁（6.4）。
3. 对 `lock=randomText` 的封锁发起 `-stop`：Daymark 必须报"未生效（该封锁已上锁）"，不能假装成功。
4. 联动失败不影响 `execution_records` 写入（6.2）。
5. 真实网页侧验证：开启封锁后用浏览器访问该封锁内某站点应被挡（本次调研**未做**此项，属实现阶段必做的一条）。

## 9. 已知坑

1. **静默失败**：GUI 子系统丢 stdout，`error.log` 只记 ServiceHub 的异常，CLI 拒绝时无任何痕迹 → 只能靠回读 DB。
2. **退出码恒为 0**（实测 `-stop` 一个不存在的封锁名也返回 0）。
3. **延迟 5~7 秒**：第二实例转交不是即时的，别并行轰多条命令。
4. **中文封锁名**：PowerShell 传参会乱码；Rust `Command` 正常。
5. **`-add` 不生效**：见 4.2 与第 10 节。批量维护名单的现成通路是界面里的 `Export all blocks...` / `Import blocks from file...` / 列表内 `ImportUrlsFromFile()`（纯文本、一行一个 URL、单次上限 5000 条）。
6. 主程序可能原本没在运行：第一次 `-start` 会把它拉起来并留在托盘，这是可见的副作用。
7. `settings.password` 一旦设置，CLI 全面失效；`passwordStrict` 也参与判定。本机当前为 `password=""`、`passwordStrict=false`。

## 10. 给开发组的未决问题

1. `-add "<name>" -web "<URL>"` 实测 4 次（封锁关着/开着、裸域名/完整 `http://`）都没写进 `exceptions`。剩余假设：**只在冷启动首次解析参数时生效**（未验证，需要退出 Cold Turkey 主程序后带参启动才能确认）。"执行中途精准放行某个网站"是否值得作为 P1 需求，取决于这个假设能否证实。
2. 封锁集合按"任务"还是按"时段"决定？`ExecutionRecord` 带 `task_id`，可以按任务标题/项目关键词映射（6.6 的 `taskRules`），但需求上用户只说了"2~3 个"。
3. 只覆盖网站封锁，还是也覆盖 `apps`（本机 `Edit` 封锁了 4 个文件夹）？
4. 时段被取消/标记 `missed` 时（`execution_sessions.status`），是否需要解除？
5. Hard 模式下如果用户提前点了"结束并保存"，UI 该提示什么（封锁仍在生效直到 N 分钟到）？
