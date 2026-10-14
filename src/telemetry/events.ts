/**
 * 统一事件模型。对应架构文档 §16。
 * Trace 是 Benchmark、Replanning、Experience 的唯一数据源，UI 不允许自己猜数据。
 */

export type RunPhase = "idle" | "planning" | "running" | "verifying" | "ready_to_apply" | "unverified" | "failed" | "cancelled" | "applied";

export type SakuraEvent =
  | {type:"model.usage";agentId:string;input?:number;output?:number;cacheRead?:number;model?:string}
  | {type:"context.selected";paths:string[];estimatedTokens:number;budget:number}
  | {type:"instruction.updated";id:string;target:string;status:string;graphVersion?:number;reason?:string}
	| { type: "policy.decision"; agentId: string; tool: string; decision: string; reason?: string }
	| { type: "run.phase"; phase: RunPhase; runId: string }
	| { type: "task.created"; taskId: string }
	| { type: "plan.created"; graphVersion: number }
	| { type: "task.started"; taskId: string; agentId: string }
	| { type: "tool.called"; agentId: string; tool: string;path?:string }
	| { type: "file.read"; agentId: string; path: string }
	| { type: "task.finished"; taskId: string; status: string }
	| { type: "task.usage"; taskId: string; agentId: string; toolCalls?: number; tokensIn?: number; tokensOut?: number }
	| { type: "verification.started" }
	| { type: "verification.finished"; passed: boolean }
	| { type: "replan.triggered"; reason: string }
	| { type: "workspace.created"; path: string }
	| { type: "workspace.cleaned"; path: string };

export type SakuraEventType = SakuraEvent["type"];

export interface TracedEvent {
	seq: number;
	at: number;
	event: SakuraEvent;
}

export interface RunMetrics {
	runId: string;
	startedAt: number;
	endedAt?: number;
	tasks: number;
	tasksSucceeded: number;
	tasksFailed: number;
	replans: number;
	toolCalls: number;
	agents: number;
	tokensIn?: number;
	tokensOut?: number;
	verificationRuns: number;
	verificationPassed: number;
}

export function emptyMetrics(runId: string, startedAt: number): RunMetrics {
	return {
		runId,
		startedAt,
		tasks: 0,
		tasksSucceeded: 0,
		tasksFailed: 0,
		replans: 0,
		toolCalls: 0,
		agents: 0,
		verificationRuns: 0,
		verificationPassed: 0,
	};
}

/** 事件 → metrics 的唯一归约点，避免多处手工累加对不上。 */
export function reduceMetrics(metrics: RunMetrics, event: SakuraEvent): RunMetrics {
	switch (event.type) {
		case "task.created":
			return { ...metrics, tasks: metrics.tasks + 1 };
		case "task.finished":
			return {
				...metrics,
				tasksSucceeded: metrics.tasksSucceeded + (event.status === "succeeded" ? 1 : 0),
				tasksFailed: metrics.tasksFailed + (event.status === "failed" ? 1 : 0),
			};
		case "task.started":
			// 每个 started 就是一次真实 Agent 调用；Benchmark 的 agent 计数从这里来
			return { ...metrics, agents: metrics.agents + 1 };
		case "tool.called":
			return { ...metrics, toolCalls: metrics.toolCalls + 1 };
		case "task.usage":
			return {
				...metrics,
				toolCalls: metrics.toolCalls + (event.toolCalls ?? 0),
				tokensIn: event.tokensIn === undefined ? metrics.tokensIn : (metrics.tokensIn ?? 0) + event.tokensIn,
				tokensOut: event.tokensOut === undefined ? metrics.tokensOut : (metrics.tokensOut ?? 0) + event.tokensOut,
			};
		case "replan.triggered":
			return { ...metrics, replans: metrics.replans + 1 };
		case "verification.finished":
			return {
				...metrics,
				verificationRuns: metrics.verificationRuns + 1,
				verificationPassed: metrics.verificationPassed + (event.passed ? 1 : 0),
			};
		default:
			return metrics;
	}
}
