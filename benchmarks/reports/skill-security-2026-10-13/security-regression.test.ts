import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {piFixture} from "../helpers/pi-fixture.ts";
import {runSakuraTaskOnce} from "../../src/run.ts";
import {createTaskGraph,taskNode} from "../../src/planning/schemas.ts";
import {createExperienceStore} from "../../src/experience/store.ts";
import {proposeCandidate,evaluateCandidate,reviewCandidate,promoteCandidate,rollbackCandidate,loadCandidate,loadActiveSkill,artifactHash,assessCandidateEffect} from "../../src/experience/skill-candidates.ts";
import {loadConfig} from "../../src/config.ts";
import {createShellCommandRunner} from "../../src/verification/test-runner.ts";
import {certifyRunVerification} from "../../src/experience/control-store.ts";
import {evaluateAction} from "../../src/workspace/guard.ts";
const exec=promisify(execFile);
async function fixture(t:{after:(fn:()=>Promise<unknown>)=>void},benefit=false){
 const root=await mkdtemp(join(tmpdir(),"sakura-security-")),controlDir=await mkdtemp(join(tmpdir(),"sakura-control-credentials-security-")),authority={controlDir};
 t.after(()=>rm(root,{recursive:true,force:true}));t.after(()=>rm(controlDir,{recursive:true,force:true}));
 const git=(...args:string[])=>exec("git",args,{cwd:root});await git("init","-q");
 await writeFile(join(root,".gitignore"),".sakura/\n.pi/\n");await writeFile(join(root,"value.txt"),"stale\n");await writeFile(join(root,"check.mjs"),"import {readFileSync} from 'node:fs';if(readFileSync('value.txt','utf8')!=='fresh\\n')process.exit(1);");await writeFile(join(root,"package.json"),JSON.stringify({type:"module",scripts:{test:"node check.mjs"}}));await git("add","-A");await git("-c","user.name=test","-c","user.email=test@example.invalid","commit","-qm","base");
 await createExperienceStore(root).add({id:"source",problemPattern:"refresh regression",symptoms:[],failedAttempts:[],successfulActions:["return fresh"],usefulTools:[],relevantFiles:["value.txt"],verificationEvidence:["test exit 0"],tags:[],createdAt:Date.now()});
 const pi=await piFixture(context=>{const withSkill=JSON.stringify(context.messages).includes("Return fresh and verify.");const usage={input:benefit&&withSkill?4:10,output:4,cacheRead:0,cacheWrite:0,totalTokens:benefit&&withSkill?8:14,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};return context.messages.at(-1)?.role==="toolResult"?{usage,content:[{type:"text",text:"Changed value; host runs the checks."}]}:{usage,stopReason:"toolUse",content:[{type:"toolCall",id:"fix",name:"write",arguments:{path:"value.txt",content:"fresh\n"}}]};});t.after(pi.cleanup);
 const config=structuredClone(await loadConfig(root));config.policy.network="allow";config.experience.enabled=false;
 const task="refresh regression",planner={plan:async()=>createTaskGraph({id:"security",rootTask:task,nodes:[taskNode({id:"fix",role:"implementer",title:task,description:task,dependencies:[],priority:1,writeScope:["value.txt"]})]})};
 const input={name:"sakura-learned-refresh",description:task,body:"# refresh regression\nReturn fresh and verify.",experienceIds:["source"]};
 const first=await proposeCandidate(root,input,authority);
 const run=(version?:number,description=task)=>runSakuraTaskOnce({cwd:root,task:description,config,planner:{plan:async()=>({...await planner.plan(),rootTask:description})},skillAuthority:authority,skillDirs:version?[join(root,".sakura","skill-candidates",first.id,`replay-v${version}`)]:[],agentConfig:pi.config});
 const evaluate=async(version:number)=>{const outcome=await run(version);assert.equal(outcome.completed,true,outcome.error);await evaluateCandidate(root,first.id,outcome.traceDir,authority);return outcome;};
 const approve=()=>reviewCandidate(root,first.id,"test operator",true,authority);
 return {root,authority,first,input,run,evaluate,approve};
}
test("different candidates cannot reserve the same name or overwrite an unrelated formal skill",async t=>{
 const f=await fixture(t);await assert.rejects(proposeCandidate(f.root,f.input,f.authority),/owned by another/);
 await f.evaluate(1);await f.approve();const target=join(f.root,".pi","skills",f.first.name,"SKILL.md");await mkdir(join(target,".."),{recursive:true});await writeFile(target,"FOREIGN SKILL");await assert.rejects(promoteCandidate(f.root,f.first.id,f.authority),/ownership/);assert.equal(await readFile(target,"utf8"),"FOREIGN SKILL");
});
test("old selected artifact cannot pass evaluation even when it contains the complete new body",async t=>{
 const f=await fixture(t);const newBody=f.input.body;const v2=await proposeCandidate(f.root,{...f.input,id:f.first.id,body:`OLD PREFIX\n${newBody}`},f.authority);
 const v3=await proposeCandidate(f.root,{...f.input,id:f.first.id,body:newBody},f.authority);assert.notEqual(v2.sha256,v3.sha256);
 const old=await f.run(2);assert.equal(old.completed,true,old.error);assert.ok((await readFile(join(old.traceDir,"context-pack.json"),"utf8")).includes(newBody.split("\n")[1]));await assert.rejects(evaluateCandidate(f.root,f.first.id,old.traceDir,f.authority),/artifact version/);
});
test("description tampering after review invalidates publication even with a recomputed project hash",async t=>{
 const f=await fixture(t);await f.evaluate(1);await f.approve();const path=join(f.root,".sakura","skill-candidates",f.first.id,"latest.json"),value=JSON.parse(await readFile(path,"utf8"));value.description="Changed trigger after review";value.sha256=artifactHash(value);value.review.sha256=value.sha256;value.evaluation.sha256=value.sha256;await writeFile(path,JSON.stringify(value));await assert.rejects(promoteCandidate(f.root,f.first.id,f.authority),/control authority/);
});
test("two processes create distinct successive revisions without overwriting a version",async t=>{
 const f=await fixture(t),module=new URL("../../src/experience/skill-candidates.ts",import.meta.url).href;
 const launch=(body:string)=>exec(process.execPath,["--input-type=module","-e",`import {proposeCandidate} from ${JSON.stringify(module)};const c=await proposeCandidate(${JSON.stringify(f.root)},${JSON.stringify({...f.input,id:f.first.id,body})},${JSON.stringify(f.authority)});console.log(c.version);`]);
 const results=await Promise.all([launch("Revision A"),launch("Revision B")]);assert.deepEqual(results.map(r=>Number(r.stdout)).sort(),[2,3]);
 const a=await loadCandidate(f.root,f.first.id,2,f.authority),b=await loadCandidate(f.root,f.first.id,3,f.authority);assert.notEqual(a.sha256,b.sha256);assert.equal((await loadCandidate(f.root,f.first.id,undefined,f.authority)).version,3);
});
test("publication interrupted after skill write recovers journal, authoritative state and mirrors",async t=>{
 const f=await fixture(t);await f.evaluate(1);await f.approve();await assert.rejects(promoteCandidate(f.root,f.first.id,{...f.authority,fault:async point=>{if(point==="skill-written")throw new Error("simulated crash");}}),/simulated crash/);
 const active=await loadActiveSkill(f.root,f.first.name,f.authority);assert.equal(active.version,1);assert.equal(active.sha256,f.first.sha256);assert.equal((await loadCandidate(f.root,f.first.id,undefined,f.authority)).stage,"promoted");assert.deepEqual(JSON.parse(await readFile(join(f.root,".sakura","skill-candidates",f.first.id,"active.json"),"utf8")),active);
});
test("rollback preserves path and active hash while latest remains the newest created version",async t=>{
 const f=await fixture(t);await f.evaluate(1);await f.approve();await promoteCandidate(f.root,f.first.id,f.authority);
 await proposeCandidate(f.root,{...f.input,id:f.first.id,body:f.input.body+"\nVersion two"},f.authority);await f.evaluate(2);await f.approve();await promoteCandidate(f.root,f.first.id,f.authority);await rollbackCandidate(f.root,f.first.id,1,f.authority);
 const active=await loadActiveSkill(f.root,f.first.name,f.authority);assert.equal(active.version,1);assert.equal(active.path,join(await import("node:fs/promises").then(m=>m.realpath(f.root)),".pi","skills",f.first.name,"SKILL.md"));assert.equal(active.sha256,f.first.sha256);assert.equal((await loadCandidate(f.root,f.first.id,undefined,f.authority)).version,2);
});
test("forged reviewed project state grants no authority and protected Agent paths cannot be approved",async t=>{
 const f=await fixture(t),path=join(f.root,".sakura","skill-candidates",f.first.id,"latest.json"),value=JSON.parse(await readFile(path,"utf8"));value.stage="reviewed";value.review={approved:true,reviewer:"human",sha256:value.sha256,mode:"human",at:Date.now()};value.evaluation={sha256:value.sha256,runId:"fake",runDir:"/fake",at:Date.now()};await writeFile(path,JSON.stringify(value));await assert.rejects(promoteCandidate(f.root,f.first.id,f.authority),/control authority/);
 assert.equal((await evaluateAction({workspacePath:f.root,allowExternalRead:true,externalWrite:"approval",trustedPaths:[f.authority.controlDir]},{agentId:"attacker",tool:"write",kind:"write",path:join(f.authority.controlDir,"forged.json")})).type,"deny");
});
test("repository verification cannot read or mutate the external authority through arbitrary code",async t=>{
 const f=await fixture(t),secret=join(f.authority.controlDir,"sentinel.txt");await writeFile(secret,"trusted");
 const result=await createShellCommandRunner({readWriteDeny:[f.authority.controlDir.replace(/^\/var\//,"/private/var/")],writeDeny:[]})(`node -e 'require("fs").writeFileSync(${JSON.stringify(secret)},"forged")'`,f.root);
 assert.notEqual(result.exitCode,0);assert.equal(await readFile(secret,"utf8"),"trusted");
 const host=await mkdtemp(join(tmpdir(),"sakura-host-code-"));t.after(()=>rm(host,{recursive:true,force:true}));const path=join(host,"controller.ts");await writeFile(path,"trusted host code");const denied=await createShellCommandRunner({readWriteDeny:[],writeDeny:[]})(`node -e 'require("fs").writeFileSync(${JSON.stringify(path)},"forged")'`,f.root);assert.notEqual(denied.exitCode,0);assert.equal(await readFile(path,"utf8"),"trusted host code");
});

test("protected candidate replay rejects in-place execution before the Agent can edit host files",async t=>{
 const f=await fixture(t),config=structuredClone(await loadConfig(f.root));config.workspace.mode="in-place";
 const outcome=await runSakuraTaskOnce({cwd:f.root,task:"refresh regression",config,skillAuthority:f.authority,skillDirs:[join(f.root,".sakura","skill-candidates",f.first.id,"replay-v1")]});
 assert.equal(outcome.completed,false);assert.match(outcome.error??"",/isolated Git worktree/);assert.equal(await readFile(join(f.root,"value.txt"),"utf8"),"stale\n");await assert.rejects(evaluateCandidate(f.root,f.first.id,outcome.traceDir,f.authority),/trusted verified run/);
});

test("automatic approval uses equal paired native receipts and rejects missing, duplicate or regressive evidence",async t=>{
 const f=await fixture(t,true);await f.evaluate(1);await assert.rejects(reviewCandidate(f.root,f.first.id,"authorized test operator",true,f.authority,"user-authorized"),/paired effect/);
 const pairs=[];for(const task of ["refresh regression alpha","refresh regression beta"])for(let repeat=0;repeat<3;repeat++){const b=await f.run(undefined,task),a=await f.run(1,task);assert.equal(b.completed,true,b.error);assert.equal(a.completed,true,a.error);await certifyRunVerification(f.root,b.runId,b.result!.verification!,f.authority);await certifyRunVerification(f.root,a.runId,a.result!.verification!,f.authority);pairs.push({baselineRunId:b.runId,candidateRunId:a.runId});}
 await assert.rejects(assessCandidateEffect(f.root,f.first.id,[pairs[0],pairs[0]],f.authority),/Invalid or unequal/);
 const insufficient=await assessCandidateEffect(f.root,f.first.id,pairs.slice(0,3),f.authority);assert.equal(insufficient.effectEvaluation?.eligible,false);
 const assessed=await assessCandidateEffect(f.root,f.first.id,pairs,f.authority);assert.equal(assessed.effectEvaluation?.eligible,true);assert.equal(assessed.effectEvaluation?.baseline.passed,6);
 await reviewCandidate(f.root,f.first.id,"authorized test operator",true,f.authority,"user-authorized");await promoteCandidate(f.root,f.first.id,f.authority);assert.equal((await loadActiveSkill(f.root,f.first.name,f.authority)).version,1);
});
