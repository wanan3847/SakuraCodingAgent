import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, relative } from "node:path";
import { createToolPolicy, type ToolAction, type PolicyDecision, type ToolPolicyConfig } from "./sandbox-policy.ts";

export interface ExecutionPolicy extends ToolPolicyConfig { readScope?: string[]; writeScope?: string[];trustedPaths?:string[] }
export type Approval = (action: ToolAction, decision: Exclude<PolicyDecision, { type: "allow" }>) => Promise<boolean>;
/** Resolve existing ancestors as well: a new file inside a symlink must not bypass scope checks. */
async function canonical(path: string): Promise<string> {
  const pending: string[] = [];
  let cursor = resolve(path);
  while (true) {
    try { return join(await realpath(cursor), ...pending.reverse()); }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      pending.push(basename(cursor)); cursor = parent;
    }
  }
}
const inside = (root: string, path: string) => { const part = relative(root, path); return !part.startsWith(".." + "/") && part !== ".." && !part.startsWith("/"); };
export async function evaluateAction(policy: ExecutionPolicy, action: ToolAction): Promise<PolicyDecision> {
  const root = await canonical(policy.workspacePath);
  const path = action.path ? await canonical(action.path) : undefined;
  const trustedPaths=await Promise.all((policy.trustedPaths??[]).map(canonical));
  if(path&&trustedPaths.some(trusted=>inside(trusted,path)))return {type:"deny",reason:"Trusted skill authority is inaccessible to Agent tools"};
  if(action.kind === "write" && path && inside(root,path) && /^\.pi[\/]skills(?:[\/]|$)/.test(relative(root,path))) return {type:"deny",reason:"Formal Pi skills require evaluated candidate promotion and explicit review"};
  if(action.kind === "write" && path && inside(root,path) && /^\.sakura(?:[\/]|$)/.test(relative(root,path))) return {type:"deny",reason:"Sakura control/evidence files are managed by the runtime"};
  const normalized = { ...action, path };
  const base = createToolPolicy({ ...policy, workspacePath: root }).evaluate(normalized);
  if (base.type !== "allow") return base;
  const scope = action.kind === "write" ? policy.writeScope : action.kind === "read" ? policy.readScope : undefined;
  if (path && scope?.length) {
    const paths = await Promise.all(scope.map((entry) => canonical(resolve(root, entry))));
    if (!paths.some((prefix) => inside(prefix, path))) return { type: "deny", reason: `${action.kind} outside task scope` };
  }
  if (action.kind === "exec" || action.kind === "git") {
    // Arbitrary shell can bypass every path/network rule. Permission requires an explicit decision.
    if (action.tool === "verification" && policy.network === "allow" && !policy.writeScope?.length) return { type:"allow" };
    if (policy.network === "deny") return { type: "deny", reason: "Unrestricted shell cannot enforce network:deny; use isolated execution." };
    return { type: "approval", reason: "Shell commands can access paths and networks outside tool scopes." };
  }
  return base;
}
export async function enforceAction(policy: ExecutionPolicy, action: ToolAction, approve?: Approval): Promise<PolicyDecision> {
  const decision = await evaluateAction(policy, action);
  if (decision.type === "allow") return decision;
  if (decision.type === "approval" && approve && await approve(action, decision)) return { type: "allow" };
  return { type: "deny", reason: decision.type === "approval" ? `Approval required: ${decision.reason}; no authorization received.` : decision.reason };
}
export function actionForTool(tool: string, input: Record<string, unknown>, cwd: string, agentId: string): ToolAction | undefined {
  const kind = ["write", "edit"].includes(tool) ? "write" : ["read", "grep", "find", "ls"].includes(tool) ? "read" : ["bash", "user_bash", "powershell"].includes(tool) ? "exec" : undefined;
  if (!kind) return undefined;
  const raw = typeof input.path === "string" ? input.path : undefined;
  return { agentId, tool, kind, path: raw ? resolve(cwd, raw.replace(/^@/, "")) : kind === "read" ? resolve(cwd) : undefined, command: typeof input.command === "string" ? input.command : undefined };
}
