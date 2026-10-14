import {readFileSync,existsSync,lstatSync} from 'node:fs';
import {readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {atomicWrite} from '../storage/atomic.ts';
import {withFileLock} from '../storage/lock.ts';
import {createMcpExtension,createCodemodeExtension,createToolSearchExtension,type LoadedMcpConfig,type McpServerConfig} from '@earendil-works/pi-coding-agent';

/** Only the explicitly installed Sakura profile may start a server. Never consult .pi. */
export function loadStandaloneMcp(agentDir:string):LoadedMcpConfig{
 const source=join(agentDir,'mcp.json');
 if(!existsSync(source))return {servers:[],errors:[]};
 try{
  if(lstatSync(source).isSymbolicLink())throw new Error('MCP config must not be a symlink');
  const raw=JSON.parse(readFileSync(source,'utf8'));
  if(!raw||typeof raw!=='object'||!raw.mcpServers||typeof raw.mcpServers!=='object'||Array.isArray(raw.mcpServers))throw new Error('mcpServers must be an object');
  const servers=Object.entries(raw.mcpServers).map(([name,value])=>{
   if(!/^[a-zA-Z0-9_-]+$/.test(name)||!value||typeof value!=='object'||Array.isArray(value))throw new Error(`Invalid MCP server: ${name}`);
   const config=validateServer(name,value);
   return {name,config,source,scope:'global' as const};
  });
  return {servers,errors:[],autoEnableCodemode:raw.autoEnableCodemode!==false};
 }catch(error){return {servers:[],errors:[`${source}: ${String(error)}`]};}
}
function validateServer(name:string,value:unknown):McpServerConfig{
 if(!/^[a-zA-Z0-9_-]+$/.test(name)||!value||typeof value!=='object'||Array.isArray(value))throw new Error(`Invalid MCP server: ${name}`);
 const raw=value as Record<string,unknown>;
 if(('command' in raw)===('url' in raw))throw new Error(`${name}: specify one command or url`);
 if('command' in raw&&(typeof raw.command!=='string'||!raw.command.trim()||raw.command.includes('\0')))throw new Error(`${name}: invalid command`);
 if(raw.args!==undefined&&(!Array.isArray(raw.args)||raw.args.some(arg=>typeof arg!=='string'||arg.includes('\0'))))throw new Error(`${name}: args must be strings`);
 if('url' in raw){if(typeof raw.url!=='string')throw new Error(`${name}: invalid URL`);const url=new URL(raw.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error(`${name}: HTTP URL without embedded credentials required`);}
 if(raw.exposure!==undefined&&!['direct','deferred','hidden','codemode','codemode-deferred'].includes(String(raw.exposure)))throw new Error(`${name}: invalid exposure`);
 if(raw.enabled!==undefined&&typeof raw.enabled!=='boolean')throw new Error(`${name}: enabled must be boolean`);
 if(raw.timeout!==undefined&&(typeof raw.timeout!=='number'||!Number.isFinite(raw.timeout)||raw.timeout<=0))throw new Error(`${name}: invalid timeout`);
 return raw as unknown as McpServerConfig;
}
/** Explicit CLI configuration, not an LLM tool. Credentials and command text are never listed. */
export async function updateStandaloneMcp(agentDir:string,name:string,value?:unknown){
 if(!/^[a-zA-Z0-9_-]+$/.test(name))throw new Error('Invalid MCP server name');
 if(value!==undefined)validateServer(name,value);
 const path=join(agentDir,'mcp.json');
 await withFileLock(join(agentDir,'mcp-config.lock'),async()=>{
  if((await lstat(path).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;}))?.isSymbolicLink())throw new Error('MCP config must not be a symlink');
  const raw=await readFile(path,'utf8').then(text=>JSON.parse(text),error=>{if(error.code==='ENOENT')return {mcpServers:{}};throw error;});
  raw.mcpServers??={};
  if(value===undefined)delete raw.mcpServers[name];else raw.mcpServers[name]=value;
  await atomicWrite(path,JSON.stringify(raw,null,2)+'\n');
 });
}
export function standaloneMcpExtensions(agentDir:string){return [
 createCodemodeExtension(),createToolSearchExtension(),
 createMcpExtension({loadConfig:()=>loadStandaloneMcp(agentDir),logPath:join(agentDir,'mcp.log')}),
];}
