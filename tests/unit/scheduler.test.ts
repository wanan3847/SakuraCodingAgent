import assert from "node:assert/strict";
import { test } from "node:test";
import { runGraph } from "../../src/orchestrator/scheduler.ts";
import { createTaskGraph, taskNode, type TaskGraph, type TaskNode, type TaskResult } from "../../src/planning/schemas.ts";

function graph(nodes: TaskNode[]): TaskGraph {
	return createTaskGraph({ id: "g", rootTask: "root", nodes });
}

const ok = (summary = "ok"): TaskResult => ({ status: "success", summary, changedFiles: [], evidence: [] });
const bad = (summary = "failed"): TaskResult => ({ status: "failure", summary, changedFiles: [], evidence: [] });

test("independent explore tasks run in the same wave", async () => {
	let concurrent = 0;
	let peak = 0;
	const g = graph([
		taskNode({ id: "a", title: "a", description: "", role: "explorer", dependencies: [], priority: 2 }),
		taskNode({ id: "b", title: "b", description: "", role: "explorer", dependencies: [], priority: 1 }),
	]);

	const outcome = await runGraph(g, {
		maxConcurrency: 3,
		async runTask() {
			concurrent += 1;
			peak = Math.max(peak, concurrent);
			await new Promise((resolve) => setTimeout(resolve, 5));
			concurrent -= 1;
			return ok();
		},
	});

	assert.equal(peak, 2);
	assert.equal(outcome.waves, 1);
	assert.equal(outcome.graph.nodes.a.status, "succeeded");
});

test("maxConcurrency is respected and dependents wait", async () => {
	const order: string[] = [];
	const g = graph([
		taskNode({ id: "a", title: "a", description: "", role: "explorer", dependencies: [], priority: 3 }),
		taskNode({ id: "b", title: "b", description: "", role: "explorer", dependencies: [], priority: 2 }),
		taskNode({ id: "c", title: "c", description: "", role: "tester", dependencies: ["a", "b"], priority: 1 }),
	]);

	await runGraph(g, {
		maxConcurrency: 2,
		async runTask(task) {
			order.push(task.id);
			return ok();
		},
	});

	assert.deepEqual(order, ["a", "b", "c"]);
});

test("overlapping write scopes never run concurrently", async () => {
	const active: string[] = [];
	let overlapped = false;
	const g = graph([
		taskNode({ id: "a", title: "a", description: "", role: "implementer", dependencies: [], priority: 2, writeScope: ["src/core"] }),
		taskNode({ id: "b", title: "b", description: "", role: "implementer", dependencies: [], priority: 1, writeScope: ["src/core/util.ts"] }),
	]);

	await runGraph(g, {
		maxConcurrency: 4,
		async runTask(task) {
			active.push(task.id);
			if (active.length > 1) overlapped = true;
			await new Promise((resolve) => setTimeout(resolve, 2));
			active.pop();
			return ok();
		},
	});

	assert.equal(overlapped, false);
});

test("failure retries up to maxRetries then blocks dependents", async () => {
	let attempts = 0;
	const g = graph([
		taskNode({ id: "a", title: "a", description: "", role: "implementer", dependencies: [], priority: 1, maxRetries: 2 }),
		taskNode({ id: "b", title: "b", description: "", role: "tester", dependencies: ["a"], priority: 0 }),
	]);

	const outcome = await runGraph(g, {
		maxConcurrency: 1,
		async runTask() {
			attempts += 1;
			return bad("still broken");
		},
	});

	assert.equal(attempts, 3); // 1 + 2 retries
	assert.equal(outcome.graph.nodes.a.status, "failed");
	assert.equal(outcome.graph.nodes.b.status, "cancelled");
});

test("replan replaces the graph and counts once", async () => {
	const g = graph([taskNode({ id: "a", title: "a", description: "", role: "implementer", dependencies: [], priority: 1 })]);

	const outcome = await runGraph(g, {
		maxConcurrency: 2,
		async runTask(task) {
			return task.id === "a" ? bad("wrong approach") : ok();
		},
		async replan() {
			return graph([taskNode({ id: "a2", title: "a2", description: "", role: "implementer", dependencies: [], priority: 1 })]);
		},
	});

	assert.equal(outcome.replans, 1);
	assert.equal(outcome.graph.nodes.a2.status, "succeeded");
});

test("invalid graph is rejected before any agent runs", async () => {
	const g = graph([taskNode({ id: "a", title: "a", description: "", role: "explorer", dependencies: ["ghost"], priority: 1 })]);
	await assert.rejects(
		() => runGraph(g, { maxConcurrency: 1, runTask: async () => ok() }),
		/invalid task graph/,
	);
});
