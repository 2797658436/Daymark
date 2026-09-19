# Git 对象库事故记录（2026-09-10）

性质：**已完全恢复**。工作区文件、36 个提交、393 个可达对象均完好；远端 `main` 未被污染。
本记录用于留痕，不需要作为发布阻断项。

## 1. 时间线与事实

### 1.1 预先存在的损伤（非本次引入）

`git commit` 时触发 `git maintenance` 的几何重包，报错：

```
fatal: bad tree object 2ec33605641b2becf324d94b27dc5a348d2bc000
error: failed to perform geometric repack
task 'geometric-repack' failed
```

诊断（只读）：

| 项 | 值 |
| --- | --- |
| 缺失对象 | `tree 2ec33605…` |
| 唯一引用者 | 提交 `e29768bc`（2026-09-02，"feat(ui): one-click complete on project tasks…"，在 pack 中） |
| 该提交可达性 | `git rev-list --all \| grep -c e29768bc` = **0**（`--all` 含 `refs/codex/*`） |
| 该提交是否在 reflog | **0** |
| `main` 历史完整性 | 36 提交，最近 10 个提交的 tree 全部可读 |

结论：缺失对象只被一个**不可达提交**引用，**不影响历史、不影响 push**，只让 `git maintenance` 永久失败。

### 1.2 连带损伤：`origin/main` 静默回退

几何重包失败时，loose ref 已被移除，而 `packed-refs` 仍停留在 2026-09-04 的旧值 `2105edaf`。

后果：`origin/main` 静默解析为两周前的提交，`git status` 假报 `ahead 11` —— **不报错，只给错值**。

另有两条坏 reflog 条目：`refs/remotes/origin/{HEAD,main}` 指向已不存在的 `489dc032`。

### 1.3 本次修复动作造成的二次损坏（已恢复）

用 `git archive` 解出上游提交对照验证 M3 用例时结论正常；随后为清除 1.1 的缺失对象，在 `%TEMP%` 的 `.git` 副本上验证了正确命令序列：

```
git reflog expire --expire-unreachable=now --all
git repack -a -d
git prune --expire=now
```

副本验证结果：fsck 完全干净、提交数 36 不变、可达对象数 393 不变。

但在**真实仓库**执行同一序列时，沙箱 safe-delete 层把 `.git/objects/pack/` **整个目录**搬进回收站：

- 200+ `missing blob`
- `fatal: bad object HEAD`
- `.git` 从 5.1M 缩到 154K

恢复：执行前已做完整 `.git` 备份（5.2M）→ `mv .git .git-destroyed-<ts>` → `cp -r <备份> .git`。

## 2. 恢复后校验

| 校验项 | 结果 |
| --- | --- |
| `git rev-list --count HEAD` | 36（与事故前一致） |
| `git rev-list --objects HEAD \| wc -l` | 393（与事故前一致） |
| `git rev-parse HEAD / main / origin/main` | 均为 `8d77b11` |
| `git fsck --full`（非 dangling） | 只剩 1.1 的 broken link（与事故前一致） |
| `git ls-remote origin` | `refs/heads/main = 8d77b11` |
| 工作树 | `M src-tauri/Cargo.toml`（换行符/stat 层）+ 未跟踪 `.bak-20260910` |

已生效的安全修复：删除两条坏 origin reflog；`git pack-refs --all` 使 `packed-refs` 中 main / origin-main 恢复为正确值，消除静默回退隐患。

## 3. 已知遗留缺陷

**broken link 未清除**：`commit e29768bc → tree 2ec33605`（missing）。

- 影响：每次 `git commit` / `git push` 会打印一次 repack 失败；几何重包无法完成。
- 不影响：提交、推送、检出、测试、打包。
- 修复方式（**不得在本沙箱内对真实仓库执行**）：在沙箱外终端，或对 `%TEMP%` 下的 `.git` 副本执行
  `git reflog expire --expire-unreachable=now --all && git repack -a -d && git prune --expire=now`，
  然后复验「36 提交 / 393 可达对象 / fsck 无 broken link」。

## 4. 环境红线（已写入用户级 skill `git-recycle-bin-recovery`）

WorkBuddy 沙箱的 safe-delete 层会拦截仓库内的批量删除，**包括 git 内部操作**。实测被搬走的对象有
`.git/objects/pack/`（整目录）、`.git/refs/remotes/origin/*`、`.git/{index,HEAD,packed-refs,maintenance,AUTO_MERGE}.lock`。

因此在沙箱内**禁止**对真实仓库执行 `git repack -a -d` / `git prune` / `git gc` / `git maintenance run`；
需要验证时只在 `%TEMP%` 的 `.git` 副本上进行。任何 `.git` 手术前先 `cp -r .git` 完整备份 —— 本次正是靠它恢复的。
