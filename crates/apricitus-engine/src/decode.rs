//! Decode audio files (WAV, MP3, FLAC) to planar f32 with symphonia.

use crate::render::Audio;
use std::path::Path;

pub fn decode(path: &Path) -> Result<Audio, String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let mut format = probed.format;
    let track = format.default_track().ok_or_else(|| format!("{}: no audio track", path.display()))?;
    let track_id = track.id;
    let sr = track.codec_params.sample_rate.ok_or("unknown sample rate")?;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let mut channels: Vec<Vec<f32>> = Vec::new();
    while let Ok(packet) = format.next_packet() {
        if packet.track_id() != track_id {
            continue;
        }
        let Ok(decoded) = decoder.decode(&packet) else { continue };
        let spec = *decoded.spec();
        let n = spec.channels.count();
        if channels.is_empty() {
            channels = vec![Vec::new(); n];
        }
        let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        buf.copy_interleaved_ref(decoded);
        for frame in buf.samples().chunks(n) {
            for (c, &s) in channels.iter_mut().zip(frame) {
                c.push(s);
            }
        }
    }
    if channels.is_empty() || channels[0].is_empty() {
        return Err(format!("{}: decoded no audio", path.display()));
    }
    Ok(Audio { sr, channels })
}
