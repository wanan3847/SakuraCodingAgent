import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, writeFile,lstat,readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { atomicWrite } from "../storage/atomic.ts";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** A dependency link ignored as a directory must not become a delivered source symlink. */
export async function artifactPathspec(cwd:string,baseRef="HEAD"):Promise<string[]> {
 const paths=[".",":(glob,exclude)**/.sakura/**"];
 const link=await lstat(join(cwd,"node_modules")).catch(error=>{if(error.code==="ENOENT")return undefined;throw error;});
 if(link?.isSymbolicLink()) {
  const tracked=await exec("git",["cat-file","-e",`${baseRef}:node_modules`],{cwd}).then(()=>true,()=>false);
  const generated=await readFile(join(cwd,".sakura","generated-dependencies.json"),"utf8").then(text=>JSON.parse(text) as string[],error=>{if(error.code==="ENOENT")return [] as string[];throw error;});
  // A literal exclusion still makes Git reject an ignored symlink. As with
  // .sakura, a recursive glob excludes it without explicitly naming that path.
  if(!tracked&&generated.includes("node_modules"))paths.push(":(glob,exclude)**/node_modules");
 }
 return paths;
}

export interface WorkspaceChanges {
  baseCommit: string;
  changedFiles: string[];
  changes: Array<{ status: string; path: string; previousPath?: string }>;
  diff: string;
}

/** Snapshot the working tree through an isolated Git index, without changing staging. */
export async function captureChanges(cwd: string, baseRef = "HEAD"): Promise<WorkspaceChanges> {
  const temporary = await mkdtemp(join(tmpdir(), "sakura-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(temporary, "index") };
  const git = async (...args: string[]) => (await exec("git", args, { cwd, env, maxBuffer: 256 * 1024 * 1024 })).stdout;
  try {
    const baseCommit = (await git("rev-parse", "--verify", `${baseRef}^{commit}`)).trim();
    await git("read-tree", baseCommit);
    // One recursive exclusion covers root and nested metadata. An explicit
    // .sakura pathspec makes Git reject ignored metadata even as an exclusion.
    await git("add", "-A", "--", ...await artifactPathspec(cwd,baseCommit));
    const records = (await git("diff", "--cached", "--name-status", "-z", "--find-renames", baseCommit)).split("\0");
    const changes: WorkspaceChanges["changes"] = [];
    for (let index = 0; index < records.length && records[index];) {
      const status = records[index++];
      if (status.startsWith("R") || status.startsWith("C")) {
        const previousPath = records[index++];
        changes.push({ status, previousPath, path: records[index++] });
      } else {
        changes.push({ status, path: records[index++] });
      }
    }
    const diff = await git("diff", "--cached", "--binary", "--full-index", "--find-renames", baseCommit);
    return { baseCommit, diff, changes, changedFiles: [...new Set(changes.flatMap((change) => change.previousPath ? [change.previousPath, change.path] : [change.path]))] };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export interface WorkspaceArtifact {
  version: 1;
  patchSha256?: string;
  baseCommit: string;
  changedFiles: string[];
  changes: WorkspaceChanges["changes"];
  diffFile: string;
  createdAt: string;
}

/** Both files must be durable before the caller can clean an isolated workspace. */
export async function saveArtifact(directory: string, id: string, changes: WorkspaceChanges): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error(`Unsafe artifact id: ${id}`);
  await mkdir(directory, { recursive: true });
  const patch = join(directory, `${id}.diff`);
  const manifest = join(directory, `${id}.json`);
  await atomicWrite(patch, changes.diff);
  const artifact: WorkspaceArtifact = {
    version: 1, patchSha256: createHash("sha256").update(changes.diff).digest("hex"), baseCommit: changes.baseCommit, changedFiles: changes.changedFiles, changes: changes.changes,
    diffFile: basename(patch), createdAt: new Date().toISOString(),
  };
  await atomicWrite(manifest, `${JSON.stringify(artifact, null, 2)}\n`);
  return manifest;
}
