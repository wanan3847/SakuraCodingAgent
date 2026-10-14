import assert from "node:assert/strict";
import {test} from "node:test";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {Theme,type ThemeColor,type ThemeBg} from "@earendil-works/pi-coding-agent";
import {plainTheme,brandHeader} from "../../src/ui/brand.ts";
import {visibleWidth} from "@earendil-works/pi-tui";
test("NO_COLOR uses native terminal defaults for every role and the brand fits each width",async()=>{
 const json=JSON.parse(await readFile(new URL("../../themes/sakura-night.json",import.meta.url),"utf8"));
 const bgKeys=new Set(["selectedBg","searchMatchBg","userMessageBg","customMessageBg","toolPendingBg","toolSuccessBg","toolErrorBg"]);
 const entries=Object.entries(json.colors).map(([token,color])=>[token,json.vars[color as string]??color]);
 const source=new Theme(Object.fromEntries(entries.filter(([token])=>!bgKeys.has(token as string))) as Record<ThemeColor,string>,Object.fromEntries(entries.filter(([token])=>bgKeys.has(token as string))) as Record<ThemeBg,string>,"truecolor");
 const theme=plainTheme(source);
 for(const token of Object.keys(json.colors)) {
  const output=bgKeys.has(token)?theme.bg(token as ThemeBg,"失败 +新增 -删除"):theme.fg(token as ThemeColor,"失败 +新增 -删除");
  assert.doesNotMatch(output,/\x1b\[(?:38|48);/);assert.match(output,/失败 \+新增 -删除/);
 }
 for(const width of [40,80,120])for(const emoji of [true,false])assert.ok(brandHeader(width,emoji).every(line=>visibleWidth(line)<=width));
 assert.doesNotMatch(brandHeader(40,false)[0],/🌸/);
});
test("native Pi theme rendering preserves readable code, diff, error and selection in 256 colors",async(t)=>{
 const output=await mkdtemp(join(tmpdir(),"sakura-theme-check-"));t.after(()=>rm(output,{recursive:true,force:true}));
 await promisify(execFile)(process.execPath,["scripts/check-themes.mjs","--output",output],{cwd:new URL("../../",import.meta.url).pathname});
 const report=JSON.parse(await readFile(join(output,"contrast.json"),"utf8"));assert.equal(report.reports.length,4);
 for(const theme of report.reports){assert.equal(theme.passed,true);assert.ok(theme.checks.every((check:{ratio:number;minimum:number})=>check.ratio>=check.minimum));if(theme.mode==="256color"){assert.match(theme.ansiSample,/\x1b\[38;5;/);assert.doesNotMatch(theme.ansiSample,/\x1b\[(38|48);2;/);}}
});
