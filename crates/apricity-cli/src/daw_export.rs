//! Prepare media and publish a Live set only after all inputs have been checked.
use apricity_daw::SampleReference;
use apricity_score::Timeline;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use symphonia::core::{
    formats::FormatOptions, io::MediaSourceStream, meta::MetadataOptions, probe::Hint,
};

fn directories(path: &Path, made: &mut Vec<PathBuf>) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        if parent != path {
            directories(parent, made)?;
        }
    }
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() && path.is_dir() => Ok(()),
        Ok(m) if !m.is_dir() => Err(format!(
            "{}: destination is not a directory",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => match fs::create_dir(path) {
            Ok(()) => {
                made.push(path.to_owned());
                Ok(())
            }
            Err(e) => Err(format!("{}: {e}", path.display())),
        },
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

fn same_file(a: &Path, b: &Path) -> Result<bool, String> {
    let mut a = fs::File::open(a).map_err(|e| e.to_string())?;
    let mut b = fs::File::open(b).map_err(|e| e.to_string())?;
    let (mut x, mut y) = ([0u8; 65536], [0u8; 65536]);
    loop {
        let n = a.read(&mut x).map_err(|e| e.to_string())?;
        let m = b.read(&mut y).map_err(|e| e.to_string())?;
        if n != m || x[..n] != y[..m] {
            return Ok(false);
        }
        if n == 0 {
            return Ok(true);
        }
    }
}
fn stage_audio(path: &Path, temp: &Path) -> Result<String, String> {
    let mut input = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut output = fs::File::create(temp).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = input.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
        output.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn managed_dir(path: &Path, made: &mut Vec<PathBuf>) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(format!(
            "{}: managed directory is a symlink",
            path.display()
        ));
    }
    directories(path, made)
}

fn live_path(path: &Path) -> Result<String, String> {
    let value = path
        .to_str()
        .ok_or_else(|| format!("{}: Live paths must be UTF-8", path.display()))?;
    #[cfg(unix)]
    if value.contains('\\') {
        return Err(format!(
            "{}: Live paths cannot contain backslashes",
            path.display()
        ));
    }
    #[cfg(windows)]
    let value = value.replace('\\', "/");
    Ok(value.to_string())
}

fn metadata(path: &Path) -> Result<(u64, u64, u32), String> {
    let file = fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    if len >= 2 * 1024 * 1024 * 1024 {
        return Err(format!(
            "{}: Live 11 does not support audio files of 2 GiB or larger",
            path.display()
        ));
    }
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|v| v.to_str()) {
        hint.with_extension(ext);
    }
    let mut probed = symphonia::default::get_probe()
        .format(
            &hint,
            MediaSourceStream::new(Box::new(file), Default::default()),
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let track = probed
        .format
        .default_track()
        .ok_or_else(|| format!("{}: no audio track", path.display()))?;
    use symphonia::core::codecs::*;
    let codec = track.codec_params.codec;
    if codec == CODEC_TYPE_OPUS {
        return Err(format!(
            "{}: Opus is unsupported by Live 11",
            path.display()
        ));
    }
    // Live supports PCM, FLAC, MP3 and Ogg Vorbis. Refuse unrecognized formats.
    let ext = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !["wav", "wave", "aif", "aiff", "flac", "mp3", "ogg"].contains(&ext.as_str()) {
        return Err(format!(
            "{}: unsupported Live 11 audio format",
            path.display()
        ));
    }
    let pcm = matches!(
        codec,
        CODEC_TYPE_PCM_S16LE
            | CODEC_TYPE_PCM_S16BE
            | CODEC_TYPE_PCM_S24LE
            | CODEC_TYPE_PCM_S24BE
            | CODEC_TYPE_PCM_U8
            | CODEC_TYPE_PCM_S8
            | CODEC_TYPE_PCM_F32LE
            | CODEC_TYPE_PCM_F32BE
    );
    let supported = match ext.as_str() {
        "wav" | "wave" | "aif" | "aiff" => pcm,
        "flac" => codec == CODEC_TYPE_FLAC,
        "mp3" => codec == CODEC_TYPE_MP3,
        "ogg" => codec == CODEC_TYPE_VORBIS,
        _ => false,
    };
    if !supported {
        return Err(format!(
            "{}: unsupported Live 11 codec/container",
            path.display()
        ));
    }
    if track.codec_params.channels.is_some_and(|c| c.count() > 2) {
        return Err(format!(
            "{}: Live 11 requires mono or stereo audio",
            path.display()
        ));
    }
    let track_id = track.id;
    let header_frames = track.codec_params.n_frames;
    let sr = track
        .codec_params
        .sample_rate
        .ok_or_else(|| format!("{}: unknown sample rate", path.display()))?;
    if sr > 192_000 {
        return Err(format!(
            "{}: Live 11 supports sample rates up to 192 kHz",
            path.display()
        ));
    }
    let frames = match header_frames {
        Some(n) if n > 0 => n,
        _ => {
            let mut frames = 0u64;
            while let Ok(packet) = probed.format.next_packet() {
                if packet.track_id() == track_id {
                    frames = frames.saturating_add(packet.dur());
                }
            }
            if frames == 0 {
                return Err(format!(
                    "{}: cannot determine audio frame count",
                    path.display()
                ));
            }
            frames
        }
    };
    Ok((len, frames, sr))
}

pub fn run(
    t: &Timeline,
    score: &Path,
    out: Option<&Path>,
    no_collect: bool,
    force: bool,
) -> Result<(), String> {
    apricity_daw::validate_timeline(t)?;
    let stem = score
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("score has no filename")?;
    let target = match out {
        Some(p) if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("als")) => p.to_owned(),
        Some(p) => p.join(format!("{stem}.als")),
        None => PathBuf::from(format!("{stem} Project")).join(format!("{stem}.als")),
    };
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut made = Vec::new();
    let mut published = Vec::new();
    let mut publish_lock = None;
    let result = (|| {
        directories(parent, &mut made)?;
        let parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
        let target = parent.join(target.file_name().ok_or("invalid output path")?);
        live_path(&target)?;
        let lock_name = format!(
            "apricity-live-{:x}.lock",
            Sha256::digest(parent.to_string_lossy().as_bytes())
        );
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(std::env::temp_dir().join(lock_name))
            .map_err(|e| e.to_string())?;
        lock.lock()
            .map_err(|e| format!("cannot lock project: {e}"))?;
        publish_lock = Some(lock);
        if !no_collect {
            for dir in [
                parent.join("Ableton Project Info"),
                parent.join("Samples"),
                parent.join("Samples/Imported"),
            ] {
                if fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_symlink()) {
                    return Err(format!("{}: managed directory is a symlink", dir.display()));
                }
            }
        }
        match fs::symlink_metadata(&target) {
            Ok(m) if m.file_type().is_symlink() || !m.is_file() => {
                return Err(format!(
                    "{}: destination is not a regular file",
                    target.display()
                ))
            }
            Ok(_) if !force => {
                return Err(format!(
                    "{}: destination already exists (use --force)",
                    target.display()
                ))
            }
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
            _ => (),
        }
        let used: HashSet<_> = t.events.iter().map(|e| e.source).collect();
        let stage = tempfile::tempdir_in(&parent).map_err(|e| e.to_string())?;
        let mut cached: HashMap<PathBuf, SampleReference> = HashMap::new();
        let mut pending = Vec::new();
        let mut refs = vec![None; t.sources.len()];
        for (i, source) in t.sources.iter().enumerate() {
            if !used.contains(&i) {
                continue;
            }
            let path = fs::canonicalize(&source.path).map_err(|e| {
                format!("clip {} source {}: {e}", source.clip, source.path.display())
            })?;
            if let Some(reference) = cached.get(&path) {
                refs[i] = Some(reference.clone());
                continue;
            }
            live_path(&path)?;
            let (byte_len, frames, sample_rate) =
                metadata(&path).map_err(|e| format!("clip {}: {e}", source.clip))?;
            let (absolute, relative, kind) = if no_collect {
                let rel = pathdiff::diff_paths(&path, &parent)
                    .ok_or("cannot make relative sample path")?;
                (path.clone(), rel, 1)
            } else {
                let temp = stage.path().join(format!("media-{i}"));
                let hash = stage_audio(&path, &temp)?;
                let name = path
                    .file_stem()
                    .and_then(|n| n.to_str())
                    .unwrap_or("sample");
                let ext = path.extension().and_then(|n| n.to_str()).unwrap_or("");
                let mut suffix = 0u64;
                let (rel, dest, exists) = loop {
                    let tail = if suffix == 0 {
                        String::new()
                    } else {
                        format!("-{suffix}")
                    };
                    let rel = PathBuf::from("Samples/Imported")
                        .join(format!("{name}-{}{tail}.{ext}", &hash[..16]));
                    let dest = parent.join(&rel);
                    match fs::symlink_metadata(&dest) {
                        Ok(m)
                            if m.is_file()
                                && !m.file_type().is_symlink()
                                && same_file(&dest, &temp)? =>
                        {
                            break (rel, dest, true)
                        }
                        Ok(_) => suffix += 1,
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                            break (rel, dest, false)
                        }
                        Err(e) => return Err(format!("{}: {e}", dest.display())),
                    }
                };
                if !exists {
                    pending.push((temp, dest.clone()));
                }
                (dest, rel, 3)
            };
            let reference = SampleReference {
                absolute_path: live_path(&absolute)?,
                relative_path: live_path(&relative)?,
                relative_path_type: kind,
                byte_len,
                frames,
                sample_rate,
            };
            cached.insert(path, reference.clone());
            refs[i] = Some(reference);
        }
        let set = apricity_daw::export_set(t, &refs)?;
        let mut staged_set =
            tempfile::NamedTempFile::new_in(stage.path()).map_err(|e| e.to_string())?;
        staged_set
            .write_all(&set.bytes)
            .map_err(|e| e.to_string())?;
        if !no_collect {
            managed_dir(&parent.join("Ableton Project Info"), &mut made)?;
            managed_dir(&parent.join("Samples"), &mut made)?;
            managed_dir(&parent.join("Samples/Imported"), &mut made)?;
        }
        for (src, dest) in &pending {
            match fs::hard_link(src, dest) {
                Ok(()) => published.push(dest.clone()),
                Err(e)
                    if e.kind() == std::io::ErrorKind::AlreadyExists
                        && fs::symlink_metadata(dest)
                            .is_ok_and(|m| m.is_file() && !m.file_type().is_symlink())
                        && same_file(src, dest)? =>
                {
                    ()
                }
                Err(e) => return Err(format!("{}: {e}", dest.display())),
            }
        }
        if force {
            staged_set
                .persist(&target)
                .map_err(|e| format!("{}: {}", target.display(), e.error))?;
        } else {
            staged_set
                .persist_noclobber(&target)
                .map_err(|e| format!("{}: {}", target.display(), e.error))?;
        }
        eprintln!(
            "wrote {} — {} tracks, {} clips, {} locators, {} samples copied",
            target.display(),
            set.track_count,
            set.clip_count,
            set.locator_count,
            published.len()
        );
        for warning in set.warnings {
            eprintln!("  ! {warning}");
        }
        Ok(())
    })();
    if result.is_err() {
        for p in published.iter().rev() {
            let _ = fs::remove_file(p);
        }
        for p in made.iter().rev() {
            let _ = fs::remove_dir(p);
        }
    }
    drop(publish_lock);
    result
}
