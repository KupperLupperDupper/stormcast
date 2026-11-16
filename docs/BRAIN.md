# Brain: stormcast

The project map (PRJ-02): what the system is and where things are. It is imported in `CLAUDE.md` and loaded in every session, so it stays under 60 lines and points rather than explains. Status lives in [BACKLOG.md](BACKLOG.md) and [LOG.md](LOG.md), never here. If something is wrong, fix it in the same commit as the change.

## What it is
Windows app that mirrors and controls an Android screen over USB and plays the device's sound on the PC. Tauri 2: Rust in `src-tauri/`, TypeScript and CSS in `src/`, and our own phone server in Java in `server/`. More in [ARCHITECTURE.md](ARCHITECTURE.md); the user's side in [README.md](../README.md).

## Where things are
The Java code is in `server/src/main/java/com/stormitron/stormcast/server/`; the Java files below are there.

| If you need to … | See |
|---|---|
| understand the whole | [ARCHITECTURE.md](ARCHITECTURE.md) |
| know why something is the way it is | [DECISIONS.md](DECISIONS.md) |
| see what is in progress and what is next | [BACKLOG.md](BACKLOG.md) |
| continue the work from last time | the top entries in [LOG.md](LOG.md) |
| change the protocol | [PROTOCOL.md](PROTOCOL.md), `protocol/vectors.txt`, `Protocol.java` and `src-tauri/src/protocol.rs`, all in the same commit |
| capture screen, input, clipboard or sound on the device | `DisplayCapture.java`, `InputInjector.java` and `AudioCapture.java`: the only files with hidden Android APIs |
| turn the app's control messages into input on the device | `Controller.java` |
| tell the app the lock state, or unlock the device with its code (B-012) | `DeviceStateWatcher.java` and `Controller.unlock`; the web UI's row is `lockForm` in `src/main.ts` |
| send the sound and give it PTS on the picture's clock | `AudioStreamer.java` and `AudioTiming.java` |
| run a session: adb push, reverse tunnel, server start and video to the web UI | `src-tauri/src/mirror.rs`; the message format to the web UI is shared with `src/player.ts` |
| change the H.264 setup or the decoder's reordering | `src-tauri/src/h264.rs` |
| choose the skin (glass or solid) | `src-tauri/src/appearance.rs`: glass on Windows 11 build 22621+ with transparency turned on |
| decode and draw the picture | `src/player.ts`: WebCodecs and canvas; the newest frame wins |
| play the sound on the PC | `src/audio.ts`: Web Audio, blocks scheduled a little ahead, a buffer that grows on underrun, and sound-to-picture measurement |
| change full screen (B-003) | `setFullScreen` in `src/main.ts`, the `data-full-screen` rules in `app.css` and the window rights in `src-tauri/capabilities/default.json` |
| change mouse, touch, wheel or keyboard | `src/control.ts`; Rust encodes the messages in `src-tauri/src/protocol.rs` |
| change colours, spacing and other design values | `src/styles/tokens.css` (three layers, TOK-01, TOK-02); `src/styles/app.css` uses only layers 2 and 3 |
| change a text in the UI | `src/strings.ts` |
| see style, risks and deviations | [DESIGN-BRIEF.md](DESIGN-BRIEF.md) |
| release a version | [README.md](../README.md#releases) and the version's section in `CHANGELOG.md` |

## Run and test
- `npm run tauri dev`: run the app. It also builds the phone server.
- `npm run build:server`: the server's protocol tests and build; needs JDK 17+ and the Android SDK.
- `npm run build` and `npm run check:contrast`.
- In `src-tauri/`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test`.
- Smoke test on a connected, unlocked device: `$env:STORMCAST_SMOKE = "1"; npm run tauri dev`. It presses Recent apps and Back, listens for a test tone from the device and prints `STORMCAST_SMOKE_RESULT` with the time from input to picture and the sound's offset from the picture.
- `$env:STORMCAST_SKIN = "solid"` or `"glass"` forces a skin.
- Before committing, also `node ~/docs/projects/tools/check.mjs .`

## Gotchas
- The Java code is Java 8 syntax without libraries, but is built with JDK 17+.
- CI runs the same checks as above (`.github/workflows/ci.yml`).
- A lock screen with a code is black in the mirror. Open its code entry with a swipe up: `dismissKeyguard` gives a fingerprint prompt on some phones (OnePlus), where typed keys go nowhere.
- Only one `npm run tauri dev` can run at a time; stop the old one first. Its `adb shell` for the server can outlive it.
