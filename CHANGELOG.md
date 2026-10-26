# Changelog

All notable changes to `@izhimu/pi-codegraph` will be documented in this file.

## [0.5.2] - 2026-10-26

### Fixed
- **Default CodeGraph selection for route/URL investigations**: the indexed system prompt, tool description/guidelines, and skill now require `codegraph_explore` first for any code investigation, explicitly including route/URL lookups. `grep` is reserved for remaining literal-text/config searches afterward, preventing endpoint investigations from bypassing CodeGraph.

## [0.5.1] - 2026-10-26

### Fixed
- **ANSI escape sequence in session stats line**: corrected `ESC` constant definition from `\x1b` to `\x1b[` (Control Sequence Introducer) in `extensions/codegraph.ts`. Previously, the missing bracket caused terminals to reject the escape sequence and render trailing literal `m` artifacts around status delimiters (`2m│ 0m` -> `m│m`).

## [0.5.0] - 2026-10-24

### Added
- **Session call stats**: `/codegraph-status` now ends with a `codegraph_explore` usage line for this session — calls, hits, empty results, errors (reset at session start), mirroring pi-rtk's session stats line.
- **Per-turn auto-sync**: while a project is indexed, a throttled (30s) incremental `codegraph sync -q` runs in the background on every turn, not just at session start — mid-session edits are indexed before the model's next query. Session-start and per-turn syncs share one throttle.

### Fixed
- **oh-my-pi compatibility**: `before_agent_start` now handles oh-my-pi's `string[]` system prompt (segments joined with `\n\n`, hint returned as one plain string, which oh-my-pi re-wraps into an array). Previously the sentinel check used array `includes` (exact-element match, never true), so the hint was re-appended every turn, and multi-segment prompts were comma-joined by template interpolation.
- **oh-my-pi tool visibility**: `codegraph_explore` now declares `loadMode: "essential"` — oh-my-pi defaults extension tools to `"discoverable"` (schema kept off every request, reachable only via tool search / `xd://` mounting), which is why the model there never called it. pi stores tool definitions verbatim and ignores the extra key.

### Changed
- Synced `SKILL.md` guidance with upstream codegraph 1.6.x server instructions: dropped the "Already sent earlier" dedup rule (upstream made cross-call dedup opt-in via `CODEGRAPH_EXPLORE_DEDUP=1`, and the CLI bridge never emits it), added exact-symbol-name retry guidance and the auto-sync DISABLED/RECOVERING staleness banners.
- **Stronger invocation triggers**: the indexed hint gains a pre-edit rule ("before editing a shared symbol or public contract, see all callers first"), the unindexed awareness hint now leads with "try it first" instead of the grep fallback, and a matching prompt guideline was added (pi hosts).

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
