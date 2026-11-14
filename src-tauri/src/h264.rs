//! Just enough H.264 to build the WebCodecs codec string (`avc1.PPCCLL`) and to tell the
//! decoder that the stream has no reordering, so it shows every frame at once.

const NAL_TYPE_SPS: u8 = 7;
/// Profiles whose SPS has chroma format, bit depths and scaling matrices (H.264 7.3.2.1.1).
const HIGH_PROFILES: [u32; 13] = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];

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

/// Rewrites the SPS in an Annex B config so its VUI says `max_num_reorder_frames = 0`.
///
/// Many encoders leave this out. A decoder must then assume the worst and may hold back a
/// whole DPB of frames before it shows any (Chromium's does), which on a still screen means
/// showing almost nothing. The server turns B-frames off, so the claim is true. Returns
/// `None` when the config has no SPS or the SPS cannot be parsed.
pub fn low_latency_config(config: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(config.len() + 16);
    let mut rewritten = false;
    for unit in nal_units(config) {
        out.extend_from_slice(&[0, 0, 0, 1]);
        match unit.split_first() {
            Some((&header, body)) if header & 0x1f == NAL_TYPE_SPS && !rewritten => {
                out.push(header);
                out.extend_from_slice(&escape(&rewrite_sps(&unescape(body))?));
                rewritten = true;
            }
            _ => out.extend_from_slice(unit),
        }
    }
    rewritten.then_some(out)
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

/// Copies an SPS (RBSP) and sets the VUI bitstream restriction to "no reordering".
fn rewrite_sps(rbsp: &[u8]) -> Option<Vec<u8>> {
    let mut reader = BitReader::new(rbsp);
    let mut writer = BitWriter::default();
    let max_num_ref_frames = copy_until_vui(&mut reader, &mut writer)?;
    let vui_present = reader.bits(1)?;
    writer.bits(1, 1);
    if vui_present == 1 {
        copy_vui_until_restriction(&mut reader, &mut writer)?;
        let restriction = reader.bits(1)?;
        writer.bits(1, 1);
        if restriction == 1 {
            copy(&mut reader, &mut writer, 1)?; // motion_vectors_over_pic_boundaries_flag
            for _ in 0..4 {
                // max_bytes_per_pic_denom, max_bits_per_mb_denom, log2_max_mv_length_*
                copy_ue(&mut reader, &mut writer)?;
            }
            reader.ue()?;
            writer.ue(0); // max_num_reorder_frames
            copy_ue(&mut reader, &mut writer)?; // max_dec_frame_buffering
        } else {
            write_restriction(&mut writer, max_num_ref_frames);
        }
    } else {
        // A VUI with nothing but the restriction: eight absent parts, then the restriction.
        writer.bits(0, 8);
        writer.bits(1, 1);
        write_restriction(&mut writer, max_num_ref_frames);
    }
    writer.trailing_bits();
    Some(writer.finish())
}

/// Copies the SPS up to `vui_parameters_present_flag` and returns `max_num_ref_frames`.
fn copy_until_vui(r: &mut BitReader<'_>, w: &mut BitWriter) -> Option<u32> {
    let profile = copy(r, w, 8)?;
    copy(r, w, 8)?; // constraint_set flags and reserved bits
    copy(r, w, 8)?; // level_idc
    copy_ue(r, w)?; // seq_parameter_set_id
    if HIGH_PROFILES.contains(&profile) {
        let chroma_format = copy_ue(r, w)?;
        if chroma_format == 3 {
            copy(r, w, 1)?; // separate_colour_plane_flag
        }
        copy_ue(r, w)?; // bit_depth_luma_minus8
        copy_ue(r, w)?; // bit_depth_chroma_minus8
        copy(r, w, 1)?; // qpprime_y_zero_transform_bypass_flag
        if copy(r, w, 1)? == 1 {
            // seq_scaling_matrix_present_flag
            let lists = if chroma_format == 3 { 12 } else { 8 };
            for i in 0..lists {
                if copy(r, w, 1)? == 1 {
                    copy_scaling_list(r, w, if i < 6 { 16 } else { 64 })?;
                }
            }
        }
    }
    copy_ue(r, w)?; // log2_max_frame_num_minus4
    match copy_ue(r, w)? {
        // pic_order_cnt_type
        0 => {
            copy_ue(r, w)?; // log2_max_pic_order_cnt_lsb_minus4
        }
        1 => {
            copy(r, w, 1)?; // delta_pic_order_always_zero_flag
            copy_se(r, w)?; // offset_for_non_ref_pic
            copy_se(r, w)?; // offset_for_top_to_bottom_field
            for _ in 0..copy_ue(r, w)? {
                copy_se(r, w)?; // offset_for_ref_frame
            }
        }
        _ => {}
    }
    let max_num_ref_frames = copy_ue(r, w)?;
    copy(r, w, 1)?; // gaps_in_frame_num_value_allowed_flag
    copy_ue(r, w)?; // pic_width_in_mbs_minus1
    copy_ue(r, w)?; // pic_height_in_map_units_minus1
    if copy(r, w, 1)? == 0 {
        copy(r, w, 1)?; // mb_adaptive_frame_field_flag
    }
    copy(r, w, 1)?; // direct_8x8_inference_flag
    if copy(r, w, 1)? == 1 {
        for _ in 0..4 {
            copy_ue(r, w)?; // frame_crop_*_offset
        }
    }
    Some(max_num_ref_frames)
}

fn copy_scaling_list(r: &mut BitReader<'_>, w: &mut BitWriter, size: usize) -> Option<()> {
    let mut last = 8;
    let mut next = 8;
    for _ in 0..size {
        if next != 0 {
            let delta = copy_se(r, w)?;
            next = (last + delta + 256) % 256;
        }
        if next != 0 {
            last = next;
        }
    }
    Some(())
}

/// Copies the VUI up to `bitstream_restriction_flag` (H.264 E.1.1).
fn copy_vui_until_restriction(r: &mut BitReader<'_>, w: &mut BitWriter) -> Option<()> {
    if copy(r, w, 1)? == 1 && copy(r, w, 8)? == 255 {
        // aspect_ratio_idc 255 (Extended_SAR): sar_width, sar_height
        copy(r, w, 16)?;
        copy(r, w, 16)?;
    }
    if copy(r, w, 1)? == 1 {
        copy(r, w, 1)?; // overscan_appropriate_flag
    }
    if copy(r, w, 1)? == 1 {
        copy(r, w, 4)?; // video_format, video_full_range_flag
        if copy(r, w, 1)? == 1 {
            copy(r, w, 24)?; // colour_primaries, transfer_characteristics, matrix_coefficients
        }
    }
    if copy(r, w, 1)? == 1 {
        copy_ue(r, w)?; // chroma_sample_loc_type_top_field
        copy_ue(r, w)?; // chroma_sample_loc_type_bottom_field
    }
    if copy(r, w, 1)? == 1 {
        copy(r, w, 32)?; // num_units_in_tick
        copy(r, w, 32)?; // time_scale
        copy(r, w, 1)?; // fixed_frame_rate_flag
    }
    let nal_hrd = copy(r, w, 1)?;
    if nal_hrd == 1 {
        copy_hrd(r, w)?;
    }
    let vcl_hrd = copy(r, w, 1)?;
    if vcl_hrd == 1 {
        copy_hrd(r, w)?;
    }
    if nal_hrd == 1 || vcl_hrd == 1 {
        copy(r, w, 1)?; // low_delay_hrd_flag
    }
    copy(r, w, 1)?; // pic_struct_present_flag
    Some(())
}

/// Copies hrd_parameters() (H.264 E.1.2).
fn copy_hrd(r: &mut BitReader<'_>, w: &mut BitWriter) -> Option<()> {
    let cpb_count = copy_ue(r, w)?;
    copy(r, w, 8)?; // bit_rate_scale, cpb_size_scale
    for _ in 0..=cpb_count {
        copy_ue(r, w)?; // bit_rate_value_minus1
        copy_ue(r, w)?; // cpb_size_value_minus1
        copy(r, w, 1)?; // cbr_flag
    }
    copy(r, w, 20) // four delay and offset lengths of 5 bits
        .map(|_| ())
}

fn write_restriction(w: &mut BitWriter, max_num_ref_frames: u32) {
    w.bits(1, 1); // motion_vectors_over_pic_boundaries_flag
    w.ue(2); // max_bytes_per_pic_denom (the default)
    w.ue(1); // max_bits_per_mb_denom (the default)
    w.ue(16); // log2_max_mv_length_horizontal
    w.ue(16); // log2_max_mv_length_vertical
    w.ue(0); // max_num_reorder_frames: no reordering
    w.ue(max_num_ref_frames.max(1)); // max_dec_frame_buffering
}

fn copy(r: &mut BitReader<'_>, w: &mut BitWriter, count: u32) -> Option<u32> {
    let value = r.bits(count)?;
    w.bits(value, count);
    Some(value)
}

fn copy_ue(r: &mut BitReader<'_>, w: &mut BitWriter) -> Option<u32> {
    let value = r.ue()?;
    w.ue(value);
    Some(value)
}

fn copy_se(r: &mut BitReader<'_>, w: &mut BitWriter) -> Option<i32> {
    let value = r.se()?;
    w.se(value);
    Some(value)
}

/// Removes emulation prevention bytes (`00 00 03` becomes `00 00`).
fn unescape(ebsp: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(ebsp.len());
    let mut zeros = 0;
    for &byte in ebsp {
        if zeros >= 2 && byte == 3 {
            zeros = 0;
            continue;
        }
        zeros = if byte == 0 { zeros + 1 } else { 0 };
        out.push(byte);
    }
    out
}

/// Adds emulation prevention bytes, so the payload never contains a start code.
fn escape(rbsp: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rbsp.len() + 4);
    let mut zeros = 0;
    for &byte in rbsp {
        if zeros >= 2 && byte <= 3 {
            out.push(3);
            zeros = 0;
        }
        out.push(byte);
        zeros = if byte == 0 { zeros + 1 } else { 0 };
    }
    out
}

