import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {projectInstructions} from '../../src/runtime/project-instructions.ts';
import {RunBudget} from '../../src/runtime/run-budget.ts';
import {createPiAgentRunner} from '../../src/runtime/pi-agent-runner.ts';
import {piFixture} from '../helpers/pi-fixture.ts';
import {taskNode} from '../../src/planning/schemas.ts';
import {captureChanges,saveArtifact} from '../../src/workspace/artifacts.ts';
import {applyArtifact,undoCheckpoint} from '../../src/workspace/apply-artifact.ts';
import {detectVerificationPlan} from '../../src/verification/command-detector.ts';
import {mergeConfig} from '../../src/config.ts';
import {delegateTasks} from '../../src/orchestrator/delegate.ts';
import {loadStandaloneMcp,updateStandaloneMcp} from '../../src/standalone/mcp.ts';
import {createRepositoryParser} from '../../src/repo-intelligence/languages.ts';
import {clusterExperience} from '../../src/experience/patterns.ts';
import {indexRepository} from '../../src/repo-intelligence/indexer.ts';
import {saveCodeCheckpoint,resolveCheckpoint} from '../../src/workspace/code-checkpoint.ts';
const exec=promisify(execFile);
const git=async(cwd:string,...args:string[])=>(await exec('git',args,{cwd})).stdout;
async function temp(t:{after:(fn:()=>Promise<unknown>)=>unknown}){const dir=await mkdtemp(join(tmpdir(),'sakura-capabilities-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function repo(dir:string){await git(dir,'init','-q');await writeFile(join(dir,'a.txt'),'a\n');await writeFile(join(dir,'b.txt'),'b\n');await git(dir,'add','-A');await git(dir,'-c','user.name=t','-c','user.email=t@t','commit','-qm','base');}

test('project instructions stop at Git root, honor override, and reject symlink escape and oversize',async t=>{
 const root=await temp(t),project=join(root,'project'),sub=join(project,'src');await mkdir(sub,{recursive:true});await repo(project);
 await writeFile(join(root,'AGENTS.md'),'FOREIGN');await writeFile(join(project,'AGENTS.md'),'ignored');await writeFile(join(project,'AGENTS.override.md'),'ROOT');await writeFile(join(sub,'AGENTS.md'),'SUB');
 assert.deepEqual(projectInstructions(sub).map(item=>item.content),['ROOT','SUB']);
 assert.throws(()=>projectInstructions(sub,undefined,3),/exceed/);
 await rm(join(sub,'AGENTS.md'));await symlink(join(root,'AGENTS.md'),join(sub,'AGENTS.md'));assert.throws(()=>projectInstructions(sub),/escapes/);
});
test('shared budget caps tool attempts across real Pi turns and rejects subsequent dispatch',async t=>{
 const cwd=await temp(t);await writeFile(join(cwd,'file.txt'),'data');
 const fixture=await piFixture((_context,_options,call)=>({stopReason:'toolUse',content:[{type:'toolCall',id:`read-${call}`,name:'read',arguments:{path:'file.txt'}}]}));t.after(fixture.cleanup);
 const budget=new RunBudget({maxToolCalls:1});const runner=createPiAgentRunner({config:{...fixture.config,budget}});
 const input={agentId:'explore',role:'explorer' as const,task:taskNode({id:'explore',title:'Read',description:'read',role:'explorer',dependencies:[],priority:0}),workspacePath:cwd,allowedTools:['read'],timeoutMs:5000,signal:budget.signal};
 const result=await runner.run(input);assert.equal(result.status,'failure');assert.equal(budget.snapshot().toolCalls,1);assert.equal(budget.signal.aborted,true);await assert.rejects(runner.run(input));assert.equal(fixture.requests.length,2);
});
test('provider token and cost thresholds abort real Pi sessions instead of throwing in a swallowed hook',async t=>{
 const cwd=await temp(t);
 const fixture=await piFixture(()=>({content:[{type:'text',text:'done'}],usage:{input:20,output:10,cacheRead:0,cacheWrite:0,totalTokens:30,cost:{input:0.02,output:0.01,cacheRead:0,cacheWrite:0,total:0.03}}}));t.after(fixture.cleanup);
 for(const limits of [{maxTokens:25},{maxCostUsd:0.01}]){const budget=new RunBudget(limits);const result=await createPiAgentRunner({config:{...fixture.config,budget}}).run({agentId:'explore',role:'explorer',task:taskNode({id:'explore',title:'Read',description:'read',role:'explorer',dependencies:[],priority:0}),workspacePath:cwd,allowedTools:['read'],timeoutMs:5000,signal:budget.signal});assert.equal(result.status,'failure');assert.equal(budget.snapshot().exhausted,true);assert.equal(budget.snapshot().reportedTokens,30);}
 assert.throws(()=>new RunBudget({maxTokens:1.5}),/integer/);
 const resumed=new RunBudget({maxTokens:40});resumed.restore({limits:{maxTokens:40},toolCalls:2,reportedTokens:30,reportedCostUsd:0.03,usageReports:1,unknownUsage:0,exhausted:false,reason:undefined});assert.equal(resumed.snapshot().reportedTokens,30);const capped=new RunBudget({maxTokens:20});capped.restore(resumed.snapshot());assert.equal(capped.signal.aborted,true);assert.throws(()=>capped.check(),/restored token/);
});
test('file selection accepts only selected changes; checkpoint undo preserves staging and refuses subsequent edits',async t=>{
 const cwd=await temp(t);await repo(cwd);await writeFile(join(cwd,'a.txt'),'new a\n');await writeFile(join(cwd,'b.txt'),'new b\n');const artifact=await saveArtifact(join(cwd,'.sakura','artifacts'),'selection',await captureChanges(cwd));await git(cwd,'restore','a.txt','b.txt');
 const applied=await applyArtifact(cwd,artifact,undefined,['a.txt']);assert.equal(await readFile(join(cwd,'a.txt'),'utf8'),'new a\n');assert.equal(await readFile(join(cwd,'b.txt'),'utf8'),'b\n');assert.ok(applied.checkpointPath);assert.equal((await applyArtifact(cwd,artifact,undefined,['a.txt'])).duplicate,true);
 await writeFile(join(cwd,'a.txt'),'user edit\n');await assert.rejects(undoCheckpoint(cwd,applied.checkpointPath),/changed since/);assert.equal(await readFile(join(cwd,'a.txt'),'utf8'),'user edit\n');await writeFile(join(cwd,'a.txt'),'new a\n');await undoCheckpoint(cwd,applied.checkpointPath);assert.equal(await readFile(join(cwd,'a.txt'),'utf8'),'a\n');assert.equal((await git(cwd,'diff','--cached')).trim(),'');
});
test('checkpoint round trips binary, deletion, rename and unicode paths',async t=>{
 const cwd=await temp(t);await repo(cwd);await writeFile(join(cwd,'樱花.bin'),Buffer.from([0,255,3]));await rm(join(cwd,'b.txt'));await git(cwd,'mv','a.txt','a moved.txt');const artifact=await saveArtifact(join(cwd,'.sakura','artifacts'),'binary',await captureChanges(cwd));await git(cwd,'reset','--hard','HEAD');await rm(join(cwd,'樱花.bin'));
 const applied=await applyArtifact(cwd,artifact);await undoCheckpoint(cwd,applied.checkpointPath!);assert.equal(await readFile(join(cwd,'a.txt'),'utf8'),'a\n');assert.equal(await readFile(join(cwd,'b.txt'),'utf8'),'b\n');await assert.rejects(readFile(join(cwd,'樱花.bin')),/ENOENT/);
});
test('verification detects real package manager and validates explicit command and budget configuration',async t=>{
 const cwd=await temp(t);await writeFile(join(cwd,'package.json'),JSON.stringify({packageManager:'pnpm@10.0.0',scripts:{test:'node check.mjs'}}));assert.deepEqual((await detectVerificationPlan(cwd)).test,['pnpm run test']);assert.deepEqual(mergeConfig({verification:{commands:['python -m unittest']}}).verification.commands,['python -m unittest']);assert.throws(()=>mergeConfig({verification:{commands:['']}}));assert.throws(()=>mergeConfig({runtime:{budget:{maxTokens:0}}}));
});
test('native edit checkpoint undo restores preexisting dirty and staged content without undoing other files',async t=>{
 const cwd=await temp(t);await repo(cwd);
 await writeFile(join(cwd,'a.txt'),'user dirty\n');await writeFile(join(cwd,'b.txt'),'user staged\n');await git(cwd,'add','b.txt');
 const staging=await git(cwd,'diff','--cached','--binary'),before=await captureChanges(cwd);
 await writeFile(join(cwd,'a.txt'),'agent edit\n');await writeFile(join(cwd,'user.txt'),'unrelated concurrent user file\n');
 const checkpoint=await saveCodeCheckpoint(cwd,before,['a.txt']);assert.ok(checkpoint);assert.equal(await resolveCheckpoint(cwd),checkpoint);
 await undoCheckpoint(cwd,checkpoint);assert.equal(await readFile(join(cwd,'a.txt'),'utf8'),'user dirty\n');assert.equal(await readFile(join(cwd,'b.txt'),'utf8'),'user staged\n');assert.equal(await readFile(join(cwd,'user.txt'),'utf8'),'unrelated concurrent user file\n');assert.equal(await git(cwd,'diff','--cached','--binary'),staging);await undoCheckpoint(cwd,checkpoint);
});
test('delegation cancellation stops queued tasks and fails closed when write isolation is unavailable',async t=>{
 const cwd=await temp(t);let dispatched=0;const controller=new AbortController();
 const result=await delegateTasks({cwd,signal:controller.signal,maxConcurrency:1,tasks:[{id:'one',role:'explorer',description:'x'},{id:'two',role:'explorer',description:'y'}],runner:{async run(input){dispatched++;controller.abort();assert.ok(input.signal?.aborted);return {status:'failure',summary:'cancelled',changedFiles:[],evidence:[]};}}});assert.equal(dispatched,1);assert.equal(result.tasks[1].status,'failure');
 const writer=await delegateTasks({cwd,tasks:[{id:'write',role:'implementer',description:'x'}],runner:{async run(){throw new Error('must never dispatch');}}});assert.match(writer.tasks[0].summary,/Isolation unavailable/);
});
test('MCP profile configuration validates and lists without consulting project .pi or exposing credentials',async t=>{
 const root=await temp(t),agent=join(root,'agent');await mkdir(agent);
 await updateStandaloneMcp(agent,'fixture',{url:'https://example.invalid/mcp',headers:{Authorization:'private'},exposure:'deferred'});assert.equal(loadStandaloneMcp(agent).servers[0].name,'fixture');await updateStandaloneMcp(agent,'fixture');assert.equal(loadStandaloneMcp(agent).servers.length,0);await assert.rejects(updateStandaloneMcp(agent,'bad',{command:7}),/invalid command/);
 await writeFile(join(agent,'mcp.json'),'broken');assert.equal(loadStandaloneMcp(agent).errors.length,1);
});
test('Python parsing uses AST without executing source; clusters require independent verified runs',()=>{
 const parser=createRepositoryParser();if(parser.extensions.includes('.py')){const parsed=parser.parse('src/a.py','from .b import helper\nclass Foo:\n    def bar(self):\n        raise RuntimeError("never execute")\n');assert.deepEqual(parsed.symbols.map(item=>item.name),['Foo','Foo.bar']);assert.equal(parsed.edges[0].to,'src/b');}
 const base={id:'one',problemPattern:'failure code 12',symptoms:[],failedAttempts:[],successfulActions:[],usefulTools:[],relevantFiles:[],verificationEvidence:['passed'],tags:[],createdAt:1,runId:'run-one'};
 const groups=clusterExperience([base,{...base,id:'two',runId:'run-two'},{...base,id:'three',runId:'run-three'}]);assert.equal(groups[0].readyForCandidate,true);assert.equal(clusterExperience([{...base,runId:undefined}])[0].readyForCandidate,false);
});
test('invalid Python source is excluded with a coverage diagnostic instead of dropping the whole context',async t=>{
 const cwd=await temp(t),parser=createRepositoryParser();if(!parser.extensions.includes('.py'))return;
 await writeFile(join(cwd,'good.py'),'def good():\n    return 1\n');await writeFile(join(cwd,'bad.py'),'def broken(\n');
 const index=await indexRepository({root:cwd,parser});assert.equal(index.indexedFiles,1);assert.ok(index.skipped.includes('bad.py'));assert.match(index.coverage,/Parse failures excluded: bad.py/);assert.ok(index.index.findSymbol('good').length);
});
