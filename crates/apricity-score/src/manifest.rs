//! Reading `<clip>.apricity.json` manifests (see schema/clip-manifest.schema.json).
//! Only the fields the compiler needs are modeled; the rest are ignored.

use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub source: Source,
    pub rhythm: Rhythm,
    pub tonal: Tonal,
    #[serde(default)]
    pub annotations: Annotations,
    /// Notes found in the audio (polyphonic transcription), in time order. Absent for unpitched audio.
    #[serde(default)]
    pub notes: Vec<Note>,
}

/// One transcribed note.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Note {
    pub start: f64,
    pub end: f64,
    pub midi: i32,
    #[serde(default)]
    pub velocity: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Source {
    pub path: String,
    pub sha256: String,
    pub duration: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Rhythm {
    pub bpm: Option<f64>,
    pub beats: Vec<f64>,
    pub meter: Option<u32>,
    pub warp_markers: Vec<WarpMarker>,
    /// RMS dBFS per beat interval (older manifests may lack it).
    #[serde(default)]
    pub beat_loudness: Vec<f64>,
    /// RMS dBFS per half second from the start, beat grid or not (older manifests may lack it).
    #[serde(default)]
    pub loudness: Vec<f64>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct WarpMarker {
    pub seconds: f64,
    pub beat: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Tonal {
    pub key: KeyEstimate,
    /// Deviation of the recording's A from 440 Hz, in cents.
    #[serde(default)]
    pub tuning_cents: f64,
    pub pitch_class_profile: Vec<f64>,
    #[serde(default)]
    pub beat_chroma: Vec<Vec<f64>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KeyEstimate {
    pub tonic: String,
    pub mode: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Annotations {
    /// Clips saved with the sample: yours, and automatic markup's (`sec-A1`, `loop-1`, `shot-3`).
    #[serde(default)]
    pub clips: Vec<SavedClip>,
    #[serde(default)]
    pub markers: Vec<Marker>,
}

impl Annotations {
    /// The saved clip a score names. A clip's name is unique on its sample; if two live clips still share one, the
    /// score must not play whichever comes first, so that is an error. A retired clip (kept for the scores that used
    /// it) answers only when no live clip has the name.
    pub fn saved_clip(&self, name: &str) -> Result<Option<&SavedClip>, String> {
        let named: Vec<&SavedClip> = self.clips.iter().filter(|s| s.name == name).collect();
        let live: Vec<&SavedClip> = named.iter().copied().filter(|s| !s.retired).collect();
        match live.len() {
            0 => Ok(named.first().copied()),
            1 => Ok(Some(live[0])),
            n => Err(format!("{n} clips are named {name:?} on this sample; rename one in the Library")),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Marker {
    pub name: String,
    pub seconds: f64,
}

/// A named region of a sample, saved in its manifest.
#[derive(Debug, Clone, Deserialize)]
pub struct SavedClip {
    pub name: String,
    pub start: f64,
    pub end: f64,
    /// Kept only for the scores that still use it (markup no longer proposes it).
    #[serde(default)]
    pub retired: bool,
}

/// A loaded clip: its audio path and manifest.
#[derive(Debug, Clone)]
pub struct Clip {
    pub audio: PathBuf,
    pub manifest: Manifest,
}

impl Clip {
    pub fn load(audio: &Path) -> Result<Self, String> {
        if !audio.exists() {
            return Err(format!("audio file {} does not exist", audio.display()));
        }
        let mpath = audio.with_file_name(format!("{}.apricity.json", audio.file_name().unwrap().to_string_lossy()));
        let text = std::fs::read_to_string(&mpath)
            .map_err(|_| format!("{} has no analysis yet; run `apricity-analyze {}`", audio.display(), audio.display()))?;
        Self::from_json(audio, &text)
    }

    /// Build from manifest text already in hand (e.g. fetched by a browser).
    pub fn from_json(audio: &Path, manifest_json: &str) -> Result<Self, String> {
        let manifest: Manifest = serde_json::from_str(manifest_json).map_err(|e| format!("{}.apricity.json: {e}", audio.display()))?;
        Ok(Self { audio: audio.to_path_buf(), manifest })
    }

    /// Can it be warped (did analysis find a beat grid)?
    pub fn has_beats(&self) -> bool {
        self.manifest.rhythm.warp_markers.len() >= 2
    }

    /// Replace the detected beat grid with an even one at `bpm`, starting at 0 s, for playing the
    /// clip unwarped. Warping an even grid onto the score's is plain varispeed: with `bpm` = the
    /// score's tempo the clip plays as recorded; with tempo / 1.5 it plays 1.5× as fast. Per-beat
    /// loudness and chroma are carried over by time, so level matching still works.
    pub fn unwarp(&mut self, bpm: f64) {
        let spb = 60.0 / bpm;
        let n = (self.duration() / spb).ceil().max(1.0) as usize;
        let beats: Vec<f64> = (0..=n).map(|i| i as f64 * spb).collect();
        let old = self.manifest.rhythm.beats.clone();
        // The old beat interval holding time t (clamped to the ends).
        let at = |t: f64| old.partition_point(|&b| b <= t).saturating_sub(1);
        let carry = |v: &Vec<f64>| -> Vec<f64> { if v.is_empty() || old.is_empty() { Vec::new() } else { (0..n).map(|i| v[at((i as f64 + 0.5) * spb).min(v.len() - 1)]).collect() } };
        // Level per new beat: from the time curve when there is one (it needs no beat grid).
        let curve = &self.manifest.rhythm.loudness;
        let loud = if !curve.is_empty() {
            // Average power of the half-second windows each new beat covers.
            (0..n)
                .map(|i| {
                    let w0 = ((i as f64 * spb / 0.5) as usize).min(curve.len() - 1);
                    let w1 = ((((i + 1) as f64 * spb) / 0.5).ceil() as usize).clamp(w0 + 1, curve.len());
                    let p = curve[w0..w1].iter().map(|db| 10f64.powf(db / 10.0)).sum::<f64>() / (w1 - w0) as f64;
                    10.0 * p.log10()
                })
                .collect()
        } else {
            carry(&self.manifest.rhythm.beat_loudness)
        };
        let bc = &self.manifest.tonal.beat_chroma;
        let chroma: Vec<Vec<f64>> = if bc.is_empty() || old.is_empty() { Vec::new() } else { (0..n).map(|i| bc[at((i as f64 + 0.5) * spb).min(bc.len() - 1)].clone()).collect() };
        let r = &mut self.manifest.rhythm;
        r.warp_markers = beats.iter().enumerate().map(|(i, &t)| WarpMarker { seconds: t, beat: i as f64 }).collect();
        r.beats = beats;
        r.bpm = Some(bpm);
        r.beat_loudness = loud;
        self.manifest.tonal.beat_chroma = chroma;
    }

    pub fn duration(&self) -> f64 {
        self.manifest.source.duration
    }

    /// Clip-beat range covered by the warp markers.
    pub fn beat_range(&self) -> (f64, f64) {
        let w = &self.manifest.rhythm.warp_markers;
        (w[0].beat, w[w.len() - 1].beat)
    }

    /// Source seconds at clip beat `b` (piecewise linear through the warp markers).
    pub fn seconds_at(&self, b: f64) -> f64 {
        interp(&self.manifest.rhythm.warp_markers, b, |m| m.beat, |m| m.seconds)
    }

    /// Clip beat at source seconds `t`.
    pub fn beat_at(&self, t: f64) -> f64 {
        interp(&self.manifest.rhythm.warp_markers, t, |m| m.seconds, |m| m.beat)
    }

    /// How uneven the beat intervals are over a clip-beat range (coefficient of variation of
    /// the inter-beat intervals): ~0.02 for a steady band, 0.2+ for free time or a misread meter.
    pub fn beat_irregularity(&self, beats: (f64, f64)) -> f64 {
        let t: Vec<f64> = self.manifest.rhythm.warp_markers.iter().filter(|w| w.beat >= beats.0 - 1e-6 && w.beat <= beats.1 + 1e-6).map(|w| w.seconds).collect();
        if t.len() < 3 {
            return 0.0;
        }
        let ibi: Vec<f64> = t.windows(2).map(|w| w[1] - w[0]).collect();
        let mean = ibi.iter().sum::<f64>() / ibi.len() as f64;
        let var = ibi.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / ibi.len() as f64;
        var.sqrt() / mean
    }

    /// Indices of beat intervals (into `rhythm.beats`) that fall inside a clip-beat range.
    fn beat_indices(&self, beats: (f64, f64)) -> std::ops::Range<usize> {
        let (lo, hi) = (self.seconds_at(beats.0), self.seconds_at(beats.1));
        let bt = &self.manifest.rhythm.beats;
        let first = bt.partition_point(|&t| t < lo - 1e-3);
        let last = bt.partition_point(|&t| t <= hi + 1e-3).saturating_sub(1);
        first..last.max(first)
    }

    /// How much the harmony moves within a range: mean over beats of (1 − cosine similarity with
    /// the range's average chroma). ~0 for one sustained chord; 0.3+ for moving harmony.
    pub fn harmonic_motion(&self, beats: (f64, f64)) -> f64 {
        let bc = &self.manifest.tonal.beat_chroma;
        let rows: Vec<&Vec<f64>> = self.beat_indices(beats).filter_map(|i| bc.get(i)).filter(|r| r.len() == 12).collect();
        if rows.len() < 2 {
            return 0.0;
        }
        let mean: Vec<f64> = (0..12).map(|k| rows.iter().map(|r| r[k]).sum::<f64>() / rows.len() as f64).collect();
        let norm = |v: &[f64]| v.iter().map(|x| x * x).sum::<f64>().sqrt();
        let nm = norm(&mean);
        rows.iter().map(|r| {
            let d = norm(r) * nm;
            if d == 0.0 { 1.0 } else { 1.0 - r.iter().zip(&mean).map(|(a, b)| a * b).sum::<f64>() / d }
        }).sum::<f64>() / rows.len() as f64
    }

    /// Mean RMS level (dBFS) of a range, from per-beat loudness; `None` for older manifests.
    pub fn loudness(&self, beats: (f64, f64)) -> Option<f64> {
        let loud = &self.manifest.rhythm.beat_loudness;
        let vals: Vec<f64> = self.beat_indices(beats).filter_map(|i| loud.get(i).copied()).collect();
        if vals.is_empty() {
            return None;
        }
        // Average power, not average dB, so a few loud hits count properly.
        let p = vals.iter().map(|db| 10f64.powf(db / 10.0)).sum::<f64>() / vals.len() as f64;
        Some(10.0 * p.log10())
    }

    /// How quiet a range is relative to the clip's *playing* level (its 90th-percentile beat):
    /// 0 when the range is that loud; grows as it falls below, and with the share of near-silent
    /// beats in it. (Not the median: a stem can be silent most of the time, like tubas resting.)
    pub fn quietness(&self, beats: (f64, f64)) -> f64 {
        let loud = &self.manifest.rhythm.beat_loudness;
        if loud.is_empty() {
            return 0.0;
        }
        let mut sorted = loud.clone();
        sorted.sort_by(|a, b| a.total_cmp(b));
        let playing = sorted[(sorted.len() * 9 / 10).min(sorted.len() - 1)];
        let vals: Vec<f64> = self.beat_indices(beats).filter_map(|i| loud.get(i).copied()).collect();
        if vals.is_empty() {
            return 0.0;
        }
        let level = self.loudness(beats).unwrap_or(playing);
        let silent = vals.iter().filter(|&&v| v < playing - 15.0).count() as f64 / vals.len() as f64;
        ((playing - level) / 6.0).max(0.0) + 3.0 * silent
    }

    /// Pitch-class energy over a clip-beat range, from per-beat chroma (falls back to the
    /// whole-clip profile when the manifest has no beat chroma).
    pub fn pcp(&self, beats: (f64, f64)) -> [f64; 12] {
        let t = &self.manifest.tonal;
        let mut out = [0.0; 12];
        let (lo, hi) = (self.seconds_at(beats.0), self.seconds_at(beats.1));
        let bt = &self.manifest.rhythm.beats;
        let mut any = false;
        for (i, chroma) in t.beat_chroma.iter().enumerate() {
            if i + 1 < bt.len() && bt[i] >= lo - 1e-3 && bt[i + 1] <= hi + 1e-3 && chroma.len() == 12 {
                for (o, c) in out.iter_mut().zip(chroma) {
                    *o += c;
                }
                any = true;
            }
        }
        if !any {
            for (o, c) in out.iter_mut().zip(&t.pitch_class_profile) {
                *o = *c;
            }
        }
        out
    }
}

impl Clip {
    /// The note a short clip plays, heard from the transcription: of the notes that start at the region's onset
    /// (from 30 ms before to 120 ms after it), the lowest one that is at least half as loud as the loudest there.
    /// A stab voiced as a chord gives its bass note; `None` when nothing starts there (unpitched, or not analyzed).
    pub fn pitch(&self, seconds: (f64, f64)) -> Option<i32> {
        let (lo, hi) = (seconds.0 - 0.03, (seconds.0 + 0.12).min(seconds.1));
        let onset: Vec<&Note> = self.manifest.notes.iter().filter(|n| n.start >= lo && n.start <= hi).collect();
        let loudest = onset.iter().map(|n| n.velocity).fold(0.0f64, f64::max);
        onset.iter().filter(|n| n.velocity >= loudest * 0.5).map(|n| n.midi).min()
    }
}

/// Piecewise-linear interpolation over sorted markers, extrapolating from the end segments.
fn interp<T>(m: &[T], x: f64, fx: impl Fn(&T) -> f64, fy: impl Fn(&T) -> f64) -> f64 {
    let n = m.len();
    let i = match m.iter().position(|p| fx(p) > x) {
        Some(0) => 0,
        Some(i) => i - 1,
        None => n - 2,
    }
    .min(n - 2);
    let (x0, x1, y0, y1) = (fx(&m[i]), fx(&m[i + 1]), fy(&m[i]), fy(&m[i + 1]));
    if (x1 - x0).abs() < 1e-12 { y0 } else { y0 + (x - x0) * (y1 - y0) / (x1 - x0) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_notes(notes: &[(f64, f64, i32, f64)]) -> Clip {
        let json = serde_json::json!({
            "source": { "path": "a.wav", "sha256": "x", "duration": 10.0 },
            "rhythm": { "bpm": 120.0, "beats": [0.0, 0.5, 1.0], "meter": 4, "warp_markers": [{ "seconds": 0.0, "beat": 0.0 }, { "seconds": 0.5, "beat": 1.0 }] },
            "tonal": { "key": { "tonic": "C", "mode": "major" }, "pitch_class_profile": [1.0,0,0,0,0,0,0,0,0,0,0,0] },
            "notes": notes.iter().map(|&(start, end, midi, velocity)| serde_json::json!({ "start": start, "end": end, "midi": midi, "velocity": velocity })).collect::<Vec<_>>(),
        });
        Clip::from_json(Path::new("a.wav"), &json.to_string()).unwrap()
    }

    #[test]
    fn a_shots_pitch_is_its_lowest_strong_onset_note() {
        // Real shots from the Thunderer horns: C in octaves, and a B♭ chord with its bass on B♭2.
        let c = with_notes(&[(0.2786, 0.45, 48, 0.59), (0.2902, 0.44, 72, 0.276), (0.30, 0.5, 60, 0.5)]);
        assert_eq!(c.pitch((0.204, 0.704)), Some(48));
        let bb = with_notes(&[(163.17, 163.4, 62, 0.4), (163.18, 163.4, 65, 0.5), (163.2, 163.5, 58, 0.6), (163.21, 163.5, 46, 0.55), (163.25, 163.4, 74, 0.3)]);
        assert_eq!(bb.pitch((163.162, 163.662)), Some(46));
        // A note that began well before the shot, a faint low note, and nothing at all.
        let early = with_notes(&[(4.0, 4.6, 41, 0.9), (4.26, 4.5, 60, 0.8), (4.27, 4.5, 36, 0.1)]);
        assert_eq!(early.pitch((4.256, 4.756)), Some(60));
        assert_eq!(with_notes(&[]).pitch((1.0, 2.0)), None);
    }

    #[test]
    fn interpolates_and_extrapolates() {
        let m = [WarpMarker { seconds: 1.0, beat: 0.0 }, WarpMarker { seconds: 1.5, beat: 1.0 }, WarpMarker { seconds: 2.5, beat: 2.0 }];
        let s = |b| interp(&m, b, |w| w.beat, |w| w.seconds);
        assert_eq!(s(0.0), 1.0);
        assert_eq!(s(0.5), 1.25);
        assert_eq!(s(1.5), 2.0);
        assert_eq!(s(3.0), 3.5); // last segment's tempo
        assert_eq!(s(-1.0), 0.5); // first segment's tempo
        let b = |t| interp(&m, t, |w| w.seconds, |w| w.beat);
        assert_eq!(b(2.0), 1.5);
    }

    #[test]
    fn saved_clip_names_are_unambiguous() {
        let clip = |name: &str, start: f64, retired: bool| SavedClip { name: name.into(), start, end: start + 1.0, retired };
        let a = Annotations { clips: vec![clip("loop-1", 0.0, true), clip("loop-1", 2.0, false), clip("fill", 4.0, true)], markers: vec![] };
        assert_eq!(a.saved_clip("loop-1").unwrap().unwrap().start, 2.0, "the live one, not the retired one");
        assert_eq!(a.saved_clip("fill").unwrap().unwrap().start, 4.0, "a retired clip still plays for old scores");
        assert!(a.saved_clip("nope").unwrap().is_none());
        let b = Annotations { clips: vec![clip("loop-1", 0.0, false), clip("loop-1", 2.0, false)], markers: vec![] };
        assert_eq!(b.saved_clip("loop-1").unwrap_err(), "2 clips are named \"loop-1\" on this sample; rename one in the Library");
    }
}
