import {randomUUID} from "node:crypto";
import {readFile,realpath,lstat} from "node:fs/promises";
import {join,resolve} from "node:path";
import {atomicWrite} from "../storage/atomic.ts";
import {loadRunState} from "../runtime/run-state.ts";
import {createExperienceStore} from "./store.ts";
import {withControl,digest,controlDirectory,type ControlOptions,type Ledger,type ActiveSkill,type RunReceipt} from "./control-store.ts";
export interface SkillCandidate{
 id:string;name:string;description:string;body:string;version:number;sha256:string;experienceIds:string[];
 stage:"candidate"|"evaluated"|"reviewed"|"promoted";
 evaluation?:{runDir:string;runId:string;sha256:string;at:number};
 review?:{reviewer:string;sha256:string;approved:boolean;at:number;mode:"human"|"user-authorized"};promotedAt?:number;
 effectEvaluation?:{sha256:string;pairs:Array<{baselineRunId:string;candidateRunId:string}>;baseline:Record<string,number>;candidate:Record<string,number>;eligible:boolean;at:number;policy:string};
}
export interface CandidateOptions extends ControlOptions{expectedSha256?:string;fault?:(point:"journaled"|"skill-written"|"committed")=>Promise<void>}
export const renderSkill=(c:Pick<SkillCandidate,"name"|"description"|"body">)=>`---\nname: ${c.name}\ndescription: ${JSON.stringify(c.description)}\n---\n\n${c.body}\n`;
export const artifactHash=(c:Pick<SkillCandidate,"name"|"description"|"body">)=>digest(renderSkill(c));
function metadata(v:Pick<SkillCandidate,"name"|"description"|"body"|"experienceIds">){
 if(!/^sakura-learned-[a-z0-9-]+$/.test(v.name)||v.name.length>64||typeof v.description!=="string"||!v.description.trim()||v.description.length>1024||typeof v.body!=="string"||!v.body.trim()||!Array.isArray(v.experienceIds)||!v.experienceIds.length||v.experienceIds.some(id=>typeof id!=="string"||!id))throw new Error("Invalid candidate skill metadata");
}
function validate(c:SkillCandidate,id:string){
 metadata(c);
 if(c.id!==id||!Number.isSafeInteger(c.version)||c.version<1||!["candidate","evaluated","reviewed","promoted"].includes(c.stage)||artifactHash(c)!==c.sha256)throw new Error("Candidate artifact checksum or schema mismatch");
 if(c.stage!=="candidate"&&(!c.evaluation||c.evaluation.sha256!==c.sha256||typeof c.evaluation.runDir!=="string"||typeof c.evaluation.runId!=="string"||!Number.isFinite(c.evaluation.at)))throw new Error("Invalid candidate evaluation schema");
 if(["reviewed","promoted"].includes(c.stage)&&(!c.review?.approved||c.review.sha256!==c.sha256||typeof c.review.reviewer!=="string"||!c.review.reviewer.trim()||!["human","user-authorized"].includes(c.review.mode)||!Number.isFinite(c.review.at)))throw new Error("Invalid candidate review schema");
}
function paths(root:string,id:string,version?:number){
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw new Error("Invalid candidate id");
 if(version!==undefined&&(!Number.isSafeInteger(version)||version<1))throw new Error("Invalid candidate version");
 return join(root,".sakura","skill-candidates",id,version?`v${version}.json`:"latest.json");
}
const replay=(root:string,c:SkillCandidate)=>join(root,".sakura","skill-candidates",c.id,`replay-v${c.version}`,c.name,"SKILL.md");
async function safeParents(root:string,target:string){let path=root;for(const part of target.slice(root.length+1).split("/")){path=join(path,part);try{if((await lstat(path)).isSymbolicLink())throw new Error("Symlink in managed skill path");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}}}
async function exists(path:string){try{await lstat(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;return false;}}
async function mirrors(l:Ledger){
 for(const record of Object.values(l.candidates)){
  for(const c of Object.values(record.versions)){await safeParents(l.root,paths(l.root,c.id,c.version));await safeParents(l.root,replay(l.root,c));await atomicWrite(paths(l.root,c.id,c.version),JSON.stringify(c,null,2));await atomicWrite(replay(l.root,c),renderSkill(c));}
  await atomicWrite(paths(l.root,record.versions[record.latest].id),JSON.stringify(record.versions[record.latest],null,2));
 }
 for(const active of Object.values(l.active))await atomicWrite(join(l.root,".sakura","skill-candidates",active.candidateId,"active.json"),JSON.stringify(active,null,2));
}
async function recover(l:Ledger,commit:()=>Promise<void>){
 if(l.pending){
  const {candidate:c,active,source}=l.pending;validate(c,c.id);
  if(active.path!==join(l.root,".pi","skills",c.name,"SKILL.md")||active.candidateId!==c.id||active.sha256!==artifactHash(c)||digest(source)!==active.sha256||l.names[active.name]!==c.id)throw new Error("Invalid publication journal");
  await safeParents(l.root,active.path);
  if(await exists(active.path)){const actual=digest(await readFile(active.path,"utf8")),previous=l.active[active.name];if(actual!==active.sha256&&(!previous||previous.candidateId!==c.id||actual!==previous.sha256))throw new Error("Skill publication conflict during recovery");}
  await atomicWrite(active.path,source);l.active[active.name]=active;l.candidates[c.id].versions[c.version]=c;delete l.pending;l.mirrorsPending=true;await commit();
 }
 if(l.mirrorsPending){await mirrors(l);delete l.mirrorsPending;await commit();}
}
async function access<T>(root:string,o:CandidateOptions,op:(l:Ledger,commit:()=>Promise<void>)=>Promise<T>){return withControl(root,o,async(l,commit)=>{await recover(l,commit);return op(l,commit);});}
async function current(l:Ledger,id:string,version?:number){
 paths(l.root,id,version);const record=l.candidates[id],c=record?.versions[version??record.latest];
 if(!c)throw new Error("Candidate has no trusted control authority; legacy project JSON cannot authorize publication");validate(c,id);
 const mirror=JSON.parse(await readFile(paths(l.root,id,version),"utf8"));validate(mirror,id);
 if(JSON.stringify(mirror)!==JSON.stringify(c))throw new Error("Candidate mirror differs from trusted control authority");
 if(digest(await readFile(replay(l.root,c),"utf8"))!==c.sha256)throw new Error("Candidate replay artifact changed");return structuredClone(c);
}
async function save(l:Ledger,commit:()=>Promise<void>,c:SkillCandidate){l.candidates[c.id].versions[c.version]=c;l.mirrorsPending=true;await commit();await recover(l,commit);return c;}
export async function loadCandidate(root:string,id:string,version?:number,o:CandidateOptions={}){return access(root,o,l=>current(l,id,version));}
export async function proposeCandidate(root:string,input:{name:string;description:string;body:string;experienceIds:string[];id?:string},o:CandidateOptions={}){
 metadata(input);return access(root,o,async(l,commit)=>{
  const experiences=await createExperienceStore(l.root).all();if(input.experienceIds.some(id=>!experiences.some(e=>e.id===id)))throw new Error("Candidate must reference existing experience evidence");
  const previous=input.id?await current(l,input.id):undefined,id=previous?.id??randomUUID();if(previous&&previous.name!==input.name)throw new Error("Candidate name is immutable");
  if(l.names[input.name]&&l.names[input.name]!==id)throw new Error("Skill name is owned by another candidate");
  const formal=join(l.root,".pi","skills",input.name);await safeParents(l.root,formal);if(await exists(formal)&&l.active[input.name]?.candidateId!==id)throw new Error("Existing skill is not owned by this candidate");
  const c:SkillCandidate={id,name:input.name,description:input.description,body:input.body,experienceIds:[...input.experienceIds],version:(previous?.version??0)+1,sha256:artifactHash(input),stage:"candidate"};
  l.names[input.name]=id;l.candidates[id]??={latest:0,versions:{}};l.candidates[id].latest=c.version;return save(l,commit,c);
 });
}
export async function evaluateCandidate(root:string,id:string,runDir:string,o:CandidateOptions={}){
 return access(root,o,async(l,commit)=>{
  const c=await current(l,id),state=await loadRunState(runDir),receipt=l.runs[state.runId];
  if(!receipt||receipt.runDir!==await realpath(runDir)||receipt.root!==l.root||!receipt.verified||!receipt.protectedExecution||receipt.stateSha256!==digest(await readFile(join(runDir,"state.json"),"utf8"))||receipt.packSha256!==digest(await readFile(join(runDir,"context-pack.json"),"utf8")))throw new Error("Evaluation requires trusted verified run evidence and protected execution");
  if(!["ready_to_apply","applied"].includes(state.phase??"")||!Object.keys(state.graph.nodes).length||!state.verification.at(-1)?.passed||Object.values(state.graph.nodes).some(n=>n.status!=="succeeded"))throw new Error("Evaluation requires a verified run");
  if(!receipt.skills.some(e=>e.name===c.name&&e.sourcePath===resolve(replay(l.root,c))&&e.sha256===c.sha256&&e.fullyIncluded))throw new Error("Candidate artifact version was not fully selected");
  return save(l,commit,{...c,stage:"evaluated",evaluation:{runDir:receipt.runDir,runId:state.runId,sha256:c.sha256,at:Date.now()},review:undefined});
 });
}
/** Trusted operator CLI only. Labels provide attribution, not authentication. */
export async function reviewCandidate(root:string,id:string,reviewer:string,approved:boolean,o:CandidateOptions={},mode:"human"|"user-authorized"="human"){
 return access(root,o,async(l,commit)=>{const c=await current(l,id);if(o.expectedSha256&&o.expectedSha256!==c.sha256)throw new Error("Operator approved a different artifact version");if(!reviewer?.trim()||c.stage!=="evaluated"||c.evaluation?.sha256!==c.sha256)throw new Error("Review requires current trusted evaluation and explicit operator authorization");if(mode==="user-authorized"&&(!c.effectEvaluation?.eligible||c.effectEvaluation.sha256!==c.sha256))throw new Error("Automatic user-authorized approval requires eligible paired effect evaluation");return save(l,commit,{...c,stage:approved?"reviewed":"evaluated",review:{reviewer,approved,sha256:c.sha256,at:Date.now(),mode}});});
}
/** Accept run IDs only; all outcomes and metrics come from the host's external ledger. */
export async function assessCandidateEffect(root:string,id:string,pairs:Array<{baselineRunId:string;candidateRunId:string}>,o:CandidateOptions={}){
 return access(root,o,async(l,commit)=>{
  const c=await current(l,id);if(c.stage!=="evaluated"||c.evaluation?.sha256!==c.sha256)throw new Error("Effect evaluation requires current candidate evaluation");
  const seen=new Set<string>(),tasks=new Map<string,number>(),baseline:RunReceipt[]=[],candidate:RunReceipt[]=[];
  for(const pair of pairs){
   const b=l.runs[pair.baselineRunId],a=l.runs[pair.candidateRunId];
   if(!b||!a||seen.has(b.runId)||seen.has(a.runId)||b.runId===a.runId||!b.protectedExecution||!a.protectedExecution||!b.externalVerification||!a.externalVerification||b.model==="unresolved"||b.model!==a.model||b.settingsSha256!==a.settingsSha256||(baseline[0]&&(b.model!==baseline[0].model||b.settingsSha256!==baseline[0].settingsSha256))||b.task!==a.task||!b.baseCommit||b.baseCommit!==a.baseCommit||b.skills.some(e=>e.name===c.name)||!a.skills.some(e=>e.name===c.name&&e.sha256===c.sha256&&e.fullyIncluded&&e.sourcePath===resolve(replay(l.root,c))))throw new Error("Invalid or unequal baseline/candidate run pair");
   for(const run of [b,a])for(const key of ["toolCalls","tokensIn","tokensOut","startedAt","endedAt"])if(typeof run.metrics[key]!=="number"||!Number.isFinite(run.metrics[key])||Number(run.metrics[key])<0)throw new Error("Incomplete paired metrics");
   seen.add(b.runId);seen.add(a.runId);tasks.set(b.task,(tasks.get(b.task)??0)+1);baseline.push(b);candidate.push(a);
  }
  const aggregate=(rows:typeof baseline)=>({runs:rows.length,passed:rows.filter(r=>r.verified).length,toolCalls:rows.reduce((sum,r)=>sum+Number(r.metrics.toolCalls),0),tokens:rows.reduce((sum,r)=>sum+Number(r.metrics.tokensIn)+Number(r.metrics.tokensOut),0),durationMs:rows.reduce((sum,r)=>sum+Number(r.metrics.endedAt)-Number(r.metrics.startedAt),0)});
  const b=aggregate(baseline),a=aggregate(candidate),eligible=tasks.size>=2&&[...tasks.values()].every(n=>n>=3)&&a.passed===a.runs&&a.passed>=b.passed&&a.tokens<=b.tokens&&a.toolCalls<=b.toolCalls&&(a.passed>b.passed||a.tokens<b.tokens||a.toolCalls<b.toolCalls);
  return save(l,commit,{...c,effectEvaluation:{sha256:c.sha256,pairs,baseline:b,candidate:a,eligible,at:Date.now(),policy:"At least two tasks, three pairs each; all candidate runs pass; no aggregate token/tool regression; at least one strict improvement. Local evidence only; no claim of general benefit."}});
 });
}
async function publish(l:Ledger,commit:()=>Promise<void>,c:SkillCandidate,o:CandidateOptions){
 if(!["reviewed","promoted"].includes(c.stage)||!c.review?.approved||c.review.sha256!==c.sha256||c.evaluation?.sha256!==c.sha256)throw new Error("Promotion requires trusted evaluation and explicit operator review of this version");
 const path=join(l.root,".pi","skills",c.name,"SKILL.md"),previous=l.active[c.name];await safeParents(l.root,path);
 if(await exists(join(l.root,".pi","skills",c.name))&&(!previous||previous.candidateId!==c.id||!await exists(path)||digest(await readFile(path,"utf8"))!==previous.sha256))throw new Error("Existing skill ownership or artifact conflict");
 const candidate={...c,stage:"promoted" as const,promotedAt:Date.now()},active:ActiveSkill={candidateId:c.id,name:c.name,version:c.version,sha256:c.sha256,path};
 l.pending={candidate,active,source:renderSkill(c)};await commit();await o.fault?.("journaled");await atomicWrite(path,renderSkill(c));await o.fault?.("skill-written");await recover(l,commit);await o.fault?.("committed");return candidate;
}
export async function promoteCandidate(root:string,id:string,o:CandidateOptions={}){return access(root,o,async(l,commit)=>publish(l,commit,await current(l,id),o));}
export async function rollbackCandidate(root:string,id:string,version:number,o:CandidateOptions={}){return access(root,o,async(l,commit)=>{const c=await current(l,id,version);if(c.stage!=="promoted")throw new Error("Rollback target was not previously promoted");return publish(l,commit,c,o);});}
/** latest is newest created version; active is independently checked against actual skill bytes. */
async function activeSkill(l:Ledger,name:string){
 if(!/^sakura-learned-[a-z0-9-]+$/.test(name))throw new Error("Invalid skill name");const active=l.active[name];if(!active)throw new Error("No active skill");
 const c=l.candidates[active.candidateId]?.versions[active.version];if(!c||l.names[name]!==c.id||active.name!==name||active.path!==join(l.root,".pi","skills",name,"SKILL.md")||c.sha256!==active.sha256||c.stage!=="promoted")throw new Error("Active skill ownership mismatch");validate(c,c.id);
 await safeParents(l.root,active.path);if(digest(await readFile(active.path,"utf8"))!==active.sha256)throw new Error("Active skill artifact mismatch");return structuredClone(active);
}
export async function loadActiveSkill(root:string,name:string,o:CandidateOptions={}){return access(root,o,l=>activeSkill(l,name));}
export async function loadActiveSkills(root:string,o:CandidateOptions={}){return access(root,o,l=>Promise.all(Object.keys(l.active).map(name=>activeSkill(l,name))));}
export async function existingActiveSkills(root:string,o:CandidateOptions={}){
 const ledger=join(controlDirectory(o),digest(await realpath(root)),"ledger.json");
 if(!await exists(ledger))return [];
 return loadActiveSkills(root,o);
}
