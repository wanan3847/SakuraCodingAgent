import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {prepareFixtureJudge} from "../../benchmarks/runners/fixture-judge.ts";
import task from "../../benchmarks/tasks/auth-refresh.json" with {type:"json"};
test("fixed benchmark checks cannot be bypassed by editing scripts, scenarios, tests or TS configuration",async(t)=>{
 const cwd=await mkdtemp(join(tmpdir(),"sakura-judge-contract-"));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const exec=promisify(execFile);await exec("git",["clone","-q",new URL("../../benchmarks/fixtures/token-refresh.bundle",import.meta.url).pathname,cwd]);await exec("git",["checkout","-q","--detach",task.repo.commit],{cwd});
 const judge=await prepareFixtureJudge(cwd,task.id);t.after(judge.dispose);assert.equal((await judge.run()).passed,false);
 await writeFile(join(cwd,"scenario.txt"),"read-only-review\n");await writeFile(join(cwd,"tests","check.mjs"),"console.log('fake pass');");await writeFile(join(cwd,"tsconfig.json"),"{}");await writeFile(join(cwd,"package.json"),JSON.stringify({type:"module",scripts:{test:"echo pass",typecheck:"echo pass"}}));
 assert.equal((await judge.run()).passed,false);
 await writeFile(join(cwd,"src","auth","auth-service.ts"),"import type {Token} from './token-service.ts';export function refresh(current:Token,next:Token){return next;}export function canLogin(n:number){return n<3;}\n");
 assert.equal((await judge.run()).passed,true);
});
