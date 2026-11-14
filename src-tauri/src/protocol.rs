//! The Stormcast protocol between the phone-side server (`server/`) and this app, specified
//! in `docs/PROTOCOL.md`. Both sides test against `protocol/vectors.txt`.
//!
//! The phone sends a 5-byte preamble (`STRM` and the version), then messages of
//! `[u8 type][u32 length][payload]`. The app sends control messages with the same framing on the
//! same connection. Integers are big-endian. Unknown types are skipped.

use crate::error::AppError;
use serde::Deserialize;

pub const VERSION: u8 = 2;
pub const PREAMBLE_LEN: usize = 5;
pub const HEADER_LEN: usize = 5;
const MAGIC: &[u8; 4] = b"STRM";
/// A larger message means a broken stream; refuse it instead of allocating.
const MAX_PAYLOAD: u32 = 64 * 1024 * 1024;

// From the phone to the app.
pub const TYPE_HELLO: u8 = 1;
pub const TYPE_SESSION: u8 = 2;
pub const TYPE_CONFIG: u8 = 3;
pub const TYPE_FRAME: u8 = 4;
pub const TYPE_ERROR: u8 = 5;
pub const TYPE_CLIPBOARD: u8 = 6;

/// Flags and PTS in front of a frame's data.
const FRAME_PREFIX_LEN: usize = 9;
const FLAG_KEY_FRAME: u8 = 1;

// From the app to the phone.
const TYPE_TOUCH: u8 = 16;
const TYPE_KEY: u8 = 17;
const TYPE_TEXT: u8 = 18;
const TYPE_BUTTON: u8 = 19;
const TYPE_SCROLL: u8 = 20;
const TYPE_SET_CLIPBOARD: u8 = 21;
/// Clipboard text in either direction, in UTF-8 bytes.
pub const MAX_CLIPBOARD: usize = 256 * 1024;
/// The server refuses larger control messages.
const MAX_CONTROL_PAYLOAD: usize = MAX_CLIPBOARD + 1;
/// Android's `KeyEvent.KEYCODE_PASTE`.
pub const KEYCODE_PASTE: u32 = 279;

