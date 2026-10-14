/**
 * Run trace 落盘。目录布局见架构文档 §16：
 *   .sakura/runs/<run-id>/{events.jsonl,metrics.json}
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emptyMetrics, reduceMetrics, type RunMetrics, type SakuraEvent, type TracedEvent } from "./events.ts";

export interface RunTrace {
	runId: string;
	dir: string;
	emit(event: SakuraEvent): void;
	metrics(): RunMetrics;
	finish(): Promise<RunMetrics>;
}

export async function createRunTrace(runId: string, rootDir = process.cwd(), onEvent?: (event: SakuraEvent) => void): Promise<RunTrace> {
	const dir = join(rootDir, ".sakura", "runs", runId);
	await mkdir(dir, { recursive: true });
	const eventsPath = join(dir, "events.jsonl");

	let seq = 0;
	let metrics = emptyMetrics(runId, Date.now());
	// 串行化写入：并发 appendFile 会让 jsonl 行序和 seq 不一致，trace 就不能当证据
	let tail: Promise<unknown> = Promise.resolve();

	return {
		runId,
		dir,
		emit(event) {
			seq += 1;
			metrics = reduceMetrics(metrics, event);
			onEvent?.(event);
			const record: TracedEvent = { seq, at: Date.now(), event };
			tail = tail.then(() => appendFile(eventsPath, `${JSON.stringify(record)}\n`));
		},
		metrics: () => metrics,
		async finish() {
			await tail;
			metrics = { ...metrics, endedAt: Date.now() };
			await writeFile(join(dir, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
			return metrics;
		},
	};
}
