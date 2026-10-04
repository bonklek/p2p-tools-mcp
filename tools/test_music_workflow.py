import contextlib,hashlib,json,subprocess,tempfile,unittest,wave
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch
from music_workflow import Workflow,sha,song_key,session_lock,load_profile
class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.downloads=self.root/'downloads';self.downloads.mkdir()
        self.p={'session_dir':str(self.root/'session'),'downloads_dir':str(self.downloads),'phone':{'serial':'fixture','music_root':'/storage/emulated/0/Music'},'tracks':[{'id':'1','artist':'Artist','title':'Song','album':'Album','duration_ms':1000}],'target_unique_songs':1}
        self.w=Workflow(self.p)
    def test_identity_does_not_collapse_versions_without_policy(self):
        self.assertNotEqual(song_key('Artist','Song (live)'),song_key('Artist','Song'))
        self.assertEqual(song_key('Artist','Song (live)',True),song_key('Artist','Song',True))
    def test_plan_filters_existing_and_repeated_editions_without_network(self):
        self.p['tracks']+=[{'id':'2','artist':'Artist','title':'Song','album':'Another Edition'},{'id':'3','artist':'Other','title':'Exists'}]
        with patch.object(self.w,'inventory',return_value={song_key('Other','Exists')}):result=self.w.plan()
        self.assertEqual(result,{'candidates':1,'excluded_existing_or_duplicate':2,'downloads_started':False})
        self.p['tracks'].append({'id':'4','artist':'New','title':'Changed'})
        with self.assertRaisesRegex(ValueError,'new session_dir'):self.w.plan()
    def test_only_one_worker_can_hold_session_lock(self):
        with session_lock(self.root/'lock'):
            with self.assertRaises(RuntimeError):
                with session_lock(self.root/'lock'):pass
    def test_observed_library_quality_becomes_soft_ranking_preferences(self):
        library=self.root/'library'/'Album';library.mkdir(parents=True);(library/'old.flac').write_bytes(b'fixture')
        self.p['library_roots']=[str(library)]
        class Audio(dict):info=SimpleNamespace(sample_rate=44100,bits_per_sample=16)
        audio=Audio(artist=['Existing Artist'],title=['Existing Song'],album=['Album'])
        with patch('mutagen.File',return_value=audio),patch.object(self.w,'connected',return_value=True),patch.object(self.w,'shell',return_value=subprocess.CompletedProcess([],0,b'',b'')):
            self.w.plan()
        manifest=json.loads(self.w.manifest.read_text(encoding='utf-8'))
        self.assertIn('Prefer format flac; 100% of observed library matches it',manifest['preferences'])
        self.assertEqual(self.w.state['library_distribution']['pc_layouts'],{'album_folder':1})
    def test_library_cannot_contain_incoming_downloads(self):
        profile=self.root/'profile.json';profile.write_text(json.dumps({**self.p,'library_roots':[str(self.root)]}))
        with self.assertRaisesRegex(ValueError,'overlap'):load_profile(profile)
    def test_sd_capacity_does_not_fall_back_to_internal_storage(self):
        self.p['phone']['music_root']='/storage/ABCD-1234/Music/new'
        calls=[]
        def shell(*args):
            calls.append(args)
            if args[-1]=='/storage/ABCD-1234':return subprocess.CompletedProcess(args,0,b'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/fuse 100000 50000 50000 50% /storage/ABCD-1234',b'')
            return subprocess.CompletedProcess(args,1,b'',b'')
        with patch.object(self.w,'shell',side_effect=shell):self.w.phone_capacity(1024)
        self.assertNotIn('/storage/emulated/0',[r[-1] for r in calls])
    def prepare_delivery(self):
        u='1';stage=self.w.root/'staging'/hashlib.sha256(u.encode()).hexdigest()[:16];stage.mkdir(parents=True)
        source=self.downloads/'song.wav'
        with wave.open(str(source),'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(8000);f.writeframes(b'\x00\x00'*8000)
        staged=stage/'song.wav';staged.write_bytes(source.read_bytes());digest=sha(source)
        j={'status':'ready','source':str(source),'source_sha256':digest,'track':self.p['tracks'][0],'key':list(song_key('Artist','Song')),'review':False,'report':{'destination':str(staged),'duration_ms':1000}}
        self.w.state['jobs'][u]=j
        return u,j,source,staged,digest
    def test_hash_failure_preserves_local_files_and_delivery_state(self):
        u,j,source,staged,digest=self.prepare_delivery()
        def shell(*args):
            if args[0]=='test':return subprocess.CompletedProcess(args,1,b'',b'')
            if args[0]=='sha256sum':return subprocess.CompletedProcess(args,0,b'0'*64+b' file',b'')
            return subprocess.CompletedProcess(args,0,b'',b'')
        with patch.object(self.w,'shell',side_effect=shell),patch.object(self.w,'push',return_value=subprocess.CompletedProcess([],0)),patch.object(self.w,'phone_capacity'):
            with self.assertRaisesRegex(RuntimeError,'PHONE_HASH_MISMATCH'):self.w.deliver(u,j,True)
        self.assertTrue(source.exists());self.assertTrue(staged.exists());self.assertEqual(j['status'],'ready')
    def test_verified_receipt_precedes_source_cleanup(self):
        u,j,source,staged,digest=self.prepare_delivery()
        def shell(*args):
            if args[0]=='test':return subprocess.CompletedProcess(args,1,b'',b'')
            if args[0]=='sha256sum':return subprocess.CompletedProcess(args,0,digest.encode()+b' file',b'')
            return subprocess.CompletedProcess(args,0,b'',b'')
        with patch.object(self.w,'shell',side_effect=shell),patch.object(self.w,'push',return_value=subprocess.CompletedProcess([],0)),patch.object(self.w,'phone_capacity'):
            self.w.deliver(u,j,True)
        receipt=json.loads(self.w.state_file.read_text(encoding='utf-8'))['jobs'][u]
        self.assertEqual(receipt['sha256'],digest);self.assertEqual(receipt['status'],'delivered');self.assertFalse(source.exists());self.assertFalse(staged.exists())
    def test_cleanup_recovers_after_receipt_saved_before_crash(self):
        u,j,source,staged,digest=self.prepare_delivery()
        j.update(status='delivered',destination='/storage/emulated/0/Music/song.wav',sha256=digest)
        self.w.save();resumed=Workflow(self.p)
        with patch.object(resumed,'shell',return_value=subprocess.CompletedProcess([],0,digest.encode()+b' file',b'')):
            resumed.cleanup(resumed.state['jobs'][u],True)
        self.assertFalse(source.exists());self.assertFalse(staged.exists())
        self.assertTrue(resumed.state['jobs'][u]['cleanup_complete'])
if __name__=='__main__':unittest.main()
