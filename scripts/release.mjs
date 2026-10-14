#!/usr/bin/env node
/**
 * 构建发布工件，并在需要时创建 GitHub Release。
 *
 *   npm run release                 # 只构建：sakura.tgz + .sakura/release/{SHA256SUMS,install.sh,release-notes.md}
 *   npm run release -- --publish    # 额外用 gh 创建 Release（需要先 gh auth login）
 *   npm run release -- --publish --tag v0.1.1
 *
 * 发布产物的三个资源固定同名：sakura.tgz / SHA256SUMS / install.sh，
 * 这样 install.sh 里的下载地址不需要随版本变化。
 */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, readFile, writeFile, copyFile, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback;
};

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = value('--version', pkg.version);
const tag = value('--tag', `v${version}`);
const outDir = join(root, '.sakura', 'release');
const tarball = join(root, 'sakura.tgz');
const sumsFile = join(outDir, 'SHA256SUMS');
const installSh = join(outDir, 'install.sh');
const notesFile = join(outDir, 'release-notes.md');
const publish = flag('--publish');
const repo = value('--repo', process.env.SAKURA_REPO ?? 'wanan3847/SakuraCodingAgent');

if (version !== pkg.version) {
  console.error(`版本不一致：package.json 是 ${pkg.version}，--version 给的是 ${version}`);
  process.exitCode = 1;
  process.exit();
}

// 1. 打包（复用 pack.mjs，保证只有一个打包实现）
if (!flag('--skip-pack')) await exec(process.execPath, [join(root, 'scripts', 'pack.mjs')], {cwd: root, stdio: 'inherit'});
await stat(tarball);

// 2. 校验和与安装脚本
const sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
await mkdir(outDir, {recursive: true});
await writeFile(sumsFile, `${sha256}  sakura.tgz\n`);
await copyFile(join(root, 'scripts', 'install.sh'), installSh);
// 把 tarball 也放进同一个目录，方便手动上传或用 file:// 本地验证
await copyFile(tarball, join(outDir, 'sakura.tgz'));

// 3. Release 说明
const bytes = (await stat(tarball)).size;
await writeFile(notesFile, `# Sakura Coding Agent ${tag}

发布工件：\`sakura.tgz\`（${(bytes / 1024).toFixed(0)} KiB）· SHA-256 \`${sha256}\`

## 安装

\`\`\`sh
curl -fsSL https://github.com/${repo}/releases/latest/download/install.sh | sh
\`\`\`

需要 Node.js >= 22.19 与 npm。脚本会校验 SHA-256 后执行 \`npm i -g\`；也可以下载 \`sakura.tgz\` 自己安装：

\`\`\`sh
npm i -g ./sakura.tgz
\`\`\`

## 升级

重新运行上面的 curl 命令，或 \`npm i -g ./sakura.tgz\`。卸载：\`npm rm -g sakura-coding-agent\`。

## 首次运行

\`\`\`sh
sakura init      # 选择本机 Ollama 模型，写入独立配置 ~/.sakura
sakura           # 启动终端工作台
sakura doctor    # 检查独立配置、资源与 MCP
\`\`\`

## 版本信息

- Pi 基线：${JSON.parse(await readFile(join(root, 'docs', 'pi-compatibility.json'), 'utf8')).pi ?? '1.1.0'}
- 变更与已知边界：见仓库 \`docs/实施记录.md\` 与 \`docs/完成度审计.md\`
- 升级依赖流程：见 \`docs/UPSTREAM.md\`
`);

console.log(JSON.stringify({tag, version, tarball, bytes, sha256, assets: ['sakura.tgz', 'SHA256SUMS', 'install.sh'], publish, repo}, null, 2));

if (!publish) {
  console.log(`\n只构建了工件。发布到 GitHub Release：\n  npm run release -- --publish\n\n发布后的一行安装：\n  curl -fsSL https://github.com/${repo}/releases/latest/download/install.sh | sh`);
  process.exit(0);
}

// 4. 创建 Release（不创建 tag 之外的引用，不做 force）
try {
  await exec('gh', ['--version']);
} catch {
  console.error('没有找到 gh CLI（https://cli.github.com），无法发布。工件已生成在 .sakura/release/。');
  process.exitCode = 1;
  process.exit();
}
try {
  await exec('gh', ['auth', 'status']);
} catch {
  console.error('gh 未登录。先运行 gh auth login，或手动上传 .sakura/release/ 下的三个资源。');
  process.exitCode = 1;
  process.exit();
}
const alreadyExists = await exec('gh', ['release', 'view', tag, '--repo', repo]).then(() => true, () => false);
if (alreadyExists) {
  console.error(`Release ${tag} 已存在；不覆盖已有发布。用 --tag 指定新版本，或先 gh release delete ${tag}。`);
  process.exitCode = 1;
  process.exit();
}
await exec('gh', ['release', 'create', tag, '--repo', repo, '--title', `Sakura Coding Agent ${tag}`, '--notes-file', notesFile, tarball, sumsFile, installSh], {cwd: root, stdio: 'inherit'});
console.log(`\n已发布 ${tag}。一行安装：\n  curl -fsSL https://github.com/${repo}/releases/latest/download/install.sh | sh`);
