import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createTypeScriptParser,type LanguageParser,type ParsedFile} from './parser.ts';
/** AST adapters only; unsupported languages remain available through native read/grep/MCP. */
export function createRepositoryParser():LanguageParser{
 const typescript=createTypeScriptParser();
 let python=false;try{execFileSync('python3',['-I','-S','--version'],{stdio:'ignore',timeout:2000});python=true;}catch{}
 const script=fileURLToPath(new URL('./python-ast.py',import.meta.url));
 return {
  cacheKey:`${typescript.cacheKey}-python-ast-v1-${python}`,
  extensions:[...typescript.extensions,...(python?['.py']:[])],
  parse(path,source):ParsedFile{
   if(!path.endsWith('.py'))return typescript.parse(path,source);
   return JSON.parse(execFileSync('python3',['-I','-S',script],{input:JSON.stringify({path,source}),encoding:'utf8',stdio:'pipe',timeout:5000,maxBuffer:8*1024*1024}));
  },
  link(files){const linked=typescript.link!(files.filter(file=>!file.path.endsWith('.py')));return {...linked,coverage:`${linked.coverage} Python: ${python?'AST definitions and relative imports only; no reference/call inference':'python3 unavailable; Python files excluded'}. Other languages: read/grep or explicitly configured MCP language server.`};},
 };
}
