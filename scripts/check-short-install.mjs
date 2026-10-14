import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const host = await mkdtemp(join(tmpdir(), 'sakura-short-install-'));
try {
  const env = {...process.env, npm_config_prefix: host};
  const npmCli = process.env.npm_execpath;
  const npm = npmCli ? process.execPath : 'npm';
  const args = ['run', 'app'];
  await exec(npm, npmCli ? [npmCli, ...args] : args, {cwd: root, env, timeout: 300000, maxBuffer: 8 * 1024 * 1024});
  const library = join(host, 'lib', 'node_modules');
  const bin = join(host, 'bin', 'sakura');
  const project = join(host, 'project');
  const profile = join(host, 'profile');
  await mkdir(join(project, '.pi'), {recursive: true});
  const foreign = JSON.stringify({theme: 'foreign-theme', defaultModel: 'foreign-model'});
  await writeFile(join(project, '.pi', 'settings.json'), foreign);
  const run = args => exec(bin, ['--home', profile, ...args], {cwd: project, env, timeout: 60000, maxBuffer: 2 * 1024 * 1024});
  assert.ok((await run(['--help'])).stdout.includes('sakura init [NAME]'));
  await run(['init', 'short-command-fixture', '--offline']);
  const doctor = JSON.parse((await run(['doctor'])).stdout);
  assert.equal(doctor.models[0].id, 'short-command-fixture');
  assert.equal(doctor.extensions, 9);
  assert.deepEqual(doctor.extensionErrors, []);
  assert.deepEqual(doctor.projectSettings, {});
  assert.equal(doctor.agentDir, join(profile, 'agent'));
  assert.equal(await readFile(join(project, '.pi', 'settings.json'), 'utf8'), foreign);
  // Both the short form and the old option must validate their model arguments.
  await assert.rejects(run(['init', 'one', '--ollama-model', 'two', '--offline']), /Specify one model name/);
  await assert.rejects(run(['init', '--ollama-model', '--offline']), /requires a model name/);
  const config = JSON.parse(await readFile(join(profile, 'agent', 'models.json'), 'utf8'));
  assert.equal(config.providers.ollama.models[0].id, 'short-command-fixture');
  const pi = JSON.parse(await readFile(join(library, 'sakura-coding-agent', 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8'));
  assert.equal(pi.version, '1.1.0');
  const artifact = join(root, 'sakura.tgz');
  const report = {checkedAt: new Date().toISOString(), passed: true, command: 'npm run app', isolatedGlobalPrefix: true, shortInit: true, invalidModelArgumentsRejected: true, projectPiSettingsUnchanged: true, extensions: doctor.extensions, pi: pi.version, artifact, sha256: createHash('sha256').update(await readFile(artifact)).digest('hex')};
  const release = join(root, '.sakura', 'release');
  await mkdir(release, {recursive: true});
  await writeFile(join(release, 'short-installed.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(host, {recursive: true, force: true});
}
