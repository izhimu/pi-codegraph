// Smoke test: run the compiled extension against a mock pi (+ optional real CLI).
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import codegraphExtension from "./.smoke-build/codegraph.js";

const realExec = (command, args, options = {}) =>
	new Promise((resolve) => {
		const proc = execFile(
			command,
			args,
			{ timeout: options.timeout, cwd: options.cwd },
			(err, stdout, stderr) => {
				resolve({
					stdout: String(stdout),
					stderr: String(stderr),
					code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
					killed: Boolean(err?.killed),
				});
			},
		);
		if (options.signal) options.signal.addEventListener("abort", () => proc.kill());
	});

const calls = [];
let execImpl = async (command, args, options = {}) => {
	calls.push({ command, args, options });
	const verb = command === "git" ? "git" : args[0];
	if (command === "git") {
		return { stdout: "src/foo.ts\n", stderr: "", code: 0, killed: false };
	}
	if (verb === "version") return { stdout: "1.0.0\n", stderr: "", code: 0, killed: false };
	if (verb === "explore") {
		return {
			stdout: "",
			stderr: "no .codegraph/ index exists here. Run codegraph init.",
			code: 1,
			killed: false,
		};
	}
	if (verb === "sync") return { stdout: "Already up to date", stderr: "", code: 0, killed: false };
	if (verb === "affected") return { stdout: "src/foo.test.ts\n", stderr: "", code: 0, killed: false };
	if (verb === "init" || verb === "index" || verb === "uninit" || verb === "status" || verb === "unlock") {
		return { stdout: `${verb} ok`, stderr: "", code: 0, killed: false };
	}
	return { stdout: "", stderr: "", code: 0, killed: false };
};

const tools = new Map();
const commands = new Map();
const handlers = new Map();
const messages = [];
const pi = {
	exec: (command, args, options) => execImpl(command, args, options),
	registerTool: (t) => tools.set(t.name, t),
	registerCommand: (n, c) => commands.set(n, c),
	on: (e, h) => handlers.set(e, h),
	sendMessage: (msg) => {
		messages.push(msg);
	},
};
codegraphExtension(pi);

const fail = (msg) => {
	console.error("FAIL:", msg);
	process.exit(1);
};

const explore = tools.get("codegraph_explore") ?? fail("tool not registered");
const guidelines = explore.promptGuidelines ?? [];
if (!guidelines[1]?.includes("codegraph_explore")) {
	fail(`promptGuidelines[1] must name codegraph_explore, got: ${guidelines[1]}`);
}
console.log("promptGuidelines OK");

for (const name of [
	"codegraph-init",
	"codegraph-sync",
	"codegraph-index",
	"codegraph-uninit",
	"codegraph-status",
	"codegraph-unlock",
	"codegraph-affected",
]) {
	if (!commands.get(name)) fail(`${name} not registered`);
	if (name !== "codegraph-affected" && typeof commands.get(name).getArgumentCompletions !== "function") {
		fail(`${name} missing getArgumentCompletions`);
	}
}
console.log("Commands registration OK");

const ctx = (cwd, extra = {}) => ({
	cwd,
	hasUI: false,
	ui: { notify: () => {}, setStatus: () => {}, confirm: async () => true },
	sessionManager: { getBranch: () => extra.branch ?? [] },
	...extra,
});

const repoRoot = process.cwd();

// Scenario A: unindexed project → "not initialized" passthrough (mocked CLI).
const a = await explore.execute("1", { query: "anything", path: repoRoot }, undefined, undefined, ctx(repoRoot));
if (!a.content[0].text.includes("no .codegraph/ index exists") && !a.content[0].text.includes("not found")) {
	fail(`A expected not-initialized passthrough, got: ${a.content[0].text}`);
}
if (!a.details || typeof a.details !== "object") fail("textResult details should be {}");
console.log("A unindexed-passthrough OK");

