/**
 * 体检脚本自己的测试。
 *
 * 为什么值得测：这个脚本的全部价值就是「把静默失败变成显式失败」。
 * 如果它对下面这些畸形包返回 0，那它比没有更糟——人会以为一切正常。
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "check-plugin.mjs");
const run = promisify(execFile);

async function pkg(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "sakura-plugin-"));
	for (const [path, content] of Object.entries(files)) {
		const target = join(root, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content);
	}
	return root;
}

/** 跑体检脚本，返回 { code, output }。脚本退出 1 不算异常。 */
async function check(root: string): Promise<{ code: number; output: string }> {
	try {
		const { stdout, stderr } = await run("node", [CHECKER, root]);
		return { code: 0, output: `${stdout}${stderr}` };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
	}
}

const OK_EXTENSION = 'export default function (pi) { pi.registerTool({ name: "x" }); }\n';
const OK_MANIFEST = JSON.stringify({ name: "p", keywords: ["pi-package"], pi: { extensions: ["./extensions"] } });

test("模板包自己必须通过体检", async () => {
	const template = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates", "pi-plugin");
	const { code, output } = await check(template);
	assert.equal(code, 0, output);
});

test("扩展文件没有 export default 会被拦下（Pi 会因此 exit 1）", async () => {
	const root = await pkg({
		"package.json": OK_MANIFEST,
		// 常见错法：写成具名导出，加载时拿到的不是函数
		"extensions/broken.ts": "export function broken(pi) {}\n",
	});
	const { code, output } = await check(root);
	assert.equal(code, 1);
	assert.match(output, /export default/);
});

test("pi manifest 的值类型写错会被拦下（那会让整份 manifest 被丢弃）", async () => {
	const root = await pkg({
		"package.json": JSON.stringify({ name: "p", pi: { extensions: "./extensions" } }),
		"extensions/ok.ts": OK_EXTENSION,
	});
	const { code, output } = await check(root);
	assert.equal(code, 1);
	assert.match(output, /字符串数组/);
});

test("pi manifest 指向不存在的路径会被拦下", async () => {
	const root = await pkg({
		"package.json": JSON.stringify({ name: "p", pi: { extensions: ["./extensions"], skills: ["./nope"] } }),
		"extensions/ok.ts": OK_EXTENSION,
	});
	const { code, output } = await check(root);
	assert.equal(code, 1);
	assert.match(output, /不存在/);
});

test("SKILL.md 缺 description、name 不合法都会被拦下", async () => {
	const root = await pkg({
		"package.json": OK_MANIFEST,
		"extensions/ok.ts": OK_EXTENSION,
		"skills/no-description/SKILL.md": "---\nname: no-description\n---\nbody\n",
		"skills/Bad_Name/SKILL.md": "---\nname: Bad_Name\ndescription: x\n---\nbody\n",
		"skills/no-frontmatter/SKILL.md": "# just markdown\n",
	});
	const { code, output } = await check(root);
	assert.equal(code, 1);
	assert.match(output, /缺 description/);
	assert.match(output, /不合法/);
	assert.match(output, /没有 frontmatter/);
});

test("import 了没声明的包会被拦下（本地能跑，pi install 之后炸）", async () => {
	const root = await pkg({
		"package.json": OK_MANIFEST,
		"extensions/ok.ts": 'import yaml from "js-yaml";\nexport default function (pi) { void yaml; void pi; }\n',
	});
	const { code, output } = await check(root);
	assert.equal(code, 1);
	assert.match(output, /js-yaml/);
	assert.match(output, /package\.json 里没有声明/);
});

test("两个插件注册同名工具会被拦下（Pi 会报 Tool conflict 并 exit 1）", async () => {
	const tool = (label: string) =>
		`export default function (pi) {\n  pi.registerTool({\n    name: "shared_tool",\n    label: "${label}",\n    description: "d",\n    parameters: { type: "object", properties: {} },\n    async execute() { return { content: [], details: {} }; },\n  });\n}\n`;
	const root = await pkg({
		"package.json": JSON.stringify({ name: "p", pi: { extensions: ["./extensions"] } }),
		"extensions/a.ts": tool("a"),
		"extensions/b.ts": tool("b"),
	});
	const { code, output } = await check(root);
	assert.equal(code, 1);
	assert.match(output, /工具名 "shared_tool"/);
	assert.match(output, /Tool conflict/);
	// 跨文件检查要真的读到多行 registerTool（早期版本窗口太小，扫不到真实文件）
	assert.match(output, /tools:\s+1 个/);
});

test("不同插件注册不同工具是允许的", async () => {
	const tool = (name: string) =>
		`export default function (pi) { pi.registerTool({ name: "${name}", label: "x", description: "d", parameters: {}, async execute() { return {}; } }); }\n`;
	const root = await pkg({
		"package.json": JSON.stringify({ name: "p", pi: { extensions: ["./extensions"] } }),
		"extensions/a.ts": tool("tool_a"),
		"extensions/b.ts": tool("tool_b"),
	});
	const { code, output } = await check(root);
	assert.equal(code, 0, output);
	assert.match(output, /tools:\s+2 个/);
});

test("两个插件注册同名 flag 也会被拦下", async () => {
	const ext = (n: string) => `export default function (pi) { pi.registerFlag("${n}", { type: "boolean" }); }\n`;
	const root = await pkg({
		"package.json": JSON.stringify({ name: "p", pi: { extensions: ["./extensions"] } }),
		"extensions/a.ts": ext("dry-run"),
		"extensions/b.ts": ext("dry-run"),
	});
	const { code, output } = await check(root);
	assert.equal(code, 1);
	assert.match(output, /flag "--dry-run"/);
});

test("依赖 Pi 自带的包时，放 dependencies 只给建议，不拦", async () => {
	const root = await pkg({
		"package.json": JSON.stringify({
			name: "p",
			pi: { extensions: ["./extensions"] },
			dependencies: { typebox: "1.1.38" },
		}),
		"extensions/ok.ts": 'import { Type } from "typebox";\nexport default function (pi) { void Type; void pi; }\n',
	});
	const { code, output } = await check(root);
	assert.equal(code, 0, output);
	assert.match(output, /peerDependencies/);
});
