#!/usr/bin/env node
/**
 * 插件包的静态体检。目的是把「Pi 或 npm 不会告诉你」的那几类错误在本地挡掉。
 *
 * 为什么需要它：下面每一条都是**静默失败或起不来**的类型。
 *   - 扩展文件忘了 export default → Pi 报 "does not export a valid factory function" 然后 exit 1
 *   - package.json 的 pi manifest 写错类型 → 整个 manifest 被丢掉，插件一个都不加载，没有提示
 *   - manifest 指的路径不存在 → 同上
 *   - SKILL.md 缺 description → Pi 和 Sakura 的 Router 都静默忽略
 *   - 扩展 import 了没写进 dependencies 的包 → 本地能跑，`pi install` 之后 ERR_MODULE_NOT_FOUND
 *
 * 用法：
 *   node scripts/check-plugin.mjs [包目录]      # 默认当前目录
 *
 * 退出码 1 表示有 must-fix。
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(process.argv[2] ?? process.cwd());
const problems = [];
const warnings = [];
const fail = (msg) => problems.push(msg);
const warn = (msg) => warnings.push(msg);
const rel = (p) => relative(root, p) || ".";

// ---------------------------------------------------------------- package.json
const pkgPath = join(root, "package.json");
if (!existsSync(pkgPath)) {
	fail("没有 package.json：pi 在本地路径模式下靠它找 pi manifest");
} else {
	let pkgManifest;
	try {
		pkgManifest = JSON.parse(readFileSync(pkgPath, "utf8"));
	} catch (error) {
		fail(`package.json 不是合法 JSON：${error.message}`);
	}

	if (pkgManifest) {
		const manifest = pkgManifest.pi;
		if (!manifest) {
			warn("package.json 里没有 pi 字段：Pi 会按约定目录（extensions/ skills/ prompts/ themes/）发现，只在顶层生效、不递归");
		} else if (typeof manifest !== "object" || Array.isArray(manifest)) {
			fail("package.json 的 pi 字段必须是对象");
		} else {
			// readPiManifest 只认这 4 个 key，且值必须是 string[]；有一个不对就整份丢弃
			for (const [key, value] of Object.entries(manifest)) {
				if (!["extensions", "skills", "prompts", "themes"].includes(key)) {
					if (["video", "image"].includes(key)) continue; // gallery 字段，允许
					fail(`pi.${key} 不是 Pi 认识的字段（只认 extensions/skills/prompts/themes，多一个不影响，但别指望它生效）`);
					continue;
				}
				if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
					fail(`pi.${key} 必须是字符串数组——writePiManifest 的解析要求 every(string)，否则**整份 manifest 被丢弃**，插件一个都不加载`);
					continue;
				}
				for (const entry of value) {
					if (entry.includes("*")) {
						const base = join(root, entry.slice(0, entry.search(/[*?]/)).replace(/\/$/, ""));
						if (!existsSync(base)) fail(`pi.${key} 里的 "${entry}" 匹配不到东西：${rel(base)} 不存在`);
						continue;
					}
					if (!existsSync(join(root, entry))) fail(`pi.${key} 里的 "${entry}" 不存在`);
				}
			}
		}
		if (!Array.isArray(pkgManifest.keywords) || !pkgManifest.keywords.includes("pi-package")) {
			warn('keywords 里没有 "pi-package"：不影响安装，但不会出现在 package gallery');
		}
	}
}

// ------------------------------------------------------------------- extensions
/** 和 loader.ts 的 discoverExtensionsInDir 规则一致：顶层 *.ts/*.js + 一层 index.ts，不递归。 */
function discoverExtensions(root) {
	const dir = join(root, "extensions");
	if (!existsSync(dir)) return [];
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isFile() && /\.(ts|js|mts|mjs)$/.test(entry.name)) {
			out.push(path);
			continue;
		}
		if (!entry.isDirectory()) continue;
		for (const name of ["index.ts", "index.js", "index.mts", "index.mjs"]) {
			if (existsSync(join(path, name))) {
				out.push(join(path, name));
				break;
			}
		}
	}
	return out;
}

const extensions = discoverExtensions(root);
if (!extensions.length) {
	warn("extensions/ 下没发现插件文件（顶层 *.ts 或 一层 <dir>/index.ts）");
}

