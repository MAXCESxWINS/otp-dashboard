<#
  Repoints the OTP Maker APK at any server base URL and produces a signed APK.

  Example:
    powershell -ExecutionPolicy Bypass -File .\build-apk.ps1 -BaseUrl https://otp-dashboard.onrender.com/abc123token/

  The app appends api/Smslist/batchAdd and api/Smslist/setoffline to this base,
  so the URL must end with a slash.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BaseUrl,

  [string]$ApkIn = "C:\Users\Administrator\Documents\APK\PENapp.apk",
  [string]$ApkOut = "C:\Users\Administrator\Documents\APK\PENapp_CUSTOM.apk",
  [string]$VersionName = "v7.0.4-dash",
  [int]$VersionCode = 9
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$tools = Join-Path $root "tools"
$work = Join-Path $env:TEMP "apkbuild"
$decoded = Join-Path $work "decoded"

if ($BaseUrl -notmatch '^https?://') { throw "BaseUrl must start with http:// or https://" }
if (-not $BaseUrl.EndsWith('/')) { $BaseUrl += '/' }
$BaseUrl = $BaseUrl.Replace('\', '/')

foreach ($jar in @("apktool.jar", "uber-apk-signer.jar")) {
  if (-not (Test-Path (Join-Path $tools $jar))) { throw "Missing tools/$jar" }
}
if (-not (Test-Path $ApkIn)) { throw "APK not found: $ApkIn" }

Write-Host "[1/4] decoding $ApkIn"
if (Test-Path $decoded) { Remove-Item $decoded -Recurse -Force }
java -jar (Join-Path $tools "apktool.jar") d $ApkIn -o $decoded -f | Out-Null

Write-Host "[2/4] patching base URL -> $BaseUrl"
$appSmali = Join-Path $decoded "smali\com\pocksms\app\base\MyApplication.smali"
if (-not (Test-Path $appSmali)) { throw "MyApplication.smali not found in decode" }

$text = Get-Content $appSmali -Raw
$pattern = '(?m)^\.field public static e:Ljava/lang/String; = ".*?"\r?$'
if ($text -notmatch $pattern) { throw "Could not locate the base URL field in MyApplication.smali" }
$text = [regex]::Replace($text, $pattern, ".field public static e:Ljava/lang/String; = `"$BaseUrl`"")
Set-Content -Path $appSmali -Value $text -NoNewline

# any hardcoded absolute URL left in the dex points at the old host; move it to the new base
$oldHosts = @('https://otp.always-lucky.com/', 'http://otp.always-lucky.com/')
$touched = 0
Get-ChildItem (Join-Path $decoded "smali") -Recurse -Filter *.smali | ForEach-Object {
  $raw = Get-Content $_.FullName -Raw
  $next = $raw
  foreach ($h in $oldHosts) { $next = $next.Replace($h, $BaseUrl) }
  if ($next -ne $raw) {
    Set-Content -Path $_.FullName -Value $next -NoNewline
    $touched++
  }
}
Write-Host "      rewrote hardcoded URLs in $touched file(s)"

$yml = Join-Path $decoded "apktool.yml"
$cfg = Get-Content $yml -Raw
$cfg = [regex]::Replace($cfg, 'versionCode: \d+', "versionCode: $VersionCode")
$cfg = [regex]::Replace($cfg, 'versionName: .*', "versionName: $VersionName")
Set-Content -Path $yml -Value $cfg -NoNewline

Write-Host "[3/4] rebuilding"
$unsigned = Join-Path $work "unsigned.apk"
java -jar (Join-Path $tools "apktool.jar") b $decoded -o $unsigned | Out-Null
if (-not (Test-Path $unsigned)) { throw "apktool build failed" }

Write-Host "[4/4] signing"
$signedDir = Join-Path $work "signed"
if (Test-Path $signedDir) { Remove-Item $signedDir -Recurse -Force }
java -jar (Join-Path $tools "uber-apk-signer.jar") -a $unsigned --out $signedDir --allowResign | Out-Null
$produced = Get-ChildItem $signedDir -Filter "*debugSigned.apk" | Select-Object -First 1
if (-not $produced) { throw "signing failed" }

Copy-Item $produced.FullName $ApkOut -Force

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($ApkOut)
$dex = $zip.Entries | Where-Object { $_.Name -eq "classes.dex" }
$ms = New-Object System.IO.MemoryStream
$stream = $dex.Open()
$stream.CopyTo($ms)
$stream.Close()
$zip.Dispose()
$body = [System.Text.Encoding]::ASCII.GetString($ms.ToArray())

Write-Host ""
Write-Host "APK      : $ApkOut"
Write-Host "Size     : $((Get-Item $ApkOut).Length) bytes"
Write-Host "SHA256   : $((Get-FileHash $ApkOut -Algorithm SHA256).Hash)"
Write-Host "Base URL : $BaseUrl"
Write-Host "Verify   : base=$($body.Contains($BaseUrl.TrimEnd('/'))) oldhost=$($body.Contains('always-lucky')) batchAdd=$($body.Contains('api/Smslist/batchAdd'))"
exit 0
