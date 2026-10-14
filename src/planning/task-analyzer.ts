/**
 * Task Analyzer：先判断复杂度和风险，再决定要不要启动多 Agent。
 * 对应架构文档 §6.1。第一版是可解释的启发式规则，不做模型调用。
 */

export type TaskType = "edit" | "bugfix" | "feature" | "refactor" | "research";
export type Complexity = "small" | "medium" | "large";
export type Risk = "low" | "medium" | "high";

export interface TaskAnalysis {
	type: TaskType;
	complexity: Complexity;
	likelyFiles: string[];
	requiresRepoExploration: boolean;
	requiresParallelism: boolean;
	requiresArchitecture: boolean;
	risk: Risk;
}

export interface AnalyzeTaskInput {
	description: string;
	/** 用户显式给出的文件/路径线索，可选 */
	hintFiles?: string[];
	/** 已知期望改动的文件数，可选 */
	expectedFileCount?: number;
}

const BUG_WORDS = ["bug", "fix", "broken", "fails", "fail", "failure", "crash", "regression", "错误", "修复", "修好", "报错", "不对", "挂了"];

const FEATURE_WORDS = ["add", "implement", "support", "feature", "新增", "实现", "支持"];
const REFACTOR_WORDS = ["refactor", "cleanup", "rename", "extract", "重构", "整理"];
const RESEARCH_WORDS = ["investigate", "research", "explain", "why", "分析", "调研", "review", "审查", "只读"];
const LARGE_WORDS = ["architecture", "migrate", "all modules", "end-to-end", "整个", "全量", "跨模块"];

/**
 * 英文关键词必须按**词边界**匹配。
 *
 * 曾经用 `text.includes(word)`：任务是 `add()` 的符号写错了，结果因为 "add" 是 `FEATURE_WORDS`
 * 里的一个词，整个任务被判成 feature，进而选了 planning 而不是 systematic-debugging。
 * 同类问题还有 "address" 命中 "add"、"prefix" 命中 "fix"。
 *
 * 中文没法用词边界，继续 substring；带连字符/空格的短语也走 substring。
 */
function matcher(text: string) {
	const cache = new Map<string, RegExp>();
	return (words: string[]) =>
		words.some((word) => {
			if (!/^[a-z0-9][a-z0-9 ]*$/.test(word)) return text.includes(word);
			let pattern = cache.get(word);
			if (!pattern) {
				pattern = new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
				cache.set(word, pattern);
			}
			return pattern.test(text);
		});
}

export function analyzeTask(input: AnalyzeTaskInput): TaskAnalysis {
	const text = input.description.toLowerCase();
	const has = matcher(text);

	const type: TaskType = has(["只读", "read-only"]) ? "research" : has(BUG_WORDS)
		? "bugfix"
		: has(REFACTOR_WORDS)
			? "refactor"
			: has(FEATURE_WORDS)
				? "feature"
				: has(RESEARCH_WORDS)
					? "research"
					: "edit";

	const likelyFiles = input.hintFiles ?? [];
	const fileCount = input.expectedFileCount ?? likelyFiles.length;
	const crossModule = spansModules(likelyFiles);

	// 只按“要动多大范围”判复杂度，不按任务类型放大：改个 README typo 不该启动多 Agent。
	let complexity: Complexity = "small";
	if (has(LARGE_WORDS) || fileCount > 8) complexity = "large";
	else if (fileCount > 2 || crossModule) complexity = "medium";
	else if (fileCount === 0 && (type === "feature" || type === "refactor")) complexity = "medium";

	const risk: Risk =
		has(["auth", "token", "secret", "credential", "payment", "migration", "权限", "密钥", "支付"])
			? "high"
			: complexity === "small"
				? "low"
				: "medium";

	return {
		type,
		complexity,
		likelyFiles,
		requiresRepoExploration: complexity !== "small" || likelyFiles.length === 0,
		requiresParallelism: complexity === "large" || crossModule,
		requiresArchitecture: complexity === "large",
		risk,
	};
}

function spansModules(files: string[]): boolean {
	const modules = files.map(file => {
		const parts = file.replaceAll("\\", "/").split("/").filter(Boolean);
		if (parts[0] === "src") parts.shift();
		return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
	});
	return new Set(modules).size > 1;
}

/**
 * 复杂度 → 目标 DAG 形状。Planner 用它约束上限，避免小任务生成流水线。
 * 对应架构文档 §6.1 的规则表。
 */
export function pipelineFor(analysis: TaskAnalysis): AgentRolePlan[] {
	if (analysis.type === "research") return [{ role: "explorer", parallel: analysis.complexity === "large" ? 2 : 1 }, { role: "reviewer", parallel: 1 }];
	if (analysis.type === "edit" && analysis.complexity === "small") return [{ role: "implementer", parallel: 1 }];
	switch (analysis.complexity) {
		case "small":
			return [{ role: "implementer", parallel: 1 }];
		case "medium":
			return [
				{ role: "explorer", parallel: analysis.requiresParallelism ? 2 : 1 },
				{ role: "implementer", parallel: 1 },
				{ role: "tester", parallel: 1 },
				{ role: "reviewer", parallel: 1 },
			];
		case "large":
			return [
				{ role: "explorer", parallel: 3 },
				{ role: "architect", parallel: 1 },
				{ role: "implementer", parallel: 2 },
				{ role: "tester", parallel: 1 },
				{ role: "reviewer", parallel: 1 },
			];
	}
}

export interface AgentRolePlan {
	role: "explorer" | "architect" | "implementer" | "tester" | "reviewer";
	parallel: number;
}
