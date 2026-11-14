# Stormcast protocol, version 1

How the phone-side server (`server/`) and the Windows app (`src-tauri/`) talk. Both sides test against [`protocol/vectors.txt`](../protocol/vectors.txt). Change the protocol, the vectors and both implementations in the same commit, and raise the version when an old and a new side can no longer talk.

## Starting the server

The app copies `stormcast-server.jar` to `/data/local/tmp/` and starts it through adb:

```
CLASSPATH=/data/local/tmp/stormcast-server.jar app_process / \
    com.stormitron.stormcast.server.Server 1 socket=stormcast_0123abcd
```

- The first argument is the protocol version. The server exits with code 2 if it is not its own.
- Options are `key=value`:
  - `socket` (required): the abstract Unix socket to connect to.
  - `max_size`: the long side of the video in pixels; `0`, the default, keeps the display size.
  - `bit_rate`: bits per second, default `8000000`.
  - `max_fps`: `0`, the default, means no limit.
- Unknown options are an error, because the app and the server always ship together.
- The server deletes its jar as soon as it starts, so nothing is left on the device.

## Connection

The app listens on a local TCP port and maps it with `adb reverse localabstract:<socket> tcp:<port>`. The server connects to the abstract socket. Everything goes from the phone to the app; in version 1 nothing goes the other way.

## Stream

All integers are big-endian.

1. A 5-byte preamble: `STRM` and the protocol version as `u8`.
2. Messages: `u8 type`, `u32 length`, then `length` bytes of payload. A reader skips types it does not know.

| Type | Name | Payload |
|---|---|---|
| 1 | hello | UTF-8 JSON with `device`, `codec` (`"h264"`), `server` (its version), `android` and `sdk`. Always the first message. |
| 2 | session | `u32 width`, `u32 height`, `u8 rotation` (0–3). Starts a capture session, and comes again when the display rotates or changes size. |
| 3 | config | The codec configuration: H.264 SPS and PPS in Annex B. Comes before the first frame of each session. |
| 4 | frame | `u8 flags` (bit 0: key frame), `u64 pts` in microseconds, then the encoded frame in Annex B. Frames come in display order: the server turns B-frames off. |
| 5 | error | UTF-8 JSON with `code` and `message`. The server stops after sending it. Codes: `display_unavailable`, `encoder_failed`, `server_error`. |

A payload is at most 64 MiB; a larger length means a broken stream.

## Ending

The app ends a session by closing the connection; the server notices on its next write and exits. When the stream closes without an error message, the device ended it, for example because the cable was unplugged.
