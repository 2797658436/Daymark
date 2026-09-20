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

## 3. 遗留缺陷：已清除（2026-09-20）

**broken link `commit e29768bc → tree 2ec33605` 已消除。** 实际处置与本记录原先推测的步骤不同，且不需要 `repack`／`prune`：

1. **先发现一个未被记录的损伤**：`pack-eecb61dafeb54b7bdcb73d7dca0ac9aa2bab1d46` 只剩 `.pack`、`.rev`、`.keep`，**`.idx` 缺失**，导致该包内所有对象对 Git 不可见（`git fsck` 启动时即在警告 `no corresponding .idx`）。用 `git index-pack <pack>` 重建索引后：可见对象 `in-pack` 由 **708 → 922**（找回 214 个），`garbage` 由 3（301 字节）→ **0**。这一步是纯增量写入，非破坏性。
2. **`2ec33605` 确实不在任何包内** —— 上一步之后仍然 `missing tree`。所以它不是"索引丢了"，是对象本身真的没了。
3. **清除它只需让引用者不可达**：执行 `git reflog expire --expire-unreachable=now --all` 后，`e29768bc` 变为普通 dangling commit，`git fsck --full` **退出码 0、不再报告 broken link 或 missing tree**。`git repack`／`git prune` 都不需要。

**先在 `%TEMP%` 副本上彩排验证，再对真实仓库执行**（副本结果与真实仓库一致）。执行前后均对整个 `.git` 做了完整备份。

复验结果：

| 项 | 值 |
| --- | --- |
| 提交数 | 43（执行前后一致，未丢历史） |
| `git fsck --full` | 退出码 0，无 broken link、无 missing |
| `git maintenance run --task=incremental-repack` | **退出码 0**（此前几何重包必失败） |
| `HEAD` / `main` / `origin/main` | 均为 `04a375f`，三者一致 |

**原始症状（每次提交／推送打印一次 repack 失败）随之消失。**

同时暴露出一项与本次事故无关的既有问题：`.git` 内存在 `refs/codex/turn-diffs/checkpoints/<超长路径>` 形式的引用，路径超出 Windows 限制，Git 无法解析（`Filename too long` → `invalid sha1 pointer 0000…`）。它会让 `reflog expire --all` 打印一条 `fatal` 但不阻断上述结果。这些引用来自 Codex 工具，与本项目无关，清理需另行决定。


## 4. 环境红线（已写入用户级 skill `git-recycle-bin-recovery`）

WorkBuddy 沙箱的 safe-delete 层会拦截仓库内的批量删除，**包括 git 内部操作**。实测被搬走的对象有
`.git/objects/pack/`（整目录）、`.git/refs/remotes/origin/*`、`.git/{index,HEAD,packed-refs,maintenance,AUTO_MERGE}.lock`。

因此在沙箱内**禁止**对真实仓库执行 `git repack -a -d` / `git prune` / `git gc` / `git maintenance run`；
需要验证时只在 `%TEMP%` 的 `.git` 副本上进行。任何 `.git` 手术前先 `cp -r .git` 完整备份 —— 本次正是靠它恢复的。
