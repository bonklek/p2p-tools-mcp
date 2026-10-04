param([string]$SourceDirectory = "$PSScriptRoot/upstream/SeekerAndroid")
$ErrorActionPreference = 'Stop'
$pin = Get-Content "$PSScriptRoot/upstream.lock.json" -Raw | ConvertFrom-Json
if (!(Test-Path -LiteralPath "$SourceDirectory/.git")) {
    git clone $pin.repository $SourceDirectory
    if ($LASTEXITCODE) { throw 'Upstream clone failed' }
    git -C $SourceDirectory checkout --detach $pin.commit
    if ($LASTEXITCODE) { throw 'Pinned checkout failed' }
}
$head = git -C $SourceDirectory rev-parse HEAD
if ($head -ne $pin.commit) { throw 'Source directory is not at the pinned commit; use a fresh build directory' }
# Reconstruct only files managed by this preparation step from the pinned source.
function Read-Upstream([string]$Path) {
    $text = git -C $SourceDirectory show "HEAD:$Path"
    if ($LASTEXITCODE) { throw "Missing pinned source: $Path" }
    return $text -join "`n"
}
function Save-Utf8([string]$Path,[string]$Text) {
    if ((Test-Path -LiteralPath $Path) -and [IO.File]::ReadAllText($Path) -eq $Text) { return }
    [IO.File]::WriteAllText($Path,$Text,[Text.UTF8Encoding]::new($false))
}
$sdk = '{"sdk":{"version":"10.0.401","rollForward":"latestPatch"}}'
Save-Utf8 "$SourceDirectory/global.json" $sdk
$project = (Read-Upstream 'Seeker/Seeker.csproj').Replace('<SupportedOSPlatformVersion>23</SupportedOSPlatformVersion>','<SupportedOSPlatformVersion>30</SupportedOSPlatformVersion>')
$project = $project.Replace('android-arm;android-x86;android-x64;android-arm64','android-arm64')
$project = $project.Replace('</Project>','<ItemGroup><PackageReference Include="TagLibSharp" Version="2.3.0" /><PackageReference Include="Xamarin.AndroidX.DataStore.Preferences" Version="1.2.1" /></ItemGroup></Project>')
Save-Utf8 "$SourceDirectory/Seeker/Seeker.csproj" $project
$manifest = Read-Upstream 'Seeker/Properties/AndroidManifest.xml'
$manifest = $manifest -replace 'package="[^"]+"','package="com.bonklek.p2p.android"'
$manifest = $manifest -replace 'android:versionCode="[^"]+"','android:versionCode="1"'
$manifest = $manifest -replace 'android:versionName="[^"]+"','android:versionName="0.3.0-alpha.1"'
$manifest = $manifest -replace 'android:allowBackup="true"','android:allowBackup="false"'
$manifest = $manifest -replace 'android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" android:maxSdkVersion="33"','android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC"'
$manifest = $manifest.Replace('<uses-permission android:name="android.permission.INTERNET"','<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" /><uses-permission android:name="android.permission.INTERNET"')
Save-Utf8 "$SourceDirectory/Seeker/Properties/AndroidManifest.xml" $manifest
Save-Utf8 "$SourceDirectory/Common/Common.csproj" ((Read-Upstream 'Common/Common.csproj').Replace('2.5.198','2.5.303'))
$soulseek = 'Seeker/Soulseek.NET-master/src/Soulseek.csproj'
Save-Utf8 "$SourceDirectory/$soulseek" ((Read-Upstream $soulseek).Replace('<GeneratePackageOnBuild>true','<GeneratePackageOnBuild>false'))
New-Item -ItemType Directory -Force "$SourceDirectory/Seeker/Automation" | Out-Null
Get-ChildItem -LiteralPath "$PSScriptRoot/native" -Filter '*.cs' | ForEach-Object {
    Save-Utf8 "$SourceDirectory/Seeker/Automation/$($_.Name)" ([IO.File]::ReadAllText($_.FullName))
}
Write-Output 'Pinned native source prepared; upstream licenses remain in place.'
