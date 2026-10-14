/**
 * Repo Graph 的存储与查询。架构文档 §9.2/§9.3。
 *
 * 这里只做图，不解析语言：文件/符号/测试的节点与边由 parser 填充。
 * 已经是可用实现，纯内存、可单测。
 */

export type SymbolKind = "function" | "class" | "method" | "variable" | "interface";

export interface SymbolNode {
	id: string;
	name: string;
	kind: SymbolKind;
	file: string;
	startLine: number;
	endLine: number;
}

export type RepoEdgeKind =
	| "FILE_CONTAINS_SYMBOL"
	| "IMPORTS"
	| "REFERENCES"
	| "CALLS"
	| "TESTS"
	| "DEPENDS_ON"
	| "CHANGED_WITH";

export interface RepoEdge {
	kind: RepoEdgeKind;
	from: string;
	to: string;
}

export class SymbolIndex {
	private symbols = new Map<string, SymbolNode>();
	private edges: RepoEdge[] = [];
	private outgoing = new Map<string, RepoEdge[]>();
	private incoming = new Map<string, RepoEdge[]>();

	addSymbol(symbol: SymbolNode): void {
		this.symbols.set(symbol.id, symbol);
		this.addEdge({ kind: "FILE_CONTAINS_SYMBOL", from: symbol.file, to: symbol.id });
	}

	addEdge(edge: RepoEdge): void {
		this.edges.push(edge);
		this.outgoing.set(edge.from, [...(this.outgoing.get(edge.from) ?? []), edge]);
		this.incoming.set(edge.to, [...(this.incoming.get(edge.to) ?? []), edge]);
	}

	findSymbol(name: string): SymbolNode[] {
		return [...this.symbols.values()].filter((symbol) => symbol.name === name);
	}

	findSymbolById(id: string): SymbolNode | undefined {
		return this.symbols.get(id);
	}

	findReferences(symbolId: string): RepoEdge[] {
		return this.incoming.get(symbolId)?.filter((edge) => edge.kind === "REFERENCES" || edge.kind === "CALLS") ?? [];
	}

	findCallers(symbolId: string): string[] {
		return this.incoming.get(symbolId)?.filter((edge) => edge.kind === "CALLS").map((edge) => edge.from) ?? [];
	}

	findCallees(symbolId: string): string[] {
		return this.outgoing.get(symbolId)?.filter((edge) => edge.kind === "CALLS").map((edge) => edge.to) ?? [];
	}

	getDependencies(id: string): string[] {
		return this.outgoing.get(id)?.filter((edge) => edge.kind === "IMPORTS" || edge.kind === "DEPENDS_ON").map((edge) => edge.to) ?? [];
	}

	getDependents(id: string): string[] {
		return this.incoming.get(id)?.filter((edge) => edge.kind === "IMPORTS" || edge.kind === "DEPENDS_ON").map((edge) => edge.from) ?? [];
	}

	findRelatedTests(id: string): string[] {
		return this.incoming.get(id)?.filter((edge) => edge.kind === "TESTS").map((edge) => edge.from) ?? [];
	}

	files(): string[] {
		return [...new Set([...this.symbols.values()].map((symbol) => symbol.file))];
	}

	allSymbols(): SymbolNode[] {
		return [...this.symbols.values()];
	}

	/** 按名字子串搜符号（大小写不敏）。架构路线 §9.3 的 `searchRelevantCode` 的确定性基底。 */
	searchSymbols(query: string, limit = 50): SymbolNode[] {
		const needle = query.toLowerCase();
		return this.allSymbols()
			.filter((symbol) => symbol.name.toLowerCase().includes(needle) || symbol.file.toLowerCase().includes(needle))
			.sort((a, b) => a.name.length - b.name.length)
			.slice(0, limit);
	}

	size(): { symbols: number; edges: number } {
		return { symbols: this.symbols.size, edges: this.edges.length };
	}
}
