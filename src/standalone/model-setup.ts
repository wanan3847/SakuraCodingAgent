import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {atomicWrite} from '../storage/atomic.ts';
import {withFileLock} from '../storage/lock.ts';
import {prepareProfile,initializeProfile} from './profile.ts';

export async function setDefaultModel(provider:string,id:string){
 const {agentDir}=await prepareProfile();
 if(!provider||!id)throw new Error('Select provider/id');
 await withFileLock(join(agentDir,'model-setup.lock'),async()=>{
  const path=join(agentDir,'settings.json');
  if((await lstat(path).catch(()=>undefined))?.isSymbolicLink())throw new Error('Profile settings must not be a symlink');
  const settings=await readFile(path,'utf8').then(text=>JSON.parse(text),error=>{if(error.code==='ENOENT')return {};throw error;});
  await atomicWrite(path,JSON.stringify({...settings,defaultProvider:provider,defaultModel:id},null,2)+'\n');
 });
}
export async function configureOllama(model:string,contextWindow:number,maxTokens:number){
 await initializeProfile(model,contextWindow,maxTokens);
 const {agentDir}=await prepareProfile();
 await withFileLock(join(agentDir,'model-setup.lock'),async()=>{
  const path=join(agentDir,'models.json');
  if((await lstat(path)).isSymbolicLink())throw new Error('Profile models must not be a symlink');
  const raw=JSON.parse(await readFile(path,'utf8'));
  const previous=raw.providers?.ollama;
  const definition={id:model,name:model,contextWindow,maxTokens,input:['text'],reasoning:false,samplingParams:{reasoning_effort:'none'}};
  if(previous&&previous.baseUrl!=='http://127.0.0.1:11434/v1')throw new Error('Existing ollama provider has a custom endpoint; use /model or edit its independent models.json');
  const models=[...(previous?.models??[]).filter((item:{id:string})=>item.id!==model),definition];
  raw.providers={...raw.providers,ollama:{...previous,api:'openai-completions',baseUrl:'http://127.0.0.1:11434/v1',apiKey:'ollama',models}};
  await atomicWrite(path,JSON.stringify(raw,null,2)+'\n');
 });
 await setDefaultModel('ollama',model);
}
export async function modelRuntime(){const {agentDir}=await prepareProfile();return ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:join(agentDir,'models.json'),modelsStorePath:join(agentDir,'models-cache.json'),allowModelNetwork:false,refreshOnCreate:false});}
export async function setupWizard():Promise<string|undefined>{
 const input=createInterface({input:stdin,output:stdout});
 try{
  const kind=(await input.question('模型来源  1 Ollama · 2 云端（Pi /login） [1]: ')).trim();
  if(kind==='2'){
   await initializeProfile();console.log('运行 sakura --cloud，在终端内使用 /login 和 /model；认证只保存在 ~/.sakura。');return undefined;
  }
  let names:string[]=[];
  try{const response=await fetch('http://127.0.0.1:11434/api/tags',{signal:AbortSignal.timeout(3000)});if(response.ok){const raw=await response.json() as {models?:Array<{name:string}>};names=raw.models?.map(item=>item.name)??[];}}catch{}
  if(names.length)console.log(names.map((name,index)=>`${index+1}  ${name}`).join('\n'));
  const selected=(await input.question('模型名称或编号: ')).trim();
  const model=/^\d+$/.test(selected)?names[Number(selected)-1]:selected;
  if(!model)throw new Error('未选择模型');
  return model;
 }finally{input.close();}
}
