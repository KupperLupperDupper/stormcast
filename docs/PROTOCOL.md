# Stormcast protocol, version 3

How the phone-side server (`server/`) and the Windows app (`src-tauri/`) talk. Both sides test against [`protocol/vectors.txt`](../protocol/vectors.txt). Change the protocol, the vectors and both implementations in the same commit, and raise the version when an old and a new side can no longer talk.

## Starting the server

The app copies `stormcast-server.jar` to `/data/local/tmp/` and starts it through adb:

```
CLASSPATH=/data/local/tmp/stormcast-server.jar app_process / \
    com.stormitron.stormcast.server.Server 3 socket=stormcast_0123abcd audio=1
```

- The first argument is the protocol version. The server exits with code 2 if it is not its own.
- Options are `key=value`:
  - `socket` (required): the abstract Unix socket to connect to.
  - `max_size`: the long side of the video in pixels; `0`, the default, keeps the display size.
  - `bit_rate`: bits per second, default `8000000`.
  - `max_fps`: `0`, the default, means no limit.
  - `audio`: `1` starts audio capture at once; `0`, the default, waits for the app's audio message.
  - `tone`: `1` plays a short test tone on the device about a second after audio capture starts, for the smoke test; default `0`.
- Unknown options are an error, because the app and the server always ship together.
- The server deletes its jar as soon as it starts, so nothing is left on the device.

## Connection

The app listens on a local TCP port and maps it with `adb reverse localabstract:<socket> tcp:<port>`. The server connects to the abstract socket. The phone sends the stream below, and the app sends control messages the other way on the same connection.

All integers are big-endian. `f32` is an IEEE 754 single. Every message is `u8 type`, `u32 length`, then `length` bytes of payload, and a reader skips types it does not know.

## Stream from the phone

1. A 5-byte preamble: `STRM` and the protocol version as `u8`.
2. Messages:

| Type | Name | Payload |
|---|---|---|
| 1 | hello | UTF-8 JSON with `device`, `codec` (`"h264"`), `server` (its version), `android` and `sdk`. Always the first message. |
| 2 | session | `u32 width`, `u32 height`, `u8 rotation` (0–3). Starts a capture session, and comes again when the display rotates or changes size. |
| 3 | config | The codec configuration: H.264 SPS and PPS in Annex B. Comes before the first frame of each session. |
| 4 | frame | `u8 flags` (bit 0: key frame), `u64 pts` in microseconds, then the encoded frame in Annex B. Frames come in display order: the server turns B-frames off. |
| 5 | error | UTF-8 JSON with `code` and `message`. The server stops after sending it. Codes: `display_unavailable`, `encoder_failed`, `server_error`. |
| 6 | clipboard | UTF-8 text: the device's clipboard changed, for example after Copy. Not sent for text the server put there itself. |
| 7 | audio config | `u8 codec` (0: PCM, 16-bit signed little-endian, channels interleaved), `u32 sample rate`, `u8 channels`. Audio capture started; comes before its first audio message. |
| 8 | audio | `u64 pts` in microseconds, then the samples. |
| 9 | audio off | `u8 reason`: 0 the app turned audio off, 1 the device's Android is older than 12, 2 the device did not allow capture, 3 capture failed. Audio capture stopped. |

A payload is at most 64 MiB; a larger length means a broken stream.

- **Audio** is what the device plays, captured as 48 kHz stereo PCM. While capture runs, the device plays no sound itself; when it stops, the device plays its sound again.
- **Audio PTS** use the device's monotonic clock, as the frames' PTS do, so the app can measure and keep sound and picture in step. They count the samples and follow the device's audio timestamps slowly, because those jump when playback on the device starts or stops; after a pause in capture they jump ahead. They always increase.
- After an audio off with reason 1 to 3, capture stays off until the app turns it off and on again, which tries again.

## Control from the app

No preamble: the version was checked when the server started. The server injects the messages as input on the main display, in the order they arrive. Audio messages work also when the device does not allow input.

| Type | Name | Payload |
|---|---|---|
| 16 | touch | `u8 action` (0 down, 1 move, 2 up, 3 cancel), `u32 pointer`, `u16 x`, `u16 y`, `u16 width`, `u16 height`, `f32 pressure` (0–1). |
| 17 | key | `u8 action` (0 down, 1 up), `u32 keycode`, `u32 repeat`, `u32 meta state`. |
| 18 | text | UTF-8 text to type. |
| 19 | button | `u8 button`: 0 back, 1 home, 2 recent apps, 3 power. One press and release; power turns the screen on or off. |
| 20 | scroll | `u16 x`, `u16 y`, `u16 width`, `u16 height`, `f32 horizontal`, `f32 vertical`. |
| 21 | set clipboard | `u8 paste` (0 or 1), then UTF-8 text. Puts the text on the device's clipboard, and with paste 1 also pastes it. |
| 22 | audio | `u8 on` (0 or 1): starts or stops audio capture. The server answers with audio config or audio off. |

- **Positions** are pixels on the video: `x` and `y` on a video of `width` × `height`, the size in the current session message. The server scales them to the display. A position for another size was made before the display rotated, so the server drops it; an up or cancel then cancels the touch, so no finger stays down.
- **Touch:** `pointer` is the app's own id for a finger, the mouse or a pen. Up to 10 can be down at once. Cancel ends them all. A down for a pointer that is already down means its up was lost, so the server cancels the old touch before the new one starts.
- **Key:** `keycode` and `meta state` are Android's `KeyEvent.KEYCODE_*` and `META_*` values. `repeat` counts auto-repeat and is 0 on the first down.
- **Text:** typed with the keys of the device's virtual keyboard, accented letters as a dead key and a letter. Characters it has no keys for, such as æ, ø, å and emoji, are pasted through the device's clipboard, which then holds them.
- **Scroll:** in wheel notches, positive to the right and up, like Android's `AXIS_HSCROLL` and `AXIS_VSCROLL`.
- **Clipboard:** text only, at most 256 KiB of UTF-8, both ways. Because the server sends only changes it did not make, text from the app or from pasted characters never comes back.

A payload is at most 256 KiB and one byte; a larger length means a broken stream.

## Ending

The app ends a session by closing the connection; the server notices on its next write and exits. When the stream closes without an error message, the device ended it, for example because the cable was unplugged.
