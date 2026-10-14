/**
 * Test Mapping（W5-06）。架构文档 §9.1/§9.3：`findRelatedTests` 是 Repo Intelligence 的
 * 核心查询之一，没有它 Planner 就只能靠猜哪些测试会挂。
 *
 * 只做文件名约定（.test/.spec、__tests__、tests/），不做动态分析。
 * 边方向固定为 TESTS: from=测试文件 → to=被测文件，和 SymbolIndex.findRelatedTests 的
 * incoming 查询一致。
 *
 * ponytail: 先按同路径主干匹配，再不唯一才退回“仓库内唯一同名文件”。
 * 多个同名候选时宁可不建边，也不猜错——错的 TESTS 边会直接污染 Impact Analysis。
 */

import type { ParsedFile } from "./parser.ts";
import type { RepoEdge } from "./symbol-index.ts";

export function isTestFile(path: string): boolean {
	const stem = (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "");
	return (
		/(\.test|\.spec|-test|_test)$/.test(stem) ||
		path.includes("/__tests__/") ||
		path.startsWith("tests/") ||
		path.startsWith("test/")
	);
}

/**
 * `src/a/foo.test.ts` → `src/a/foo.ts`。
 *
 * `tests/` / `test/` / `__tests__/` 这种集中式测试树不镜像源码目录（`tests/unit/scheduler.test.ts`
 * 对应的可能是 `src/orchestrator/scheduler.ts`），所以只留文件名，交给 mapTests 的唯一同名回退。
 */
export function sourceStem(path: string): string {
	const parts = path.split("/");
	const base = parts.pop() ?? path;
	const extension = /\.[^.]+$/.exec(base)?.[0] ?? "";
	const stem = base.slice(0, base.length - extension.length).replace(/(\.test|\.spec|-test|_test)$/, "");
	const leaf = `${stem}${extension}`;

	const centralised = path.startsWith("tests/") || path.startsWith("test/") || parts.includes("__tests__") || parts.includes("tests");
	return centralised ? leaf : [...parts, leaf].join("/");
}

export function mapTests(parsed: ParsedFile[]): RepoEdge[] {
	const files = new Set(parsed.map((file) => file.path));
	const resolve = (stem: string): string | undefined => {
		if (files.has(stem)) return stem;
		const suffix = `/${stem}`;
		const matches = [...files].filter((file) => file.endsWith(suffix));
		return matches.length === 1 ? matches[0] : undefined;
	};

	const edges: RepoEdge[] = [];
	for (const file of parsed) {
		if (!isTestFile(file.path)) continue;
		const target = resolve(sourceStem(file.path));
		if (target && target !== file.path) edges.push({ kind: "TESTS", from: file.path, to: target });
	}
	return edges;
}
