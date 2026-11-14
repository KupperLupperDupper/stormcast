# Stormcast

Stormcast mirrors the screen of an Android device to a Windows PC over USB.

> **Status: early.** Stormcast shows the screen. Mouse and keyboard control, audio and wireless connections are planned.

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
- An Android device with USB debugging turned on.

## How it works

1. Stormcast uses `adb` to copy the [scrcpy](https://github.com/Genymobile/scrcpy) server to the device and start it.
2. The server captures the screen and encodes it as H.264 with the device's hardware encoder.
3. The video travels over the USB cable, and Stormcast decodes it on the graphics card with WebCodecs.

Nothing is installed on the device, and the server deletes itself when mirroring stops.

## Build from source

You need Node.js 22 or later, Rust (stable, MSVC toolchain) and the Visual Studio C++ build tools.

```powershell
npm ci
npm run fetch-deps   # downloads the pinned scrcpy server and checks its SHA-256
npm run tauri dev
```

Checks, the same as CI runs:

```powershell
npm run build            # TypeScript and the web UI
npm run check:contrast   # WCAG contrast of the colour tokens
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Smoke test on a connected device. It mirrors the first ready device for a few seconds, prints `STORMCAST_SMOKE_RESULT` and exits:

```powershell
$env:STORMCAST_SMOKE = "1"; npm run tauri dev
```

Set `$env:STORMCAST_SKIN` to `"glass"` or `"solid"` to try either design on any Windows version.

## Releases

Push a tag that matches the version in `package.json`:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

The [Release workflow](.github/workflows/release.yml) builds the installer and the portable zip, writes `SHA256SUMS.txt`, attests the build and publishes a GitHub release. Run it by hand (Actions → Release → Run workflow) to build the files without publishing.

## License

[Apache License 2.0](LICENSE). Releases include the scrcpy server and Android platform tools; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
