import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {indexRepository} from "../../src/repo-intelligence/indexer.ts";
import {createTypeScriptParser} from "../../src/repo-intelligence/parser.ts";
import {buildRepositoryContext,packContext} from "../../src/repo-intelligence/context-pack.ts";

test("compiler resolves cross-file aliases, calls and references; incremental updates equal full indexing",async(t)=>{
 const cwd=await mkdtemp(join(tmpdir(),"sakura-index-"));t.after(()=>rm(cwd,{recursive:true,force:true}));
 await writeFile(join(cwd,"a.ts"),"export function refresh(){return 1;}\n");
 await writeFile(join(cwd,"b.ts"),"import {refresh as renew} from './a.js';\nexport function consume(){return renew();}\nexport function unknown(fn:any){return fn();}\n");
 await writeFile(join(cwd,"b.test.ts"),"import {consume} from './b.js';\nexport function test(){return consume();}\n");
 const first=await indexRepository({root:cwd,parser:createTypeScriptParser()});
 assert.equal(first.parsedFiles,3);assert.equal(first.reusedFiles,0);
 assert.deepEqual(first.index.findCallers("a.ts#refresh"),["b.ts#consume"]);
 assert.ok(first.index.findReferences("a.ts#refresh").some(edge=>edge.kind==="REFERENCES"));
 assert.equal(first.unresolvedCalls,1);assert.match(first.coverage,/dynamic/);
 const second=await indexRepository({root:cwd,parser:createTypeScriptParser()});assert.equal(second.parsedFiles,0);assert.equal(second.reusedFiles,3);
 await writeFile(join(cwd,"a.ts"),"export function refresh(){return 2;}\nexport function added(){return 3;}\n");
 const incremental=await indexRepository({root:cwd,parser:createTypeScriptParser()}),full=await indexRepository({root:cwd,parser:createTypeScriptParser(),cache:false});
 assert.equal(incremental.parsedFiles,1);assert.equal(incremental.reusedFiles,2);
 assert.deepEqual(incremental.index.allSymbols(),full.index.allSymbols());assert.deepEqual(incremental.index.findReferences("a.ts#refresh"),full.index.findReferences("a.ts#refresh"));
 const built=await buildRepositoryContext({cwd,task:"fix refresh",files:["a.ts"],topK:1,maxFileSizeKb:512,budget:1024});
 assert.equal(built.pack.selected.length,1);assert.equal(built.pack.selected[0].path,"a.ts");assert.match(built.pack.text,/a.ts:1-/);
 assert.ok(built.pack.estimatedTokens<=built.pack.budget);
});

test("context budget trims low ranked evidence, keeps line provenance and deduplicates",()=>{
 const items=[{source:"code",path:"a.ts",startLine:1,endLine:100,text:"你好代码\n".repeat(100),weight:100,estimatedTokens:0},{source:"experience",text:"low relevance",weight:1,estimatedTokens:0}];
 const small=packContext([...items,items[0]],256),large=packContext(items,4096);
 assert.ok(small.estimatedTokens<=256);assert.ok(large.estimatedTokens>small.estimatedTokens);
 assert.ok(small.truncated.some(item=>item.reason==="duplicate"));assert.ok(small.selected[0].endLine!<100);assert.equal(small.selected[0].startLine,1);
 assert.ok(small.truncated.some(item=>item.source==="experience"));
});

test("repository read evidence includes indexing beyond the selected pack and excludes protected source files",async(t)=>{
 const cwd=await mkdtemp(join(tmpdir(),"sakura-index-policy-"));t.after(()=>rm(cwd,{recursive:true,force:true}));
 await writeFile(join(cwd,"a.ts"),"export const a=1;");await writeFile(join(cwd,"b.ts"),"export const b=2;");
 await writeFile(join(cwd,"credentials.ts"),"export const PRIVATE_SECRET_MARKER='secret';");
 const reads=new Set<string>();
 const built=await buildRepositoryContext({cwd,task:"a",files:["a.ts"],topK:1,maxFileSizeKb:512,budget:1024,onFileRead:path=>reads.add(path)});
 assert.deepEqual([...reads].sort(),[join(cwd,"a.ts"),join(cwd,"b.ts")]);assert.equal(built.index.indexedFiles,2);
 assert.ok(built.index.skipped.includes("credentials.ts"));assert.equal(built.pack.selected.length,1);assert.doesNotMatch(built.pack.text,/PRIVATE_SECRET_MARKER/);
});
