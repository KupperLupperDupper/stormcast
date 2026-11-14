//! The Stormcast protocol between the phone-side server (`server/`) and this app, specified
//! in `docs/PROTOCOL.md`. Both sides test against `protocol/vectors.txt`.
//!
//! The phone sends a 5-byte preamble (`STRM` and the version), then messages of
//! `[u8 type][u32 length][payload]`. Integers are big-endian. Unknown types are skipped.

use crate::error::AppError;
use serde::Deserialize;

pub const VERSION: u8 = 1;
pub const PREAMBLE_LEN: usize = 5;
pub const HEADER_LEN: usize = 5;
const MAGIC: &[u8; 4] = b"STRM";
/// A larger message means a broken stream; refuse it instead of allocating.
const MAX_PAYLOAD: u32 = 64 * 1024 * 1024;

pub const TYPE_HELLO: u8 = 1;
pub const TYPE_SESSION: u8 = 2;
pub const TYPE_CONFIG: u8 = 3;
pub const TYPE_FRAME: u8 = 4;
pub const TYPE_ERROR: u8 = 5;

/// Flags and PTS in front of a frame's data.
const FRAME_PREFIX_LEN: usize = 9;
const FLAG_KEY_FRAME: u8 = 1;

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
            check_preamble(b"XTRM\x01").unwrap_err().code,
            "server_failed"
        );
        assert_eq!(
            check_preamble(b"STRM\x02").unwrap_err().code,
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
}
