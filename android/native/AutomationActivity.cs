// GPL-3.0-only with Seeker's upstream additional terms.
using Android.App;
using Android.Content;
using Android.OS;
using Android.Widget;

namespace Seeker.Automation;

[Activity(Name="com.bonklek.p2p.android.AutomationActivity",Label="P2P Automation",Exported=true,MainLauncher=true)]
public sealed class AutomationActivity : Activity
{
    TextView status;
    protected override void OnCreate(Bundle savedInstanceState)
    {
        base.OnCreate(savedInstanceState);
        var layout = new LinearLayout(this) { Orientation = Orientation.Vertical }; layout.SetPadding(24,24,24,24);
        status = new TextView(this) { Text = "P2P Automation\nOpen the music client to configure Soulseek login and real shares. Enable automation here, then pair in Termux. Credentials never belong in chat.\nDefault destination: Music/P2P on internal storage." }; layout.AddView(status);
        Add(layout,"Open music client",()=>StartActivity(new Intent(this,typeof(MainActivity))));
        Add(layout,"Enable automation and show pairing code",()=>{
            if(Build.VERSION.SdkInt>=BuildVersionCodes.Tiramisu && CheckSelfPermission(Android.Manifest.Permission.PostNotifications)!=Android.Content.PM.Permission.Granted)RequestPermissions(new[]{Android.Manifest.Permission.PostNotifications},44);
            string audio=Build.VERSION.SdkInt>=BuildVersionCodes.Tiramisu ? Android.Manifest.Permission.ReadMediaAudio : Android.Manifest.Permission.ReadExternalStorage;
            if(CheckSelfPermission(audio)!=Android.Content.PM.Permission.Granted)RequestPermissions(new[]{audio},45);
            StartForegroundService(new Intent(this,typeof(AutomationService)));
            status.Text="Pair locally: p2p-tools-android pair\nCode (valid two minutes): "+AutomationBridge.NewPairCode(this)+"\nBridge: 127.0.0.1:5032\nOpen the music client for account login and sharing.";
        });
        Add(layout,"Choose music destination folder",()=>{
            var intent=new Intent(Intent.ActionOpenDocumentTree);intent.AddFlags(ActivityFlags.GrantReadUriPermission|ActivityFlags.GrantWriteUriPermission|ActivityFlags.GrantPersistableUriPermission|ActivityFlags.GrantPrefixUriPermission);StartActivityForResult(intent,51);
        });
        Add(layout,"Use internal Music/P2P destination",()=>{GetSharedPreferences("p2p_automation",FileCreationMode.Private).Edit().Remove("tree_uri").Apply();status.Text="Destination: internal Music/P2P. Existing files are preserved.";});
        Add(layout,"Disable automation and revoke pairing",()=>{AutomationBridge.Revoke(this);StopService(new Intent(this,typeof(AutomationService)));status.Text="Automation disabled and pairing revoked. Published library files remain.";});
        SetContentView(layout);
    }
    void Add(LinearLayout layout,string label,System.Action action){var button=new Button(this){Text=label};button.Click+=(_,_)=>action();layout.AddView(button);}
    protected override void OnActivityResult(int requestCode,Result resultCode,Intent data)
    {
        base.OnActivityResult(requestCode,resultCode,data);
        if(requestCode!=51 || resultCode!=Result.Ok || data?.Data==null)return;
        ContentResolver.TakePersistableUriPermission(data.Data,data.Flags & (ActivityFlags.GrantReadUriPermission|ActivityFlags.GrantWriteUriPermission));
        GetSharedPreferences("p2p_automation",FileCreationMode.Private).Edit().PutString("tree_uri",data.Data.ToString()).Apply();status.Text="Music destination selected. Setup verifies access before downloading.";
    }
}

[Service(Name="com.bonklek.p2p.android.AutomationService",Exported=false,ForegroundServiceType=Android.Content.PM.ForegroundService.TypeDataSync)]
public sealed class AutomationService : Service
{
    public override IBinder OnBind(Intent intent)=>null;
    public override void OnCreate()
    {
        base.OnCreate();const string channel="p2p_automation";
        ((NotificationManager)GetSystemService(NotificationService)).CreateNotificationChannel(new NotificationChannel(channel,"P2P music automation",NotificationImportance.Low));
        var open=PendingIntent.GetActivity(this,0,new Intent(this,typeof(AutomationActivity)),PendingIntentFlags.Immutable|PendingIntentFlags.UpdateCurrent);
        StartForeground(5412,new Notification.Builder(this,channel).SetContentTitle("P2P music automation").SetContentText("Phone-local jobs; open to pair or stop").SetSmallIcon(Android.Resource.Drawable.StatSysDownload).SetContentIntent(open).Build());
        AutomationBridge.Start(this);
    }
    public override StartCommandResult OnStartCommand(Intent intent,StartCommandFlags flags,int startId)=>StartCommandResult.NotSticky;
    public override void OnTimeout(int startId,Android.Content.PM.ForegroundService fgsType){AutomationBridge.Stop();StopSelf();}
    public override void OnDestroy(){AutomationBridge.Stop();base.OnDestroy();}
}
