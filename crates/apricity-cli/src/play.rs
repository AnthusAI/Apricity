//! `apricity play`: live playback with hot reload. Save the score and the change lands at the next
//! bar. A score with mistakes is reported and ignored; the last good version keeps playing.
//! Type mix commands while it plays (`mute horns`, `solo 2`, `gain bass -6`); see `HELP`.

use apricity_engine::{engine, Command, Controller, Mixer, Renderer, SwapAt, TrackControl};
use apricity_score::Timeline;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant, SystemTime};

pub struct Options {
    pub score: PathBuf,
    /// Drive the engine from a silent clock instead of the sound card (for testing).
    pub no_audio: bool,
    /// Stop after this long.
    pub seconds: Option<f64>,
    /// Output level in dB (0 = as rendered).
    pub volume_db: f32,
}

fn mtime(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

fn compile(score: &Path) -> Result<Timeline, Vec<String>> {
    apricity_score::compile_file(score)
}

fn arrange(renderer: &mut Renderer, tl: &Timeline, ctl: &mut Controller, at: SwapAt) -> Result<String, String> {
    let t0 = Instant::now();
    let (arr, stats) = renderer.arrange(tl, None)?;
    // Live mutes and solos baked into buses survive the re-render.
    let arr = match renderer.mix() {
        Some(m) if m.has_buses() && !ctl.controls().is_empty() => renderer.remix(ctl.controls()).unwrap_or(arr),
        _ => arr,
    };
    let bars = tl.length_beats / tl.meter as f64;
    ctl.load(arr, at)?;
    Ok(format!("{bars} bars at {} BPM in {}; rendered {} event{}, reused {} ({:.1} s)",
        tl.tempo, tl.key, stats.rendered, if stats.rendered == 1 { "" } else { "s" }, stats.reused, t0.elapsed().as_secs_f64()))
}

pub fn run(opts: Options) -> Result<(), String> {
    let tl = compile(&opts.score).map_err(|e| format!("{} has problems:\n  ✗ {}", opts.score.display(), e.join("\n  ✗ ")))?;
    let (mut ctl, mixer) = engine();

    let (sample_rate, _stream) = if opts.no_audio {
        std::thread::spawn(move || silent_clock(mixer, 48_000));
        (48_000, None)
    } else {
        open_device(mixer, 10f32.powf(opts.volume_db / 20.0))?
    };
    let mut renderer = Renderer::with_file_decoder(sample_rate);
    let mut meter = tl.meter;
    eprintln!("▶ {}", arrange(&mut renderer, &tl, &mut ctl, SwapAt::Now)?);
    ctl.send(Command::Play)?;

    if !opts.no_audio {
        eprintln!("  output: {sample_rate} Hz{}", if opts.volume_db != 0.0 { format!(", volume {:+} dB", opts.volume_db) } else { String::new() });
    }
    eprintln!("  watching {} — save it to hear changes at the next bar; Ctrl-C to stop", opts.score.display());
    eprintln!("  mix live: type `mute NAME`, `solo NAME`, `gain NAME -6`, `reset`, `tracks` (NAME or number)");
    let lines = stdin_lines();
    let started = Instant::now();
    let mut last = mtime(&opts.score);
    let mut last_status = String::new();
    let mut shown_warnings: Vec<String> = tl.warnings.clone();
    for w in &tl.warnings {
        eprintln!("  ! {w}");
    }
    loop {
        std::thread::sleep(Duration::from_millis(100));
        ctl.collect_garbage();
        if opts.seconds.is_some_and(|s| started.elapsed().as_secs_f64() >= s) {
            break;
        }
        let (bar, beat) = ctl.status.bar_beat(meter);
        let pending = if ctl.status.pending_swap.load(Ordering::Relaxed) { "  (change queued for the next bar)" } else { "" };
        let status = format!("bar {bar:>3} beat {beat}{pending}");
        if status != last_status {
            eprint!("\r\x1b[2K  {status}");
            let _ = std::io::stderr().flush();
            last_status = status;
        }

        while let Ok(line) = lines.try_recv() {
            eprint!("\r\x1b[2K");
            match mix_command(&mut ctl, &renderer, &line) {
                Ok(msg) if !msg.is_empty() => eprintln!("  ◆ {msg}"),
                Ok(_) => {}
                Err(e) => eprintln!("  ✗ {e}"),
            }
            last_status.clear();
        }

        let now = mtime(&opts.score);
        if now == last {
            continue;
        }
        last = now;
        std::thread::sleep(Duration::from_millis(50)); // let the editor finish writing
        eprint!("\r\x1b[2K");
        match compile(&opts.score) {
            Err(errors) => {
                eprintln!("✗ {} has {} problem{}; still playing the last good version:", opts.score.display(), errors.len(), if errors.len() == 1 { "" } else { "s" });
                for e in errors {
                    eprintln!("    {e}");
                }
            }
            Ok(tl) => match arrange(&mut renderer, &tl, &mut ctl, SwapAt::NextBar) {
                Ok(msg) => {
                    meter = tl.meter;
                    let (bar, _) = ctl.status.bar_beat(meter);
                    eprintln!("↻ {msg}; lands at bar {}", bar + 1);
                    for w in tl.warnings.iter().filter(|w| !shown_warnings.contains(w)) {
                        eprintln!("    ! {w}");
                    }
                    shown_warnings = tl.warnings.clone();
                }
                Err(e) => eprintln!("✗ couldn't render: {e}"),
            },
        }
    }
    eprintln!();
    Ok(())
}

fn stdin_lines() -> std::sync::mpsc::Receiver<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in std::io::stdin().lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    rx
}

const HELP: &str = "mute NAME · unmute NAME · solo NAME · unsolo NAME · gain NAME dB · reset · tracks";

