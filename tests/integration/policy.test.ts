import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSakuraAgent } from "../../src/runtime/create-agent.ts";
import { piFixture } from "../helpers/pi-fixture.ts";
import { enforceAction } from "../../src/workspace/guard.ts";
import type { ToolCall } from "@earendil-works/pi-ai";
import type { SakuraEvent } from "../../src/telemetry/events.ts";

test("nested real Pi tools deny scope escapes, symlinks and shell without headless approval",async(t)=>{
 const fixture=await piFixture((_context,_options,call)=>call===1?{
  content:[
   {type:"toolCall",id:"scope",name:"write",arguments:{path:"wrong.txt",content:"bad"}},
   {type:"toolCall",id:"symlink",name:"write",arguments:{path:"link/outside.txt",content:"bad"}},
   {type:"toolCall",id:"shell",name:"bash",arguments:{command:"touch shell-bypass.txt"}},
  ] as ToolCall[],stopReason:"toolUse",
 }:{content:[{type:"text",text:"blocked"}]});t.after(fixture.cleanup);
 const outside=await piFixture(()=>({content:[]}));t.after(outside.cleanup);
 await symlink(outside.directory,join(fixture.directory,"link"));
 const events:SakuraEvent[]=[];
 const agent=await createSakuraAgent({role:"implementer",cwd:fixture.directory,...fixture.config,policy:{workspacePath:fixture.directory,writeScope:["allowed.txt"],network:"approval"},onEvent:(event)=>events.push(event)});t.after(()=>agent.dispose());
 await agent.session.prompt("try denied tools");
 for(const path of [join(fixture.directory,"wrong.txt"),join(outside.directory,"outside.txt"),join(fixture.directory,"shell-bypass.txt")]) await assert.rejects(readFile(path),/ENOENT/);
 assert.equal(events.filter((event)=>event.type==="policy.decision"&&event.decision==="deny").length,3);
 assert.ok(JSON.stringify(agent.session.messages).includes("Approval required"));
});

test("approval cannot override denial, and network deny blocks unrestricted shell",async(t)=>{
 const fixture=await piFixture(()=>({content:[]}));t.after(fixture.cleanup);
 let approvals=0;
 const policy={workspacePath:fixture.directory,network:"deny" as const};
 const denied=await enforceAction(policy,{agentId:"test",tool:"bash",kind:"exec",command:"python -c 'network access'"},async()=>{approvals++;return true;});
 assert.equal(denied.type,"deny");assert.equal(approvals,0);
 await writeFile(join(fixture.directory,".env"),"PRIVATE_SECRET_MARKER");
 assert.equal((await enforceAction(policy,{agentId:"test",tool:"read",kind:"read",path:join(fixture.directory,".env")})).type,"deny");
});
