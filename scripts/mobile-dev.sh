#!/usr/bin/env bash
set -euo pipefail

NO_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-run) NO_RUN=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MOBILE_DIR="$ROOT_DIR/apps/mobile"

ANDROID_SDK="${HOME}/Android/Sdk"
FLUTTER_DIR="${HOME}/development/flutter"
AVD_NAME="Pixel_6"

export ANDROID_HOME="$ANDROID_SDK"
export ANDROID_SDK_ROOT="$ANDROID_SDK"
export ANDROID_AVD_HOME="${HOME}/.android/avd"
export PUB_HOSTED_URL="https://pub.flutter-io.cn"
export FLUTTER_STORAGE_BASE_URL="https://storage.flutter-io.cn"

export PATH="$FLUTTER_DIR/bin:$ANDROID_SDK/platform-tools:$ANDROID_SDK/cmdline-tools/latest/bin:$ANDROID_SDK/emulator:$PATH"

has_android_device() {
  adb devices 2>/dev/null | grep -qE 'emulator-[0-9]+\s+device'
}

if ! has_android_device; then
  "$ANDROID_SDK/emulator/emulator" -avd "$AVD_NAME" -netdelay none -netspeed full -gpu swiftshader_indirect &
  disown

  DEADLINE=$((SECONDS + 300))
  while [[ $SECONDS -lt $DEADLINE ]]; do
    if has_android_device; then
      break
    fi
    sleep 5
  done

  if ! has_android_device; then
    echo "Emulator failed to start within 5 minutes"
    exit 1
  fi
fi

cd "$MOBILE_DIR"
flutter pub get

if [ "$NO_RUN" = false ]; then
  flutter run -d emulator-5554
fi
