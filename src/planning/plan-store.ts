import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWrite } from "../storage/atomic.ts";
import { validateGraph } from "./dag.ts";
import type { TaskGraph } from "./schemas.ts";

export function assertPlan(graph: TaskGraph): void {
  if (!graph || typeof graph.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(graph.id) || !Number.isSafeInteger(graph.version) || graph.version < 1 || typeof graph.rootTask !== "string" || !graph.nodes || !Array.isArray(graph.edges)) throw new Error("Invalid saved plan structure");
  const errors = validateGraph(graph);
  if (errors.length) throw new Error(`Invalid saved plan: ${errors.join("; ")}`);
}
/** Each preview gets a unique identity; execution loads this exact graph. */
export async function savePlan(cwd: string, graph: TaskGraph, newIdentity = true): Promise<{ graph: TaskGraph; path: string }> {
  const saved = structuredClone(graph);
  if (newIdentity) saved.id = `plan-${randomUUID()}`;
  assertPlan(saved);
  const path = join(cwd, ".sakura", "plans", saved.id, `v${saved.version}.json`);
  await atomicWrite(path, JSON.stringify(saved, null, 2) + "\n");
  return { graph: saved, path };
}
export async function loadPlan(path: string): Promise<TaskGraph> {
  const graph = JSON.parse(await readFile(path, "utf8")) as TaskGraph;
  assertPlan(graph);
  if (Object.values(graph.nodes).some((node) => node.status !== "pending")) throw new Error("A saved preview must contain pending tasks; use run recovery for partially executed graphs.");
  return graph;
}
