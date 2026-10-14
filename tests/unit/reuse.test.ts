/**
 * 复用指南 §8.1（submit_plan）/ §9.2（Skill Router）/ §10（SakuraRunState）/ §6（Pi 事件采集）
 * 这几处 Pi 复用的行为测试。全部不调模型。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeTask } from "../../src/planning/task-analyzer.ts";
import { planFromToolParams, plannerPrompt } from "../../src/planning/planner.ts";
import { validateGraph } from "../../src/planning/dag.ts";
import { observeAgent, providerFailure } from "../../src/runtime/agent-events.ts";
import { createSubmitPlanTool } from "../../src/runtime/plan-agent.ts";
import { createRunState, recordVerification, recordWorkspace, saveRunState, syncTasks } from "../../src/runtime/run-state.ts";
import { loadSkillCatalog, parseSkillFile } from "../../src/skills/registry.ts";
import { routeSkills } from "../../src/skills/router.ts";
import { loadSkillReferences, stripFrontmatter } from "../../src/skills/loader.ts";
import { createRunTrace } from "../../src/telemetry/trace.ts";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** 在 <root>/skills/<name>/SKILL.md 写一个技能，返回 skills 根目录（和真实布局一致）。 */
async function skillDir(root: string, name: string, description: string): Promise<string> {
	const dir = join(root, "skills", name);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nbody of ${name}\n`);
	return join(root, "skills");
}

test("skill registry parses frontmatter, skips unusable skills, and dedupes directories", async () => {
	const root = await mkdtemp(join(tmpdir(), "sakura-skills-"));
	const skillsRoot = await skillDir(root, "planning", "Decompose a task into a dependency-ordered plan.");
	await skillDir(root, "no-description", "");
	// 分组目录（~/.agents/skills/<group>/<skill>/ 那种）也要被递归找到
	const grouped = join(skillsRoot, "group", "nested");
	await mkdir(grouped, { recursive: true });
	await writeFile(join(grouped, "SKILL.md"), "---\nname: nested\ndescription: A nested skill.\n---\nbody\n");

	// 同一个目录传两次：包内 skills/ 和项目 skills/ 常常是同一个
	const catalog = await loadSkillCatalog([skillsRoot, skillsRoot]);
	assert.deepEqual(
		catalog.map((skill) => skill.name),
		["nested", "planning"],
	);
	assert.equal(parseSkillFile("/x/y/SKILL.md", "no frontmatter"), undefined);
	assert.equal(parseSkillFile("/x/y/SKILL.md", "---\nname: a\n---\nbody"), undefined, "缺 description 的技能不能进目录");
});

test("skill router prefers the task type's skills and respects the limit", async () => {
	const root = await mkdtemp(join(tmpdir(), "sakura-router-"));
	const dirs = [
		await skillDir(root, "planning", "Decompose a coding task into a dependency-ordered plan."),
		await skillDir(root, "systematic-debugging", "Diagnose a bug and prove a root-cause fix."),
		await skillDir(root, "verification", "Prove a change works using the project's own commands."),
		await skillDir(root, "code-review", "Review a diff for correctness and scope creep."),
	];
	const catalog = await loadSkillCatalog(dirs);

	const bugfix = routeSkills(catalog, {
		task: "fix the refresh token bug",
		analysis: analyzeTask({ description: "fix the refresh token bug" }),
		limit: 2,
	});
	assert.equal(bugfix.length, 2);
	assert.equal(bugfix[0]?.skill.name, "systematic-debugging");
	assert.ok(bugfix[0]?.reason.includes("bugfix"));

	const feature = routeSkills(catalog, {
		task: "add an export command",
		analysis: analyzeTask({ description: "add an export command" }),
		limit: 1,
	});
	assert.equal(feature[0]?.skill.name, "planning");

	// 完全无关的任务 + 无 analysis：不应该硬塞技能
	assert.deepEqual(routeSkills(catalog, { task: "zzz", minScore: 0.5 }), []);
});

test("skill loader strips frontmatter and says when it truncates", async () => {
	const root = await mkdtemp(join(tmpdir(), "sakura-load-"));
	const dir = await skillDir(root, "big", "A skill with a lot of body.");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "SKILL.md"), `---\nname: big\ndescription: A skill with a lot of body.\n---\n\n${"x".repeat(500)}\n`);
	const [skill] = await loadSkillCatalog([dir]);
	assert.ok(skill);

	assert.equal(stripFrontmatter("---\nname: a\n---\n\nbody\n"), "body");
	const full = await loadSkillReferences([skill], 10);
	assert.ok(full.includes("截断"), "截断必须写出来，不能静默");
	const small = await loadSkillReferences([skill], 100_000);
	assert.ok(small.startsWith("## skill: big"));
	assert.ok(!small.includes("---"));
});

test("submit_plan params become a validated graph, and bad plans are rejected with reasons", () => {
	const input = { graphId: "g", rootTask: "fix the bug", now: 0 };

	const good = planFromToolParams(
		{
			tasks: [
				{ id: "implementer", title: "fix", description: "fix the bug", role: "implementer", dependencies: [], priority: 0, writeScope: ["src/a.ts"] },
				{ id: "tester", title: "test", description: "add a test", role: "tester", dependencies: ["implementer"], priority: 1, writeScope: ["test/a.test.ts"] },
			],
		},
		input,
	);
	assert.equal(good.rejected, undefined);
	assert.ok(good.graph);
	assert.deepEqual(validateGraph(good.graph), []);
	assert.equal(Object.keys(good.graph.nodes).length, 2);

	// 写角色缺 writeScope：调度器无法并行，必须拒绝而不是猜
	const noScope = planFromToolParams(
		{ tasks: [{ id: "impl", title: "x", description: "y", role: "implementer", dependencies: [], priority: 0 }] },
		input,
	);
	assert.match(noScope.rejected ?? "", /writeScope/);

	// 悬空依赖
	const dangling = planFromToolParams(
		{ tasks: [{ id: "a", title: "x", description: "y", role: "explorer", dependencies: ["ghost"], priority: 0 }] },
		input,
	);
	assert.match(dangling.rejected ?? "", /unknown task/);

	// 成环：单任务自依赖
	const cyclic = planFromToolParams(
		{ tasks: [{ id: "a", title: "x", description: "y", role: "explorer", dependencies: ["a"], priority: 0 }] },
		input,
	);
	assert.ok(cyclic.rejected, "环必须被拒绝");

	// 模型自报的不确定性要透传（进 trace 用）
	const withNotes = planFromToolParams({ tasks: [], notes: ["not sure"] }, input);
	assert.deepEqual(withNotes.notes, ["not sure"]);
});

test("planner prompt carries repo context, experience, skills and the analysis", () => {
	const prompt = plannerPrompt({
		task: "fix the refresh token bug",
		analysis: analyzeTask({ description: "fix the refresh token bug", hintFiles: ["src/auth.ts"] }),
		repoContext: "## skill: tdd\nbody",
		experience: ["refresh token returns stale token | failed: clearing cache"],
		gitState: "1 file changed",
	});
	assert.ok(prompt.includes("submit_plan"));
	assert.ok(prompt.includes("fix the refresh token bug"));
	assert.ok(prompt.includes("src/auth.ts"));
	assert.ok(prompt.includes("## skill: tdd"));
	assert.ok(prompt.includes("clearing cache"));
});

test("submit_plan tool captures its parameters", async () => {
	const { tool, captured } = createSubmitPlanTool();
	assert.equal(tool.name, "submit_plan");
	assert.equal(captured(), undefined);
	const result = await tool.execute("call-1", { tasks: [{ id: "a" }] }, undefined, undefined, {} as never);
	assert.equal(captured()?.tasks.length, 1);
	assert.match(JSON.stringify(result.content), /1 tasks/);
});

test("observeAgent counts tool calls and usage from Pi events and forwards them to the trace", async () => {
	const root = await mkdtemp(join(tmpdir(), "sakura-observe-"));
	const trace = await createRunTrace("observe-test", root);

	let listener: ((event: unknown) => void) | undefined;
	const fakeSession = {
		subscribe(next: (event: unknown) => void) {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
	} as unknown as AgentSession;

	const observation = observeAgent(fakeSession, { trace, agentId: "implementer" });
	listener?.({ type: "tool_execution_start", toolCallId:"r1", toolName: "read", args:{path:"src/a.ts"} });
	listener?.({ type: "tool_execution_end", toolCallId:"r1", toolName:"read", isError:true });
	listener?.({ type: "tool_execution_start", toolCallId:"r2", toolName: "read", args:{path:"src/b.ts"} });
	listener?.({ type: "tool_execution_end", toolCallId:"r2", toolName:"read", isError:false });
	listener?.({ type: "tool_execution_start", toolName: "edit" });
	listener?.({ type: "message_end", message: { role: "assistant", usage: { input: 100, output: 20 } } });
	listener?.({ type: "message_end", message: { role: "assistant", usage: { input: 10, output: 5 } } });
	listener?.({ type: "message_end", message: { role: "user" } });

	const usage = observation.usage();
	assert.equal(usage.toolCalls, 3);
	assert.deepEqual(usage.tools, ["read", "edit"], "同一个工具只记一次名字");
	assert.equal(usage.tokensIn, 110);
	assert.equal(usage.tokensOut, 25);

	observation.unsubscribe();
	assert.equal(listener, undefined, "unsubscribe 必须真的退订，否则长跑会漏监听器");

	// tool.called 由 observeAgent 逐次发；token 走 task.usage（由 orchestrator 按任务汇总），
	// 两条路不重叠，所以这里只断言 tool call 进了 trace
	const metrics = await trace.finish();
	assert.equal(metrics.toolCalls, 3);
	const records=(await readFile(join(trace.dir,"events.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line));
	assert.deepEqual(records.filter(record=>record.event.type==="file.read").map(record=>record.event.path),["src/b.ts"]);
});

test("SakuraRunState keeps structured state and only references the Pi session", async () => {
	const root = await mkdtemp(join(tmpdir(), "sakura-state-"));
	const graph = planFromToolParams(
		{
			tasks: [
				{ id: "impl", title: "fix", description: "fix it", role: "implementer", dependencies: [], priority: 0, writeScope: ["src/a.ts"] },
			],
		},
		{ graphId: "g", rootTask: "fix the bug", now: 0 },
	).graph;
	assert.ok(graph);

	let state = createRunState({ runId: "r1", graph, rootPiSessionRef: "pi-session-abc", now: 0 });
	state = recordWorkspace(state, { taskId: "r1", path: "/tmp/wt", branch: "sakura/r1" });
	state = recordVerification(state, {
		passed: false,
		reviewedDiff: true,
		steps: [{ command: "npm test", exitCode: 1, durationMs: 5, stdoutTail: "", stderrTail: "" }],
		failures: [{ command: "npm test", exitCode: 1, reason: "boom" }],
	});

	graph.nodes.impl!.status = "succeeded";
	graph.nodes.impl!.result = { status: "success", summary: "done", changedFiles: ["src/a.ts"], evidence: [] };
	state = { ...syncTasks(state), selectedSkills: ["tdd"] };

	const path = await saveRunState(join(root, "runs", "r1"), state);
	const saved = JSON.parse(await readFile(path, "utf8"));

	// 只引用 Pi Session，不复制聊天记录
	assert.equal(saved.rootPiSessionRef, "pi-session-abc");
	assert.equal(saved.sessionMessages, undefined);
	assert.equal(saved.tasks.impl.status, "succeeded");
	assert.deepEqual(saved.tasks.impl.changedFiles, ["src/a.ts"]);
	assert.deepEqual(saved.selectedSkills, ["tdd"]);
	assert.deepEqual(saved.workspaces.r1.path, "/tmp/wt");
	assert.equal(saved.verification[0].passed, false);
	assert.deepEqual(saved.verification[0].failures, ["npm test: boom"]);

	// 架构文档 §16 的 run 目录布局
	const graphFile = await readFile(join(root, "runs", "r1", `task-graph-v${graph.version}.json`), "utf8");
	assert.equal(JSON.parse(graphFile).rootTask, "fix the bug");
});

test("providerFailure tells a dead provider apart from 'the model chose not to'", () => {
	// Pi 在 provider 报错时不 reject prompt()：只有读 stopReason 才能分辨
	assert.match(providerFailure([{ role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error." }]) ?? "", /Connection error/);
	assert.match(providerFailure([{ role: "assistant", content: [], stopReason: "stop" }]) ?? "", /no content/);
	assert.match(providerFailure([]) ?? "", /no assistant message/);
	// 正常结束（含只调了工具没输出文本的情况）不算失败
	assert.equal(providerFailure([{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }]), undefined);
	assert.equal(providerFailure([{ role: "assistant", content: [{ type: "toolCall" }], stopReason: "toolUse" }]), undefined);
});

test("planner graph ids stay ascii so they are safe in file names and traces", async () => {
	const { graphIdFor } = await import("../../src/runtime/plan-agent.ts");
	const analysis = analyzeTask({ description: "x" });
	assert.equal(graphIdFor({ task: "src/math.ts 里 add() 的符号写错了", analysis }), "plan-edit-src-math-ts-add");
	assert.equal(graphIdFor({ task: "!!!", analysis }), "plan-edit");
	assert.ok(graphIdFor({ task: "a".repeat(200), analysis }).length <= 45);
});
