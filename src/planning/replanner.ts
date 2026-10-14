import { buildEdges, type TaskGraph, type TaskNode } from "./schemas.ts";
import { validateGraph } from "./dag.ts";

export interface ReplanInput { graph: TaskGraph; failed: TaskNode[]; evidence: string }
export interface ReplanResult { graph: TaskGraph; reason: string }
export interface Replanner { replan(input: ReplanInput): Promise<ReplanResult | undefined> }
/** Local repair preserves completed work; global attempt bounds belong to the scheduler. */
export function createReplanner(): Replanner {
  return { async replan(input) {
    if (!input.failed.length || /Integration conflict|Task workspace failed|401|403|credentials|No Pi model|local-only|Policy denied|Approval required|network denied/i.test(input.evidence)) return undefined;
    const graph = structuredClone(input.graph);
    const repair = new Set(input.failed.map((node) => node.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of Object.values(graph.nodes)) if (node.dependencies.some((id) => repair.has(id)) && !repair.has(node.id)) { repair.add(node.id); changed = true; }
    }
    for (const id of repair) {
      const node = graph.nodes[id];
      if (!node) throw new Error(`Replan cannot repair an unknown task: ${id}`);
      node.description = `${node.description}\n\n# Repair evidence (attempt ${graph.version + 1})\n${input.evidence.slice(-8000)}`;
      node.status = "pending"; node.retryCount = 0; node.result = undefined;
    }
    graph.version += 1; graph.updatedAt = Date.now(); graph.edges = buildEdges(graph.nodes);
    const errors = validateGraph(graph);
    if (errors.length) throw new Error(`Invalid repair plan: ${errors.join("; ")}`);
    return { graph, reason: `Repair ${[...repair].join(", ")} after: ${input.evidence.slice(0, 500)}` };
  } };
}
