import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSakuraAgent } from "../../src/runtime/create-agent.ts";
import { observeAgent, providerFailure } from "../../src/runtime/agent-events.ts";
import { piFixture } from "../helpers/pi-fixture.ts";

test("Pi contract: prompt streams real read/write tools and attributes usage exactly once", async (t) => {
  const fixture = await piFixture((_context, _options, call) => call === 1 ? {
    content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "input.txt" } }], stopReason: "toolUse",
  } : call === 2 ? {
    content: [{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "output.txt", content: "verified output\n" } }], stopReason: "toolUse",
  } : { content: [{ type: "text", text: "Finished" }] });
  t.after(fixture.cleanup);
  await writeFile(join(fixture.directory, "input.txt"), "source evidence\n");
  const agent = await createSakuraAgent({ role: "implementer", cwd: fixture.directory, ...fixture.config });
  t.after(() => agent.dispose());
  const events: string[] = [];
  agent.session.subscribe((event) => events.push(event.type));
  const observation = observeAgent(agent.session, { agentId: "contract" });
  await agent.session.prompt("Read input.txt, write output.txt, then report.");
  assert.equal(await readFile(join(fixture.directory, "output.txt"), "utf8"), "verified output\n");
  assert.equal(providerFailure(agent.session.messages), undefined);
  assert.ok(events.includes("message_update"));
  assert.ok(events.includes("tool_execution_end"));
  assert.deepEqual(observation.usage(), { toolCalls: 2, tokensIn: 30, tokensOut: 12, tools: ["read", "write"] });
  assert.ok(JSON.stringify(fixture.requests[1]).includes("source evidence"));
  observation.unsubscribe();
});

test("Pi contract: queued steer and follow-up reach subsequent model turns", async (t) => {
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const fixture = await piFixture(async (_context, _options, call) => {
    if (call === 1) { started(); await barrier; }
    return { content: [{ type: "text", text: `turn ${call}` }] };
  });
  t.after(fixture.cleanup);
  const agent = await createSakuraAgent({ role: "explorer", cwd: fixture.directory, ...fixture.config });
  t.after(() => agent.dispose());
  const work = agent.session.prompt("initial request");
  await waiting;
  await agent.session.steer("STEER_MARKER");
  await agent.session.followUp("FOLLOWUP_MARKER");
  release();
  await work;
  assert.equal(fixture.requests.length, 3);
  assert.ok(JSON.stringify(fixture.requests[1]).includes("STEER_MARKER"));
  assert.ok(JSON.stringify(fixture.requests[2]).includes("FOLLOWUP_MARKER"));
  assert.equal(agent.session.pendingMessageCount, 0);
});

test("Pi contract: abort cancels provider work and settles the session", async (t) => {
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const fixture = await piFixture(async (_context, options) => {
    started();
    await new Promise<void>((resolve) => { if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
    return { stopReason: "aborted" };
  });
  t.after(fixture.cleanup);
  const agent = await createSakuraAgent({ role: "explorer", cwd: fixture.directory, ...fixture.config });
  t.after(() => agent.dispose());
  const work = agent.session.prompt("wait for cancellation");
  await waiting;
  await agent.session.abort();
  await work;
  assert.equal(agent.session.isStreaming, false);
  assert.equal(agent.session.messages.at(-1)?.role, "assistant");
  assert.equal((agent.session.messages.at(-1) as { stopReason?: string }).stopReason, "aborted");
});

test("Pi contract: native persisted sessions resume and compact without copying transcripts", async (t) => {
  const fixture = await piFixture(() => ({ content: [{ type: "text", text: "SUMMARY_CONTRACT" }] }));
  t.after(fixture.cleanup);
  const manager = SessionManager.create(fixture.directory, join(fixture.directory, "sessions"));
  const original = await createSakuraAgent({ role: "explorer", cwd: fixture.directory, ...fixture.config, sessionManager: manager });
  await original.session.prompt("PERSISTED_MARKER " + "context evidence ".repeat(200));
  const file = original.session.sessionFile;
  assert.ok(file);
  original.dispose();
  const resumed = await createSakuraAgent({ role: "explorer", cwd: fixture.directory, ...fixture.config, sessionManager: SessionManager.open(file) });
  t.after(() => resumed.dispose());
  assert.ok(JSON.stringify(resumed.session.messages).includes("PERSISTED_MARKER"));
  await resumed.session.prompt("continue persisted work " + "recent evidence ".repeat(100));
  const compaction = await resumed.session.compact("Summarize this work.");
  assert.ok(compaction.summary.includes("SUMMARY_CONTRACT"));
  assert.ok((await readFile(file, "utf8")).includes('"type":"compaction"'));
  assert.equal(resumed.session.sessionId, manager.getSessionId());
});
