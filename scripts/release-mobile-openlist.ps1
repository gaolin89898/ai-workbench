param(
  [string]$Version,
  [string]$RemoteName = 'openlist-mobile',
  [string]$WebDavUrl = 'https://openlist.gaolin.xin/dav',
  [string]$RemotePath = '夸克网盘/移动端',
  [string]$User = $env:OPENLIST_USER,
  [string]$Password = $env:OPENLIST_PASS,
  [switch]$NoBuild,
  [switch]$NoUpload
)

$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$mobileDir = Join-Path $root 'apps/mobile'
$pubspecPath = Join-Path $mobileDir 'pubspec.yaml'
$androidSdk = Join-Path $env:LOCALAPPDATA 'Android/Sdk'
$flutterDir = Join-Path $env:USERPROFILE 'flutter'
$releaseDir = Join-Path $root 'releases/mobile'

if (-not $Version) {
  $pubspec = Get-Content -Raw -Path $pubspecPath
  if ($pubspec -notmatch '(?m)^version:\s*([^\r\n]+)') {
    throw "Cannot read version from $pubspecPath"
  }
  $Version = $Matches[1].Trim()
}

$versionName = ($Version -split '\+')[0]
$apkName = "ai-workbench-mobile-$versionName.apk"
$builtApk = Join-Path $mobileDir 'build/app/outputs/flutter-apk/app-release.apk'
$distApk = Join-Path $releaseDir $apkName

$env:ANDROID_HOME = $androidSdk
$env:ANDROID_SDK_ROOT = $androidSdk
$env:PUB_HOSTED_URL = 'https://pub.flutter-io.cn'
$env:FLUTTER_STORAGE_BASE_URL = 'https://storage.flutter-io.cn'
$env:Path = @(
  (Join-Path $flutterDir 'bin'),
  (Join-Path $androidSdk 'platform-tools'),
  (Join-Path $androidSdk 'cmdline-tools/latest/bin'),
  (Join-Path $androidSdk 'emulator'),
  $env:Path
) -join ';'

if (-not (Get-Command flutter -ErrorAction SilentlyContinue)) {
  throw "Flutter was not found. Expected $flutterDir\bin\flutter.bat"
}

if (-not $NoBuild) {
  Set-Location $mobileDir
  flutter pub get
  flutter build apk --release --dart-define="MOBILE_VERSION=$versionName"
}

if (-not (Test-Path $builtApk)) {
  throw "APK was not found: $builtApk"
}

New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
Copy-Item -LiteralPath $builtApk -Destination $distApk -Force
Write-Host "APK ready: $distApk"

if ($NoUpload) {
  return
}

if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) {
  throw "rclone was not found. Install rclone, then rerun this script."
}
if (-not $User -or -not $Password) {
  throw "OpenList credentials are required. Pass -User/-Password or set OPENLIST_USER/OPENLIST_PASS."
}

$obscuredPass = (& rclone obscure $Password).Trim()
$remoteExists = $false
try {
  rclone config show $RemoteName | Out-Null
  $remoteExists = $true
} catch {
  $remoteExists = $false
}

if ($remoteExists) {
  rclone config update $RemoteName url $WebDavUrl vendor other user $User pass $obscuredPass | Out-Null
} else {
  rclone config create $RemoteName webdav url $WebDavUrl vendor other user $User pass $obscuredPass | Out-Null
}

$target = "${RemoteName}:$RemotePath/$apkName"
rclone copyto $distApk $target --progress
Write-Host "Uploaded: $target"
