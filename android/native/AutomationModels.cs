// Android automation additions for the Seeker-derived local backend.
// GPL-3.0-only; retain the upstream additional terms and LICENSE.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace Seeker.Automation;

public sealed class SongRequest
{
    public string artist { get; set; } = "";
    public string title { get; set; } = "";
    public string album { get; set; } = "";
    public long duration_ms { get; set; }
    public string request_key { get; set; } = "";
    public string candidate_id { get; set; } = "";
    public void Validate()
    {
        if (string.IsNullOrWhiteSpace(artist) || artist.Length > 200 || string.IsNullOrWhiteSpace(title) || title.Length > 200 || album.Length > 200 || duration_ms < 0 || request_key.Length > 128)
            throw new InvalidOperationException("INVALID_SONG_REQUEST");
    }
}
public sealed class Candidate
{
    public string Id { get; set; } = "";
    public string Username { get; set; } = "";
    public string Filename { get; set; } = "";
    public long Size { get; set; }
    public int? Length { get; set; }
    public bool FreeSlot { get; set; }
    public int QueueLength { get; set; }
    public int Speed { get; set; }
    public DateTime Expires { get; set; }
    public string Name => Filename.Replace('\\', '/').Split('/').Last();
    public object Public() => new { candidate_id = Id, title = Name, size = Size, duration_seconds = Length, free_upload_slot = FreeSlot, queue_length = QueueLength, upload_speed_bytes_per_second = Speed };
}
public sealed class NativeJob
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public SongRequest Request { get; set; } = new();
    public Candidate Candidate { get; set; } = new();
    public string State { get; set; } = "queued";
    public string Reason { get; set; } = "";
    public long Bytes { get; set; }
    public bool DownloadComplete { get; set; }
    public List<string> TriedCandidates { get; set; } = new();
    public string DestinationTree { get; set; } = "";
    public string Uri { get; set; } = "";
    public string Sha256 { get; set; } = "";
    public string RecordingId { get; set; } = "";
    public string ReleaseId { get; set; } = "";
    public string RelativeName { get; set; } = "";
    public int Attempts { get; set; }
    public DateTime Updated { get; set; } = DateTime.UtcNow;
    public DateTime? Published { get; set; }
    public object Public() => new { job_id = Id, artist = Request.artist, title = Request.title, state = State, reason = Reason, bytes_transferred = Bytes, size = Candidate.Size, recording_id = RecordingId, release_id = ReleaseId, sha256 = Sha256, published_at = Published, updated_at = Updated };
}
public static class AutomationPolicy
{
    public static void CheckBudget(long total,long free,long incomingFree,long remaining,long publishBytes)
    {
        if(total<=0||free<0||incomingFree<0||remaining<0||publishBytes<0)throw new InvalidOperationException("INVALID_STORAGE_BUDGET");
        if(incomingFree-remaining-publishBytes<1073741824)throw new InvalidOperationException("INCOMING_STORAGE_BUDGET");
        if(total-free+remaining+publishBytes>total*66/100)throw new InvalidOperationException("DESTINATION_STORAGE_CAP");
    }
    public static string Normalize(string input) => string.Join(" ", Regex.Matches((input ?? "").Normalize(NormalizationForm.FormKD).ToLowerInvariant(), @"[\p{L}\p{N}]+", RegexOptions.CultureInvariant).Select(m => m.Value));
    public static string Key(SongRequest song) => Normalize(song.artist.Split(';')[0]) + "\0" + Normalize(song.title);
    public static string Safe(string value) => Regex.Replace(value ?? "", "[<>:\"/\\\\|?*\\x00-\\x1f]", "_").Trim(' ', '.') is string safe && safe.Length > 0 ? safe : "Unknown";
    public static bool Same(string artist, string title, SongRequest song) => Normalize(artist) == Normalize(song.artist.Split(';')[0]) && Normalize(title) == Normalize(song.title);
    public static bool Plausible(Candidate file, SongRequest song)
    {
        string ext = System.IO.Path.GetExtension(file.Name).ToLowerInvariant();
        if (ext != ".flac" && ext != ".mp3") return false;
        if (song.duration_ms > 0 && file.Length.HasValue && Math.Abs(song.duration_ms - file.Length.Value * 1000L) > 10000) return false;
        string title = Normalize(Regex.Replace(System.IO.Path.GetFileNameWithoutExtension(file.Name), @"^\s*\d{1,3}[\s._-]+", ""));
        string wanted = Normalize(song.title), artist = Normalize(song.artist.Split(';')[0]);
        return title == wanted || title == artist + " " + wanted;
    }
    public static bool Active(NativeJob job) => job.State != "cancelled" && job.State != "held" && job.State != "failed";
}