struct BitReader<'a> {
    data: &'a [u8],
    position: usize,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, position: 0 }
    }

    fn bit(&mut self) -> Option<u32> {
        let byte = *self.data.get(self.position / 8)?;
        let bit = (byte >> (7 - self.position % 8)) & 1;
        self.position += 1;
        Some(u32::from(bit))
    }

    fn bits(&mut self, count: u32) -> Option<u32> {
        let mut value = 0;
        for _ in 0..count {
            value = (value << 1) | self.bit()?;
        }
        Some(value)
    }

    /// Unsigned Exp-Golomb.
    fn ue(&mut self) -> Option<u32> {
        let mut zeros = 0;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return None;
            }
        }
        let rest = u64::from(self.bits(zeros)?);
        u32::try_from((1u64 << zeros) - 1 + rest).ok()
    }

    /// Signed Exp-Golomb.
    fn se(&mut self) -> Option<i32> {
        let code = i64::from(self.ue()?);
        let value = if code % 2 == 1 {
            (code + 1) / 2
        } else {
            -(code / 2)
        };
        i32::try_from(value).ok()
    }
}

#[derive(Default)]
struct BitWriter {
    bytes: Vec<u8>,
    current: u8,
    filled: u8,
}

impl BitWriter {
    fn bit(&mut self, bit: u32) {
        self.current = (self.current << 1) | (bit & 1) as u8;
        self.filled += 1;
        if self.filled == 8 {
            self.bytes.push(self.current);
            self.current = 0;
            self.filled = 0;
        }
    }

