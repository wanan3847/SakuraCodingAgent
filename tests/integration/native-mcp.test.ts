import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAgentSession,createAgentSessionRuntime,DefaultResourceLoader,SessionManager} from '@earendil-works/pi-coding-agent';
import {standaloneMcpExtensions,updateStandaloneMcp} from '../../src/standalone/mcp.ts';
import {piFixture} from '../helpers/pi-fixture.ts';

test('Pi native MCP connects, exposes and executes a real stdio tool then closes the server',async t=>{
 const fixture=await piFixture((_context,_options,call)=>call===1?{stopReason:'toolUse',content:[{type:'toolCall',id:'ping',name:'mcp__fixture__ping',arguments:{}}]}:{content:[{type:'text',text:'done'}]});t.after(fixture.cleanup);
 const cwd=join(fixture.directory,'project');await mkdir(cwd);const pidFile=join(fixture.directory,'server.pid');
 await updateStandaloneMcp(fixture.directory,'fixture',{command:process.execPath,args:[fileURLToPath(new URL('../helpers/mcp-fixture.mjs',import.meta.url)),pidFile],exposure:'direct'});
 const loader=new DefaultResourceLoader({cwd,agentDir:fixture.directory,settingsManager:fixture.config.settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:standaloneMcpExtensions(fixture.directory)});await loader.reload();
 const runtime=await createAgentSessionRuntime(async options=>{const result=await createAgentSession({...fixture.config,cwd,resourceLoader:loader,sessionManager:options.sessionManager});return {...result,services:{cwd,agentDir:fixture.directory,modelRuntime:fixture.config.modelRuntime!,settingsManager:fixture.config.settingsManager!,resourceLoader:loader,diagnostics:[]},diagnostics:[]};},{cwd,agentDir:fixture.directory,sessionManager:SessionManager.inMemory(cwd)});
 const session=runtime.session;
 try{await session.bindExtensions({});await session.prompt('Call the fixture MCP tool.');assert.ok(session.messages.some(message=>message.role==='toolResult'&&message.content.some(part=>part.type==='text'&&part.text.includes('MCP fixture called'))));assert.equal(fixture.requests.length,2);}
 finally{await runtime.dispose();}
 const pid=Number(await readFile(pidFile,'utf8'));
 t.after(()=>{try{process.kill(pid,'SIGTERM');}catch{}});
 const until=Date.now()+2000;let live=true;
 while(live&&Date.now()<until){try{process.kill(pid,0);await new Promise(resolve=>setTimeout(resolve,20));}catch{live=false;}}
 assert.equal(live,false,'disposing the native session must stop its MCP process');
});
