// pi-codegraph — pi extension
//
// CodeGraph support for pi: codegraph_explore tool, /codegraph-init,
// /codegraph-sync, /codegraph-index, /codegraph-uninit, /codegraph-status,
// /codegraph-unlock, and /codegraph-affected commands.
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

const STATUS_READY = "codegraph";
const STATUS_INIT = "codegraph:init";
const STATUS_SYNC = "codegraph:sync";
const STATUS_INDEX = "codegraph:index";
const STATUS_KEYS = [STATUS_READY, STATUS_INIT, STATUS_SYNC, STATUS_INDEX] as const;

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

async function ensureCli(pi: ExtensionAPI, opts: { force?: boolean } = {}): Promise<boolean> {
	if (!opts.force && cliAvailable === true) return true;
	if (!opts.force && cliAvailable === false) return false;
	try {
		const result = await execCg(pi, ["version"], { timeout: 10_000 });
		cliAvailable = result.code === 0;
	} catch {
		cliAvailable = false;
	}
	return cliAvailable;
}

async function requireCli(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	opts: { force?: boolean } = {},
): Promise<boolean> {
	if (await ensureCli(pi, opts)) return true;
	if (ctx.hasUI) ctx.ui.notify(INSTALL_HINT, "error");
	return false;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

function outputOf(result: { stdout: string; stderr: string; code: number }): string {
	return (result.stdout + result.stderr).trim() || `exit ${result.code}`;
}

async function isIndexed(cwd: string): Promise<boolean> {
	try {
		await fs.access(path.join(cwd, ".codegraph", "codegraph.db"));
		return true;
	} catch {
		return false;
	}
}

/** Strip a leading @ (some models include it) and resolve against the session cwd. */
function resolveProjectPath(raw: string | undefined, cwd: string): string {
	const input = (raw ?? cwd).replace(/^@/, "");
	return path.resolve(cwd, input);
}

function parseForceAndPath(
	args: string | undefined,
	cwd: string,
): { force: boolean; target: string } {
	const raw = (args ?? "").trim();
	const force = /(?:^|\s)(?:--force|-f)(?:\s|$)/.test(raw);
	const rest = raw.replace(/(?:^|\s)(?:--force|-f)(?=\s|$)/g, " ").trim();
	return { force, target: resolveProjectPath(rest || undefined, cwd) };
}

function hasIndexHint(ctx: ExtensionContext): boolean {
	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	return branch.some(
		(entry: { type?: string; customType?: string }) =>
			entry.type === "custom_message" && entry.customType === "codegraph-context",
	);
}

function injectIndexHint(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (hasIndexHint(ctx)) return;
	pi.sendMessage(
		{ customType: "codegraph-context", content: INDEX_HINT, display: false },
		{ triggerTurn: false },
	);
}

function statusLabel(ctx: ExtensionContext, label: string): string {
	return ctx.ui.theme?.fg ? `${ctx.ui.theme.fg("accent", "⬡")} ${label}` : `⬡ ${label}`;
}

function setStatus(ctx: ExtensionContext, key: string, label: string | undefined): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(key, label ? statusLabel(ctx, label) : undefined);
}

function setReadyStatus(ctx: ExtensionContext, indexed: boolean): void {
	setStatus(ctx, STATUS_READY, indexed ? "index" : undefined);
}

function clearAllStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	for (const key of STATUS_KEYS) ctx.ui.setStatus(key, undefined);
}

async function pathCompletions(
	prefix: string,
): Promise<{ value: string; label: string }[] | null> {
	const raw = prefix
		.replace(/(?:^|\s)(?:--force|-f)(?=\s|$)/g, " ")
		.trimStart()
		.replace(/^@/, "")
		.replace(/\\/g, "/");
	const endsWithSlash = raw.endsWith("/");
	const slash = raw.lastIndexOf("/");
	const dirPart = endsWithSlash ? raw : slash >= 0 ? raw.slice(0, slash + 1) : "";
	const partial = endsWithSlash ? "" : slash >= 0 ? raw.slice(slash + 1) : raw;
	try {
		const entries = await fs.readdir(path.resolve(dirPart || "."), { withFileTypes: true });
		const items: { value: string; label: string }[] = [];
		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".")) {
				continue;
			}
			if (partial && !entry.name.toLowerCase().startsWith(partial.toLowerCase())) continue;
			const value = `${dirPart}${entry.name}${entry.isDirectory() ? "/" : ""}`;
			items.push({ value, label: entry.isDirectory() ? `${entry.name}/` : entry.name });
		}
		items.sort((a, b) => a.label.localeCompare(b.label));
		return items.length > 0 ? items.slice(0, 50) : null;
	} catch {
		return null;
	}
}

