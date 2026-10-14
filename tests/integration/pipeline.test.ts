/**
 * 集成测试：不用模型、不用 git，把“任务 → 分析 → 计划 → 调度 → 验证 → trace”
 * 整条链路跑一遍。架构文档 §23 的 Integration Test 一栏。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { asTaskRunner, createFakeAgentRunner } from "../../src/orchestrator/agent-runner.ts";
import { runSakuraTask } from "../../src/orchestrator/orchestrator.ts";
import { createTaskGraph, taskNode, type TaskGraph } from "../../src/planning/schemas.ts";
import type { Planner } from "../../src/planning/planner.ts";
import { createRunTrace } from "../../src/telemetry/trace.ts";
import { verify, type CommandRunner } from "../../src/verification/verifier.ts";

test("medium bug task runs end-to-end with parallel exploration and verification evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "sakura-pipeline-"));
	const trace = await createRunTrace("run-integration", root);

	const commands: string[] = [];
	const runCommand: CommandRunner = async (command) => {
		commands.push(command);
		return { exitCode: 0, stdout: "18 passed", stderr: "" };
	};

	const planner: Planner = {
		async plan(): Promise<TaskGraph> {
			return createTaskGraph({
				id: "plan-1",
				rootTask: "auth refresh bug",
				nodes: [
					taskNode({ id: "explore-auth", title: "explore auth", description: "", role: "explorer", dependencies: [], priority: 3 }),
					taskNode({ id: "explore-token", title: "explore token", description: "", role: "explorer", dependencies: [], priority: 2 }),
					taskNode({
						id: "implement",
						title: "implement",
						description: "",
						role: "implementer",
						dependencies: ["explore-auth", "explore-token"],
						priority: 1,
						writeScope: ["src/auth"],
						verification: [{ kind: "test", command: "npm run test" }],
					}),
				],
			});
		},
	};

	const result = await runSakuraTask(
		{ task: "fix refresh token bug", hintFiles: ["src/auth/auth-service.ts", "src/auth/token-service.ts"] },
		{
			planner,
			runTask: asTaskRunner(createFakeAgentRunner({
				"explore-auth": { status: "success", summary: "auth flow mapped", changedFiles: [], evidence: ["src/auth/auth-service.ts:42"] },
				"explore-token": { status: "success", summary: "token rotation found", changedFiles: [], evidence: ["src/auth/token-service.ts:88"] },
				implement: { status: "success", summary: "rotate before returning", changedFiles: ["src/auth/token-service.ts"], evidence: ["18 passed"] },
			}), { workspacePath: root }),
			verify: async () => verify({ cwd: root, commands: ["npm run test"], run: runCommand }),
			trace,
			maxConcurrency: 3,
		},
	);

	assert.equal(result.completed, true);
	assert.equal(result.graph.nodes.implement.status, "succeeded");
	// 两个 explore 同 wave，implement 在下一 wave
	assert.equal(result.scheduler.waves, 2);
	assert.deepEqual(commands, ["npm run test"]);

	const metrics = await trace.finish();
	assert.equal(metrics.tasks, 3);
	assert.equal(metrics.tasksSucceeded, 3);
	assert.equal(metrics.verificationPassed, 1);

	const events = (await readFile(join(root, ".sakura", "runs", "run-integration", "events.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { event: { type: string } });
	assert.ok(events.some((record) => record.event.type === "verification.finished"));
});
