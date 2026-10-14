import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { indexRepository } from "./indexer.ts";
import { createRepositoryParser } from "./languages.ts";
import { analyzeImpact } from "./impact-analysis.ts";
import { rankCandidates, type Candidate } from "./retrieval.ts";
import { evaluateAction } from "../workspace/guard.ts";

export interface ContextEvidence {source:string;path?:string;startLine?:number;endLine?:number;text:string;weight:number;estimatedTokens:number}
export interface ContextPack {text:string;estimatedTokens:number;budget:number;estimator:"utf8-bytes-upper-estimate";selected:ContextEvidence[];truncated:Array<{source:string;reason:string}>;coverage:string}
// Conservative for code/multilingual text. Pi remains responsible for exact provider context and compaction.
export const estimateTokens=(text:string)=>Buffer.byteLength(text,"utf8");
export function packContext(evidence:ContextEvidence[], budget:number, coverage=""):ContextPack {
  if(!Number.isSafeInteger(budget)||budget<0) throw new Error("Context budget must be a nonnegative integer");
  const selected:ContextEvidence[]=[],truncated:ContextPack["truncated"]=[],seen=new Set<string>();let used=0;
  for(const item of [...evidence].sort((a,b)=>b.weight-a.weight||a.source.localeCompare(b.source))) {
    const identity=item.path ? `${item.path}:${item.startLine}:${item.endLine}` : item.source;
    if(seen.has(identity)){truncated.push({source:item.source,reason:"duplicate"});continue;}seen.add(identity);
    const header=`# ${item.source}${item.path ? ` ${item.path}:${item.startLine}-${item.endLine}` : ""}\n`;
    const available=budget-used-estimateTokens(header)-2;
    if(available<32){truncated.push({source:item.source,reason:"input budget exhausted"});continue;}
    let text=item.text;
    if(estimateTokens(text)>available) {
      const lines=text.split("\n");text="";
      for(const line of lines) {if(estimateTokens(text+line+"\n")>available) break;text+=line+"\n";}
      if(!text){truncated.push({source:item.source,reason:"no complete line fits"});continue;}
      truncated.push({source:item.source,reason:"clipped to complete lines within input budget"});
    }
    const endLine=item.startLine!==undefined ? item.startLine+text.trimEnd().split("\n").length-1 : item.endLine;
    const rendered=`${header}${text}\n\n`,estimatedTokens=estimateTokens(rendered);
    if(used+estimatedTokens>budget) {truncated.push({source:item.source,reason:"header exceeds input budget"});continue;}
    selected.push({...item,text,endLine,estimatedTokens});used+=estimatedTokens;
  }
  const text=selected.map(item=>`# ${item.source}${item.path ? ` ${item.path}:${item.startLine}-${item.endLine}` : ""}\n${item.text}\n\n`).join("");
  return {text,estimatedTokens:estimateTokens(text),budget,estimator:"utf8-bytes-upper-estimate",selected,truncated,coverage};
}
export async function buildRepositoryContext(options:{cwd:string;task:string;files?:string[];topK:number;maxFileSizeKb:number;budget:number;extra?:ContextEvidence[];onFileRead?:(path:string)=>void}) {
  const result=await indexRepository({root:options.cwd,parser:createRepositoryParser(),maxIndexedFileSizeKb:options.maxFileSizeKb,onFileRead:options.onFileRead});
  const terms=options.task.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(term=>term.length>1);
  const impacts=(options.files ?? []).map(file=>analyzeImpact(result.index,file));
  const related=new Set(impacts.flatMap(impact=>impact.files)),tests=new Set(impacts.flatMap(impact=>impact.relatedTests));
  const hints=new Set(options.files ?? []);
  const candidates:Candidate[]=result.paths.map(path=>({path,keywordScore:terms.filter(term=>path.toLowerCase().includes(term)).length,symbolScore:result.index.allSymbols().filter(symbol=>symbol.file===path && terms.some(term=>symbol.name.toLowerCase().includes(term))).length,dependencyScore:related.has(path)?2:0,testScore:tests.has(path)?3:0,gitChangeScore:hints.has(path)?10:0}));
  const ranked=rankCandidates(candidates,{topK:options.topK});
  const evidence:ContextEvidence[]=[...(options.extra ?? [])];
  for(const [position,candidate] of ranked.entries()) {
    const decision=await evaluateAction({workspacePath:options.cwd},{agentId:"context",tool:"read",kind:"read",path:join(options.cwd,candidate.path)});
    if(decision.type!=="allow") continue;
    const source=await readFile(join(options.cwd,candidate.path),"utf8"),lines=source.split("\n");
    options.onFileRead?.(join(options.cwd,candidate.path));
    const symbols=result.index.allSymbols().filter(symbol=>symbol.file===candidate.path && terms.some(term=>symbol.name.toLowerCase().includes(term)));
    const start=Math.max(0,(symbols[0]?.startLine ?? 1)-4),end=Math.min(lines.length,start+120);
    evidence.push({source:"repository",path:candidate.path,startLine:start+1,endLine:end,text:lines.slice(start,end).join("\n"),weight:100-position,estimatedTokens:0});
  }
  return {pack:packContext(evidence,options.budget,result.coverage),index:{indexedFiles:result.indexedFiles,parsedFiles:result.parsedFiles,reusedFiles:result.reusedFiles,unresolvedCalls:result.unresolvedCalls,skipped:result.skipped},unsupportedHints:[...hints].filter(path=>!result.paths.includes(path))};
}
