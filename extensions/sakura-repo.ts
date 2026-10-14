import {registerSakuraCommand} from '../src/ui/commands.ts';
/**
 * 插件 3/5 —— Repository Intelligence（架构路线 §9 / §31.3）
 *
 * 把 SymbolIndex 的查询接口暴露给模型：找定义、找引用、找相关测试、算影响面。
 * 目的是减少无关文件读取，不是替代 Pi 的 context compaction（架构路线 §9 开头那段区分）。
 *
 * 按内容 hash 复用未变文件，查询时核对变更，不保留过期内存结果。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { analyzeImpact, createRepositoryParser, formatImpact, indexRepository, loadConfig, type IndexResult } from "../src/index.ts";

async function indexPath(cwd:string):Promise<IndexResult> {
  const cfg=await loadConfig(cwd);
  return indexRepository({root:cwd,parser:createRepositoryParser(),maxIndexedFileSizeKb:cfg.repository.maxIndexedFileSizeKb});
}

/**
 * 索引没命中时的出口（复用指南 §8.3：Pi 的 read/bash 是降级探索手段）。
 *
 * 关键是把降级路径**明确写出来**。只说“没找到”会让人以为仓库里真的没有，
 * 而实际上可能只是索引不覆盖（非 TS/JS、超过大小上限、或根本没建出来）。
 */
function miss(target: string, reason: string): string {
	return `${reason}\n\n降级路径：sakura_repo 只索引 TypeScript/JavaScript 及确定的符号调用/引用；动态调用和外部包未完全覆盖。用内置的 grep / find / read 直接找 ${target ? `"${target}"` : "目标"}，不要因为这里返回空就断定它不存在。`;
}

function symbolLines(result: IndexResult, name: string): string {
	const symbols = result.index.findSymbol(name);
	if (!symbols.length) return miss(name, `索引里没有名为 "${name}" 的符号。`);
	return symbols.map((symbol) => `${symbol.file}:${symbol.startLine}-${symbol.endLine} ${symbol.kind} ${symbol.name}`).join("\n");
}

async function dispatch(action: string, target: string, cwd: string): Promise<string> {
	const result = await indexPath(cwd);

	switch (action) {
		case "index": {
			const { symbols, edges } = result.index.size();
			const lines = [
				`indexed ${result.indexedFiles} files, ${symbols} symbols, ${edges} edges`,
				`skipped (too large): ${result.skipped.length}`,
        `parsed: ${result.parsedFiles}; reused: ${result.reusedFiles}; unresolved calls: ${result.unresolvedCalls}`,
        result.coverage,
				`files with symbols: ${result.index.files().length}`,
			];
			// 只支持 TS/JS，别的语言仓库要在这里说清楚，否则用户会以为索引坏了
			if (!result.indexedFiles) lines.push(miss(target, "索引为空。"));
			return lines.join("\n");
		}
		case "symbol":
			return result.indexedFiles === 0
				? miss(target, "索引是空的——这个目录里没有 TypeScript/JavaScript 文件，或者它们都被 ignore / 超过大小上限了。")
				: symbolLines(result, target);
		case "references": {
			const symbol = result.index.findSymbol(target)[0];
			if (!symbol) return `没有名为 "${target}" 的符号。`;
			const edges = result.index.findReferences(symbol.id);
			return edges.length ? edges.map((edge) => `${edge.from} → ${edge.to} (${edge.kind})`).join("\n") : `"${target}" 没有已解析引用边；动态/外部调用仍需 read/grep 核对。`;
		}
		case "dependencies": {
			// 和 impact 一样：IMPORTS 边是文件级的，先解析符号所在的文件
			const files = analyzeImpact(result.index, target).files;
			const deps = [...new Set(files.flatMap((file) => result.index.getDependencies(file)))];
			return deps.length ? deps.join("\n") : miss(target, `${target} 没有出边依赖（第一版只建相对导入的 IMPORTS 边，不跟踪裸包名）。`);
		}
		case "tests": {
			const tests = analyzeImpact(result.index, target).relatedTests;
			return tests.length ? tests.join("\n") : miss(target, `没找到 ${target} 的相关测试（只按文件名约定推断，不做动态分析）。`);
		}
		case "impact": {
			const report = analyzeImpact(result.index, target);
			if (!report.symbols.length && !report.files.length) return miss(target, formatImpact(report));
			return formatImpact(report);
		}
		case "search": {
			const hits = result.index.searchSymbols(target);
			return hits.length
				? hits.map((symbol) => `${symbol.file}:${symbol.startLine} ${symbol.kind} ${symbol.name}`).join("\n")
				: miss(target, `没有符号或文件名匹配 "${target}"。`);
		}
		default:
			return `unknown action "${action}"`;
	}
}

export default function sakuraRepo(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "sakura_repo",
		label: "Sakura Repo",
		description:
			"Query the repository graph: index stats, symbol definitions, import dependencies, related tests, and impact analysis.",
		promptSnippet: "Query Sakura's repository graph (symbols, deps, tests, impact)",
		promptGuidelines: [
			"Use sakura_repo with action=impact before editing a shared symbol, and action=tests to find which tests to run.",
			"sakura_repo only indexes TypeScript/JavaScript and only records the first version's IMPORT + TESTS edges; if it returns nothing, fall back to grep.",
		],
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("index"),
					Type.Literal("symbol"),
					Type.Literal("references"),
					Type.Literal("dependencies"),
					Type.Literal("tests"),
					Type.Literal("impact"),
					Type.Literal("search"),
				],
				{ description: "Which query to run" },
			),
			target: Type.Optional(Type.String({ description: "Symbol name, file path, or search keyword (not needed for index)" })),
		}),
		async execute(_toolCallId, params, _signal, _update, ctx) {
			const text = await dispatch(params.action, params.target ?? "", ctx.cwd);
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	registerSakuraCommand(pi,"sakura-repo", {
		description: "Query the repo graph: /sakura-repo <action> [target]  (action: index|symbol|references|dependencies|tests|impact|search)",
		async handler(args, ctx) {
			const [action = "index", ...rest] = args.trim().split(/\s+/);
			ctx.ui.notify(await dispatch(action, rest.join(" "), ctx.cwd), "info");
		},
	});
}
