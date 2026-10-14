/**
 * 只读 .sakura/runs 的展示辅助。CLI 和 Pi 扩展共用一份，避免两边各写一个“最近一次 run”。
 * 读取 metrics.json 和最近检查点，不触发任何 run、不缓存。
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface RunRef {
	id: string;
	dir: string;
	/** 读不到 metrics.json 时为空 */
	metrics?: unknown;
	state?: import("../runtime/run-state.ts").SakuraRunState;
}

export async function listRuns(cwd: string): Promise<RunRef[]> {
	const dir = join(cwd, ".sakura", "runs");
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const runs = await Promise.all(
		names.map(async (name) => {
			const runDir = join(dir, name);
			const at = await stat(runDir).then((info) => info.mtimeMs, () => 0);
			const metrics = await readFile(join(runDir, "metrics.json"), "utf8").then(
				(text) => JSON.parse(text) as unknown,
				() => undefined,
			);
			const state = await readFile(join(runDir, "state.json"), "utf8").then(text => JSON.parse(text), () => undefined);
			return { id: name, dir: runDir, metrics, state, at };
		}),
	);
	return runs.sort((a, b) => b.at - a.at).map(({ at: _at, ...run }) => run);
}

export async function newestRunMetrics(cwd: string): Promise<RunRef | undefined> {
	return (await listRuns(cwd))[0];
}
