# Daymark agent guidance

## Agent skills

### Issue tracker

Specifications and work items live in GitHub Issues for `2797658436/Daymark`; external pull requests are not treated as a request surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix` labels. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. Read the root `CONTEXT.md` and relevant decisions under `docs/adr/` before changing product behavior. See `docs/agents/domain.md`.

### Implementation guide and document sync

- Before changing product code, data models, migrations, backup/restore, settings persistence, desktop behavior, or test infrastructure, read `docs/PROJECT-GUIDE.md`.
- When the user says “需要更新文档了”, “更新项目文档”, “同步文档”, “让文档和代码保持一致”, or an equivalent request, follow the complete “文档同步协议” in `docs/PROJECT-GUIDE.md`.
- Documentation sync must be based on the real production code and tests, and must preserve the user's existing uncommitted changes.

### Repository cleanup

Never delete build or dependency leftovers in place, and never `rm -rf` a directory tree inside the sandbox: safe-delete sends every file and every subdirectory to the Recycle Bin individually, so clearing `node_modules` produces roughly 18,000 entries.

Move anything you intend to discard into `_quarantine/<YYYY-MM-DD>_<short-description>/` instead — a same-volume rename never touches the Recycle Bin. Only regenerable content belongs there (`node_modules/`, `dist/`, `src-tauri/target/`, `test-results/`, `output/`, caches); never `src/`, `docs/`, `.git/`, `.workbuddy-ai/`, or the user's uncommitted changes.

Agents move, they do not discard: after the batch is verified, the user deletes that one folder in Explorer. Keep at most one undiscarded batch. See `_quarantine/README.md`.
