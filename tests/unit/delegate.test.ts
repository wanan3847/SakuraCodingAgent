/**
 * 并行委托的行为测试。用 FakeAgentRunner，不烧 token、不需要 git。
 *
 * 要证明的几件事（都是"看起来对但容易错"的）：
 *   - 真并发，且并发上限生效
 *   - 只读角色不建 worktree，写角色建（git 不可用时降级成原地 + 明确 warning）
 *   - 一个任务失败不拖垮整批
 *   - 多人改同一个文件能被冲突报告抓到
 *   - diff 落盘、trace 落盘
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir,mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { cleanupDelegation, delegateTasks, renderDelegation } from "../../src/orchestrator/delegate.ts";
import type { AgentRunner, AgentRunInput, AgentRunResult } from "../../src/orchestrator/agent-runner.ts";

const run = promisify(execFile);

/** 记录每个任务"同时有几个在跑"，并可以按 id 定制返回。 */
function trackingRunner(
	responses: Record<string, Partial<AgentRunResult>> = {},
	onRun?: (input: AgentRunInput, concurrency: number) => unknown,
): { runner: AgentRunner; peak: () => number; roles: string[] } {
	let active = 0;
	let peak = 0;
	const roles: string[] = [];
	const runner: AgentRunner = {
		async run(input) {
			active += 1;
			peak = Math.max(peak, active);
			roles.push(input.role);
			await onRun?.(input, active);
			// 让出事件循环，制造真实的并发窗口
			await new Promise((resolve) => setTimeout(resolve, 5));
			active -= 1;
			return {
				status: "success",
				summary: `${input.task.id} done`,
				changedFiles: [],
				evidence: [],
				toolCalls: 1,
				...responses[input.task.id],
			};
		},
	};
	return { runner, peak: () => peak, roles };
}

test("runs independent tasks concurrently, bounded by maxConcurrency", async () => {
	const root = await mkdtemp(join(tmpdir(), "sakura-delegate-"));
	const { runner, peak } = trackingRunner();

	const outcome = await delegateTasks({
		cwd: root,
		runner,
		maxConcurrency: 2,
		tasks: Array.from({ length: 6 }, (_, index) => ({
			id: `t${index}`,
			description: "read something",
			role: "explorer" as const,
		})),
	});

	assert.equal(outcome.tasks.length, 6);
	assert.ok(outcome.tasks.every((task) => task.status === "success"));
	// 真的并发了（不是串行），而且没超过上限
	assert.ok(peak() >= 2, `期望并发，实测峰值 ${peak()}`);
	assert.ok(peak() <= 2, `并发上限没生效，实测峰值 ${peak()}`);
	assert.deepEqual(outcome.tasks.map((task) => task.id), ["t0", "t1", "t2", "t3", "t4", "t5"], "结果顺序必须和输入一致");
});

test("read-only roles skip the worktree, writing roles ask for one", async () => {
	const root = await mkdtemp(join(tmpdir(), "sakura-delegate-"));
	const seen: Array<{ id: string; path: string }> = [];
	const { runner } = trackingRunner({}, (input) => seen.push({ id: input.task.id, path: input.workspacePath }));

	const outcome = await delegateTasks({
		cwd: root,
		runner,
		tasks: [
			{ id: "explore", description: "read", role: "explorer" },
			{ id: "review", description: "read", role: "reviewer" },
			{ id: "impl", description: "write", role: "implementer", writeScope: ["src/"] },
		],
	});

	// 只读角色原地跑：省掉一次 git worktree add
	for (const id of ["explore", "review"]) {
		assert.equal(seen.find((entry) => entry.id === id)?.path, root, `${id} 应该原地跑`);
		assert.equal(outcome.tasks.find((task) => task.id === id)?.worktree, undefined);
	}
	// 这个 tmp 目录不是 git 仓库 → 写角色必须降级，而且降级要**说出来**
	assert.equal(outcome.tasks.find(task=>task.id==="impl")?.status,"failure");
 assert.ok(!seen.some(task=>task.id==="impl"),"failed isolation must never dispatch a writer in the original directory");
 assert.ok(
		outcome.warnings.some((warning) => warning.includes("impl") && warning.includes("worktree")),
		"worktree 降级必须写成 warning，不能静默原地改",
	);
});

test("writing roles really get an isolated worktree in a git repo, and it is cleaned up", async () => {
	const root = await mkdtemp(join(tmpdir(), "sakura-delegate-git-"));
	const git = (...args: string[]) => run("git", args, { cwd: root });
	await git("init", "-q");
	await writeFile(join(root, "a.txt"), "one\n");
	await git("add", "-A");
	await git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");

	const seen: Array<{ id: string; path: string }> = [];
	const { runner } = trackingRunner({}, (input) => seen.push({ id: input.task.id, path: input.workspacePath }));

	const outcome = await delegateTasks({
		cwd: root,
		runner,
		tasks: [
			{ id: "impl", description: "write", role: "implementer", writeScope: ["a.txt"] },
			{ id: "explore", description: "read", role: "explorer" },
		],
	});

	const implPath = seen.find((entry) => entry.id === "impl")?.path;
	// 写角色必须跑在**另一个目录**里，否则两个 Agent 会互相改坏
	assert.ok(implPath && implPath !== root, `implementer 应该在隔离目录里跑，实际 ${implPath}`);
	assert.equal(outcome.tasks.find((task) => task.id === "impl")?.worktree, implPath);
	assert.equal(seen.find((entry) => entry.id === "explore")?.path, root, "explorer 原地跑");
	assert.deepEqual(outcome.warnings, [], "真仓库里不该有降级 warning");

	// 默认清理：worktree 目录不该留在磁盘上，`git worktree list` 也不该累积
	assert.equal(outcome.kept, false);
	assert.equal(existsSync(implPath), false, "跑完必须清掉 worktree");
	const list = await run("git", ["worktree", "list"], { cwd: root });
	assert.equal(list.stdout.trim().split("\n").length, 1, "git worktree list 只剩主工作区");
});

