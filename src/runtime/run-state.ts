/**
 * SakuraRunState —— 复用指南 §10。
 *
 * 原则：**Pi 保留聊天 Session，Sakura 只存结构化业务状态并引用 Pi Session。**
 * 不把 Task DAG / worktree / 验证证据塞进聊天消息，也不复制一套聊天 Session 数据库。
 * 所以这里存的是 id 和摘要，`rootPiSessionRef` / `piSessionRef` 只是引用。
 *
 * 落盘布局对齐架构文档 §16：<runDir>/state.json + task-graph-v<n>.json。
 */

import { mkdir, readFile } from "node:fs/promises";
import { atomicWrite } from "../storage/atomic.ts";
import type { RunPhase } from "../telemetry/events.ts";
import { join } from "node:path";
import type { TaskGraph, TaskStatus } from "../planning/schemas.ts";
import type { VerificationResult } from "../verification/verifier.ts";
import type {SkillEvidence} from "../skills/loader.ts";

export interface TaskExecutionState {
	taskId: string;
	role: string;
	status: TaskStatus;
	/** 这次任务用的 Pi Session 引用；没有就表示没跑过 */
	piSessionRef?: string;
	agentId?: string;
	changedFiles: string[];
	summary?: string;
	startedAt?: number;
	endedAt?: number;
}

export interface WorkspaceRef {
	taskId: string;
	path: string;
	branch?: string;
	baseCommit?: string;
	/** 降级到原地修改时的原因；有值就说明隔离没生效 */
	fallbackReason?: string;
}

export interface VerificationRecord {
	at: number;
	passed: boolean;
	commands: string[];
	failures: string[];
}

export interface SakuraRunState {
	runId: string;
	phase?: RunPhase;
	artifactPath?: string;
	planPath?: string;
	error?: string;
	/** 宿主 Pi Session 的引用（不是内容） */
	rootPiSessionRef?: string;
	graph: TaskGraph;
	tasks: Record<string, TaskExecutionState>;
	workspaces: Record<string, WorkspaceRef>;
	verification: VerificationRecord[];
	experienceCandidates: string[];
	/** 路由选中的技能名，便于之后做效果追踪（复用指南 §9.2） */
	selectedSkills: string[];
	skillEvidence?:SkillEvidence[];
	startedAt: number;
	endedAt?: number;
}

export function createRunState(input: { runId: string; graph: TaskGraph; rootPiSessionRef?: string; now?: number }): SakuraRunState {
	const now = input.now ?? Date.now();
	return {
		runId: input.runId,
		rootPiSessionRef: input.rootPiSessionRef,
		graph: input.graph,
		tasks: {},
		workspaces: {},
		verification: [],
		experienceCandidates: [],
		selectedSkills: [],
		startedAt: now,
	};
}

/** 从图里同步任务状态。图是执行中的真源，run state 是它的投影。 */
export function syncTasks(state: SakuraRunState): SakuraRunState {
	const tasks: Record<string, TaskExecutionState> = { ...state.tasks };
	for (const node of Object.values(state.graph.nodes)) {
		const previous = tasks[node.id];
		tasks[node.id] = {
			...previous,
			taskId: node.id,
			role: node.role,
			status: node.status,
			changedFiles: node.result?.changedFiles ?? previous?.changedFiles ?? [],
			summary: node.result?.summary ?? previous?.summary,
		};
	}
	return { ...state, tasks };
}

export function recordVerification(state: SakuraRunState, verification: VerificationResult, at = Date.now()): SakuraRunState {
	return {
		...state,
		verification: [
			...state.verification,
			{
				at,
				passed: verification.passed,
				commands: verification.steps.map((step) => step.command),
				failures: verification.failures.map((failure) => `${failure.command}: ${failure.reason}`),
			},
		],
	};
}

export function recordWorkspace(state: SakuraRunState, ref: WorkspaceRef): SakuraRunState {
	return { ...state, workspaces: { ...state.workspaces, [ref.taskId]: ref } };
}

export function recordExperienceCandidates(state: SakuraRunState, ids: readonly string[]): SakuraRunState {
	return { ...state, experienceCandidates: [...state.experienceCandidates, ...ids] };
}

/** 写 state.json + task-graph-v<n>.json（架构文档 §16 的 run 目录布局）。 */
export async function saveRunState(runDir: string, state: SakuraRunState): Promise<string> {
	await mkdir(runDir, { recursive: true });
	const path = join(runDir, "state.json");
	await atomicWrite(path, `${JSON.stringify(state, null, 2)}\n`);
	await atomicWrite(join(runDir, `task-graph-v${state.graph.version}.json`), `${JSON.stringify(state.graph, null, 2)}\n`);
	return path;
}

export async function loadRunState(runDir: string): Promise<SakuraRunState> {
  const state = JSON.parse(await readFile(join(runDir, "state.json"), "utf8")) as SakuraRunState;
  if (!state.runId || !state.graph || !state.tasks || !state.workspaces) throw new Error("Invalid run checkpoint");
  return state;
}
