//! Just enough H.264 parsing to build the WebCodecs codec string (`avc1.PPCCLL`).

const NAL_TYPE_SPS: u8 = 7;

/// The codec string from the SPS in an Annex B config packet: profile, constraint
/// flags and level as hex, e.g. `avc1.64002A`.
pub fn codec_string(config: &[u8]) -> Option<String> {
    let sps =
        nal_units(config).find(|nal| nal.first().is_some_and(|b| b & 0x1f == NAL_TYPE_SPS))?;
    let fields = sps.get(1..4)?;
    Some(format!(
        "avc1.{:02X}{:02X}{:02X}",
        fields[0], fields[1], fields[2]
    ))
}

/// Splits an Annex B stream into NAL units, without their start codes.
fn nal_units(stream: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= stream.len() {
        if stream[i] == 0 && stream[i + 1] == 0 && stream[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let ends: Vec<usize> = starts
        .iter()
        .skip(1)
        .map(|&next| next - 3)
        .chain(std::iter::once(stream.len()))
        .collect();
    starts.into_iter().zip(ends).map(move |(start, end)| {
        // A 4-byte start code leaves its first zero at the end of the previous unit.
        let mut unit = &stream[start..end];
        while let [rest @ .., 0] = unit {
            unit = rest;
        }
        unit
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPS_HIGH_42: [u8; 12] = [0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2a, 0xac, 0x2b, 0x40, 0x3c];
    const PPS: [u8; 8] = [0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80];

    #[test]
    fn builds_the_codec_string_from_sps_and_pps() {
        let config = [SPS_HIGH_42.as_slice(), PPS.as_slice()].concat();
        assert_eq!(codec_string(&config).as_deref(), Some("avc1.64002A"));
    }

    #[test]
    fn finds_the_sps_after_other_units_and_three_byte_start_codes() {
        let config = [
            [0, 0, 1, 0x68, 0xee, 0x3c, 0x80].as_slice(),
            [0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0x95].as_slice(),
        ]
        .concat();
        assert_eq!(codec_string(&config).as_deref(), Some("avc1.42C01F"));
    }

    #[test]
    fn returns_none_without_an_sps() {
        assert_eq!(codec_string(&PPS), None);
        assert_eq!(codec_string(&[0, 0, 0, 1, 0x67, 0x64]), None);
        assert_eq!(codec_string(&[]), None);
    }

    #[test]
    fn splits_units_and_trims_four_byte_start_codes() {
        let config = [SPS_HIGH_42.as_slice(), PPS.as_slice()].concat();
        let units: Vec<&[u8]> = nal_units(&config).collect();
        assert_eq!(units, vec![&SPS_HIGH_42[4..], &PPS[4..]]);
    }
}