    fn bits(&mut self, value: u32, count: u32) {
        for shift in (0..count).rev() {
            self.bit(value >> shift);
        }
    }

    fn ue(&mut self, value: u32) {
        let code = u64::from(value) + 1;
        let length = 64 - code.leading_zeros();
        for _ in 1..length {
            self.bit(0);
        }
        for shift in (0..length).rev() {
            self.bit(((code >> shift) & 1) as u32);
        }
    }

    fn se(&mut self, value: i32) {
        let code = if value > 0 {
            2 * i64::from(value) - 1
        } else {
            -2 * i64::from(value)
        };
        self.ue(u32::try_from(code).unwrap_or(u32::MAX));
    }

    /// rbsp_trailing_bits: a one, then zeros up to the byte boundary.
    fn trailing_bits(&mut self) {
        self.bit(1);
        while self.filled != 0 {
            self.bit(0);
        }
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
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
        assert_eq!(low_latency_config(&PPS), None);
    }

    #[test]
    fn splits_units_and_trims_four_byte_start_codes() {
        let config = [SPS_HIGH_42.as_slice(), PPS.as_slice()].concat();
        let units: Vec<&[u8]> = nal_units(&config).collect();
        assert_eq!(units, vec![&SPS_HIGH_42[4..], &PPS[4..]]);
    }

