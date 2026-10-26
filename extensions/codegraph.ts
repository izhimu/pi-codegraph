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
For ANY code investigation, MUST call \`codegraph_explore\` FIRST, before grep/read. This includes route/URL, symbol, caller, and implementation lookups. Use grep afterward only for remaining literal-text/config searches. Verbatim line-numbered source returned is safe to edit directly. Trust AST results; do not re-verify with grep.
Before editing a shared symbol or public contract, call \`codegraph_explore\` on it to see all callers first — never blind-edit.`;

const AWARE_HINT = `# CodeGraph
\`codegraph_explore\` tool available: symbol source + call paths in one shot. Try it first for code questions; if it reports no index, fall back to grep and suggest the user run /codegraph-init.`;

// Spacing between background auto-syncs: mid-session edits are indexed before
// the model's next query without spawning a sync process on every single turn.
const AUTO_SYNC_INTERVAL_MS = 30_000;

// ── Session stats ─────────────────────────────────────────────────────────
const ESC = "\x1b[";
const DIM = `${ESC}2m`;
const RST = `${ESC}0m`;

interface SessionStats {
	calls: number;
	hits: number;
	empty: number;
	errors: number;
}

let sessionStats: SessionStats = { calls: 0, hits: 0, empty: 0, errors: 0 };

function statsLine(): string {
	const s = sessionStats;
	return (
		` ${s.calls} explore calls ${DIM}│${RST} ${s.hits} hits ${DIM}│${RST}` +
		` ${s.empty} empty ${DIM}│${RST} ${s.errors} errors ${DIM}(this session)${RST}`
	);
}

export default function codegraphExtension(pi: ExtensionAPI) {
	// Timestamp of the last background sync — shared by session_start and the
	// per-turn auto-sync so both throttle together.
	let lastAutoSyncAt = 0;

	function scheduleSync(pi: ExtensionAPI, root: string) {
		lastAutoSyncAt = Date.now();
		// Incremental sync; near-zero cost when nothing changed.
		void execCg(pi, ["sync", "-q", root], { timeout: 300_000 }).catch(() => {});
	}
	// ── codegraph_explore tool ─────────────────────────────────────────────
	pi.registerTool({
		name: "codegraph_explore",
		label: "CodeGraph Explore",
		description:
			"PRIMARY tool for ANY code investigation, including route/URL and symbol lookups — call it BEFORE grep/read. " +
			"One query returns the relevant symbols' verbatim line-numbered source plus the call paths between them and a blast-radius summary. " +
			"If the project is not indexed the output says so: continue with built-in tools and suggest the user run /codegraph-init.",
		promptSnippet:
			"codegraph_explore: route/URL lookups, symbol source + call paths in one shot from the project's CodeGraph index",
		promptGuidelines: [
			"For any code investigation, call codegraph_explore before grep/read, including route/URL, symbol, caller, and implementation lookups. Use grep afterward only for remaining literal-text/config searches.",
			"Before editing a shared symbol or public contract, call codegraph_explore on it to see all callers first.",
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
			sessionStats.calls++;
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
			if (result.killed) {
				sessionStats.errors++;
				return textResult("codegraph explore timed out (120s)");
			}
			// Non-zero exits carry upstream's agent-friendly guidance (e.g. the
			// "not initialized" message) — pass it through verbatim.
			if (result.code !== 0) {
				sessionStats.errors++;
				return textResult(outputOf(result));
			}
			const out = result.stdout.trim();
			if (out) sessionStats.hits++;
			else sessionStats.empty++;
			return textResult(
				out ||
					"codegraph explore returned no results. Retry with different query terms (symbol names work best); if it stays empty, fall back to grep.",
			);
		},
		// oh-my-pi defaults extension tools to loadMode "discoverable": the
		// schema stays off every request, reachable only via tool search or
		// xd:// mounting, so the model never sees it as a callable function.
		// Declaring "essential" keeps this tool top-level there; pi stores tool
		// definitions verbatim and ignores the extra key.
		...({ loadMode: "essential" } as const),
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
			const out = `${outputOf(result)}\n\n${statsLine()}`;
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
		sessionStats = { calls: 0, hits: 0, empty: 0, errors: 0 };
		if (!(await ensureCli(pi))) {
			if (ctx.hasUI && !notifiedMissing) {
				notifiedMissing = true;
				ctx.ui.notify(INSTALL_HINT, "warning");
			}
			return;
		}

		const root = await findIndexRoot(ctx.cwd);
		if (root) {
			scheduleSync(pi, root);
		}
	});


	// ── before_agent_start: auto-sync + system-prompt hint, every turn ───
	// Appended to the current system prompt (never replaces it — other
	// extensions chain through the same value). Re-evaluated each turn, so it
	// survives compaction, picks up indexes built mid-session via
	// /codegraph-init, and resets to the base prompt automatically when the
	// index is gone. Unindexed projects get a one-line awareness hint so the
	// model knows the tool exists instead of defaulting to grep.
	pi.on("before_agent_start", async (event, ctx) => {
		// pi renders event.systemPrompt as one string; oh-my-pi passes string[]
		// segments (rendered "\n\n"-joined downstream). Merge to one string and
		// return a string: native on pi, re-wrapped into [string] by oh-my-pi.
		const segments: string[] = Array.isArray(event.systemPrompt)
			? event.systemPrompt
			: [event.systemPrompt];
		const prompt = segments.join("\n\n");
		const root = await findIndexRoot(ctx.cwd);
		// Auto-sync (fire-and-forget, throttled): index mid-session edits before
		// the model's next query. Runs before the sentinel early-return — hosts
		// that feed the modified prompt back still need syncing on later turns.
		if (
			root &&
			Date.now() - lastAutoSyncAt > AUTO_SYNC_INTERVAL_MS &&
			(await ensureCli(pi))
		) {
			scheduleSync(pi, root);
		}
		// Sentinel = a hint's full first line: a bare "# CodeGraph" substring
		// can appear in project docs included in the base prompt.
		if (
			prompt.includes("# CodeGraph — this project is indexed") ||
			prompt.includes("# CodeGraph\n")
		) {
			return;
		}
		const hint = root ? INDEX_HINT.replace("$ROOT", root) : AWARE_HINT;
		return { systemPrompt: `${prompt}\n\n${hint}` };
	});

}