test("keepWorktrees: true leaves the worktree, and cleanup happens only when asked", async () => {
	const root = await mkdtemp(join(tmpdir(), "sakura-delegate-keep-"));
	const git = (...args: string[]) => run("git", args, { cwd: root });
	await git("init", "-q");
	await writeFile(join(root, "a.txt"), "one\n");
	await git("add", "-A");
	await git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");

	const { runner } = trackingRunner();
	const outcome = await delegateTasks({
		cwd: root,
		runner,
		keepWorktrees: true,
		tasks: [{ id: "impl", description: "write", role: "implementer" }],
	});

	const worktree = outcome.tasks[0]?.worktree;
	assert.ok(worktree && existsSync(worktree), "keepWorktrees: true 必须真的留着，report 里的路径要能被打开");
	assert.equal(outcome.kept, true);

	await cleanupDelegation(outcome, root);
	assert.equal(existsSync(worktree), false, "显式 cleanup 之后要消失");
	// 幂等：再调一次不该抛
	await cleanupDelegation(outcome, root);
});

test("one failing task does not abort the batch, and the failure is reported", async () => {
	const root = await mkdtemp(join(tmpdir(), "sakura-delegate-"));
	const { runner } = trackingRunner({
		bad: { status: "failure", summary: "model call failed: Connection error." },
	});

	const outcome = await delegateTasks({
		cwd: root,
		runner,
		tasks: [
			{ id: "good1", description: "x", role: "explorer" },
			{ id: "bad", description: "y", role: "explorer" },
			{ id: "good2", description: "z", role: "explorer" },
		],
	});

	assert.deepEqual(
		outcome.tasks.map((task) => [task.id, task.status]),
		[
			["good1", "success"],
			["bad", "failure"],
			["good2", "success"],
		],
	);
	assert.match(outcome.tasks[1]!.summary, /Connection error/);
	// 失败也要进 trace 的 metrics
	assert.equal(outcome.metrics.tasksFailed, 1);
	assert.equal(outcome.metrics.tasksSucceeded, 2);
});

test("two agents touching the same file shows up in the conflict report", async () => {
	const root = await mkdtemp(join(tmpdir(), "sakura-delegate-"));
	await run("git",["init","-q"],{cwd:root});await writeFile(join(root,"base.txt"),"base");await run("git",["add","-A"],{cwd:root});await run("git",["-c","user.email=t@t","-c","user.name=t","commit","-qm","base"],{cwd:root});
 const responses={
		a: { changedFiles: ["src/shared.ts", "src/a.ts"] },
		b: { changedFiles: ["src/shared.ts"] },
		c: { changedFiles: ["src/c.ts"] },
	};
 const {runner}=trackingRunner(responses,async input=>{await mkdir(join(input.workspacePath,'src'),{recursive:true});for(const path of responses[input.task.id as keyof typeof responses].changedFiles)await writeFile(join(input.workspacePath,path),input.task.id);});

	const outcome = await delegateTasks({
		cwd: root,
		runner,
		tasks: [
			{ id: "a", description: "x", role: "implementer" },
			{ id: "b", description: "y", role: "implementer" },
			{ id: "c", description: "z", role: "implementer" },
		],
	});

	assert.equal(outcome.conflicts.clean, false);
	assert.deepEqual(outcome.conflicts.conflicts, [{ files: ["src/shared.ts"], sessions: ["a", "b"] }]);
	const report = renderDelegation(outcome);
	assert.match(report, /src\/shared\.ts ← a, b/);
	assert.match(report, /合并前先看 CONFLICTS/);
});

test("trace and diff files land on disk, and cleanup is opt-out", async () => {
	const root = await mkdtemp(join(tmpdir(), "sakura-delegate-"));
	const { runner } = trackingRunner();

	const outcome = await delegateTasks({ cwd: root, runner, tasks: [{ id: "only", description: "x", role: "explorer" }] });

	const events = await readFile(join(outcome.traceDir, "events.jsonl"), "utf8");
	const types = events.trim().split("\n").map((line) => JSON.parse(line).event.type);
	assert.ok(types.includes("task.created"));
	assert.ok(types.includes("task.started"));
	assert.ok(types.includes("task.usage"));
	assert.ok(types.includes("task.finished"));

	const metrics = JSON.parse(await readFile(join(outcome.traceDir, "metrics.json"), "utf8"));
	assert.equal(metrics.tasksSucceeded, 1);

	// 只读角色没有 worktree，cleanup 不该炸
	await cleanupDelegation(outcome, root);
	assert.deepEqual(await readdir(join(outcome.traceDir)).then((files) => files.sort()), ["budget.json","events.jsonl", "metrics.json"]);
});

test("an empty task list is a no-op, not a crash", async () => {
	const root = await mkdtemp(join(tmpdir(), "sakura-delegate-"));
	const { runner } = trackingRunner();
	const outcome = await delegateTasks({ cwd: root, runner, tasks: [] });
	assert.deepEqual(outcome.tasks, []);
	assert.equal(outcome.conflicts.clean, true);
	assert.match(renderDelegation(outcome), /tasks: 0/);
});
