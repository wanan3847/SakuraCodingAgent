import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRunTrace } from "../../src/telemetry/trace.ts";
import type { TracedEvent } from "../../src/telemetry/events.ts";

test("trace writes jsonl events in order and aggregates metrics", async () => {
	const root = await mkdtemp(join(tmpdir(), "sakura-trace-"));
	const trace = await createRunTrace("run-1", root);

	trace.emit({ type: "task.created", taskId: "a" });
	trace.emit({ type: "task.started", taskId: "a", agentId: "impl-1" });
	trace.emit({ type: "tool.called", agentId: "impl-1", tool: "read" });
	trace.emit({ type: "task.finished", taskId: "a", status: "succeeded" });
	trace.emit({ type: "verification.finished", passed: true });
	const metrics = await trace.finish();

	assert.equal(metrics.tasks, 1);
	assert.equal(metrics.tasksSucceeded, 1);
	assert.equal(metrics.toolCalls, 1);
	assert.equal(metrics.verificationPassed, 1);
	assert.ok(metrics.endedAt);

	const lines = (await readFile(join(root, ".sakura", "runs", "run-1", "events.jsonl"), "utf8")).trim().split("\n");
	assert.equal(lines.length, 5);
	const parsed = lines.map((line) => JSON.parse(line) as TracedEvent);
	assert.deepEqual(parsed.map((record) => record.seq), [1, 2, 3, 4, 5]);
	assert.ok(parsed.every((record, index) => index === 0 || record.at >= parsed[index - 1].at));

	const written = JSON.parse(await readFile(join(root, ".sakura", "runs", "run-1", "metrics.json"), "utf8"));
	assert.deepEqual(written, metrics);
});
