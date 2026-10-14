#!/usr/bin/env node
import { mkdtemp,mkdir,writeFile,rm,copyFile } from "node:fs/promises";
import { join,resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec=promisify(execFile),root=resolve(new URL("../",import.meta.url).pathname);
const temporary=await mkdtemp(join(tmpdir(),"sakura-benchmark-seed-"));
const env={...process.env,GIT_AUTHOR_DATE:"2026-10-12T00:00:00Z",GIT_COMMITTER_DATE:"2026-10-12T00:00:00Z",GIT_AUTHOR_NAME:"Sakura fixtures",GIT_AUTHOR_EMAIL:"fixtures@example.invalid",GIT_COMMITTER_NAME:"Sakura fixtures",GIT_COMMITTER_EMAIL:"fixtures@example.invalid"};
const git=async(...args)=>(await exec("git",args,{cwd:temporary,env})).stdout.trim();
const token=`export interface Token {value:string;expires:number}\nexport function expired(token:Token,now:number){return token.expires<=now;}\nexport function revoke(tokens:Token[],value:string){return tokens.filter(token=>token.value!==value);}\n`;
const auth=`import type {Token} from './token-service.ts';\nexport function refresh(current:Token,next:Token){return next;}\nexport function canLogin(attempts:number){return attempts<3;}\n`;
const users=`export interface User {name:string;password:string}\nexport function publicUser(user:User){return {name:user.name};}\nexport function displayName(first:string,last:string){return [first.trim(),last.trim()].filter(Boolean).join(' ');}\n`;
const scenarios=[
 ["auth-refresh","修复刷新 token 后仍返回旧 token 的问题，补充回归证据。","src/auth/auth-service.ts",auth.replace('return next;','return current;'),"bugfix"],
 ["expiry-boundary","修复 token 恰好过期时仍被判有效的边界问题。","src/auth/token-service.ts",token.replace('token.expires<=now','token.expires<now'),"bugfix"],
 ["revoke-token","修复撤销指定 token 时误保留目标 token、删除其他 token 的问题。","src/auth/token-service.ts",token.replace('token.value!==value','token.value===value'),"bugfix"],
 ["public-user","修复 publicUser 导出密码字段的问题，保留公开姓名。","src/users/users.ts",users.replace('return {name:user.name};','return user;'),"bugfix"],
 ["new-cache","新增 src/auth/cache.ts：TokenCache 支持 set/get，达到 expires 后返回 undefined。","src/auth/cache.ts",null,"feature"],
 ["name-refactor","重构 displayName，消除重复空格并保留 trim/空姓名的既有行为。","src/users/users.ts",users.replace('[first.trim(),last.trim()]','[first,last]'),"refactor"],
 ["read-only-review","只读审查 auth refresh；指出旧 token 返回问题与文件位置，不修改文件。","src/auth/auth-service.ts",auth.replace('return next;','return current;'),"research"],
 ["dependency-module","新增 src/auth/login-policy.ts 的 loginLimit=3，并让 canLogin 导入并使用该模块；保持第三次失败后拒绝。","src/auth/auth-service.ts",auth,"feature"],
 ["repeated-refresh","再次修复 refresh 返回 stale token 的相同问题，记录经验是否减少探索。","src/auth/auth-service.ts",auth.replace('return next;','return current;'),"bugfix"],
 ["cancel-recovery","修复 canLogin 在第三次失败后仍放行的问题，支持中断后恢复并保持最终检查通过。","src/auth/auth-service.ts",auth.replace('attempts<3','attempts<=3'),"recovery"],
];
const checks=`import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {refresh,canLogin} from '../src/auth/auth-service.ts';
import {expired,revoke} from '../src/auth/token-service.ts';
import {publicUser,displayName} from '../src/users/users.ts';
const scenario=(await readFile('scenario.txt','utf8')).trim();
const fresh={value:'new',expires:20},old={value:'old',expires:10};
if(['auth-refresh','repeated-refresh','all'].includes(scenario)) assert.equal(refresh(old,fresh),fresh);
if(['expiry-boundary','all'].includes(scenario)) {assert.equal(expired(old,10),true);assert.equal(expired(fresh,10),false);}
if(['revoke-token','all'].includes(scenario)) assert.deepEqual(revoke([old,fresh],'old'),[fresh]);
if(['public-user','all'].includes(scenario)) assert.deepEqual(publicUser({name:'A',password:'secret'}),{name:'A'});
if(['name-refactor','all'].includes(scenario)) {assert.equal(displayName(' A ',' B '),'A B');assert.equal(displayName('','B'),'B');}
if(scenario==='new-cache') {const {TokenCache}=await import('../src/auth/cache.ts');const cache=new TokenCache();cache.set('user',fresh);assert.equal(cache.get('user',19).value,'new');assert.equal(cache.get('user',20),undefined);}
if(scenario==='dependency-module') {const {loginLimit}=await import('../src/auth/login-policy.ts');assert.equal(loginLimit,3);assert.match(await readFile('src/auth/auth-service.ts','utf8'),/import[^\\n]+login-policy/);assert.equal(canLogin(2),true);assert.equal(canLogin(3),false);}
if(['cancel-recovery','all'].includes(scenario)) {assert.equal(canLogin(2),true);assert.equal(canLogin(3),false);}
if(scenario==='read-only-review') {assert.equal(refresh(old,fresh),old);console.log('Read-only fixture: static stale-token finding required; no code edits expected.');}
console.log('scenario checks passed:',scenario);
`;
try {
 await git("init","-q","-b","main");
 await mkdir(join(temporary,"src","auth"),{recursive:true});await mkdir(join(temporary,"src","users"),{recursive:true});await mkdir(join(temporary,"tests"));
 const files={"src/auth/token-service.ts":token,"src/auth/auth-service.ts":auth,"src/users/users.ts":users,"tests/check.mjs":checks,"scenario.txt":"all\n","package.json":JSON.stringify({name:"sakura-token-refresh-demo",private:true,type:"module",scripts:{test:"node tests/check.mjs",typecheck:"tsc --noEmit"}}),"tsconfig.json":JSON.stringify({compilerOptions:{noEmit:true,strict:true,target:"ES2022",module:"NodeNext",allowImportingTsExtensions:true,types:[]},include:["src/**/*.ts"]}),"sakura.config.yaml":"policy:\n  network: allow\n",".gitignore":".sakura/\nnode_modules/\n","README.md":"# Sakura token refresh Demo\nA small fixed TypeScript fixture for regression, feature, review and recovery tasks.\n"};
 for(const [path,source] of Object.entries(files)) await writeFile(join(temporary,path),source);
 await git("add","-A");await git("commit","-qm","correct fixture baseline");const correctCommit=await git("rev-parse","HEAD");
 const manifest=[];
 await mkdir(join(root,"benchmarks","tasks"),{recursive:true});await mkdir(join(root,"benchmarks","fixtures"),{recursive:true});
 for(const [id,description,path,source,type] of scenarios) {
  await git("reset","--hard",correctCommit);
  await writeFile(join(temporary,"scenario.txt"),id+"\n");if(source!==null) await writeFile(join(temporary,path),source);
  await git("add","-A");const tree=await git("write-tree"),commit=await git("commit-tree",tree,"-p",correctCommit,"-m",id);await git("update-ref",`refs/heads/${id}`,commit);
  const task={id,repo:{bundle:"../fixtures/token-refresh.bundle",commit},task:{description,type,hintFiles:[path]},verification:{commands:["npm run typecheck","npm test"],readOnly:type==="research",findingPattern:type==="research"?"旧|stale|current":undefined,locationPattern:type==="research"?"src/auth/auth-service\\.ts|auth-service\\.ts":undefined},limits:{timeoutMs:600000},baselineExpected:type==="research"?"pass":"fail",correctCommit};
  manifest.push(task);await writeFile(join(root,"benchmarks","tasks",`${id}.json`),JSON.stringify(task,null,2)+"\n");
 }
 const bundle=join(temporary,"fixture.bundle");await git("bundle","create",bundle,"--all");await copyFile(bundle,join(root,"benchmarks","fixtures","token-refresh.bundle"));
 await writeFile(join(root,"benchmarks","fixtures","manifest.json"),JSON.stringify({schemaVersion:1,correctCommit,tasks:manifest.map(task=>({id:task.id,commit:task.repo.commit}))},null,2)+"\n");
 // Replace the historical placeholder with a real fixed task in valid YAML/JSON syntax.
 await writeFile(join(root,"benchmarks","tasks","auth-refresh.yaml"),JSON.stringify(manifest[0],null,2)+"\n");
 console.log(JSON.stringify({tasks:manifest.length,correctCommit,bundle:"benchmarks/fixtures/token-refresh.bundle"},null,2));
} finally {await rm(temporary,{recursive:true,force:true});}
