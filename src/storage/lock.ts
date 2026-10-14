import {mkdir,readFile,writeFile,rm} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";
import {atomicWrite} from "./atomic.ts";
/** Cross-process exclusion. Never evict a live owner based on elapsed time. */
export async function withFileLock<T>(path:string,operation:()=>Promise<T>):Promise<T>{
 const token=randomUUID(),started=Date.now();
 while(true){
  try{await mkdir(path);await atomicWrite(`${path}/owner.json`,JSON.stringify({pid:process.pid,token}));break;}
  catch(error){
   if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
   try{const owner=JSON.parse(await readFile(`${path}/owner.json`,"utf8"));
    if(!Number.isSafeInteger(owner.pid)||owner.pid<1)throw new Error("Invalid lock owner");
    try{process.kill(owner.pid,0);}catch(dead){if((dead as NodeJS.ErrnoException).code==="ESRCH"){
     // Serialize reclamation too: two waiters must not remove a newly acquired lock.
     const reap=`${path}.reap`;
     try{await mkdir(reap);}catch(busy){if((busy as NodeJS.ErrnoException).code==="EEXIST"){await delay(20);continue;}throw busy;}
     try{const current=JSON.parse(await readFile(`${path}/owner.json`,"utf8"));try{process.kill(current.pid,0);}catch(stillDead){if((stillDead as NodeJS.ErrnoException).code==="ESRCH")await rm(path,{recursive:true});}}catch(missing){if((missing as NodeJS.ErrnoException).code!=="ENOENT")throw missing;}finally{await rm(reap,{recursive:true});}
     continue;
    }}
   }catch(error){if(!["ENOENT"].includes((error as NodeJS.ErrnoException).code??""))throw error;}
   if(Date.now()-started>30000)throw new Error(`Control lock timeout: ${path}`);
   await delay(20);
  }
 }
 try{return await operation();}
 finally{const owner=JSON.parse(await readFile(`${path}/owner.json`,"utf8"));if(owner.token!==token)throw new Error("Control lock ownership changed");await rm(path,{recursive:true});}
}
