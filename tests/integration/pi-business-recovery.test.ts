import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {piFixture} from "../helpers/pi-fixture.ts";
import {runSakuraTaskOnce} from "../../src/run.ts";
import {loadConfig} from "../../src/config.ts";
import {loadRunState} from "../../src/runtime/run-state.ts";
import {createTaskGraph,taskNode} from "../../src/planning/schemas.ts";
import {createResilientPlanner} from "../../src/runtime/plan-agent.ts";
import {analyzeTask} from "../../src/planning/task-analyzer.ts";
import {agentProfile} from "../../src/orchestrator/agent-registry.ts";
test("business resume reopens the unfinished native Pi session in a new isolated workspace",async(t)=>{
 const cwd=await mkdtemp(join(tmpdir(),"sakura-native-resume-"));t.after(()=>rm(cwd,{recursive:true,force:true}));const git=async(...args:string[])=>promisify(execFile)("git",args,{cwd});
 await git("init","-q");await writeFile(join(cwd,".gitignore"),".sakura/\n");await writeFile(join(cwd,"package.json"),JSON.stringify({type:"module",scripts:{test:"node check.mjs"}}));await writeFile(join(cwd,"check.mjs"),"import {readFileSync} from 'node:fs';if(readFileSync('first.txt','utf8')!=='done'||readFileSync('second.txt','utf8')!=='finished')process.exit(1);\n");await git("add","-A");await git("-c","user.name=t","-c","user.email=t@example.invalid","commit","-qm","base");
 const controller=new AbortController();let resuming=false,historySeen=false;
 const fixture=await piFixture(context=>{
  const messages=JSON.stringify(context.messages),second=messages.includes("# Task (second)");
  if(second&&resuming){historySeen ||= messages.includes("PERSISTED_SECOND_HISTORY");if(context.messages.at(-1)?.role==="toolResult")return {content:[{type:"text",text:"finished second.txt"}]};return {stopReason:"toolUse",content:[{type:"toolCall",id:"finish",name:"write",arguments:{path:"second.txt",content:"finished"}}]};}
  if(second&&context.messages.at(-1)?.role==="toolResult"){controller.abort();return {stopReason:"aborted",content:[]};}
  if(!second&&context.messages.at(-1)?.role==="toolResult")return {content:[{type:"text",text:"completed first.txt"}]};
  return {stopReason:"toolUse",content:[{type:"text",text:second?"PERSISTED_SECOND_HISTORY":"first"},{type:"toolCall",id:second?"partial":"first",name:"write",arguments:{path:second?"second.txt":"first.txt",content:second?"partial":"done"}}]};
 });t.after(fixture.cleanup);
 const config=structuredClone(await loadConfig(cwd));config.policy.network="allow";config.workspace.taskIsolation=true;
 const task="add first and second files",planner={plan:async()=>createTaskGraph({id:"native-recovery",rootTask:task,nodes:[taskNode({id:"first",title:"first",description:"write first.txt",role:"implementer",dependencies:[],priority:1,writeScope:["first.txt"]}),taskNode({id:"second",title:"second",description:"write second.txt",role:"implementer",dependencies:["first"],priority:1,writeScope:["second.txt"]})]})};
 const agentConfig={...fixture.config,sessionMode:"file" as const};
 const initial=await runSakuraTaskOnce({cwd,task,planner,config,agentConfig,signal:controller.signal});assert.equal(initial.executionStatus,"cancelled");
 const checkpoint=await loadRunState(initial.traceDir);assert.equal(checkpoint.tasks.first.status,"succeeded");assert.ok(checkpoint.tasks.second.piSessionRef);assert.match(await readFile(checkpoint.tasks.second.piSessionRef!,"utf8"),/PERSISTED_SECOND_HISTORY/);
 resuming=true;const resumed=await runSakuraTaskOnce({cwd,task,config,agentConfig,resumeRunId:initial.runId});assert.equal(resumed.completed,true);assert.equal(historySeen,true);assert.equal((await loadRunState(resumed.traceDir)).tasks.second.piSessionRef,checkpoint.tasks.second.piSessionRef);assert.match(resumed.diff,/finished/);assert.match(resumed.diff,/first.txt/);
});
test("dynamic model planning cannot assign write roles to a read-only task",async(t)=>{
 const fixture=await piFixture(context=>context.messages.at(-1)?.role==="toolResult"?{content:[{type:"text",text:"submitted"}]}:{stopReason:"toolUse",content:[{type:"toolCall",id:"bad-plan",name:"submit_plan",arguments:{tasks:[{id:"writer",title:"write",description:"edit",role:"implementer",dependencies:[],priority:1,writeScope:["auth.ts"]}]}}]});t.after(fixture.cleanup);
 const reasons:string[]=[],task="只读审查 auth.ts";const planner=createResilientPlanner({cwd:fixture.directory,config:fixture.config,onFallback:reason=>reasons.push(reason)});
 const graph=await planner.plan({task,analysis:analyzeTask({description:task,hintFiles:["auth.ts"]})});assert.ok(reasons.some(reason=>reason.includes("read-only")));assert.ok(Object.values(graph.nodes).every(node=>!agentProfile(node.role).writes));
});
