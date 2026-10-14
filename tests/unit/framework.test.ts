import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mergeConfig, DEFAULT_CONFIG } from "../../src/config.ts";
import { createExperienceExtractor } from "../../src/experience/extractor.ts";
import { experienceContext } from "../../src/experience/retrieval.ts";
import { createExperienceStore } from "../../src/experience/store.ts";
import { createHeuristicPlanner } from "../../src/planning/planner.ts";
import { topoLayers, validateGraph } from "../../src/planning/dag.ts";
import { analyzeTask } from "../../src/planning/task-analyzer.ts";
import type { TaskGraph, TaskNode, TaskStatus } from "../../src/planning/schemas.ts";
import { createTypeScriptParser, resolveRelative } from "../../src/repo-intelligence/parser.ts";
import { indexRepository } from "../../src/repo-intelligence/indexer.ts";
import { analyzeImpact } from "../../src/repo-intelligence/impact-analysis.ts";
import { mapTests, sourceStem } from "../../src/repo-intelligence/test-mapper.ts";
import { verdictOf } from "../../src/runtime/pi-agent-runner.ts";

async function write(root: string, path: string, content: string): Promise<void> {
	await mkdir(join(root, path, ".."), { recursive: true });
	await writeFile(join(root, path), content);
}

test("typescript parser extracts symbols, methods and import edges", () => {
	const parsed = createTypeScriptParser().parse(
		"src/a.ts",
		[
			'import { helper } from "../lib/helper.js";',
			"export interface Thing { id: string }",
			"export class Service {",
			"  run(): void {}",
			"  get value(): number { return 1; }",
			"}",
			"export function helper2() {}",
			"export const token = 1;",
		].join("\n"),
	);

	assert.deepEqual(
		parsed.symbols.map((symbol) => `${symbol.name}:${symbol.kind}`).sort(),
		["Service.run:method", "Service.value:method", "Service:class", "Thing:interface", "helper2:function", "token:variable"],
	);
	assert.deepEqual(parsed.edges, [{ kind: "IMPORTS", from: "src/a.ts", to: "lib/helper.js" }]);
	assert.equal(resolveRelative("src/deep/a.ts", "../b.js"), "src/b.js");
	assert.equal(resolveRelative("a.ts", "./x/../y.ts"), "y.ts");
});

test("indexer resolves .js→.ts imports and maps tests to sources", async () => {
	const root = await mkdtemp(join(tmpdir(), "sakura-idx-"));
	await write(root, "src/token.ts", "export function issueToken() { return 1; }\n");
	await write(root, "src/auth.ts", 'import { issueToken } from "./token.js";\nexport function login() { return issueToken(); }\n');
	await write(root, "src/auth.test.ts", 'import { login } from "./auth.ts";\ntest("login", () => login());\n');

	const { index, indexedFiles } = await indexRepository({ root, parser: createTypeScriptParser() });
	assert.equal(indexedFiles, 3);

	// .js → .ts 必须落到真实文件上，否则 getDependencies 永远是空的
	assert.deepEqual(index.getDependencies("src/auth.ts"), ["src/token.ts"]);
	assert.deepEqual(index.getDependents("src/token.ts"), ["src/auth.ts"]);
	assert.deepEqual(index.findRelatedTests("src/auth.ts"), ["src/auth.test.ts"]);
	assert.equal(index.searchSymbols("token")[0]?.name, "issueToken");
});

test("test mapper only links when the source file is unambiguous", () => {
	const files = (paths: string[]) => paths.map((path) => ({ path, symbols: [], edges: [] }));
	assert.equal(sourceStem("src/auth/auth.test.ts"), "src/auth/auth.ts");
	// 集中式测试树不镜像源目录，只留文件名交给唯一同名回退
	assert.equal(sourceStem("tests/unit/scheduler.test.ts"), "scheduler.ts");
	assert.deepEqual(
		mapTests(files(["src/auth.ts", "src/auth.test.ts"])).map((edge) => `${edge.from}→${edge.to}`),
		["src/auth.test.ts→src/auth.ts"],
	);
	assert.deepEqual(
		mapTests(files(["src/orchestrator/scheduler.ts", "tests/unit/scheduler.test.ts"])).map((edge) => `${edge.from}→${edge.to}`),
		["tests/unit/scheduler.test.ts→src/orchestrator/scheduler.ts"],
	);
	// 两个同名候选 → 不建边，宁缺勿错
	assert.deepEqual(mapTests(files(["a/util.ts", "b/util.ts", "tests/util.test.ts"])), []);
});

