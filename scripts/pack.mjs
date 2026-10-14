#!/usr/bin/env node
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, readFile, copyFile, rename, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const exec = promisify(execFile);
const source = fileURLToPath(new URL('../', import.meta.url));
const output = resolve('sakura.tgz');
const temporary = await mkdtemp(join(tmpdir(), 'sakura-pack-'));
const staging = `${output}.${process.pid}.tmp`;
try {
  const args = ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary, '--cache', join(temporary, 'cache')];
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = await exec(command, npmCli ? [npmCli, ...args] : args, {cwd: source, maxBuffer: 8 * 1024 * 1024});
  const [packed] = JSON.parse(result.stdout);
  if (!packed?.filename || packed.filename !== packed.filename.split(/[\\/]/).at(-1)) throw new Error('Invalid npm pack artifact');
  const artifact = join(temporary, packed.filename);
  const sha256 = createHash('sha256').update(await readFile(artifact)).digest('hex');
  await copyFile(artifact, staging);
  await rename(staging, output);
  console.log(`已打包：${output}\n版本：${packed.version}\nSHA-256：${sha256}\n\n源码目录一键打包安装：\n  npm run app\n\n已有安装包时：\n  npm i -g ./sakura.tgz\n\n首次配置：\n  sakura init\n\n在任意项目目录启动：\n  sakura`);
} finally {
  await rm(staging, {force: true});
  await rm(temporary, {recursive: true, force: true});
}
