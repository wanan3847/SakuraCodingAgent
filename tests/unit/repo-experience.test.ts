import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createExperienceStore, type Experience } from "../../src/experience/store.ts";
import { retrieveExperience } from "../../src/experience/retrieval.ts";
import { indexRepository } from "../../src/repo-intelligence/indexer.ts";
import { SymbolIndex } from "../../src/repo-intelligence/symbol-index.ts";
import type { LanguageParser } from "../../src/repo-intelligence/parser.ts";

function experience(overrides: Partial<Experience>): Experience {
	return {
		id: "e1",
		problemPattern: "refresh token returns stale token",
		symptoms: ["stale token after refresh"],
		failedAttempts: [],
		successfulActions: [],
		usefulTools: [],
		relevantFiles: [],
		verificationEvidence: [],
		tags: ["auth"],
		createdAt: 0,
		...overrides,
	};
}

test("store round-trips experiences and retrieval ranks by symptom overlap", async () => {
	const root = await mkdtemp(join(tmpdir(), "sakura-exp-"));
	const store = createExperienceStore(root);

	await store.add(experience({ id: "auth-1" }));
	await store.add(experience({ id: "ui-1", problemPattern: "button misaligned", symptoms: ["layout"], tags: ["ui"] }));

	const all = await store.all();
	assert.equal(all.length, 2);

	const hits = retrieveExperience(all, { task: "refresh token is stale after refresh", tags: ["auth"], limit: 1 });
	assert.equal(hits[0]?.experience.id, "auth-1");
	assert.ok(hits[0]?.score > 2);
	assert.equal(retrieveExperience(all, { task: "unrelated thing" }).length, 0);
});

test("symbol index answers the queries repo intelligence must support", () => {
	const index = new SymbolIndex();
	index.addSymbol({ id: "src/token.ts#refresh", name: "refresh", kind: "function", file: "src/token.ts", startLine: 10, endLine: 20 });
	index.addSymbol({ id: "src/auth.ts#login", name: "login", kind: "function", file: "src/auth.ts", startLine: 1, endLine: 9 });
	index.addEdge({ kind: "CALLS", from: "src/auth.ts#login", to: "src/token.ts#refresh" });
	index.addEdge({ kind: "IMPORTS", from: "src/auth.ts", to: "src/token.ts" });
	index.addEdge({ kind: "TESTS", from: "tests/token.test.ts", to: "src/token.ts#refresh" });

	assert.equal(index.findSymbol("refresh").length, 1);
	assert.deepEqual(index.findCallers("src/token.ts#refresh"), ["src/auth.ts#login"]);
	assert.deepEqual(index.findRelatedTests("src/token.ts#refresh"), ["tests/token.test.ts"]);
	assert.deepEqual(index.getDependencies("src/auth.ts"), ["src/token.ts"]);
	// 2 个符号各自带一条 FILE_CONTAINS_SYMBOL 边，再加 CALLS/IMPORTS/TESTS
	assert.deepEqual(index.size(), { symbols: 2, edges: 5 });
});

test("indexer walks the repo, honours ignores and skips oversized files", async () => {
	const root = await mkdtemp(join(tmpdir(), "sakura-idx-"));
	await writeFile(join(root, "a.ts"), "export const a = 1;\n");
	await writeFile(join(root, "big.ts"), "x".repeat(4096));
	await writeFile(join(root, "notes.md"), "ignored by extension");

	const parser: LanguageParser = {
		extensions: [".ts"],
		parse(path) {
			return { path, symbols: [{ id: `${path}#a`, name: "a", kind: "variable", startLine: 1, endLine: 1 }], edges: [] };
		},
	};

	const result = await indexRepository({ root, parser, maxIndexedFileSizeKb: 1 });
	assert.equal(result.indexedFiles, 1);
	assert.deepEqual(result.skipped, ["big.ts"]);
	assert.deepEqual(result.index.files(), ["a.ts"]);
});
