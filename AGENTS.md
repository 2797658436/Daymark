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

Use the `ops-batch` skill for these moves rather than hand-written `mv` or `rm` commands: it plans first with no side effects, refuses personal directories, protected paths, overwrites, symlink traversal and cross-volume moves, and writes a `MANIFEST.md` into the batch folder for the user to read.

## Browser and visual verification

Agents cannot see the screen, so every headed browser window is visible noise to the user. Treat browser sessions as a shared resource:

- **Default to headless.** Playwright is headless unless `headless: false` is passed; use it for layout, screenshots, computed styles and DOM checks. Open a headed browser only when headless cannot render the thing under test — for example Chromium uses overlay scrollbars in headless mode, so `::-webkit-scrollbar` styles are not painted, or the check is about OS-level window behavior.
- **One browser session per verification batch.** Put every scenario into one script and reuse a single `browser` instance; never launch a browser per screenshot, per probe, or in parallel. A task may open at most **one** headed browser session unless the user explicitly agrees to more.
- **Announce a headed session before opening it**, and state in the final report why headless was insufficient.
- **Always clean up in `finally`**: close the browser, stop any dev/preview server you started, and do not leave windows for the user to close. If a probe crashes, fix its cleanup before rerunning instead of relaunching blindly.
- **Reuse the repository scripts first**: `scripts/visual-evidence.mjs` (headless by default; `--headed` only for the exception above), `scripts/run-e2e.mjs` and `scripts/measure-perf.mjs`. One-off probes belong in `output/` (gitignored) and must follow the same rules.
- **Before finishing, verify nothing is left running**: `Get-Process chrome,msedge,node -ErrorAction SilentlyContinue` and `Get-NetTCPConnection -State Listen | Where-Object LocalPort -in 1420,4174,4175,4176,4177`.
