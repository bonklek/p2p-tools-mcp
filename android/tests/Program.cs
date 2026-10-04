using Seeker.Automation;
using System.Text.Json;
void Assert(bool value,string message){if(!value)throw new Exception(message);}
var song=new SongRequest{artist="Artist",title="Song",duration_ms=180000};
Assert(AutomationPolicy.Plausible(new Candidate{Filename=@"share\album\01 - Song.flac",Length=181},song),"Exact title/duration should be plausible");
Assert(!AutomationPolicy.Plausible(new Candidate{Filename="Song (Live).flac",Length=180},song),"Live version must remain distinct");
Assert(!AutomationPolicy.Plausible(new Candidate{Filename="Song.flac",Length=240},song),"Wrong duration must fail");
Assert(!AutomationPolicy.Plausible(new Candidate{Filename="Song.exe",Length=180},song),"Non-audio candidate must fail");
Assert(AutomationPolicy.Key(song)!=AutomationPolicy.Key(new SongRequest{artist="Artist",title="Song (Remastered)"}),"Version qualifier lost");
Assert(AutomationPolicy.Safe("../bad/name").Contains('/')==false,"Unsafe path component");
var job=new NativeJob{Request=song,DownloadComplete=true,State="enriching",Candidate=new Candidate{Username="PRIVATE_ACCOUNT",Filename="PRIVATE_PATH"}};
var recovered=JsonSerializer.Deserialize<NativeJob>(JsonSerializer.Serialize(job));
Assert(recovered.DownloadComplete,"Restart must retain completed-download phase after tagging");
Assert(!JsonSerializer.Serialize(job.Public()).Contains("PRIVATE_"),"Public job leaks private peer/path");
Assert(!AutomationPolicy.Active(new NativeJob{State="held"}),"Held jobs must allow a reviewed replacement");
const long GiB=1073741824;
AutomationPolicy.CheckBudget(100*GiB,40*GiB,40*GiB,2*GiB,GiB);
void Refused(Action action,string code){try{action();throw new Exception("Budget admitted unsafe reservation");}catch(InvalidOperationException e){Assert(e.Message==code,"Wrong budget refusal");}}
Refused(()=>AutomationPolicy.CheckBudget(100*GiB,40*GiB,40*GiB,6*GiB,GiB),"DESTINATION_STORAGE_CAP");
Refused(()=>AutomationPolicy.CheckBudget(100*GiB,90*GiB,2*GiB,GiB,GiB),"INCOMING_STORAGE_BUDGET");
Console.WriteLine("12 native policy/recovery/budget checks passed");
