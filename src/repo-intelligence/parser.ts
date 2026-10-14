/**
 * 语言解析器边界 + TypeScript/JavaScript 实现（W5-02）。架构文档 §9.1 / §29 风险 1。
 *
 * 用 TypeScript compiler API 做 AST，不用正则。产出 Symbol + IMPORTS 边，再用 Program/checker 链接 REFERENCES/CALLS
 * （架构文档 §29 的降级路径：先 Symbol + Import + Test Mapping，不做完整调用图）。
 * 无法静态解析的调用单独计数，供读取/搜索降级。
 */

import ts from "typescript";
import type { RepoEdge, SymbolNode } from "./symbol-index.ts";

export interface ParsedFile {
	path: string;
	symbols: Array<Omit<SymbolNode, "file">>;
	edges: RepoEdge[];
}

export interface LanguageParser {
	cacheKey?:string;
	/** 支持的文件扩展名，含点：.ts / .tsx / .js */
	extensions: string[];
	parse(path: string, source: string): ParsedFile;
	link?(files: Array<{path:string;source:string;parsed:ParsedFile}>): {edges:RepoEdge[]; unresolvedCalls:number; coverage:string};
}

export const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function scriptKindOf(path: string): ts.ScriptKind {
	if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
	if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
	if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return ts.ScriptKind.JS;
	return ts.ScriptKind.TS;
}

/** 把 `./a/../b` 归一成 `b`（仓库相对、posix 分隔）。不做磁盘探测。 */
export function resolveRelative(fromPath: string, specifier: string): string {
	const parts = [...fromPath.split("/").slice(0, -1), ...specifier.split("/")];
	const out: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return out.join("/");
}

/**
 * 把 IMPORTS 边的 `to` 指到真实文件上。
 *
 * 解析器只能做路径归一（`./a`），猜不到扩展名和 index 文件，所以这一步需要已知文件集。
 * 不做 tsconfig paths / 包导出解析——ponytail: 只覆盖相对导入 + 扩展名/index，
 * 遇到 monorepo alias 时依赖 `pi` 的 grep/find 兜底。
 */
export function resolveImportEdges(parsed: ParsedFile[], extensions: string[]): void {
	const files = new Set(parsed.map((file) => file.path));
	const candidates = (target: string): string[] => [
		target,
		...extensions.map((extension) => `${target}${extension}`),
		...extensions.map((extension) => `${target.replace(/\.(js|mjs|cjs)$/, "")}${extension}`),
		...extensions.map((extension) => `${target}/index${extension}`),
    `${target}/__init__.py`,
	];

	for (const file of parsed) {
		for (const edge of file.edges) {
			if (edge.kind !== "IMPORTS") continue;
			const hit = candidates(edge.to).find((candidate) => files.has(candidate));
			if (hit) edge.to = hit;
		}
	}
}

export function createTypeScriptParser(): LanguageParser {
	return {
		extensions: TYPESCRIPT_EXTENSIONS,
    cacheKey:`typescript-${ts.version}-symbols-v2`,
		link: linkTypeScript,
		parse(path, source) {
			const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, scriptKindOf(path));
			const symbols: Array<Omit<SymbolNode, "file">> = [];
			const edges: RepoEdge[] = [];

			const line = (position: number) => file.getLineAndCharacterOfPosition(position).line + 1;
			const add = (name: string, kind: SymbolNode["kind"], node: ts.Node) => {
				symbols.push({ id: `${path}#${name}`, name, kind, startLine: line(node.getStart(file)), endLine: line(node.getEnd()) });
			};
			const addModule = (node: ts.ImportDeclaration | ts.ExportDeclaration) => {
				if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) return;
				const specifier = node.moduleSpecifier.text;
				// 只跟踪仓库内的相对导入；裸包名不建边（不是本仓库的结构）
				if (!specifier.startsWith(".")) return;
				edges.push({ kind: "IMPORTS", from: path, to: resolveRelative(path, specifier) });
			};

			for (const statement of file.statements) {
				if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
					addModule(statement);
					continue;
				}
				if (ts.isFunctionDeclaration(statement) && statement.name) {
					add(statement.name.text, "function", statement);
					continue;
				}
				if (ts.isClassDeclaration(statement) && statement.name) {
					add(statement.name.text, "class", statement);
					for (const member of statement.members) {
						if ((ts.isMethodDeclaration(member) || ts.isGetAccessor(member) || ts.isSetAccessor(member)) && member.name && ts.isIdentifier(member.name)) {
							add(`${statement.name.text}.${member.name.text}`, "method", member);
						}
					}
					continue;
				}
				if (ts.isInterfaceDeclaration(statement)) {
					add(statement.name.text, "interface", statement);
					continue;
				}
				if (ts.isTypeAliasDeclaration(statement)) {
					add(statement.name.text, "interface", statement);
					continue;
				}
				if (ts.isVariableStatement(statement)) {
					for (const declaration of statement.declarationList.declarations) {
						if (ts.isIdentifier(declaration.name)) add(declaration.name.text, "variable", statement);
					}
				}
			}

			return { path, symbols, edges };
		},
	};
}

