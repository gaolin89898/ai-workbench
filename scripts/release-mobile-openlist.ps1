param(
  [string]$Version,
  [string]$RemoteName = 'openlist-mobile',
  [string]$WebDavUrl = 'https://openlist.gaolin.xin/dav',
  [string]$RemotePath,
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
$rcloneConfig = Join-Path $root '.uploads/rclone.conf'

if (-not $RemotePath) {
  $RemotePath = [System.Uri]::UnescapeDataString(
    '%E5%A4%B8%E5%85%8B%E7%BD%91%E7%9B%98/%E7%A7%BB%E5%8A%A8%E7%AB%AF'
  )
}

if (-not $Version) {
  $pubspec = Get-Content -Raw -Path $pubspecPath
  if ($pubspec -notmatch '(?m)^version:\s*([^\r\n]+)') {
    throw "Cannot read version from $pubspecPath"
  }
  $Version = $Matches[1].Trim()
}

$versionName = ($Version -split '\+')[0]
$apkName = "codehub-ai-mobile-$versionName.apk"
$builtApk = Join-Path $mobileDir 'build/app/outputs/flutter-apk/app-release.apk'
$distApk = Join-Path $releaseDir $apkName
$manifestPath = Join-Path $releaseDir 'latest.json'

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
$apkUrlPath = [System.Uri]::EscapeDataString($apkName)
$manifest = [ordered]@{
  version = $versionName
  versionCode = ($Version -split '\+')[1]
  tagName = "mobile-v$versionName"
  apkFileName = $apkName
  apkUrl = "$WebDavUrl/$([System.Uri]::EscapeDataString($RemotePath).Replace('%2F', '/'))/$apkUrlPath"
  notes = "CodeHub AI mobile $versionName"
  updatedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
}
$manifestJson = $manifest | ConvertTo-Json
[System.IO.File]::WriteAllText(
  (Resolve-Path $manifestPath),
  $manifestJson,
  [System.Text.UTF8Encoding]::new($false)
)
Write-Host "APK ready: $distApk"
Write-Host "Manifest ready: $manifestPath"

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
New-Item -ItemType Directory -Force -Path (Split-Path $rcloneConfig) | Out-Null
try {
  $configDump = rclone --config $rcloneConfig config dump
  if ($configDump) {
    $config = $configDump | ConvertFrom-Json
    $remoteExists = $null -ne $config.PSObject.Properties[$RemoteName]
  }
} catch {
  $remoteExists = $false
}

if ($remoteExists) {
  rclone --config $rcloneConfig config update $RemoteName url $WebDavUrl vendor other user $User pass $obscuredPass | Out-Null
} else {
  rclone --config $rcloneConfig config create $RemoteName webdav url $WebDavUrl vendor other user $User pass $obscuredPass | Out-Null
}

$target = "${RemoteName}:$RemotePath/$apkName"
rclone --config $rcloneConfig copyto $distApk $target --progress
if ($LASTEXITCODE -ne 0) {
  throw "rclone upload failed with exit code $LASTEXITCODE"
}
Write-Host "Uploaded: $target"

$manifestTarget = "${RemoteName}:$RemotePath/latest.json"
rclone --config $rcloneConfig copyto $manifestPath $manifestTarget --progress
if ($LASTEXITCODE -ne 0) {
  throw "rclone manifest upload failed with exit code $LASTEXITCODE"
}
Write-Host "Uploaded: $manifestTarget"