    /// A 1920x1080 High profile SPS, optionally with a VUI, as an Annex B config with a PPS.
    fn config(vui: impl Fn(&mut BitWriter)) -> Vec<u8> {
        let mut w = BitWriter::default();
        w.bits(100, 8); // profile_idc: High
        w.bits(0, 8); // constraint flags
        w.bits(42, 8); // level_idc 4.2
        w.ue(0); // seq_parameter_set_id
        w.ue(1); // chroma_format_idc 4:2:0
        w.ue(0); // bit_depth_luma_minus8
        w.ue(0); // bit_depth_chroma_minus8
        w.bits(0, 1); // qpprime_y_zero_transform_bypass_flag
        w.bits(0, 1); // seq_scaling_matrix_present_flag
        w.ue(4); // log2_max_frame_num_minus4
        w.ue(0); // pic_order_cnt_type
        w.ue(4); // log2_max_pic_order_cnt_lsb_minus4
        w.ue(3); // max_num_ref_frames
        w.bits(0, 1); // gaps_in_frame_num_value_allowed_flag
        w.ue(119); // 120 macroblocks wide
        w.ue(67); // 68 macroblocks high
        w.bits(1, 1); // frame_mbs_only_flag
        w.bits(1, 1); // direct_8x8_inference_flag
        w.bits(1, 1); // frame_cropping_flag
        for offset in [0, 0, 0, 4] {
            w.ue(offset);
        }
        vui(&mut w);
        w.trailing_bits();
        let sps = escape(&w.finish());
        [&[0, 0, 0, 1, 0x67], sps.as_slice(), PPS.as_slice()].concat()
    }

    fn no_vui(w: &mut BitWriter) {
        w.bits(0, 1);
    }

    /// A VUI with colour description, timing and NAL HRD, but no restriction.
    fn vui_with_hrd(w: &mut BitWriter) {
        w.bits(1, 1); // vui_parameters_present_flag
        w.bits(1, 1); // aspect_ratio_info_present_flag
        w.bits(255, 8); // Extended_SAR
        w.bits(1, 16);
        w.bits(1, 16);
        w.bits(0, 1); // overscan_info_present_flag
        w.bits(1, 1); // video_signal_type_present_flag
        w.bits(5, 3);
        w.bits(0, 1);
        w.bits(1, 1); // colour_description_present_flag
        w.bits(0x010101, 24);
        w.bits(0, 1); // chroma_loc_info_present_flag
        w.bits(1, 1); // timing_info_present_flag
        w.bits(1, 32);
        w.bits(120, 32);
        w.bits(0, 1);
        w.bits(1, 1); // nal_hrd_parameters_present_flag
        w.ue(0); // cpb_cnt_minus1
        w.bits(0x44, 8);
        w.ue(7999);
        w.ue(1999);
        w.bits(0, 1);
        w.bits(0x9a4a5, 20);
        w.bits(0, 1); // vcl_hrd_parameters_present_flag
        w.bits(1, 1); // low_delay_hrd_flag
        w.bits(0, 1); // pic_struct_present_flag
        w.bits(0, 1); // bitstream_restriction_flag
    }

    /// A VUI that allows two reordered frames.
    fn vui_with_reordering(w: &mut BitWriter) {
        w.bits(1, 1); // vui_parameters_present_flag
        w.bits(0, 8); // eight absent parts
        w.bits(1, 1); // bitstream_restriction_flag
        w.bits(1, 1);
        w.ue(2);
        w.ue(1);
        w.ue(16);
        w.ue(16);
        w.ue(2); // max_num_reorder_frames
        w.ue(4); // max_dec_frame_buffering
    }

    fn sps_rbsp(config: &[u8]) -> Vec<u8> {
        let sps = nal_units(config)
            .find(|nal| nal[0] & 0x1f == NAL_TYPE_SPS)
            .unwrap();
        unescape(&sps[1..])
    }

    /// The SPS fields before the VUI, re-encoded, to check that nothing else changed.
    fn fields_before_vui(config: &[u8]) -> Vec<u8> {
        let rbsp = sps_rbsp(config);
        let mut w = BitWriter::default();
        copy_until_vui(&mut BitReader::new(&rbsp), &mut w).unwrap();
        w.trailing_bits();
        w.finish()
    }

    /// (max_num_reorder_frames, max_dec_frame_buffering), if the SPS has a restriction.
    fn restriction(config: &[u8]) -> Option<(u32, u32)> {
        let rbsp = sps_rbsp(config);
        let mut r = BitReader::new(&rbsp);
        let mut sink = BitWriter::default();
        copy_until_vui(&mut r, &mut sink)?;
        if r.bits(1)? == 0 {
            return None;
        }
        copy_vui_until_restriction(&mut r, &mut sink)?;
        if r.bits(1)? == 0 {
            return None;
        }
        r.bits(1)?;
        for _ in 0..4 {
            r.ue()?;
        }
        Some((r.ue()?, r.ue()?))
    }

