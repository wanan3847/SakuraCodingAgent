import {createHash} from 'node:crypto';
import type {Experience} from './store.ts';
export interface ExperiencePattern {id:string;pattern:string;experienceIds:string[];sourceRuns:string[];verifiedRuns:number;readyForCandidate:boolean}
/** Deterministic grouping, not a model's claim of improvement. No approval or promotion. */
export function clusterExperience(items:Experience[],minimumRuns=3):ExperiencePattern[]{
 const groups=new Map<string,ExperiencePattern>();
 for(const item of items){
  const normalized=item.problemPattern.toLowerCase().replace(/\b(?:[a-f0-9]{8,}|\d+)\b/g,'#').replace(/\s+/g,' ').trim();
  const id=createHash('sha256').update(normalized).digest('hex').slice(0,16);
  const group=groups.get(id)??{id,pattern:normalized,experienceIds:[],sourceRuns:[],verifiedRuns:0,readyForCandidate:false};
  group.experienceIds.push(item.id);
  if(item.verificationEvidence.length){const sources=[...(item.sourceRuns??[]).map(source=>source.runId),...(item.runId?[item.runId]:[])];group.sourceRuns.push(...sources);}
  groups.set(id,group);
 }
 return [...groups.values()].map(group=>{group.sourceRuns=[...new Set(group.sourceRuns)].sort();group.verifiedRuns=group.sourceRuns.length;group.readyForCandidate=group.verifiedRuns>=minimumRuns;return group;}).sort((a,b)=>b.verifiedRuns-a.verifiedRuns||a.id.localeCompare(b.id));
}