/// Apply one typed mix command. Tracks and buses are named as in the score, or numbered from 1.
/// A change to anything baked into a bus (a grouped track, a send, any solo) re-mixes the buses
/// and swaps the result in right away; tracks that go straight to the master change instantly.
fn mix_command(ctl: &mut Controller, renderer: &Renderer, line: &str) -> Result<String, String> {
    let words: Vec<&str> = line.split_whitespace().collect();
    let Some((&verb, args)) = words.split_first() else { return Ok(String::new()) };
    let tracks = renderer.mix().map_or_else(|| ctl.tracks().to_vec(), |m| m.names());
    let msg = apply_mix_command(ctl, &tracks, verb, args)?;
    if let (Some(m), Some(name)) = (renderer.mix(), msg.1) {
        let solo_changed = msg.2;
        if m.has_buses() && (solo_changed || name.as_deref().is_none_or(|n| m.baked(n))) {
            let t0 = Instant::now();
            if let Some(arr) = renderer.remix(ctl.controls()) {
                ctl.load(arr, SwapAt::Now)?;
                return Ok(format!("{}   (buses re-mixed in {:.0} ms)", msg.0, t0.elapsed().as_secs_f64() * 1e3));
            }
        }
    }
    Ok(msg.0)
}

/// (message, Some(changed track, or None for all), whether a solo changed)
type Applied = (String, Option<Option<String>>, bool);

fn apply_mix_command(ctl: &mut Controller, tracks: &[String], verb: &str, args: &[&str]) -> Result<Applied, String> {
    let tracks = tracks.to_vec();
    let names = || tracks.iter().enumerate().map(|(i, n)| format!("{}. {n}", i + 1)).collect::<Vec<_>>().join("  ");
    let name = |a: Option<&&str>| -> Result<String, String> {
        let a = a.ok_or_else(|| format!("which track? {}", names()))?;
        if let Ok(i) = a.parse::<usize>() {
            return tracks.get(i.wrapping_sub(1)).cloned().ok_or_else(|| format!("no track {i}; {}", names()));
        }
        tracks.iter().find(|t| t.as_str() == *a).cloned().ok_or_else(|| format!("no track `{a}`; {}", names()))
    };
    let mut set = |n: String, f: &dyn Fn(&mut TrackControl)| -> Result<Applied, String> {
        let before = ctl.track(&n);
        let mut c = before;
        f(&mut c);
        ctl.set_track(&n, c)?;
        Ok((listing_after(ctl, &tracks), Some(Some(n)), before.solo != c.solo))
    };
    match verb {
        "mute" | "m" => set(name(args.first())?, &|c| c.mute = true),
        "unmute" | "um" => set(name(args.first())?, &|c| c.mute = false),
        "solo" | "s" => set(name(args.first())?, &|c| c.solo = true),
        "unsolo" | "us" => set(name(args.first())?, &|c| c.solo = false),
        "gain" | "g" => {
            let n = name(args.first())?;
            let db: f32 = args.get(1).map(|d| d.trim_end_matches("dB").trim_end_matches("db")).and_then(|d| d.parse().ok()).ok_or("gain NAME dB, e.g. `gain bass -6`")?;
            if !(-60.0..=12.0).contains(&db) {
                return Err("gain must be between -60 and +12 dB".into());
            }
            set(n, &|c| c.gain = 10f32.powf(db / 20.0))
        }
        "reset" => {
            for t in &tracks {
                ctl.set_track(t, TrackControl::default())?;
            }
            Ok((listing_after(ctl, &tracks), Some(None), true))
        }
        "tracks" | "t" => Ok((listing_after(ctl, &tracks), None, false)),
        "help" | "?" => Ok((HELP.into(), None, false)),
        _ => Err(format!("unknown command `{verb}`; {HELP}")),
    }
}

fn listing_after(ctl: &Controller, tracks: &[String]) -> String {
    tracks
        .iter()
        .enumerate()
        .map(|(i, n)| {
            let c = ctl.track(n);
            let db = 20.0 * c.gain.max(1e-6).log10();
            let flags = [(c.mute, " muted"), (c.solo, " solo")].iter().filter(|f| f.0).map(|f| f.1).collect::<String>();
            format!("{}. {n}{}{flags}", i + 1, if db.abs() > 0.05 { format!(" {db:+.1} dB") } else { String::new() })
        })
        .collect::<Vec<_>>()
        .join("   ")
}

fn silent_clock(mut mixer: Mixer, sr: u32) {
    let block = 512;
    let mut buf = vec![0.0f32; block * 2];
    let period = Duration::from_secs_f64(block as f64 / sr as f64);
    let mut next = Instant::now();
    loop {
        mixer.process_interleaved(&mut buf, 2);
        next += period;
        if let Some(d) = next.checked_duration_since(Instant::now()) {
            std::thread::sleep(d);
        }
    }
}

fn open_device(mut mixer: Mixer, volume: f32) -> Result<(u32, Option<cpal::Stream>), String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or("no audio output device")?;
    let config = device.default_output_config().map_err(|e| e.to_string())?;
    if config.sample_format() != cpal::SampleFormat::F32 {
        return Err(format!("output device wants {:?} samples; only f32 is supported so far", config.sample_format()));
    }
    let sr = config.sample_rate();
    let channels = config.channels() as usize;
    let stream = device
        .build_output_stream(config.into(), move |out: &mut [f32], _| {
                mixer.process_interleaved(out, channels);
                if volume != 1.0 {
                    out.iter_mut().for_each(|x| *x *= volume);
                }
            }, |e| eprintln!("audio error: {e}"), None)
        .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((sr, Some(stream)))
}
