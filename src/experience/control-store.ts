import {homedir} from "node:os";
import {createHash} from "node:crypto";
import {realpath,mkdir,readFile,lstat} from "node:fs/promises";
import {join,resolve,relative,isAbsolute} from "node:path";
import {atomicWrite} from "../storage/atomic.ts";
import {withFileLock} from "../storage/lock.ts";
import type {SkillCandidate} from "./skill-candidates.ts";
import type {SkillEvidence} from "../skills/loader.ts";
export interface ControlOptions{controlDir?:string}
export const controlDirectory=(options:ControlOptions={})=>resolve(options.controlDir??join(homedir(),".sakura-control-credentials"));
export const digest=(value:string|Uint8Array)=>createHash("sha256").update(value).digest("hex");
export interface RunReceipt{root:string;runDir:string;runId:string;task:string;baseCommit?:string;model:string;settingsSha256:string;stateSha256:string;packSha256:string;skills:SkillEvidence[];verified:boolean;protectedExecution:boolean;metrics:Record<string,unknown>;externalVerification?:{passed:boolean;sha256:string}}
export interface ActiveSkill{candidateId:string;name:string;version:number;sha256:string;path:string}
export interface Ledger{schema:1;root:string;names:Record<string,string>;candidates:Record<string,{latest:number;versions:Record<string,SkillCandidate>}>;runs:Record<string,RunReceipt>;active:Record<string,ActiveSkill>;mirrorsPending?:boolean;pending?:{candidate:SkillCandidate;active:ActiveSkill;source:string}}
export function isWithin(root:string,path:string){const part=relative(root,path);return part===""||(!isAbsolute(part)&&part!==".."&&!part.startsWith("../"));}
/** The trusted host owns this directory, not repository configuration or model tools. */
export async function withControl<T>(root:string,options:ControlOptions,operation:(ledger:Ledger,commit:()=>Promise<void>)=>Promise<T>):Promise<T>{
 root=await realpath(root);const control=controlDirectory(options);
 await mkdir(control,{recursive:true,mode:0o700});
 const owner=await lstat(control);
 if(owner.isSymbolicLink()||isWithin(root,await realpath(control)))throw new Error("Control authority must be outside the Agent workspace and not a symlink");
 if((owner.mode&0o077)!==0||(process.getuid&&owner.uid!==process.getuid()))throw new Error("Control authority requires private owner-only permissions");
 const directory=join(control,digest(root));await mkdir(directory,{recursive:true,mode:0o700});
 if((await lstat(directory)).isSymbolicLink())throw new Error("Unsafe control directory");
 return withFileLock(join(directory,"lock"),async()=>{
  const file=join(directory,"ledger.json");let ledger:Ledger;
  try{if((await lstat(file)).isSymbolicLink())throw new Error("Control ledger cannot be a symlink");ledger=JSON.parse(await readFile(file,"utf8"));if(ledger.schema!==1||ledger.root!==root)throw new Error("Invalid control authority");}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;ledger={schema:1,root,names:{},candidates:{},runs:{},active:{}};}
  return operation(ledger,()=>atomicWrite(file,JSON.stringify(ledger,null,2)));
 });
}
/** Called by the host runtime after native execution; project state is not an authority. */
export async function recordTrustedRun(root:string,receipt:Omit<RunReceipt,"root">,options:ControlOptions={}){
 return withControl(root,options,async(ledger,commit)=>{if(ledger.runs[receipt.runId])throw new Error("Run receipt is immutable");ledger.runs[receipt.runId]={...receipt,root:ledger.root};await commit();});
}
/** Trusted fixed judge only; can disqualify a run, never turn a failed native run into success. */
export async function certifyRunVerification(root:string,runId:string,result:import("../verification/verifier.ts").VerificationResult,options:ControlOptions={}){
 return withControl(root,options,async(ledger,commit)=>{const run=ledger.runs[runId];if(!run||run.externalVerification)throw new Error("Unknown run or immutable external verification");run.externalVerification={passed:result.passed,sha256:digest(JSON.stringify(result))};run.verified=run.verified&&result.passed;await commit();});
}
