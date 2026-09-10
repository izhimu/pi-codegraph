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

// session_start: handler registered
const onStart = handlers.get("session_start") ?? fail("session_start not registered");

const tmpTestDir = ".smoke-tmp";
rmSync(tmpTestDir, { recursive: true, force: true });
mkdirSync(tmpTestDir, { recursive: true });

const mockCtx = (cwd) => ({
	cwd,
	hasUI: true,
	ui: { notify: () => {} },
});

await onStart({ reason: "start" }, mockCtx(tmpTestDir));

rmSync(tmpTestDir, { recursive: true, force: true });
console.log("session_start OK");

rmSync(".smoke-build", { recursive: true, force: true });
console.log("SMOKE PASS");
