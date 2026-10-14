import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {evaluateAction} from './guard.ts';
const exec=promisify(execFile);
/** Let Git parse binary/mode/rename patches; do not split untrusted diff text with regex. */
export async function selectPatch(cwd:string,base:string,patch:string,files?:string[]):Promise<{patch:string;files:string[]}>{
 const dir=await mkdtemp(join(tmpdir(),'sakura-select-'));
 const env={...process.env,GIT_INDEX_FILE:join(dir,'index')};
 const git=async(...args:string[])=>(await exec('git',args,{cwd,env,maxBuffer:256*1024*1024})).stdout;
 try{
  const path=join(dir,'patch.diff');await writeFile(path,patch);
  await git('read-tree',base);
  if(patch)await git('apply','--cached','--binary',path);
  const actual=(await git('diff','--cached','--name-only','-z',base)).split('\0').filter(Boolean);
  for(const file of actual){const decision=await evaluateAction({workspacePath:cwd},{agentId:'apply',tool:'write',kind:'write',path:resolve(cwd,file)});if(decision.type!=='allow')throw new Error(`Artifact path refused: ${file}: ${decision.reason}`);}
  const selected=files?[...new Set(files)]:actual;
  if(files&&(!selected.length||selected.some(file=>!actual.includes(file))))throw new Error('Select existing changed file paths');
  const filtered=selected.length?await git('diff','--cached','--binary','--full-index','--no-renames',base,'--',...selected.map(file=>`:(literal)${file}`)):'';
  return {patch:filtered,files:selected};
 }finally{await rm(dir,{recursive:true,force:true});}
}
