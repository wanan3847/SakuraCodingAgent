import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
type CommandOptions=Parameters<ExtensionAPI['registerCommand']>[1];
/** Keep Pi's built-in /resume for sessions; Sakura's run-resume keeps its namespace. */
export function sakuraCommandName(name:string){
 const primary=name==='sakura-run'?'sakura-subagent':name;
 return process.env.SAKURA_STANDALONE==='1'&&primary!=='sakura-resume'?primary.replace(/^sakura-/,''):primary;
}
export function registerSakuraCommand(pi:ExtensionAPI,name:string,options:CommandOptions){
 pi.registerCommand(name,options);
 const short=sakuraCommandName(name);
 if(short!==name)pi.registerCommand(short,{...options,description:options.description?.replaceAll('/'+name,'/'+short)});
 if(name==='sakura-run'&&process.env.SAKURA_STANDALONE==='1')pi.registerCommand('run',{...options,description:'Compatibility alias for /subagent'});
}
