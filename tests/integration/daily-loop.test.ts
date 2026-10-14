import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTaskGraph, taskNode } from "../../src/planning/schemas.ts";
import { loadPlan, savePlan } from "../../src/planning/plan-store.ts";
import { captureChanges, saveArtifact } from "../../src/workspace/artifacts.ts";
import { applyArtifact } from "../../src/workspace/apply-artifact.ts";
import { runSakuraTaskOnce } from "../../src/run.ts";
import { piFixture } from "../helpers/pi-fixture.ts";
import { createPiAgentRunner } from "../../src/runtime/pi-agent-runner.ts";
import { createRunTrace } from "../../src/telemetry/trace.ts";
import { runSakuraTask } from "../../src/orchestrator/orchestrator.ts";
import { asTaskRunner } from "../../src/orchestrator/agent-runner.ts";
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout;
async function repository(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "sakura-daily-"));
  t.after(() => rm(cwd, { recursive:true, force:true }));
  await git(cwd, "init", "-q");
  await writeFile(join(cwd, "base.txt"), "base\n");
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  await writeFile(join(cwd, "sakura.config.yaml"), "policy:\n  network: allow\n");
  await git(cwd, "add", "-A");
  await git(cwd, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
  return cwd;
}
const graph = () => createTaskGraph({ id: "preview", rootTask: "add a file", nodes: [taskNode({ id: "write", title: "add file", description: "add file", role: "implementer", dependencies: [], priority: 1, writeScope: ["new.txt"] })] });

test("saved preview is the exact plan executed and its artifact can be applied and verified once", async (t) => {
  const cwd = await repository(t);
  const saved = await savePlan(cwd, graph());
  const seen: string[] = [];
  const outcome = await runSakuraTaskOnce({ cwd, task: saved.graph.rootTask, planPath: saved.path,
    planner: { async plan() { throw new Error("must not create another plan"); } },
    runner: { async run(input) {
      seen.push(input.task.id);
      await writeFile(join(input.workspacePath, "new.txt"), "new\n");
      return { status:"success", summary:"created", changedFiles:["new.txt"], evidence:[] };
    } },
  });
  assert.equal(outcome.completed, true);
  assert.equal(outcome.result?.graph.id, saved.graph.id);
  assert.equal(outcome.result?.graph.version, saved.graph.version);
  assert.deepEqual(seen, ["write"]);
  assert.equal((await loadPlan(saved.path)).nodes.write.status, "pending");
  assert.ok(outcome.artifactPath);
  await assert.rejects(readFile(join(cwd, "new.txt")), /ENOENT/);
  const applied = await applyArtifact(cwd, outcome.artifactPath);
  assert.equal(applied.verification.passed, true);
  assert.equal(await readFile(join(cwd, "new.txt"), "utf8"), "new\n");
  assert.equal((await applyArtifact(cwd, outcome.artifactPath)).duplicate, true);
});

test("artifact apply rejects dirty targets, mismatched base and tampered patches", async (t) => {
  const cwd = await repository(t);
  await writeFile(join(cwd, "base.txt"), "new\n");
  const changes = await captureChanges(cwd);
  const path = await saveArtifact(join(cwd, ".sakura", "artifacts"), "sample", changes);
  await assert.rejects(applyArtifact(cwd, path), /uncommitted/);
  await git(cwd, "checkout", "--", "base.txt");
  await writeFile(join(cwd, "other.txt"), "other\n");
  await git(cwd, "add", "other.txt");
  await git(cwd, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "different base");
  await assert.rejects(applyArtifact(cwd, path), /base mismatch/);
  await writeFile(join(cwd, ".sakura", "artifacts", "sample.diff"), "tampered");
  await assert.rejects(applyArtifact(cwd, path), /checksum/);
  assert.equal(await readFile(join(cwd, "base.txt"), "utf8"), "base\n");
});

test("run preserves the worktree when artifacts cannot be persisted", async (t) => {
  const cwd = await repository(t);
  const saved = await savePlan(cwd, graph());
  const outcome = await runSakuraTaskOnce({ cwd, task:saved.graph.rootTask, planPath:saved.path,
    runner:{ async run(input) {
      await writeFile(join(input.workspacePath, "new.txt"), "keep\n");
      const [id] = await readdir(join(cwd, ".sakura", "runs"));
      await writeFile(join(cwd, ".sakura", "runs", id, "diffs"), "obstructed");
      return { status:"success", summary:"created", changedFiles:["new.txt"], evidence:[] };
    } },
  });
  assert.equal(outcome.completed, false);
  assert.match(outcome.warning ?? "", /产物保存失败/);
  assert.equal(await readFile(join(outcome.workspacePath!, "new.txt"), "utf8"), "keep\n");
});

test("nested Pi tool events are not counted again in task summaries", async (t) => {
  const cwd = await repository(t);
  const fixture = await piFixture((_context, _options, call) => call===1 ? { content:[{ type:"toolCall", id:"write", name:"write", arguments:{path:"new.txt", content:"new\n"} }], stopReason:"toolUse" } : { content:[{type:"text", text:"done"}] });
  t.after(fixture.cleanup);
  const trace = await createRunTrace("usage-contract", cwd);
  const runner = createPiAgentRunner({ config:fixture.config, trace });
  await runSakuraTask({ task:"add a file" }, { planner:{ plan:async()=>graph() }, runTask:asTaskRunner(runner,{workspacePath:cwd}), trace, maxConcurrency:1 });
  const metrics = await trace.finish();
  assert.equal(metrics.toolCalls,1);
  assert.equal(metrics.tokensIn,20);
  assert.equal(metrics.tokensOut,8);
});
