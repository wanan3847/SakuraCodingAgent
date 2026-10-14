import {lstat,mkdir,realpath} from "node:fs/promises";
import {basename,dirname,join,resolve} from "node:path";

export interface CommandProtection{readWriteDeny:string[];writeDeny:string[]}
/** Seatbelt matches canonical paths; resolve aliases and ancestors of future files. */
export async function canonicalProtectionPath(target:string):Promise<string>{
 let cursor=resolve(target);const pending:string[]=[];
 while(true){try{return join(await realpath(cursor),...pending.reverse());}catch(error){
  if(!["ENOENT","ENOTDIR"].includes((error as NodeJS.ErrnoException).code??""))throw error;
  const parent=dirname(cursor);if(parent===cursor)throw error;pending.push(basename(cursor));cursor=parent;
 }}
}
export const protectedSandboxSupported=()=>process.platform==="darwin"||(process.platform==="linux"&&["x64","arm64"].includes(process.arch));

/** Classic seccomp BPF: deny sockets (including host Unix IPC), io_uring, clone3,
 * unshare and setns. The architecture check refuses compatibility ABIs. bwrap adds
 * PID/user/mount/net isolation; clone3 denial keeps legacy bwrap from nested userns.
 */
export function linuxSeccompProgram(arch=process.arch):Buffer{
 const audit=arch==="x64"?0xc000003e:arch==="arm64"?0xc00000b7:undefined;
 if(audit===undefined)throw new Error("Unsupported protected Linux architecture");
 const instructions:Array<[number,number,number,number]>=[
  [0x20,0,0,4], // load seccomp_data.arch
  [0x15,1,0,audit],
  [0x06,0,0,0x80000000], // kill on an unexpected ABI
  [0x20,0,0,0], // load syscall number
 ];
 if(arch==="x64")instructions.push([0x45,0,1,0x40000000],[0x06,0,0,0x80000000]); // no x32 ABI
 for(const syscall of [...(arch==="x64"?[41,53]:[198,199]),425,426,427,...(arch==="x64"?[272,308]:[97,268])])instructions.push([0x15,0,1,syscall],[0x06,0,0,0x0005000d]); // EACCES: sockets, io_uring, unshare and setns
 // Ask clone3 callers to use clone, whose namespace flags are inspectable here.
 // ENOSYS preserves normal runtimes' compatibility fallback without allowing clone3 namespaces.
 instructions.push([0x15,0,1,435],[0x06,0,0,0x00050026]);
 // Old bubblewrap releases lack --disable-userns. The outer user namespace is
 // still isolated; unshare/setns are denied above and bwrap drops all capabilities.
 instructions.push([0x06,0,0,0x7fff0000]);
 const bytes=Buffer.alloc(instructions.length*8);
 instructions.forEach(([code,jt,jf,k],i)=>{bytes.writeUInt16LE(code,i*8);bytes[i*8+2]=jt;bytes[i*8+3]=jf;bytes.writeUInt32LE(k,i*8+4);});
 return bytes;
}

/** Fail closed when a Linux host lacks usable user namespace permissions. */
export async function linuxSandboxArguments(protection:CommandProtection,cwd:string,temporary:string,command:string):Promise<string[]>{
 const args=["--unshare-all","--die-with-parent","--new-session","--cap-drop","ALL","--ro-bind","/","/","--proc","/proc","--dev","/dev","--bind",cwd,cwd,"--bind",temporary,temporary];
 for(const target of protection.writeDeny){
  // Reserved control directories need mount points even before a first publication.
  try{await lstat(target);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;await mkdir(target,{recursive:true,mode:0o700});}
  const path=await realpath(target);args.push("--ro-bind",path,path);
 }
 for(const target of protection.readWriteDeny){
  const path=await realpath(target),info=await lstat(path);
  if(info.isDirectory())args.push("--tmpfs",path,"--remount-ro",path);
  else args.push("--ro-bind","/dev/null",path);
 }
 return [...args,"--chdir",cwd,"--seccomp","3","--","/bin/sh","-c",command];
}
