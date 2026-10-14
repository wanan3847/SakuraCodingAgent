import {createServer,type Server} from 'node:http';
import {readFile,readdir,lstat,realpath,stat} from 'node:fs/promises';
import {join,resolve,relative,basename,isAbsolute} from 'node:path';
import {reduceMetrics,emptyMetrics,type TracedEvent} from '../telemetry/events.ts';
import {profileSummary,packageRoot} from '../standalone/profile.ts';
export interface DashboardOptions{project:string;port?:number;roots?:string[]}
const inside=(root:string,path:string)=>{const part=relative(root,path);return !isAbsolute(part)&&part!=='..'&&!part.startsWith('../');};
async function safeText(root:string,path:string,max=8*1024*1024){
 try{const canonical=await realpath(path);if(!inside(root,canonical))return undefined;const info=await stat(canonical);if(!info.isFile()||info.size>max)return undefined;return await readFile(canonical,'utf8');}catch{return undefined;}
}
async function json(root:string,path:string){const text=await safeText(root,path);if(text===undefined)return undefined;try{return JSON.parse(text);}catch{return undefined;}}
export async function createDashboardServer(options:DashboardOptions):Promise<Server>{
 const project=await realpath(resolve(options.project)),roots=await Promise.all([join(project,'.sakura/runs'),...(options.roots??[])].map(async path=>{try{return await realpath(path);}catch{return resolve(path);}}));
 const webRoot=await realpath(join(packageRoot,'web'));
 const catalogue=new Map<string,{root:string;dir:string}>();
 async function readRun(key:string,root:string,dir:string,detail=false){
  const state=await json(root,join(dir,'state.json'));if(!state?.runId||!state?.graph?.nodes)return undefined;
  const raw=await safeText(root,join(dir,'events.jsonl'));
  const events:TracedEvent[]=(raw??'').split('\n').flatMap(line=>{try{const item=JSON.parse(line);return item?.event?.type?[item]:[];}catch{return [];}});
  const metrics=await json(root,join(dir,'metrics.json'))??events.reduce((m,item)=>reduceMetrics(m,item.event),emptyMetrics(state.runId,state.startedAt));
  const summary={key,id:state.runId,task:state.graph.rootTask,phase:state.phase??'unverified',startedAt:state.startedAt,endedAt:state.endedAt,recordedAt:events.at(-1)?.at??state.startedAt,metrics,source:basename(dir),nodes:Object.values(state.graph.nodes),verification:state.verification??[],error:state.error};
  if(!detail)return summary;
  const diffDir=join(dir,'diffs'),names=await readdir(diffDir).catch(()=>[]);
  const diffs=await Promise.all(names.filter(name=>name.endsWith('.diff')).map(async name=>({name,text:await safeText(root,join(diffDir,name))??''})));
  return {...summary,state,events:events.slice(-500),diffs};
 }
 async function scan(){
  catalogue.clear();const rows=[];
  for(let index=0;index<roots.length;index++){
   const root=roots[index];const names=await readdir(root).catch(()=>[]);
   for(const name of names.slice(0,250)){
    const dir=join(root,name),info=await lstat(dir).catch(()=>undefined);if(!info?.isDirectory()||info.isSymbolicLink())continue;
    const key=Buffer.from(`${index}/${name}`).toString('base64url'),row=await readRun(key,root,dir);
    if(row){catalogue.set(key,{root,dir});rows.push(row);}
   }
  }
  return rows.sort((a,b)=>b.startedAt-a.startedAt);
 }
 return createServer(async(req,res)=>{
  const port=(res.socket?.localPort??options.port??4317),host=req.headers.host??'';
  const permitted=[`127.0.0.1:${port}`,`localhost:${port}`];
  if(!permitted.includes(host)||req.headers.origin&&![`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(req.headers.origin)){res.writeHead(403);res.end('Local origin required');return;}
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  if(req.method!=='GET'){res.writeHead(405);res.end('Read-only dashboard');return;}
  try{
   const url=new URL(req.url??'/',`http://${host}`),send=(data:unknown)=>{res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(data));};
   if(url.pathname==='/api/overview'){const runs=await scan();send({project:{name:basename(project),path:project},profile:await profileSummary(),runs,experiences:await json(project,join(project,'.sakura/experience/experiences.json'))??[],updatedAt:Date.now()});return;}
   if(url.pathname.startsWith('/api/runs/')){
    const key=url.pathname.slice('/api/runs/'.length);await scan();const ref=catalogue.get(key);if(!ref){res.statusCode=404;send({error:'Run not found'});return;}
    send(await readRun(key,ref.root,ref.dir,true));return;
   }
   const files:Record<string,[string,string]>={'/':['index.html','text/html'],'/index.html':['index.html','text/html'],'/landing.js':['landing.js','text/javascript'],'/landing.css':['landing.css','text/css'],'/assets/sakura-hero.png':['assets/sakura-hero.png','image/png'],'/flower.svg':['flower.svg','image/svg+xml'],'/guide.html':['guide.html','text/html'],'/license.txt':['license.txt','text/plain'],'/workbench':['workbench/index.html','text/html'],'/workbench/':['workbench/index.html','text/html'],'/workbench/app.js':['workbench/app.js','text/javascript'],'/workbench/style.css':['workbench/style.css','text/css']};
   const asset=files[url.pathname];if(!asset){res.writeHead(404);res.end('Not found');return;}
   res.setHeader('Content-Type',asset[1]+(asset[1].startsWith('text/')?'; charset=utf-8':''));res.end(await readFile(join(webRoot,asset[0])));
  }catch(error){if(!res.headersSent){res.statusCode=500;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:error instanceof Error?error.message:'Unable to read run'}));}else res.end();}
 });
}
export async function serveDashboard(options:DashboardOptions){
 const port=options.port??4317;if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid port');
 const server=await createDashboardServer(options);await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>accept());});
 const address=server.address();console.log(`Sakura 项目网站：http://127.0.0.1:${typeof address==='object'&&address?address.port:port}\n项目：${resolve(options.project)}\n项目介绍位于首页；已有运行工作台位于 /workbench。`);
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>server.close());
 return server;
}
