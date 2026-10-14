import {createTaskGraph,taskNode,type TaskGraph} from "../../src/planning/schemas.ts";
import {validateGraph} from "../../src/planning/dag.ts";
import {agentProfile} from "../../src/orchestrator/agent-registry.ts";
/** Keep dynamic planning and its measured usage; collapse execution into one logical worker. */
export function singleAgentPlan(graph:TaskGraph):TaskGraph {
 const errors=validateGraph(graph);if(errors.length)throw new Error(errors.join("; "));
 const nodes=Object.values(graph.nodes),writers=nodes.filter(node=>agentProfile(node.role).writes);
 const writeScope=writers.some(node=>!node.writeScope?.length)?undefined:[...new Set(writers.flatMap(node=>node.writeScope??[]))];
 return createTaskGraph({id:graph.id,rootTask:graph.rootTask,version:graph.version,nodes:[taskNode({id:"worker",title:"Complete dynamically planned task",description:[graph.rootTask,...nodes.map(node=>`${node.title}\n${node.description}`)].join("\n\n"),role:writers.length?"implementer":"reviewer",writeScope:writers.length?writeScope:undefined,dependencies:[],priority:1,verification:nodes.flatMap(node=>node.verification??[])})]});
}
