import {createLocalBashOperations,type BashOperations} from '@earendil-works/pi-coding-agent';
import {enforceAction,type Approval,type ExecutionPolicy} from '../workspace/guard.ts';

/** Pi keeps streaming, truncation, timeouts and process-tree cancellation. */
export function guardedBash(policy:ExecutionPolicy,approve?:Approval):BashOperations{
 const native=createLocalBashOperations();
 return {async exec(command,cwd,options){
  options.signal?.throwIfAborted();
  const decision=await enforceAction({...policy,workspacePath:cwd},{agentId:'host',tool:'bash',kind:'exec',command},approve);
  if(decision.type!=='allow')throw new Error(decision.reason);
  return native.exec(command,cwd,options);
 }};
}