// A3: @ prefix and relative path resolve to absolute -p / cwd.
calls.length = 0;
const abs = path.resolve(repoRoot, "extensions");
await explore.execute("2", { query: "Q", path: `@${abs}` }, undefined, undefined, ctx(repoRoot));
const absCall = [...calls].reverse().find((c) => c.args.includes("explore")) ?? fail("no explore call for @abs");
const absP = absCall.args[absCall.args.indexOf("-p") + 1];
if (absP !== abs) fail(`expected -p ${abs}, got ${absP}`);
if (absCall.options.cwd !== abs) fail(`expected explore cwd ${abs}, got ${absCall.options.cwd}`);

calls.length = 0;
await explore.execute("3", { query: "Q", path: "extensions" }, undefined, undefined, ctx(repoRoot));
const relCall = [...calls].reverse().find((c) => c.args.includes("explore")) ?? fail("no explore call for relative");
const relP = relCall.args[relCall.args.indexOf("-p") + 1];
if (relP !== abs) fail(`expected relative -p ${abs}, got ${relP}`);
console.log("A3 path normalize OK");

const onStart = handlers.get("session_start") ?? fail("session_start not registered");
const onShutdown = handlers.get("session_shutdown") ?? fail("session_shutdown not registered");
const init = commands.get("codegraph-init");
const sync = commands.get("codegraph-sync");
const uninit = commands.get("codegraph-uninit");
const affected = commands.get("codegraph-affected");

let currentStatus = null;
const statuses = {};
const mockCtx = (cwd, extra = {}) => ({
	cwd,
	hasUI: true,
	ui: {
		notify: () => {},
		confirm: extra.confirm ?? (async () => true),
		setStatus: (id, text) => {
			statuses[id] = text;
			currentStatus = text;
			if (extra.statusHistory) extra.statusHistory.push({ id, text });
		},
		theme: { fg: (_k, s) => s },
	},
	sessionManager: { getBranch: () => extra.branch ?? [] },
});

const tmpTestDir = path.resolve(".smoke-tmp");
rmSync(tmpTestDir, { recursive: true, force: true });
mkdirSync(tmpTestDir, { recursive: true });

// 1. Unindexed dir: no ready status, no INDEX_HINT
messages.length = 0;
await onStart({ reason: "startup" }, mockCtx(tmpTestDir));
if (currentStatus !== undefined) fail(`expected undefined status for empty dir, got: ${currentStatus}`);
if (messages.some((m) => m.customType === "codegraph-context")) fail("must not inject INDEX_HINT when unindexed");

// 2. Dir with .codegraph/ but no codegraph.db: no status
mkdirSync(`${tmpTestDir}/.codegraph`, { recursive: true });
writeFileSync(`${tmpTestDir}/.codegraph/.gitignore`, "*\n!.gitignore\n");
await onStart({ reason: "startup" }, mockCtx(tmpTestDir));
if (currentStatus !== undefined) {
	fail(`expected undefined status for dir with only .gitignore, got: ${currentStatus}`);
}

// 3. Dir with .codegraph/codegraph.db: sync status + INDEX_HINT
writeFileSync(`${tmpTestDir}/.codegraph/codegraph.db`, "dummy-db");
messages.length = 0;
await onStart({ reason: "startup" }, mockCtx(tmpTestDir));
await new Promise((r) => setTimeout(r, 20));
if (!Object.values(statuses).some((s) => s?.includes("sync") || s?.includes("index"))) {
	fail(`expected sync or index in status, got: ${JSON.stringify(statuses)}`);
}
if (!messages.some((m) => m.customType === "codegraph-context")) {
	fail("expected INDEX_HINT on indexed startup");
}

// A4: existing codegraph-context entry → no duplicate inject (covers reload)
messages.length = 0;
const existing = [{ type: "custom_message", customType: "codegraph-context" }];
await onStart({ reason: "reload" }, mockCtx(tmpTestDir, { branch: existing }));
if (messages.some((m) => m.customType === "codegraph-context")) {
	fail("must not re-inject INDEX_HINT when branch already has codegraph-context");
}
console.log("A4 INDEX_HINT idempotent OK");

