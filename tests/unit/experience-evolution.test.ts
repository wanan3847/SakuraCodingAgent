import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp,rm,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createExperienceStore,type Experience} from "../../src/experience/store.ts";
import {retrieveExperience} from "../../src/experience/retrieval.ts";
import {proposeCandidate,promoteCandidate,reviewCandidate,loadCandidate} from "../../src/experience/skill-candidates.ts";
const evidence=(id:string):Experience=>({id,problemPattern:"refresh stale token",symptoms:["stale token"],failedAttempts:[],successfulActions:["return rotated token"],usefulTools:["read","write"],relevantFiles:["auth.ts"],verificationEvidence:["npm test → exit 0 10ms"],tags:["auth"],createdAt:Date.now(),runId:id,traceDir:`/evidence/${id}`});
test("mixed Chinese tasks retrieve verified actions and source files without unrelated matches",()=>{
 const item={...evidence("source"),problemPattern:"修复刷新 token 后仍返回旧 token 的问题",symptoms:[],successfulActions:["改了 refresh 函数使其返回新 token"],tags:["verified"]};
 assert.equal(retrieveExperience([item],{task:"再次修复 refresh 返回 stale token 的相同问题",minScore:2})[0]?.experience.id,"source");
 assert.deepEqual(retrieveExperience([item],{task:"修复完全无关的数据库连接问题",minScore:2}),[]);
});
test("experience facts deduplicate across runs, carry source references and decay with age",async(t)=>{
 const root=await mkdtemp(join(tmpdir(),"sakura-evolution-"));t.after(()=>rm(root,{recursive:true,force:true}));const store=createExperienceStore(root);
 assert.equal(await store.add(evidence("first")),"first");assert.equal(await store.add({...evidence("second"),verificationEvidence:["npm test → exit 0 50ms"]}),"first");
 const all=await store.all();assert.equal(all.length,1);assert.deepEqual(all[0].sourceRuns?.map(run=>run.runId),["first","second"]);
 const now=Date.now(),fresh={...evidence("fresh"),createdAt:now},old={...evidence("old"),createdAt:now-90*86400000};
 const hits=retrieveExperience([old,fresh],{task:"refresh stale token",now,minScore:0});assert.equal(hits[0].experience.id,"fresh");assert.equal(hits[1].score,hits[0].score/2);
});
test("candidate revisions stay outside formal skills and cannot be promoted without evaluation and review",async(t)=>{
 const root=await mkdtemp(join(tmpdir(),"sakura-candidate-"));t.after(()=>rm(root,{recursive:true,force:true}));await createExperienceStore(root).add(evidence("source"));
 const controlDir=await mkdtemp(join(tmpdir(),"sakura-control-credentials-unit-"));t.after(()=>rm(controlDir,{recursive:true,force:true}));const authority={controlDir};
 const input={name:"sakura-learned-refresh",description:"Refresh stale token evidence",body:"# Refresh\nReturn the rotated token and run regression checks.",experienceIds:["source"]};
 const first=await proposeCandidate(root,input,authority);assert.equal(first.stage,"candidate");await assert.rejects(promoteCandidate(root,first.id,authority),/evaluation/);await assert.rejects(reviewCandidate(root,first.id,"reviewer",true,authority),/evaluation/);
 await assert.rejects(readFile(join(root,".pi","skills",first.name,"SKILL.md")),/ENOENT/);
 const second=await proposeCandidate(root,{...input,id:first.id,body:input.body+"\nCheck expiry boundary."},authority);assert.equal(second.version,2);assert.notEqual(second.sha256,first.sha256);assert.equal((await loadCandidate(root,first.id,1,authority)).sha256,first.sha256);
 const replay=await readFile(join(root,".sakura","skill-candidates",first.id,"replay-v2",first.name,"SKILL.md"),"utf8");assert.match(replay,/Check expiry boundary/);
});
