export interface TrialResult {
 taskId:string;variant:string;repeat:number;status:"passed"|"failed"|"setup_failed"|"cancelled";
 durationMs:number;tokensIn?:number;tokensOut?:number;toolCalls?:number;agentCalls?:number;
 filesRead?:number;contextTokens?:number;replans?:number;retries?:number;conflicts?:number;cost?:number;
 metricsScope:"complete"|"root-only";[key:string]:unknown;
}
const measured=["durationMs","tokensIn","tokensOut","toolCalls","agentCalls","filesRead","contextTokens","replans","retries","conflicts","cost"] as const;
export function summarizeTrials(trials:TrialResult[]) {
 const variants=[...new Set(trials.map(trial=>trial.variant))];
 return variants.map(variant=>{
  const rows=trials.filter(trial=>trial.variant===variant),passed=rows.filter(trial=>trial.status==="passed").length;
  const metrics=Object.fromEntries(measured.map(key=>{const values=rows.map(row=>row[key]).filter((value):value is number=>typeof value==="number"&&Number.isFinite(value));const mean=values.length ? values.reduce((sum,value)=>sum+value,0)/values.length : null;const stddev=mean===null ? null : Math.sqrt(values.reduce((sum,value)=>sum+(value-mean)**2,0)/values.length);return [key,{mean,stddev,measured:values.length,total:rows.length}];}));
  return {variant,trials:rows.length,passed,failed:rows.length-passed,successRate:rows.length ? passed/rows.length : null,metrics,comparable:rows.every(row=>row.metricsScope==="complete")};
 });
}
