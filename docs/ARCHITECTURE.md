# Architecture: stormcast

The system as built (PRJ-06), after arc42 and C4 in short form. The why is in [DECISIONS.md](DECISIONS.md), and what is in progress in [BACKLOG.md](BACKLOG.md). Updated in the same commit as a change to layers or folders.

## 1. Purpose and context
Stormcast mirrors the screen of an Android device to a Windows PC over a USB cable, lets the user control the device from the PC and plays the device's sound on the PC. It talks to the user at the PC and to the Android device (USB debugging turned on) through `adb`, which ships with releases. Nothing is installed on the device. A wireless connection is planned (B-004).

## 2. Building blocks
```text
Android device                 USB (adb reverse)   Windows PC, Tauri 2
server/ (Java, app_process)  <================>  src-tauri/ (Rust)  <== IPC ==>  src/ (TypeScript, web UI)
captures screen and sound,                        adb, session,                  WebCodecs and canvas,
injects input                                     protocol, H.264                Web Audio, input
```
- **The phone server** (`server/`): Java 8 syntax without libraries, copied to the device and started with `app_process`; it deletes its jar at start. Hidden Android APIs only in `DisplayCapture.java`, `InputInjector.java` and `AudioCapture.java`, each with a fallback (ADR-002).
- **The Rust core** (`src-tauri/`): `mirror.rs` runs one session: adb push, `adb reverse` to a local TCP port, server start and the video stream to the web UI. `protocol.rs` is the app's side of the protocol, `h264.rs` tells the decoder there is no reordering (ADR-003), and `appearance.rs` chooses the skin.
- **The web UI** (`src/`): `player.ts` decodes with WebCodecs and draws on canvas, `audio.ts` plays the sound with Web Audio, and `control.ts` turns input into control messages. It talks to the Rust core through Tauri's IPC (`ipc.ts`).

## 3. Structure
```text
server/      the phone server (Java) and its protocol test
src-tauri/   the Rust core, the Tauri configuration and the icons
src/         the web UI; the design values in src/styles/tokens.css
protocol/    the test vectors shared by the Java and Rust tests
scripts/     server build, adb download, contrast check and release notes
docs/        BRAIN, BACKLOG, LOG, ARCHITECTURE, DECISIONS, PROTOCOL and DESIGN-BRIEF
.github/     CI, release workflow and Dependabot
```

## 4. Data and flow
- **Picture:** the screen → the device's hardware encoder → H.264 without B-frames → the protocol over USB → WebCodecs on the graphics card → canvas, where the newest frame wins.
- **Sound:** what the device plays → 48 kHz stereo PCM with PTS on the picture's clock (ADR-004) → Web Audio, scheduled a few tens of milliseconds ahead.
- **Input and clipboard:** the web UI → control messages → Rust encodes them → the server injects them. Text copied on the device comes back to the PC's clipboard (at most 256 KiB).
- **Device details (B-008):** `diagnostics.rs` runs one `adb shell` script every ten seconds while mirroring (build properties, `wm`, `dumpsys battery`, `/proc` and `df`) and parses it; the web UI adds the stream's own numbers. No server and no hidden APIs.
- **Lock state and unlocking (B-012):** `DeviceStateWatcher.java` polls whether the screen is on and the device locked and sends it when it changes. A lock screen with a code shows black in the mirror, so the web UI asks for the code, and the server wakes the screen, swipes up and types the code as key presses, never through the clipboard or the log.
- **The protocol** is version 3 and described in [PROTOCOL.md](PROTOCOL.md): every message is type, length and payload, and unknown types are skipped.
- Nothing is stored on the device. The app remembers whether sound plays on the PC.

## 5. Quality requirements
- First frame after about a second (0.1.0; 1.3 s on a real tablet, ADR-003).
- Sound in sync with the picture (the ui-rulebook's PERF-06). The smoke test measures the time from input to picture and the sound's offset (`STORMCAST_SMOKE_RESULT`).
- The phone picture never sits under glass or any other layer.
- The UI follows the UI rulebook; contrast is checked with `npm run check:contrast`.

## 6. Build, test and operations
- The commands are in [BRAIN.md](BRAIN.md), and CI (`.github/workflows/ci.yml`) runs the same checks.
- Release: the tag `vX.Y.Z` matches `version` in `package.json`. `release.yml` builds the installer and the portable zip, writes `SHA256SUMS.txt`, attests the build and publishes with the version's section in `CHANGELOG.md` as notes.
- The files are not code-signed yet (B-006).

## 7. Risks and technical debt
- Hidden Android APIs can change from version to version; that is why they live in three files with a fallback (ADR-002).
- Without code signing, SmartScreen warns the first time (B-006).

## 8. Glossary
- **Server:** the phone server in `server/`, not a network server.
- **Session:** one capture with a given size and rotation; it starts again when the screen rotates or changes size.
- **Skin:** glass or solid (`appearance.rs`).
- **PTS:** presentation timestamp; sound and picture use the same clock.
- **Smoke test:** `STORMCAST_SMOKE=1`, which measures input to picture and the sound's offset on a connected device.
