/**
 * Task DAG 数据模型。对应架构文档 §4。
 *
 * 这里只有类型和一个工厂函数；图合法性在 dag.ts，执行在 orchestrator/。
 */

export type TaskStatus = "pending" | "ready" | "running" | "blocked" | "succeeded" | "failed" | "cancelled";

export type AgentRole = "explorer" | "planner" | "architect" | "implementer" | "tester" | "reviewer" | "researcher";

export type VerificationKind = "lint" | "typecheck" | "test" | "build" | "custom";

export interface VerificationSpec {
	kind: VerificationKind;
	command: string;
}

export interface TaskResult {
	status: "success" | "failure" | "needs_replan";
	summary: string;
	changedFiles: string[];
	diff?: string;
	evidence: string[];
	/** 该任务的真实用量，进 trace.metrics（Benchmark 的唯一数据源）。缺省表示没测到，不是 0。 */
	toolCalls?: number;
	toolCallsTraced?: boolean;
	tokensIn?: number;
	tokensOut?: number;
}

export interface TaskNode {
	id: string;
	title: string;
	description: string;

	role: AgentRole;
	dependencies: string[];

	status: TaskStatus;
	priority: number;

	/** 任务允许读的路径前缀，空表示不限制 */
	readScope?: string[];
	/** 任务允许写的路径前缀；调度器用它避免并行写冲突 */
	writeScope?: string[];

	verification?: VerificationSpec[];

	retryCount: number;
	maxRetries: number;

	result?: TaskResult;
}

export interface TaskGraph {
	id: string;
	rootTask: string;
	version: number;

	nodes: Record<string, TaskNode>;
	/** 由 dependencies 派生，createTaskGraph/buildEdges 生成，不要手写 */
	edges: Array<{ from: string; to: string }>;

	createdAt: number;
	updatedAt: number;
}

export type TaskNodeInput = Omit<TaskNode, "status" | "retryCount" | "maxRetries"> &
	Partial<Pick<TaskNode, "status" | "retryCount" | "maxRetries">>;

export function taskNode(input: TaskNodeInput): TaskNode {
	return {
		status: "pending",
		retryCount: 0,
		maxRetries: 1,
		...input,
	};
}

/** dependencies → edges。图里只保留 dependencies 一个真源。 */
export function buildEdges(nodes: Record<string, TaskNode>): Array<{ from: string; to: string }> {
	return Object.values(nodes).flatMap((node) => node.dependencies.map((from) => ({ from, to: node.id })));
}

export function createTaskGraph(input: {
	id: string;
	rootTask: string;
	nodes: TaskNode[];
	version?: number;
	now?: number;
}): TaskGraph {
	const nodes: Record<string, TaskNode> = {};
	for (const node of input.nodes) nodes[node.id] = node;
	const now = input.now ?? Date.now();
	return {
		id: input.id,
		rootTask: input.rootTask,
		version: input.version ?? 1,
		nodes,
		edges: buildEdges(nodes),
		createdAt: now,
		updatedAt: now,
	};
}