// init on indexed project injects hint when missing
messages.length = 0;
calls.length = 0;
await init.handler("", mockCtx(tmpTestDir));
const initCall = calls.find((c) => c.args[0] === "init") ?? fail("init not executed");
if (!initCall.args.includes("-i") || !initCall.args.includes("-y")) {
	fail(`init should pass -i -y, got ${initCall.args.join(" ")}`);
}
if (!messages.some((m) => m.customType === "codegraph-context")) {
	fail("init success should inject INDEX_HINT when current project is indexed");
}

// uninit without --force and without UI requires --force
messages.length = 0;
calls.length = 0;
await uninit.handler("", ctx(tmpTestDir));
if (calls.some((c) => c.args[0] === "uninit")) fail("uninit must not run CLI without confirm/--force in print mode");
if (!messages.some((m) => String(m.content).includes("--force"))) {
	fail("print-mode uninit should tell the user to pass --force");
}

// uninit --force skips confirm and always passes --force to CLI
calls.length = 0;
await uninit.handler("--force", mockCtx(tmpTestDir, { confirm: async () => fail("should not confirm") }));
const uninitCall = calls.find((c) => c.args[0] === "uninit") ?? fail("uninit --force not executed");
if (!uninitCall.args.includes("--force")) fail("CLI uninit must receive --force");

// affected: git diff files become argv (no --stdin)
calls.length = 0;
messages.length = 0;
await affected.handler("", mockCtx(tmpTestDir));
const gitCall = calls.find((c) => c.command === "git") ?? fail("affected did not run git");
if (gitCall.args.join(" ") !== "diff --name-only HEAD") fail(`git args: ${gitCall.args.join(" ")}`);
const affCall = calls.find((c) => c.args[0] === "affected") ?? fail("affected CLI not run");
if (affCall.args.includes("--stdin")) fail("affected must not use --stdin (pi.exec has no stdin)");
if (!affCall.args.includes("src/foo.ts") || !affCall.args.includes("--quiet")) {
	fail(`affected argv expected files + --quiet, got ${affCall.args.join(" ")}`);
}
console.log("B1/B2/B4 commands OK");

// 4. Test codegraph-sync transitions
const statusHistory = [];
await sync.handler("", mockCtx(tmpTestDir, { statusHistory }));
if (!statusHistory.some((s) => s.text?.includes("sync"))) {
	fail(`expected sync status during codegraph-sync, got history: ${JSON.stringify(statusHistory)}`);
}
const last = statusHistory[statusHistory.length - 1];
if (!last?.text?.includes("index")) {
	fail(`expected final index status after codegraph-sync, got: ${JSON.stringify(last)}`);
}

currentStatus = "stale";
await onShutdown({}, mockCtx(tmpTestDir));
if (currentStatus !== undefined) fail(`expected shutdown to clear status, got: ${currentStatus}`);

rmSync(tmpTestDir, { recursive: true, force: true });
console.log("session_start & session_shutdown OK");

// Optional: real CLI still answers unindexed projects.
try {
	const live = await realExec("codegraph", ["version"], { timeout: 10_000 });
	if (live.code === 0) {
		execImpl = async (command, args, options) => {
			calls.push({ command, args, options });
			return realExec(command, args, options);
		};
		const liveResult = await explore.execute(
			"live",
			{ query: "anything", path: repoRoot },
			undefined,
			undefined,
			ctx(repoRoot),
		);
		const text = liveResult.content[0].text;
		if (!text.includes("no .codegraph/ index exists") && !text.includes("not found") && !text.includes("not initialized")) {
			console.log("live CLI explore (info):", text.slice(0, 200));
		} else {
			console.log("live CLI unindexed-passthrough OK");
		}
	}
} catch {
	// CLI not installed — mock coverage is enough.
}

rmSync(".smoke-build", { recursive: true, force: true });
console.log("SMOKE PASS");