test("impact analysis resolves a symbol back to file-level edges", async () => {
	const root = await mkdtemp(join(tmpdir(), "sakura-impact-"));
	await write(root, "src/schemas.ts", "export function buildGraph() { return 1; }\n");
	await write(root, "src/planner.ts", 'import { buildGraph } from "./schemas.ts";\nexport const plan = () => buildGraph();\n');
	await write(root, "src/cli.ts", 'import { plan } from "./planner.ts";\nexport const main = () => plan();\n');
	await write(root, "tests/unit/schemas.test.ts", 'import { buildGraph } from "../../src/schemas.ts";\ntest("buildGraph", () => buildGraph());\n');

	const { index } = await indexRepository({ root, parser: createTypeScriptParser() });
	const report = analyzeImpact(index, "buildGraph");

	// 符号级查询必须先解析回文件，否则 dependents 永远是空的
	assert.deepEqual(report.files, ["src/schemas.ts"]);
	assert.deepEqual(report.dependents.sort(), ["src/cli.ts", "src/planner.ts", "tests/unit/schemas.test.ts"]);
	// relatedTests 同时吃到两条路：文件名约定（schemas.test.ts）和该测试文件对 schemas.ts 的 import
	assert.deepEqual(report.relatedTests, ["tests/unit/schemas.test.ts"]);

	// 直接对 symbolId 查（第一版的错法）在文件级边上确实返回空——这就是要修的原因
	assert.deepEqual(index.getDependents("src/schemas.ts#buildGraph"), []);

	// 文件路径也能当 target
	assert.deepEqual(analyzeImpact(index, "src/planner.ts").dependents, ["src/cli.ts"]);
});

test("heuristic planner produces a validated DAG whose shape follows complexity", async () => {
	const planner = createHeuristicPlanner({ graphId: "g", now: 0 });

	const small = await planner.plan({ task: "fix typo in README", analysis: analyzeTask({ description: "fix typo in README" }) });
	assert.deepEqual(validateGraph(small), []);
	assert.equal(Object.keys(small.nodes).length, 1);

	const hinted = await planner.plan({task:"fix auth",analysis:analyzeTask({description:"fix auth",hintFiles:["src/auth/service.ts"]})});
	assert.equal(hinted.nodes.implementer.readScope,undefined,"file hints must not block reading related imports/tests");
	assert.deepEqual(hinted.nodes.implementer.writeScope,["src/auth/service.ts"]);
	assert.match(hinted.nodes.implementer.description,/实现任务/);

	const large = await planner.plan({
		task: "migrate all modules end-to-end",
		analysis: analyzeTask({ description: "migrate all modules end-to-end", expectedFileCount: 20 }),
	});
	assert.deepEqual(validateGraph(large), []);
	assert.ok(Object.keys(large.nodes).length >= 8, "large tasks must fan out");
	// 第一层必须是并行 explorer，否则“多 Agent”只是串行流水线
	assert.equal(topoLayers(large)[0]?.length, 3);

	// 写任务的 writeScope 必须落进图里，调度器才敢并行
	const writers = Object.values(large.nodes).filter((node) => node.role === "implementer");
	assert.ok(writers.every((node) => node.writeScope === undefined), "没有文件线索时不能编造 writeScope");
});

test("experience extractor records failures plus evidence, and skips runs with neither", async () => {
	const graph = await createHeuristicPlanner({ graphId: "g", now: 0 }).plan({
		task: "fix refresh token",
		analysis: analyzeTask({ description: "fix bug in refresh token", hintFiles: ["src/auth.ts"] }),
	});

	// 图里没有节点时，先用它把“跑过一轮”的状态摆出来
	const first = Object.values(graph.nodes)[0] as TaskNode;
	const setStatus = (status: TaskStatus, result?: TaskNode["result"]) => {
		first.status = status;
		first.result = result;
	};
	setStatus("failed", {
		status: "failure",
		summary: "auth.ts:42 仍然返回旧 token",
		changedFiles: ["src/auth.ts"],
		evidence: [],
	});

	const verification = {
		passed: true,
		reviewedDiff: true,
		steps: [{ command: "npm test", exitCode: 0, durationMs: 12, stdoutTail: "", stderrTail: "" }],
		failures: [],
	};

	const extractor = createExperienceExtractor();
	const [experience] = extractor.extract({ graph, verification, successfulActions: [], failedAttempts: [] });
	assert.ok(experience, "a run with a failure and evidence must be recorded");
	assert.equal(experience.problemPattern, "fix refresh token");
	assert.deepEqual(experience.relevantFiles, ["src/auth.ts"]);
	assert.ok(experience.tags.includes("verified"));

	// 只有验证证据、没有失败：仍然入库（能告诉后面的任务该跑什么命令）
	setStatus("succeeded");
	assert.equal(extractor.extract({ graph, verification, successfulActions: [], failedAttempts: [] }).length, 1);

	// 既没失败也没证据：不入库
	assert.deepEqual(extractor.extract({ graph: { ...graph, nodes: {} } as TaskGraph, successfulActions: [], failedAttempts: [] }), []);
});

