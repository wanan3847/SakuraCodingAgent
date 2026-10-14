/**
 * 顶层编排：analyze → plan → schedule → verify → trace。架构文档 §5/§7。
 *
 * 只做接线，不实现调度细节（在 scheduler.ts）也不实现验证细节（在 verification/）。
 * 依赖全部注入，所以整条链路可以不用模型、不用 git 跑通。
 */

import { runGraph, type SchedulerOutcome } from "./scheduler.ts";
import { analyzeTask, type TaskAnalysis } from "../planning/task-analyzer.ts";
import type { Planner } from "../planning/planner.ts";
import type { Replanner } from "../planning/replanner.ts";
import type { TaskGraph, TaskNode, TaskResult } from "../planning/schemas.ts";
import type { VerificationResult } from "../verification/verifier.ts";
import type { RunTrace } from "../telemetry/trace.ts";

export interface OrchestratorDeps {
	planner: Planner;
	signal?: AbortSignal;
	beforeWave?: (graph:TaskGraph) => Promise<void>;
	onGraph?: (graph: TaskGraph) => Promise<void>;
	onPlan?: (graph: TaskGraph) => Promise<void>;
	replanner?: Replanner;
	runTask: (task: TaskNode, graph: TaskGraph) => Promise<TaskResult>;
	/** 整体验证（集成后跑一次）；不传则不做验证，结果里 passed 为 undefined */
	verify?: (graph: TaskGraph) => Promise<VerificationResult>;
	trace?: RunTrace;
	maxConcurrency: number;
	maxReplans?: number;
}

export interface OrchestratorInput {
	task: string;
	hintFiles?: string[];
	expectedFileCount?: number;
}

export interface OrchestratorResult {
	analysis: TaskAnalysis;
	graph: TaskGraph;
	scheduler: SchedulerOutcome;
	verification?: VerificationResult;
	/** 只有“任务全绿 + 验证通过”才算完成 */
	completed: boolean;
}

export async function runSakuraTask(input: OrchestratorInput, deps: OrchestratorDeps): Promise<OrchestratorResult> {
	const analysis = analyzeTask({
		description: input.task,
		hintFiles: input.hintFiles,
		expectedFileCount: input.expectedFileCount,
	});
	deps.trace?.emit({ type: "plan.created", graphVersion: 0 });

	deps.signal?.throwIfAborted();
	const planned = await deps.planner.plan({ task: input.task, analysis });
	await deps.onPlan?.(planned);
	deps.trace?.emit({ type: "plan.created", graphVersion: planned.version });
	for (const node of Object.values(planned.nodes)) deps.trace?.emit({ type: "task.created", taskId: node.id });

	const replanner = deps.replanner;
	const scheduler = await runGraph(planned, {
		maxConcurrency: deps.maxConcurrency,
		signal: deps.signal,
		onGraph: deps.onGraph,
    beforeWave:deps.beforeWave,
		maxReplans: deps.maxReplans,
		runTask: async (task, graph) => {
			const result = await deps.runTask(task, graph);
			// usage 在知道的当下就进 trace（Benchmark 的唯一数据源），不从别处补算
			deps.trace?.emit({
				type: "task.usage",
				taskId: task.id,
				agentId: `${task.role}-${task.id}`,
				toolCalls: result.toolCallsTraced ? undefined : result.toolCalls,
				tokensIn: result.tokensIn,
				tokensOut: result.tokensOut,
			});
			return result;
		},
		replan: replanner
			? async (graph, failed) => {
					const result = await replanner.replan({
						graph,
						failed,
						evidence: failed.map((task) => task.result?.summary ?? "unknown").join("\n"),
					});
					return result?.graph;
				}
			: undefined,
		onEvent: (event) => {
			if (event.type === "replan.triggered") deps.trace?.emit({type:"replan.triggered",reason:event.reason ?? "repair"});
			if (event.type === "task.started" && event.taskId) {
				deps.trace?.emit({ type: "task.started", taskId: event.taskId, agentId: "" });
			}
			if (event.type === "task.finished" && event.taskId && event.status) {
				deps.trace?.emit({ type: "task.finished", taskId: event.taskId, status: event.status });
			}
		},
	});

	const tasksOk = Object.values(scheduler.graph.nodes).every((node) => node.status === "succeeded");
	let verification: VerificationResult | undefined;
	if (deps.verify && !deps.signal?.aborted) {
		deps.trace?.emit({ type: "verification.started" });
		verification = await deps.verify(scheduler.graph);
		deps.trace?.emit({ type: "verification.finished", passed: verification.passed });
	}

  if (tasksOk && verification && !verification.passed && verification.status !== "not_run" && !deps.signal?.aborted && deps.replanner && scheduler.replans < (deps.maxReplans ?? 3)) {
    const failed = Object.values(scheduler.graph.nodes).filter((node) => ["implementer", "tester"].includes(node.role));
    const evidence = verification.failures.map((failure) => `${failure.command}: ${failure.reason}`).join("\n");
    const repair = await deps.replanner.replan({ graph:scheduler.graph, failed, evidence });
    if (repair) {
      deps.trace?.emit({type:"replan.triggered",reason:repair.reason});
      const retry = await runSakuraTask(input, { ...deps, planner:{plan:async()=>repair.graph}, maxReplans:(deps.maxReplans ?? 3) - scheduler.replans - 1 });
      return { ...retry, scheduler:{...retry.scheduler,replans:retry.scheduler.replans + scheduler.replans + 1,waves:retry.scheduler.waves + scheduler.waves} };
    }
  }

	return {
		analysis,
		graph: scheduler.graph,
		scheduler,
		verification,
		completed: !deps.signal?.aborted && tasksOk && (verification ? verification.passed : true),
	};
}
