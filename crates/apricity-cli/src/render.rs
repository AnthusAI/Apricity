//! Offline rendering: arrange the whole timeline with the engine's renderer and bounce it.

use apricity_engine::{Renderer, Stereo};
use apricity_score::Timeline;
use std::path::Path;

pub const OUT_SR: u32 = 48_000;

pub struct Rendered {
    pub mix: Stereo,
    pub unique_events: usize,
    /// Integrated loudness of the finished mix (LUFS) and its sample peak (dBFS).
    pub lufs: f64,
    pub peak_db: f64,
    /// The master's loudness make-up gain (dB).
    pub makeup_db: f64,
    pub stems: usize,
    /// One line per track and bus: routing, level, and compressor gain reduction.
    pub report: Vec<String>,
}

pub fn render(tl: &Timeline, beats: Option<(f64, f64)>) -> Result<Rendered, String> {
    let mut r = Renderer::with_file_decoder(OUT_SR);
    let (arr, stats) = r.arrange(tl, beats)?;
    let mix = arr.bounce();
    let lufs = apricity_dsp::fx::loudness_lufs(&mix[0], &mix[1], OUT_SR as f64);
    let peak = mix.iter().flatten().fold(0f32, |m, x| m.max(x.abs()));
    let report = mix_report(&r, &arr);
    Ok(Rendered { mix, unique_events: stats.rendered, lufs, peak_db: 20.0 * (peak.max(1e-9) as f64).log10(), makeup_db: arr.master.gain_db, stems: arr.stems.len(), report })
}

/// Level of each stem as it enters the mix, and how hard each compressor worked (deepest gain
/// reduction over the loop).
fn mix_report(r: &Renderer, arr: &apricity_engine::Arrangement) -> Vec<String> {
    let Some(m) = r.mix() else { return Vec::new() };
    let level = |b: &Stereo| {
        let lufs = apricity_dsp::fx::loudness_lufs(&b[0], &b[1], OUT_SR as f64);
        let peak = b.iter().flatten().fold(0f32, |p, x| p.max(x.abs()));
        let lufs = if lufs.is_finite() { format!("{lufs:6.1} LUFS") } else { "  silent   ".into() };
        format!("{lufs}  peak {:6.1} dBFS", 20.0 * (peak.max(1e-9) as f64).log10())
    };
    let comps = |red: &[(String, f64)]| red.iter().map(|(what, db)| format!("   {what}: {db:.1} dB")).collect::<String>();
    let mut out = Vec::new();
    for t in &m.tracks {
        let route = if t.sends.is_empty() { t.out.clone() } else { format!("{} + {}", t.out, t.sends.iter().map(|s| s.0.as_str()).collect::<Vec<_>>().join(", ")) };
        out.push(format!("track {:<14} → {:<16} {}{}", t.name, route, level(&t.buf), comps(&t.reductions)));
    }
    for b in &m.buses {
        let lvl = arr.stems.iter().find(|s| s.name == b.name).map_or_else(|| format!("(inside {})", b.out), |s| level(&s.buf));
        let red = r.bus_report().iter().find(|(n, _)| *n == b.name).map_or(String::new(), |(_, red)| comps(red));
        out.push(format!("bus   {:<14} → {:<16} {lvl}{red}", b.name, b.out));
    }
    out
}

pub fn write_wav(path: &Path, mix: &Stereo) -> Result<(), String> {
    let spec = hound::WavSpec { channels: 2, sample_rate: OUT_SR, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut w = hound::WavWriter::create(path, spec).map_err(|e| e.to_string())?;
    for i in 0..mix[0].len() {
        for c in mix {
            w.write_sample((c[i].clamp(-1.0, 1.0) * i16::MAX as f32) as i16).map_err(|e| e.to_string())?;
        }
    }
    w.finalize().map_err(|e| e.to_string())
}
