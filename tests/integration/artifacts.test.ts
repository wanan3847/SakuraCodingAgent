import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { captureChanges, saveArtifact } from "../../src/workspace/artifacts.ts";
import { createWorkspace, collectDiff, cleanupWorkspace } from "../../src/workspace/worktree.ts";
import { delegateTasks } from "../../src/orchestrator/delegate.ts";
import { readdir } from "node:fs/promises";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout;

test("generated dependency exclusions preserve tracked and intentional user symlinks",async(t)=>{
  const cwd=await mkdtemp(join(tmpdir(),"sakura-user-link-"));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  await git(cwd,"init","-q");await writeFile(join(cwd,"base.txt"),"base\n");
  await git(cwd,"add","-A");await git(cwd,"-c","user.name=test","-c","user.email=test@example.invalid","commit","-qm","base");
  await symlink("first-target",join(cwd,"node_modules"));
  assert.deepEqual((await captureChanges(cwd)).changedFiles,["node_modules"]);
  await git(cwd,"add","node_modules");await git(cwd,"-c","user.name=test","-c","user.email=test@example.invalid","commit","-qm","user link");
  await rm(join(cwd,"node_modules"));await symlink("second-target",join(cwd,"node_modules"));
  await mkdir(join(cwd,".sakura"));await writeFile(join(cwd,".sakura","generated-dependencies.json"),'["node_modules"]');
  const changed=await captureChanges(cwd);
  assert.deepEqual(changed.changedFiles,["node_modules"]);assert.match(changed.diff,/second-target/);
});

test("saved artifacts replay additions, deletions, rename, binary, Unicode and space paths without changing staging", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sakura-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, "init", "-q");
  await writeFile(join(repo, "old.txt"), "rename content\n");
  await writeFile(join(repo, "deleted.txt"), "delete me\n");
  await writeFile(join(repo, "modified.txt"), "before\n");
  await git(repo, "add", "-A");
  await git(repo, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
  const workspace = await createWorkspace("artifact", repo, join(root, "worktrees"));
  const path = workspace.worktreePath;
  await rename(join(path, "old.txt"), join(path, "樱花 renamed.txt"));
  await rm(join(path, "deleted.txt"));
  await writeFile(join(path, "modified.txt"), "staged\n");
  await git(path, "add", "modified.txt");
  const staged = await git(path, "diff", "--cached", "--binary");
  await writeFile(join(path, "modified.txt"), "unstaged final\n");
  await writeFile(join(path, "new file.txt"), "new\n");
  const binary = Buffer.from([0, 255, 1, 2, 3, 0, 127]);
  await writeFile(join(path, "image.bin"), binary);
  const diff = await collectDiff(workspace);
  assert.match(diff, /GIT binary patch/);
  assert.match(diff, /new file mode/);
  assert.equal(await git(path, "diff", "--cached", "--binary"), staged);
  assert.ok(workspace.changedFiles.includes("new file.txt"));
  assert.ok(workspace.changedFiles.includes("樱花 renamed.txt"));
  assert.ok(workspace.changedFiles.includes("old.txt"));
  assert.ok(workspace.artifact);
  const manifestPath = await saveArtifact(join(root, "saved"), "artifact", workspace.artifact);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.baseCommit, workspace.baseCommit);
  await cleanupWorkspace(workspace, repo);
  await cleanupWorkspace(workspace, repo);
  await git(repo, "apply", "--binary", join(root, "saved", manifest.diffFile));
  assert.equal(await readFile(join(repo, "new file.txt"), "utf8"), "new\n");
  assert.equal(await readFile(join(repo, "樱花 renamed.txt"), "utf8"), "rename content\n");
  assert.equal(await readFile(join(repo, "modified.txt"), "utf8"), "unstaged final\n");
  assert.deepEqual(await readFile(join(repo, "image.bin")), binary);
  await assert.rejects(readFile(join(repo, "deleted.txt")), /ENOENT/);
  await assert.rejects(readFile(join(repo, "old.txt")), /ENOENT/);
});

test("artifact persistence fails explicitly when the output cannot be written", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sakura-artifact-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "not-a-directory");
  await writeFile(file, "blocked");
  await assert.rejects(saveArtifact(file, "task", { baseCommit: "base", diff: "patch", changedFiles: ["file"], changes: [] }));
  await assert.rejects(saveArtifact(root, "../outside", { baseCommit: "base", diff: "", changedFiles: [], changes: [] }), /Unsafe artifact/);
});

test("captureChanges rejects missing repositories instead of returning a clean snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sakura-no-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(captureChanges(root), /not a git repository/);
});

test("delegation preserves an isolated workspace and reports failure when saving artifacts fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sakura-preserve-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q");
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, "add", "-A");
  await git(root, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
  const outcome = await delegateTasks({
    cwd: root, tasks: [{ id: "write", role: "implementer", description: "create a new file" }],
    runner: { async run(input) {
      await writeFile(join(input.workspacePath, "new.txt"), "preserve me\n");
      const [id] = await readdir(join(root, ".sakura", "runs"));
      await writeFile(join(root, ".sakura", "runs", id, "diffs"), "blocked");
      return { status: "success", summary: "created", changedFiles: ["new.txt"], evidence: [] };
    } },
  });
  assert.equal(outcome.tasks[0].status, "failure");
  assert.equal(outcome.kept, true);
  assert.equal(outcome.tasks[0].preserved, true);
  assert.match(outcome.warnings.join("\n"), /产物保存失败/);
  assert.equal(await readFile(join(outcome.tasks[0].worktree!, "new.txt"), "utf8"), "preserve me\n");
});

test("failed delegated tasks still save their partial edits before cleanup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sakura-partial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q");
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, "add", "-A");
  await git(root, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
  const outcome = await delegateTasks({
    cwd: root, tasks: [{ id: "partial", role: "implementer", description: "create then fail" }],
    runner: { async run(input) {
      await writeFile(join(input.workspacePath, "partial.txt"), "partial\n");
      throw new Error("provider stopped");
    } },
  });
  const task = outcome.tasks[0];
  assert.equal(task.status, "failure");
  assert.ok(task.artifactPath);
  assert.match(await readFile(task.diffPath!, "utf8"), /partial/);
  await assert.rejects(readFile(join(task.worktree!, "partial.txt")), /ENOENT/);
});
