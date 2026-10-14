import type {ExtensionContext,CreateAgentSessionOptions,AgentSession} from '@earendil-works/pi-coding-agent';
import type {SakuraAgentConfig} from './agent-config.ts';
import {RunBudget,type BudgetLimits} from './run-budget.ts';
type HostServices=Pick<CreateAgentSessionOptions,'modelRuntime'|'settingsManager'|'agentDir'>&Pick<SakuraAgentConfig,'localOnly'|'budget'>;
const services=new Map<string,HostServices>();
const sessions=new Map<string,AgentSession>();
const budgetListeners=new Map<string,()=>void>();
export function bindHostServices(cwd:string,value:HostServices){services.set(cwd,value);}
export function bindHostSession(cwd:string,session:AgentSession){sessions.set(cwd,session);}
export function startHostBudget(cwd:string,limits?:BudgetLimits){
 budgetListeners.get(cwd)?.();const host=services.get(cwd),session=sessions.get(cwd);if(!host||!session)return;
 host.budget=new RunBudget(limits);budgetListeners.set(cwd,host.budget.attach(session));
}
export function currentHostBudget(cwd:string){return services.get(cwd)?.budget;}
export function finishHostBudget(cwd:string){const budget=currentHostBudget(cwd);budgetListeners.get(cwd)?.();budgetListeners.delete(cwd);const host=services.get(cwd);if(host)host.budget=undefined;return budget?.snapshot();}
export function configFromHost(ctx:ExtensionContext):Partial<SakuraAgentConfig>{return {
 ...services.get(ctx.cwd),model:ctx.model,thinkingLevel:ctx.thinkingLevel,
 approve:ctx.hasUI?async(action,decision)=>ctx.ui.confirm('Sakura 执行权限',`${action.tool}: ${decision.reason}\n${action.command??action.path??''}`):undefined,
};}
const active=new Map<AbortController,Promise<void>>();
export function trackRun(parent?:AbortSignal){
 const controller=new AbortController();
 const abort=()=>controller.abort(parent?.reason);
 let finished!:()=>void;const done=new Promise<void>(resolve=>{finished=resolve;});
 parent?.addEventListener('abort',abort,{once:true});if(parent?.aborted)abort();active.set(controller,done);
 return {controller,close(){active.delete(controller);parent?.removeEventListener('abort',abort);finished();}};
}
export function cancelActiveRuns(){const count=active.size;for(const controller of active.keys())controller.abort();return count;}
export async function drainActiveRuns(){cancelActiveRuns();await Promise.all([...active.values()]);}
