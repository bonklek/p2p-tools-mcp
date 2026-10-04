"""Portable, resumable Soulseek → enrichment → verified Android delivery."""
import argparse,contextlib,hashlib,json,os,re,shlex,shutil,subprocess,sys,tempfile,threading,time,unicodedata
from pathlib import Path,PurePosixPath

ROOT=Path(__file__).resolve().parent.parent
EXT={'.flac','.mp3','.m4a','.ogg','.opus','.wav','.aac'}
def norm(s):return ' '.join(re.findall(r'\w+',unicodedata.normalize('NFKD',s).casefold()))
def song_key(artist,title,collapse=False):
    if collapse:title=re.sub(r'\([^)]*(?:remaster|live|acoustic|remix|version|edit)[^)]*\)|\s*[-–—]\s*[^-]*(?:remaster|live|acoustic|remix|version|edit).*$','',title,flags=re.I)
    return norm(artist.split(';')[0]),norm(title)
def atomic(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_name(path.name+'.'+str(threading.get_ident())+'.tmp')
    tmp.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8');tmp.replace(path)
def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda:f.read(1048576),b''):h.update(b)
    return h.hexdigest()
def cli(*args):
    p=subprocess.run([os.environ.get('P2P_NODE','node'),str(ROOT/'dist/p2p-tools.js'),*args],capture_output=True,timeout=600)
    try:d=json.loads(p.stdout.decode('utf-8').strip())
    except ValueError:raise RuntimeError('CLI_FAILED: inspect setup status and local logs') from None
    if not d.get('ok'):raise RuntimeError(d.get('error',{}).get('code','SERVICE_ERROR'))
    return d['data']
def load_profile(path):
    p=json.loads(path.read_text(encoding='utf-8'))
    required={'session_dir','downloads_dir','tracks','phone'}
    if not required<=p.keys():raise ValueError('Profile needs session_dir, downloads_dir, tracks and phone')
    for k in ['session_dir','downloads_dir']:
        v=Path(p[k]);p[k]=str((path.parent/v).resolve())
    p['library_roots']=[str((path.parent/Path(r)).resolve()) for r in p.get('library_roots',[])]
    for k in ['inventory_path','approvals_path']:
        if p.get(k):p[k]=str((path.parent/Path(p[k])).resolve())
    for r in p['library_roots']:
        if Path(r)==Path(p['downloads_dir']) or Path(p['downloads_dir']) in Path(r).parents or Path(r) in Path(p['downloads_dir']).parents:raise ValueError('Incoming downloads cannot overlap a baseline library root')
    if not Path(p['downloads_dir']).is_dir():raise ValueError('downloads_dir must exist and match slskd completed downloads')
    for k in ['music_root','review_root']:
        value=p['phone'].get(k)
        if value is None and k=='review_root':continue
        if not value or not value.startswith('/storage/') or '..' in PurePosixPath(value).parts:raise ValueError('Phone roots must be explicit shared-storage directories without ..')
    if not p['phone'].get('serial'):raise ValueError('Choose a phone serial using adb devices -l')
    if not 1<=p.get('phone_max_used_percent',66)<=100:raise ValueError('Invalid phone storage ceiling')
    if p.get('pc_minimum_free_bytes',1073741824)<0:raise ValueError('Invalid PC storage floor')
    if not isinstance(p['tracks'],list) or not p['tracks']:raise ValueError('Supply structured tracks, not just free-text queries')
    ids=set()
    for t in p['tracks']:
        if not all(t.get(k) for k in ['id','artist','title']) or t['id'] in ids:raise ValueError('Track IDs must be unique; each track needs artist and title')
        ids.add(t['id']);t.setdefault('album','');t.setdefault('duration_ms',0)
    p.setdefault('target_unique_songs',len(p['tracks']))
    if not isinstance(p['target_unique_songs'],int) or p['target_unique_songs']<1:raise ValueError('Invalid completion target')
    return p
