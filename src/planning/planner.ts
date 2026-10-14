/**
 * Planner：把用户任务 + Repo Intelligence + 经验，变成受校验的 TaskGraph。
 *
 * 规则：Planner 只输出结构化 TaskGraph，Scheduler 不解析自由文本。
 */

import type { TaskGraph, TaskNode, VerificationSpec } from "./schemas.ts";
import { createTaskGraph, taskNode } from "./schemas.ts";
import { validateGraph } from "./dag.ts";
import { validatePlannerOutput, type PlannerOutput } from "./validator.ts";
import { pipelineFor, type AgentRolePlan, type TaskAnalysis } from "./task-analyzer.ts";

export interface PlannerInput {
	/** 用户原始任务描述 */
	task: string;
	analysis: TaskAnalysis;
	/** Repo Intelligence 给出的相关文件/符号摘要 */
	repoContext?: string;
	/** 检索到的历史经验 */
	experience?: string[];
	/** 仓库当前 git 状态摘要 */
	gitState?: string;
}

export interface Planner {
	plan(input: PlannerInput): Promise<TaskGraph>;
}

/**
 * 确定性 Planner：按 `pipelineFor(analysis)` 的复杂度规则生成 Stage 串行、Stage 内并行的 DAG。
 *
 * 存在的意义不是“凑合”，而是让 Orchestrator / Workspace / Verification 在没有可用模型时
 * 也能端到端跑通并留下 Trace（架构文档 §35：先让每一层都有可运行的端到端版本）。
 * 模型 Planner 接进来之后，它会作为 Plan 校验失败或模型不可用时的兜底。
 *
 * ponytail: 阶段间一律全串行，没有做“只依赖真正的前置”的细粒度剪枝。
 * 目前 pipelineFor 的语义就是分阶段，等 Benchmark 证明串行是瓶颈再细化。
 */
export function createHeuristicPlanner(options: { graphId?: string; now?: number } = {}): Planner {
	return {
		async plan(input: PlannerInput): Promise<TaskGraph> {
			const stages = pipelineFor(input.analysis);
			const nodes: TaskNode[] = [];
			const planned: TaskNode[][] = [];

			for (const stage of stages) {
				const stageNodes: TaskNode[] = [];
				for (let index = 0; index < stage.parallel; index += 1) {
					stageNodes.push(stageNode(stage.role, index, stage.parallel, input));
				}
				planned.push(stageNodes);
			}

			for (const [stageIndex, stageNodes] of planned.entries()) {
				const dependencies = planned[stageIndex - 1]?.map((node) => node.id) ?? [];
				for (const node of stageNodes) nodes.push({ ...node, dependencies });
			}

			return createTaskGraph({
				id: options.graphId ?? `plan-${input.analysis.type}-${nodes.length}`,
				rootTask: input.task,
				nodes,
				now: options.now,
			});
		},
	};
}

const VERIFICATION_FOR_ROLE: Record<AgentRolePlan["role"], VerificationSpec[]> = {
	explorer: [],
	architect: [],
	implementer: [],
	tester: [],
	reviewer: [],
};

const ROLE_OUTCOME: Record<AgentRolePlan["role"], string> = {
	explorer: "只读调查：定位相关实现、调用方和测试，给出文件位置及修复建议。",
	architect: "只读设计：结合前置调查提出实现方案、接口约束和验证方式。",
	implementer: "实现任务：检查相关代码和测试，完成必要改动；不要声称运行未调用的检查。",
	tester: "补充回归测试：读取前置实现，按仓库约定新增或修正测试；不要重复实现业务逻辑。",
	reviewer: "只读审查：检查前置改动及其影响，报告有文件位置支持的问题和剩余风险。",
};

function stageNode(role: AgentRolePlan["role"], index: number, parallel: number, input: PlannerInput): TaskNode {
	const id = parallel > 1 ? `${role}-${index + 1}` : role;
	const scope = input.analysis.likelyFiles;
	const writes = role === "implementer" || role === "tester";
	return taskNode({
		id,
		title: `${role}${parallel > 1 ? ` #${index + 1}` : ""}`,
		description: `${ROLE_OUTCOME[role]}\n\n用户任务：\n${input.task}`,
		role,
		dependencies: [],
		priority: index,
		// File hints guide retrieval, not authorization. Related imports/tests must
		// remain readable. Only the model's explicit scopes constrain those paths.
		writeScope: writes && role === "implementer" && scope.length ? scope : undefined,
		verification: VERIFICATION_FOR_ROLE[role],
		maxRetries: role === "implementer" || role === "tester" ? 2 : 1,
	});
}

