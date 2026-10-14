import assert from "node:assert/strict";
import {mkdir,readFile,symlink,appendFile,realpath} from "node:fs/promises";
import {controlDirectory,certifyRunVerification} from "../../src/experience/control-store.ts";
import {join,resolve} from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {getAgentDir,ModelRuntime,SettingsManager} from "@earendil-works/pi-coding-agent";
import {createSakuraAgent} from "../../src/runtime/create-agent.ts";
import {createExperienceStore} from "../../src/experience/store.ts";
import {proposeCandidate,evaluateCandidate} from "../../src/experience/skill-candidates.ts";
import {runSakuraTaskOnce} from "../../src/run.ts";
import {loadConfig} from "../../src/config.ts";
import {readArtifact} from "../../src/workspace/apply-artifact.ts";
import {prepareFixtureJudge} from "./fixture-judge.ts";
import {atomicWrite} from "../../src/storage/atomic.ts";
const root=resolve(new URL("../../",import.meta.url).pathname),exec=promisify(execFile);
const workspace=join(root,".sakura","release","candidate-replay-v2"),source=join(root,".sakura","benchmarks","experience-seed","experiences.json");
// A new replay must have a clean fixed base; preserve any earlier attempt rather than overwriting it.
await mkdir(join(root,".sakura","release"),{recursive:true});
await exec("git",["clone","--quiet",join(root,"benchmarks","fixtures","token-refresh.bundle"),workspace]);
const task=JSON.parse(await readFile(join(root,"benchmarks","tasks","repeated-refresh.json"),"utf8"));
await exec("git",["checkout","--quiet","--detach",task.repo.commit],{cwd:workspace});
await symlink(join(root,"node_modules"),join(workspace,"node_modules"),"dir");await appendFile(join(workspace,".git","info","exclude"),"\n/node_modules\n/.pi\n");
const store=createExperienceStore(workspace),experiences=JSON.parse(await readFile(source,"utf8"));
for(const item of experiences)await store.add({...item,traceDir:item.traceDir?resolve(root,item.traceDir):undefined});
const name="sakura-learned-refresh",candidate=await proposeCandidate(workspace,{name,description:"refresh stale token regression 刷新 token 回归检查",experienceIds:experiences.map((item:{id:string})=>item.id),body:"# Refresh token regression\n\n证据来源：固定 auth-refresh 任务的已验证补丁，修改 src/auth/auth-service.ts，使 refresh(current, next) 返回 next。\n\n1. 读取当前 refresh 的实现及调用方，确认返回旧 token 的问题仍然存在；历史补丁只作为线索。\n2. 保持公开函数签名，返回已轮换的新 token，避免修改无关文件或测试判定器。\n3. 运行项目类型检查与回归测试；没有 shell 工具时说明由 Sakura 外层执行检查，不声称自己已执行。\n4. 记录实际 diff、检查命令、退出码和剩余问题。单次成功不代表适用于所有 token 系统。"});
await atomicWrite(join(root,".sakura","release","candidate-review-v2.json"),JSON.stringify({workspace,id:candidate.id,version:candidate.version,stage:candidate.stage,artifactSha256:candidate.sha256,replaySkill:join(workspace,".sakura","skill-candidates",candidate.id,"replay-v1",name,"SKILL.md")},null,2));
const modelRuntime=await ModelRuntime.create({refreshOnCreate:false,allowModelNetwork:false}),settingsManager=SettingsManager.create(root,getAgentDir());
const model=modelRuntime.getModel("ollama","sakura-bench-qwen35-4b");assert.ok(model);
const probe=await createSakuraAgent({cwd:workspace,role:"explorer",model,modelRuntime,settingsManager,localOnly:true,sessionMode:"memory"});probe.dispose();
const config=structuredClone(await loadConfig(workspace));config.runtime.localOnly=true;config.policy.network="allow";config.workspace.taskIsolation=true;
const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),600000);
const stop=()=>controller.abort();process.on("SIGTERM",stop);process.on("SIGINT",stop);
let judge:Awaited<ReturnType<typeof prepareFixtureJudge>>|undefined;
try {
 judge=await prepareFixtureJudge(workspace,task.id,task.repo.commit);
 const outcome=await runSakuraTaskOnce({cwd:workspace,task:task.task.description,files:task.task.hintFiles,config,skillDirs:[join(workspace,".sakura","skill-candidates",candidate.id,"replay-v1")],signal:controller.signal,agentConfig:{model,modelRuntime,settingsManager,thinkingLevel:"off",allowedTools:["read","write","edit","grep","find","ls"]}});
 assert.equal(outcome.completed,true,outcome.error);
 assert.ok(outcome.artifactPath);
 const artifact=await readArtifact(outcome.artifactPath);
 if(artifact.patch){await exec("git",["apply","--check","--binary",artifact.patchPath],{cwd:workspace});await exec("git",["apply","--binary",artifact.patchPath],{cwd:workspace});}
 const projectRoot=await realpath(workspace);
 const frozen=await judge.run(controller.signal,{readWriteDeny:[await realpath(controlDirectory())],writeDeny:[join(projectRoot,".pi/skills"),join(projectRoot,".sakura/runs"),join(projectRoot,".sakura/skill-candidates")]});
 await certifyRunVerification(workspace,outcome.runId,frozen);assert.equal(frozen.passed,true);
 const evaluated=await evaluateCandidate(workspace,candidate.id,outcome.traceDir);
 await atomicWrite(join(root,".sakura","release","candidate-review-v2.json"),JSON.stringify({workspace,id:candidate.id,version:candidate.version,stage:evaluated.stage,artifactSha256:candidate.sha256,replaySkill:join(workspace,".sakura","skill-candidates",candidate.id,"replay-v1",name,"SKILL.md"),runDir:outcome.traceDir,artifactPath:outcome.artifactPath,frozen,metrics:outcome.metrics,next:"Trusted operator review required; automatic authorization additionally requires eligible paired effect evaluation"},null,2));
 console.log(JSON.stringify({id:candidate.id,stage:evaluated.stage,workspace,runDir:outcome.traceDir},null,2));
}finally{clearTimeout(timer);await judge?.dispose();process.removeListener("SIGTERM",stop);process.removeListener("SIGINT",stop);}
