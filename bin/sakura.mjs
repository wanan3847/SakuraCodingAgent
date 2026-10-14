#!/usr/bin/env node
import {homedir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url,{tryNative:false});
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const homeIndex=args.indexOf('--home');
if(homeIndex>=0&&!args[homeIndex+1])throw new Error('--home requires a directory');
const home=resolve(homeIndex>=0?args.splice(homeIndex,2)[1]:(process.env.SAKURA_HOME??join(homedir(),'.sakura')));
// Set the profile before importing Pi: its config module reads this environment at load time.
process.env.SAKURA_HOME=home;process.env.PI_CODING_AGENT_DIR=join(home,'agent');process.env.SAKURA_STANDALONE='1';
process.env.PI_SKIP_VERSION_CHECK='1';
const command=!args[0]||(args[0].startsWith('-')&&!['--help','-h'].includes(args[0]))?'tui':args[0];
if(['doctor','tui'].includes(command))process.env.PI_OFFLINE='1';
if(['--help','help','-h'].includes(command)){
 console.log(`Sakura Coding Agent\n\nsakura                         独立终端工作台\nsakura init [NAME]              配置模型（无参数进入向导）\nsakura --model NAME             选择模型\nsakura --cloud                  使用独立云端登录\nsakura models                   查看模型配置诊断\nsakura connect                  检查模型实际连接\nsakura mcp list | add | remove   管理独立 MCP 服务\nsakura web [--port 4317]        本地项目展示网站\nsakura plan "任务"              生成计划\nsakura run "任务"               执行任务\nsakura history | status        查看运行\nsakura doctor                  核对独立配置与资源\nsakura install npm:PKG@VERSION  安装 Pi 生态包到 Sakura\nsakura remove SOURCE           移除生态包\nsakura packages                查看已配置的生态包\n\n--home PATH 指定 Sakura 配置目录，默认 ~/.sakura。不会导入 ~/.pi。模型切换直接使用 Pi 原生 /model。\nWeb 支持 --project PATH、--runs PATH（可重复）；只监听 127.0.0.1。`);
}else if(['tui','init','doctor','web','install','remove','packages','models','connect','mcp'].includes(command)){
 const {main}=await jiti.import('../src/standalone/main.ts');await main([command,...args.slice(command===args[0]?1:0)]);
}else{
 const child=spawn(process.execPath,[join(root,'bin/run-business.mjs'),...args],{stdio:'inherit',env:process.env});
 for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>child.kill(sig));
 child.on('error',error=>{console.error(error.message);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
}
