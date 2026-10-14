import {mkdir,readFile,writeFile,lstat} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {DefaultPackageManager,SettingsManager,ModelRuntime,createAgentSessionServices} from '@earendil-works/pi-coding-agent';
import {projectInstructions} from '../runtime/project-instructions.ts';
import {standaloneMcpExtensions} from './mcp.ts';
export const packageRoot=fileURLToPath(new URL('../../',import.meta.url));
export const profileHome=()=>resolve(process.env.SAKURA_HOME??join(homedir(),'.sakura'));
export async function prepareProfile(){
 const home=profileHome(),agentDir=join(home,'agent'),settingsCwd=join(home,'settings-scope');
 for(const path of [home,agentDir,settingsCwd]){await mkdir(path,{recursive:true,mode:0o700});if((await lstat(path)).isSymbolicLink())throw new Error('Sakura profile must not be a symlink');}
 return {home,agentDir,settingsCwd};
}
export async function initializeProfile(model?:string,contextWindow=16384,maxTokens=4096){
 if(model&&(!Number.isSafeInteger(contextWindow)||!Number.isSafeInteger(maxTokens)||contextWindow<=maxTokens||maxTokens<1))throw new Error('Invalid model token limits');
 const profile=await prepareProfile();
 const writeNew=async(name:string,data:unknown)=>{try{await writeFile(join(profile.agentDir,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}};
 await writeNew('settings.json',{theme:'sakura-light',quietStartup:true,defaultThinkingLevel:'off',enableInstallTelemetry:false,enableAnalytics:false,...(model?{defaultProvider:'ollama',defaultModel:model}:{})});
 if(model){
  await writeNew('models.json',{providers:{ollama:{api:'openai-completions',baseUrl:'http://127.0.0.1:11434/v1',apiKey:'ollama',models:[{id:model,name:model,contextWindow,maxTokens,input:['text'],reasoning:false,samplingParams:{reasoning_effort:'none'}}]}}});
 }
 return profile;
}
export async function standalonePackageManager(){
 const {home,agentDir,settingsCwd}=await prepareProfile();
 const settingsManager=SettingsManager.create(settingsCwd,agentDir);
 return {home,agentDir,settingsCwd,settingsManager,packageManager:new DefaultPackageManager({cwd:settingsCwd,agentDir,settingsManager,builtinExtensions:[]})};
}
/** All settings are stored in Sakura's profile. Target-project .pi settings never enter this host. */
export async function standaloneServices(cwd:string){
 const {home,agentDir,settingsManager,packageManager}=await standalonePackageManager();
 const resources=await packageManager.resolve(async()=> 'skip');
 const withinHome=(path:string)=>{const part=relative(home,resolve(path));return !isAbsolute(part)&&part!=='..'&&!part.startsWith('../');};
 const enabled=(kind:keyof typeof resources)=>resources[kind].filter(item=>item.enabled&&(item.metadata.source!=='auto'||withinHome(item.metadata.baseDir??item.path))).map(item=>item.path);
 const modelRuntime=await ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:join(agentDir,'models.json'),modelsStorePath:join(agentDir,'models-cache.json'),allowModelNetwork:false,refreshOnCreate:false});
 const options={noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
  agentsFilesOverride:()=>({agentsFiles:projectInstructions(cwd,agentDir)}),
  extensionFactories:standaloneMcpExtensions(agentDir),
  additionalExtensionPaths:['planning','orchestrator','repo','workspace','experience','subagent'].map(name=>join(packageRoot,`extensions/sakura-${name}.ts`)).concat(enabled('extensions')),
  additionalSkillPaths:[join(packageRoot,'skills'),...enabled('skills')],additionalPromptTemplatePaths:[join(packageRoot,'prompts'),...enabled('prompts')],additionalThemePaths:[join(packageRoot,'themes'),...enabled('themes')]};
 return createAgentSessionServices({cwd,agentDir,settingsManager,modelRuntime,resourceLoaderOptions:options});
}
export async function profileSummary(){
 const {home,agentDir}=await prepareProfile();
 const models=await readFile(join(agentDir,'models.json'),'utf8').then(text=>JSON.parse(text),()=>({providers:{}}));
 return {home,agentDir,sessions:join(agentDir,'sessions'),isolated:true,models:Object.entries(models.providers??{}).flatMap(([provider,value])=>((value as {models?:Array<{id:string}>}).models??[]).map(model=>({provider,id:model.id})))};
}
