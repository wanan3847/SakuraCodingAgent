import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeTask, pipelineFor } from "../../src/planning/task-analyzer.ts";
import { isIgnored, rankCandidates } from "../../src/repo-intelligence/retrieval.ts";

test("small edit stays small and does not require multi-agent", () => {
	const analysis = analyzeTask({ description: "fix README typo", hintFiles: ["README.md"] });
	assert.equal(analysis.type, "bugfix");
	assert.equal(analysis.complexity, "small");
	assert.equal(analysis.requiresParallelism, false);
	assert.deepEqual(pipelineFor(analysis).map((step) => step.role), ["implementer"]);
});

test("auth bug across modules is medium+ and marked risky", () => {
	const analysis = analyzeTask({
		description: "fix refresh token bug in auth service",
		hintFiles: ["src/auth/auth-service.ts", "src/tokens/token-service.ts"],
	});
	assert.equal(analysis.type, "bugfix");
	assert.equal(analysis.risk, "high");
	assert.ok(["medium", "large"].includes(analysis.complexity));
});

test("a deep single-file auth fix stays short while preserving its risk", () => {
	const analysis = analyzeTask({description:"fix refresh token bug",hintFiles:["src/auth/auth-service.ts"]});
	assert.equal(analysis.complexity,"small");
	assert.equal(analysis.risk,"high");
	assert.equal(analysis.requiresParallelism,false);
	assert.deepEqual(pipelineFor(analysis).map(step=>step.role),["implementer"]);
});

test("large architecture task gets parallel explorers", () => {
	const analysis = analyzeTask({ description: "migrate all modules to the new architecture", expectedFileCount: 20 });
	assert.equal(analysis.complexity, "large");
	assert.equal(analysis.requiresArchitecture, true);
	assert.equal(pipelineFor(analysis)[0].parallel, 3);
});

test("ranking is weighted and stable on ties", () => {
	const ranked = rankCandidates(
		[
			{ path: "src/b.ts", keywordScore: 1 },
			{ path: "src/a.ts", keywordScore: 1 },
			{ path: "src/important.ts", symbolScore: 1, testScore: 1 },
		],
		{ topK: 2 },
	);
	assert.deepEqual(ranked.map((c) => c.path), ["src/important.ts", "src/a.ts"]);
});

test("build output and vendored code never enter the candidate set", () => {
	assert.equal(isIgnored("node_modules/foo/index.js"), true);
	assert.equal(isIgnored("src/index.ts"), false);
});
