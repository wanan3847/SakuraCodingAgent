/**
 * 并行委托：把 N 个互相独立的任务同时交给 N 个 Agent，各自在自己的 git worktree 里干，
 * 最后汇总结果 + 冲突报告。
 *
 * 和 `orchestrator/scheduler.ts` 的分工：scheduler 处理**有依赖**的 TaskGraph（拓扑、重规划、
 * 失败传播）；这里处理**没有依赖**的平铺委托——不需要图，只需要并发上限和隔离。
 * 两者都复用同一套 AgentRunner / WorkspaceManager，不重写执行。
 *
 * 空写任务（explorer / reviewer）不建 worktree：只读角色之间不会互相污染，
 * 原地跑省掉一次 git worktree add。这个判断来自 agentProfile(role).writes，和 scheduler 一致。
 *
 * 不自动合并。跑完只留 diff（去 trace 目录取），由人决定怎么合——和多 Agent 隔离的整个前提一致。
 */

import {RunBudget} from "../runtime/run-budget.ts";
import {loadConfig} from "../config.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {randomUUID} from 'node:crypto';
import { agentProfile } from "./agent-registry.ts";
import { asTaskRunner, type AgentRunner } from "./agent-runner.ts";
import { taskNode, type AgentRole, type TaskNode, type TaskResult } from "../planning/schemas.ts";
import { createPiAgentRunner, type PiAgentRunnerOptions } from "../runtime/pi-agent-runner.ts";
import { collectDiff, createWorkspace, cleanupWorkspace, detectConflict, type AgentSession, type ConflictReport } from "../workspace/worktree.ts";
import { createRunTrace } from "../telemetry/trace.ts";
import { emptyMetrics, type RunMetrics } from "../telemetry/events.ts";
import { saveArtifact } from "../workspace/artifacts.ts";

export interface DelegateTaskSpec {
	/** 唯一 id，也是 worktree / diff 文件名的来源 */
	id: string;
	description: string;
	role: AgentRole;
	/** 允许写的路径前缀；写角色最好给，否则 diff 审查只能靠人眼 */
	writeScope?: string[];
	/** 追加上下文（相关文件摘要、约束、历史经验） */
	context?: string;
}

export interface DelegatedTask {
	id: string;
	role: AgentRole;
	status: "success" | "failure";
	summary: string;
	changedFiles: string[];
	/** 写角色的隔离目录；只读角色为空（原地跑） */
	worktree?: string;
	/** diff 落盘位置；无改动或只读角色为空 */
	diffPath?: string;
	artifactPath?: string;
	preserved?: boolean;
	evidence: string[];
	toolCalls?: number;
	tokensIn?: number;
	tokensOut?: number;
}

export interface DelegateOutcome {
	id: string;
	tasks: DelegatedTask[];
	/** 多个 Agent 改了同一个文件时列出来——这是并行委托最该看的东西 */
	conflicts: ConflictReport;
	metrics: RunMetrics;
	traceDir: string;
	/** worktree 是否还留着（keep=true 时留着给人 review） */
	kept: boolean;
	/** 降级说明（例如不是 git 仓库，隔离没生效） */
	warnings: string[];
}

export interface DelegateOptions {
	signal?:AbortSignal;
	cwd: string;
	tasks: DelegateTaskSpec[];
	/** 不传就自己建一个 Pi AgentRunner（需要可用模型） */
	runner?: AgentRunner;
	/** 透传给 createPiAgentRunner 的模型配置 */
	config?: PiAgentRunnerOptions["config"];
	maxConcurrency?: number;
	timeoutMs?: number;
	/** 跑完是否保留 worktree（默认 false，清理掉） */
	keepWorktrees?: boolean;
	onProgress?: (message: string) => void;
}

