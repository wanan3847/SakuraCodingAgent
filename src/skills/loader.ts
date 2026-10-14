/**
 * Skill Loader：把选中的 SKILL.md 正文读出来，作为参考注入 Agent prompt。
 *
 * Pi 已经把技能目录注入 system prompt（那是“模型自己决定要不要看”）；这里做的是
 * “Sakura 已经替你选了，直接给你正文”。两者不冲突，也不重复实现加载系统——
 * 只是同一次读取的另一个消费方。
 */

import { readFile,realpath } from "node:fs/promises";
import {createHash} from "node:crypto";
import {parseSkillFile} from "./registry.ts";
import type { SkillMeta } from "./registry.ts";

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
export interface SkillEvidence{name:string;sourcePath:string;sha256:string;reference:string;fullyIncluded:boolean}

export function stripFrontmatter(source: string): string {
	return source.replace(FRONTMATTER, "").trim();
}

export async function loadSkillBody(skill: SkillMeta): Promise<string> {
	return stripFrontmatter(await readFile(skill.path, "utf8"));
}

/**
 * 拼成可以直接塞进 prompt 的参考块。默认只带正文，不带路径噪音。
 * 超长正文按 budgetChars 截断并注明——截断要说出来，静默截断会让人以为看到的是全文。
 */
export async function loadSkillReferences(skills: readonly SkillMeta[], budgetChars = 6000): Promise<string> {
	return (await loadSkillReferenceEvidence(skills,budgetChars)).text;
}
/** Hash the same bytes from which the injected reference is derived, not a later reread. */
export async function loadSkillReferenceEvidence(skills:readonly SkillMeta[],budgetChars=6000):Promise<{text:string;evidence:SkillEvidence[]}>{
	const blocks: string[] = [];
	const evidence:SkillEvidence[]=[];
	let used = 0;
	for (const skill of skills) {
		const sourcePath=await realpath(skill.path),source=await readFile(sourcePath,"utf8"),meta=parseSkillFile(sourcePath,source);
		if(!meta||meta.name!==skill.name||meta.description!==skill.description)throw new Error("Skill metadata changed after routing");
		if(skill.artifactSha256&&createHash("sha256").update(source).digest("hex")!==skill.artifactSha256)throw new Error("Active skill artifact changed after selection");
		const body = stripFrontmatter(source);
		const remaining = budgetChars - used;
		if (remaining <= 0) {
			blocks.push(`## skill: ${skill.name}\n(正文因预算不足被省略，需要时用 read 打开 ${skill.path})`);
			evidence.push({name:skill.name,sourcePath,sha256:createHash("sha256").update(source).digest("hex"),reference:blocks.at(-1)!,fullyIncluded:false});
			continue;
		}
		const text = body.length > remaining ? `${body.slice(0, remaining)}\n\n...(截断，全文在 ${skill.path})` : body;
		used += text.length;
		blocks.push(`## skill: ${skill.name}\n${text}`);
		evidence.push({name:skill.name,sourcePath,sha256:createHash("sha256").update(source).digest("hex"),reference:blocks.at(-1)!,fullyIncluded:body.length<=remaining});
	}
	return {text:blocks.join("\n\n"),evidence};
}
