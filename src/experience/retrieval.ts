/**
 * Experience 检索：新任务来了先翻历史。架构文档 §15 + W7-04。
 *
 * 可解释的词面匹配（症状/标签/工具），不上 embedding——和 Repo 检索同一套口径。
 */

import type { Experience, ExperienceStore } from "./store.ts";

export interface ExperienceQuery {
	task: string;
	tags?: string[];
	limit?: number;
	/** 低于此分不计入，避免拿无关经验污染 Planner */
	minScore?: number;
	now?:number;
	halfLifeDays?:number;
}

export interface ExperienceHit {
	experience: Experience;
	score: number;
	matched: string[];
}

export function retrieveExperience(experiences: Experience[], query: ExperienceQuery): ExperienceHit[] {
	const terms = tokenize(`${query.task} ${(query.tags ?? []).join(" ")}`);
	const minScore = query.minScore ?? 1;

	const hits = experiences
		.map((experience) => {
			const matched: string[] = [];
			let score = 0;
			const haystack = tokenize(`${experience.problemPattern} ${experience.symptoms.join(" ")} ${experience.tags.join(" ")} ${experience.successfulActions.join(" ")} ${experience.relevantFiles.join(" ")}`);
			for (const term of terms) {
				if (haystack.has(term)) {
					score += 1;
					matched.push(term);
				}
			}
			for (const tag of query.tags ?? []) {
				if (experience.tags.includes(tag)) {
					score += 2;
					matched.push(tag);
				}
			}
			// 有验证证据的经验更可信
			if (experience.verificationEvidence.length) score += 0.5;
			const age=experience.createdAt>0 ? Math.max(0,(query.now ?? Date.now())-(experience.lastSeenAt ?? experience.createdAt)) : 0;
      score *= Math.pow(0.5,age/((query.halfLifeDays ?? 90)*86400000));
			return { experience, score, matched: [...new Set(matched)] };
		})
		.filter((hit) => hit.score >= minScore)
		.sort((a, b) => b.score - a.score || a.experience.id.localeCompare(b.experience.id));

	return query.limit ? hits.slice(0, query.limit) : hits;
}

/**
 * Store → Planner 的那一跳（架构路线 §15）：只取高置信命中，拼成 PlannerInput.experience。
 * 没命中就返回空数组，不塞“也许相关”的东西——污染 Planner 比没有经验更贵。
 */
export async function experienceContext(store: ExperienceStore, task: string, limit = 3): Promise<string[]> {
	const hits = retrieveExperience(await store.all(), { task, limit, minScore: 2 });
	return hits.map((hit) => {
		const item = hit.experience;
		return [
			item.problemPattern,
      item.runId ? `source: ${item.runId}${item.traceDir ? ` (${item.traceDir})` : ""}` : "",
			item.failedAttempts.length ? `failed: ${item.failedAttempts.join("; ")}` : "",
			item.successfulActions.length ? `worked: ${item.successfulActions.join("; ")}` : "",
		]
			.filter(Boolean)
			.join(" | ");
	});
}

function tokenize(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9\u4e00-\u9fa5_]+/)
			.filter((token) => token.length > 1),
	);
}