export async function delegateTasks(options: DelegateOptions): Promise<DelegateOutcome> {
	const ids=new Set<string>();
	for(const spec of options.tasks){if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(spec.id)||ids.has(spec.id))throw new Error('Delegate task ids must be unique safe filenames');ids.add(spec.id);agentProfile(spec.role);}
	const id = `delegate-${Date.now().toString(36)}-${randomUUID().slice(0,8)}`;
	const trace = await createRunTrace(id, options.cwd);
	const warnings: string[] = [];
	const cfg=await loadConfig(options.cwd);
 const budget=options.config?.budget??new RunBudget(cfg.runtime.budget);
 const signal=options.signal?AbortSignal.any([options.signal,budget.signal]):budget.signal;
 const runner = options.runner ?? createPiAgentRunner({ config: {...options.config,budget,signal}, trace });
	const maxConcurrency = options.maxConcurrency ?? 3;
	if(!Number.isSafeInteger(maxConcurrency)||maxConcurrency<1)throw new Error('maxConcurrency must be a positive integer');
	const timeoutMs = options.timeoutMs ?? 600_000;
	let kept = Boolean(options.keepWorktrees);

	for (const spec of options.tasks) trace.emit({ type: "task.created", taskId: spec.id });

	const results = await pool(options.tasks, maxConcurrency, async (spec) => {
		options.onProgress?.(`${spec.id} (${spec.role}) started`);
		const result = await runOne(spec, runner, trace, options.cwd, timeoutMs, warnings,signal);
		options.onProgress?.(`${spec.id} → ${result.status}`);
		return result;
	});

	// 冲突检测用 AgentSession 的最小形状：detectConflict 只读 taskId 和 changedFiles
	const conflicts = detectConflict(
		results.map((task) => ({ taskId: task.id, changedFiles: task.changedFiles }) as AgentSession),
	);

	const outcome: DelegateOutcome = { id, tasks: results, conflicts, metrics: emptyMetrics(id, Date.now()), traceDir: trace.dir, kept, warnings };


	/*
	 * 默认就在这里清理，不留给调用方。
	 *
	 * 之前是分开的 `cleanupDelegation()`，结果是：`kept: false` 说"没保留"，worktree 却还在磁盘上，
	 * 而且 `git worktree list` 里会一直累积——忘了调用方的代码就永久泄漏。让返回值和磁盘状态一致，
	 * 只在 keepWorktrees: true 时才留（那时交给调用方之后显式调 cleanupDelegation）。
	 * diff 在 runOne 里已经落盘，所以清理不会丢掉 review 需要的东西。
	 */
	if (!kept) await cleanupWorktrees(results, options.cwd);
	kept = kept || results.some((task) => task.preserved);
	outcome.kept = kept;
	await writeFile(join(trace.dir,"budget.json"),JSON.stringify(budget.snapshot(),null,2));
 outcome.metrics = await trace.finish();
	return outcome;
}

async function runOne(
	spec: DelegateTaskSpec,
	runner: AgentRunner,
	trace: Awaited<ReturnType<typeof createRunTrace>>,
	cwd: string,
	timeoutMs: number,
	warnings: string[],
	signal?:AbortSignal,
): Promise<DelegatedTask> {
	if(signal?.aborted)return {id:spec.id,role:spec.role,status:'failure',summary:'Delegation cancelled before dispatch',changedFiles:[],evidence:[]};
	const profile = agentProfile(spec.role);
	const node: TaskNode = taskNode({
		id: spec.id,
		title: spec.id,
		description: spec.description,
		role: spec.role,
		dependencies: [],
		priority: 0,
		writeScope: spec.writeScope,
	});

	// 只读角色原地跑；写角色要隔离
	let session: AgentSession | undefined;
	let workspacePath = cwd;
	if (profile.writes) {
		try {
			session = await createWorkspace(`${trace.runId}-${spec.id}`, cwd, join(cwd, ".sakura", "worktrees"));
			workspacePath = session.worktreePath;
			trace.emit({ type: "workspace.created", path: workspacePath });
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			warnings.push(`${spec.id}: worktree 不可用，任务已停止`);
			trace.emit({type:'task.finished',taskId:spec.id,status:'failed'});
			return {id:spec.id,role:spec.role,status:'failure',summary:`Isolation unavailable: ${reason}`,changedFiles:[],evidence:[]};
		}
	}

	trace.emit({ type: "task.started", taskId: spec.id, agentId: `${spec.role}-${spec.id}` });
	const run = asTaskRunner(runner, { workspacePath, context: spec.context, timeoutMs,signal,baseCommit:session?.baseCommit });

	let result: TaskResult;
	try {
		result = await run(node);
	} catch (error) {
		result = {
			status: "failure",
			summary: error instanceof Error ? error.message : String(error),
			changedFiles: [],
			evidence: [],
		};
	}
	let succeeded = result.status === "success";

	trace.emit({
		type: "task.usage",
		taskId: spec.id,
		agentId: `${spec.role}-${spec.id}`,
		toolCalls: result.toolCallsTraced ? undefined : result.toolCalls,
		tokensIn: result.tokensIn,
		tokensOut: result.tokensOut,
	});

	// 收 diff 落盘：这是人 review 的唯一入口
	let diffPath: string | undefined;
	let artifactPath: string | undefined;
	let preserved = false;
	if (session) {
		try {
			const diff = await collectDiff(session);
			if (!session.artifact) throw new Error("Missing workspace snapshot");
			artifactPath = await saveArtifact(join(trace.dir, "diffs"), spec.id, session.artifact);
			if (diff) {
				diffPath = join(trace.dir, "diffs", `${spec.id}.diff`);
			}
		} catch (error) {
			preserved = true;
			succeeded = false;
			result = { ...result, status: "failure", summary: `Artifact persistence failed: ${String(error)}` };
			warnings.push(`${spec.id}: 产物保存失败，保留工作区 ${session.worktreePath}: ${String(error)}`);
		}
	}

	trace.emit({ type: "task.finished", taskId: spec.id, status: succeeded ? "succeeded" : "failed" });
	return {
		id: spec.id,
		role: spec.role,
		status: succeeded ? "success" : "failure",
		summary: result.summary,
		changedFiles: session?.artifact?.changedFiles ?? result.changedFiles,
		worktree: session?.worktreePath,
		diffPath,
		artifactPath,
		preserved,
		evidence: result.evidence,
		toolCalls: result.toolCalls,
		tokensIn: result.tokensIn,
		tokensOut: result.tokensOut,
	};
}

