# Mobile release signing

Android APK updates only work when every release is signed with the same release key.

The mobile app now requires a release keystore for `flutter build apk --release`. This avoids accidentally publishing a debug-signed or throwaway-signed APK that cannot update the previously installed app.

## Local signing files

The generated release key is stored outside the repository:

- Keystore: `/home/gl/.ai-workbench-release/ai-workbench-mobile-release.jks`
- GitHub secrets reference: `/home/gl/.ai-workbench-release/mobile-signing-secrets.txt`
- Local Gradle config: `apps/mobile/android/key.properties`

The local `key.properties` file is intentionally ignored by Git.

## GitHub Actions secrets

Add these repository secrets before pushing a new `mobile-v*` tag:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

The release workflow restores the keystore from those secrets, builds `app-release.apk`, and uploads it to the GitHub Release.

## First signed release note

`mobile-v0.1.2` and earlier may have been built with debug or inconsistent signing. Android treats those as a different app signature, so the first formally signed APK may not install over an old APK.

If that happens, uninstall the old mobile app once, then install the new signed APK. Future APKs signed with this same key can update normally.

## Current release line

The next signed mobile release should use:

- App version: `0.1.3+4`
- Git tag: `mobile-v0.1.3`

