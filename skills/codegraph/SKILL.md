---
name: codegraph
description: Query the project's CodeGraph index (symbol source + call paths) via the codegraph_explore tool. Use when answering structural code questions — how X works, where X is, what a change affects — in a project that has a .codegraph/ index.
---

# CodeGraph

The `codegraph_explore` tool answers structural code questions in one shot: the relevant symbols' verbatim line-numbered source, the call paths between them, and a blast-radius summary. It reads the project's CodeGraph index (`.codegraph/`), built and maintained by the `codegraph` CLI.

## When to use

- "How does X work?" / "Where is X?" / "What calls Y?" / "What breaks if I change Z?"
- Before an edit, to map the symbols you are about to touch and inspect the blast radius.
- Prefer it over grep/read for structural exploration **when the project has a `.codegraph/` index**.

## How to query

- `query`: symbol names (`CodeGraph open`, `MCPSession`), endpoint flows (`mutateElement renderScene`), or a natural-language question. Naming a file or symbol returns its current line-numbered source.
- `path`: optional project path. Defaults to the current working directory. In a monorepo, pass the sub-project directory that contains `.codegraph/`.
- `maxFiles`: optional integer to limit how many file sources are returned.

## Anti-patterns & Guidance

- **Trust AST results.** Don't re-verify codegraph output with grep.
- **Already sent earlier in this conversation.** When this pointer appears, the lines are already in your session context — scroll back instead of re-fetching or reading the file.
- **Staleness banner.** If output warns `⚠️ Some files referenced below were edited since the last index sync`, read only those specific files directly; other files in the response remain fresh.
- **No index, no tool.** If the output says the project isn't indexed, stop calling `codegraph_explore` for that project this session and use built-in tools. Indexing is the user's decision — suggest the user run `/codegraph-init` if appropriate.
- **Structured call chains.** `codegraph_explore` already inlines callers/callees/impact. If you need `--json` output for a specific symbol, run the CLI via bash: `codegraph callers <symbol> --json`, `codegraph callees <symbol> --json`, or `codegraph impact <symbol> --json`. Do not add extra tools for this.
