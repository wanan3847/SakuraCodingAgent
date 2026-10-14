import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTaskGraph, taskNode } from "../../src/planning/schemas.ts";
import { savePlan } from "../../src/planning/plan-store.ts";
import { runSakuraTaskOnce } from "../../src/run.ts";
import { loadRunState } from "../../src/runtime/run-state.ts";
import { createShellCommandRunner } from "../../src/verification/test-runner.ts";
import {mergeConfig} from "../../src/config.ts";
const exec=promisify(execFile);
const git=async(cwd:string,...args:string[])=>(await exec("git",args,{cwd})).stdout;
async function repository(t:TestContext){
 const cwd=await mkdtemp(join(tmpdir(),"sakura-control-"));t.after(()=>rm(cwd,{recursive:true,force:true}));
 await git(cwd,"init","-q");await writeFile(join(cwd,"base.txt"),"base\n");
 await writeFile(join(cwd,"package.json"),JSON.stringify({scripts:{test:'node -e "process.exit(0)"'}}));
 await writeFile(join(cwd,"sakura.config.yaml"),"policy:\n  network: allow\n");
 await git(cwd,"add","-A");await git(cwd,"-c","user.name=test","-c","user.email=test@example.invalid","commit","-qm","base");return cwd;
}

test("whole run cancels scheduling, saves partial changes and resumes only unfinished nodes",async(t)=>{
 const cwd=await repository(t);const controller=new AbortController();
 const graph=createTaskGraph({id:"recovery",rootTask:"implement three changes",nodes:["first","second","third"].map((id,index)=>taskNode({id,title:id,description:id,role:"implementer",dependencies:index?["first","second"].slice(index-1,index):[],writeScope:[`${id}.txt`],priority:1}))});
 const saved=await savePlan(cwd,graph);const firstSeen:string[]=[];
 const initial=await runSakuraTaskOnce({cwd,task:graph.rootTask,planPath:saved.path,signal:controller.signal,
 runner:{async run(input){
  firstSeen.push(input.task.id);await writeFile(join(input.workspacePath,`${input.task.id}.txt`),"partial\n");
  if(input.task.id==="second") controller.abort();
  return{status:"success",summary:"created",changedFiles:[`${input.task.id}.txt`],evidence:[]};
 }} });
 assert.deepEqual(firstSeen,["first","second"]);assert.equal(initial.executionStatus,"cancelled");assert.equal(initial.completed,false);
 assert.ok(initial.artifactPath);const checkpoint=await loadRunState(initial.traceDir);
 assert.equal(checkpoint.phase,"cancelled");assert.equal(checkpoint.tasks.first.status,"succeeded");assert.equal(checkpoint.tasks.second.status,"cancelled");
 assert.ok(checkpoint.workspaces[initial.runId].baseCommit);
 const resumedSeen:string[]=[];
 const resumed=await runSakuraTaskOnce({cwd,task:graph.rootTask,resumeRunId:initial.runId,runner:{async run(input){
  resumedSeen.push(input.task.id);
  assert.equal(await readFile(join(input.workspacePath,"first.txt"),"utf8"),"partial\n");
  await writeFile(join(input.workspacePath,`${input.task.id}.txt`),"finished\n");
  return{status:"success",summary:"finished",changedFiles:[`${input.task.id}.txt`],evidence:[]};
 }}});
 assert.equal(resumed.completed,true);assert.deepEqual(resumedSeen,["second","third"]);assert.equal(resumed.result?.graph.version,2);
 assert.match(resumed.diff,/first.txt/);assert.match(resumed.diff,/third.txt/);
 await assert.rejects(readFile(join(cwd,"first.txt")),/ENOENT/);
});

test("cancellation during planning persists a failed phase without starting agents",async(t)=>{
 const cwd=await repository(t);const controller=new AbortController();let calls=0;
 const outcome=await runSakuraTaskOnce({cwd,task:"cancel planning",signal:controller.signal,planner:{async plan(){controller.abort();controller.signal.throwIfAborted();throw new Error("unreachable");}},runner:{async run(){calls++;throw new Error("unreachable");}}});
 assert.equal(calls,0);assert.equal(outcome.executionStatus,"cancelled");assert.equal((await loadRunState(outcome.traceDir)).phase,"cancelled");
});

test("verification cancellation terminates shell descendants before returning",async(t)=>{
 const cwd=await repository(t);const controller=new AbortController();
 const child=join(cwd,"child.cjs");await writeFile(child,"require('node:fs').writeFileSync('pid',String(process.pid));setTimeout(()=>require('node:fs').writeFileSync('late','wrong'),2000);\n");
 const result=createShellCommandRunner()(`node ${JSON.stringify(child)}`,cwd,controller.signal);
 const rejection=assert.rejects(result,{name:"AbortError"});
 let pid:string|undefined;
 for(let i=0;i<100&&!pid;i++){try{pid=await readFile(join(cwd,"pid"),"utf8");}catch{await new Promise((resolve)=>setTimeout(resolve,10));}}
 assert.ok(pid);controller.abort();await rejection;
 assert.throws(()=>process.kill(Number(pid),0),{code:"ESRCH"});
 await assert.rejects(readFile(join(cwd,"late")),/ENOENT/);
});

test("isolated cancelled writers restore their unintegrated partial artifact before resume",async(t)=>{
 const cwd=await repository(t),config=mergeConfig({workspace:{taskIsolation:true},policy:{network:"allow"}}),controller=new AbortController();
 const graph=createTaskGraph({id:"isolated-recovery",rootTask:"two isolated changes",nodes:["first","second"].map((id,index)=>taskNode({id,title:id,description:id,role:"implementer",dependencies:index?["first"]:[],priority:1,writeScope:[`${id}.txt`]}))});const saved=await savePlan(cwd,graph);
 const initial=await runSakuraTaskOnce({cwd,task:graph.rootTask,planPath:saved.path,config,signal:controller.signal,runner:{async run(input){await writeFile(join(input.workspacePath,`${input.task.id}.txt`),"partial\n");if(input.task.id==="second") controller.abort();return {status:"success",summary:"written",changedFiles:[`${input.task.id}.txt`],evidence:[]};}}});
 assert.equal(initial.executionStatus,"cancelled");assert.match(initial.diff,/first.txt/);assert.doesNotMatch(initial.diff,/second.txt/);
 const seen:string[]=[];const resumed=await runSakuraTaskOnce({cwd,task:graph.rootTask,resumeRunId:initial.runId,config,runner:{async run(input){seen.push(input.task.id);assert.equal(await readFile(join(input.workspacePath,"first.txt"),"utf8"),"partial\n");assert.equal(await readFile(join(input.workspacePath,"second.txt"),"utf8"),"partial\n");await writeFile(join(input.workspacePath,"second.txt"),"finished\n");return {status:"success",summary:"finished",changedFiles:["second.txt"],evidence:[]};}}});
 assert.deepEqual(seen,["second"]);assert.equal(resumed.completed,true);assert.match(resumed.diff,/finished/);
});