/** Compiler symbols resolve aliases and cross-file calls; dynamic calls remain explicit unknowns. */
function linkTypeScript(files:Array<{path:string;source:string;parsed:ParsedFile}>) {
  const root="/sakura-index/";
  const sources=new Map(files.map(file=>[root+file.path,file]));
  const options:ts.CompilerOptions={target:ts.ScriptTarget.Latest,module:ts.ModuleKind.ESNext,allowJs:true,noLib:true,jsx:ts.JsxEmit.Preserve};
  const host:ts.CompilerHost={
    getSourceFile(path){const file=sources.get(path);return file ? ts.createSourceFile(path,file.source,ts.ScriptTarget.Latest,true,scriptKindOf(path)) : undefined;},
    getDefaultLibFileName:()=>"",writeFile(){},getCurrentDirectory:()=>root,getDirectories:()=>[],fileExists:path=>sources.has(path),
    readFile:path=>sources.get(path)?.source,getCanonicalFileName:path=>path,useCaseSensitiveFileNames:()=>true,getNewLine:()=>"\n",
    resolveModuleNames(names,containing){return names.map(name=>{
      if(!name.startsWith(".")) return undefined;
      const target=resolveRelative(containing.slice(root.length),name);
      const candidates=[target,...TYPESCRIPT_EXTENSIONS.flatMap(extension=>[target+extension,target.replace(/\.(js|mjs|cjs)$/,"")+extension,target+"/index"+extension])];
      const match=candidates.find(path=>sources.has(root+path));
      return match ? {resolvedFileName:root+match,isExternalLibraryImport:false} : undefined;
    });},
  };
  const program=ts.createProgram([...sources.keys()],options,host),checker=program.getTypeChecker();
  const declarations=new Map<ts.Node,string>();
  for(const source of program.getSourceFiles()) {
    const file=sources.get(source.fileName)!;
    function visit(node:ts.Node) {
      const line=source.getLineAndCharacterOfPosition(node.getStart(source)).line+1;
      const named=node as ts.NamedDeclaration;
      if(named.name && ts.isIdentifier(named.name) && (ts.isFunctionDeclaration(node)||ts.isClassDeclaration(node)||ts.isInterfaceDeclaration(node)||ts.isTypeAliasDeclaration(node)||ts.isVariableDeclaration(node)||ts.isMethodDeclaration(node)||ts.isGetAccessor(node)||ts.isSetAccessor(node))) {
        const name=ts.isMethodDeclaration(node)||ts.isGetAccessor(node)||ts.isSetAccessor(node) ? `${(node.parent as ts.ClassDeclaration).name?.text}.${named.name.text}` : named.name.text;
        const symbol=file.parsed.symbols.find(symbol=>symbol.name===name && symbol.startLine<=line && symbol.endLine>=line);
        if(symbol) declarations.set(node,symbol.id);
      }
      ts.forEachChild(node,visit);
    } visit(source);
  }
  const edges:RepoEdge[]=[];const seen=new Set<string>();let unresolvedCalls=0;
  const resolveSymbol=(node:ts.Node)=>{let symbol=checker.getSymbolAtLocation(node);if(symbol && symbol.flags & ts.SymbolFlags.Alias) symbol=checker.getAliasedSymbol(symbol);return symbol?.declarations?.map(declaration=>declarations.get(declaration)).find(Boolean);};
  const add=(kind:RepoEdge["kind"],from:string,to:string)=>{const key=`${kind}:${from}:${to}`;if(!seen.has(key)){seen.add(key);edges.push({kind,from,to});}};
  for(const source of program.getSourceFiles()) {
    const file=sources.get(source.fileName)!;
    function visit(node:ts.Node,owner:string) {
      owner=declarations.get(node) ?? owner;
      if(ts.isCallExpression(node)||ts.isNewExpression(node)) {
        const expression=ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        const target=resolveSymbol(expression);
        if(target) add("CALLS",owner,target);else unresolvedCalls++;
      }
      if(ts.isIdentifier(node)) {
        const parent=node.parent;
        const declarationName=declarations.has(parent) && (parent as ts.NamedDeclaration).name===node;
        const importName=ts.isImportSpecifier(parent)||ts.isImportClause(parent)||ts.isNamespaceImport(parent);
        if(!declarationName && !importName) {const target=resolveSymbol(node);if(target) add("REFERENCES",owner,target);}
      }
      ts.forEachChild(node,child=>visit(child,owner));
    } visit(source,file.path);
  }
  return {edges,unresolvedCalls,coverage:"Compiler-resolved indexed TS/JS symbols; external packages, dynamic dispatch and unresolved aliases require read/grep fallback."};
}
