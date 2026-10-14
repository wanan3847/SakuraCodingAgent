/**
 * Impact Analysis MVP（架构路线 §9.3 的 `analyzeImpact`，W5-10）。
 *
 * 存在的理由：第一版的 IMPORTS 边是**文件级**的，符号级只有 FILE_CONTAINS_SYMBOL。
 * 所以 `getDependents(symbolId)` 永远是空的——直接对符号查影响面会静默返回 []，
 * 看起来像“没有东西依赖它”，比报错更危险。这里把符号解析回它所在的文件再查。
 *
 * ponytail: 只有文件级传递闭包，没有调用图，会把“同文件里无关的符号”也算进来。
 * 偏保守（多报而不是漏报），调用图进 W5+ 之后再收紧。
 */

import type { SymbolIndex, SymbolNode } from "./symbol-index.ts";

export interface ImpactReport {
	target: string;
	/** 名字精确匹配到的符号；target 是文件路径时为空 */
	symbols: SymbolNode[];
	/** 符号所在的文件（或 target 本身就是文件） */
	files: string[];
	/** 直接 + 传递依赖这些文件的其他文件 */
	dependents: string[];
	relatedTests: string[];
}

export function analyzeImpact(index: SymbolIndex, target: string): ImpactReport {
	const symbols = index.findSymbol(target);
	const known = new Set(index.files());
	const files = symbols.length ? [...new Set(symbols.map((symbol) => symbol.file))] : known.has(target) ? [target] : [];

	const dependents = new Set<string>();
	const queue = files.flatMap((file) => index.getDependents(file));
	while (queue.length) {
		const current = queue.shift() as string;
		if (dependents.has(current) || files.includes(current)) continue;
		dependents.add(current);
		queue.push(...index.getDependents(current));
	}

	const relatedTests = new Set<string>();
	for (const file of files) for (const test of index.findRelatedTests(file)) relatedTests.add(test);
	for (const symbol of symbols) for (const test of index.findRelatedTests(symbol.id)) relatedTests.add(test);

	return { target, symbols, files, dependents: [...dependents], relatedTests: [...relatedTests] };
}

export function formatImpact(report: ImpactReport): string {
	const lines = [`impact of ${report.target}`];
	if (!report.symbols.length && !report.files.length) return `${lines[0]}: 索引里没有这个名字，也不是已知文件路径。`;
	if (report.symbols.length) {
		lines.push(
			`definitions:`,
			...report.symbols.map((symbol) => `- ${symbol.file}:${symbol.startLine} ${symbol.kind} ${symbol.name}`),
		);
	}
	lines.push(
		`dependents (${report.dependents.length}, file-level imports):`,
		...(report.dependents.length ? report.dependents.map((file) => `- ${file}`) : ["- (none)"]),
		`related tests (${report.relatedTests.length}):`,
		...(report.relatedTests.length ? report.relatedTests.map((file) => `- ${file}`) : ["- (none)"]),
	);
	return lines.join("\n");
}
