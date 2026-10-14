/**
 * Agent Role → Pi AgentSession 配置。复用指南 §6 的 glue code，不是第六个核心模块。
 */

import type { Approval, ExecutionPolicy } from "../workspace/guard.ts";
import type { SakuraEvent } from "../telemetry/events.ts";
import { agentProfile } from "../orchestrator/agent-registry.ts";
import type { AgentRole } from "../planning/schemas.ts";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { PiCustomTool } from "./create-agent.ts";

export type ThinkingLevelName = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

export interface SakuraAgentConfig {
	role: AgentRole;
	/** worktree 路径或任务 cwd；Pi 的读写工具都相对它解析 */
	cwd: string;
	/** 覆盖角色默认 prompt */
	systemPrompt?: string;
	/** 覆盖角色默认工具白名单。默认来自 agent-registry，不在这里重新维护一份 */
	allowedTools?: string[];
	/** 这个角色额外拿到的 Pi 自定义工具（例如 Planner 的 submit_plan） */
	customTools?: PiCustomTool[];
	/** 不传则由 Pi 的 settings/model runtime 决定 */
	model?: CreateAgentSessionOptions["model"];
	/** 默认只允许 loopback 模型端点；需要云端时显式设为 false。 */
	localOnly?: boolean;
	/** Native Pi objects, shared with the host when provided. */
	modelRuntime?: CreateAgentSessionOptions["modelRuntime"];
	settingsManager?: CreateAgentSessionOptions["settingsManager"];
	sessionManager?: CreateAgentSessionOptions["sessionManager"];
	thinkingLevel?: ThinkingLevelName;
	agentDir?: string;
	/** 测试用 memory，生产用 file */
	signal?: AbortSignal;
	policy?: ExecutionPolicy;
	approve?: Approval;
	onEvent?: (event: SakuraEvent) => void;
	budget?:import('./run-budget.ts').RunBudget;
	sessionMode?: "file" | "memory";
}

export function configForRole(role: AgentRole, cwd: string, overrides: Partial<SakuraAgentConfig> = {}): SakuraAgentConfig {
	const profile = agentProfile(role);
	return {
		role,
		cwd,
		systemPrompt: profile.systemPrompt,
		allowedTools: profile.allowedTools,
		sessionMode: "file",
		...overrides,
	};
}