function postCommand(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	customType: string,
	out: string,
	code: number,
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(out, code === 0 ? "info" : "warning");
	}
	pi.sendMessage({ customType, content: out, display: true }, { triggerTurn: false });
}

// Modeled on upstream's MCP SERVER_INSTRUCTIONS (src/mcp/server-instructions.ts):
// lead the agent to codegraph_explore BEFORE grep/read, plus anti-patterns and staleness handling.
const INDEX_HINT = `# CodeGraph — this project is indexed

A \`.codegraph/\` index exists here: SQLite knowledge graph of every symbol, edge, and file (30+ languages). ONE \`codegraph_explore\` call returns the relevant symbols' verbatim line-numbered source (treat it as already Read — safe to Edit from) PLUS call paths between them and a blast-radius summary of what depends on them.

- For structural questions (how does X work / where is X / who calls Y / what breaks if I change Z), call \`codegraph_explore\` INSTEAD of grep + read — usually ONE call answers the whole question.
- Call it BEFORE and WHILE writing or editing code: it puts the blast radius in view before you touch a symbol you can name.
- Flow tracing: name endpoint symbols (e.g. \`mutateElement renderScene\`) to surface the path across dynamic-dispatch hops.
- Anti-patterns: don't grep or Read first; don't re-verify codegraph output with grep (AST-derived, more accurate than grep); don't reconstruct a flow by hand.
- "Already sent earlier in this conversation": pointer means content is already in context — do not re-fetch or Read.
- Staleness: if tool output contains "⚠️ Some files referenced below were edited since the last index sync", read only those flagged files directly.
- Multi-project / Monorepo: pass \`path\` to query any indexed sub-project directory.
- If a project has no \`.codegraph/\`, use built-in tools there; indexing is the user's decision — suggest /codegraph-init if it comes up.`;

