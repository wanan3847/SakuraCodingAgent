/**
 * 词面匹配的共用工具。Experience 检索和 Skill 路由都用它。
 *
 * 两处各写一份 tokenize 就会出现“经验检索和技能路由对同一个任务切出不同的词”，
 * 排查时没人看得出为什么。所以放在这里一份。
 *
 * ponytail: 就是 substring 词表匹配，没有 stemming、没有同义词、没有 embedding。
 * 架构路线 §9.4 要求第一版不上向量库；等 Benchmark 证明词面匹配不够再加。
 */

/**
 * 常见英文虚词。不滤掉它们的话，技能描述里的 "the / it / so / and" 会命中任何任务，
 * 每个技能的分数都被抬到同一个水平，路由就等于随机（实测踩到过）。
 */
const STOPWORDS = new Set([
	"the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "her", "was", "one", "our",
	"out", "day", "get", "has", "him", "his", "how", "its", "may", "new", "now", "old", "see", "two", "way",
	"who", "boy", "did", "use", "with", "that", "this", "from", "they", "will", "would", "there", "their",
	"what", "about", "into", "than", "then", "them", "these", "those", "when", "your", "been", "have", "its",
	"it", "is", "as", "at", "be", "by", "do", "if", "in", "of", "on", "or", "so", "to", "up", "we", "an",
]);

export function tokenize(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9\u4e00-\u9fa5_]+/)
			.filter((token) => token.length > 1 && !STOPWORDS.has(token)),
	);
}

/** 关键词重叠计分：返回命中的词和分数。 */
export function overlapScore(query: Set<string>, haystackText: string): { score: number; matched: string[] } {
	const haystack = tokenize(haystackText);
	const matched: string[] = [];
	for (const token of query) if (haystack.has(token)) matched.push(token);
	return { score: matched.length, matched };
}
