/**
 * 从仓库配置推断验证命令。对应架构文档 §13。
 * 只看仓库里真实存在的文件，推断不出来就不编造。
 */

import { readFile, access } from "node:fs/promises";
import { join } from "node:path";

export interface VerificationPlan {
	lint?: string[];
	typecheck?: string[];
	test?: string[];
	build?: string[];
	custom?: string[];
}

const CANDIDATES = {
	lint: ["lint", "eslint", "biome", "check:lint", "format:check"],
	typecheck: ["typecheck", "type-check", "tsc", "check:types"],
	test: ["test", "test:unit", "vitest", "jest"],
	build: ["build", "compile"],
} as const;

export async function detectVerificationPlan(dir: string): Promise<VerificationPlan> {
	const plan: VerificationPlan = {};

	const pkg = await readJson(join(dir, "package.json"));
	if (pkg?.scripts) {
		const declared=typeof pkg.packageManager==='string'?pkg.packageManager.split('@')[0]:undefined;
		const manager=declared&&['npm','pnpm','yarn','bun'].includes(declared)?declared:
      await exists(join(dir,'pnpm-lock.yaml'))?'pnpm':await exists(join(dir,'yarn.lock'))?'yarn':await exists(join(dir,'bun.lock'))||await exists(join(dir,'bun.lockb'))?'bun':'npm';
		const scripts = pkg.scripts as Record<string, string>;
		for (const [kind, names] of Object.entries(CANDIDATES)) {
			const hit = names.find((name) => typeof scripts[name] === "string");
			if (hit) plan[kind as keyof typeof CANDIDATES] = [`${manager} run ${hit}`];
		}
	}

	if (await exists(join(dir, "pyproject.toml"))) {
		const text = await readFile(join(dir, "pyproject.toml"), "utf8");
		if (/\bpytest\b/.test(text)) plan.test = push(plan.test, "python -m pytest");
		if (/\bruff\b/.test(text)) plan.lint = push(plan.lint, "ruff check .");
		if (/\bmypy\b/.test(text)) plan.typecheck = push(plan.typecheck, "mypy .");
	}

	if (await exists(join(dir, "Makefile"))) {
		const text = await readFile(join(dir, "Makefile"), "utf8");
		for (const target of ["test", "lint", "build"]) {
			if (new RegExp(`^${target}:`, "m").test(text)) {
				plan[target as "test" | "lint" | "build"] = push(plan[target as "test"], `make ${target}`);
			}
		}
	}

	if (await exists(join(dir, "Cargo.toml"))) {
		plan.test = push(plan.test, "cargo test");
		plan.build = push(plan.build, "cargo build");
		if (await exists(join(dir, "clippy.toml"))) plan.lint = push(plan.lint, "cargo clippy");
	}

	if (await exists(join(dir, "go.mod"))) {
		plan.test = push(plan.test, "go test ./...");
		plan.build = push(plan.build, "go build ./...");
	}

	return plan;
}

/** 展开成按顺序执行、遇错即停的命令列表：先快后慢。 */
export function toCommandSequence(plan: VerificationPlan): string[] {
	return [...(plan.lint ?? []), ...(plan.typecheck ?? []), ...(plan.build ?? []), ...(plan.test ?? []), ...(plan.custom ?? [])];
}

function push(list: string[] | undefined, value: string): string[] {
	return [...(list ?? []), value];
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
