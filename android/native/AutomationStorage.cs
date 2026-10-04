// GPL-3.0-only with Seeker's upstream additional terms.
using Android.Content;
using Android.OS;
using Android.Provider;
using AndroidX.DocumentFile.Provider;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Threading.Tasks;
using IoFile=System.IO.File;

namespace Seeker.Automation;

public static class AutomationStorage
{
    public static string Tree(Context context)=>context.GetSharedPreferences("p2p_automation",FileCreationMode.Private).GetString("tree_uri","");
    public static string VolumePath(Context context)
    {
        string tree=Tree(context);if(tree.Length==0)return Android.OS.Environment.ExternalStorageDirectory.AbsolutePath;
        string volume=DocumentsContract.GetTreeDocumentId(Android.Net.Uri.Parse(tree)).Split(':')[0];
        if(volume=="primary")return Android.OS.Environment.ExternalStorageDirectory.AbsolutePath;
        if(!System.Text.RegularExpressions.Regex.IsMatch(volume,@"^[A-Za-z0-9_-]+$"))throw new InvalidOperationException("UNSUPPORTED_STORAGE_VOLUME");
        string path="/storage/"+volume;if(!Directory.Exists(path))throw new InvalidOperationException("DESTINATION_VOLUME_UNAVAILABLE");return path;
    }
    public static object Status(Context context)
    {
        string tree=Tree(context);
        if(tree.Length>0){var root=DocumentFile.FromTreeUri(context,Android.Net.Uri.Parse(tree));if(root==null||!root.CanWrite()||!root.CanRead())throw new InvalidOperationException("DESTINATION_PERMISSION_REQUIRED");}
        var volume=new StatFs(VolumePath(context));var incoming=new StatFs(context.FilesDir.AbsolutePath);
        return new {destination=tree.Length==0?"internal Music/P2P":"selected document tree",total_bytes=volume.TotalBytes,free_bytes=volume.AvailableBytes,incoming_free_bytes=incoming.AvailableBytes,max_used_percent=66};
    }
    public static void CheckBudget(Context context,long remaining,long publishBytes)
    {
        Status(context);var destination=new StatFs(VolumePath(context));var incoming=new StatFs(context.FilesDir.AbsolutePath);
        AutomationPolicy.CheckBudget(destination.TotalBytes,destination.AvailableBytes,incoming.AvailableBytes,remaining,publishBytes);
    }
    public static object[] Find(Context context,SongRequest song)
    {
        song.Validate();var rows=new List<object>();
        var uri=MediaStore.Audio.Media.ExternalContentUri;
        using var cursor=context.ContentResolver.Query(uri,new[]{"_id","artist","title","duration","_size"},"is_music != 0",null,null);
        if(cursor==null)throw new InvalidOperationException("LIBRARY_PERMISSION_REQUIRED");
        int scanned=0;
        while(cursor.MoveToNext() && scanned++<50000 && rows.Count<100)
        {
            string artist=cursor.GetString(1)??"",title=cursor.GetString(2)??"";long duration=cursor.GetLong(3);
            if(!AutomationPolicy.Same(artist,title,song) || (song.duration_ms>0 && Math.Abs(song.duration_ms-duration)>10000))continue;
            var item=ContentUris.WithAppendedId(uri,cursor.GetLong(0));
            try {using var fd=context.ContentResolver.OpenFileDescriptor(item,"r");if(fd==null)continue;}catch{continue;}
            rows.Add(new {media_id=cursor.GetLong(0).ToString(),artist,title,duration_ms=duration,size=cursor.GetLong(4)});
        }
        return rows.ToArray();
    }
    public static string Digest(string path){using var stream=IoFile.OpenRead(path);return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();}
    public static string Digest(Context context,string uri){using var stream=context.ContentResolver.OpenInputStream(Android.Net.Uri.Parse(uri));if(stream==null)throw new InvalidOperationException("PUBLICATION_UNREADABLE");return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();}
    public static async Task Publish(Context context,NativeJob job,string source,Action save)
    {
        string mime=job.Candidate.Name.EndsWith(".flac",StringComparison.OrdinalIgnoreCase)?"audio/flac":"audio/mpeg";
        string tree=Tree(context);string relative=job.RelativeName;string leaf=Path.GetFileName(relative);
        if(job.Uri.Length==0)
        {
            if(tree.Length==0)
            {
                var values=new ContentValues();values.Put("_display_name",leaf);values.Put("mime_type",mime);values.Put("relative_path","Music/P2P/"+Path.GetDirectoryName(relative)?.Replace('\\','/')+"/");values.Put("is_pending",1);
                var inserted=context.ContentResolver.Insert(MediaStore.Audio.Media.GetContentUri(MediaStore.VolumeExternalPrimary),values);if(inserted==null)throw new InvalidOperationException("PUBLICATION_CREATE_FAILED");job.Uri=inserted.ToString();
            }
            else
            {
                var folder=DocumentFile.FromTreeUri(context,Android.Net.Uri.Parse(tree));
                foreach(string component in relative.Replace('\\','/').Split('/').SkipLast(1))
                {
                    string name=AutomationPolicy.Safe(component);folder=folder.FindFile(name)??folder.CreateDirectory(name);if(folder==null||!folder.IsDirectory)throw new InvalidOperationException("DESTINATION_FOLDER_FAILED");
                }
                if(folder.FindFile(leaf)!=null)throw new InvalidOperationException("DESTINATION_COLLISION");
                var created=folder.CreateFile(mime,job.Id+".p2p-partial");if(created==null)throw new InvalidOperationException("PUBLICATION_CREATE_FAILED");job.Uri=created.Uri.ToString();
            }
            save();
        }
        using(var input=IoFile.OpenRead(source))using(var output=context.ContentResolver.OpenOutputStream(Android.Net.Uri.Parse(job.Uri),"wt"))
        {if(output==null)throw new InvalidOperationException("PUBLICATION_WRITE_FAILED");await input.CopyToAsync(output);output.Flush();}
        if(Digest(context,job.Uri)!=job.Sha256)throw new InvalidOperationException("PUBLICATION_HASH_MISMATCH");
        if(tree.Length==0){var values=new ContentValues();values.Put("is_pending",0);if(context.ContentResolver.Update(Android.Net.Uri.Parse(job.Uri),values,null,null)!=1)throw new InvalidOperationException("PUBLICATION_COMMIT_FAILED");}
        else
        {
            var document=DocumentFile.FromSingleUri(context,Android.Net.Uri.Parse(job.Uri));if(document==null)throw new InvalidOperationException("PUBLICATION_RENAME_FAILED");
            if(document.Name!=leaf){var parent=DocumentFile.FromTreeUri(context,Android.Net.Uri.Parse(tree));foreach(string component in relative.Replace('\\','/').Split('/').SkipLast(1)){parent=parent?.FindFile(AutomationPolicy.Safe(component));}if(parent?.FindFile(leaf)!=null)throw new InvalidOperationException("DESTINATION_COLLISION");if(!document.RenameTo(leaf))throw new InvalidOperationException("PUBLICATION_RENAME_FAILED");}
            job.Uri=document.Uri.ToString();save();
            string root=DocumentsContract.GetTreeDocumentId(Android.Net.Uri.Parse(tree));string[] parts=root.Split(':',2);string path=VolumePath(context)+"/"+(parts.Length==2?parts[1]+"/":"")+relative.Replace('\\','/');
            Android.Media.MediaScannerConnection.ScanFile(context,new[]{path},new[]{mime},null);
        }
        if(Digest(context,job.Uri)!=job.Sha256)throw new InvalidOperationException("FINAL_HASH_MISMATCH");
    }
}
