---
name: codegraph
description: Query the project's CodeGraph index (symbol source + call paths) via the codegraph_explore tool. Use when answering structural code questions — how X works, where X is, what a change affects — in a project that has a .codegraph/ index.
---

# CodeGraph

Query CodeGraph index via \`codegraph_explore\` for verbatim source, call paths, and blast radius.

## When to use

- Structural code questions ("how X works", "where X is", "what calls Y", "what breaks if Z changes").
- Before editing, to map symbols and blast radius. Prefer over grep/read on indexed projects.

## Parameters

- \`query\`: Symbol names, endpoint flows (\`mutateElement renderScene\`), or natural question.
- \`path\`: Subproject path containing \`.codegraph/\` (for monorepos). Defaults to cwd.
- \`maxFiles\`: Cap source files returned.

## Rules

- Trust AST output; never re-verify with grep.
- Call paths need exact symbol names; empty results list near-miss names — retry with those.
- "⚠️ files edited since sync": re-read only flagged files directly. "auto-sync DISABLED/RECOVERING" banner: whole index may be stale — read files directly until it clears.
- Unindexed project: use built-in tools; suggest user run \`/codegraph-init\` (never run auto-init).
