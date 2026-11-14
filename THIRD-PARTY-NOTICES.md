# Third-party notices

Stormcast releases include the software below. Its own licenses apply to those parts.

## Android SDK Platform-Tools (adb)

- `adb.exe`, `AdbWinApi.dll` and `AdbWinUsbApi.dll` from Google's Android SDK Platform-Tools.
- Source: https://developer.android.com/tools/releases/platform-tools
- License: see `platform-tools/NOTICE.txt` in the release.

## Libraries

Stormcast is built with [Tauri](https://tauri.app) (MIT or Apache-2.0) and other open source Rust crates and npm packages. Their licenses are in each package's metadata, listed in `src-tauri/Cargo.lock` and `package-lock.json`.

## Acknowledgement

Stormcast's phone-side server is its own code. The open source server of [scrcpy](https://github.com/Genymobile/scrcpy) (Apache License 2.0) was the reference for which Android APIs work on which Android versions. Stormcast is an independent project and is not affiliated with or endorsed by Genymobile or the scrcpy project.
