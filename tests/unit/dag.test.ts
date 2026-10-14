import assert from "node:assert/strict";
import { test } from "node:test";
import { createTaskGraph, taskNode } from "../../src/planning/schemas.ts";
import { getReadyTasks, isGraphFinished, topoLayers, validateGraph, writeScopesConflict } from "../../src/planning/dag.ts";

function graph() {
	return createTaskGraph({
		id: "g1",
		rootTask: "demo",
		nodes: [
			taskNode({ id: "explore-a", title: "a", description: "", role: "explorer", dependencies: [], priority: 1 }),
			taskNode({ id: "explore-b", title: "b", description: "", role: "explorer", dependencies: [], priority: 2 }),
			taskNode({ id: "implement", title: "i", description: "", role: "implementer", dependencies: ["explore-a", "explore-b"], priority: 0 }),
		],
	});
}

test("edges are derived from dependencies", () => {
	const g = graph();
	assert.deepEqual(g.edges, [
		{ from: "explore-a", to: "implement" },
		{ from: "explore-b", to: "implement" },
	]);
	assert.deepEqual(validateGraph(g), []);
});

test("validateGraph reports missing dependency and cycles", () => {
	const missing = createTaskGraph({
		id: "g",
		rootTask: "r",
		nodes: [taskNode({ id: "a", title: "a", description: "", role: "explorer", dependencies: ["nope"], priority: 0 })],
	});
	assert.match(validateGraph(missing).join("\n"), /missing task "nope"/);

	const cyclic = createTaskGraph({
		id: "g",
		rootTask: "r",
		nodes: [
			taskNode({ id: "a", title: "a", description: "", role: "explorer", dependencies: ["b"], priority: 0 }),
			taskNode({ id: "b", title: "b", description: "", role: "explorer", dependencies: ["a"], priority: 0 }),
		],
	});
	assert.match(validateGraph(cyclic).join("\n"), /dependency cycle/);
});

test("only dependency-satisfied tasks are ready, highest priority first", () => {
	const g = graph();
	assert.deepEqual(getReadyTasks(g).map((t) => t.id), ["explore-b", "explore-a"]);
	g.nodes["explore-a"].status = "succeeded";
	g.nodes["explore-b"].status = "succeeded";
	assert.deepEqual(getReadyTasks(g).map((t) => t.id), ["implement"]);
	assert.equal(isGraphFinished(g), false);
	for (const node of Object.values(g.nodes)) node.status = "succeeded";
	assert.equal(isGraphFinished(g), true);
});

test("unknown write scope counts as conflict, disjoint scopes do not", () => {
	const a = taskNode({ id: "a", title: "a", description: "", role: "implementer", dependencies: [], priority: 0, writeScope: ["src/auth/"] });
	const b = taskNode({ id: "b", title: "b", description: "", role: "implementer", dependencies: [], priority: 0, writeScope: ["src/users/"] });
	const c = taskNode({ id: "c", title: "c", description: "", role: "implementer", dependencies: [], priority: 0, writeScope: ["src/auth/token.ts"] });
	const unknown = taskNode({ id: "d", title: "d", description: "", role: "implementer", dependencies: [], priority: 0 });
	assert.equal(writeScopesConflict(a, b), false);
	assert.equal(writeScopesConflict(a, c), true);
	assert.equal(writeScopesConflict(a, unknown), true);
});

test("topoLayers groups parallel work", () => {
	assert.deepEqual(topoLayers(graph()), [["explore-a", "explore-b"], ["implement"]]);
});
