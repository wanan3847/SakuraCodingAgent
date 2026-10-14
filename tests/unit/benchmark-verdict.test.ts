import assert from "node:assert/strict";
import {test} from "node:test";
import {lastAssistantText} from "../../src/runtime/pi-agent-runner.ts";
import {readOnlyVerdict} from "../../benchmarks/runners/verdict.ts";
const patterns={findingPattern:"旧|stale|current",locationPattern:"auth-service\\.ts"};
test("read-only evaluation cannot pass on the user's prompt or tool contents",()=>{
 const messages=[{role:"user",content:"指出 auth-service.ts 旧 token"},{role:"toolResult",content:[{type:"text",text:"auth-service.ts current token"}]},{role:"assistant",content:[{type:"text",text:"没有发现问题"}]}];
 assert.equal(readOnlyVerdict({...patterns,answer:lastAssistantText(messages)}),false);
 assert.equal(readOnlyVerdict({...patterns,answer:"旧 token"}),false);
 assert.equal(readOnlyVerdict({...patterns,answer:"auth-service.ts 返回旧 token"}),true);
 assert.equal(readOnlyVerdict({...patterns,answer:"auth-service.ts 返回旧 token",diff:"edited"}),false);
});
