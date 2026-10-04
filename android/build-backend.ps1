param(
    [string]$Dotnet = "$PSScriptRoot/.build/dotnet/dotnet.exe",
    [string]$AndroidSdk = "$env:LOCALAPPDATA/Android/Sdk",
    [Parameter(Mandatory=$true)][string]$JavaSdk
)
$ErrorActionPreference = 'Stop'
& "$PSScriptRoot/prepare-backend.ps1"
if (!(Test-Path -LiteralPath $Dotnet)) { throw 'Install .NET SDK 10.0.401 and its Android workload, then pass -Dotnet' }
$arguments = @('build',"$PSScriptRoot/upstream/SeekerAndroid/Seeker/Seeker.csproj",'-c','Debug',
    '-p:AndroidKeyStore=false',"-p:AndroidSdkDirectory=$AndroidSdk","-p:JavaSdkDirectory=$JavaSdk",
    '-p:AndroidPackageFormats=apk','-p:EmbedAssembliesIntoApk=true','-p:AndroidUseSharedRuntime=false',
    '-p:ApplicationId=com.bonklek.p2p.android','-p:ApplicationTitle=P2P Music Backend',
    '-p:RunAnalyzers=false','-v:minimal')
& $Dotnet @arguments
if ($LASTEXITCODE) { throw 'Native APK build failed' }
Write-Output 'Private integration APK built. Verify signing and manifest before transfer.'
