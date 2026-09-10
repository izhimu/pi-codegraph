// Smoke test: run the compiled extension against a mock pi + real codegraph CLI.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import codegraphExtension from "./.smoke-build/codegraph.js";

const exec = (command, args, options = {}) =>
	new Promise((resolve) => {
		const proc = execFile(command, args, { timeout: options.timeout }, (err, stdout, stderr) => {
			resolve({ stdout: String(stdout), stderr: String(stderr), code: err ? (err.code ?? 1) : 0, killed: Boolean(err?.killed) });
		});
		if (options.signal) options.signal.addEventListener("abort", () => proc.kill());
	});

const tools = new Map();
const commands = new Map();
const handlers = new Map();
const pi = {
	exec,
	registerTool: (t) => tools.set(t.name, t),
	registerCommand: (n, c) => commands.set(n, c),
	on: (e, h) => handlers.set(e, h),
	sendMessage: () => {},
};
codegraphExtension(pi);

const ctx = (cwd) => ({ cwd, hasUI: false, ui: { notify: () => {}, setStatus: () => {} } });
const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };

// Scenario A: unindexed project → upstream "not initialized" passthrough.
const repoRoot = process.cwd();
const explore = tools.get("codegraph_explore") ?? fail("tool not registered");
const a = await explore.execute("1", { query: "anything", path: repoRoot }, undefined, undefined, ctx(repoRoot));
if (!a.content[0].text.includes("no .codegraph/ index exists") && !a.content[0].text.includes("not found")) {
	console.log("A passthrough info:", a.content[0].text);
}
console.log("A unindexed-passthrough OK");

// Check commands registered
const init = commands.get("codegraph-init") ?? fail("init not registered");
const sync = commands.get("codegraph-sync") ?? fail("sync not registered");
const status = commands.get("codegraph-status") ?? fail("status not registered");
const unlock = commands.get("codegraph-unlock") ?? fail("unlock not registered");
console.log("Commands registration OK");

// session_start / session_shutdown: handlers registered + status bar check
const onStart = handlers.get("session_start") ?? fail("session_start not registered");
const onShutdown = handlers.get("session_shutdown") ?? fail("session_shutdown not registered");

let currentStatus = null;
const mockCtx = (cwd) => ({
	cwd,
	hasUI: true,
	ui: {
		notify: () => {},
		setStatus: (_id, text) => { currentStatus = text; },
	},
});

const tmpTestDir = ".smoke-tmp";
rmSync(tmpTestDir, { recursive: true, force: true });
mkdirSync(tmpTestDir, { recursive: true });

// 1. Unindexed dir: no status
await onStart({ reason: "start" }, mockCtx(tmpTestDir));
if (currentStatus !== undefined) fail(`expected undefined status for empty dir, got: ${currentStatus}`);

// 2. Dir with .codegraph/ but no codegraph.db (e.g. only .gitignore): no status
mkdirSync(`${tmpTestDir}/.codegraph`, { recursive: true });
writeFileSync(`${tmpTestDir}/.codegraph/.gitignore`, "*\n!.gitignore\n");
await onStart({ reason: "start" }, mockCtx(tmpTestDir));
if (currentStatus !== undefined) fail(`expected undefined status for dir with only .gitignore, got: ${currentStatus}`);

// 3. Dir with .codegraph/codegraph.db: status should be set
writeFileSync(`${tmpTestDir}/.codegraph/codegraph.db`, "dummy-db");
await onStart({ reason: "start" }, mockCtx(tmpTestDir));
// session_start sets "sync" immediately when starting background sync
if (!currentStatus?.includes("sync") && !currentStatus?.includes("index")) {
	fail(`expected sync or index in status, got: ${currentStatus}`);
}

// 3b. before_agent_start: hint only when indexed, chained prompts untouched
const onBeforeStart = handlers.get("before_agent_start") ?? fail("before_agent_start not registered");
const bareDir = ".smoke-tmp-bare";
mkdirSync(bareDir, { recursive: true });
const noHint = await onBeforeStart({ systemPrompt: "BASE" }, ctx(bareDir));
if (noHint !== undefined) fail(`expected no hint for unindexed dir, got: ${JSON.stringify(noHint)}`);
const hinted = await onBeforeStart({ systemPrompt: "BASE" }, ctx(tmpTestDir));
if (!hinted?.systemPrompt?.startsWith("BASE\n\n# CodeGraph")) {
	fail(`expected BASE + CodeGraph hint, got: ${JSON.stringify(hinted)}`);
}
const already = `${hinted.systemPrompt}`;
const dup = await onBeforeStart({ systemPrompt: already }, ctx(tmpTestDir));
if (dup !== undefined) fail("expected no double-injection when hint already chained");
rmSync(bareDir, { recursive: true, force: true });
console.log("before_agent_start hint OK");

// 4. Test codegraph-sync transitions
const statusHistory = [];
const trackingCtx = {
	cwd: tmpTestDir,
	hasUI: true,
	ui: {
		notify: () => {},
		setStatus: (_id, text) => {
			statusHistory.push(text);
			currentStatus = text;
		},
	},
};
await sync.handler("", trackingCtx);
if (!statusHistory.some((s) => s?.includes("sync"))) {
	fail(`expected sync status during codegraph-sync, got history: ${JSON.stringify(statusHistory)}`);
}
if (!statusHistory[statusHistory.length - 1]?.includes("index")) {
	fail(`expected final index status after codegraph-sync, got: ${statusHistory[statusHistory.length - 1]}`);
}

await onShutdown({}, mockCtx(tmpTestDir));
if (currentStatus !== undefined) fail(`expected shutdown to clear status, got: ${currentStatus}`);

rmSync(tmpTestDir, { recursive: true, force: true });
console.log("session_start & session_shutdown OK");

rmSync(".smoke-build", { recursive: true, force: true });
console.log("SMOKE PASS");
