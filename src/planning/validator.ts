/**
 * Planner 输出的 schema 校验。预留框架（W3-01/W3-03）。
 *
 * 手写校验，不引 zod：只查 Planner 最容易犯的错（缺字段、悬空依赖、写范围缺失）。
 */

import type { AgentRole, TaskNode, VerificationSpec } from "./schemas.ts";

export interface PlannerOutput {
	tasks: Array<Partial<TaskNode>>;
}

const ROLES: AgentRole[] = ["explorer", "planner", "architect", "implementer", "tester", "reviewer", "researcher"];
const KINDS: VerificationSpec["kind"][] = ["lint", "typecheck", "test", "build", "custom"];

export function validatePlannerOutput(output: PlannerOutput): string[] {
	const errors: string[] = [];
	if (!Array.isArray(output?.tasks) || output.tasks.length === 0) {
		return ["planner output must contain a non-empty tasks array"];
	}

	const ids = new Set(output.tasks.map((task) => task.id).filter((id): id is string => Boolean(id)));

	for (const task of output.tasks) {
		const at = task.id ?? "<missing id>";
		if (!task.id) errors.push("task is missing id");
		if (!task.title) errors.push(`task "${at}" is missing title`);
		if (!task.description) errors.push(`task "${at}" is missing description`);
		if (!task.role || !ROLES.includes(task.role)) errors.push(`task "${at}" has invalid role "${task.role}"`);
		if (typeof task.priority !== "number") errors.push(`task "${at}" is missing numeric priority`);
		for (const dep of task.dependencies ?? []) {
			if (!ids.has(dep)) errors.push(`task "${at}" depends on unknown task "${dep}"`);
		}
		// 架构文档 §4 要求：写任务前尽可能确定 writeScope，否则调度器只能保守串行
		if (task.role === "implementer" || task.role === "tester") {
			if (!task.writeScope?.length) errors.push(`task "${at}" is a writer but has no writeScope`);
		}
		for (const spec of task.verification ?? []) {
			if (!KINDS.includes(spec.kind)) errors.push(`task "${at}" has invalid verification kind "${spec.kind}"`);
			if (!spec.command) errors.push(`task "${at}" has an empty verification command`);
		}
	}
	return errors;
}
