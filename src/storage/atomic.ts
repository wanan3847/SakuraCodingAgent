import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Publish one complete file; unique temp names also prevent concurrent writers sharing a temp file. */
export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flush: true });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