/**
 * 结构化 Planner —— 复用指南 §8.1 的 `submit_plan`。
 *
 * Planner 本质仍是「一个配置了专用 Prompt 和工具集的 Pi Session」，不重写 Agent Loop：
 * 调用方负责起会话、发 prompt，本模块只负责
 *   1. 定义 `submit_plan` 这个结构化工具（Pi 的 customTools）
 *   2. 校验它收到的参数
 *   3. 把校验过的任务列表变成 TaskGraph
 *
 * 模型没调工具 / 参数不合法 → 返回 undefined，由调用方决定降级（通常是走启发式 Planner）。
 * 不抛异常，因为“模型这次没按格式输出”是常态，不是崩溃。
 */

export interface SubmitPlanResult {
	graph?: TaskGraph;
	/** 为什么没拿到图；undefined 表示成功 */
	rejected?: string;
	/** 模型自己声明的不确定性，进 trace 用 */
	notes?: string[];
}

export interface PlanToolParams {
	tasks: Array<Partial<TaskNode>>;
	notes?: string[];
}

/** `submit_plan` 收到的参数 → 受校验的 TaskGraph。纯函数，不烧 token 就能测。 */
export function planFromToolParams(params: PlanToolParams, input: { graphId: string; rootTask: string; now?: number }): SubmitPlanResult {
	const output: PlannerOutput = { tasks: params.tasks ?? [] };
	const errors = validatePlannerOutput(output);
	if (errors.length) return { rejected: errors.join("; "), notes: params.notes };

	const nodes: TaskNode[] = [];
	for (const task of output.tasks) {
		nodes.push(
			taskNode({
				id: task.id as string,
				title: task.title as string,
				description: task.description as string,
				role: task.role as TaskNode["role"],
				dependencies: task.dependencies ?? [],
				priority: task.priority ?? 0,
				readScope: task.readScope,
				writeScope: task.writeScope,
				verification: task.verification,
				maxRetries: task.maxRetries ?? 1,
			}),
		);
	}

	const graph = createTaskGraph({ id: input.graphId, rootTask: input.rootTask, nodes, now: input.now });
	const graphErrors = validateGraph(graph);
	if (graphErrors.length) return { rejected: graphErrors.join("; "), notes: params.notes };
	return { graph, notes: params.notes };
}

/** Planner 用的系统提示词。约束它只输出结构化任务，不做别的。 */
export function plannerPrompt(input: PlannerInput): string {
	const lines = [
		"你是 Sakura 的任务规划器。把用户任务拆成依赖有序的任务 DAG，然后调用 submit_plan 提交。",
		"",
		"你的回答里**只能**是 submit_plan 工具调用。不要写解释、不要写计划正文、不要在文本里贴 JSON——",
		"文本输出会被忽略，只有 submit_plan 的参数算数。现在就调用它。",
		"",
		"规则：",
		"- 任务数不超过 12。简单修复或小功能用一个 implementer 完成；外层负责运行项目检查。",
		"- 每个任务必须给 id / title / description / role / priority。",
		"- role 只能是 explorer / architect / implementer / tester / reviewer / researcher。",
		"- dependencies 只能引用本次提交里存在的 id；必须无环。",
		"- implementer / tester 必须给 writeScope（要改哪些路径前缀），否则调度器只能保守串行。",
		"- 互相独立的 explorer 可以并行，让它们没有共同依赖。",
		"",
		`任务类型判定：type=${input.analysis.type} complexity=${input.analysis.complexity} risk=${input.analysis.risk}`,
		`是否需要仓库探索：${input.analysis.requiresRepoExploration}；是否值得并行：${input.analysis.requiresParallelism}`,
		input.analysis.likelyFiles.length ? `用户提到的文件：${input.analysis.likelyFiles.join(", ")}` : "",
		input.repoContext ? `仓库上下文：\n${input.repoContext}` : "",
		input.gitState ? `git 状态：${input.gitState}` : "",
		input.experience?.length ? `历史经验（避免重复失败）：\n${input.experience.map((line) => `- ${line}`).join("\n")}` : "",
		"",
		`用户任务：\n${input.task}`,
	];
	return lines.filter(Boolean).join("\n");
}
