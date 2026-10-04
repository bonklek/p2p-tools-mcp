import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AndroidBridge, androidHandlers, loadAndroidConfig } from './backend.js';

const roots:string[]=[];
function config(baseUrl='http://127.0.0.1:5032') {
  const root=mkdtempSync(join(tmpdir(),'p2p-android-'));roots.push(root);
  const path=join(root,'android.json');writeFileSync(path,JSON.stringify({baseUrl,accessToken:'test-token-'.repeat(5)}));
  return {P2P_ANDROID_CONFIG:path};
}
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
describe('Android MCP trust and request boundary',()=>{
  it('requires local pairing before making a network request',async()=>{
    const fetcher=vi.fn();const result=await androidHandlers({P2P_ANDROID_CONFIG:join(tmpdir(),'absent-p2p-config')},fetcher as typeof fetch).p2p_setup_status({});
    expect(result).toMatchObject({ok:true,data:{status:'needs_user_input',local_entry:'p2p-tools-android pair'}});expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['https://127.0.0.1:5032','http://example.com','http://127.0.0.1@evil.com','http://127.0.0.1:5032/private','http://127.0.0.1:5032/?token=secret'])('refuses non-direct loopback bridge %s',base=>{
    expect(()=>loadAndroidConfig(config(base))).toThrow();
  });
  it('rejects arbitrary paths and privileged commands before calling native backend',async()=>{
    const fetcher=vi.fn();const result=await androidHandlers(config(),fetcher as typeof fetch).p2p_music_fetch({artist:'Artist',title:'Song',shell_command:'rm -rf /',destination:'/other'});
    expect(result.ok).toBe(false);expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps a caller idempotency key and generates one only when absent',async()=>{
    const bodies:Record<string,unknown>[]=[];const fetcher=vi.fn(async(_url:unknown,options?:RequestInit)=>{bodies.push(JSON.parse(String(options?.body)));expect(options?.redirect).toBe('error');return new Response(JSON.stringify({status:'queued',job:{job_id:'public-job'}}));});
    const handlers=androidHandlers(config(),fetcher as typeof fetch);
    await handlers.p2p_music_fetch({artist:'Artist',title:'Song',request_key:'retry-the-same-intent'});
    await handlers.p2p_music_fetch({artist:'Artist',title:'Song'});
    expect(bodies[0].request_key).toBe('retry-the-same-intent');expect(bodies[1].request_key).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('does not return the pairing token or raw native error text',async()=>{
    const fetcher=vi.fn(async()=>new Response('account password: SECRET',{status:401}));
    const result=await androidHandlers(config(),fetcher as typeof fetch).p2p_setup_status({});
    expect(result).toMatchObject({ok:false,error:{code:'PAIRING_REQUIRED'}});expect(JSON.stringify(result)).not.toMatch(/SECRET|test-token/);
  });
  it('bounds native responses instead of accepting unlimited local payloads',async()=>{
    const bridge=new AndroidBridge({baseUrl:'http://127.0.0.1:5032',accessToken:'x'.repeat(64)},(async()=>new Response('x'.repeat(2_000_001))) as typeof fetch);
    await expect(bridge.call('status')).rejects.toThrow('limit');
  });
  it('gives an actionable local recovery step when the app is stopped',async()=>{
    const result=await androidHandlers(config(),(async()=>{throw new Error('private network detail');}) as typeof fetch).p2p_setup_status({});
    expect(result).toMatchObject({ok:false,error:{code:'ANDROID_BACKEND_UNAVAILABLE',next_action:expect.stringContaining('enable automation')}});
    expect(JSON.stringify(result)).not.toContain('private network detail');
  });
});