    #[test]
    fn adds_a_vui_that_forbids_reordering() {
        let original = config(no_vui);
        assert_eq!(restriction(&original), None);
        let rewritten = low_latency_config(&original).unwrap();
        assert_eq!(restriction(&rewritten), Some((0, 3)));
        assert_eq!(fields_before_vui(&rewritten), fields_before_vui(&original));
        assert_eq!(codec_string(&rewritten), codec_string(&original));
        assert!(rewritten.ends_with(&PPS));
    }

    #[test]
    fn keeps_an_existing_vui_and_adds_the_restriction() {
        let original = config(vui_with_hrd);
        let rewritten = low_latency_config(&original).unwrap();
        assert_eq!(restriction(&rewritten), Some((0, 3)));
        assert_eq!(fields_before_vui(&rewritten), fields_before_vui(&original));
        // Everything in the VUI before the restriction is copied bit for bit.
        let vui = |config: &[u8]| {
            let rbsp = sps_rbsp(config);
            let mut r = BitReader::new(&rbsp);
            let mut w = BitWriter::default();
            copy_until_vui(&mut r, &mut BitWriter::default()).unwrap();
            r.bits(1).unwrap();
            copy_vui_until_restriction(&mut r, &mut w).unwrap();
            w.trailing_bits();
            w.finish()
        };
        assert_eq!(vui(&rewritten), vui(&original));
    }

    #[test]
    fn sets_an_existing_restriction_to_no_reordering() {
        let original = config(vui_with_reordering);
        assert_eq!(restriction(&original), Some((2, 4)));
        let rewritten = low_latency_config(&original).unwrap();
        assert_eq!(restriction(&rewritten), Some((0, 4)));
    }

    #[test]
    fn rewriting_twice_changes_nothing_more() {
        for original in [
            config(no_vui),
            config(vui_with_hrd),
            config(vui_with_reordering),
        ] {
            let once = low_latency_config(&original).unwrap();
            assert_eq!(low_latency_config(&once).unwrap(), once);
        }
    }

    #[test]
    fn exp_golomb_round_trips() {
        let mut w = BitWriter::default();
        for value in [0, 1, 2, 3, 119, 7999, u32::MAX - 1] {
            w.ue(value);
        }
        for value in [0, 1, -1, 2, -2, 127, -128] {
            w.se(value);
        }
        w.trailing_bits();
        let bytes = w.finish();
        let mut r = BitReader::new(&bytes);
        for value in [0, 1, 2, 3, 119, 7999, u32::MAX - 1] {
            assert_eq!(r.ue(), Some(value));
        }
        for value in [0, 1, -1, 2, -2, 127, -128] {
            assert_eq!(r.se(), Some(value));
        }
    }

    #[test]
    fn escapes_start_codes_and_back() {
        // 00 00 01 gets a 03; five zeros get one after every second zero, and the
        // original 03 after a single zero stays as it is.
        let rbsp = [0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xff];
        let escaped = escape(&rbsp);
        assert_eq!(
            escaped,
            [
                0x00, 0x00, 0x03, 0x01, 0x00, 0x00, 0x03, 0x00, 0x00, 0x03, 0x00, 0x03, 0xff
            ]
        );
        assert_eq!(unescape(&escaped), rbsp);
    }

    /// The SPS and PPS a Lenovo TB311FU (MediaTek, Android 16) sent for 1920x1200 video.
    const DEVICE_CONFIG: &str = "0000000167640032ac1b1a8078025e9a80808083c2211a800000000168ea43cb";

    #[test]
    fn rewrites_a_real_device_sps() {
        let original: Vec<u8> = (0..DEVICE_CONFIG.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&DEVICE_CONFIG[i..i + 2], 16).unwrap())
            .collect();
        let rewritten = low_latency_config(&original).unwrap();
        assert_eq!(restriction(&rewritten).map(|(reorder, _)| reorder), Some(0));
        assert_eq!(fields_before_vui(&rewritten), fields_before_vui(&original));
        assert_eq!(codec_string(&rewritten).as_deref(), Some("avc1.640032"));
        assert_eq!(low_latency_config(&rewritten).unwrap(), rewritten);
        assert!(rewritten.ends_with(&[0, 0, 0, 1, 0x68, 0xea, 0x43, 0xcb]));
    }
}
