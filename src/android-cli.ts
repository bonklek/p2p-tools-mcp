#!/usr/bin/env node
import { mkdirSync,writeFileSync,existsSync,readFileSync,chmodSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import YAML from 'yaml';
import { androidConfigPath,androidHandlers } from './android/backend.js';

async function hiddenInput():Promise<string>{
  if(!process.stdin.isTTY || !process.stdout.isTTY)throw new Error('Run pairing in a local interactive Termux terminal');
  process.stdout.write('Pairing code from P2P Automation (hidden): ');
  return new Promise((resolve,reject)=>{
    let value='';const done=()=>{process.stdin.off('data',data);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');};
    const data=(buffer:Buffer)=>{for(const c of buffer.toString()){if(c==='\u0003'){done();reject(new Error('Pairing cancelled'));return;}if(c==='\r'||c==='\n'){done();resolve(value);return;}if(c==='\u007f'||c==='\b')value=value.slice(0,-1);else if(/[0-9]/.test(c))value+=c;}};
    process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',data);
  });
}
async function main(){
  const [action,...rest]=process.argv.slice(2);
  if(!action||action==='--help'){console.log('p2p-tools-android <pair|register-hermes|status|shizuku>\nRun pair locally; never supply sensitive command arguments. See docs/android-device-integration.md.');return;}
  if(rest.length)throw new Error('This command accepts no sensitive or positional arguments');
  if(action==='pair'){
    const code=await hiddenInput();if(!/^\d{8}$/.test(code))throw new Error('Pairing code must contain eight digits');
    const response=await fetch('http://127.0.0.1:5032/v1/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code}),signal:AbortSignal.timeout(10000),redirect:'error'});
    if(!response.ok)throw new Error('Pairing rejected; reopen P2P Automation and request a fresh code');
    const result=await response.json() as {accessToken?:string};if(!result.accessToken||result.accessToken.length<32)throw new Error('Invalid pairing response');
    const path=androidConfigPath();mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,JSON.stringify({baseUrl:'http://127.0.0.1:5032',accessToken:result.accessToken}),{mode:0o600});chmodSync(path,0o600);
    console.log('Paired locally. Run p2p-tools-android register-hermes, then reload MCP in Hermes.');return;
  }
  if(action==='register-hermes'){
    const path=join(process.env.HERMES_HOME||join(homedir(),'.hermes'),'config.yaml');mkdirSync(dirname(path),{recursive:true,mode:0o700});
    const text=existsSync(path)?readFileSync(path,'utf8'):'';const doc=YAML.parseDocument(text);if(doc.errors.length)throw new Error('Hermes YAML is invalid; repair it before registration');
    if(text)writeFileSync(path+'.p2p-backup',text,{mode:0o600});
    doc.setIn(['mcp_servers','p2p_android'],{command:process.execPath,args:[fileURLToPath(new URL('./android-mcp.js',import.meta.url))],env:{P2P_ANDROID_CONFIG:androidConfigPath(),...(process.env.P2P_RISH?{P2P_RISH:process.env.P2P_RISH}:{})},timeout:40,connect_timeout:20});
    writeFileSync(path,String(doc),{mode:0o600});console.log('Hermes registration saved; unrelated settings preserved. Use /reload-mcp or restart Hermes.');return;
  }
  const name=action==='status'?'p2p_setup_status':action==='shizuku'?'p2p_android_capabilities':undefined;
  if(!name)throw new Error('Unknown Android command');console.log(JSON.stringify(await androidHandlers()[name]({}),null,2));
}
main().catch(()=>{console.error('Android setup failed. Check the local app, pairing, and integration guide; no sensitive input was printed.');process.exitCode=1;});