export default function codegraphExtension(pi: ExtensionAPI) {
	// ── codegraph_explore tool ─────────────────────────────────────────────
	pi.registerTool({
		name: "codegraph_explore",
		label: "CodeGraph Explore",
		description:
			"PRIMARY tool for code questions — call it BEFORE grep/read when the project has a .codegraph/ index. " +
			"One query returns the relevant symbols' verbatim line-numbered source plus the call paths between them and a blast-radius summary. " +
			"If the project is not indexed the output says so: continue with built-in tools and suggest the user run /codegraph-init.",
		promptSnippet:
			"codegraph_explore: symbol source + call paths in one shot from the project's CodeGraph index",
		promptGuidelines: [
			"For structural code questions (how does X work, where is X, what breaks if I change X), prefer codegraph_explore over grep when the project has a .codegraph/ index.",
			"When codegraph_explore reports the project is not indexed, do not run codegraph init yourself; suggest the user run /codegraph-init.",
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
					minimum: 1,
				}),
			),
		}),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			if (!(await ensureCli(pi))) return textResult(INSTALL_HINT);
			const cwd = resolveProjectPath(params.path, ctx.cwd);
			const args = ["explore", params.query, "-p", cwd];
			if (typeof params.maxFiles === "number" && params.maxFiles > 0) {
				args.push("--max-files", String(params.maxFiles));
			}
			const result = await execCg(pi, args, {
				signal,
				timeout: 120_000,
				cwd,
			});
			if (result.killed) return textResult("codegraph explore timed out (120s)");
			// Non-zero exits carry upstream's agent-friendly guidance (e.g. the
			// "not initialized" message) — pass it through verbatim.
			if (result.code !== 0) return textResult(outputOf(result));
			return textResult(result.stdout.trim());
		},
	});

	// ── /codegraph-init ────────────────────────────────────────────────────
	pi.registerCommand("codegraph-init", {
		description:
			"Build the CodeGraph index for the current project (codegraph init). --force indexes home/root.",
		getArgumentCompletions: pathCompletions,
		handler: async (args, ctx) => {
			if (!(await requireCli(pi, ctx))) return;
			const { force, target } = parseForceAndPath(args, ctx.cwd);
			if (ctx.hasUI) {
				ctx.ui.notify(`Indexing ${target} — can take minutes on a large repo…`, "info");
			}
			setStatus(ctx, STATUS_INIT, "init");
			try {
				// -i is a no-op on current CLI and still indexes on pre-0.9.8; -y skips TTY prompts
				// (pi.exec stdin is ignored). --force overrides the home/root safety check.
				const cliArgs = ["init", "-i", "-y"];
				if (force) cliArgs.push("--force");
				cliArgs.push(target);
				const result = await execCg(pi, cliArgs, { timeout: 1_800_000, cwd: target });
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
				if (success && (await isIndexed(ctx.cwd))) injectIndexHint(pi, ctx);
			} finally {
				setStatus(ctx, STATUS_INIT, undefined);
				setReadyStatus(ctx, await isIndexed(ctx.cwd));
			}
		},
	});

	// ── /codegraph-sync ────────────────────────────────────────────────────
	pi.registerCommand("codegraph-sync", {
		description: "Sync CodeGraph changes since last index (codegraph sync)",
		getArgumentCompletions: pathCompletions,
		handler: async (args, ctx) => {
			if (!(await requireCli(pi, ctx))) return;
			const { target } = parseForceAndPath(args, ctx.cwd);
			if (ctx.hasUI) {
				ctx.ui.notify(`Syncing CodeGraph for ${target}…`, "info");
			}
			setStatus(ctx, STATUS_SYNC, "sync");
			try {
				const result = await execCg(pi, ["sync", target], { timeout: 300_000, cwd: target });
				postCommand(pi, ctx, "codegraph-sync", outputOf(result), result.code);
			} finally {
				setStatus(ctx, STATUS_SYNC, undefined);
				setReadyStatus(ctx, await isIndexed(ctx.cwd));
			}
		},
	});

	// ── /codegraph-index ───────────────────────────────────────────────────
	pi.registerCommand("codegraph-index", {
		description:
			"Rebuild the CodeGraph index from scratch (codegraph index). --force indexes home/root.",
		getArgumentCompletions: pathCompletions,
		handler: async (args, ctx) => {
			if (!(await requireCli(pi, ctx))) return;
			const { force, target } = parseForceAndPath(args, ctx.cwd);
			if (ctx.hasUI) {
				ctx.ui.notify(`Rebuilding index for ${target} — can take minutes on a large repo…`, "info");
			}
			setStatus(ctx, STATUS_INDEX, "index");
			try {
				const cliArgs = ["index"];
				if (force) cliArgs.push("--force");
				cliArgs.push(target);
				const result = await execCg(pi, cliArgs, { timeout: 1_800_000, cwd: target });
				postCommand(pi, ctx, "codegraph-index", outputOf(result), result.code);
				if (result.code === 0 && (await isIndexed(ctx.cwd))) injectIndexHint(pi, ctx);
			} finally {
				setStatus(ctx, STATUS_INDEX, undefined);
				setReadyStatus(ctx, await isIndexed(ctx.cwd));
			}
		},
	});

	// ── /codegraph-uninit ──────────────────────────────────────────────────
	pi.registerCommand("codegraph-uninit", {
		description: "Remove the CodeGraph index (.codegraph/) for a project. --force skips confirmation.",
		getArgumentCompletions: pathCompletions,
		handler: async (args, ctx) => {
			if (!(await requireCli(pi, ctx))) return;
			const { force, target } = parseForceAndPath(args, ctx.cwd);
			if (!force) {
				if (!ctx.hasUI) {
					pi.sendMessage(
						{
							customType: "codegraph-uninit",
							content: "Pass --force to remove the CodeGraph index in non-interactive mode.",
							display: true,
						},
						{ triggerTurn: false },
					);
					return;
				}
				const ok = await ctx.ui.confirm(
					"Remove CodeGraph index",
					`Permanently delete ${path.join(target, ".codegraph/")}?`,
				);
				if (!ok) {
					ctx.ui.notify("Cancelled.", "info");
					return;
				}
			}
			// Always pass --force: pi.exec stdin is ignored, so the CLI cannot prompt.
			const result = await execCg(pi, ["uninit", "--force", target], {
				timeout: 30_000,
				cwd: target,
			});
			postCommand(pi, ctx, "codegraph-uninit", outputOf(result), result.code);
			setReadyStatus(ctx, await isIndexed(ctx.cwd));
		},
	});

	// ── /codegraph-status ──────────────────────────────────────────────────
	pi.registerCommand("codegraph-status", {
		description: "Show CodeGraph index status and statistics",
		getArgumentCompletions: pathCompletions,
		handler: async (args, ctx) => {
			if (!(await requireCli(pi, ctx, { force: true }))) return;
			const { target } = parseForceAndPath(args, ctx.cwd);
			const result = await execCg(pi, ["status", target], { timeout: 30_000, cwd: target });
			postCommand(pi, ctx, "codegraph-status", outputOf(result), result.code);
			setReadyStatus(ctx, await isIndexed(ctx.cwd));
		},
	});

	// ── /codegraph-unlock ──────────────────────────────────────────────────
	pi.registerCommand("codegraph-unlock", {
		description: "Release stale CodeGraph database lock (codegraph unlock)",
		getArgumentCompletions: pathCompletions,
		handler: async (args, ctx) => {
			if (!(await requireCli(pi, ctx))) return;
			const { target } = parseForceAndPath(args, ctx.cwd);
			const result = await execCg(pi, ["unlock", target], { timeout: 10_000, cwd: target });
			postCommand(pi, ctx, "codegraph-unlock", outputOf(result), result.code);
		},
	});

	// ── /codegraph-affected ────────────────────────────────────────────────
	pi.registerCommand("codegraph-affected", {
		description:
			"List test files affected by changes since a git ref (default HEAD). Uses `git diff --name-only` then `codegraph affected`.",
		handler: async (args, ctx) => {
			if (!(await requireCli(pi, ctx))) return;
			const base = args?.trim() || "HEAD";
			const diff = await pi.exec("git", ["diff", "--name-only", base], {
				cwd: ctx.cwd,
				timeout: 30_000,
			});
			if (diff.code !== 0) {
				postCommand(pi, ctx, "codegraph-affected", outputOf(diff), diff.code);
				return;
			}
			const files = diff.stdout
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean);
			if (files.length === 0) {
				const msg = `No changed files since ${base}.`;
				if (ctx.hasUI) ctx.ui.notify(msg, "info");
				pi.sendMessage(
					{ customType: "codegraph-affected", content: msg, display: true },
					{ triggerTurn: false },
				);
				return;
			}
			const result = await execCg(pi, ["affected", ...files, "--quiet"], {
				cwd: ctx.cwd,
				timeout: 60_000,
			});
			postCommand(pi, ctx, "codegraph-affected", outputOf(result), result.code);
		},
	});

	// ── session_start: CLI check + incremental sync + context hint ────────
	pi.on("session_start", async (_event, ctx) => {
		if (!(await ensureCli(pi, { force: cliAvailable === false }))) {
			setReadyStatus(ctx, false);
			if (ctx.hasUI && !notifiedMissing) {
				notifiedMissing = true;
				ctx.ui.notify(INSTALL_HINT, "warning");
			}
			return;
		}
		notifiedMissing = false;

		const indexed = await isIndexed(ctx.cwd);
		if (indexed) {
			setStatus(ctx, STATUS_SYNC, "sync");
			// Incremental sync; near-zero cost when nothing changed.
			void execCg(pi, ["sync", "-q", ctx.cwd], { timeout: 300_000, cwd: ctx.cwd })
				.catch((e) => {
					console.debug("[codegraph] background sync failed:", e);
				})
				.finally(async () => {
					setStatus(ctx, STATUS_SYNC, undefined);
					setReadyStatus(ctx, await isIndexed(ctx.cwd));
				});
			injectIndexHint(pi, ctx);
		} else {
			setReadyStatus(ctx, false);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearAllStatus(ctx);
	});
}
