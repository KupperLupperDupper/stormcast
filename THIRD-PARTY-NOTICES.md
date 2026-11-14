# Third-party notices

Stormcast releases include the software below. Its own licenses apply to those parts.

## scrcpy server

- Version 5.0.1, pinned with its SHA-256 in [`src-tauri/scrcpy-server.json`](src-tauri/scrcpy-server.json).
- Source: https://github.com/Genymobile/scrcpy
- Copyright Genymobile and Romain Vimont. Licensed under the Apache License 2.0; the license text is in [LICENSE](LICENSE).
- Used unmodified. It is copied to the Android device while mirroring and deletes itself afterwards.

## Android SDK Platform-Tools (adb)

- `adb.exe`, `AdbWinApi.dll` and `AdbWinUsbApi.dll` from Google's Android SDK Platform-Tools, bundled the same way the Windows release of scrcpy bundles them.
- Source: https://developer.android.com/tools/releases/platform-tools
- License: see `platform-tools/NOTICE.txt` in the release.

## Libraries

Stormcast is built with [Tauri](https://tauri.app) (MIT or Apache-2.0) and other open source Rust crates and npm packages. Their licenses are in each package's metadata, listed in `src-tauri/Cargo.lock` and `package-lock.json`.
