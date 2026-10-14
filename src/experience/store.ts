/**
 * Experience Store。架构文档 §15。
 *
 * 本地原子 JSON 快照；兼容读取历史 JSONL，按事实内容去重。
 * 存的是“症状 → 失败尝试 → 成功动作”，不是模型自动改 system prompt。
 */

import { mkdir, readFile,open,unlink,stat } from "node:fs/promises";
import { atomicWrite } from "../storage/atomic.ts";
import { createHash } from "node:crypto";
import { join } from "node:path";

export interface Experience {
	id: string;
	problemPattern: string;
	symptoms: string[];
	failedAttempts: string[];
	successfulActions: string[];
	usefulTools: string[];
	relevantFiles: string[];
	verificationEvidence: string[];
	tags: string[];
	createdAt: number;
	runId?:string;
	traceDir?:string;
	sourceRuns?:Array<{runId:string;traceDir?:string}>;
	lastSeenAt?:number;
}

export interface ExperienceStore {
	add(experience: Experience): Promise<string>;
	all(): Promise<Experience[]>;
}

const queues=new Map<string,Promise<unknown>>();
async function lock(file:string) {
  for(let attempt=0;attempt<200;attempt++) {
    try {const handle=await open(file,"wx");await handle.writeFile(JSON.stringify({pid:process.pid}));await handle.close();return async()=>{await unlink(file).catch(()=>{});};}
    catch(error) {
      if((error as NodeJS.ErrnoException).code!=="EEXIST") throw error;
      try {const owner=JSON.parse(await readFile(file,"utf8"));try{process.kill(owner.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH") await unlink(file).catch(()=>{});}}
      catch(error) {if(error instanceof SyntaxError && Date.now()-(await stat(file)).mtimeMs>30000) await unlink(file).catch(()=>{});}
      await new Promise(resolve=>setTimeout(resolve,10));
    }
  }
  throw new Error("Experience store is busy; refusing to overwrite concurrent evidence");
}
const fingerprint=(item:Experience)=>createHash("sha256").update(JSON.stringify({pattern:item.problemPattern,symptoms:item.symptoms,failed:item.failedAttempts,actions:item.successfulActions,files:item.relevantFiles,evidence:item.verificationEvidence.map(line=>line.replace(/ \d+ms/g,""))})).digest("hex");
export function createExperienceStore(rootDir:string):ExperienceStore {
  const dir=join(rootDir,".sakura","experience"),file=join(dir,"experiences.json");
  async function all():Promise<Experience[]> {
    try {const items=JSON.parse(await readFile(file,"utf8"));if(!Array.isArray(items)) throw new Error("Invalid experience snapshot");return items;}
    catch(error) {
      if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;
      try {return (await readFile(join(dir,"experiences.jsonl"),"utf8")).split("\n").filter(Boolean).map(line=>JSON.parse(line));}
      catch(error) {if((error as NodeJS.ErrnoException).code==="ENOENT") return [];throw error;}
    }
  }
  return {all,async add(experience) {
    const result=(queues.get(file) ?? Promise.resolve()).then(async()=>{
      await mkdir(dir,{recursive:true});const release=await lock(file+".lock");
      try {
      const items=await all(),existing=items.find(item=>item.id===experience.id || fingerprint(item)===fingerprint(experience));
      if(existing) {
        const sources=[...(existing.sourceRuns ?? []),...(existing.runId ? [{runId:existing.runId,traceDir:existing.traceDir}] : []),...(experience.runId ? [{runId:experience.runId,traceDir:experience.traceDir}] : [])];
        existing.sourceRuns=[...new Map(sources.map(source=>[source.runId,source])).values()];existing.lastSeenAt=experience.createdAt;
      } else items.push(experience);
      await mkdir(dir,{recursive:true});await atomicWrite(file,JSON.stringify(items,null,2)+"\n");return existing?.id ?? experience.id;
      } finally {await release();}
    });
    queues.set(file,result.then(()=>undefined,()=>undefined));return result;
  }};
}
