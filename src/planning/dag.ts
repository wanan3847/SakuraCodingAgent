/**
 * DAG 校验与就绪判定。纯函数，无 I/O，可单测。
 */

import type { TaskGraph, TaskNode, TaskStatus } from "./schemas.ts";

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["succeeded", "failed", "cancelled"]);

/** 返回错误列表；空数组表示合法。 */
export function validateGraph(graph: TaskGraph): string[] {
	const errors: string[] = [];
	const nodes = Object.values(graph.nodes);
	if (!nodes.length) errors.push("task graph must contain at least one task");

	for (const node of nodes) {
    if(!Number.isSafeInteger(node.maxRetries) || node.maxRetries < 0 || node.maxRetries > 3) errors.push(`task "${node.id}" maxRetries must be an integer 0..3`);
		for (const dep of node.dependencies) {
			if (!graph.nodes[dep]) errors.push(`task "${node.id}" depends on missing task "${dep}"`);
			if (dep === node.id) errors.push(`task "${node.id}" depends on itself`);
		}
	}

	const cycle = findCycle(graph);
	if (cycle) errors.push(`dependency cycle: ${cycle.join(" -> ")}`);

	const declared = new Set(graph.edges.map((e) => `${e.from}>${e.to}`));
	for (const node of nodes) {
		for (const dep of node.dependencies) {
			if (!declared.has(`${dep}>${node.id}`)) errors.push(`edge "${dep} -> ${node.id}" missing from graph.edges`);
		}
	}

	return errors;
}

/** 深度优先找环，只在有环时分配额外内存之外的东西。 */
export function findCycle(graph: TaskGraph): string[] | undefined {
	const state = new Map<string, 0 | 1 | 2>();
	const stack: string[] = [];

	function visit(id: string): string[] | undefined {
		const seen = state.get(id);
		if (seen === 1) return [...stack.slice(stack.indexOf(id)), id];
		if (seen === 2) return undefined;
		state.set(id, 1);
		stack.push(id);
		for (const dep of graph.nodes[id]?.dependencies ?? []) {
			const found = visit(dep);
			if (found) return found;
		}
		stack.pop();
		state.set(id, 2);
		return undefined;
	}

	for (const id of Object.keys(graph.nodes)) {
		const found = visit(id);
		if (found) return found;
	}
	return undefined;
}

/** 依赖全部成功、自身仍在 pending 的节点。 */
export function getReadyTasks(graph: TaskGraph): TaskNode[] {
	return Object.values(graph.nodes)
		.filter(
			(node) =>
				node.status === "pending" &&
				node.dependencies.every((dep) => graph.nodes[dep]?.status === "succeeded"),
		)
		.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

/** 所有节点进入终态；failed 也算结束（是否成功由调用方判断）。 */
export function isGraphFinished(graph: TaskGraph): boolean {
	return Object.values(graph.nodes).every((node) => TERMINAL.has(node.status));
}

export function failedTasks(graph: TaskGraph): TaskNode[] {
	return Object.values(graph.nodes).filter((node) => node.status === "failed");
}

/**
 * 两个任务的写范围是否重叠。空 writeScope 视为“范围未知”，保守判为冲突。
 * TODO(P1): 换成 Repo Intelligence 的符号级依赖分析，减少无谓串行。
 */
export function writeScopesConflict(a: TaskNode, b: TaskNode): boolean {
	if (!a.writeScope?.length || !b.writeScope?.length) return true;
	return a.writeScope.some((scopeA) => b.writeScope?.some((scopeB) => pathPrefixOverlap(scopeA, scopeB)));
}

function pathPrefixOverlap(a: string, b: string): boolean {
	const norm = (p: string) => p.replace(/\/+$/, "");
	return norm(a).startsWith(norm(b)) || norm(b).startsWith(norm(a));
}

/** 拓扑分层：同层可并行。仅用于展示/调试。 */
export function topoLayers(graph: TaskGraph): string[][] {
	const layers: string[][] = [];
	const done = new Set<string>();
	let remaining = Object.keys(graph.nodes);
	while (remaining.length) {
		const layer = remaining.filter((id) => (graph.nodes[id]?.dependencies ?? []).every((d) => done.has(d)));
		if (!layer.length) break; // 有环，validateGraph 已经会报
		for (const id of layer) done.add(id);
		layers.push(layer);
		remaining = remaining.filter((id) => !done.has(id));
	}
	return layers;
}
