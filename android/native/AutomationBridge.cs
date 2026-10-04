// GPL-3.0-only with Seeker's upstream additional terms.
using Android.Content;
using Android.OS;
using Seeker.Services;
using Soulseek;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using IoFile=System.IO.File;
using Directory=System.IO.Directory;
using OperationCanceledException=System.OperationCanceledException;

namespace Seeker.Automation;

public static class AutomationBridge
{
    static readonly object sync=new();
    static readonly JsonSerializerOptions json=new(){PropertyNameCaseInsensitive=false};
    static Context context;
    static TcpListener listener;
    static CancellationTokenSource lifetime;
    static string pairing="";static DateTime pairExpires;static int pairingAttempts;
    static readonly Dictionary<string,Candidate> candidates=new();
    static List<NativeJob> jobs=new();
    static readonly ConcurrentDictionary<string,CancellationTokenSource> running=new();
    static readonly SemaphoreSlim requests=new(16,16);
    static string Store=>Path.Combine(context.FilesDir.AbsolutePath,"p2p-jobs.json");
    static string Incoming=>Path.Combine(context.FilesDir.AbsolutePath,"p2p-incoming");
    public static string NewPairCode(Context ctx)
    {
        lock(sync){context=ctx.ApplicationContext;pairing=RandomNumberGenerator.GetInt32(100000000).ToString("D8");pairExpires=DateTime.UtcNow.AddMinutes(2);pairingAttempts=0;return pairing;}
    }
    public static void Revoke(Context ctx){lock(sync){ctx.GetSharedPreferences("p2p_automation",FileCreationMode.Private).Edit().Remove("access_hash").Commit();pairing="";}}
    public static void Start(Context ctx)
    {
        lock(sync)
        {
            if(listener!=null)return;context=ctx.ApplicationContext;Directory.CreateDirectory(Incoming);
            if(IoFile.Exists(Store))jobs=JsonSerializer.Deserialize<List<NativeJob>>(IoFile.ReadAllText(Store),json)??new();
            foreach(var job in jobs.Where(j=>j.State is "downloading" or "verifying" or "enriching"))job.State="queued";
            listener=new TcpListener(IPAddress.Loopback,5032);listener.Start();lifetime=new();Save();
        }
        var source=lifetime;var socket=listener;_=Task.Run(()=>Listen(socket,source.Token));_=Task.Run(()=>Work(source.Token));
    }
    public static void Stop()
    {
        lock(sync){lifetime?.Cancel();listener?.Stop();listener=null;foreach(var job in running.Values)job.Cancel();if(context!=null)Save();}
    }
    static void Save(){lock(sync){string temp=Store+".tmp";IoFile.WriteAllText(temp,JsonSerializer.Serialize(jobs,json));using(var f=new FileStream(temp,FileMode.Open,FileAccess.ReadWrite)){f.Flush(true);}IoFile.Move(temp,Store,true);}}
    static bool LoggedIn=>SeekerState.SoulseekClient?.State.HasFlag(SoulseekClientStates.LoggedIn)==true;
    static object Setup()
    {
        if(!LoggedIn)return new {status="needs_account_login",user_message="Open the P2P music client and enter your Soulseek account login locally. Keep sensitive input out of chat.",local_entry="Open music client from P2P Automation"};
        string audio=Build.VERSION.SdkInt>=BuildVersionCodes.Tiramisu ? Android.Manifest.Permission.ReadMediaAudio : Android.Manifest.Permission.ReadExternalStorage;
        if(context.CheckSelfPermission(audio)!=Android.Content.PM.Permission.Granted)return new {status="needs_library_permission",user_message="Enable audio-library access in P2P Automation or Android app permissions.",local_entry="P2P Automation: Enable automation"};
        try{return new {status="ready",soulseek_logged_in=true,storage=AutomationStorage.Status(context)};}
        catch{return new {status="needs_storage_permission",user_message="Open P2P Automation, choose a writable music folder, and grant audio-library access in Android settings.",local_entry="Open P2P Automation destination settings"};}
    }
    static async Task Listen(TcpListener socket,CancellationToken token)
    {
        while(!token.IsCancellationRequested)
        {
            try{var client=await socket.AcceptTcpClientAsync(token);_=Task.Run(()=>Serve(client));}
            catch when(token.IsCancellationRequested){return;}
            catch{await Task.Delay(1000);}
        }
    }
    static async Task Serve(TcpClient client)
    {
        if(!await requests.WaitAsync(0)){client.Close();return;}
        using(client)try
        {
            using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(35));var stream=client.GetStream();var header=new List<byte>();byte[] one=new byte[1];
            while(header.Count<16384)
            {
                if(await stream.ReadAsync(one,timeout.Token)!=1)throw new IOException();header.Add(one[0]);
                if(header.Count>=4&&header[^4]==13&&header[^3]==10&&header[^2]==13&&header[^1]==10)break;
            }
            string text=Encoding.ASCII.GetString(header.ToArray());if(!text.EndsWith("\r\n\r\n"))throw new IOException();
            var lines=text.Split("\r\n",StringSplitOptions.RemoveEmptyEntries);var first=lines[0].Split(' ');
            if(first.Length!=3||first[0]!="POST"||!first[1].StartsWith("/v1/",StringComparison.Ordinal)){await Reply(stream,404,new {error="UNKNOWN_OPERATION"});return;}
            var headers=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
            foreach(string line in lines.Skip(1)){int pos=line.IndexOf(':');if(pos<1)throw new IOException();if(!headers.TryAdd(line[..pos].Trim(),line[(pos+1)..].Trim()))throw new IOException();}
            if(headers.ContainsKey("Transfer-Encoding")||!headers.TryGetValue("Content-Length",out var value)||!int.TryParse(value,out int length)||length<2||length>65536){await Reply(stream,400,new {error="INVALID_REQUEST"});return;}
            string operation=first[1][4..];
            if(operation!="pair"&&!Authorized(headers)){await Reply(stream,401,new {error="PAIRING_REQUIRED"});return;}
            byte[] body=new byte[length];await stream.ReadExactlyAsync(body,timeout.Token);using var request=JsonDocument.Parse(body);
            if(request.RootElement.ValueKind!=JsonValueKind.Object)throw new InvalidOperationException("INVALID_REQUEST");
            var result=await Dispatch(operation,request.RootElement);await Reply(stream,200,result);
        }
        catch(InvalidOperationException e){try{await Reply(client.GetStream(),409,new {error=System.Text.RegularExpressions.Regex.IsMatch(e.Message,@"^[A-Z_]+$")?e.Message:"OPERATION_REQUIRES_REVIEW",next_action="Inspect setup or the native job state; no account data was returned."});}catch{}}
        catch{try{await Reply(client.GetStream(),503,new {error="OPERATION_UNAVAILABLE",next_action="Inspect the phone application and retry status before submitting another job."});}catch{}}
        finally{requests.Release();}
    }
    static bool Authorized(Dictionary<string,string> headers)
    {
        if(!headers.TryGetValue("Authorization",out string auth)||!auth.StartsWith("Bearer ",StringComparison.Ordinal))return false;
        string stored=context.GetSharedPreferences("p2p_automation",FileCreationMode.Private).GetString("access_hash","");if(stored.Length==0)return false;
        try{return CryptographicOperations.FixedTimeEquals(Convert.FromHexString(stored),SHA256.HashData(Encoding.UTF8.GetBytes(auth[7..])));}catch{return false;}
    }
    static Task Reply(Stream stream,int status,object value)
    {
        byte[] body=JsonSerializer.SerializeToUtf8Bytes(value,json);byte[] head=Encoding.ASCII.GetBytes($"HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {body.Length}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n");return Write();
        async Task Write(){await stream.WriteAsync(head);await stream.WriteAsync(body);await stream.FlushAsync();}
    }
    static SongRequest Song(JsonElement input){var song=JsonSerializer.Deserialize<SongRequest>(input.GetRawText(),json)??throw new InvalidOperationException("INVALID_REQUEST");song.Validate();return song;}
    static async Task<object> Dispatch(string operation,JsonElement input)
    {
        if(operation=="pair")
        {
            lock(sync)
            {
                string code=input.TryGetProperty("code",out var c)?c.GetString()??"":"";
                if(++pairingAttempts>5||pairing.Length==0||DateTime.UtcNow>pairExpires||!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(code),Encoding.UTF8.GetBytes(pairing)))throw new InvalidOperationException("PAIRING_DENIED");
                string token=Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();context.GetSharedPreferences("p2p_automation",FileCreationMode.Private).Edit().PutString("access_hash",Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)))).Commit();pairing="";return new {accessToken=token,protocol=1};
            }
        }
        if(operation=="capabilities")return new {protocol=1,backend="SeekerAndroid",abi="arm64-v8a",publication="verified MediaStore or selected SAF tree",shizuku_required_for_download=false};
        if(operation=="setup")return Setup();
        if(operation=="sharing")return new {indexed_files=SharedFileService.SharedFileCache?.PresentableNameToFullFileInfo.Count??0,sharing_configured=SharedFileService.IsSharingSetUpSuccessfully(),incoming_reachability_verified=false};
        if(operation=="library"){var song=Song(input);return new {matches=AutomationStorage.Find(context,song)};}
        if(operation=="status")
        {
            string id=input.TryGetProperty("job_id",out var identifier)?identifier.GetString():null;
            lock(sync){var selected=jobs.Where(j=>id==null||j.Id==id).OrderByDescending(j=>j.Updated).Take(100).ToArray();int arrivals=jobs.Count(j=>j.Published>=DateTime.UtcNow.AddMinutes(-10));return new {jobs=selected.Select(j=>j.Public()).ToArray(),total_jobs=jobs.Count,unique_published=jobs.Where(j=>j.State=="published").Select(j=>AutomationPolicy.Key(j.Request)).Distinct().Count(),published_per_minute_last_10_minutes=arrivals/10.0,publication_is_player_playback_verified=false,worker_running=listener!=null};}
        }
        if(operation=="cancel")
        {
            string id=input.GetProperty("job_id").GetString();lock(sync){var job=jobs.SingleOrDefault(j=>j.Id==id)??throw new InvalidOperationException("JOB_NOT_FOUND");if(job.State=="publishing")throw new InvalidOperationException("PUBLICATION_IN_PROGRESS");if(job.State=="published")throw new InvalidOperationException("PUBLISHED_LIBRARY_IS_PRESERVED");job.State="cancelled";job.Updated=DateTime.UtcNow;if(running.TryGetValue(id,out var cancellation))cancellation.Cancel();Save();return job.Public();}
        }
        if(operation is "search" or "fetch" or "queue")
        {
            var song=Song(input);if(!LoggedIn)return Setup();
            if(operation!="search")
            {
                var existing=AutomationStorage.Find(context,song);if(existing.Length>0)return new {status="already_available",matches=existing};
                lock(sync){var keyed=jobs.FirstOrDefault(j=>song.request_key.Length>0 && j.Request.request_key==song.request_key);if(keyed!=null && (AutomationPolicy.Key(keyed.Request)!=AutomationPolicy.Key(song)||keyed.Request.album!=song.album||keyed.Request.duration_ms!=song.duration_ms))throw new InvalidOperationException("REQUEST_KEY_CONFLICT");var active=jobs.FirstOrDefault(j=>AutomationPolicy.Active(j)&&AutomationPolicy.Key(j.Request)==AutomationPolicy.Key(song));if(active!=null)return new {status="existing_job",job=active.Public()};}
            }
            if(operation=="queue")return Queue(song);
            var found=await Search(song);
            if(operation=="search")return new {candidates=found.Select(c=>c.Public()).ToArray(),total=found.Count};
            var plausible=found.Where(c=>AutomationPolicy.Plausible(c,song)).OrderByDescending(c=>c.FreeSlot).ThenBy(c=>c.QueueLength).ThenBy(c=>c.Size).ToList();
            if(plausible.Count==0)return new {status="needs_candidate_review",candidates=found.Take(20).Select(c=>c.Public()).ToArray()};
            song.candidate_id=plausible[0].Id;return Queue(song);
        }
        throw new InvalidOperationException("UNKNOWN_OPERATION");
    }
    static async Task<List<Candidate>> Search(SongRequest song)
    {
        var found=new ConcurrentDictionary<string,Candidate>();
        await SeekerState.SoulseekClient.SearchAsync(new SearchQuery(song.artist.Split(';')[0]+" "+song.title),response=>{
            foreach(var file in response.Files.Where(f=>f.Filename.EndsWith(".flac",StringComparison.OrdinalIgnoreCase)||f.Filename.EndsWith(".mp3",StringComparison.OrdinalIgnoreCase)).Take(100))
            {
                string id=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(response.Username+"\0"+file.Filename+"\0"+file.Size))).ToLowerInvariant();
                found.TryAdd(id,new Candidate{Id=id,Username=response.Username,Filename=file.Filename,Size=file.Size,Length=file.Length,FreeSlot=response.HasFreeUploadSlot,QueueLength=response.QueueLength,Speed=response.UploadSpeed,Expires=DateTime.UtcNow.AddMinutes(30)});
            }
        },options:new SearchOptions(searchTimeout:15000,responseLimit:100,fileLimit:2500));
        var result=found.Values.OrderByDescending(c=>c.FreeSlot).ThenBy(c=>c.QueueLength).Take(100).ToList();
        lock(sync){foreach(string old in candidates.Where(c=>c.Value.Expires<DateTime.UtcNow).Select(c=>c.Key).ToArray())candidates.Remove(old);foreach(var c in result)candidates[c.Id]=c;}
        return result;
    }
    static object Queue(SongRequest song)
    {
        lock(sync)
        {
            var active=jobs.FirstOrDefault(j=>AutomationPolicy.Active(j)&&AutomationPolicy.Key(j.Request)==AutomationPolicy.Key(song));if(active!=null)return new {status="existing_job",job=active.Public()};
            if(!candidates.TryGetValue(song.candidate_id,out var candidate)||candidate.Expires<DateTime.UtcNow)throw new InvalidOperationException("CANDIDATE_EXPIRED");
            if(candidate.Size<=0)throw new InvalidOperationException("CANDIDATE_SIZE_UNKNOWN");
            long reserved=jobs.Where(j=>AutomationPolicy.Active(j)&&j.State!="published").Sum(j=>Math.Max(0,j.Candidate.Size-j.Bytes));AutomationStorage.CheckBudget(context,reserved+candidate.Size,candidate.Size);
            var job=new NativeJob{Request=song,Candidate=candidate,DestinationTree=AutomationStorage.Tree(context)};jobs.Add(job);Save();return new {status="queued",job=job.Public()};
        }
    }
    static async Task Work(CancellationToken token)
    {
        while(!token.IsCancellationRequested)
        {
            NativeJob[] published;lock(sync)published=jobs.Where(j=>j.State=="published").ToArray();
            foreach(var completed in published){string leftover=Path.Combine(Incoming,completed.Id+Path.GetExtension(completed.Candidate.Name).ToLowerInvariant());try{if(IoFile.Exists(leftover)&&completed.Sha256.Length>0&&AutomationStorage.Digest(context,completed.Uri)==completed.Sha256&&AutomationStorage.Digest(leftover)==completed.Sha256)IoFile.Delete(leftover);}catch{}}
            NativeJob[] todo;lock(sync)todo=jobs.Where(j=>j.State=="queued" || j.State=="publishing" || (j.State=="retry_wait" && DateTime.UtcNow-j.Updated>TimeSpan.FromSeconds(Math.Min(300,30*j.Attempts)))).ToArray();
            foreach(var job in todo){if(running.ContainsKey(job.Id))continue;var cts=CancellationTokenSource.CreateLinkedTokenSource(token);if(running.TryAdd(job.Id,cts))_=Task.Run(()=>Download(job,cts));}
            try{await Task.Delay(2000,token);}catch(OperationCanceledException){return;}
        }
    }
    static void State(NativeJob job,string state,string reason=""){lock(sync){if(job.State=="cancelled")throw new OperationCanceledException();job.State=state;job.Reason=reason;job.Updated=DateTime.UtcNow;Save();}}
    static async Task Download(NativeJob job,CancellationTokenSource cancellation)
    {
        string file=Path.Combine(Incoming,job.Id+Path.GetExtension(job.Candidate.Name).ToLowerInvariant());
        try
        {
            if(!LoggedIn)throw new InvalidOperationException("ACCOUNT_LOGIN_REQUIRED");
            if(job.DestinationTree!=AutomationStorage.Tree(context))throw new InvalidOperationException("DESTINATION_CHANGED_REVIEW_REQUIRED");
            if(!job.DownloadComplete && job.Attempts>0)
            {
                var alternatives=await Search(job.Request);
                var replacement=alternatives.Where(c=>AutomationPolicy.Plausible(c,job.Request)&&c.Id!=job.Candidate.Id&&!job.TriedCandidates.Contains(c.Id)).OrderByDescending(c=>c.FreeSlot).ThenBy(c=>c.QueueLength).ThenBy(c=>c.Size).FirstOrDefault();
                if(replacement!=null){lock(sync){job.TriedCandidates.Add(job.Candidate.Id);if(IoFile.Exists(file))IoFile.Delete(file);job.Candidate=replacement;job.Bytes=0;file=Path.Combine(Incoming,job.Id+Path.GetExtension(replacement.Name).ToLowerInvariant());Save();}}
            }
            lock(sync){long reserved=jobs.Where(j=>AutomationPolicy.Active(j)&&j.State!="published").Sum(j=>Math.Max(0,j.Candidate.Size-j.Bytes));AutomationStorage.CheckBudget(context,reserved,job.Candidate.Size);}
            if(job.State!="publishing")
            {
                if(!job.DownloadComplete)
                {
                State(job,"downloading");long offset=IoFile.Exists(file)?new FileInfo(file).Length:0;if(offset>job.Candidate.Size)throw new InvalidOperationException("INCOMING_SIZE_CONFLICT");
                if(offset<job.Candidate.Size)
                {
                    await SeekerState.SoulseekClient.DownloadAsync(job.Candidate.Username,job.Candidate.Filename,file,job.Candidate.Size,offset,options:new TransferOptions(progressUpdated:p=>{lock(sync){job.Bytes=p.Transfer.BytesTransferred;job.Updated=DateTime.UtcNow;}}),cancellationToken:cancellation.Token);
                }
                if(new FileInfo(file).Length!=job.Candidate.Size)throw new InvalidOperationException("INCOMING_SIZE_MISMATCH");
                job.DownloadComplete=true;job.Bytes=job.Candidate.Size;State(job,"verifying");
                }
                if(!IoFile.Exists(file))throw new InvalidOperationException("INCOMING_FILE_MISSING_REVIEW");
                cancellation.Token.ThrowIfCancellationRequested();State(job,"enriching");await AutomationMetadata.Enrich(job,file,Path.Combine(context.FilesDir.AbsolutePath,"p2p-metadata-cache"));
                job.Sha256=AutomationStorage.Digest(file);State(job,"publishing");
            }
            cancellation.Token.ThrowIfCancellationRequested();await AutomationStorage.Publish(context,job,file,Save);
            lock(sync){job.Published=DateTime.UtcNow;State(job,"published");}
            if(AutomationStorage.Digest(context,job.Uri)==job.Sha256)IoFile.Delete(file);
        }
        catch(OperationCanceledException){if(job.State!="cancelled")State(job,"queued","WORKER_INTERRUPTED");}
        catch(InvalidOperationException e)
        {
            job.Attempts++;string reason=e.Message;bool held=reason.Contains("CONFLICT")||reason.Contains("MISMATCH")||reason.Contains("REVIEW")||reason.Contains("COLLISION");State(job,held?"held":"retry_wait",reason);
        }
        catch{job.Attempts++;State(job,"retry_wait","TRANSFER_OR_STORAGE_UNAVAILABLE");}
        finally{running.TryRemove(job.Id,out _);cancellation.Dispose();Save();}
    }
}
