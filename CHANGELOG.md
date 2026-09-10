# Changelog

All notable changes to `@izhimu/pi-codegraph` will be documented in this file.

## [0.3.0] - 2026-08-22

### Changed & Improved
- **Prompt Token Optimization**: Compressed `INDEX_HINT` and `SKILL.md` by ~60%, eliminating background fluff while preserving all core behavioral constraints (AST priority, anti-grep verification, cached pointers, and staleness handling).
- **Cleaner TUI**: Removed permanent bottom status bar indicator to reduce UI clutter.
- **Cross-Platform Compatibility**: Fully verified cross-platform execution on macOS, Linux, and Windows.

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
