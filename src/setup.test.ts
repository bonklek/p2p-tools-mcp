import { afterEach,describe,expect,it } from 'vitest';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfigFromEnv,loadConfigFromString } from './shared/config.js';
import { setupStatus,readCredentials } from './setup.js';
import { structuredResult } from './shared/tool-result.js';
const dirs:string[]=[];
afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
describe('private setup',()=>{
  it('returns an actionable local input path when an integration is disabled',async()=>{
    const response=await structuredResult(()=>setupStatus(loadConfigFromString(''),{}),()=> 'setup failed');
    expect(response.ok).toBe(true);
    const result=response.ok ? response.data : {};
    expect(result).toMatchObject({status:'needs_user_input',user_input:{local_entry:'p2p-tools setup credentials',input_method:'local_terminal'}});
    expect(JSON.stringify(result)).toContain('never');
    expect(JSON.stringify(result)).toContain('Run p2p-tools setup credentials in a local terminal');
  });
  it('distinguishes API authentication from missing Soulseek login',async()=>{
    const config=loadConfigFromString('integrations:\n  slskd:\n    enabled: true\n    apiKey: do-not-print-this\n');
    const result=await setupStatus(config,{slskd_test:async()=>({ok:true,data:{reachable:true}}),slskd_server:async()=>({ok:true,data:{isLoggedIn:false}})});
    expect(result).toMatchObject({status:'needs_account_login',api_authenticated:true});
    expect(result.user_input?.agent_message).toContain('Enter your account login');
    expect(JSON.stringify(result)).not.toContain('do-not-print-this');
  });
  it('loads locally entered API credentials with environment precedence',()=>{
    const dir=mkdtempSync(join(tmpdir(),'p2p-credentials-'));dirs.push(dir);const path=join(dir,'credentials.json');
    writeFileSync(path,JSON.stringify({SLSKD_API_KEY:'from-private-file',SLSKD_BASE_URL:'http://127.0.0.1:5030'}));
    const config=loadConfigFromEnv({P2P_TOOLS_CREDENTIALS:path,SLSKD_API_KEY:'environment-wins'});
    expect(config.integrations).toMatchObject({slskd:{apiKey:'environment-wins',enabled:true}});
    writeFileSync(path,'{"password":"never-echo-this"}');
    expect(()=>readCredentials({P2P_TOOLS_CREDENTIALS:path})).toThrow('Credential file is invalid');
  });
});
