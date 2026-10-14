/**
 * 依赖感知调度器。对应架构文档 §7。
 *
 * 不是 Promise.all(spawnAgent)：它按依赖就绪、写范围不冲突、并发槽可用三个条件取任务。
 * runTask / replan 都是注入的，所以不烧模型 token 就能测。
 */

import { failedTasks, getReadyTasks, isGraphFinished, validateGraph, writeScopesConflict } from "../planning/dag.ts";
import type { TaskGraph, TaskNode, TaskResult, TaskStatus } from "../planning/schemas.ts";
import { agentProfile } from "./agent-registry.ts";

/** 只读角色不产生写冲突，因此可以无条件并行。 */
function concurrentConflict(a: TaskNode, b: TaskNode): boolean {
	return agentProfile(a.role).writes && agentProfile(b.role).writes && writeScopesConflict(a, b);
}

export interface SchedulerEvent {
	type: "task.started" | "task.finished" | "task.skipped" | "replan.triggered" | "graph.finished";
	taskId?: string;
	status?: TaskStatus;
	reason?: string;
	wave?: number;
}

export interface SchedulerOptions {
	maxConcurrency: number;
	signal?: AbortSignal;
	beforeWave?: (graph:TaskGraph) => Promise<void>;
	onGraph?: (graph: TaskGraph) => Promise<void>;
	runTask: (task: TaskNode, graph: TaskGraph) => Promise<TaskResult>;
	/** 返回 undefined 表示放弃重规划，直接把失败上报 */
	replan?: (graph: TaskGraph, failures: TaskNode[]) => Promise<TaskGraph | undefined>;
	maxReplans?: number;
	onEvent?: (event: SchedulerEvent) => void;
}

export interface SchedulerOutcome {
	graph: TaskGraph;
	replans: number;
	waves: number;
}

export async function runGraph(initial: TaskGraph, options: SchedulerOptions): Promise<SchedulerOutcome> {
	if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1) throw new Error("maxConcurrency must be a positive integer");
	const errors = validateGraph(initial);
	if (errors.length) throw new Error(`invalid task graph:\n${errors.join("\n")}`);

	let graph = initial;
	let replans = 0;
	let waves = 0;
	let running: TaskNode[] = [];
	const maxReplans = options.maxReplans ?? 3;

	while (!isGraphFinished(graph)) {
		if (options.signal?.aborted) {
			for (const node of Object.values(graph.nodes)) if (!["succeeded", "failed"].includes(node.status)) node.status = "cancelled";
			await options.onGraph?.(graph);
			break;
		}
		await options.beforeWave?.(graph);
		const ready = getReadyTasks(graph);
		if (!ready.length && !running.length) {
			// 既没就绪任务也没在跑的：依赖链断了，剩下的节点永久 blocked
			for (const node of Object.values(graph.nodes)) {
				if (node.status === "pending") {
					node.status = "blocked";
					options.onEvent?.({ type: "task.skipped", taskId: node.id, reason: "dependency chain broken" });
				}
			}
			break;
		}

		const runnable: TaskNode[] = [];
		for (const task of ready) {
			if (runnable.length + running.length >= options.maxConcurrency) break;
			// 同时与本 wave 已入选的任务比：否则同 wave 内两个写同一目录的任务会并发
			if ([...running, ...runnable].some((active) => concurrentConflict(active, task))) continue;
			runnable.push(task);
		}

		if (runnable.length) {
			waves += 1;
			for (const task of runnable) {
				task.status = "running";
				options.onEvent?.({ type: "task.started", taskId: task.id, wave: waves });
			}
			running = [...running, ...runnable];
			await options.onGraph?.(graph);

			const settled = await Promise.all(
				runnable.map(async (task) => {
					try {
						return { task, result: await options.runTask(task, graph) };
					} catch (error) {
						return {
							task,
							result: {
								status: "failure" as const,
								summary: error instanceof Error ? error.message : String(error),
								changedFiles: [],
								evidence: [],
							},
						};
					}
				}),
			);

			for (const { task, result } of settled) {
				if (options.signal?.aborted) { task.result = result; task.status = "cancelled"; }
				else applyResult(task, result);
				options.onEvent?.({
					type: "task.finished",
					taskId: task.id,
					status: task.status,
					reason: result.summary,
					wave: waves,
				});
			}
			running = running.filter((task) => !runnable.includes(task));
		}

		await options.onGraph?.(graph);
		cancelOrphans(graph);
		graph = { ...graph, updatedAt: Date.now() };

		const failures = failedTasks(graph);
		if (!options.signal?.aborted && failures.length && options.replan && replans < maxReplans) {
			const next = await options.replan(graph, failures);
			if (next) {
				replans += 1;
				options.onEvent?.({
					type: "replan.triggered",
					reason: `${failures.length} failed task(s): ${failures.map((t) => t.id).join(", ")}`,
				});
				const nextErrors = validateGraph(next);
				if (nextErrors.length) throw new Error(`invalid replanned graph:\n${nextErrors.join("\n")}`);
				graph = next;
				await options.onGraph?.(graph);
			}
		}
	}

	options.onEvent?.({ type: "graph.finished", reason: isGraphFinished(graph) ? "finished" : "stalled" });
	return { graph, replans, waves };
}

function applyResult(task: TaskNode, result: TaskResult): void {
	task.result = result;
	switch (result.status) {
		case "success":
			task.status = "succeeded";
			return;
		case "needs_replan":
			task.status = "failed";
			return;
		case "failure":
			if (task.retryCount < task.maxRetries) {
				task.retryCount += 1;
				task.status = "pending";
				return;
			}
			task.status = "failed";
	}
}

function cancelOrphans(graph: TaskGraph): void {
	for (const node of Object.values(graph.nodes)) {
		if (node.status !== "pending") continue;
		if (node.dependencies.some((dep) => graph.nodes[dep]?.status === "failed" || graph.nodes[dep]?.status === "cancelled")) {
			node.status = "cancelled";
		}
	}
}
