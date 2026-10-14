import type {AgentSession} from '@earendil-works/pi-coding-agent';
export interface BudgetLimits {maxTokens?:number;maxCostUsd?:number;maxToolCalls?:number}
/** One ledger per root run. Reported provider usage can arrive after an in-flight request. */
export class RunBudget{
 readonly controller=new AbortController();
 private tools=0;private tokens=0;private cost=0;private reports=0;private unknown=0;
 reason?:string;
 readonly limits:BudgetLimits;
 constructor(limits:BudgetLimits={}){
  this.limits={...limits};
  for(const [key,value] of Object.entries(limits))if(value!==undefined&&(!Number.isFinite(value)||value<=0||(key!=='maxCostUsd'&&!Number.isSafeInteger(value))))throw new Error(`${key} must be positive${key==='maxCostUsd'?'':' integer'}`);
 }
 get signal(){return this.controller.signal;}
 snapshot(){return {limits:this.limits,toolCalls:this.tools,reportedTokens:this.tokens,reportedCostUsd:this.cost,usageReports:this.reports,unknownUsage:this.unknown,exhausted:!!this.reason,reason:this.reason};}
 restore(snapshot:ReturnType<RunBudget['snapshot']>){
  for(const key of ['toolCalls','reportedTokens','reportedCostUsd','usageReports','unknownUsage'] as const){const value=snapshot[key];if(typeof value!=='number'||!Number.isFinite(value)||value<0||(key!=='reportedCostUsd'&&!Number.isSafeInteger(value)))throw new Error('Invalid persisted run budget');}
  this.tools+=snapshot.toolCalls;this.tokens+=snapshot.reportedTokens;this.cost+=snapshot.reportedCostUsd;this.reports+=snapshot.usageReports;this.unknown+=snapshot.unknownUsage;
  if(this.unknown&&(this.limits.maxTokens!==undefined||this.limits.maxCostUsd!==undefined))this.stop('restored usage is incomplete');
  if(this.limits.maxToolCalls!==undefined&&this.tools>=this.limits.maxToolCalls)this.stop('restored tool call limit reached');
  if(this.limits.maxTokens!==undefined&&this.tokens>=this.limits.maxTokens)this.stop('restored token limit reached');
  if(this.limits.maxCostUsd!==undefined&&this.cost>=this.limits.maxCostUsd)this.stop('restored cost limit reached');
 }
 check(){if(this.reason)throw new Error(this.reason);}
 private stop(reason:string){this.reason??=`Run budget stopped: ${reason}`;this.controller.abort(new Error(this.reason));}
 reserveTool(){this.check();if(this.limits.maxToolCalls!==undefined&&this.tools>=this.limits.maxToolCalls){this.stop('tool call limit reached');this.check();}this.tools++;}
 attach(session:AgentSession){
  const abort=()=>{void session.abort().catch(()=>{});};
  this.signal.addEventListener('abort',abort,{once:true});if(this.signal.aborted)abort();
  const unsubscribe=session.subscribe(event=>{
   if(event.type!=='message_end'||event.message.role!=='assistant')return;
   const usage=event.message.usage;this.reports++;
   if(!usage||![usage.input,usage.output,usage.cacheRead,usage.cacheWrite].every(value=>Number.isFinite(value)&&value>=0)){
    this.unknown++;if(this.limits.maxTokens!==undefined)this.stop('token usage unavailable');
   }else this.tokens+=usage.input+usage.output+usage.cacheRead+usage.cacheWrite;
   const cost=usage?.cost?.total;
   if(typeof cost==='number'&&Number.isFinite(cost)&&cost>=0)this.cost+=cost;
   else if(this.limits.maxCostUsd!==undefined){this.unknown++;this.stop('cost usage unavailable');}
   if(this.limits.maxTokens!==undefined&&this.tokens>=this.limits.maxTokens)this.stop('reported token limit reached');
   if(this.limits.maxCostUsd!==undefined&&this.cost>=this.limits.maxCostUsd)this.stop('reported cost limit reached');
  });
  return ()=>{unsubscribe();this.signal.removeEventListener('abort',abort);};
 }
}
