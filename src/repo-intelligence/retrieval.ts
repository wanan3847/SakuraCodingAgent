/**
 * Repository Intelligence 的检索排序。对应架构文档 §9.4。
 *
 * 第一版是可解释的加权规则，不上 embedding/向量库。权重是配置，不宣称最优。
 */

export interface Candidate {
	path: string;
	/** 命中关键词的次数或相关性，调用方给归一化前的原始值 */
	keywordScore?: number;
	symbolScore?: number;
	dependencyScore?: number;
	testScore?: number;
	gitChangeScore?: number;
	recencyScore?: number;
}

export const DEFAULT_WEIGHTS = {
	keyword: 0.3,
	symbol: 0.25,
	dependency: 0.15,
	test: 0.15,
	gitChange: 0.1,
	recency: 0.05,
} as const;

export type Weights = typeof DEFAULT_WEIGHTS;

export interface RankOptions {
	topK?: number;
	weights?: Weights;
}

export function rankCandidates(candidates: Candidate[], options: RankOptions = {}): Candidate[] {
	const weights = options.weights ?? DEFAULT_WEIGHTS;
	const scored = candidates.map((candidate) => ({ candidate, score: score(candidate, weights) }));
	scored.sort((a, b) => b.score - a.score || a.candidate.path.localeCompare(b.candidate.path));
	const ranked = scored.map((entry) => entry.candidate);
	return options.topK ? ranked.slice(0, options.topK) : ranked;
}

export function score(candidate: Candidate, weights: Weights = DEFAULT_WEIGHTS): number {
	return (
		weights.keyword * (candidate.keywordScore ?? 0) +
		weights.symbol * (candidate.symbolScore ?? 0) +
		weights.dependency * (candidate.dependencyScore ?? 0) +
		weights.test * (candidate.testScore ?? 0) +
		weights.gitChange * (candidate.gitChangeScore ?? 0) +
		weights.recency * (candidate.recencyScore ?? 0)
	);
}

/** 目录/构建产物一律不进入候选，避免把 node_modules 喂给 Agent。 */
export const DEFAULT_IGNORES = [
	"node_modules/",
	".git/",
	"dist/",
	"build/",
	"out/",
	"coverage/",
	".sakura/",
	"vendor/",
	"target/",
	"__pycache__/",
];

export function isIgnored(path: string, ignores: string[] = DEFAULT_IGNORES): boolean {
	return ignores.some((needle) => path.includes(needle));
}
