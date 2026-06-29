param(
  [switch]$NoRun
)

$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$mobileDir = Join-Path $root 'apps/mobile'
$androidSdk = Join-Path $env:LOCALAPPDATA 'Android/Sdk'
$flutterDir = Join-Path $env:USERPROFILE 'flutter'
$avdName = 'ai_workbench_api35'

$env:ANDROID_HOME = $androidSdk
$env:ANDROID_SDK_ROOT = $androidSdk
$env:ANDROID_AVD_HOME = Join-Path $env:USERPROFILE '.android/avd'
$env:PUB_HOSTED_URL = 'https://pub.flutter-io.cn'
$env:FLUTTER_STORAGE_BASE_URL = 'https://storage.flutter-io.cn'
$env:Path = @(
  (Join-Path $flutterDir 'bin'),
  (Join-Path $androidSdk 'platform-tools'),
  (Join-Path $androidSdk 'cmdline-tools/latest/bin'),
  (Join-Path $androidSdk 'emulator'),
  $env:Path
) -join ';'

function Test-AndroidDevice {
  $devices = adb devices
  return ($devices -join "`n") -match 'emulator-\d+\s+device'
}

if (-not (Test-AndroidDevice)) {
  Start-Process -FilePath (Join-Path $androidSdk 'emulator/emulator.exe') `
    -ArgumentList @('-avd', $avdName, '-netdelay', 'none', '-netspeed', 'full') `
    -WindowStyle Hidden

  $deadline = (Get-Date).AddMinutes(5)
  do {
    Start-Sleep -Seconds 5
  } while ((Get-Date) -lt $deadline -and -not (Test-AndroidDevice))
}

Set-Location $mobileDir
flutter pub get

if (-not $NoRun) {
  flutter run -d emulator-5554
}
