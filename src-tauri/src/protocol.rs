//! The scrcpy 5.0.1 video protocol, as the server writes it in
//! `server/src/main/java/com/genymobile/scrcpy/device/Streamer.java` and
//! `DesktopConnection.java`. It changes between scrcpy versions, so this module must
//! follow the version pinned in `scrcpy-server.json`.
//!
//! Video socket: device name (64 bytes, first socket only), codec id (u32), then a
//! stream of 12-byte headers, each followed by its payload. Integers are big-endian.

use crate::error::AppError;

pub const DEVICE_NAME_LEN: usize = 64;
pub const HEADER_LEN: usize = 12;
pub const CODEC_H264: u32 = 0x6832_3634; // "h264"

const FLAG_SESSION: u64 = 1 << 63;
const FLAG_CONFIG: u64 = 1 << 62;
const FLAG_KEY_FRAME: u64 = 1 << 61;
const PTS_MASK: u64 = FLAG_KEY_FRAME - 1;
/// A larger packet means a broken stream; refuse it instead of allocating.
const MAX_PACKET_SIZE: u32 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Header {
    /// A new capture session (for example after rotation) with the size of the coming frames.
    Session {
        width: u32,
        height: u32,
        client_resized: bool,
    },
    /// Encoder output: a config packet (SPS/PPS) or a frame. `size` bytes follow.
    Media {
        config: bool,
        key_frame: bool,
        pts: u64,
        size: u32,
    },
}

pub fn parse_header(bytes: &[u8; HEADER_LEN]) -> Result<Header, AppError> {
    let be32 =
        |at: usize| u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    let first = u64::from_be_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    ]);
    if first & FLAG_SESSION != 0 {
        return Ok(Header::Session {
            width: be32(4),
            height: be32(8),
            client_resized: bytes[3] & 1 == 1,
        });
    }
    let size = be32(8);
    if size > MAX_PACKET_SIZE {
        return Err(AppError::new(
            "bad_stream",
            format!("packet of {size} bytes"),
        ));
    }
    Ok(Header::Media {
        config: first & FLAG_CONFIG != 0,
        key_frame: first & FLAG_KEY_FRAME != 0,
        pts: first & PTS_MASK,
        size,
    })
}

/// The device name is UTF-8, padded with NUL bytes.
pub fn parse_device_name(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

pub fn codec_name(id: u32) -> Option<&'static str> {
    match id {
        CODEC_H264 => Some("h264"),
        0x6832_3635 => Some("h265"),
        0x0061_7631 => Some("av1"),
        0x0076_7038 => Some("vp8"),
        0x0076_7039 => Some("vp9"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(first: [u8; 8], last: u32) -> [u8; HEADER_LEN] {
        let mut bytes = [0u8; HEADER_LEN];
        bytes[..8].copy_from_slice(&first);
        bytes[8..].copy_from_slice(&last.to_be_bytes());
        bytes
    }

    #[test]
    fn parses_a_session_packet() {
        let mut first = [0u8; 8];
        first[0] = 0x80;
        first[4..].copy_from_slice(&1200u32.to_be_bytes());
        assert_eq!(
            parse_header(&header(first, 1920)).unwrap(),
            Header::Session {
                width: 1200,
                height: 1920,
                client_resized: false
            }
        );
    }

    #[test]
    fn reads_the_client_resized_flag() {
        let mut first = [0u8; 8];
        first[0] = 0x80;
        first[3] = 1;
        assert!(matches!(
            parse_header(&header(first, 0)).unwrap(),
            Header::Session {
                client_resized: true,
                ..
            }
        ));
    }

    #[test]
    fn parses_a_config_packet() {
        assert_eq!(
            parse_header(&header(FLAG_CONFIG.to_be_bytes(), 27)).unwrap(),
            Header::Media {
                config: true,
                key_frame: false,
                pts: 0,
                size: 27
            }
        );
    }

    #[test]
    fn parses_a_key_frame_and_its_pts() {
        let first = FLAG_KEY_FRAME | 1_234_567;
        assert_eq!(
            parse_header(&header(first.to_be_bytes(), 50_000)).unwrap(),
            Header::Media {
                config: false,
                key_frame: true,
                pts: 1_234_567,
                size: 50_000
            }
        );
    }

    #[test]
    fn keeps_the_full_61_bit_pts() {
        let first = PTS_MASK;
        assert!(matches!(
            parse_header(&header(first.to_be_bytes(), 1)).unwrap(),
            Header::Media { config: false, key_frame: false, pts, .. } if pts == PTS_MASK
        ));
    }

    #[test]
    fn refuses_oversized_packets() {
        assert!(parse_header(&header([0; 8], u32::MAX)).is_err());
    }

    #[test]
    fn reads_the_device_name() {
        let mut bytes = [0u8; DEVICE_NAME_LEN];
        bytes[..7].copy_from_slice(b"TB311FU");
        assert_eq!(parse_device_name(&bytes), "TB311FU");
        assert_eq!(
            parse_device_name(&[b'a'; DEVICE_NAME_LEN]).len(),
            DEVICE_NAME_LEN
        );
        assert_eq!(parse_device_name(&[0xff, b'x', 0]), "\u{fffd}x");
    }

    #[test]
    fn names_codec_ids() {
        assert_eq!(codec_name(CODEC_H264), Some("h264"));
        assert_eq!(codec_name(0x0061_7631), Some("av1"));
        assert_eq!(codec_name(0), None);
    }
}
