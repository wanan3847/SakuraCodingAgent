/**
 * Skill Router：复用指南 §9.2「Skill Metadata Catalog → Sakura Skill Router → Selected
 * Skill References → Pi AgentSession」。
 *
 * 只做选择，不重写 Skill 系统。创新点在“按任务匹配 + 记录选了哪个”（后者是效果追踪的前提），
 * 不在于换一种 Markdown 格式重新实现 Skill。
 *
 * ponytail: 词面匹配 + 任务类型偏置，没有 embedding（架构路线 §9.4 第一版口径）。
 */

import { overlapScore, tokenize } from "../text.ts";
import type { TaskAnalysis } from "../planning/task-analyzer.ts";
import type { SkillMeta } from "./registry.ts";

export interface SkillQuery {
	task: string;
	/** 来自 Task Analyzer；用来做类型偏置 */
	analysis?: Pick<TaskAnalysis, "type" | "complexity" | "requiresArchitecture" | "requiresRepoExploration">;
	limit?: number;
	/** 低于此分不计入。0 分表示只是被类型偏置抬上来的，也算数 */
	minScore?: number;
}

export interface SkillRoute {
	skill: SkillMeta;
	score: number;
	matched: string[];
	/** 为什么选它（进 trace / run state） */
	reason: string;
}

/**
 * 任务类型 → 应该优先参考的技能。这是路由的“先验”，不是硬性绑定：
 * 词面命中仍然可以把它挤掉。
 */
const TYPE_AFFINITY: Record<TaskAnalysis["type"], string[]> = {
	bugfix: ["systematic-debugging", "verification", "tdd"],
	feature: ["planning", "tdd", "verification"],
	refactor: ["planning", "code-review", "verification"],
	research: ["systematic-debugging", "planning"],
	edit: ["verification", "code-review"],
};

export function routeSkills(catalog: readonly SkillMeta[], query: SkillQuery): SkillRoute[] {
	const terms = tokenize(query.task);
	const affinity = query.analysis ? (TYPE_AFFINITY[query.analysis.type] ?? []) : [];

	const routes = catalog.map((skill) => {
		const { score, matched } = overlapScore(terms, `${skill.name} ${skill.description}`);
		const rank = affinity.indexOf(skill.name.replace(/^sakura-/, ""));
		const biased = rank >= 0 ? 1 + (affinity.length - rank) / affinity.length : 0;
		const reasons = [
			matched.length ? `matched ${matched.join(", ")}` : "",
			rank >= 0 ? `task type "${query.analysis?.type}" prefers ${skill.name}` : "",
		];
		return { skill, score: score + biased, matched, reason: reasons.filter(Boolean).join("; ") || "no signal" };
	});

	const minScore = query.minScore ?? 0.5;
	const ranked = routes.filter((route) => route.score >= minScore).sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
	return query.limit ? ranked.slice(0, query.limit) : ranked;
}