class Workflow:
    def __init__(self,p):
        self.p=p;self.root=Path(p['session_dir']);self.state_file=self.root/'workflow-state.json';self.mutex=threading.RLock();self.stop=threading.Event()
        self.collapse=p.get('collapse_versions',False)
        self.state=json.loads(self.state_file.read_text(encoding='utf-8')) if self.state_file.exists() else {'baseline':[],'jobs':{},'arrivals':[],'pause_reasons':[]}
        self.downloads=Path(p['downloads_dir']);self.serial=p['phone']['serial'];self.manifest=self.root/'search-manifest.json'
        self.acquire_status={}
    def key(self,t):return song_key(t['artist'],t['title'],self.collapse)
    def adb(self,*args):
        return subprocess.run([os.environ.get('P2P_ADB','adb'),'-s',self.serial,*args],capture_output=True,timeout=300)
    def shell(self,*args):return self.adb('shell',shlex.join(args))
    def connected(self):
        p=self.adb('get-state');return p.returncode==0 and p.stdout.strip()==b'device'
    def inventory(self):
        from mutagen import File
        found=set()
        from collections import Counter
        formats=Counter();rates=Counter();depths=Counter();layouts=Counter()
        for root in self.p.get('library_roots',[]):
            for f in Path(root).rglob('*'):
                if not f.is_file() or f.suffix.lower() not in EXT:continue
                try:
                    a=File(f,easy=True)
                    if a and a.get('artist') and a.get('title'):
                        found.add(song_key(a['artist'][0],a['title'][0],self.collapse));formats[f.suffix.lower().lstrip('.')]+=1
                        if getattr(a.info,'sample_rate',None):rates[a.info.sample_rate]+=1
                        if getattr(a.info,'bits_per_sample',None):depths[a.info.bits_per_sample]+=1
                        if a.get('album') and norm(a['album'][0]) in norm(f.parent.name):layouts['album_folder']+=1
                        else:layouts['other']+=1
                except Exception:continue
        if not self.connected():raise RuntimeError('PHONE_DISCONNECTED: connect and authorize before taking the baseline')
        p=self.shell('content','query','--uri','content://media/external/audio/media','--projection','_data:artist:title')
        if p.returncode:raise RuntimeError('PHONE_INVENTORY_UNAVAILABLE')
        # MediaStore indexes only known audio; snapshots supplied by other apps may be merged.
        roots=self.p['phone'].get('inventory_roots',['/storage/emulated/0/Music',self.p['phone']['music_root']])
        physical=set()
        for root in roots:
            if not root.startswith('/storage/') or '..' in PurePosixPath(root).parts:raise ValueError('Invalid phone inventory root')
            files=self.shell('find',root,'-type','f')
            if files.returncode==0:physical.update(files.stdout.decode('utf-8',errors='replace').splitlines())
        for file in physical:
            ext=PurePosixPath(file).suffix.lower()
            if ext in EXT:formats[ext.lstrip('.')]+=1
        for line in p.stdout.decode('utf-8',errors='replace').splitlines():
            m=re.match(r'Row: \d+ _data=(.*?), artist=(.*?), title=(.*)$',line)
            if m and m[1] in physical and m[2] not in {'NULL','<unknown>',''}:
                found.add(song_key(m[2],m[3],self.collapse))
        external=self.p.get('inventory_path')
        if external:
            for r in json.loads(Path(external).read_text(encoding='utf-8')):found.add(song_key(r['artist'],r['title'],self.collapse))
        self.state['library_distribution']={'formats':dict(formats),'sample_rates':dict(rates),'bit_depths':dict(depths),'pc_layouts':dict(layouts)}
        return found
    def save(self):
        with self.mutex:
            jobs=self.state['jobs'];delivered={tuple(r['key']) for r in jobs.values() if r['status']=='delivered'}
            events=[r for r in self.state['arrivals'] if r['time']>=time.time()-600]
            window=min(600,max(1,time.time()-self.state.get('created_at',time.time())))
            rate=len(events)*60/window
            self.state['summary']={'unique_delivered':len(delivered),'target':self.p['target_unique_songs'],
                'remaining':max(0,self.p['target_unique_songs']-len(delivered)),
                'verified_library':sum(r['status']=='delivered' and not r.get('review') for r in jobs.values()),
                'review_folder':sum(r['status']=='delivered' and r.get('review',False) for r in jobs.values()),
                'jobs':dict(__import__('collections').Counter(r['status'] for r in jobs.values())),
                'arrivals_per_minute_last_10_minutes':round(rate,2),'eta_minutes':round((self.p['target_unique_songs']-len(delivered))/rate,1) if rate and len(delivered)<self.p['target_unique_songs'] else None,
                'pc_free_bytes':shutil.disk_usage(self.downloads).free,'pause_reasons':self.state.get('pause_reasons',[]),'acquisition':self.acquire_status,'updated_at':time.time()}
            self.state['summary']['library_distribution']=self.state.get('library_distribution',{})
            atomic(self.state_file,self.state)
    def plan(self):
        signature=hashlib.sha256(json.dumps({'tracks':self.p['tracks'],'downloads_dir':self.p['downloads_dir'],'serial':self.serial,'collapse_versions':self.collapse},sort_keys=True).encode()).hexdigest()
        if self.manifest.exists():
            if self.state.get('profile_signature')!=signature:raise ValueError('Use a new session_dir when changing candidates, source directory, phone serial or identity policy')
            return self.state.get('summary',{})
        baseline=self.inventory();self.state['baseline']=list(baseline);seen=set(baseline);tracks=[];skipped=[]
        for t in self.p['tracks']:
            k=self.key(t)
            if k in seen:skipped.append(t['id']);continue
            seen.add(k);tracks.append({**t,'query':t.get('query') or t['artist'].split(';')[0]+' '+t['title']})
        if not tracks:raise ValueError('All candidates already exist or duplicate other candidates')
        manifest={'version':1,'tracks':tracks,'filters':{'file_types':['audio'],'extensions':self.p.get('extensions',['flac','mp3']),'public_only':True},
            'jev_call_budget':self.p.get('jev_call_budget',len(tracks)),'auto_select_jev':self.p.get('auto_select_jev',False)}
        if self.p.get('preferences'):manifest['preferences']=self.p['preferences']
        else:
            distribution=self.state.get('library_distribution',{});preferences=[]
            for field,label in [('formats','format'),('sample_rates','sample rate Hz'),('bit_depths','bit depth')]:
                values=distribution.get(field,{})
                if values:
                    value=max(values,key=values.get);share=round(values[value]*100/sum(values.values()))
                    preferences.append(f'Prefer {label} {value}; {share}% of observed library matches it')
            preferences+=['Prefer coherent album metadata and proven track order','Prefer smaller files when recording identity and quality are equivalent']
            manifest['preferences']=preferences
        self.state['profile_signature']=signature;self.state['excluded_candidate_ids']=skipped;self.state['created_at']=time.time();self.save();atomic(self.manifest,manifest)
        return {'candidates':len(tracks),'excluded_existing_or_duplicate':len(skipped),'downloads_started':False}
    def transfers(self):
        all=[];offset=0
        while True:
            page=cli('slskd','transfers','--limit','1000','--offset',str(offset));all.extend(page['transfers'])
            if not page['truncated']:return all
            offset+=1000
    def acquire(self,download):
        while not self.stop.wait(2):
            if (self.root/'paused').exists():continue
            if self.state.get('summary',{}).get('unique_delivered',0)>=self.p['target_unique_songs']:return
            try:
                status=cli('setup','status')
                if status['status']!='ready':
                    self.acquire_status={'pause_reason':'setup_required','setup':status};self.stop.wait(15);continue
                transfers=self.transfers()
                outstanding=sum(max(0,int(t.get('size',0))-int(t.get('bytesTransferred',0))) for t in transfers if not str(t.get('state','')).startswith('Completed'))
                free=shutil.disk_usage(self.downloads).free
                budget=max(0,free-self.p.get('pc_minimum_free_bytes',1073741824)-self.p.get('pc_headroom_bytes',1073741824)-outstanding)
                if download and not budget:self.acquire_status={'pause_reason':'pc_storage_budget'};self.stop.wait(10);continue
                args=['slskd','bulk','--manifest',str(self.manifest),'--max-items','10']
                if download:args+=['--download','--download-budget-bytes',str(budget)]
                if self.p.get('approvals_path'):args+=['--approvals',self.p['approvals_path']]
                result=cli(*args)
                self.acquire_status={'state':'running','search':result}
            except Exception as e:
                self.acquire_status={'pause_reason':str(e).split(':')[0]};self.stop.wait(15)
    def discover(self):
        state_path=Path(str(self.manifest)+'.state.json')
        if not state_path.exists():return
        search=json.loads(state_path.read_text(encoding='utf-8'));tracks={t['id']:t for t in json.loads(self.manifest.read_text(encoding='utf-8'))['tracks']}
        completed=[t for t in self.transfers() if t.get('state')=='Completed, Succeeded']
        paths_by_file={}
        for path in self.downloads.rglob('*'):
            if path.is_file() and path.suffix.lower() in EXT and '_incomplete' not in path.parts:
                paths_by_file.setdefault((path.name,path.stat().st_size),[]).append(path)
        for u,item in search['items'].items():
            if item['status']!='queued' or u in self.state['jobs']:continue
            matches=[t for t in completed if t.get('batchId')==item.get('batch_id')]
            if len(matches)!=1:continue
            match=matches[0];paths=paths_by_file.get((match['title'],match['size']),[])
            if len(paths)!=1:continue
            self.state['jobs'][u]={'status':'new','track':tracks[u],'source':str(paths[0].resolve()),'key':list(self.key(tracks[u])),'attempts':0}
        self.save()
    def phone_capacity(self,bytes_,root=None):
        root=root or self.p['phone']['music_root'];p=self.shell('df','-k',root)
        # A new destination may not exist yet; inspect its shared-storage mount.
        while p.returncode and len(PurePosixPath(root).parts)>3:
            root=str(PurePosixPath(root).parent);p=self.shell('df','-k',root)
        if p.returncode:raise RuntimeError('PHONE_STORAGE_UNAVAILABLE')
        lines=p.stdout.decode(errors='replace').splitlines()
        fields=next((r.split() for r in lines if r.startswith('/')),None)
        if not fields:raise RuntimeError('PHONE_STORAGE_UNAVAILABLE')
        total,used=int(fields[1])*1024,int(fields[2])*1024
        limit=total*self.p.get('phone_max_used_percent',66)//100
        if used+((bytes_+4095)//4096)*4096>limit:raise RuntimeError('PHONE_STORAGE_CAP')
        self.state['phone_storage']={'total_bytes':total,'used_bytes':used,'max_used_percent':self.p.get('phone_max_used_percent',66)}
    def push(self,source,destination):
        if os.name=='nt' and (len(str(source))>=240 or not str(source).isascii()):
            with tempfile.TemporaryDirectory(prefix='p2p-adb-') as folder:
                link=Path(folder)/('audio'+source.suffix);os.link(source,link);return self.adb('push',str(link),destination)
        return self.adb('push',str(source),destination)
    def deliver(self,u,j,delete_sources):
        import enrich_music
        from mutagen import File
        source=Path(j['source']);source.resolve().relative_to(self.downloads.resolve())
        k=tuple(j['key'])
        if k in {tuple(r['key']) for id_,r in self.state['jobs'].items() if id_!=u and r['status']=='delivered'}:
            j['status']='duplicate';return
        stage_root=self.root/'staging'/hashlib.sha256(u.encode()).hexdigest()[:16]
        if j['status']=='new':
            size=source.stat().st_size
            free=min(shutil.disk_usage(self.downloads).free,shutil.disk_usage(self.root).free)
            if free-size < self.p.get('pc_minimum_free_bytes',1073741824)+self.p.get('pc_headroom_bytes',1073741824):raise RuntimeError('PC_STAGING_BUDGET')
            before=sha(source)
            t=j['track'];report=enrich_music.stage({**t,'path':str(source)},stage_root,True,self.p.get('allow_embedded_review',False))
            if sha(source)!=before:raise RuntimeError('SOURCE_CHANGED_DURING_ENRICHMENT')
            j['source_sha256']=before;j['report']=report
            if report['status']=='musicbrainz_error':raise RuntimeError('METADATA_SERVICE_UNAVAILABLE')
            if report['status'] not in {'staged','staged_embedded_only'}:j['status']='held';j['reason']=report['status'];return
            j['status']='ready';j['review']=report['status']=='staged_embedded_only';self.save()
        staged=Path(j['report']['destination']);staged.resolve().relative_to(stage_root.resolve())
        # Check actual staged duration, not the target's duration after enrichment.
        actual=round(File(staged,easy=True).info.length*1000)
        if abs(actual-int(j['report']['duration_ms']))>100:raise RuntimeError('STAGED_DURATION_CHANGED')
        digest=sha(staged);relative=staged.relative_to(stage_root).as_posix()
        if j['review']:
            if not self.p['phone'].get('review_root'):j['status']='held';j['reason']='review_destination_required';return
            destination=self.p['phone']['review_root'].rstrip('/')+'/'+hashlib.sha256(u.encode()).hexdigest()[:10]+'-'+staged.name
        else:
            artist=enrich_music.safe(j['track']['artist'].split(';')[0]);destination=self.p['phone']['music_root'].rstrip('/')+'/'+artist+'/'+relative
        if self.shell('test','-e',destination).returncode==0:
            existing=self.shell('sha256sum','--',destination)
            if existing.returncode or existing.stdout.split()[0].decode()!=digest:j['status']='held';j['reason']='destination_collision';return
        else:
            self.phone_capacity(staged.stat().st_size,str(PurePosixPath(destination).parent))
            if self.shell('mkdir','-p',str(PurePosixPath(destination).parent)).returncode:raise RuntimeError('PHONE_FOLDER_UNAVAILABLE')
            partial=destination+'.p2p-partial'
            if self.push(staged,partial).returncode:raise RuntimeError('PHONE_COPY_FAILED')
            result=self.shell('sha256sum','--',partial)
            if result.returncode or result.stdout.split()[0].decode()!=digest:raise RuntimeError('PHONE_HASH_MISMATCH')
            # Refuse replacement if another process created a final file meanwhile.
            if self.shell('test','-e',destination).returncode==0:raise RuntimeError('DESTINATION_CHANGED')
            if self.shell('mv','-n','--',partial,destination).returncode:raise RuntimeError('PHONE_FINALIZE_FAILED')
        final=self.shell('sha256sum','--',destination)
        if final.returncode or final.stdout.split()[0].decode()!=digest:raise RuntimeError('PHONE_FINAL_HASH_MISMATCH')
        if not j['review']:
            self.shell('am','broadcast','-a','android.intent.action.MEDIA_SCANNER_SCAN_FILE','-d','file://'+destination)
        j.update(status='delivered',destination=destination,sha256=digest,delivered_at=time.time())
        self.state['arrivals'].append({'time':time.time(),'key':j['key']});self.save()
        # The fresh receipt is durable before any local cleanup.
        self.cleanup(j,delete_sources)
    def cleanup(self,j,delete_sources):
        source=Path(j['source']);source.resolve().relative_to(self.downloads.resolve())
        staged=Path(j['report']['destination']);staged.resolve().relative_to((self.root/'staging').resolve())
        final=self.shell('sha256sum','--',j['destination'])
        if final.returncode or not final.stdout.split() or final.stdout.split()[0].decode()!=j['sha256']:raise RuntimeError('CLEANUP_PHONE_HASH_MISMATCH')
        digest=j['sha256']
        if delete_sources and source.exists() and sha(source)==j['source_sha256']:
            identical=sha(source)==digest
            if not identical and source.suffix.lower()=='.flac' and staged.exists():
                from mutagen.flac import FLAC
                stream=FLAC(source).info.md5_signature;identical=bool(stream) and stream==FLAC(staged).info.md5_signature
            if identical:source.unlink();j['source_deleted']=True
        if staged.exists() and sha(staged)==digest:staged.unlink()
        j['cleanup_complete']=True;self.save()
    def run(self,download,delete_sources):
        if download and not self.p.get('downloads_enabled',False):raise ValueError('Batch is held: set downloads_enabled only after user authorizes release')
        if delete_sources and not self.p.get('delete_sources_after_delivery',False):raise ValueError('Source deletion requires profile permission and --delete-sources')
        self.plan();(self.root/'paused').unlink(missing_ok=True)
        worker=threading.Thread(target=self.acquire,args=(download,),daemon=True);worker.start()
        try:
            while True:
                if (self.root/'paused').exists():self.stop.set();self.save();return
                if not self.connected():self.state['pause_reasons']=['phone_disconnected'];self.save();time.sleep(10);continue
                self.state['pause_reasons']=[]
                try:self.discover()
                except Exception as e:self.state['pause_reasons']=[str(e).split(':')[0]]
                for u,j in list(self.state['jobs'].items()):
                    if not self.connected():break
                    if j['status']=='delivered' and not j.get('cleanup_complete'):
                        try:self.cleanup(j,delete_sources)
                        except Exception:j['cleanup_reason']='Cleanup deferred: phone verification or local file access failed'
                        continue
                    if j['status'] not in {'new','ready'} or j.get('retry_at',0)>time.time():continue
                    try:self.deliver(u,j,delete_sources)
                    except Exception as e:
                        j['attempts']+=1;j['reason']=str(e).split(':')[0];j['retry_at']=time.time()+min(300,30*j['attempts'])
                        # Corruption and identity conflicts are held rather than retried forever.
                        if j['reason'] in {'STAGED_DURATION_CHANGED','SOURCE_CHANGED_DURING_ENRICHMENT'}:j['status']='held'
                    self.save()
                    if (self.root/'paused').exists():break
                self.save();time.sleep(5)
        finally:self.stop.set()

@contextlib.contextmanager
def session_lock(root):
    root.mkdir(parents=True,exist_ok=True)
    f=(root/'worker.lock').open('a+b')
    if f.tell()==0:f.write(b'0');f.flush()
    f.seek(0)
    try:
        if os.name=='nt':
            import msvcrt;msvcrt.locking(f.fileno(),msvcrt.LK_NBLCK,1)
        else:
            import fcntl;fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except OSError:f.close();raise RuntimeError('WORKFLOW_ALREADY_RUNNING') from None
    try:yield
    finally:f.close()
def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=['plan','start','run','status','pause']);parser.add_argument('--profile',type=Path,required=True);parser.add_argument('--download',action='store_true');parser.add_argument('--delete-sources',action='store_true');args=parser.parse_args()
    profile_path=args.profile.resolve();p=load_profile(profile_path);w=Workflow(p)
    if args.action=='status':print(json.dumps(w.state.get('summary',{'status':'not_planned'})));return
    if args.action=='pause':w.root.mkdir(parents=True,exist_ok=True);(w.root/'paused').touch();print(json.dumps({'paused':True}));return
    try:import mutagen
    except ImportError:print(json.dumps({'status':'prerequisite_missing','next_action':'Install tools/requirements-music.txt in your chosen Python environment; set P2P_PYTHON.'}));return
    if not shutil.which(os.environ.get('P2P_ADB','adb')):print(json.dumps({'status':'prerequisite_missing','next_action':'Install Android platform-tools, connect the phone and accept USB debugging; choose its serial.'}));return
    if args.action=='start':
        if args.download and not p.get('downloads_enabled',False):raise ValueError('Batch is held; downloads_enabled is false')
        if args.delete_sources and not p.get('delete_sources_after_delivery',False):raise ValueError('Profile does not authorize source deletion')
        w.root.mkdir(parents=True,exist_ok=True)
        with session_lock(w.root):pass # Reject a second start before launching another child.
        with (w.root/'worker.log').open('ab') as log:
            cmd=[sys.executable,'-u',str(Path(__file__).resolve()),'run','--profile',str(profile_path),*(['--download'] if args.download else []),*(['--delete-sources'] if args.delete_sources else [])]
            proc=subprocess.Popen(cmd,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0,start_new_session=os.name!='nt')
        print(json.dumps({'status':'starting','pid':proc.pid,'next_action':'Read music status and the local worker.log to confirm progress; setup may require user input.'}));return
    with session_lock(w.root):
        if args.action=='plan':print(json.dumps(w.plan()))
        else:w.run(args.download,args.delete_sources)
if __name__=='__main__':
    try:main()
    except (KeyboardInterrupt,SystemExit):raise
    except Exception as e:
        print(json.dumps({'status':'blocked','reason':type(e).__name__,'next_action':str(e) if isinstance(e,(ValueError,RuntimeError)) else 'Inspect local files and setup status; no credentials were printed.'}));sys.exit(1)
