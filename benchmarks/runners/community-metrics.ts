import {readFile} from "node:fs/promises";

/** Consume the pinned plugin's public final result details, never progress snapshots. */
export async function communityMetrics(receipts:unknown[], expectedModel:string) {
 const children=new Map<string,any>();
 let complete=true;
 for(const receipt of receipts) {
  const details=receipt as {runId?:string;results?:any[];mode?:string};
  if(!Array.isArray(details?.results)) {complete=false;continue;}
  for(const child of details.results) children.set(`${details.runId??"unknown"}:${child.index}`,child);
 }
 let tokensIn=0,tokensOut=0,toolCalls=0,agentCalls=0,contextTokens:number|undefined,retries=0;
 const paths=new Set<string>(),models=new Set<string>(),evidence:unknown[]=[];
 for(const child of children.values()) {
  const attempts=child.modelAttempts?.length??1;
  agentCalls+=attempts;retries+=Math.max(0,attempts-1);
  if(child.model) models.add(child.model);
  for(const attempt of child.modelAttempts??[]) if(attempt.model) models.add(attempt.model);
  if(!child.model || (child.model!==expectedModel && child.model!==expectedModel.slice(expectedModel.indexOf("/")+1))) complete=false;
  if(typeof child.usage?.input!=="number"||typeof child.usage?.output!=="number") complete=false;
  tokensIn+=child.usage?.input??0;tokensOut+=child.usage?.output??0;
  let messages=child.messages;
  if(!messages && child.sessionFile) {
   try {messages=(await readFile(child.sessionFile,"utf8")).split("\n").filter(Boolean).map(line=>JSON.parse(line)).filter(entry=>entry.type==="message").map(entry=>entry.message);}
   catch {complete=false;}
  }
  // An abbreviated result cannot prove successful reads or full context usage.
  if(!Array.isArray(messages)||attempts>1||child.detached) complete=false;
  const successful=new Set((messages??[]).filter((message:any)=>message.role==="toolResult"&&!message.isError).map((message:any)=>message.toolCallId));
  let observedTools=0;
  for(const message of messages??[]) {
   if(message.role!=="assistant")continue;
   if(typeof message.usage?.input==="number")contextTokens=Math.max(contextTokens??0,message.usage.input+(message.usage.cacheRead??0));
   for(const part of Array.isArray(message.content)?message.content:[]) {
    if(part.type!=="toolCall")continue;
    // Only calls which received a result were actually executed.
    if(!(messages??[]).some((result:any)=>result.role==="toolResult"&&result.toolCallId===part.id))continue;
    observedTools++;
    if(part.name==="read"&&successful.has(part.id)&&typeof part.arguments?.path==="string")paths.add(part.arguments.path);
   }
  }
  toolCalls+=child.progressSummary?.toolCount??observedTools;
  evidence.push({index:child.index,model:child.model,usage:child.usage,sessionFile:child.sessionFile,observedTools,attempts});
 }
 return {tokensIn,tokensOut,toolCalls,agentCalls,contextTokens,retries,paths:[...paths],models:[...models],complete,evidence};
}
