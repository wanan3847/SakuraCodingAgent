/**
 * 增量索引入口：扫描仓库 → parser → 解析导入 → test mapping → SymbolIndex。架构文档 §9.1。
 *
 * 扫描、ignore、大小限制是真实的；语言解析交给注入的 LanguageParser。
 * 两趟：先 parse 全部文件（导入边和测试边都需要完整文件集才能落到真实路径上），再建索引。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { atomicWrite } from "../storage/atomic.ts";
import { join, relative, sep } from "node:path";
import { DEFAULT_IGNORES, isIgnored } from "./retrieval.ts";
import { resolveImportEdges, type LanguageParser, type ParsedFile } from "./parser.ts";
import { mapTests } from "./test-mapper.ts";
import { SymbolIndex } from "./symbol-index.ts";
import {evaluateAction} from "../workspace/guard.ts";

export interface IndexOptions {
	root: string;
	parser: LanguageParser;
	ignores?: string[];
	maxIndexedFileSizeKb?: number;
	cache?: boolean;
	onFileRead?:(path:string)=>void;
}

export interface IndexResult {
	index: SymbolIndex;
	indexedFiles: number;
	skipped: string[];
	paths: string[];
	parsedFiles: number;
	reusedFiles: number;
	unresolvedCalls: number;
	coverage: string;
}

export async function indexRepository(options: IndexOptions): Promise<IndexResult> {
	const ignores = options.ignores ?? DEFAULT_IGNORES;
	const maxBytes = (options.maxIndexedFileSizeKb ?? 512) * 1024;
	const index = new SymbolIndex();
	const skipped: string[] = [];
	const parsed: ParsedFile[] = [];
  const sources:Array<{path:string;source:string;parsed:ParsedFile}>=[];
  const cachePath=join(options.root,".sakura","index-cache.json");
  type CacheEntry={hash:string;parsed:ParsedFile};
  let previous:Record<string,CacheEntry>={};
  if(options.cache!==false && options.parser.cacheKey !== undefined) try {const cache=JSON.parse(await readFile(cachePath,"utf8"));if(cache.version===2 && cache.parser===options.parser.cacheKey) previous=cache.files;} catch(error) {if((error as NodeJS.ErrnoException).code!=="ENOENT" && !(error instanceof SyntaxError)) throw error;}
  const next:Record<string,CacheEntry>={};let parsedFiles=0,reusedFiles=0;
  const parseFailures:string[]=[];

	async function walk(dir: string): Promise<void> {
		let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const absolute = join(dir, entry.name);
			const path = relative(options.root, absolute).split(sep).join("/");
			if (isIgnored(`${path}/`, ignores)) continue;

			if (entry.isDirectory()) {
				await walk(absolute);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!options.parser.extensions.some((extension) => path.endsWith(extension))) continue;
			if((await evaluateAction({workspacePath:options.root},{agentId:"repository-index",tool:"read",kind:"read",path:absolute})).type!=="allow") {skipped.push(path);continue;}

			const info = await stat(absolute);
			if (info.size > maxBytes) {
				skipped.push(path);
				continue;
			}
			const source=await readFile(absolute,"utf8"),hash=createHash("sha256").update(source).digest("hex");
      options.onFileRead?.(absolute);
      const cached=previous[path]?.hash===hash ? previous[path].parsed : undefined;
      let file:ParsedFile;
      try{file=cached ? structuredClone(cached) : options.parser.parse(path,source);}
      catch(error){skipped.push(path);parseFailures.push(`${path}: ${String(error).split('\n')[0]}`);continue;}
      if(cached) reusedFiles++;else parsedFiles++;
      next[path]={hash,parsed:structuredClone(file)};parsed.push(file);sources.push({path,source,parsed:file});
		}
	}

	await walk(options.root);

	resolveImportEdges(parsed, options.parser.extensions);
	for (const file of parsed) {
		for (const symbol of file.symbols) index.addSymbol({ ...symbol, file: file.path });
		for (const edge of file.edges) index.addEdge(edge);
	}
	for (const edge of mapTests(parsed)) index.addEdge(edge);
  const linked=options.parser.link?.(sources);
  for(const edge of linked?.edges ?? []) index.addEdge(edge);
  if(options.cache!==false && options.parser.cacheKey !== undefined) await atomicWrite(cachePath,JSON.stringify({version:2,parser:options.parser.cacheKey,files:next}));

	return { index, indexedFiles: parsed.length, skipped, paths:parsed.map(file=>file.path), parsedFiles, reusedFiles, unresolvedCalls:linked?.unresolvedCalls ?? 0, coverage:[linked?.coverage ?? "Parser has no reference/call analysis; empty results do not establish absence.",...(parseFailures.length?[`Parse failures excluded: ${parseFailures.join('; ')}`]:[])].join(' ') };
}
