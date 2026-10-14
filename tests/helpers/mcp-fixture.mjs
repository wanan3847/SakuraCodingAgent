// Real stdio MCP protocol boundary, without network or installed external servers.
import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
if(process.argv[2])writeFileSync(process.argv[2],String(process.pid));
const input=createInterface({input:process.stdin});
input.on('line',line=>{
 const request=JSON.parse(line);if(request.id===undefined)return;
 const result=request.method==='initialize'?{protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'sakura-fixture',version:'1'}}:
 request.method==='tools/list'?{tools:[{name:'ping',description:'Return fixture evidence',inputSchema:{type:'object',properties:{}}}]}:
 request.method==='tools/call'?{content:[{type:'text',text:'MCP fixture called'}]}:{};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});
input.on('close',()=>process.exit(0));
