/**
 * AgentRunner：Sakura 与 Pi 之间的执行适配层。架构文档 §8。
 *
 * 这是“多 Agent 编排”的边界：Orchestrator 只认这个接口，Pi API 变化只改实现。
 */

import type { AgentRole, TaskGraph, TaskNode, TaskResult } from "../planning/schemas.ts";
import { agentProfile } from "./agent-registry.ts";

export interface AgentRunInput {
	agentId: string;
	signal?: AbortSignal;
	baseCommit?: string;
	role: AgentRole;
	task: TaskNode;
	workspacePath: string;
	/** Prompt 里带上的上下文（不做 Pi context compaction 的替代） */
	context?: string;
	allowedTools: string[];
	timeoutMs: number;
}

export interface AgentRunResult {
	status: "success" | "failure" | "needs_replan";
	summary: string;
	changedFiles: string[];
	diff?: string;
	evidence: string[];
	/** 缺失 = 没测到，不是 0 */
	toolCalls?: number;
	toolCallsTraced?: boolean;
	usage?: { input?: number; output?: number };
}

export interface AgentRunner {
	run(input: AgentRunInput): Promise<AgentRunResult>;
}

/**
 * 真模型实现见 `runtime/pi-agent-runner.ts`（createPiAgentRunner）——那里要 import Pi。
 * 本文件保持“不依赖任何 Runtime”的纯接口 + 确定性替身，方便单测调度器。
 */

/** 开发/测试用：确定性返回，不烧 token。 */
export function createFakeAgentRunner(responses: Record<string, AgentRunResult>): AgentRunner {
	return {
		async run(input) {
			return (
				responses[input.task.id] ?? {
					status: "failure",
					summary: `fake runner has no response for task "${input.task.id}"`,
					changedFiles: [],
					evidence: [],
				}
			);
		},
	};
}

/**
 * AgentRunner → 调度器的 runTask。角色工具白名单在这里显式计算（复用指南 §13：
 * 不能假设“传了 tools 就安全”，权限在 Agent 创建阶段定）。
 */
export function asTaskRunner(
	runner: AgentRunner,
	defaults: { workspacePath: string; context?: string; timeoutMs?: number; signal?: AbortSignal; baseCommit?: string },
	// graph 只是给 scheduler 的签名占位：这里不需要它（依赖解析在调度器里）
): (task: TaskNode, graph?: TaskGraph) => Promise<TaskResult> {
	return async (task) => {
		const result = await runner.run({
			agentId: `${task.role}-${task.id}`,
			signal: defaults.signal,
			baseCommit: defaults.baseCommit,
			role: task.role,
			task,
			workspacePath: defaults.workspacePath,
			context: defaults.context,
			allowedTools: agentProfile(task.role).allowedTools,
			timeoutMs: defaults.timeoutMs ?? 600_000,
		});
		return {
			status: result.status,
			summary: result.summary,
			changedFiles: result.changedFiles,
			diff: result.diff,
			evidence: result.evidence,
			toolCalls: result.toolCalls,
			toolCallsTraced: result.toolCallsTraced,
			tokensIn: result.usage?.input,
			tokensOut: result.usage?.output,
		};
	};
}
