# Changelog

## [0.3.0] - 2026-09-10

### Changed
- The index playbook (`INDEX_HINT`) is now injected into the system prompt on every turn while the project is indexed (`before_agent_start`), replacing the one-shot session-start user message. Survives compaction and picks up indexes built mid-session via `/codegraph-init`; the base prompt is restored automatically when the index is gone.
- Tool description and guidelines no longer hedge on "when the project has a .codegraph/ index" — `codegraph_explore` is unconditionally primary, with explicit fallback to grep when empty or unindexed.

### Fixed
- Empty `codegraph explore` output now returns explicit retry/fallback guidance instead of an empty tool result that read as a broken tool.
- Duplicate-injection sentinel narrowed to the hint's full first line; a bare `# CodeGraph` substring in project docs no longer suppresses the hint.

## [0.2.1] - 2026-08-16

### Fixed
- Accurate index check (`.codegraph/codegraph.db`, not just the directory) and sync status indicator.

## [0.2.0] - 2026-08-16

### Added
- `/codegraph-sync` and `/codegraph-unlock` commands.
- `maxFiles` option for `codegraph_explore`.
- Status bar indicator for index/sync state.
- win32 compatibility.

## [0.1.0] - 2026-08-04

### Added
- `codegraph_explore` tool bridging to the CodeGraph CLI.
- `/codegraph-init` and `/codegraph-status` commands.
- Session-start index sync and context hint for indexed projects.
