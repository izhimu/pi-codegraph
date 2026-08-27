# pi-codegraph

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![pi extension](https://img.shields.io/badge/pi-extension-green.svg)](https://github.com/earendil-works/pi)

[CodeGraph](https://github.com/colbymchenry/codegraph) support for [pi](https://github.com/earendil-works/pi). The agent gets a `codegraph_explore` tool — one query returns the relevant symbols' verbatim line-numbered source plus the call paths between them.

## Requirements

The `codegraph` CLI on `PATH`:

```bash
npm i -g @colbymchenry/codegraph
```

## Install

### npm (recommended)

```bash
pi install npm:@izhimu/pi-codegraph
```

### From git

```bash
# Global
pi install git:github.com/izhimu/pi-codegraph

# Project-local (shared with team via .pi/settings.json)
pi install git:github.com/izhimu/pi-codegraph -l
```

### From local path

```bash
pi install /path/to/pi-codegraph
```

### Quick test (no install)

```bash
pi -e ./extensions/codegraph.ts
```

## What you get

- **`codegraph_explore` tool** — the agent's primary code-intelligence tool. Query with symbol names or a natural-language question; optionally pass `path` to query another indexed project, and `maxFiles` to cap source lines.
- **`/codegraph-init [--force] [path]`** — build the index for the project (`codegraph init`). `--force` indexes home/root.
- **`/codegraph-sync [path]`** — manually sync changes since last index (`codegraph sync`).
- **`/codegraph-index [--force] [path]`** — rebuild the index from scratch (`codegraph index`).
- **`/codegraph-uninit [--force] [path]`** — remove `.codegraph/` (`codegraph uninit`). Confirms in the TUI unless `--force` is passed.
- **`/codegraph-status [path]`** — index status and statistics (`codegraph status`).
- **`/codegraph-unlock [path]`** — release stale database locks if daemon crashed (`codegraph unlock`).
- **`/codegraph-affected [base-ref]`** — list test files affected by changes since a git ref (default `HEAD`).
- **Session-start sync** — runs `codegraph sync -q` once per session so the index reflects your last edits.

## Usage

Ask structural code questions as usual — the agent calls `codegraph_explore` first when the project is indexed:

- "How does session loading work?"
- "What breaks if I change `ExtensionRunner.emit`?"

The first time you use pi in a fresh project, build the index once:

```
/codegraph-init
```

Indexing is always your explicit action — the agent never runs `codegraph init` itself (see `docs/adr/0002`).

## How It Works

pi has no native MCP support, so the extension bridges to CodeGraph by executing the CLI — `codegraph explore` produces the same output as the `codegraph_explore` MCP tool (see `docs/adr/0001`). One `pi.exec` per tool call: no daemon, no JSON-RPC, nothing to leak or recover.

The `SKILL.md` in `skills/codegraph/` is auto-discovered by pi's skill system and teaches the agent when to prefer the tool over grep/read.

## Project Structure

```
pi-codegraph/
├── extensions/
│   └── codegraph.ts      # pi ExtensionAPI integration
├── skills/
│   └── codegraph/
│       └── SKILL.md      # agent guidance for codegraph_explore
├── docs/adr/             # design decisions
├── CONTEXT.md            # domain glossary
├── package.json          # pi package manifest
├── tsconfig.json
├── LICENSE
└── README.md
```

## Development

```bash
npm install
npm run typecheck
```

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request

## License

[MIT](LICENSE) © [izhimu](https://github.com/izhimu)
