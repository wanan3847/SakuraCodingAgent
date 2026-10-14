import {existsSync, readFileSync, realpathSync, statSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname, join, relative, resolve, isAbsolute} from 'node:path';

export interface InstructionFile {path:string; content:string}
const within=(root:string,path:string)=>{const part=relative(root,path);return !isAbsolute(part)&&part!=='..'&&!part.startsWith('../');};
/** Project instructions are data, never a source of tool privileges. Stop at the Git root. */
export function projectInstructions(cwd:string,agentDir?:string,maxBytes=32768):InstructionFile[]{
 const current=realpathSync(cwd);let root=current;
 try{root=realpathSync(execFileSync('git',['rev-parse','--show-toplevel'],{cwd:current,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim());}catch{}
 const dirs:string[]=[];let dir=current;
 while(within(root,dir)){dirs.unshift(dir);if(dir===root)break;dir=dirname(dir);}
 const output:InstructionFile[]=[];let remaining=maxBytes;
 for(const scope of [...(agentDir?[resolve(agentDir)]:[]),...dirs]){
  const selected=['AGENTS.override.md','AGENTS.md','CLAUDE.md'].map(name=>join(scope,name)).find(existsSync);
  if(!selected)continue;
  const canonical=realpathSync(selected);
  if(!within(scope,canonical)||!statSync(canonical).isFile())throw new Error(`Instruction file escapes its scope: ${selected}`);
  const bytes=readFileSync(canonical);
  if(bytes.length>remaining)throw new Error(`Project instructions exceed ${maxBytes} bytes: ${selected}`);
  remaining-=bytes.length;output.push({path:canonical,content:bytes.toString('utf8')});
 }
 return output;
}
