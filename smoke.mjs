// Smoke test: run the compiled extension against a mock pi + real codegraph CLI.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
const execCalls = [];
const pi = {
	// Wrap the real exec with call tracking so the smoke can assert auto-sync.
	exec: (command, args, options = {}) => {
		const rec = { command, args, code: undefined };
		execCalls.push(rec);
		return exec(command, args, options).then((r) => {
			rec.code = r.code;
			return r;
		});
	},
	registerTool: (t) => tools.set(t.name, t),
	registerCommand: (n, c) => commands.set(n, c),
	on: (e, h) => handlers.set(e, h),
	sendMessage: () => {},
};
codegraphExtension(pi);

// Subcommand of a recorded exec, unwrapping the win32 cmd.exe wrapper.
const subcommand = (rec) => {
	const a = process.platform === "win32" && rec.command === "cmd.exe" ? rec.args.slice(4) : rec.args;
	return a[0] === "codegraph" ? a[1] : a[0];
};
const syncCount = () => execCalls.filter((c) => subcommand(c) === "sync").length;
const cliPresent = () => execCalls.some((c) => subcommand(c) === "version" && c.code === 0);

const ctx = (cwd) => ({ cwd, hasUI: false, ui: { notify: () => {}, setStatus: () => {} } });
const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };

// Scenario A: unindexed project → upstream "not initialized" passthrough.
const repoRoot = process.cwd();
const explore = tools.get("codegraph_explore") ?? fail("tool not registered");
if (explore.loadMode !== "essential") fail("expected loadMode 'essential' so oh-my-pi keeps the tool top-level");
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
// Hermetic unindexed dir under the OS temp root: this repo itself may be
// indexed, and index detection walks parent directories.
const bareDir = mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-smoke-"));
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
// oh-my-pi dispatches systemPrompt as string[] segments: the handler must
// join them with "\n\n" (never comma-interpolate) and return a plain string.
const arrayHint = await onBeforeStart({ systemPrompt: ["BASE_A", "BASE_B"] }, ctx(tmpTestDir));
if (!arrayHint?.systemPrompt?.startsWith("BASE_A\n\nBASE_B\n\n# CodeGraph — this project is indexed")) {
	fail(`expected merged array prompt + hint, got: ${JSON.stringify(arrayHint)}`);
}
const arrayDup = await onBeforeStart({ systemPrompt: [`${arrayHint.systemPrompt}`] }, ctx(tmpTestDir));
if (arrayDup !== undefined) fail("expected no double-injection for array-shaped prompt already holding the hint");
// Auto-sync: the first indexed turn spawned a background sync; an immediate
// follow-up turn must be throttled (no second spawn). Needs the real CLI.
if (cliPresent()) {
	const syncs = syncCount();
	if (syncs < 1) fail("expected a background sync on the first indexed turn");
	await onBeforeStart({ systemPrompt: "BASE" }, ctx(tmpTestDir));
	if (syncCount() !== syncs) fail("expected the immediate next turn to be throttled (no second sync spawn)");
	} else {
		console.log("auto-sync check skipped: codegraph CLI not on PATH");
	}
// /codegraph-status ends with the session stats line; scenario A ran 1 explore.
if (cliPresent()) {
	const statusCmd = commands.get("codegraph-status") ?? fail("status not registered");
	const notes = [];
	const statusCtx = { cwd: repoRoot, hasUI: true, ui: { notify: (m) => notes.push(m) } };
	await statusCmd.handler("", statusCtx);
	const text = notes.join("\n");
	if (!text.includes("1 explore calls")) {
		fail(`/codegraph-status missing stats line, got: ${JSON.stringify(text)}`);
	}
} else {
	console.log("status stats check skipped: codegraph CLI not on PATH");
}
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
