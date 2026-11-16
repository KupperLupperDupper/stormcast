# Stormcast

Stormcast mirrors the screen of an Android device to a Windows PC over USB, and lets you control the device from the PC.

> **Status: early.** Stormcast shows and controls the screen and plays the device's sound. Wireless connections are planned.

## Install

Download the latest version from [Releases](https://github.com/KupperLupperDupper/stormcast/releases):

- `Stormcast-<version>-x64-setup.exe` installs Stormcast for your user. No administrator rights needed.
- `Stormcast-<version>-x64-portable.zip` runs without installing: unzip it and start `Stormcast.exe`.

The files are not code-signed yet, so Windows SmartScreen may warn the first time. `SHA256SUMS.txt` in each release lists the checksums, and you can check that a file was built by this repository's release workflow:

```powershell
gh attestation verify Stormcast-0.1.0-x64-setup.exe --repo KupperLupperDupper/stormcast
```

## Requirements

- Windows 10 or Windows 11, 64-bit. Windows 11 gets the glass design. Windows 10, and Windows 11 with transparency effects turned off, get a solid design.
- An Android device with USB debugging turned on. Built for Android 10 and later; tested on Android 16.

## Control

While mirroring, click or tap the screen to control the device:

- The mouse, touch and a pen tap and swipe. Several fingers work too, for example to pinch.
- The mouse wheel scrolls, and a right click is Back.
- The keyboard types while the screen has focus. Press Tab to leave the screen. Characters the device's built-in key map lacks, such as æ, ø, å and emoji, are pasted through the device's clipboard, which then holds them.
- Copy and paste work both ways: text you copy on the device lands on the PC's clipboard, and Ctrl+V on the screen pastes the PC's clipboard on the device. Text only, up to 256 KiB.
- Back, Home and Recent apps sit under the screen, like the phone's own nav bar. Power, sound and Stop mirroring are in the card's header; Power turns the screen on or off.
- Several devices can be mirrored at once: click each one in the list. Each gets a tab, and "Show all" puts them side by side. Only the device you use plays its sound on the PC.
- The full screen button or F11 shows the devices' screens in full screen, with the tabs kept above them. F11 again leaves full screen.
- A device locked with a PIN or password shows a black screen while mirroring, so Stormcast asks for the code in a row above it. It wakes the device, opens its code entry and types the code there. The code is not kept. A pattern must be drawn on the device itself.

## Sound

The device's sound plays on the PC while you mirror, and the device itself is silent meanwhile. The speaker button in the card's header turns sound on this PC off and gives it back to the device; Stormcast remembers the choice. Sound needs Android 12 or newer.

## How it works

1. Stormcast carries a small server for the phone (`server/`). When you start mirroring, it copies the server to the device with `adb` and starts it.
2. The server mirrors the screen into the device's hardware video encoder and sends H.264 back over the USB cable, using [Stormcast's own protocol](docs/PROTOCOL.md). It captures what the device plays and sends it as uncompressed PCM, which costs less than 2 Mbit/s and adds no encoding delay.
3. Stormcast decodes the video on the graphics card with WebCodecs and shows it, and plays the sound with Web Audio, a few tens of milliseconds ahead, on the same clock as the picture.
4. Your input goes the other way on the same connection, and the server injects it on the device.

Nothing is installed on the device, and the server deletes its file as soon as it starts.

## Build from source

You need Node.js 22 or later, Rust (stable, MSVC toolchain), the Visual Studio C++ build tools, JDK 17 or later, and the Android SDK with build-tools and a platform from API 30 up.

```powershell
npm ci
npm run tauri dev   # also builds the phone server
```

Checks, the same as CI runs:

```powershell
npm run build:server     # the phone server's protocol tests, then the server itself
npm run build            # TypeScript and the web UI
npm run check:contrast   # WCAG contrast of the colour tokens
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Smoke test on a connected, unlocked device. It mirrors the first ready device, opens Recent apps and goes Back, prints `STORMCAST_SMOKE_RESULT` with the time from input to picture, and exits:

```powershell
$env:STORMCAST_SMOKE = "1"; npm run tauri dev
```

Set `$env:STORMCAST_SKIN` to `"glass"` or `"solid"` to try either design on any Windows version.

## Releases

1. Describe the version for users in its own section of [CHANGELOG.md](CHANGELOG.md). The release notes come from there, and a release without a section stops before it builds.
2. Push a tag that matches the version in `package.json`:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

The [Release workflow](.github/workflows/release.yml) builds the installer and the portable zip, writes `SHA256SUMS.txt`, attests the build and publishes a GitHub release with the changelog section as notes. Run it by hand (Actions → Release → Run workflow) to build the files without publishing.

## License

[Apache License 2.0](LICENSE). Releases include Android platform tools; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
