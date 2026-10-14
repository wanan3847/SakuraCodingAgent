import {readFile,mkdtemp,writeFile,rm} from "node:fs/promises";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createShellCommandRunner} from "../../src/verification/test-runner.ts";
import {verify} from "../../src/verification/verifier.ts";
/** Freeze checks before the model edits the checkout, including scenario and TS options. */
export async function prepareFixtureJudge(workspace:string,taskId:string,baseRef="HEAD") {
 const directory=await mkdtemp(join(tmpdir(),"sakura-fixture-judge-"));
 const git=promisify(execFile);
 const original=(await git("git",["show",`${baseRef}:tests/check.mjs`],{cwd:workspace})).stdout,config=JSON.parse((await git("git",["show",`${baseRef}:tsconfig.json`],{cwd:workspace})).stdout);
 const source=original.replaceAll("'../src/",`'${pathToFileURL(join(workspace,"src")).href}/`).replace("const scenario=(await readFile('scenario.txt','utf8')).trim();",`const scenario=${JSON.stringify(taskId)};`);
 if(source===original || !source.includes(`const scenario=${JSON.stringify(taskId)};`))throw new Error("Unrecognized fixed fixture judge layout");
 const testPath=join(directory,"check.mjs"),configPath=join(directory,"tsconfig.json");
 await writeFile(testPath,source);await writeFile(configPath,JSON.stringify({...config,include:[join(workspace,"src","**","*.ts")]}));
 const tsc=resolve(new URL("../../node_modules/typescript/bin/tsc",import.meta.url).pathname);
 const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;
 const commands=[`${quote(process.execPath)} ${quote(tsc)} --noEmit -p ${quote(configPath)}`,`${quote(process.execPath)} ${quote(testPath)}`];
 return {directory,source,config,async run(signal?:AbortSignal,protection?:Parameters<typeof createShellCommandRunner>[0]){return verify({cwd:workspace,commands,signal,run:createShellCommandRunner(protection)});},dispose:()=>rm(directory,{recursive:true,force:true})};
}
