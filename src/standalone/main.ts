import {join,resolve,basename} from 'node:path';
import {InteractiveMode,SessionManager,resolveCliModel,createFindTool,createGrepTool,createAgentSessionRuntime,createAgentSessionFromServices} from '@earendil-works/pi-coding-agent';
import {ProcessTerminal} from '@earendil-works/pi-tui';
import {standaloneServices,initializeProfile,profileSummary,prepareProfile,standalonePackageManager} from './profile.ts';
import {loadConfig} from '../config.ts';
import {isLoopbackEndpoint} from '../runtime/create-agent.ts';
import {bindHostServices,bindHostSession} from '../runtime/host-context.ts';
import {configureOllama,setupWizard,modelRuntime} from './model-setup.ts';
import {providerFailure} from '../runtime/agent-events.ts';
import {loadStandaloneMcp,updateStandaloneMcp} from './mcp.ts';
import {readFile} from 'node:fs/promises';
export async function main(args:string[]){
 const [command,...rest]=args,value=(flag:string)=>{const index=rest.indexOf(flag);return index<0?undefined:rest[index+1];};
 const cwd=resolve(value('--project')??process.cwd());
 if(command==='init'){
  const positionalModel=rest[0]&&!rest[0].startsWith('-')?rest[0]:undefined;
  const explicitModel=value('--ollama-model');
  if(rest.includes('--ollama-model')&&(!explicitModel||explicitModel.startsWith('-')))throw new Error('--ollama-model requires a model name');
  if(positionalModel&&explicitModel&&positionalModel!==explicitModel)throw new Error('Specify one model name: sakura init MODEL');
  const selectedModel=positionalModel??explicitModel??(process.stdin.isTTY&&!rest.includes('--offline')?await setupWizard():undefined);
  const contextWindow=Number(value('--context-window')??16384),maxTokens=Number(value('--max-tokens')??4096);
  const profile=await initializeProfile(selectedModel,contextWindow,maxTokens);
  if(selectedModel)await configureOllama(selectedModel,contextWindow,maxTokens);
  if(!rest.includes('--offline')){for(const tool of [createFindTool(profile.home),createGrepTool(profile.home)]){try{await tool.execute('sakura-setup',{pattern:tool.name==='find'?'*':'__sakura_setup_probe__',path:profile.home,limit:1},AbortSignal.timeout(120000));}catch(error){console.error(`工具 ${tool.name}：${error instanceof Error?error.message:String(error)}`);}}}
  console.log(JSON.stringify(profile,null,2));return;
 }
 if(command==='models'){
  const runtime=await modelRuntime();
  console.log(runtime.getModels().map(model=>`${model.provider}/${model.id}${runtime.hasConfiguredAuth(model.provider)?' · configured':''}`).join('\n'));return;
 }
 if(command==='connect'){
  const services=await standaloneServices(cwd),settings=services.settingsManager.getSettings();
  const result=resolveCliModel({cliModel:value('--model')??`${settings.defaultProvider}/${settings.defaultModel}`,modelRuntime:services.modelRuntime});
  if(result.error||!result.model)throw new Error(result.error??'Run sakura init MODEL first');
  if(!rest.includes('--cloud')&&(await loadConfig(cwd)).runtime.localOnly&&!isLoopbackEndpoint(result.model.baseUrl))throw new Error('Cloud connection requires --cloud or runtime.localOnly: false');
  const {session}=await createAgentSessionFromServices({services,model:result.model,sessionManager:SessionManager.inMemory(cwd),tools:[],thinkingLevel:'off'});
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;void session.abort();},30000);
  try{await session.prompt('Reply with OK only.');const error=providerFailure(session.messages);if(timedOut)throw new Error('Model connection timed out');if(error)throw new Error(error);console.log(`connected: ${result.model.provider}/${result.model.id}`);}finally{clearTimeout(timer);session.dispose();}
  return;
 }
 if(command==='mcp'){
  const {agentDir}=await prepareProfile();const [action='list',name,...source]=rest;
  if(action==='list'){const loaded=loadStandaloneMcp(agentDir);if(loaded.errors.length)throw new Error(loaded.errors.join('\n'));console.log(JSON.stringify(loaded.servers.map(entry=>({name:entry.name,enabled:entry.config.enabled!==false,exposure:entry.config.exposure??'codemode'})),null,2));return;}
  if(!name||!['add','remove'].includes(action))throw new Error('sakura mcp add NAME config.json | add NAME -- COMMAND ARGS | remove NAME');
  const config=action==='remove'?undefined:source[0]==='--'?{command:source[1],args:source.slice(2)}:JSON.parse(await readFile(resolve(cwd,source[0]??''),'utf8'));
  await updateStandaloneMcp(agentDir,name,config);console.log(`MCP ${action}: ${name}`);return;
 }
 if(['install','remove','packages'].includes(command)){
  const {packageManager}=await standalonePackageManager();
  if(command==='packages'){console.log(JSON.stringify(packageManager.listConfiguredPackages(),null,2));return;}
  const input=rest[0];if(!input)throw new Error(`sakura ${command} <npm:package@version | git:repo@ref | /path/to/package>`);
  const source=/^(npm:|git:|https?:\/\/|ssh:\/\/)/.test(input)?input:resolve(cwd,input);
  if(command==='install')await packageManager.installAndPersist(source);else await packageManager.removeAndPersist(source);
  console.log(`${command}: ${source}\n配置：${(await prepareProfile()).agentDir}`);return;
 }
 if(command==='web'){const {serveDashboard}=await import('../web/server.ts');await serveDashboard({project:cwd,port:Number(value('--port')??4317),roots:rest.flatMap((arg,i)=>arg==='--runs'?[resolve(rest[i+1])]:[])});return;}
 if(command==='doctor'){
  const services=await standaloneServices(cwd),loader=services.resourceLoader;
  const mcp=loadStandaloneMcp((await prepareProfile()).agentDir);
  const report={...await profileSummary(),extensions:loader.getExtensions().extensions.length,extensionErrors:loader.getExtensions().errors,themes:loader.getThemes().themes.map(t=>t.name),skills:loader.getSkills().skills.map(s=>s.name),prompts:loader.getPrompts().prompts.map(p=>p.name),projectSettings:services.settingsManager.getProjectSettings(),instructionFiles:loader.getAgentsFiles().agentsFiles.map(item=>item.path),mcp:{servers:mcp.servers.map(entry=>entry.name),errors:mcp.errors},builtinTools:['read','write','edit','bash','grep','find','ls'],commands:loader.getExtensions().extensions.flatMap(extension=>[...extension.commands.keys()]),tools:loader.getExtensions().extensions.flatMap(extension=>[...extension.tools.keys()])};
  console.log(JSON.stringify(report,null,2));if(report.extensionErrors.length||mcp.errors.length)process.exitCode=1;return;
 }
 const profile=await prepareProfile(),sessionDir=join(profile.agentDir,'sessions');
 process.env.PI_OFFLINE='1';
 const factory:Parameters<typeof createAgentSessionRuntime>[0]=async options=>{
  const services=await standaloneServices(options.cwd),settings=services.settingsManager.getSettings(),localOnly=rest.includes('--cloud')?false:(await loadConfig(options.cwd)).runtime.localOnly;
  bindHostServices(options.cwd,{modelRuntime:services.modelRuntime,settingsManager:services.settingsManager,agentDir:profile.agentDir,localOnly});
  const selection=value('--model');
  const resolved=selection?resolveCliModel({cliModel:selection,modelRuntime:services.modelRuntime}):undefined;
  if(resolved?.error)throw new Error(resolved.error);
  const model=resolved?.model??services.modelRuntime.getModel(settings.defaultProvider??'ollama',settings.defaultModel??'');
  if(localOnly&&(!model||!isLoopbackEndpoint(model.baseUrl)))throw new Error('配置 Sakura 本地模型：sakura init MODEL；使用云端时运行 sakura --cloud，再 /login 和 /model。');
  services.settingsManager.applyOverrides({defaultTools:['read','write','edit','bash','grep','find','ls',...services.resourceLoader.getExtensions().extensions.flatMap(extension=>[...extension.tools.keys()]).filter(name=>!['codemode','tool_search'].includes(name))]});
  const result=await createAgentSessionFromServices({services,sessionManager:options.sessionManager,sessionStartEvent:options.sessionStartEvent,model,scopedModels:localOnly?services.modelRuntime.getAvailableSnapshot().filter(m=>isLoopbackEndpoint(m.baseUrl)).map(model=>({model})):undefined});
  bindHostSession(options.cwd,result.session);
  return {...result,services,diagnostics:services.diagnostics};
 };
 const runtime=await createAgentSessionRuntime(factory,{cwd,agentDir:profile.agentDir,sessionManager:rest.includes('--continue')?SessionManager.continueRecent(cwd,sessionDir):SessionManager.create(cwd,sessionDir)});
 class SakuraTerminal extends ProcessTerminal{override setTitle(_title:string){super.setTitle(`Sakura Coding Agent · ${basename(cwd)}`);}}
 try{await new InteractiveMode(runtime,{terminal:new SakuraTerminal(),initialThemeSetting:value('--theme')??'sakura-light',verbose:false}).run();}finally{await runtime.dispose();}
}