test("experienceContext only injects high-confidence hits", async () => {
	const root = await mkdtemp(join(tmpdir(), "sakura-ctx-"));
	const store = createExperienceStore(root);
	await store.add({
		id: "e1",
		problemPattern: "refresh token returns stale token",
		symptoms: ["stale token"],
		failedAttempts: ["clearing cache did not help"],
		successfulActions: ["rotate the refresh token before returning"],
		usefulTools: [],
		relevantFiles: [],
		verificationEvidence: ["npm test → exit 0"],
		tags: ["auth"],
		createdAt: 0,
	});
	assert.deepEqual(await experienceContext(store, "refresh token returns stale token"), [
		"refresh token returns stale token | failed: clearing cache did not help | worked: rotate the refresh token before returning",
	]);
	assert.deepEqual(await experienceContext(store, "rename a button label"), []);
});

test("config merges over defaults and rejects invalid values", () => {
	assert.equal(mergeConfig({ runtime: { maxConcurrency: 5 } }).runtime.maxConcurrency, 5);
	assert.equal(mergeConfig(undefined).runtime.maxConcurrency, DEFAULT_CONFIG.runtime.maxConcurrency);
	assert.equal(mergeConfig({ policy: { gitPush: "deny" } }).policy.gitPush, "deny");
	assert.throws(() => mergeConfig({ runtime: { maxConcurrency: 0 } }));
	assert.throws(() => mergeConfig({ policy: { gitPush: "maybe" } }));
	// 未知键忽略，前向兼容
	assert.equal(mergeConfig({ future: { whatever: 1 } }).runtime.maxConcurrency, DEFAULT_CONFIG.runtime.maxConcurrency);
});

test("agent verdict refuses false success (provider error / no changes / unknown diff)", () => {
	const base = { role: "implementer" as const, taskId: "implementer", workspacePath: "/tmp/ws" };
	const ok = [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }];

	// 正常路径
	assert.equal(verdictOf({ ...base, messages: ok, collected: { changedFiles: ["a.ts"] } }).status, "success");

	// Pi 在 provider 报错时不 reject prompt()：只有检查 stopReason 才不会把 Connection error 当成功
	const errored = [{ role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error." }];
	const erroredVerdict = verdictOf({ ...base, messages: errored, collected: { changedFiles: ["a.ts"] } });
	assert.equal(erroredVerdict.status, "failure");
	assert.match(erroredVerdict.summary, /Connection error/);

	// 空 content 也是失败（拿不到任何工作成果）
	assert.equal(verdictOf({ ...base, messages: [{ role: "assistant", content: [], stopReason: "stop" }], collected: { changedFiles: ["a.ts"] } }).status, "failure");
	// 一条 assistant 消息都没有
	assert.equal(verdictOf({ ...base, messages: [], collected: { changedFiles: ["a.ts"] } }).status, "failure");

	// 写角色改了 0 个文件 = 没干活
	assert.equal(verdictOf({ ...base, messages: ok, collected: { changedFiles: [] } }).status, "failure");
	// git 不可用 ≠ 没有改动
	const unknown = verdictOf({ ...base, messages: ok, collected: { changedFiles: [], unknown: "fatal: not a git repository" } });
	assert.equal(unknown.status, "failure");
	assert.match(unknown.summary, /无法确定改动文件/);

	// 只读角色不需要改动文件
	assert.equal(verdictOf({ ...base, role: "explorer", messages: ok, collected: { changedFiles: [] } }).status, "success");
});

test("task analyzer matches english keywords on word boundaries, not substrings", () => {
	// "add" 曾经命中 `add()` 的符号名，把一个 bugfix 判成 feature，进而选错技能
	const bugfix = analyzeTask({ description: "src/math.ts 里 add() 的符号写错了，修好它让 test 通过" });
	assert.equal(bugfix.type, "bugfix", "'add()' 不能因为含 'add' 就被判成 feature");

	assert.equal(analyzeTask({ description: "add a new export command" }).type, "feature");
	assert.equal(analyzeTask({ description: "fix the prefix handling in the parser" }).type, "bugfix", "'prefix' 不应该命中 'fix'");
	assert.equal(analyzeTask({ description: "address the reviewer comments" }).type, "edit", "'address' 不应该命中 'add'");
	// 中文仍然是 substring
	assert.equal(analyzeTask({ description: "登录报错，帮我修复" }).type, "bugfix");
});
