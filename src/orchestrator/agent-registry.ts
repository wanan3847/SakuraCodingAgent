/**
 * 角色 → Prompt / 工具白名单 / 模型档位。对应架构文档 §8 与复用指南 §6。
 *
 * 这是 Sakura 唯一一处“显式计算 Agent 权限”的地方。工具名直接沿用 Pi 内置工具名，
 * 不复制 Pi 的工具 schema。
 */

import type { AgentRole } from "../planning/schemas.ts";

export interface AgentProfile {
	role: AgentRole;
	systemPrompt: string;
	allowedTools: string[];
	/** 只读角色禁止写，调度器据此决定是否分配 worktree */
	writes: boolean;
}

const READ_ONLY = ["read", "grep", "find", "ls"];

export const AGENT_PROFILES: Record<AgentRole, AgentProfile> = {
	explorer: {
		role: "explorer",
		systemPrompt: "Explore the repository and report findings only. Do not modify files. Cite file paths and line numbers.",
		allowedTools: READ_ONLY,
		writes: false,
	},
	planner: {
		role: "planner",
		systemPrompt: "Decompose the task into a dependency-ordered DAG. Return structured output only.",
		allowedTools: ["read", "grep", "find", "ls"],
		writes: false,
	},
	architect: {
		role: "architect",
		systemPrompt: "Decide module boundaries, interfaces and the order of implementation. No code edits.",
		allowedTools: READ_ONLY,
		writes: false,
	},
	implementer: {
		role: "implementer",
		systemPrompt: "Implement the assigned change in the given workspace. Keep the diff minimal and run available checks.",
		allowedTools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
		writes: true,
	},
	tester: {
		role: "tester",
		systemPrompt: "Add or update tests that fail before the fix and pass after. Report exact commands and output.",
		allowedTools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
		writes: true,
	},
	reviewer: {
		role: "reviewer",
		systemPrompt: "Review the diff for correctness and scope creep. Report concrete issues with file:line.",
		allowedTools: READ_ONLY,
		writes: false,
	},
	researcher: {
		role: "researcher",
		systemPrompt: "Gather repository evidence for the question using read/search tools. No file modifications.",
		allowedTools: READ_ONLY,
		writes: false,
	},
};

export function agentProfile(role: AgentRole): AgentProfile {
	return AGENT_PROFILES[role];
}
