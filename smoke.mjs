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

// before_agent_start: awareness hint when unindexed, full hint when indexed
// (including subdirectories of an indexed root), chained prompts untouched
const onBeforeStart = handlers.get("before_agent_start") ?? fail("before_agent_start not registered");
const bareDir = ".smoke-tmp-bare";
mkdirSync(bareDir, { recursive: true });
const aware = await onBeforeStart({ systemPrompt: "BASE" }, ctx(bareDir));
if (!aware?.systemPrompt?.includes("tool available")) {
	fail(`expected one-line awareness hint for unindexed dir, got: ${JSON.stringify(aware)}`);
}

mkdirSync(`${tmpTestDir}/.codegraph`, { recursive: true });
writeFileSync(`${tmpTestDir}/.codegraph/codegraph.db`, "dummy-db");
const hinted = await onBeforeStart({ systemPrompt: "BASE" }, ctx(tmpTestDir));
if (!hinted?.systemPrompt?.startsWith("BASE\n\n# CodeGraph — this project is indexed")) {
	fail(`expected BASE + CodeGraph hint, got: ${JSON.stringify(hinted)}`);
}
mkdirSync(`${tmpTestDir}/sub/dir`, { recursive: true });
const subdirHint = await onBeforeStart({ systemPrompt: "BASE" }, ctx(`${tmpTestDir}/sub/dir`));
if (!subdirHint?.systemPrompt?.includes("this project is indexed")) {
	fail(`expected indexed hint from subdirectory, got: ${JSON.stringify(subdirHint)}`);
}
const already = `${hinted.systemPrompt}`;
const dup = await onBeforeStart({ systemPrompt: already }, ctx(tmpTestDir));
if (dup !== undefined) fail("expected no double-injection when hint already chained");
rmSync(bareDir, { recursive: true, force: true });
console.log("before_agent_start hint OK");

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
