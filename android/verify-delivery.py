"""Check built transfer artifacts without claiming live Android acceptance."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import subprocess
import tarfile
import zipfile

parser=argparse.ArgumentParser()
parser.add_argument('--android-sdk',required=True)
parser.add_argument('--java-sdk',required=True)
args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
out=root/'artifacts/android'
name='p2p-android-0.3.0-alpha.1'
sha=lambda value:hashlib.sha256(value).hexdigest()
for line in (out/'SHA256SUMS').read_text().splitlines():
    digest,filename=line.split('  ',1)
    assert sha((out/filename).read_bytes())==digest,filename
with tarfile.open(out/f'{name}-termux.tar.gz') as archive:
    members={item.name:item for item in archive.getmembers()}
    for path in members:
        assert not path.startswith('/') and '..' not in Path(path).parts,path
        assert not path.endswith(('.node','.exe','.dll')),f'Nonportable dependency: {path}'
        assert Path(path).name not in {'android.json','credentials.json','.env'},path
    manifest=archive.extractfile(f'{name}/TERMUX-SHA256SUMS').read().decode()
    for line in manifest.splitlines():
        digest,filename=line.split('  ',1)
        assert sha(archive.extractfile(f'{name}/{filename}').read())==digest,filename
    assert members[f'{name}/install-termux.sh'].mode==0o700
with zipfile.ZipFile(out/f'{name}-native-source.zip') as source:
    assert source.testzip() is None
    assert 'SeekerAndroid/LICENSE' in source.namelist()
    for file in (root/'android/native').glob('*.cs'):
        assert source.read('SeekerAndroid/Seeker/Automation/'+file.name)==file.read_bytes(),f'Native source mismatch: {file.name}'
        assert (root/'android/upstream/SeekerAndroid/Seeker/Automation'/file.name).read_bytes()==file.read_bytes()
apk=out/f'{name}-arm64.apk'
with zipfile.ZipFile(apk) as package:
    assert package.testzip() is None
    abis={file.split('/')[1] for file in package.namelist() if file.startswith('lib/') and file.endswith('.so')}
    assert abis=={'arm64-v8a'},abis
tools=Path(args.android_sdk)/'build-tools/36.0.0'
badging=subprocess.check_output([str(tools/'aapt.exe'),'dump','badging',str(apk)],text=True)
assert "name='com.bonklek.p2p.android'" in badging
assert "versionName='0.3.0-alpha.1'" in badging
assert "sdkVersion:'30'" in badging
env={**os.environ,'JAVA_HOME':args.java_sdk}
signature=subprocess.check_output([str(tools/'apksigner.bat'),'verify','--verbose','--print-certs',str(apk)],env=env,text=True)
assert 'Verifies' in signature
(out/'apk-signature.txt').write_text(signature,encoding='utf-8')
(out/'apk-manifest.txt').write_text(badging,encoding='utf-8')
certificate=re.search(r'certificate SHA-256 digest: (\w+)',signature).group(1)
result={'version':'0.3.0-alpha.1','application_id':'com.bonklek.p2p.android','minimum_android_api':30,'abi':'arm64-v8a','bridge_protocol':1,
        'signature':'Android debug certificate, verified v3 private integration APK','certificate_sha256':certificate,
        'delivery_hashes':'passed','termux_internal_hashes':'passed','portable_dependencies':'passed','native_corresponding_source':'passed',
        'build_test_record':'BUILD-VALIDATION.md; test outcomes are recorded separately from archive inspection',
        'device_installation':'pending','live_soulseek_transfer':'pending','musicolet_playback':'pending','screen_off_and_restart_acceptance':'pending'}
(out/'validation.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
print(json.dumps(result,indent=2))