/** 扩展文件里 import 的裸包名（运行时由 Node 解析，必须写进 dependencies）。 */
function bareImports(source) {
	const found = new Set();
	const patterns = [
		/(?:^|\n)\s*import\s+(?:type\s+)?[^'"()]*?from\s*["']([^"'.][^"']*)["']/g,
		/(?:^|\n)\s*import\s*["']([^"'.][^"']*)["']/g,
		/\bimport\s*\(\s*["']([^"'.][^"']*)["']\s*\)/g,
		/\brequire\s*\(\s*["']([^"'.][^"']*)["']\s*\)/g,
	];
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) {
			const spec = match[1];
			if (spec.startsWith("node:") || spec.startsWith("data:") || spec.startsWith("bun:")) continue;
			found.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
		}
	}
	return found;
}

const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")) : {};
const peerDeps = pkg.peerDependencies ?? {};
const standaloneSDK = typeof pkg.bin?.sakura === "string";
if(standaloneSDK) console.log("  独立应用：自带固定 SDK；外部 Pi 插件模式需使用同版本宿主。");
const declared = new Set([
	...Object.keys(pkg.dependencies ?? {}),
	...Object.keys(pkg.devDependencies ?? {}),
	...Object.keys(peerDeps),
	...Object.keys(pkg.optionalDependencies ?? {}),
]);
/** Pi 在加载插件时提供这些（官方要求写在 peerDependencies，用 "*"），不需要装。 */
const PI_PROVIDED = new Set(["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]);

for (const path of extensions) {
	const source = readFileSync(path, "utf8");
	const name = rel(path);

	// 1. 必须有 default export，且必须是函数（含 async）。jiti.import(path, {default:true})
	if (!/export\s+default\b/.test(source)) {
		fail(`${name}: 没有 export default。Pi 会报 "does not export a valid factory function" 并 exit 1`);
	} else if (/export\s+default\s+(?!async\s+)?(?:function\b|\(|[a-zA-Z_$][\w$]*\s*=>)/.test(source) === false) {
		warn(`${name}: default export 看起来不是函数，确认一下（Pi 只接受 function）`);
	}

	// 2. 裸包名必须在 dependencies / peerDependencies 里
	for (const spec of bareImports(source)) {
		if (declared.has(spec)) {
			if (PI_PROVIDED.has(spec) && !peerDeps[spec] && !standaloneSDK) {
				warn(`${name}: 依赖 ${spec}，Pi 自己就带它。官方要求放 peerDependencies（"*"）并用 devDependencies lock 版本，别放 dependencies——否则 pi 会再装一份，扩展和宿主拿到两份实现`);
			}
			continue;
		}
		fail(`${name}: import 了 "${spec}"，但 package.json 里没有声明。本地能跑，pi install 之后会 ERR_MODULE_NOT_FOUND`);
	}

	// 3. 用 @earendil-works/* 只该 import type（运行时由 Pi 注入 api 对象）
	for (const match of source.matchAll(/(?:^|\n)\s*import\s+(?!type\b)([^'"()]*?)\bfrom\s*["']@earendil-works\//g)) {
		const clause = match[1].trim();
		const names = clause.split(",").map((s) => s.trim()).filter(Boolean);
		const valueImports = names.filter((n) => !n.startsWith("type ") && !/^\*\s+as/.test(n));
		if (valueImports.length && !standaloneSDK) {
			warn(`${name}: 从 @earendil-works/* 做了值导入（${valueImports.join(", ")}）。只 import type 更安全——运行时值由 Pi 注入，直接 import 会拿到第二份实现`);
		}
	}
}

// ------------------------------------------------ 跨插件重名（会直接让 pi 起不来）
/**
 * 工具名和 flag 名是**全局唯一**的：`resource-loader.ts:1061` 的 detectExtensionConflicts
 * 只要发现两个扩展注册同名工具就报错，而扩展加载错误会让 pi `process.exit(1)`。
 *
 * 拆成多个插件文件时这是最容易撞的东西（每个模块各写各的，谁也不知道别人注册了什么），
 * 所以在这里静态扫一遍。Pi 只在启动时报，那时候已经晚了。
 */
const toolOwners = new Map();
const flagOwners = new Map();

for (const path of extensions) {
	const source = readFileSync(path, "utf8");
	const name = rel(path);

	// registerTool({ ... name: "x" ... })：取 registerTool 之后窗口里的第一个 name
	for (const call of source.matchAll(/registerTool\s*\(\s*\{([\s\S]{0,2000})/g)) {
		const toolName = /name:\s*["'`]([^"'`]+)["'`]/.exec(call[1])?.[1];
		if (!toolName) continue;
		const owner = toolOwners.get(toolName);
		if (owner && owner !== name) {
			fail(`工具名 "${toolName}" 在 ${owner} 和 ${name} 里都注册了。Pi 会报 Tool conflict 并 exit 1`);
		} else {
			toolOwners.set(toolName, name);
		}
	}

	for (const call of source.matchAll(/registerFlag\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
		const flagName = call[1];
		const owner = flagOwners.get(flagName);
		if (owner && owner !== name) {
			fail(`flag "--${flagName}" 在 ${owner} 和 ${name} 里都注册了。Pi 会报 Flag conflict 并 exit 1`);
		} else {
			flagOwners.set(flagName, name);
		}
	}
}

// ----------------------------------------------------------------------- skills
/** Pi 递归找 SKILL.md；这里只做同样的递归并检查 frontmatter。 */
function findSkillFiles(dir, depth = 0, out = []) {
	if (depth > 4 || !existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			findSkillFiles(path, depth + 1, out);
			continue;
		}
		if (entry.name === "SKILL.md") out.push(path);
	}
	return out;
}

const skillsDir = join(root, "skills");
const skillFiles = findSkillFiles(skillsDir);
for (const path of skillFiles) {
	const source = readFileSync(path, "utf8");
	const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
	const name = rel(path);
	if (!front) {
		fail(`${name}: 没有 frontmatter。Pi 会跳过它（而且是静默的）`);
		continue;
	}
	if (!/^name:\s*\S/m.test(front[1])) fail(`${name}: frontmatter 缺 name`);
	if (!/^description:\s*\S/m.test(front[1])) fail(`${name}: frontmatter 缺 description（缺了 Pi 和 Sakura 的 Router 都会静默忽略这个技能）`);
	if (!source.replace(front[0], "").trim()) warn(`${name}: 正文是空的，加载了也没用`);

	// name 规则：小写字母/数字/连字符，1-64 位，不能首尾或连续连字符
	const raw = /^name:\s*(.+)$/m.exec(front[1])?.[1].trim() ?? "";
	if (raw && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(raw)) {
		fail(`${name}: name "${raw}" 不合法（只允许小写 a-z 0-9 和单个连字符，不能首尾或连续连字符）`);
	}
	if (raw.length > 64) fail(`${name}: name 超过 64 字符`);
}

// ---------------------------------------------------------------------- prompts
const promptsDir = join(root, "prompts");
if (existsSync(promptsDir)) {
	for (const entry of readdirSync(promptsDir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const path = join(promptsDir, entry.name);
		const source = readFileSync(path, "utf8");
		if (!source.trim()) {
			fail(`prompts/${entry.name}: 是空文件`);
			continue;
		}
		// 有 frontmatter 时 description 可选（缺了用第一行非空文本当描述）；没 frontmatter 也能用
		if (!/^---\r?\n[\s\S]*?\r?\n---/.test(source) && !source.split("\n").some((line) => line.trim())) {
			warn(`prompts/${entry.name}: 既没有 frontmatter 也没有正文`);
		}
	}
}

// ------------------------------------------------------------------------ 报告
console.log(`插件包体检：${root}`);
console.log(`  extensions: ${extensions.length} 个`);
if (extensions.length > 1) {
	console.log(`  tools:      ${toolOwners.size} 个（跨 ${extensions.length} 个插件文件检查了重名）`);
}
console.log(`  skills:     ${skillFiles.length} 个`);
console.log(`  prompts:    ${existsSync(promptsDir) ? readdirSync(promptsDir).filter((f) => f.endsWith(".md")).length : 0} 个`);

if (warnings.length) {
	console.log(`\n建议（${warnings.length}）：`);
	for (const w of warnings) console.log(`  ~ ${w}`);
}
if (problems.length) {
	console.log(`\n必须修（${problems.length}）：`);
	for (const p of problems) console.log(`  ✗ ${p}`);
	process.exit(1);
}
console.log("\n通过：没有会让插件静默失效或起不来的问题。");
