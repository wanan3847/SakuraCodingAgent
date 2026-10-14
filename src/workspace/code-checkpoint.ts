import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,writeFile,readdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {atomicWrite} from '../storage/atomic.ts';
import {captureChanges,type WorkspaceChanges} from './artifacts.ts';
const exec=promisify(execFile);
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export async function resolveCheckpoint(cwd:string,input?:string):Promise<string>{
 if(input?.trim())return resolve(cwd,input.trim());
 const dir=join(cwd,'.sakura','checkpoints');
 const names=await readdir(dir).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
 const entries=await Promise.all(names.filter(name=>name.endsWith('.json')).map(async name=>({path:join(dir,name),entry:JSON.parse(await readFile(join(dir,name),'utf8'))})));
 const selected=entries.filter(item=>['applied','applying'].includes(item.entry.status)).sort((a,b)=>b.entry.createdAt-a.entry.createdAt||a.path.localeCompare(b.path))[0];
 if(!selected)throw new Error('没有可撤销的代码检查点');
 return selected.path;
}
/** Save a delta for native write/edit paths, preserving preexisting user changes. */
export async function saveCodeCheckpoint(cwd:string,before:WorkspaceChanges,files:string[]):Promise<string|undefined>{
 const after=await captureChanges(cwd,before.baseCommit);
 if(before.diff===after.diff||!files.length)return undefined;
 const temporary=await mkdtemp(join(tmpdir(),'sakura-checkpoint-'));
 const env={...process.env,GIT_INDEX_FILE:join(temporary,'index')};
 const git=async(...args:string[])=>(await exec('git',args,{cwd,env,maxBuffer:256*1024*1024})).stdout;
 try{
  const tree=async(patch:string)=>{await git('read-tree',before.baseCommit);if(patch){const file=join(temporary,'snapshot.diff');await writeFile(file,patch);await git('apply','--cached','--binary',file);}return (await git('write-tree')).trim();};
  const beforeTree=await tree(before.diff),afterTree=await tree(after.diff);
  const patch=await git('diff','--binary','--full-index','--no-renames',beforeTree,afterTree,'--',...files.map(file=>`:(literal)${file}`));
  if(!patch)return undefined;
  const id=`tui-${randomUUID()}`,directory=join(cwd,'.sakura','checkpoints'),patchFile=join(directory,`${id}.diff`),path=join(directory,`${id}.json`);
  const staged=(await exec('git',['diff','--cached','--binary'],{cwd,maxBuffer:256*1024*1024})).stdout;
  await atomicWrite(patchFile,patch);
  await atomicWrite(path,JSON.stringify({version:1,status:'applied',baseCommit:before.baseCommit,beforeTree,patchFile,patchSha256:hash(patch),workspaceSha256:hash(after.diff),stagedSha256:hash(staged),createdAt:Date.now(),source:'native-write-edit'},null,2));
  return path;
 }finally{await rm(temporary,{recursive:true,force:true});}
}
