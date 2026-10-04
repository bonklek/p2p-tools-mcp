import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { structuredResult, type ToolResult } from '../shared/tool-result.js';
import { McpError } from '../shared/errors.js';

export const androidConfigPath = (env:NodeJS.ProcessEnv=process.env) => env.P2P_ANDROID_CONFIG || join(homedir(),'.p2p-tools','android.json');
const configSchema=z.strictObject({baseUrl:z.string().default('http://127.0.0.1:5032'),accessToken:z.string().min(32)});
export type AndroidConfig=z.infer<typeof configSchema>;
export function loadAndroidConfig(env:NodeJS.ProcessEnv=process.env):AndroidConfig|undefined {
  const path=androidConfigPath(env);if(!existsSync(path))return;
  let parsed:AndroidConfig;
  try {parsed=configSchema.parse(JSON.parse(readFileSync(path,'utf8')));}catch {throw new Error('Android pairing file is invalid; rerun local pairing');}
  const url=new URL(parsed.baseUrl);
  if(url.protocol!=='http:' || !['127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname!=='/')throw new Error('Android bridge must use a direct loopback URL');
  return parsed;
}
export class AndroidBridge {
  constructor(private config:AndroidConfig,private fetcher:typeof fetch=fetch){}
  async call(operation:string,input:unknown={}):Promise<Record<string,unknown>> {
    const response=await this.fetcher(new URL(`/v1/${operation}`,this.config.baseUrl),{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${this.config.accessToken}`},body:JSON.stringify(input),signal:AbortSignal.timeout(['search','fetch'].includes(operation)?30000:15000),redirect:'error'});
    if(response.status===401)throw new McpError('PAIRING_REQUIRED','Pair locally again');
    if(!response.ok)throw new McpError('ANDROID_OPERATION_REFUSED','Inspect local setup and native job status');
    let length=0;const pieces:Uint8Array[]=[];
    if(!response.body)throw new Error('Android bridge returned no response');
    for await(const piece of response.body){length+=piece.length;if(length>2_000_000){await response.body.cancel().catch(()=>{});throw new Error('Android response exceeded limit');}pieces.push(piece);}
    const result=JSON.parse(Buffer.concat(pieces).toString('utf8'));
    if(!result || typeof result!=='object' || Array.isArray(result))throw new Error('Invalid Android response');
    return result;
  }
}
const track={artist:z.string().trim().min(1).max(200),title:z.string().trim().min(1).max(200),album:z.string().max(200).default(''),duration_ms:z.number().int().nonnegative().default(0)};
export const androidToolSpecs={
  p2p_setup_status:{description:'Check phone-local pairing, Soulseek login, destination access, and native worker. If user input is needed, show the returned message and local action; never request account secrets in chat.',inputSchema:{},annotations:{readOnlyHint:true}},
  p2p_library_find:{description:'Find physically available recordings in this phone library before downloading.',inputSchema:track,annotations:{readOnlyHint:true}},
  p2p_music_search:{description:'Search Soulseek on this phone and return bounded opaque candidates. Search results are hints; native audio verification occurs before publication.',inputSchema:track,annotations:{readOnlyHint:true}},
  p2p_music_fetch:{description:'Fetch one song directly to this phone. Reuse an existing library match or active job; otherwise choose a plausible candidate or return review choices. Return a durable job ID immediately after enqueue.',inputSchema:{...track,request_key:z.string().min(1).max(128).optional()},annotations:{readOnlyHint:false}},
  p2p_music_queue:{description:'Queue an explicit saved candidate for this phone, with durable duplicate and storage checks.',inputSchema:{...track,candidate_id:z.string().regex(/^[a-f0-9]{64}$/),request_key:z.string().min(1).max(128).optional()},annotations:{readOnlyHint:false}},
  p2p_music_status:{description:'Inspect native job states, verification outcomes, storage reservations, and unique published arrivals. A downloaded file is not yet playable.',inputSchema:{job_id:z.string().uuid().optional()},annotations:{readOnlyHint:true}},
  p2p_music_cancel:{description:'Cancel a selected phone job and retain recoverable state. Does not delete an established library song.',inputSchema:{job_id:z.string().uuid()},annotations:{readOnlyHint:false}},
  p2p_sharing_status:{description:'Read actual Seeker share-index counts; does not publish or select additional shares.',inputSchema:{},annotations:{readOnlyHint:true}},
  p2p_android_capabilities:{description:'Check selected Shizuku access through rish. No arbitrary privileged commands are accepted.',inputSchema:{},annotations:{readOnlyHint:true}}
};
export async function shizukuStatus(env:NodeJS.ProcessEnv=process.env):Promise<Record<string,unknown>> {
  return new Promise(resolve=>execFile(env.P2P_RISH || 'rish',['-c','id'],{env:{...env,RISH_PRESERVE_ENV:'0'},timeout:5000,maxBuffer:2048},(error,stdout)=>resolve(error?{available:false,next_action:'Start Shizuku, authorize Termux and install its exported rish helper. Native downloads can operate with granted app permissions.'}:{available:true,shell_uid:Number(stdout.match(/uid=(\d+)/)?.[1]??-1)})));
}
export function androidHandlers(env:NodeJS.ProcessEnv=process.env,fetcher:typeof fetch=fetch):Record<string,(input:unknown)=>Promise<ToolResult>> {
  return Object.fromEntries(Object.entries(androidToolSpecs).map(([name,spec])=>[name,async(input:unknown)=>structuredResult(async()=>{
    const args=z.object(spec.inputSchema).strict().parse(input);
    if(name==='p2p_android_capabilities')return shizukuStatus(env);
    const config=loadAndroidConfig(env);
    if(!config)return {status:'needs_user_input',user_message:'Open P2P Automation on this phone, enable automation, and run p2p-tools-android pair in Termux. Enter the displayed code in its hidden local prompt; keep sensitive input out of chat.',local_entry:'p2p-tools-android pair'};
    const bridge=new AndroidBridge(config,fetcher);
    const op:Record<string,string>={p2p_setup_status:'setup',p2p_library_find:'library',p2p_music_search:'search',p2p_music_fetch:'fetch',p2p_music_queue:'queue',p2p_music_status:'status',p2p_music_cancel:'cancel',p2p_sharing_status:'sharing'};
    try {
      return await bridge.call(op[name],{...args,...(['p2p_music_fetch','p2p_music_queue'].includes(name)?{request_key:'request_key' in args && args.request_key || randomUUID()}: {})});
    } catch (error) {
      if(error instanceof McpError)throw error;
      throw new McpError('ANDROID_BACKEND_UNAVAILABLE','Open and enable the local Android backend');
    }
  },()=> 'Open the phone app and inspect setup; use local pairing and keep sensitive input out of chat.') ]));
}
