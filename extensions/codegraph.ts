// pi-codegraph — pi extension
//
// CodeGraph support for pi: codegraph_explore tool, /codegraph-init,
// /codegraph-sync, /codegraph-status, and /codegraph-unlock commands.
//
// Bridges to CodeGraph by executing the CLI (see docs/adr/0001). Requires the
// codegraph CLI on PATH: npm i -g @colbymchenry/codegraph
// Upstream: https://github.com/colbymchenry/codegraph

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const INSTALL_HINT =
	"codegraph CLI not found on PATH. Install: npm i -g @colbymchenry/codegraph";

// Result of `codegraph version` this session — null until first check.
let cliAvailable: boolean | null = null;
let notifiedMissing = false;

async function execCg(
	pi: ExtensionAPI,
	args: string[],
	options: { signal?: AbortSignal; timeout?: number; cwd?: string } = {},
) {
	if (process.platform === "win32") {
		return await pi.exec("cmd.exe", ["/d", "/s", "/c", "codegraph", ...args], options);
	}
	return await pi.exec("codegraph", args, options);
}

async function ensureCli(pi: ExtensionAPI): Promise<boolean> {
	if (cliAvailable !== null) return cliAvailable;
	try {
		const result = await execCg(pi, ["version"], { timeout: 10_000 });
		cliAvailable = result.code === 0;
	} catch {
		cliAvailable = false;
	}
	return cliAvailable;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function outputOf(result: { stdout: string; stderr: string; code: number }): string {
	return (result.stdout + result.stderr).trim() || `exit ${result.code}`;
}

// Nearest ancestor directory containing a CodeGraph index, or null.
async function findIndexRoot(cwd: string): Promise<string | null> {
	let dir = path.resolve(cwd);
	for (;;) {
		try {
			await fs.access(path.join(dir, ".codegraph", "codegraph.db"));
			return dir;
		} catch { /* keep walking */ }
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

// Modeled on upstream's MCP SERVER_INSTRUCTIONS (src/mcp/server-instructions.ts):
// lead the agent to codegraph_explore BEFORE grep/read, plus anti-patterns and staleness handling.
// Injected into the system prompt every turn (before_agent_start): persistent presence
// survives compaction, unlike a one-shot session-start user message.
// Two variants keep token cost minimal: full guidance only while indexed,
// a single awareness line otherwise.
const INDEX_HINT = `# CodeGraph — this project is indexed (root: $ROOT)
Use \`codegraph_explore\` BEFORE grep/read for code structure, call paths, and blast radius. Verbatim line-numbered source returned is safe to edit directly. Trust AST results; do not re-verify with grep.`;

const AWARE_HINT = `# CodeGraph
\`codegraph_explore\` tool available: symbol source + call paths in one shot. If the project is not indexed it says so — then fall back to grep and suggest /codegraph-init.`;

export default function codegraphExtension(pi: ExtensionAPI) {
	// ── codegraph_explore tool ─────────────────────────────────────────────
	pi.registerTool({
		name: "codegraph_explore",
		label: "CodeGraph Explore",
		description:
			"PRIMARY tool for code questions — call it BEFORE grep/read. " +
			"One query returns the relevant symbols' verbatim line-numbered source plus the call paths between them and a blast-radius summary. " +
			"If the project is not indexed the output says so: continue with built-in tools and suggest the user run /codegraph-init.",
		promptSnippet:
			"codegraph_explore: symbol source + call paths in one shot from the project's CodeGraph index",
		promptGuidelines: [
			"For structural code questions (how does X work, where is X, what breaks if I change X), call codegraph_explore before grep.",
			"If codegraph_explore returns empty or says the project is not indexed, fall back to grep and suggest /codegraph-init. Never run codegraph init yourself.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Symbol names or a natural-language question about the code",
			}),
			path: Type.Optional(
				Type.String({
					description: "Project path to query; defaults to the current working directory",
				}),
			),
			maxFiles: Type.Optional(
				Type.Integer({
					description: "Maximum number of files to include source from",
				}),
			),
		}),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			// Query from the index root so the tool works from any subdirectory.
			const cwd = params.path ?? (await findIndexRoot(ctx.cwd)) ?? ctx.cwd;
			const args = ["explore", params.query, "-p", cwd];
			if (typeof params.maxFiles === "number" && params.maxFiles > 0) {
				args.push("--max-files", String(params.maxFiles));
			}
			const result = await execCg(pi, args, {
				signal,
				timeout: 120_000,
			});
			if (result.killed) return textResult("codegraph explore timed out (120s)");
			// Non-zero exits carry upstream's agent-friendly guidance (e.g. the
			// "not initialized" message) — pass it through verbatim.
			if (result.code !== 0) return textResult(outputOf(result));
			const out = result.stdout.trim();
			return textResult(
				out ||
					"codegraph explore returned no results. Retry with different query terms (symbol names work best); if it stays empty, fall back to grep.",
			);
		},
	});

	// ── /codegraph-init ────────────────────────────────────────────────────
	pi.registerCommand("codegraph-init", {
		description: "Build the CodeGraph index for the current project (codegraph init)",
		handler: async (args, ctx) => {
			if (!(await ensureCli(pi))) {
				if (ctx.hasUI) ctx.ui.notify(INSTALL_HINT, "error");
				return;
			}
			const target = args?.trim() || ctx.cwd;
			if (ctx.hasUI) {
				ctx.ui.notify(`Indexing ${target} — can take minutes on a large repo…`, "info");
			}
			const result = await execCg(pi, ["init", target], { timeout: 1_800_000 });
			const out = outputOf(result);
			const success = result.code === 0;
			if (ctx.hasUI) {
				ctx.ui.notify(
					success ? "CodeGraph index built." : `codegraph init failed (exit ${result.code})`,
					success ? "info" : "error",
				);
			}
			pi.sendMessage(
				{ customType: "codegraph-init", content: out, display: true },
				{ triggerTurn: false },
			);
		},
	});

	// ── /codegraph-sync ────────────────────────────────────────────────────
	pi.registerCommand("codegraph-sync", {
		description: "Sync CodeGraph changes since last index (codegraph sync)",
		handler: async (args, ctx) => {
			if (!(await ensureCli(pi))) {
				if (ctx.hasUI) ctx.ui.notify(INSTALL_HINT, "error");
				return;
			}
			const target = args?.trim() || ctx.cwd;
			if (ctx.hasUI) {
				ctx.ui.notify(`Syncing CodeGraph for ${target}…`, "info");
			}
			const result = await execCg(pi, ["sync", target], { timeout: 300_000 });
			const out = outputOf(result);
			if (ctx.hasUI) {
				ctx.ui.notify(out, result.code === 0 ? "info" : "warning");
			}
			pi.sendMessage(
				{ customType: "codegraph-sync", content: out, display: true },
				{ triggerTurn: false },
			);
		},
	});

	// ── /codegraph-status ──────────────────────────────────────────────────
	pi.registerCommand("codegraph-status", {
		description: "Show CodeGraph index status and statistics",
		handler: async (args, ctx) => {
			if (!(await ensureCli(pi))) {
				if (ctx.hasUI) ctx.ui.notify(INSTALL_HINT, "error");
				return;
			}
			const target = args?.trim() || ctx.cwd;
			const result = await execCg(pi, ["status", target], { timeout: 30_000 });
			const out = outputOf(result);
			if (ctx.hasUI) ctx.ui.notify(out, result.code === 0 ? "info" : "warning");
			pi.sendMessage(
				{ customType: "codegraph-status", content: out, display: true },
				{ triggerTurn: false },
			);
		},
	});

	// ── /codegraph-unlock ──────────────────────────────────────────────────
	pi.registerCommand("codegraph-unlock", {
		description: "Release stale CodeGraph database lock (codegraph unlock)",
		handler: async (args, ctx) => {
			if (!(await ensureCli(pi))) {
				if (ctx.hasUI) ctx.ui.notify(INSTALL_HINT, "error");
				return;
			}
			const target = args?.trim() || ctx.cwd;
			const result = await execCg(pi, ["unlock", target], { timeout: 10_000 });
			const out = outputOf(result);
			if (ctx.hasUI) ctx.ui.notify(out, result.code === 0 ? "info" : "warning");
			pi.sendMessage(
				{ customType: "codegraph-unlock", content: out, display: true },
				{ triggerTurn: false },
			);
		},
	});

	// ── session_start: CLI check + incremental sync ──────────────────────
	pi.on("session_start", async (_event, ctx) => {
		if (!(await ensureCli(pi))) {
			if (ctx.hasUI && !notifiedMissing) {
				notifiedMissing = true;
				ctx.ui.notify(INSTALL_HINT, "warning");
			}
			return;
		}

		const root = await findIndexRoot(ctx.cwd);
		if (root) {
			// Incremental sync; near-zero cost when nothing changed.
			void execCg(pi, ["sync", "-q", root], { timeout: 300_000 }).catch(() => {});
		}
	});


	// ── before_agent_start: system-prompt hint, every turn ───────────────
	// Appended to the current system prompt (never replaces it — other
	// extensions chain through the same value). Re-evaluated each turn, so it
	// survives compaction, picks up indexes built mid-session via
	// /codegraph-init, and resets to the base prompt automatically when the
	// index is gone. Unindexed projects get a one-line awareness hint so the
	// model knows the tool exists instead of defaulting to grep.
	pi.on("before_agent_start", async (event, ctx) => {
		// Sentinel = a hint's full first line: a bare "# CodeGraph" substring
		// can appear in project docs included in the base prompt.
		if (
			event.systemPrompt.includes("# CodeGraph — this project is indexed") ||
			event.systemPrompt.includes("# CodeGraph\n")
		) {
			return;
		}
		const root = await findIndexRoot(ctx.cwd);
		const hint = root ? INDEX_HINT.replace("$ROOT", root) : AWARE_HINT;
		return { systemPrompt: `${event.systemPrompt}\n\n${hint}` };
	});

}
