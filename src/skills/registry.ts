/**
 * Skill Catalog：复用指南 §9.2 的「Pi Resource Loader → Skill Metadata Catalog」那一格。
 *
 * 这里**不重写 Skill 系统**：Pi 的 Resource Loader 已经负责发现、校验和把 SKILL.md 注入
 * system prompt。Sakura 只读同一批文件的 frontmatter，建一份给 Router 用的目录。
 * 换句话说，Pi 决定“模型能看见什么技能”，Sakura 决定“这个任务该重点参考哪一个”。
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface SkillMeta {
	/** frontmatter 的 name（缺省时退回目录名） */
	name: string;
	description: string;
	/** SKILL.md 的绝对路径 */
	path: string;
	/** 所属目录（用于展示） */
	dir: string;
	/** Present for controller-owned published skills, checked on the actual read. */
	artifactSha256?:string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

export function parseSkillFile(path: string, source: string): SkillMeta | undefined {
	const match = FRONTMATTER.exec(source);
	if (!match) return undefined;
	let front: { name?: unknown; description?: unknown };
	try {
		front = parseYaml(match[1] ?? "") ?? {};
	} catch {
		return undefined;
	}
	const description = typeof front.description === "string" ? front.description.trim() : "";
	if (!description) return undefined; // 没 description 的技能没法路由（也过不了 Pi 的校验）
	const dir = path.replace(/\/SKILL\.md$/, "");
	const name = typeof front.name === "string" && front.name.trim() ? front.name.trim() : (dir.split("/").pop() ?? "unknown");
	return { name, description, path, dir };
}

/**
 * 找每个 skills 根目录下的 SKILL.md。目录不存在就跳过，不报错。
 *
 * 递归（深度受 MAX_DEPTH 限制）而不是只看一层：Pi 的 Resource Loader 也是递归发现的，
 * 而像 `~/.agents/skills/<group>/<skill>/SKILL.md` 这种分组目录只看一层会整组漏掉。
 *
 * 按路径去重：包内 skills/ 和项目 skills/ 经常是同一个目录（在 Sakura 仓库里跑就是），
 * 不去重会让同一个技能在 Router 里出现两次、还互相压分。
 */
const MAX_DEPTH = 3;

export async function loadSkillCatalog(dirs: readonly string[]): Promise<SkillMeta[]> {
	const found: SkillMeta[] = [];
	const seen = new Set<string>();

	async function walk(dir: string, depth: number): Promise<void> {
		if (depth > MAX_DEPTH) return;
		let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const child = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(child, depth + 1);
				continue;
			}
			if (entry.name !== "SKILL.md" || seen.has(child)) continue;
			seen.add(child);
			const meta = parseSkillFile(child, await readFile(child, "utf8"));
			if (meta) found.push(meta);
		}
	}

	for (const dir of dirs) await walk(dir, 0);
	return found.sort((a, b) => a.name.localeCompare(b.name));
}
