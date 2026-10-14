#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

if (process.argv.slice(2).some(arg => ['--help', '-h'].includes(arg))) {
  console.log('npm run app：在当前目录生成 sakura.tgz 并安装 sakura 命令。\n需要当前 npm 全局目录可写；不会修改 Pi 配置。');
} else {
  const run = (command, args) => new Promise((accept, reject) => {
    const child = spawn(command, args, {stdio: 'inherit'});
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? accept() : reject(new Error(signal ? `安装被 ${signal} 中断` : `命令退出码 ${code}`)));
  });
  let packed = false;
  try {
    await run(process.execPath, [fileURLToPath(new URL('./pack.mjs', import.meta.url))]);
    packed = true;
    const args = ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', resolve('sakura.tgz')];
    const npmCli = process.env.npm_execpath;
    await run(npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm', npmCli ? [npmCli, ...args] : args);
    console.log('\n安装完成。首次配置：sakura init YOUR_MODEL\n在任意项目目录启动：sakura');
  } catch (error) {
    console.error(`安装未完成：${error instanceof Error ? error.message : String(error)}。${packed ? '安装包保留在 sakura.tgz。' : ''}请根据 npm 错误检查写权限与网络。`);
    process.exitCode = 1;
  }
}
