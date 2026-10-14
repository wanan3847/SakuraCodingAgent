import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectVerificationPlan, toCommandSequence } from "../../src/verification/command-detector.ts";
import { verify, type CommandRunner } from "../../src/verification/verifier.ts";
import { classifyFailure } from "../../src/verification/failure-classifier.ts";

async function fixture(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "sakura-verify-"));
	for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
	return dir;
}

test("detects commands only for scripts that exist", async () => {
	const dir = await fixture({
		"package.json": JSON.stringify({ scripts: { test: "vitest", typecheck: "tsgo --noEmit" } }),
	});
	assert.deepEqual(await detectVerificationPlan(dir), { typecheck: ["npm run typecheck"], test: ["npm run test"] });
});

test("returns an empty plan instead of inventing commands", async () => {
	const dir = await fixture({ "README.md": "hi" });
	assert.deepEqual(await detectVerificationPlan(dir), {});
});

test("detects python and make projects", async () => {
	const dir = await fixture({ "pyproject.toml": "[tool.pytest.ini_options]\n[tool.ruff]\n", Makefile: "build:\n\techo hi\n" });
	const plan = await detectVerificationPlan(dir);
	assert.deepEqual(plan.test, ["python -m pytest"]);
	assert.deepEqual(plan.lint, ["ruff check ."]);
	assert.deepEqual(plan.build, ["make build"]);
});

test("command order runs fast checks before slow ones", () => {
	assert.deepEqual(
		toCommandSequence({ test: ["npm run test"], lint: ["npm run lint"], build: ["npm run build"] }),
		["npm run lint", "npm run build", "npm run test"],
	);
});

test("verify stops at the first failing command and keeps evidence", async () => {
	const seen: string[] = [];
	const run: CommandRunner = async (command) => {
		seen.push(command);
		if (command === "npm run typecheck") return { exitCode: 2, stdout: "", stderr: "TS2304: cannot find name\nsecond line" };
		return { exitCode: 0, stdout: "ok", stderr: "" };
	};

	const result = await verify({ cwd: "/tmp", commands: ["npm run lint", "npm run typecheck", "npm run test"], run });

	assert.deepEqual(seen, ["npm run lint", "npm run typecheck"]);
	assert.equal(result.passed, false);
	assert.equal(result.steps.length, 2);
	assert.equal(result.failures[0].reason, "TS2304: cannot find name");
	assert.equal(classifyFailure(result), "replan");
});

test("diff review findings fail the run even when all commands pass", async () => {
	const run: CommandRunner = async () => ({ exitCode: 0, stdout: "ok", stderr: "" });
	const result = await verify({
		cwd: "/tmp",
		commands: ["npm run test"],
		run,
		reviewDiff: async () => ["unrelated file modified: src/other.ts"],
	});
	assert.equal(result.passed, false);
	assert.equal(result.reviewedDiff, true);
});

test("network-flavoured failures are retried instead of replanned", () => {
	const result = { passed: false, steps: [], reviewedDiff: false, failures: [{ command: "npm i", exitCode: 1, reason: "ECONNRESET registry unreachable" }] };
	assert.equal(classifyFailure(result), "retry");
});
