import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const exec=promisify(execFile),root=resolve(new URL('../',import.meta.url).pathname);
const host=await mkdtemp(join(tmpdir(),'sakura-standalone-install-'));
let server;
try{
 const packed=JSON.parse((await exec('npm',['pack','--json','--ignore-scripts','--pack-destination',host],{cwd:root})).stdout)[0],artifact=join(host,packed.filename);
 await writeFile(join(host,'package.json'),JSON.stringify({private:true,type:'module'}));
 // Install only Sakura, without a global Pi installation or host dependency overrides.
 await exec('npm',['install','--ignore-scripts','--no-audit','--no-fund',artifact],{cwd:host,timeout:300000,maxBuffer:8*1024*1024});
 const home=join(host,'profile'),project=join(host,'project'),bin=join(host,'node_modules/sakura-coding-agent/bin/sakura.mjs');
 await mkdir(join(project,'.pi'),{recursive:true});const foreign=JSON.stringify({theme:'foreign-theme',defaultModel:'foreign-model'});await writeFile(join(project,'.pi/settings.json'),foreign);
 const run=args=>exec(process.execPath,[bin,'--home',home,...args],{cwd:project,env:{...process.env,PI_CODING_AGENT_DIR:join(host,'legacy-pi')},timeout:60000,maxBuffer:2*1024*1024});
 await run(['init','--ollama-model','standalone-fixture','--offline']);
 const doctor=JSON.parse((await run(['doctor'])).stdout);assert.equal(doctor.extensions,9); // 6 个 Sakura 扩展 + 3 个 Pi 原生工厂（codemode / tool_search / MCP）assert.deepEqual(doctor.extensionErrors,[]);assert.equal(doctor.themes.length,2);assert.equal(doctor.skills.length,5);assert.equal(doctor.prompts.length,2);assert.deepEqual(doctor.projectSettings,{});assert.equal(doctor.agentDir,join(home,'agent'));
 assert.equal(await readFile(join(project,'.pi/settings.json'),'utf8'),foreign);
 const plan=(await run(['plan','验证独立安装后的中文计划入口'])).stdout;assert.ok(plan.includes('graph valid.'));
 server=spawn(process.execPath,[bin,'--home',home,'web','--project',project,'--port','0'],{cwd:project,stdio:['ignore','pipe','pipe']});
 const url=await new Promise((accept,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Web startup timed out')),60000);server.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);accept(match[0]);}});server.once('error',reject);server.once('exit',code=>{clearTimeout(timer);reject(Error('Web exited '+code));});});
 assert.equal((await fetch(url)).status,200);const overview=await fetch(url+'/api/overview').then(r=>r.json());assert.deepEqual(overview.runs,[]);assert.equal(overview.profile.isolated,true);
 const pi=JSON.parse(await readFile(join(host,'node_modules/@earendil-works/pi-coding-agent/package.json'),'utf8')),codemode=JSON.parse(await readFile(join(host,'node_modules/@earendil-works/pi-codemode/package.json'),'utf8'));assert.equal(pi.version,'1.1.0');assert.equal(codemode.version,'1.1.0');
 const out=join(root,'.sakura/release');await mkdir(out,{recursive:true});await copyFile(artifact,join(out,packed.filename));const sha256=createHash('sha256').update(await readFile(artifact)).digest('hex');
 const report={checkedAt:new Date().toISOString(),passed:true,artifact:packed.filename,sha256,onlySakuraInstalled:true,pi:pi.version,piCodemode:codemode.version,resources:{extensions:9,sakuraExtensions:6,themes:2,skills:5,prompts:2},projectPiSettingsUnchanged:true,standalonePlan:true,standaloneWeb:true};await writeFile(join(out,'standalone-installed.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{if(server){server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));}await rm(host,{recursive:true,force:true});}
