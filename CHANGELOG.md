# Changelog

All notable changes to `@izhimu/pi-codegraph` will be documented in this file.

## [0.4.0] - 2026-09-11

### Changed & Improved
- **Higher `codegraph_explore` adoption**: the system-prompt hint is no longer gated on an index existing at the exact cwd. Index detection now walks parent directories (`findIndexRoot`), so working from any subdirectory of an indexed project still yields the full hint, and `codegraph_explore` / session-start sync automatically query from the index root.
- **Always-on awareness**: unindexed projects now get a one-line hint stating the tool exists and falls back to grep, instead of total silence that let the model default to grep. Indexed projects get a compressed 2-line playbook; staleness details remain in `SKILL.md`. Net context cost: 1 line unindexed, 2 lines indexed, per turn.

## [0.3.0] - 2026-09-10

### Changed & Improved
- The index playbook (`INDEX_HINT`) is now injected into the system prompt on every turn while the project is indexed (`before_agent_start`), replacing the one-shot session-start user message. Survives compaction and picks up indexes built mid-session via `/codegraph-init`; the base prompt is restored automatically when the index is gone.
- **Prompt Token Optimization**: Compressed `INDEX_HINT` and `SKILL.md` by ~60%, eliminating background fluff while preserving all core behavioral constraints (AST priority, anti-grep verification, cached pointers, and staleness handling).
- Tool description and guidelines no longer hedge on "when the project has a .codegraph/ index" — `codegraph_explore` is unconditionally primary, with explicit fallback to grep when empty or unindexed.
- **Cleaner TUI**: Removed permanent bottom status bar indicator to reduce UI clutter.
- **Cross-Platform Compatibility**: Fully verified cross-platform execution on macOS, Linux, and Windows.

### Fixed
- Empty `codegraph explore` output now returns explicit retry/fallback guidance instead of an empty tool result that read as a broken tool.
- Duplicate-injection sentinel narrowed to the hint's full first line; a bare `# CodeGraph` substring in project docs no longer suppresses the hint.

## [0.2.1] - 2026-08-16

### Fixed
- **Accurate Index Detection**: Refined `.codegraph/codegraph.db` check to prevent false positives when `.codegraph/` contains only `.gitignore`.
- **Sync Feedback**: Improved background sync state transitions and notification handling.

## [0.2.0] - 2026-08-16

### Added
- **Maintenance Commands**: Added `/codegraph-sync` for manual sync and `/codegraph-unlock` for releasing stale database locks.
- **Query Limits**: Added `maxFiles` parameter to `codegraph_explore` tool to control source file output limits.
- **Windows Support**: Added `cmd.exe` execution wrapper for npm global binary compatibility on Windows.

## [0.1.0] - 2026-08-04

### Added
- Initial release of `@izhimu/pi-codegraph` extension for Pi coding agent.
- `codegraph_explore` tool for AST-based symbol exploration and call path analysis.
- `/codegraph-init` and `/codegraph-status` slash commands.
- Auto-sync on session start for indexed projects.
