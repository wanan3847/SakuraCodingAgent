import {readFile,mkdir,writeFile} from "node:fs/promises";
import {resolve,join} from "node:path";
import {Theme} from "@earendil-works/pi-coding-agent";
import {foregroundAnsi,parseColor,indexedColor,colorToRgb,colorToHex} from "@earendil-works/pi-tui";
const root=resolve(new URL("../",import.meta.url).pathname);
const backgroundTokens=new Set(["selectedBg","searchMatchBg","userMessageBg","customMessageBg","toolPendingBg","toolSuccessBg","toolErrorBg"]);
const escaped=text=>String(text).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;");
const luminance=color=>{const {r,g,b}=colorToRgb(color);const values=[r,g,b].map(value=>{const channel=value/255;return channel<=0.04045?channel/12.92:((channel+0.055)/1.055)**2.4;});return values[0]*0.2126+values[1]*0.7152+values[2]*0.0722;};
const ratio=(first,second)=>{const a=luminance(first),b=luminance(second);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);};
function renderedColor(color,mode){if(mode==="truecolor")return color;const ansi=foregroundAnsi(color,mode),match=/38;5;(\d+)m/.exec(ansi);if(!match)throw new Error(`Expected Pi indexed color: ${ansi}`);return indexedColor(Number(match[1]));}
const panels=[],reports=[];
for(const name of ["sakura-night","sakura-light"]){
 const json=JSON.parse(await readFile(join(root,"themes",`${name}.json`),"utf8"));
 const resolved=Object.fromEntries(Object.entries(json.colors).map(([token,color])=>[token,json.vars[color]??color]));
 for(const mode of ["truecolor","256color"]){
  const foreground=Object.fromEntries(Object.entries(resolved).filter(([token])=>!backgroundTokens.has(token))),background=Object.fromEntries(Object.entries(resolved).filter(([token])=>backgroundTokens.has(token)));
  const theme=new Theme(foreground,background,mode,{name,appearance:json.appearance});
  const colors=Object.fromEntries(Object.entries(theme.colors).map(([token,color])=>[token,renderedColor(color,mode)]));
  const page=renderedColor(parseColor(json.export.pageBg),mode),hex=token=>colorToHex(colors[token]);
  const checks=[...['text','accent','error','success','warning','toolDiffAdded','toolDiffRemoved','syntaxKeyword','syntaxString','syntaxFunction','syntaxVariable','syntaxNumber','syntaxType','syntaxOperator','syntaxPunctuation','mdHeading','mdLink','mdCode','mdCodeBlock','mdListBullet','bashMode'].map(token=>({foreground:token,background:"page",minimum:4.5})),...['muted','dim','syntaxComment','toolDiffContext','thinkingText','mdLinkUrl','mdQuote'].map(token=>({foreground:token,background:"page",minimum:3})),{foreground:"text",background:"selectedBg",minimum:4.5},{foreground:"searchMatchText",background:"searchMatchBg",minimum:4.5},...['toolPendingBg','toolSuccessBg','toolErrorBg'].flatMap(background=>['toolTitle','toolOutput'].map(foreground=>({foreground,background,minimum:4.5}))),{foreground:"userMessageText",background:"userMessageBg",minimum:4.5},{foreground:"customMessageText",background:"customMessageBg",minimum:4.5},{foreground:"customMessageLabel",background:"customMessageBg",minimum:4.5}].map(check=>({...check,ratio:ratio(colors[check.foreground],check.background==="page"?page:colors[check.background])}));
  const ansi=theme.bg("toolErrorBg",theme.fg("error","失败：检查退出码 1"));
  if(mode==="256color"&&/\x1b\[(?:38|48);2;/.test(ansi))throw new Error("Truecolor leaked into 256color output");
  reports.push({name,mode,checks,passed:checks.every(check=>check.ratio>=check.minimum),ansiSample:ansi});
  const index=panels.length,x=(index%2)*520,y=Math.floor(index/2)*420;
  const line=(dy,token,text,bg)=>`${bg?`<rect x="${x+16}" y="${y+dy-20}" width="480" height="30" fill="${hex(bg)}"/>`:""}<text x="${x+24}" y="${y+dy}" fill="${hex(token)}">${escaped(text)}</text>`;
  panels.push(`<g><rect x="${x}" y="${y}" width="512" height="410" rx="10" fill="${colorToHex(page)}"/><g font-family="ui-monospace,Menlo,monospace" font-size="14">${line(38,"accent",`${name} · ${mode}`)}${line(78,"text","🌸 Sakura · 正在执行 2/3")}${line(116,"userMessageText","修复 refresh token，并补回归检查","userMessageBg")}${line(158,"syntaxComment","// 旋转后返回新 token")}${line(194,"syntaxKeyword","const refreshed = store.rotate(current);")}${line(230,"toolDiffRemoved","- return current;")}${line(266,"toolDiffAdded","+ return refreshed;")}${line(307,"toolOutput","✓ typecheck / regression passed","toolSuccessBg")}${line(350,"error","✗ 检查失败：退出码 1","toolErrorBg")}${line(391,"text","› 选中计划：implement → verify","selectedBg")}</g></g>`);
 }
}
const argument=process.argv.indexOf("--output"),output=resolve(argument<0?join(root,".sakura","release","themes"):process.argv[argument+1]);
await mkdir(output,{recursive:true});
await writeFile(join(output,"preview.svg"),`<svg xmlns="http://www.w3.org/2000/svg" width="1040" height="840" viewBox="0 0 1040 840">${panels.join("")}</svg>`);
await writeFile(join(output,"contrast.json"),JSON.stringify({method:"Pi public Theme ANSI → native xterm palette; sRGB contrast, assuming the documented theme background",reports},null,2));
console.log(JSON.stringify({output,passed:reports.every(report=>report.passed),minimumRatios:reports.map(report=>({name:report.name,mode:report.mode,minimum:Math.min(...report.checks.map(check=>check.ratio))}))},null,2));
process.exitCode=reports.every(report=>report.passed)?0:1;
