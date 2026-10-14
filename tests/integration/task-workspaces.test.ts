import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp,writeFile,readFile,rm,readdir,mkdir,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {runSakuraTaskOnce} from "../../src/run.ts";
import {createTaskGraph,taskNode} from "../../src/planning/schemas.ts";
import {savePlan} from "../../src/planning/plan-store.ts";
import {createWorkspaceManager} from "../../src/workspace/workspace-manager.ts";
import {isolateTaskWorkspaces} from "../../src/workspace/task-workspaces.ts";
const exec=promisify(execFile);
const git=async(cwd:string,...args:string[])=>(await exec("git",args,{cwd})).stdout;

test("ordinary isolated DAG integrates dependency artifacts and verifies the combined output",async(t)=>{
 const cwd=await mkdtemp(join(tmpdir(),"sakura-isolated-dag-"));t.after(()=>rm(cwd,{recursive:true,force:true}));
 await git(cwd,"init","-q");await writeFile(join(cwd,"base.txt"),"base\n");
 await writeFile(join(cwd,".gitignore"),".sakura/\nnode_modules/\n");
 await writeFile(join(cwd,"sakura.config.yaml"),"workspace:\n  taskIsolation: true\npolicy:\n  network: allow\n");
 await writeFile(join(cwd,"package.json"),JSON.stringify({scripts:{test:"node consumer.mjs"},type:"module"}));
 await git(cwd,"add","-A");await git(cwd,"-c","user.name=test","-c","user.email=test@example.invalid","commit","-qm","base");
 const dependencies=await mkdtemp(join(tmpdir(),"sakura-ignored-deps-"));t.after(()=>rm(dependencies,{recursive:true,force:true}));await symlink(dependencies,join(cwd,"node_modules"),"dir");
 await writeFile(join(cwd,".git","info","exclude"),"/node_modules\n");
 const graph=createTaskGraph({id:"dependencies",rootTask:"new module and consumer",nodes:[
  taskNode({id:"module",title:"module",description:"add module",role:"implementer",dependencies:[],priority:1,writeScope:["module.mjs"]}),
  taskNode({id:"independent",title:"independent",description:"add notes",role:"implementer",dependencies:[],priority:1,writeScope:["notes.txt"]}),
  taskNode({id:"consumer",title:"consumer",description:"use module",role:"implementer",dependencies:["module","independent"],priority:1,writeScope:["consumer.mjs"]}),
 ]});const saved=await savePlan(cwd,graph);const paths:string[]=[];let active=0,max=0;let release!:()=>void;const barrier=new Promise<void>(resolve=>release=resolve);
 const outcome=await runSakuraTaskOnce({cwd,task:graph.rootTask,planPath:saved.path,runner:{async run(input){
   paths.push(input.workspacePath);active++;max=Math.max(max,active);
   if(input.task.id==="consumer") {assert.equal(await readFile(join(input.workspacePath,"module.mjs"),"utf8"),"export const value=7;\n");assert.equal(await readFile(join(input.workspacePath,"notes.txt"),"utf8"),"notes\n");}
   if(input.task.id!=="consumer"){if(active===2) release();await barrier;}
   const path=input.task.writeScope![0],content=input.task.id==="module"?"export const value=7;\n":input.task.id==="independent"?"notes\n":"import {value} from './module.mjs'; if(value!==7) process.exit(1);\n";
   await writeFile(join(input.workspacePath,path),content);active--;
   return {status:"success",summary:"created",changedFiles:[path],evidence:[]};
 }}});
 assert.equal(outcome.completed,true);assert.equal(max,2);assert.equal(new Set(paths).size,3);assert.match(outcome.diff,/module.mjs/);assert.match(outcome.diff,/consumer.mjs/);
 assert.doesNotMatch(outcome.diff,/diff --git a\/node_modules/);
 assert.equal(outcome.checkStatus,"passed");const records=await Promise.all((await readdir(join(outcome.traceDir,"integrations"))).map(async name=>JSON.parse(await readFile(join(outcome.traceDir,"integrations",name),"utf8"))));
 assert.ok(records.every(record=>record.status==="integrated"));
 for(const path of paths) await assert.rejects(readFile(join(path,".git")),/ENOENT/);
 await assert.rejects(readFile(join(cwd,"module.mjs")),/ENOENT/);
});

test("conflicting isolated deltas preserve both artifacts and keep the last integrated target",async(t)=>{
 const cwd=await mkdtemp(join(tmpdir(),"sakura-integration-conflict-"));t.after(()=>rm(cwd,{recursive:true,force:true}));
 await git(cwd,"init","-q");await writeFile(join(cwd,"common.txt"),"original\n");await git(cwd,"add","-A");await git(cwd,"-c","user.name=test","-c","user.email=test@example.invalid","commit","-qm","base");
 const manager=createWorkspaceManager({repoPath:cwd,rootDir:join(cwd,".sakura","worktrees")});const aggregate=await manager.createWorkspace("integration");
 let entered=0,ready!:()=>void,releaseB!:()=>void;const both=new Promise<void>(resolve=>ready=resolve),holdB=new Promise<void>(resolve=>releaseB=resolve);
 const runner=isolateTaskWorkspaces({repoPath:cwd,integrationPath:aggregate.worktreePath,runDir:join(cwd,".sakura","runs","conflict"),cleanup:true,runner:{async run(input){
  if(++entered===2) ready();await both;if(input.task.id==="b") await holdB;
  await writeFile(join(input.workspacePath,"common.txt"),`${input.task.id}\n`);return {status:"success",summary:"created conflicting delta",changedFiles:["common.txt"],evidence:[]};
 }}});
 const input=(id:string)=>({agentId:id,role:"implementer" as const,task:taskNode({id,title:id,description:id,role:"implementer",dependencies:[],priority:1,writeScope:[`${id}.txt`]}),workspacePath:aggregate.worktreePath,allowedTools:["read","write"],timeoutMs:10000});
 // Fault injection: the runner violates its declared scopes. Integration must still fail safely.
 const a=runner.run(input("a")),b=runner.run(input("b"));await both;assert.equal((await a).status,"success");releaseB();const failed=await b;
 assert.equal(failed.status,"needs_replan");assert.match(failed.summary,/Integration conflict/);
 assert.equal(await readFile(join(aggregate.worktreePath,"common.txt"),"utf8"),"a\n");assert.equal(await readFile(join(cwd,"common.txt"),"utf8"),"original\n");
 const recordNames=await readdir(join(cwd,".sakura","runs","conflict","integrations"));const records=await Promise.all(recordNames.map(async name=>JSON.parse(await readFile(join(cwd,".sakura","runs","conflict","integrations",name),"utf8"))));
 const conflicting=records.find(record=>record.status==="conflict");assert.ok(conflicting?.artifactPath);assert.equal(await readFile(join(conflicting.workspacePath,"common.txt"),"utf8"),"b\n");
 await manager.cleanup(aggregate);
});
