import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {refresh,canLogin} from 'file:///var/folders/n0/lb5fqzh96hxg_dwm3qkfjlth0000gn/T/sakura-benchmark-trial-F436LE/src/auth/auth-service.ts';
import {expired,revoke} from 'file:///var/folders/n0/lb5fqzh96hxg_dwm3qkfjlth0000gn/T/sakura-benchmark-trial-F436LE/src/auth/token-service.ts';
import {publicUser,displayName} from 'file:///var/folders/n0/lb5fqzh96hxg_dwm3qkfjlth0000gn/T/sakura-benchmark-trial-F436LE/src/users/users.ts';
const scenario="repeated-refresh";
const fresh={value:'new',expires:20},old={value:'old',expires:10};
if(['auth-refresh','repeated-refresh','all'].includes(scenario)) assert.equal(refresh(old,fresh),fresh);
if(['expiry-boundary','all'].includes(scenario)) {assert.equal(expired(old,10),true);assert.equal(expired(fresh,10),false);}
if(['revoke-token','all'].includes(scenario)) assert.deepEqual(revoke([old,fresh],'old'),[fresh]);
if(['public-user','all'].includes(scenario)) assert.deepEqual(publicUser({name:'A',password:'secret'}),{name:'A'});
if(['name-refactor','all'].includes(scenario)) {assert.equal(displayName(' A ',' B '),'A B');assert.equal(displayName('','B'),'B');}
if(scenario==='new-cache') {const {TokenCache}=await import('file:///var/folders/n0/lb5fqzh96hxg_dwm3qkfjlth0000gn/T/sakura-benchmark-trial-F436LE/src/auth/cache.ts');const cache=new TokenCache();cache.set('user',fresh);assert.equal(cache.get('user',19).value,'new');assert.equal(cache.get('user',20),undefined);}
if(scenario==='dependency-module') {const {loginLimit}=await import('file:///var/folders/n0/lb5fqzh96hxg_dwm3qkfjlth0000gn/T/sakura-benchmark-trial-F436LE/src/auth/login-policy.ts');assert.equal(loginLimit,3);assert.match(await readFile('src/auth/auth-service.ts','utf8'),/import[^\n]+login-policy/);assert.equal(canLogin(2),true);assert.equal(canLogin(3),false);}
if(['cancel-recovery','all'].includes(scenario)) {assert.equal(canLogin(2),true);assert.equal(canLogin(3),false);}
if(scenario==='read-only-review') {assert.equal(refresh(old,fresh),old);console.log('Read-only fixture: static stale-token finding required; no code edits expected.');}
console.log('scenario checks passed:',scenario);
