// GPL-3.0-only with Seeker's upstream additional terms.
using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Seeker.Automation;

public static class AutomationMetadata
{
    static readonly SemaphoreSlim gate=new(1,1);
    static DateTime lastRequest=DateTime.MinValue;
    static readonly HttpClient http=new(){Timeout=TimeSpan.FromSeconds(20)};
    static AutomationMetadata(){http.DefaultRequestHeaders.UserAgent.ParseAdd("p2p-tools-android/0.3.0-alpha.1 (+https://github.com/bonklek/p2p-tools-mcp)");}
    static async Task<JsonDocument> Lookup(string uri,string cache)
    {
        string key=Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(uri)));
        string path=Path.Combine(cache,key+".json");Directory.CreateDirectory(cache);
        if(System.IO.File.Exists(path)&&DateTime.UtcNow-System.IO.File.GetLastWriteTimeUtc(path)<TimeSpan.FromDays(1))return JsonDocument.Parse(await System.IO.File.ReadAllTextAsync(path));
        await gate.WaitAsync();
        try
        {
            int wait=(int)(1100-(DateTime.UtcNow-lastRequest).TotalMilliseconds);if(wait>0)await Task.Delay(wait);lastRequest=DateTime.UtcNow;
            using var response=await http.GetAsync(uri,HttpCompletionOption.ResponseHeadersRead);if(!response.IsSuccessStatusCode)throw new InvalidOperationException("METADATA_SERVICE_UNAVAILABLE");
            if(response.Content.Headers.ContentLength>2000000)throw new InvalidOperationException("METADATA_RESPONSE_TOO_LARGE");
            using var input=await response.Content.ReadAsStreamAsync();using var output=new MemoryStream();var buffer=new byte[8192];int read;
            while((read=await input.ReadAsync(buffer))>0){if(output.Length+read>2000000)throw new InvalidOperationException("METADATA_RESPONSE_TOO_LARGE");output.Write(buffer,0,read);}
            string json=System.Text.Encoding.UTF8.GetString(output.ToArray());using(var valid=JsonDocument.Parse(json)){}await System.IO.File.WriteAllTextAsync(path+".tmp",json);System.IO.File.Move(path+".tmp",path,true);return JsonDocument.Parse(json);
        }
        finally{gate.Release();}
    }
    static string Text(JsonElement e,string name)=>e.TryGetProperty(name,out var value)&&value.ValueKind==JsonValueKind.String?value.GetString()??"":"";
    public static async Task Enrich(NativeJob job,string file,string cache)
    {
        using var audio=TagLib.File.Create(file);
        long duration=(long)audio.Properties.Duration.TotalMilliseconds;
        if(duration<=0 || (job.Request.duration_ms>0&&Math.Abs(duration-job.Request.duration_ms)>10000))throw new InvalidOperationException("AUDIO_DURATION_MISMATCH");
        if(!string.IsNullOrWhiteSpace(audio.Tag.Title)&&AutomationPolicy.Normalize(audio.Tag.Title)!=AutomationPolicy.Normalize(job.Request.title))throw new InvalidOperationException("AUDIO_TITLE_CONFLICT");
        string artist=job.Request.artist.Split(';')[0];
        if(audio.Tag.Performers.Length>0&&!audio.Tag.Performers.Any(a=>AutomationPolicy.Normalize(a)==AutomationPolicy.Normalize(artist)))throw new InvalidOperationException("AUDIO_ARTIST_CONFLICT");
        string Escape(string value)=>value.Replace("\\","\\\\").Replace("\"","\\\"");
        string query="recording:\""+Escape(job.Request.title)+"\" AND artist:\""+Escape(artist)+"\"";
        using var response=await Lookup("https://musicbrainz.org/ws/2/recording/?query="+Uri.EscapeDataString(query)+"&fmt=json&limit=25",cache);
        var matches=response.RootElement.GetProperty("recordings").EnumerateArray().Where(record=>
            AutomationPolicy.Normalize(Text(record,"title"))==AutomationPolicy.Normalize(job.Request.title)&&
            record.TryGetProperty("artist-credit",out var credits)&&credits.EnumerateArray().Any(credit=>AutomationPolicy.Normalize(Text(credit,"name"))==AutomationPolicy.Normalize(artist))&&
            record.TryGetProperty("length",out var length)&&length.TryGetInt64(out long ms)&&Math.Abs(ms-duration)<=8000).ToList();
        if(matches.Select(record=>Text(record,"id")).Distinct().Count()!=1)throw new InvalidOperationException("RECORDING_IDENTITY_REVIEW_REQUIRED");
        var recording=matches[0];job.RecordingId=Text(recording,"id");
        string album=job.Request.album;uint track=0;string year="";string releaseId="";
        if(album.Length>0&&recording.TryGetProperty("releases",out var releases))
        {
            var releaseMatches=releases.EnumerateArray().Where(r=>AutomationPolicy.Normalize(Text(r,"title"))==AutomationPolicy.Normalize(album)).ToList();
            if(releaseMatches.Select(r=>Text(r,"id")).Distinct().Count()==1)
            {
                var release=releaseMatches[0];releaseId=Text(release,"id");string date=Text(release,"date");if(date.Length>=4&&uint.TryParse(date[..4],out _))year=date[..4];
                using var detail=await Lookup("https://musicbrainz.org/ws/2/release/"+Uri.EscapeDataString(releaseId)+"?inc=recordings&fmt=json",cache);
                var positions=detail.RootElement.GetProperty("media").EnumerateArray().SelectMany(m=>m.GetProperty("tracks").EnumerateArray()).Where(t=>t.TryGetProperty("recording",out var r)&&Text(r,"id")==job.RecordingId).Select(t=>t.GetProperty("position").GetUInt32()).ToList();
                if(positions.Count==1)track=positions[0];
            }
        }
        bool albumConflict=!string.IsNullOrEmpty(audio.Tag.Album)&&AutomationPolicy.Normalize(audio.Tag.Album)!=AutomationPolicy.Normalize(album);
        if(string.IsNullOrWhiteSpace(audio.Tag.Title))audio.Tag.Title=job.Request.title;
        if(audio.Tag.Performers.Length==0)audio.Tag.Performers=new[]{artist};
        if(releaseId.Length>0&&!albumConflict){if(audio.Tag.Track>0&&track>0&&audio.Tag.Track!=track)throw new InvalidOperationException("ALBUM_TRACK_CONFLICT");if(string.IsNullOrWhiteSpace(audio.Tag.Album))audio.Tag.Album=album;if(audio.Tag.Year==0&&uint.TryParse(year,out uint y))audio.Tag.Year=y;if(audio.Tag.Track==0&&track>0)audio.Tag.Track=track;job.ReleaseId=releaseId;}
        audio.Save();
        string ext=Path.GetExtension(job.Candidate.Name).ToLowerInvariant();string folder=track>0&&year.Length>0&&!albumConflict?"["+year+"] "+AutomationPolicy.Safe(album):"_Singles";
        string name=track>0&&!albumConflict?track.ToString("D2")+" - "+job.Request.title:artist+" - "+job.Request.title;
        job.RelativeName=AutomationPolicy.Safe(artist)+"/"+folder+"/"+AutomationPolicy.Safe(name)+ext;
    }
}
