import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const script = new URL('../continue-thread.mjs', import.meta.url).pathname;

test('two schedules keep separate launchd labels, configuration, status and logs',()=>{
 const thread='01a12fdb-487a-71c1-b05d-4300dedc8cd1',at=new Date(Date.now()+3600000).toISOString();
 const install=(...args)=>JSON.parse(execFileSync(process.execPath,[script,'--install','--thread',thread,'--at',at,'--codex','/unused/codex','--dry-run',...args],{encoding:'utf8'}));
 const first=install(),second=install('--job-id','0500','--config','/tmp/sakura-continue-0500.json');
 assert.equal(first.installed,false);assert.equal(second.installed,false);assert.notEqual(first.label,second.label);assert.notEqual(first.statusFile,second.statusFile);assert.notEqual(first.logFile,second.logFile);assert.notEqual(first.jobFile,second.jobFile);assert.equal(second.thread,thread);assert.equal(second.message,'继续');
});

test('scheduled message waits, sends to the exact thread once and is cancellable', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sakura-continue-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const codex = join(dir, 'codex');
  const calls = join(dir, 'calls.jsonl');
  await writeFile(codex, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n');\n`);
  await chmod(codex, 0o700);
  const configPath = join(dir, 'config.json');
  const config = { codex, thread: 'test-thread', message: '继续', cwd: dir, at: new Date(Date.now()+3600000).toISOString(), displayAt: 'future', statusFile: join(dir,'status.json'), jobFile: join(dir,'absent.plist'), label: 'local.sakura.test.nonexistent' };
  const run = (...args) => execFileSync(process.execPath, [script, ...args, '--config', configPath], { encoding:'utf8' });
  await writeFile(configPath, JSON.stringify(config));
  assert.match(run('--run'), /Waiting/);
  await assert.rejects(readFile(calls), { code:'ENOENT' });
  config.at = new Date(0).toISOString();
  await writeFile(configPath, JSON.stringify(config));
  run('--run');
  assert.equal(JSON.parse(await readFile(config.statusFile, 'utf8')).status, 'sent');
  assert.match(run('--run'), /Already sent/);
  const records = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records, [['queue','--thread','test-thread','--message','继续','--cd',dir]]);
  run('--cancel');
  assert.match(run('--run'), /Cancelled/);
  assert.equal((await readFile(calls,'utf8')).trim().split('\n').length,1);
});