/**
 * 清理 worktree。keepWorktrees: true 时 `delegateTasks` **不会**清理，由调用方在 review / 手动合并
 * 之后显式调这个。幂等：已经清过的再调只是被吞掉的 git 报错。
 */
export async function cleanupDelegation(outcome: DelegateOutcome, cwd: string): Promise<void> {
	await cleanupWorktrees(outcome.tasks, cwd);
}

async function cleanupWorktrees(tasks: readonly DelegatedTask[], cwd: string): Promise<void> {
	for (const task of tasks) {
		if (!task.worktree || task.preserved) continue;
		await cleanupWorkspace({ taskId: task.id, worktreePath: task.worktree } as AgentSession, cwd).catch((error) => {
			task.preserved = true;
			task.evidence.push(`cleanup failed: ${String(error)}`);
		});
	}
}

/** 渲染成给人看的报告。数字全部来自 outcome，渲染层不自己算。 */
export function renderDelegation(outcome: DelegateOutcome): string {
	const failed = outcome.tasks.filter((task) => task.status === "failure");
	const lines = [
		`# Sakura delegate ${outcome.id}`,
		...outcome.warnings.map((warning) => `⚠ ${warning}`),
		"",
		`tasks: ${outcome.tasks.length}  succeeded: ${outcome.tasks.length - failed.length}  failed: ${failed.length}`,
		`agents: ${outcome.metrics.agents}  tool calls: ${outcome.metrics.toolCalls}  tokens: ${outcome.metrics.tokensIn ?? 0} in / ${outcome.metrics.tokensOut ?? 0} out`,
		"",
		"[TASKS]",
		...outcome.tasks.flatMap((task) => {
			const head = `- ${task.id} (${task.role}) → ${task.status}`;
			const detail = [
				task.changedFiles.length ? `    changed: ${task.changedFiles.join(", ")}` : "    changed: none",
				task.worktree ? `    worktree: ${task.worktree}${outcome.kept || task.preserved ? "" : "（已清理）"}` : "",
				task.artifactPath ? `    artifact: ${task.artifactPath}` : "",
				task.diffPath ? `    diff: ${task.diffPath}` : "",
				task.status === "failure" ? `    error: ${task.summary}` : "",
			].filter(Boolean);
			return [head, ...detail];
		}),
		"",
		"[CONFLICTS]",
		outcome.conflicts.clean
			? "no two agents changed the same file."
			: outcome.conflicts.conflicts.map((conflict) => `${conflict.files.join(", ")} ← ${conflict.sessions.join(", ")}`).join("\n"),
		"",
		`trace: ${outcome.traceDir}`,
		outcome.conflicts.clean
			? "未合并：每个写任务只留下 diff，由你决定怎么合。"
			: "有文件被多个 Agent 改过，合并前先看 CONFLICTS。",
	];
	return lines.filter(Boolean).join("\n");
}

/**
 * 有界并发跑一个平铺列表。失败不影响其它任务——并行委托里一个任务挂掉不该拖垮整批，
 * 这也是它和 scheduler（有依赖，失败要传播）的区别。
 */
async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await work(items[index] as T);
		}
	});
	await Promise.all(workers);
	return results;
}
