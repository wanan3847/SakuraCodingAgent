import assert from "node:assert/strict";
import { test } from "node:test";
import { asTaskRunner, createFakeAgentRunner } from "../../src/orchestrator/agent-runner.ts";
import { runSakuraTask } from "../../src/orchestrator/orchestrator.ts";
import { agentProfile } from "../../src/orchestrator/agent-registry.ts";
import { createTaskGraph, taskNode, type TaskGraph } from "../../src/planning/schemas.ts";
import type { Planner } from "../../src/planning/planner.ts";
import type { VerificationResult } from "../../src/verification/verifier.ts";

const passed: VerificationResult = { passed: true, steps: [], reviewedDiff: true, failures: [] };
const failed: VerificationResult = {
	passed: false,
	steps: [],
	reviewedDiff: true,
	failures: [{ command: "npm run test", exitCode: 1, reason: "2 failed" }],
};

/** 固定的 medium bugfix 图：两个 explorer → implementer。 */
function plannerStub(): Planner {
	return {
		async plan(): Promise<TaskGraph> {
			return createTaskGraph({
				id: "plan-1",
				rootTask: "auth refresh bug",
				nodes: [
					taskNode({ id: "explore", title: "explore", description: "", role: "explorer", dependencies: [], priority: 2 }),
					taskNode({
						id: "implement",
						title: "implement",
						description: "",
						role: "implementer",
						dependencies: ["explore"],
						priority: 1,
						writeScope: ["src/auth"],
					}),
				],
			});
		},
	};
}

test("full orchestration runs plan → schedule → verify and only completes when both pass", async () => {
	const result = await runSakuraTask(
		{ task: "fix refresh token bug", hintFiles: ["src/auth/auth-service.ts", "src/auth/token-service.ts"] },
		{
			planner: plannerStub(),
			runTask: asTaskRunner(createFakeAgentRunner({
				explore: { status: "success", summary: "found token-service", changedFiles: [], evidence: ["auth-service.ts:42"] },
				implement: { status: "success", summary: "fixed", changedFiles: ["src/auth/token-service.ts"], evidence: [] },
			}), { workspacePath: "/tmp/sakura-workspace" }),
			verify: async () => passed,
			maxConcurrency: 2,
		},
	);

	assert.equal(result.completed, true);
	assert.equal(result.analysis.type, "bugfix");
	assert.equal(result.graph.nodes.implement.status, "succeeded");
	assert.equal(result.scheduler.waves, 2);
});

test("failed verification blocks completion even when every task succeeded", async () => {
	const result = await runSakuraTask(
		{ task: "fix refresh token bug" },
		{
			planner: plannerStub(),
			runTask: asTaskRunner(createFakeAgentRunner({
				explore: { status: "success", summary: "ok", changedFiles: [], evidence: [] },
				implement: { status: "success", summary: "ok", changedFiles: [], evidence: [] },
			}), { workspacePath: "/tmp/sakura-workspace" }),
			verify: async () => failed,
			maxConcurrency: 1,
		},
	);

	assert.equal(result.verification?.passed, false);
	assert.equal(result.completed, false);
});

test("read-only roles are not given write tools, writers are", () => {
	assert.deepEqual(agentProfile("explorer").allowedTools.includes("edit"), false);
	assert.equal(agentProfile("future-worker" as never), undefined);
	assert.equal(agentProfile("implementer").writes, true);
});
