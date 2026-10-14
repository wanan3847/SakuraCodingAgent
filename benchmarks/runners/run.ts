import {readFile,mkdtemp,mkdir,readdir,symlink,rm,appendFile} from "node:fs/promises";
import {join,resolve,relative,sep} from "node:path";
import {createJiti} from "jiti";
import {tmpdir,platform,arch,cpus} from "node:os";
import {randomUUID,createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {DefaultResourceLoader,SettingsManager,createAgentSession,getAgentDir,ModelRuntime,SessionManager} from "@earendil-works/pi-coding-agent";
import {atomicWrite} from "../../src/storage/atomic.ts";
import {createSakuraAgent,isLoopbackEndpoint} from "../../src/runtime/create-agent.ts";
import {observeAgent,providerFailure} from "../../src/runtime/agent-events.ts";
import {lastAssistantText} from "../../src/runtime/pi-agent-runner.ts";
import {readOnlyVerdict} from "./verdict.ts";
import {prepareFixtureJudge} from "./fixture-judge.ts";
import {loadConfig} from "../../src/config.ts";
import {runSakuraTaskOnce} from "../../src/run.ts";
import {createHeuristicPlanner} from "../../src/planning/planner.ts";
import {captureChanges,saveArtifact} from "../../src/workspace/artifacts.ts";
import {actionForTool,enforceAction} from "../../src/workspace/guard.ts";
import {createShellCommandRunner} from "../../src/verification/test-runner.ts";
import {verify} from "../../src/verification/verifier.ts";
import {summarizeTrials,type TrialResult} from "./statistics.ts";
import {communityMetrics} from "./community-metrics.ts";
import {sourceFingerprint,trialKey,validateResume} from "./resume.ts";
import {singleAgentPlan} from "./ablations.ts";
const exec=promisify(execFile),root=resolve(new URL("../../",import.meta.url).pathname),args=process.argv.slice(2);
const value=(name:string,fallback?:string)=>{const index=args.indexOf(`--${name}`);return index<0 ? fallback : args[index+1];};
const repeats=Number(value("repeats","3")),variants=value("variants","pi,pi-community,sakura,no-multi,no-repo,no-worktree,no-experience,fixed-plan")!.split(",");
if(!Number.isSafeInteger(repeats)||repeats<1||repeats>20||variants.some(variant=>!["pi","pi-community","sakura","no-multi","no-repo","no-worktree","no-experience","fixed-plan"].includes(variant))) throw new Error("Invalid repeat/variant configuration");
const taskNames=(await readdir(join(root,"benchmarks","tasks"))).filter(name=>name.endsWith(".json"));
const wanted=value("task")?.split(","),tasks=await Promise.all(taskNames.map(async name=>JSON.parse(await readFile(join(root,"benchmarks","tasks",name),"utf8"))));
const selected=tasks.filter(task=>!wanted||wanted.includes(task.id));if(!selected.length) throw new Error("No matching tasks");
const matrix=selected.flatMap(task=>Array.from({length:repeats},(_,repeat)=>variants.map(variant=>({taskId:task.id,variant,repeat:repeat+1,baseCommit:task.repo.commit,timeoutMs:task.limits.timeoutMs})))).flat();
if(args.includes("--dry-run")) {console.log(JSON.stringify({trials:matrix.length,matrix,model:value("model")??"Pi native default",executed:false},null,2));process.exit(0);}
const output=resolve(value("report",join(root,".sakura","benchmarks",`matrix-${randomUUID()}.json`))!);
const settingsManager=SettingsManager.create(root,getAgentDir()),modelRuntime=await ModelRuntime.create({refreshOnCreate:false,allowModelNetwork:false});
const requested=value("model");let model;
if(requested){const split=requested.indexOf("/");if(split<1) throw new Error("--model provider/id");model=modelRuntime.getModel(requested.slice(0,split),requested.slice(split+1));if(!model) throw new Error("Model is absent from native Pi configuration");}
const probe=await createSakuraAgent({cwd:root,role:"explorer",sessionMode:"memory",modelRuntime,settingsManager,model,localOnly:true});model=probe.session.model;probe.dispose();
if(!model || !isLoopbackEndpoint(model.baseUrl)) throw new Error("Benchmark requires the selected local Ollama model");
const seed=value("experience-seed"),seedSha256=seed?createHash("sha256").update(await readFile(join(resolve(seed),"experiences.json"))).digest("hex"):null;
const contract={node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model,pi:"1.1.0",model:`${model.provider}/${model.id}`,thinking:"off",sampling:"Pi/provider default, unchanged across variants",planned:matrix.length,metricVersion:2,tools:["read","write","edit","grep","find","ls"],costSource:"unknown: local provider prices do not measure energy or hardware cost",matrix,sourceSha256:await sourceFingerprint(root),seedSha256,communityPath:resolve(value("community-path",join(root,".sakura","benchmark-plugin","node_modules","pi-subagents"))!)};
// Hash the full native model definition without exposing configured headers.
const modelDefinitionSha256=createHash("sha256").update(JSON.stringify(model)).digest("hex");
const communityManifestSha256=variants.includes("pi-community")?createHash("sha256").update(await readFile(join(contract.communityPath,"package.json"))).digest("hex"):null;
const frozenContract={...contract,modelDefinitionSha256,communityManifestSha256};
let metadata={startedAt:new Date().toISOString(),...frozenContract,contractSha256:createHash("sha256").update(JSON.stringify(frozenContract)).digest("hex")};
const trials:TrialResult[]=[];let completed=new Set<string>();
if(args.includes("--resume")) {
 const previous=JSON.parse(await readFile(output,"utf8"));completed=validateResume(previous,metadata.contractSha256,matrix);
 for(const row of previous.trials){const saved=JSON.parse(await readFile(join(output.replace(/\.json$/,""),`${row.taskId}-${row.variant}-${row.repeat}`,"trial.json"),"utf8"));if(JSON.stringify(saved)!==JSON.stringify(row))throw new Error("Report and per-trial evidence differ");}
 trials.push(...previous.trials);metadata=previous.metadata;
} else {try {await readFile(output);throw new Error("Report already exists; use --resume or a new report path");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
const sourceArchive=join(output.replace(/\.json$/,""),"sources.tar.gz");
if(!args.includes("--resume")) {
 await mkdir(output.replace(/\.json$/,""),{recursive:true});
 await exec("tar",["-czf",sourceArchive,"src","extensions","benchmarks/runners","benchmarks/tasks","benchmarks/fixtures","package.json","package-lock.json"],{cwd:root});
 if(await sourceFingerprint(root)!==metadata.sourceSha256)throw new Error("Source changed while recording the benchmark snapshot");
 if(seed){const {cp}=await import("node:fs/promises");await cp(resolve(seed),join(output.replace(/\.json$/,""),"experience-seed"),{recursive:true});}
 if(variants.includes("pi-community"))await atomicWrite(join(output.replace(/\.json$/,""),"community-package.json"),await readFile(join(contract.communityPath,"package.json"),"utf8"));
}
const sourceArchiveSha256=createHash("sha256").update(await readFile(sourceArchive)).digest("hex");
if(args.includes("--resume")&&(metadata as any).sourceArchiveSha256!==sourceArchiveSha256)throw new Error("Source snapshot checksum mismatch");
Object.assign(metadata,{sourceArchiveSha256});
await atomicWrite(output,JSON.stringify({metadata,trials,summary:summarizeTrials(trials),complete:trials.length===matrix.length,interrupted:false},null,2));
const suiteStarted=Date.now(),suiteTimeout=Number(value("total-timeout-ms","3600000"));
let interrupted=false,activeController:AbortController|undefined;
const interrupt=()=>{interrupted=true;activeController?.abort();};
process.on("SIGINT",interrupt);process.on("SIGTERM",interrupt);
if(!Number.isFinite(suiteTimeout)||suiteTimeout<1) throw new Error("Invalid total timeout");
const tools=["read","write","edit","grep","find","ls"];
const logicalReadPath=(workspace:string,path:string)=>{
 const normalized=relative(workspace,resolve(workspace,path)).split(sep).join("/");
 const worktree=normalized.match(/^\.sakura\/worktrees\/[^/]+\/(.+)$/);
 return worktree?.[1]??normalized;
};
for(const trial of matrix) {
 if(completed.has(trialKey(trial)))continue;
 if(interrupted || Date.now()-suiteStarted>=suiteTimeout) break;
 const task=selected.find(task=>task.id===trial.taskId),workspace=await mkdtemp(join(tmpdir(),"sakura-benchmark-trial-"));
 let timedOut=false;
 // A suite deadline stops admission of new trials, never shortens a trial's
 // contracted timeout. Otherwise the last row would have unequal conditions.
 const started=Date.now(),controller=new AbortController(),timer=setTimeout(()=>{timedOut=true;controller.abort();},trial.timeoutMs);
 activeController=controller;
 let row:TrialResult={...trial,status:"failed",durationMs:0,metricsScope:trial.variant==="pi-community"?"root-only":"complete"};
 const trialDir=join(output.replace(/\.json$/,""),`${trial.taskId}-${trial.variant}-${trial.repeat}`);
 let judge:Awaited<ReturnType<typeof prepareFixtureJudge>>|undefined;
 try {
  await exec("git",["clone","--quiet",join(root,"benchmarks","fixtures","token-refresh.bundle"),workspace]);await exec("git",["checkout","--quiet","--detach",trial.baseCommit],{cwd:workspace});
  await symlink(join(root,"node_modules"),join(workspace,"node_modules"),"dir");
  await appendFile(join(workspace,".git","info","exclude"),"\n/node_modules\n");
  judge=await prepareFixtureJudge(workspace,trial.taskId,trial.baseCommit);
  if(seed && trial.variant!=="no-experience") {const {cp}=await import("node:fs/promises");await mkdir(join(workspace,".sakura","experience"),{recursive:true});await cp(resolve(seed),join(workspace,".sakura","experience"),{recursive:true});}
  row.experienceSeed=seed?resolve(seed):null;
  if(seed)row.experienceSeedSha256=createHash("sha256").update(await readFile(join(resolve(seed),"experiences.json"))).digest("hex");
  const filesRead=new Set<string>();let resultText="",agentCalls=0,toolCalls=0,tokensIn:number|undefined,tokensOut:number|undefined,retries=0;
  let contextTokens:number|undefined;
  if(["pi","pi-community"].includes(trial.variant)) {
    let pluginPath:string|undefined;
    if(trial.variant==="pi-community") {
      pluginPath=resolve(value("community-path",join(root,".sakura","benchmark-plugin","node_modules","pi-subagents"))!);
      const manifest=JSON.parse(await readFile(join(pluginPath,"package.json"),"utf8"));
      if(manifest.version!=="0.62.0") throw new Error("Community baseline must lock pi-subagents@0.62.0");
      row.community={name:manifest.name,version:manifest.version};
    }
    const loader=new DefaultResourceLoader({cwd:workspace,agentDir:getAgentDir(),settingsManager:SettingsManager.inMemory({packages:pluginPath?[pluginPath]:[]}),noExtensions:true,additionalExtensionPaths:pluginPath?[join(pluginPath,"index.ts")]:[],noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[pi=>{pi.on("tool_call",async(event)=>{const action=actionForTool(event.toolName,event.input,workspace,"baseline");if(!action)return;const decision=await enforceAction({workspacePath:workspace,network:"allow"},action);if(decision.type!=="allow") return {block:true,reason:decision.reason};});}]});
    await loader.reload();if(loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
    const {session}=await createAgentSession({cwd:workspace,model,modelRuntime,settingsManager,resourceLoader:loader,sessionManager:SessionManager.inMemory(workspace),tools:task.verification.readOnly?tools.filter(tool=>!["write","edit"].includes(tool)):[...tools,...(pluginPath?["subagent"]:[])],thinkingLevel:"off"});
    // Like Pi's extension loader, use jiti for the plugin's public TypeScript API.
    // Node's built-in type stripper deliberately refuses TS below node_modules.
    const ceilingApi=pluginPath?await createJiti(import.meta.url,{moduleCache:false}).import<{registerSubagentCapabilityCeiling(options:{sessionId:string;source:string;ceiling:{allowedTools:string[];denyExtensions:boolean}}):{dispose():void}}>(join(pluginPath,"src","api","capability-ceiling.ts")):undefined;
    const ceiling=ceilingApi?.registerSubagentCapabilityCeiling({sessionId:session.sessionId,source:"sakura-benchmark",ceiling:{allowedTools:task.verification.readOnly?tools.filter(tool=>!["write","edit"].includes(tool)):tools,denyExtensions:true}});
    if(ceiling) row.communityCeiling={allowedTools:task.verification.readOnly?tools.filter(tool=>!["write","edit"].includes(tool)):tools,denyExtensions:true};
    const receipts:unknown[]=[];
    const observer=observeAgent(session,{agentId:"baseline"});const readAttempts=new Map<string,string>();const unobserveReads=session.subscribe(event=>{if(event.type==="tool_execution_start"&&event.toolName==="read"&&typeof event.args.path==="string")readAttempts.set(event.toolCallId,event.args.path);if(event.type==="tool_execution_end"){const path=readAttempts.get(event.toolCallId);readAttempts.delete(event.toolCallId);if(path&&!event.isError)filesRead.add(logicalReadPath(workspace,path));if(event.toolName==="subagent")receipts.push(event.result?.details);}if(event.type==="message_end"&&event.message.role==="assistant"&&typeof event.message.usage?.input==="number")contextTokens=Math.max(contextTokens??0,event.message.usage.input+(event.message.usage.cacheRead??0));});
    const abort=()=>{void session.abort();};controller.signal.addEventListener("abort",abort,{once:true});agentCalls++;
    try {controller.signal.throwIfAborted();await session.prompt(task.task.description);controller.signal.throwIfAborted();const failure=providerFailure(session.messages);if(failure)throw new Error(failure);resultText=lastAssistantText(session.messages);}
    finally {controller.signal.removeEventListener("abort",abort);if(controller.signal.aborted)await session.abort();await atomicWrite(join(trialDir,"messages.json"),JSON.stringify(session.messages,null,2));const usage=observer.usage();toolCalls=usage.toolCalls;tokensIn=usage.tokensIn;tokensOut=usage.tokensOut;observer.unsubscribe();unobserveReads();ceiling?.dispose();session.dispose();if(pluginPath){const children=await communityMetrics(receipts,`${model.provider}/${model.id}`);await atomicWrite(join(trialDir,"community-receipts.json"),JSON.stringify(receipts,null,2));row.communityMetrics=children;row.metricsScope=children.complete?"complete":"root-only";toolCalls+=children.toolCalls;agentCalls+=children.agentCalls;tokensIn=tokensIn===undefined?undefined:tokensIn+children.tokensIn;tokensOut=tokensOut===undefined?undefined:tokensOut+children.tokensOut;contextTokens=children.contextTokens===undefined?contextTokens:Math.max(contextTokens??0,children.contextTokens);for(const path of children.paths)filesRead.add(logicalReadPath(workspace,path));row.retries=children.retries;}else row.metricsScope="complete";row={...row,toolCalls,tokensIn,tokensOut,agentCalls,filesRead:filesRead.size,contextTokens,contextTokenMeasurement:"Pi assistant usage peak(input + cacheRead)",replans:0,retries:row.retries??0,conflicts:0};}
  } else {
    const config=structuredClone(await loadConfig(workspace));config.runtime.localOnly=true;config.workspace.taskIsolation=true;
    // Fixture verification commands are trusted and identical for every variant.
    // Model tool access stays restricted to the same six non-shell builtins.
    config.policy.network="allow";
    if(trial.variant==="no-repo") config.repository.indexOnRun=false;
    if(trial.variant==="no-worktree") {config.workspace.mode="in-place";config.workspace.taskIsolation=false;}
    if(trial.variant==="no-experience") config.experience.enabled=false;
    const planner=trial.variant==="fixed-plan"?createHeuristicPlanner():undefined;
    const outcome=await runSakuraTaskOnce({cwd:workspace,task:task.task.description,files:task.task.hintFiles,config,planner,plannerTransform:trial.variant==="no-multi"?singleAgentPlan:undefined,signal:controller.signal,agentConfig:{model,modelRuntime,settingsManager,thinkingLevel:"off",allowedTools:tools},onEvent:event=>{if(event.type==="file.read")filesRead.add(logicalReadPath(workspace,event.path));if(event.type==="task.finished"&&event.status==="pending")retries++;if(event.type==="model.usage"&&event.input!==undefined)contextTokens=Math.max(contextTokens??0,event.input+(event.cacheRead??0));}});
    resultText=Object.values(outcome.result?.graph.nodes??{}).map(node=>node.result?.summary??"").join("\n");row.execution=outcome.executionStatus;row.replans=outcome.metrics.replans;row.retries=retries;
    toolCalls=outcome.metrics.toolCalls;tokensIn=outcome.metrics.tokensIn;tokensOut=outcome.metrics.tokensOut;agentCalls=outcome.metrics.agents;
    row={...row,toolCalls,tokensIn,tokensOut,agentCalls,filesRead:filesRead.size,contextTokens,contextTokenMeasurement:"Pi assistant usage peak(input + cacheRead)"};
    await mkdir(trialDir,{recursive:true});const {cp}=await import("node:fs/promises");await cp(outcome.traceDir,join(trialDir,"sakura-run"),{recursive:true});
    try {const records=await readdir(join(outcome.traceDir,"integrations"));row.conflicts=(await Promise.all(records.filter(name=>name.endsWith(".json")).map(async name=>JSON.parse(await readFile(join(outcome.traceDir,"integrations",name),"utf8"))))).filter(record=>record.status==="conflict").length;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")row.conflicts=0;else throw error;}
    if(outcome.error) throw new Error(outcome.error);
    if(outcome.artifactPath) {const {readArtifact}=await import("../../src/workspace/apply-artifact.ts");const artifact=await readArtifact(outcome.artifactPath);if(artifact.patch && config.workspace.mode!=="in-place") await exec("git",["apply","--check","--binary",artifact.patchPath],{cwd:workspace}).then(()=>exec("git",["apply","--binary",artifact.patchPath],{cwd:workspace}));}
    const pack=JSON.parse(await readFile(join(outcome.traceDir,"context-pack.json"),"utf8"));row.contextPackTokens=pack.estimatedTokens;row.contextPackEstimator=pack.estimator;
    row.experienceSources=pack.selected.filter((item:{source:string})=>item.source.startsWith("experience-"));
    if(outcome.executionStatus!=="succeeded") throw new Error("Sakura task execution failed; see retained run evidence");
  }
  row={...row,toolCalls,tokensIn,tokensOut,agentCalls,filesRead:filesRead.size};
  const changes=await captureChanges(workspace,trial.baseCommit);await saveArtifact(trialDir,"result",changes);
  const checks=await verify({cwd:workspace,commands:task.verification.commands,signal:controller.signal,run:createShellCommandRunner()});row.verification=checks;
  const fixedChecks=await judge.run(controller.signal);row.fixedVerification=fixedChecks;
  await atomicWrite(join(trialDir,"fixed-check.mjs"),judge.source);
  await atomicWrite(join(trialDir,"fixed-tsconfig.json"),JSON.stringify(judge.config,null,2));
  await atomicWrite(join(trialDir,"answer.txt"),resultText);
  const readOnlyOk=!task.verification.readOnly || readOnlyVerdict({diff:changes.diff,answer:resultText,findingPattern:task.verification.findingPattern,locationPattern:task.verification.locationPattern});
  row.status=checks.passed&&fixedChecks.passed&&readOnlyOk&&(task.verification.readOnly||changes.changedFiles.length>0)?"passed":"failed";
 } catch(error) {row.status=timedOut?"failed":controller.signal.aborted?"cancelled":trial.variant==="pi-community"&&String(error).includes("ENOENT")?"setup_failed":"failed";row.error=String(error);row.termination=timedOut?"timeout":controller.signal.aborted?"user-cancel":"error";}
 finally {clearTimeout(timer);activeController=undefined;await judge?.dispose();row.durationMs=Date.now()-started;if(row.status!=="passed"||args.includes("--keep-workspaces")) row.workspaceRetained=workspace;trials.push(row);await atomicWrite(join(trialDir,"trial.json"),JSON.stringify(row,null,2));await atomicWrite(output,JSON.stringify({metadata,trials,summary:summarizeTrials(trials),complete:trials.length===matrix.length,interrupted},null,2));if(row.status==="passed"&&!args.includes("--keep-workspaces")) await rm(workspace,{recursive:true,force:true});}
}
console.log(JSON.stringify({report:output,executed:trials.length,planned:matrix.length,complete:trials.length===matrix.length,summary:summarizeTrials(trials)},null,2));
process.removeListener("SIGINT",interrupt);process.removeListener("SIGTERM",interrupt);
process.exitCode=interrupted?130:trials.length===matrix.length&&trials.every(trial=>trial.status==="passed")?0:1;
