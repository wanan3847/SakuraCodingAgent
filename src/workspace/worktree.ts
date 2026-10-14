/**
 * Git worktree 隔离。对应架构文档 §11。
 *
 * 只做 P0 三件事：建 worktree、收 diff、清理。冲突检测只比 changed files。
 * TODO(P1): cherry-pick / merge 集成、语义冲突分析。
 */

import { execFile } from "node:child_process";
import {symlink} from "node:fs/promises";
import {atomicWrite} from "../storage/atomic.ts";
import {join} from "node:path";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { captureChanges, type WorkspaceChanges } from "./artifacts.ts";

const exec = promisify(execFile);

export interface AgentSession {
	agentId: string;
	taskId: string;
	branch: string;
	worktreePath: string;
	baseCommit: string;
	changedFiles: string[];
	diff?: string;
	artifact?: WorkspaceChanges;
	startedAt: number;
	endedAt?: number;
}

export interface WorkspaceManagerOptions {
	repoPath: string;
	/** worktree 放在仓库外，避免被自己索引到 */
	rootDir: string;
	baseRef?: string;
}

export async function createWorkspace(
	taskId: string,
	repoPath: string,
	rootDir: string,
	baseRef = "HEAD",
): Promise<AgentSession> {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(taskId)) throw new Error(`Unsafe workspace task id: ${taskId}`);
	const branch = `sakura/${taskId}`;
	const worktreePath = `${rootDir}/${taskId}`;
	const { stdout: head } = await exec("git", ["rev-parse", baseRef], { cwd: repoPath });
	await exec("git", ["worktree", "add", "-b", branch, worktreePath, baseRef], { cwd: repoPath });
	// Reuse an existing ignored dependency tree. Native tool guards resolve this symlink,
  // so writes through it cannot silently modify the original project dependencies.
  const dependencies=join(repoPath,"node_modules"),linked=join(worktreePath,"node_modules");
  if(existsSync(dependencies) && !existsSync(linked)) {
    const ignored=await exec("git",["check-ignore","--quiet","node_modules/"],{cwd:worktreePath}).then(()=>true,()=>false);
    if(ignored) {
      await symlink(dependencies,linked,"dir");
      // Git's node_modules/ ignore rule stops matching when the path is a symlink.
      await atomicWrite(join(worktreePath,".sakura","generated-dependencies.json"),JSON.stringify(["node_modules"]));
    }
  }
  return {
		agentId: "",
		taskId,
		branch,
		worktreePath,
		baseCommit: head.trim(),
		changedFiles: [],
		startedAt: Date.now(),
	};
}

export async function collectDiff(session: AgentSession): Promise<string> {
	const artifact = await captureChanges(session.worktreePath, session.baseCommit);
	session.changedFiles = artifact.changedFiles;
	session.artifact = artifact;
	session.diff = artifact.diff;
	session.endedAt = Date.now();
	return artifact.diff;
}

export async function cleanupWorkspace(session: AgentSession, repoPath: string): Promise<void> {
	if (existsSync(session.worktreePath)) {
		await exec("git", ["worktree", "remove", "--force", session.worktreePath], { cwd: repoPath });
	} else {
		await exec("git", ["worktree", "prune", "--expire", "now"], { cwd: repoPath });
	}
	const branch = session.branch ?? `sakura/${session.taskId}`;
	const present = await exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoPath }).then(() => true, () => false);
	if (present) await exec("git", ["branch", "-D", branch], { cwd: repoPath });
}

export interface ConflictReport {
	conflicts: Array<{ files: string[]; sessions: string[] }>;
	clean: boolean;
}

/** 只按 changed files 判重叠；文件级冲突就串行化，不做语义合并。 */
export function detectConflict(sessions: AgentSession[]): ConflictReport {
	const byFile = new Map<string, string[]>();
	for (const session of sessions) {
		for (const file of session.changedFiles) {
			byFile.set(file, [...(byFile.get(file) ?? []), session.taskId]);
		}
	}
	const conflicts = [...byFile.entries()]
		.filter(([, tasks]) => tasks.length > 1)
		.map(([file, tasks]) => ({ files: [file], sessions: tasks }));
	return { conflicts, clean: conflicts.length === 0 };
}
