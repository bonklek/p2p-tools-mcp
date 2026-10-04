import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { structuredResult } from '../shared/tool-result.js';
import type { ToolResult } from '../shared/tool-result.js';
const script = fileURLToPath(new URL('../../tools/music_workflow.py', import.meta.url));
const profile = { profile: z.string().min(1).describe('Absolute path to the user-reviewed music workflow JSON') };
export const musicToolSpecs = {
  p2p_music_plan: { description:'Build a durable music plan and baseline inventory; never downloads. Reports missing prerequisites.', inputSchema:profile, annotations:{ readOnlyHint:false } },
  p2p_music_status: { description:'Read delivered unique songs, stage backlog, rate, storage and pause reasons.', inputSchema:profile, annotations:{ readOnlyHint:true } },
  p2p_music_start: { description:'Start a resumable background workflow. Downloading and source deletion each require explicit flags and matching profile permission. No arbitrary speed cap is added.', inputSchema:{...profile,download:z.boolean().default(false),delete_sources:z.boolean().default(false)}, annotations:{readOnlyHint:false,destructiveHint:true} },
  p2p_music_pause: { description:'Pause new acquisition and delivery for this workflow; preserve all files and resume state.', inputSchema:profile,annotations:{readOnlyHint:false} }
};
function args(action:string,path:string,download=false,deleteSources=false) {
  return [script,action,'--profile',path,...(download?['--download']:[]),...(deleteSources?['--delete-sources']:[])];
}
async function invoke(argv:string[],env:NodeJS.ProcessEnv):Promise<unknown> {
  return new Promise((resolve,reject) => {
    const p=spawn(env.P2P_PYTHON || 'python',argv,{env,windowsHide:true});
    let out='';let oversized=false;
    p.stdout.on('data',b=>{out+=b.toString();if(out.length>2_000_000){oversized=true;p.kill();}});
    p.stderr.resume(); // Raw service traces and filenames do not enter MCP error messages.
    p.on('error',()=>reject(new Error('Python runtime unavailable; set P2P_PYTHON')));
    p.on('close',code=>{if(oversized)return reject(new Error('Workflow response too large'));try { const result=JSON.parse(out.trim().split('\n').at(-1)!); resolve(result); } catch {reject(new Error(code ? 'Workflow failed; inspect the local workflow log' : 'Invalid workflow response'));}});
  });
}
export function musicHandlers(env:NodeJS.ProcessEnv=process.env):Record<string,(args:unknown)=>Promise<ToolResult>> {
  return Object.fromEntries(Object.entries(musicToolSpecs).map(([name,spec])=>[name,async(input:unknown)=>structuredResult(async()=>{
    const parsed=z.object(spec.inputSchema).strict().parse(input);
    const action=name.replace('p2p_music_','');
    return invoke(args(action,parsed.profile,'download' in parsed && parsed.download===true,'delete_sources' in parsed && parsed.delete_sources===true),env);
  },()=> 'Check workflow prerequisites and the local log; never paste credentials into chat.') ]));
}
export async function runMusicCli(argv:string[],env:NodeJS.ProcessEnv,stdout:(s:string)=>void,stderr:(s:string)=>void):Promise<number> {
  if (!argv.length || argv.includes('--help')) {stdout('Usage: p2p-tools music <plan|start|run|status|pause> --profile <workflow.json> [--download] [--delete-sources]\nSet P2P_PYTHON when Python is not on PATH. See docs/music-workflow.md.\n');return 0;}
  const [action]=argv;
  if(!['plan','start','run','status','pause'].includes(action)) {stderr('Unknown music action\n');return 2;}
  // Keep Python's argument validation; never pass a command through a shell.
  if(action==='run') return new Promise(resolve=>{const p=spawn(env.P2P_PYTHON || 'python',[script,...argv],{env,stdio:'inherit',windowsHide:true});p.on('error',()=>resolve(1));p.on('close',c=>resolve(c??1));});
  try {const result=await invoke([script,...argv],env) as {status?:string};stdout(JSON.stringify(result)+'\n');return ['blocked','prerequisite_missing'].includes(result.status??'')?1:0;}catch {stderr('Music workflow failed. Check Python prerequisites and docs/music-workflow.md.\n');return 1;}
}
