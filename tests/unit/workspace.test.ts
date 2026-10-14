import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolPolicy } from "../../src/workspace/sandbox-policy.ts";
import { createWorkspaceManager } from "../../src/workspace/workspace-manager.ts";
import type { AgentSession } from "../../src/workspace/worktree.ts";

const policy = createToolPolicy({ workspacePath: "/repo/wt-task-1" });

test("writes inside the workspace are allowed, outside are denied", () => {
	assert.deepEqual(policy.evaluate({ agentId: "a", tool: "edit", kind: "write", path: "/repo/wt-task-1/src/x.ts" }), { type: "allow" });
	assert.equal(policy.evaluate({ agentId: "a", tool: "edit", kind: "write", path: "/repo/src/x.ts" }).type, "deny");
});

test("protected paths are denied even inside the workspace", () => {
	assert.equal(policy.evaluate({ agentId: "a", tool: "read", kind: "read", path: "/repo/wt-task-1/.env.local" }).type, "deny");
});

test("git push and destructive commands require approval", () => {
	assert.equal(policy.evaluate({ agentId: "a", tool: "bash", kind: "git", command: "git push origin main" }).type, "approval");
	assert.equal(policy.evaluate({ agentId: "a", tool: "bash", kind: "exec", command: "rm -rf /" }).type, "approval");
	assert.deepEqual(policy.evaluate({ agentId: "a", tool: "bash", kind: "exec", command: "npm test" }), { type: "allow" });
});

test("workspace manager reports overlapping changed files as conflicts", () => {
	const manager = createWorkspaceManager({ repoPath: "/repo", rootDir: "/repo/.sakura/worktrees" });
	const session = (taskId: string, changedFiles: string[]): AgentSession => ({
		agentId: "",
		taskId,
		branch: `sakura/${taskId}`,
		worktreePath: `/repo/.sakura/worktrees/${taskId}`,
		baseCommit: "abc",
		changedFiles,
		startedAt: 0,
	});

	const clean = manager.detectConflict([session("a", ["src/a.ts"]), session("b", ["src/b.ts"])]);
	assert.equal(clean.clean, true);

	const conflict = manager.detectConflict([session("a", ["src/shared.ts"]), session("b", ["src/shared.ts"])]);
	assert.equal(conflict.clean, false);
	assert.deepEqual(conflict.conflicts, [{ files: ["src/shared.ts"], sessions: ["a", "b"] }]);
});
