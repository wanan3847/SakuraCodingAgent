import assert from "node:assert/strict";
import {readFile,mkdir,writeFile,symlink,appendFile,cp,mkdtemp,realpath} from "node:fs/promises";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {setTimeout as delay} from "node:timers/promises";
import {ModelRuntime,SettingsManager,getAgentDir} from "@earendil-works/pi-coding-agent";
import {runSakuraTaskOnce} from "../src/run.ts";
import {createExperienceStore} from "../src/experience/store.ts";
import {proposeCandidate,evaluateCandidate,assessCandidateEffect,reviewCandidate,promoteCandidate,loadActiveSkill} from "../src/experience/skill-candidates.ts";
import {certifyRunVerification,digest} from "../src/experience/control-store.ts";
import {loadConfig} from "../src/config.ts";
import {readArtifact} from "../src/workspace/apply-artifact.ts";
import {prepareFixtureJudge} from "../benchmarks/runners/fixture-judge.ts";
import {sourceFingerprint} from "../benchmarks/runners/resume.ts";
import {atomicWrite} from "../src/storage/atomic.ts";
import {protectedSandboxSupported} from "../src/verification/protected-command.ts";
const root=resolve(new URL("../",import.meta.url).pathname),exec=promisify(execFile),args=process.argv.slice(2);
const value=(key:string)=>{const i=args.indexOf(key);return i<0?undefined:args[i+1];};
const output=resolve(root,value("--output")??".sakura/release/candidate-effect-experiment"),workspace=join(output,"workspace");
const sourceSha256=await sourceFingerprint(root);
const driverSha256=digest(await readFile(new URL(import.meta.url),"utf8"));
await mkdir(output,{recursive:true});
try{await readFile(join(output,"progress.json"));throw new Error("Experiment already exists; preserve evidence and choose a new output directory");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
const progress:any={stage:"queued",sourceSha256,driverSha256,model:"ollama/sakura-bench-qwen35-4b",planned:18,trials:[],pairs:[],autoApprovalAuthorized:args.includes("--user-authorized")};
const save=()=>atomicWrite(join(output,"progress.json"),JSON.stringify(progress,null,2));
try{
await exec("tar",["-czf",join(output,"sources.tar.gz"),"src","extensions","benchmarks/runners","benchmarks/tasks","benchmarks/fixtures","scripts/evaluate-candidate-pairs.ts","package.json","package-lock.json"],{cwd:root});progress.archiveSha256=digest(await readFile(join(output,"sources.tar.gz")));await save();
const preceding=value("--after-report"),pid=Number(value("--after-pid"));
if(preceding){
 while(true){const previous=JSON.parse(await readFile(resolve(root,preceding),"utf8"));if(previous.complete)break;
  if(!Number.isSafeInteger(pid)||pid<1)throw new Error("Queued experiment needs an authoritative preceding PID");
  let command="";try{command=(await exec("ps",["-p",String(pid),"-o","command="])).stdout;}catch{}
  if(!command.includes("benchmarks/runners/run.ts")||!command.includes(preceding))throw new Error("Preceding matrix stopped incomplete; do not overlap a replacement run. Inspect and explicitly restart this queue.");
  await delay(10000);
 }
}
assert.equal(await sourceFingerprint(root),sourceSha256,"Source changed while queued; no mixed-version auto approval");
assert.equal(digest(await readFile(new URL(import.meta.url),"utf8")),driverSha256,"Experiment driver changed while queued");
assert.equal(protectedSandboxSupported(),true,"Protected replay needs a configured OS sandbox");
await exec("git",["clone","--quiet",join(root,"benchmarks/fixtures/token-refresh.bundle"),workspace]);
await symlink(join(root,"node_modules"),join(workspace,"node_modules"),"dir");await appendFile(join(workspace,".git/info/exclude"),"\n/node_modules\n/.pi\n/.sakura\n");
const controlDir=await mkdtemp(join(tmpdir(),"sakura-control-credentials-effect-")),authority={controlDir};progress.authority=await realpath(controlDir);progress.workspace=await realpath(workspace);
const experiences=JSON.parse(await readFile(join(root,"benchmarks/reports/experience-2026-10-13/seed/experiences.json"),"utf8"));
for(const item of experiences)await createExperienceStore(workspace).add({...item,traceDir:join(root,"benchmarks/reports/experience-2026-10-13/seed-source-run")});
const candidate=await proposeCandidate(workspace,{name:"sakura-learned-refresh",description:"refresh stale token regression 刷新 token 回归检查",experienceIds:experiences.map((e:{id:string})=>e.id),body:"# Refresh token regression\n\n事实来源：已验证 auth-refresh 的补丁，将 refresh(current,next) 的返回值从 current 改为 next。\n\n1. 先读取当前实现和调用方，确认该问题确实存在；历史经验只是线索。当前任务不涉及此问题时，不改正确的刷新逻辑。\n2. 修复时保持公开签名，返回已轮换的新 token，避免改写判定器或无关文件。\n3. 运行项目类型检查和回归检查；没有 shell 工具时，由 Sakura 外层检查，不声称自己执行过命令。\n4. 报告实际 diff、命令、退出码和剩余问题。局部效果对照不能证明通用收益。"},authority);
progress.candidate={id:candidate.id,sha256:candidate.sha256,version:1};progress.stage="running";await save();
const runtime=await ModelRuntime.create({refreshOnCreate:false,allowModelNetwork:false}),settings=SettingsManager.create(root,getAgentDir()),model=runtime.getModel("ollama","sakura-bench-qwen35-4b");assert.ok(model);
const config=structuredClone(await loadConfig(workspace));config.runtime.localOnly=true;config.policy.network="allow";config.experience.enabled=false;config.workspace.taskIsolation=true;
const tasks=await Promise.all(["auth-refresh","repeated-refresh","expiry-boundary"].map(async name=>JSON.parse(await readFile(join(root,`benchmarks/tasks/${name}.json`),"utf8"))));
const controller=new AbortController(),interrupt=()=>controller.abort();process.on("SIGTERM",interrupt);process.on("SIGINT",interrupt);
try{
 for(const task of tasks)for(let repeat=1;repeat<=3;repeat++){
  const pair:any={};
  for(const variant of ["baseline","candidate"]){
   controller.signal.throwIfAborted();await exec("git",["reset","--hard"],{cwd:workspace});await exec("git",["clean","-fd"],{cwd:workspace});await exec("git",["checkout","--detach",task.repo.commit],{cwd:workspace});
   const judge=await prepareFixtureJudge(workspace,task.id,task.repo.commit),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(task.limits.timeoutMs)]);
   try{
    const outcome=await runSakuraTaskOnce({cwd:workspace,task:task.task.description,files:task.task.hintFiles,config,skillAuthority:authority,skillDirs:variant==="candidate"?[join(workspace,".sakura/skill-candidates",candidate.id,"replay-v1")]:[],signal,agentConfig:{model,modelRuntime:runtime,settingsManager:settings,thinkingLevel:"off",allowedTools:["read","write","edit","grep","find","ls"]}});
    assert.ok(outcome.artifactPath,"No replay artifact; preserve experiment and refuse automatic publication");
    const artifact=await readArtifact(outcome.artifactPath);if(artifact.patch){await exec("git",["apply","--check","--binary",artifact.patchPath],{cwd:workspace});await exec("git",["apply","--binary",artifact.patchPath],{cwd:workspace});}
    const fixed=await judge.run(signal,{readWriteDeny:[progress.authority],writeDeny:[join(progress.workspace,".pi/skills"),join(progress.workspace,".sakura/runs"),join(progress.workspace,".sakura/skill-candidates")]});
    await certifyRunVerification(workspace,outcome.runId,fixed,authority);
    const row={taskId:task.id,repeat,variant,runId:outcome.runId,passed:outcome.completed&&fixed.passed,metrics:outcome.metrics,fixed,runDir:outcome.traceDir};progress.trials.push(row);pair[variant==="baseline"?"baselineRunId":"candidateRunId"]=outcome.runId;
    await cp(outcome.traceDir,join(output,`${task.id}-${variant}-${repeat}`),{recursive:true});await save();
    if(variant==="candidate"&&row.passed&&progress.stage!=="evaluated"){await evaluateCandidate(workspace,candidate.id,outcome.traceDir,authority);progress.stage="evaluated";await save();}
   }finally{await judge.dispose();}
  }
  progress.pairs.push(pair);await save();
 }
 const assessed=await assessCandidateEffect(workspace,candidate.id,progress.pairs,authority);progress.effect=assessed.effectEvaluation;progress.stage="assessed";await save();
 if(progress.autoApprovalAuthorized&&assessed.effectEvaluation?.eligible){
  await reviewCandidate(workspace,candidate.id,"current user: explicit automatic approval in this conversation",true,{...authority,expectedSha256:candidate.sha256},"user-authorized");await promoteCandidate(workspace,candidate.id,authority);progress.active=await loadActiveSkill(workspace,candidate.name,authority);progress.stage="promoted";
 }else progress.reason="Effect gate did not qualify or operator authorization absent; keep evaluated, no publication.";
 progress.complete=true;await save();console.log(JSON.stringify({output,stage:progress.stage,effect:progress.effect},null,2));
}catch(error){progress.stage="failed";progress.error=String(error);progress.complete=false;await save();throw error;}
finally{process.removeListener("SIGTERM",interrupt);process.removeListener("SIGINT",interrupt);}
}catch(error){progress.stage="failed";progress.error=String(error);progress.complete=false;await save();throw error;}