pub fn check_preamble(bytes: &[u8; PREAMBLE_LEN]) -> Result<(), AppError> {
    if &bytes[..4] != MAGIC {
        return Err(AppError::new(
            "server_failed",
            "the device sent something that is not a Stormcast stream",
        ));
    }
    if bytes[4] != VERSION {
        return Err(AppError::new(
            "protocol_mismatch",
            format!("the server speaks protocol {}, the app {VERSION}", bytes[4]),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub kind: u8,
    pub length: u32,
}

pub fn parse_header(bytes: &[u8; HEADER_LEN]) -> Result<Header, AppError> {
    let length = u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
    if length > MAX_PAYLOAD {
        return Err(AppError::new(
            "bad_stream",
            format!("message of {length} bytes"),
        ));
    }
    Ok(Header {
        kind: bytes[0],
        length,
    })
}

/// The first message. Unknown fields are ignored, so the server can add more.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Hello {
    pub device: String,
    pub codec: String,
    pub server: String,
}

pub fn parse_hello(payload: &[u8]) -> Result<Hello, AppError> {
    serde_json::from_slice(payload)
        .map_err(|error| AppError::new("bad_stream", format!("hello: {error}")))
}

/// A new capture session, for example after rotation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Session {
    pub width: u32,
    pub height: u32,
    pub rotation: u8,
}

pub fn parse_session(payload: &[u8]) -> Result<Session, AppError> {
    if payload.len() < 9 {
        return Err(too_short("session"));
    }
    Ok(Session {
        width: be32(&payload[0..4]),
        height: be32(&payload[4..8]),
        rotation: payload[8],
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Frame<'a> {
    pub key_frame: bool,
    /// Presentation time in microseconds.
    pub pts: u64,
    /// The encoded frame, Annex B.
    pub data: &'a [u8],
}

pub fn parse_frame(payload: &[u8]) -> Result<Frame<'_>, AppError> {
    if payload.len() < FRAME_PREFIX_LEN {
        return Err(too_short("frame"));
    }
    let mut pts = [0u8; 8];
    pts.copy_from_slice(&payload[1..FRAME_PREFIX_LEN]);
    Ok(Frame {
        key_frame: payload[0] & FLAG_KEY_FRAME != 0,
        pts: u64::from_be_bytes(pts),
        data: &payload[FRAME_PREFIX_LEN..],
    })
}

/// The server's last message before it stops.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ServerError {
    pub code: String,
    pub message: String,
}

pub fn parse_error(payload: &[u8]) -> ServerError {
    serde_json::from_slice(payload).unwrap_or_else(|_| ServerError {
        code: "server_error".into(),
        message: String::from_utf8_lossy(payload).into_owned(),
    })
}

impl From<ServerError> for AppError {
    fn from(error: ServerError) -> Self {
        // Known codes have their own text in the UI (src/strings.ts).
        let code = match error.code.as_str() {
            "display_unavailable" => "display_unavailable",
            "encoder_failed" => "encoder_failed",
            _ => "server_error",
        };
        AppError::new(code, format!("{}: {}", error.code, error.message))
    }
}

/// A control message from the web view (`src/control.ts`) for the device.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Control {
    /// A finger, the mouse or a pen at pixel `x`, `y` on a video of `width` × `height`.
    Touch {
        action: TouchAction,
        pointer: u32,
        x: u16,
        y: u16,
        width: u16,
        height: u16,
        pressure: f32,
    },
    /// Android's keycode and meta state; `repeat` counts auto-repeat.
    Key {
        action: KeyAction,
        keycode: u32,
        repeat: u32,
        meta_state: u32,
    },
    Text {
        text: String,
    },
    Button {
        button: Button,
    },
    /// Wheel notches at pixel `x`, `y`, positive to the right and up.
    Scroll {
        x: u16,
        y: u16,
        width: u16,
        height: u16,
        h_scroll: f32,
        v_scroll: f32,
    },
    /// Text for the device's clipboard, pasted too when `paste` is set.
    SetClipboard {
        text: String,
        paste: bool,
    },
    /// Ctrl+V in the web view: the app turns it into `SetClipboard` with the PC's text before
    /// sending, because only the app can read the PC's clipboard.
    Paste,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TouchAction {
    Down = 0,
    Move = 1,
    Up = 2,
    Cancel = 3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyAction {
    Down = 0,
    Up = 1,
}

/// Android's navigation buttons and the power button.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Button {
    Back = 0,
    Home = 1,
    RecentApps = 2,
    Power = 3,
}

impl Control {
    /// Appends the message as `[u8 type][u32 length][payload]`.
    pub fn encode(&self, out: &mut Vec<u8>) -> Result<(), AppError> {
        match self {
            Self::Touch {
                action,
                pointer,
                x,
                y,
                width,
                height,
                pressure,
            } => {
                put_header(out, TYPE_TOUCH, 17);
                out.push(*action as u8);
                out.extend_from_slice(&pointer.to_be_bytes());
                put_position(out, [*x, *y, *width, *height]);
                out.extend_from_slice(&pressure.to_be_bytes());
            }
            Self::Key {
                action,
                keycode,
                repeat,
                meta_state,
            } => {
                put_header(out, TYPE_KEY, 13);
                out.push(*action as u8);
                for value in [keycode, repeat, meta_state] {
                    out.extend_from_slice(&value.to_be_bytes());
                }
            }
            Self::Text { text } => {
                if text.len() > MAX_CONTROL_PAYLOAD {
                    return Err(AppError::new(
                        "bad_control",
                        format!("text of {} bytes", text.len()),
                    ));
                }
                put_header(out, TYPE_TEXT, text.len());
                out.extend_from_slice(text.as_bytes());
            }
            Self::Button { button } => {
                put_header(out, TYPE_BUTTON, 1);
                out.push(*button as u8);
            }
            Self::Scroll {
                x,
                y,
                width,
                height,
                h_scroll,
                v_scroll,
            } => {
                put_header(out, TYPE_SCROLL, 16);
                put_position(out, [*x, *y, *width, *height]);
                out.extend_from_slice(&h_scroll.to_be_bytes());
                out.extend_from_slice(&v_scroll.to_be_bytes());
            }
            Self::SetClipboard { text, paste } => {
                if text.len() > MAX_CLIPBOARD {
                    return Err(AppError::new(
                        "clipboard_too_large",
                        format!("clipboard text of {} bytes", text.len()),
                    ));
                }
                put_header(out, TYPE_SET_CLIPBOARD, 1 + text.len());
                out.push(u8::from(*paste));
                out.extend_from_slice(text.as_bytes());
            }
            Self::Paste => {
                return Err(AppError::new(
                    "bad_control",
                    "paste becomes set clipboard before it is sent",
                ));
            }
        }
        Ok(())
    }
}

/// Text the device copied. The server sends valid UTF-8; anything else is shown as it is.
pub fn parse_clipboard(payload: &[u8]) -> String {
    String::from_utf8_lossy(payload).into_owned()
}

fn put_header(out: &mut Vec<u8>, kind: u8, length: usize) {
    out.push(kind);
    out.extend_from_slice(&u32::try_from(length).unwrap_or(u32::MAX).to_be_bytes());
}

/// `x`, `y`, `width` and `height` as `u16`.
fn put_position(out: &mut Vec<u8>, values: [u16; 4]) {
    for value in values {
        out.extend_from_slice(&value.to_be_bytes());
    }
}

fn be32(bytes: &[u8]) -> u32 {
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

fn too_short(what: &str) -> AppError {
    AppError::new("bad_stream", format!("{what} message is too short"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTORS: &str = include_str!("../../protocol/vectors.txt");

    /// The bytes of a named vector in protocol/vectors.txt, which the Java tests also check.
    fn vector(name: &str) -> Vec<u8> {
        let hex = VECTORS
            .lines()
            .filter(|line| !line.trim_start().starts_with('#'))
            .find_map(|line| {
                let (key, hex) = line.split_once('|')?;
                (key.trim() == name).then_some(hex)
            })
            .unwrap_or_else(|| panic!("no vector {name}"));
        let digits: Vec<u8> = hex.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
        digits
            .chunks(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }

    /// Splits a message vector into its header and payload.
    fn message(name: &str) -> (Header, Vec<u8>) {
        let bytes = vector(name);
        let header = parse_header(bytes[..HEADER_LEN].try_into().unwrap()).unwrap();
        assert_eq!(
            header.length as usize,
            bytes.len() - HEADER_LEN,
            "{name} length"
        );
        (header, bytes[HEADER_LEN..].to_vec())
    }

    #[test]
    fn accepts_the_preamble() {
        check_preamble(vector("preamble").as_slice().try_into().unwrap()).unwrap();
    }

    #[test]
    fn rejects_a_wrong_magic_or_version() {
        assert_eq!(
            check_preamble(b"XTRM\x02").unwrap_err().code,
            "server_failed"
        );
        assert_eq!(
            check_preamble(b"STRM\x01").unwrap_err().code,
            "protocol_mismatch"
        );
    }

    #[test]
    fn decodes_hello() {
        let (header, payload) = message("hello");
        assert_eq!(header.kind, TYPE_HELLO);
        assert_eq!(
            parse_hello(&payload).unwrap(),
            Hello {
                device: "Lenovo TB311FU".into(),
                codec: "h264".into(),
                server: "0.1.0".into()
            }
        );
    }

    #[test]
    fn decodes_session() {
        let (header, payload) = message("session");
        assert_eq!(header.kind, TYPE_SESSION);
        assert_eq!(
            parse_session(&payload).unwrap(),
            Session {
                width: 1200,
                height: 1920,
                rotation: 1
            }
        );
    }

    #[test]
    fn decodes_config() {
        let (header, payload) = message("config");
        assert_eq!(header.kind, TYPE_CONFIG);
        assert_eq!(
            crate::h264::codec_string(&payload).as_deref(),
            Some("avc1.64002A")
        );
    }

    #[test]
    fn decodes_frames() {
        let (header, payload) = message("frame_key");
        assert_eq!(header.kind, TYPE_FRAME);
        assert_eq!(
            parse_frame(&payload).unwrap(),
            Frame {
                key_frame: true,
                pts: 1_234_567,
                data: &[0, 0, 0, 1, 0x65, 0x88]
            }
        );
        let (_, payload) = message("frame_delta");
        assert_eq!(
            parse_frame(&payload).unwrap(),
            Frame {
                key_frame: false,
                pts: 1_251_234,
                data: &[0, 0, 0, 1, 0x41, 0x9a]
            }
        );
    }

    #[test]
    fn decodes_errors() {
        let (header, payload) = message("error");
        assert_eq!(header.kind, TYPE_ERROR);
        let error = parse_error(&payload);
        assert_eq!(error.code, "encoder_failed");
        assert_eq!(error.message, "No H.264 encoder\n\"quoted\" é");
        assert_eq!(AppError::from(error).code, "encoder_failed");
        assert_eq!(
            AppError::from(parse_error(b"not json")).code,
            "server_error"
        );
    }

    #[test]
    fn refuses_oversized_and_short_messages() {
        assert!(parse_header(&[TYPE_FRAME, 0xff, 0xff, 0xff, 0xff]).is_err());
        assert!(parse_session(&[0; 8]).is_err());
        assert!(parse_frame(&[0; 8]).is_err());
    }

    #[test]
    fn encodes_control_messages() {
        let touch = |action, pointer, x, y, pressure| Control::Touch {
            action,
            pointer,
            x,
            y,
            width: 1200,
            height: 1920,
            pressure,
        };
        let button = |button| Control::Button { button };
        let cases = [
            ("touch_down", touch(TouchAction::Down, 1, 600, 960, 1.0)),
            (
                "touch_up",
                touch(TouchAction::Up, 0xffff_fffe, 1199, 0, 0.5),
            ),
            (
                "key_down",
                Control::Key {
                    action: KeyAction::Down,
                    keycode: 29,
                    repeat: 2,
                    meta_state: 0x3000,
                },
            ),
            (
                "key_up",
                Control::Key {
                    action: KeyAction::Up,
                    keycode: 66,
                    repeat: 0,
                    meta_state: 0,
                },
            ),
            (
                "text",
                Control::Text {
                    text: "Hi é😀".into(),
                },
            ),
            ("button_back", button(Button::Back)),
            ("button_home", button(Button::Home)),
            ("button_recent_apps", button(Button::RecentApps)),
            ("button_power", button(Button::Power)),
            (
                "set_clipboard",
                Control::SetClipboard {
                    text: "Hej på dig".into(),
                    paste: true,
                },
            ),
            (
                "scroll",
                Control::Scroll {
                    x: 600,
                    y: 960,
                    width: 1200,
                    height: 1920,
                    h_scroll: 0.25,
                    v_scroll: -1.0,
                },
            ),
        ];
        for (name, control) in cases {
            let mut bytes = Vec::new();
            control.encode(&mut bytes).unwrap();
            assert_eq!(bytes, vector(name), "{name}");
        }
    }

    #[test]
    fn reads_control_messages_from_the_web_view() {
        let json = r#"[
            {"type":"touch","action":"cancel","pointer":3,"x":1,"y":2,"width":1200,"height":1920,"pressure":0.5},
            {"type":"key","action":"up","keycode":66,"repeat":0,"metaState":4096},
            {"type":"text","text":"æøå"},
            {"type":"button","button":"recentApps"},
            {"type":"scroll","x":1,"y":2,"width":1200,"height":1920,"hScroll":0,"vScroll":-1}
        ]"#;
        let messages: Vec<Control> = serde_json::from_str(json).unwrap();
        assert_eq!(
            messages,
            [
                Control::Touch {
                    action: TouchAction::Cancel,
                    pointer: 3,
                    x: 1,
                    y: 2,
                    width: 1200,
                    height: 1920,
                    pressure: 0.5
                },
                Control::Key {
                    action: KeyAction::Up,
                    keycode: 66,
                    repeat: 0,
                    meta_state: 4096
                },
                Control::Text {
                    text: "æøå".into()
                },
                Control::Button {
                    button: Button::RecentApps
                },
                Control::Scroll {
                    x: 1,
                    y: 2,
                    width: 1200,
                    height: 1920,
                    h_scroll: 0.0,
                    v_scroll: -1.0
                },
            ]
        );
    }

    #[test]
    fn refuses_text_the_server_would_refuse() {
        let text = Control::Text {
            text: "a".repeat(MAX_CONTROL_PAYLOAD + 1),
        };
        assert_eq!(
            text.encode(&mut Vec::new()).unwrap_err().code,
            "bad_control"
        );
        let clip = Control::SetClipboard {
            text: "a".repeat(MAX_CLIPBOARD + 1),
            paste: false,
        };
        assert_eq!(
            clip.encode(&mut Vec::new()).unwrap_err().code,
            "clipboard_too_large"
        );
        assert!(Control::Paste.encode(&mut Vec::new()).is_err());
    }

    #[test]
    fn decodes_the_device_clipboard() {
        let (header, payload) = message("clipboard");
        assert_eq!(header.kind, TYPE_CLIPBOARD);
        assert_eq!(parse_clipboard(&payload), "Hej på dig");
        let paste: Control = serde_json::from_str(r#"{"type":"paste"}"#).unwrap();
        assert_eq!(paste, Control::Paste);
    }
}
