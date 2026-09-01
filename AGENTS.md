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
