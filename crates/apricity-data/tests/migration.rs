//! Migration (design/storage.md §5) over a small hand-made repository: a Marine Band piece with
//! a stem, annotations, candidates, verdicts, a crate and two scores.

use apricity_data::{
    Library, MigrationReport, candidate_id, clip_id, curated_slice_id, loader, migrate,
    stem_clip_id,
};
use apricity_score::{compile_file, compile_text};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use tempfile::TempDir;
use virtuus_amplify::Identity;

const PIECE_SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STEM_SHA: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SCORE: &str = "tempo 120\nkey F major\nsamples ../samples\n\nchords I . . . | IV . . . | I . . . | V . . .\n\nclip a = marine-band/Piece.wav  loop-1\nclip d = marine-band/stems/Piece/drums.wav\n\ntrack a at 1 2\ntrack d at 3 1\n";

/// A tiny but valid mono 8 kHz WAV whose bytes depend on `seed`.
fn write_wav(path: &Path, seed: u8) {
    let data: Vec<u8> = (0..800u32).map(|i| (i as u8).wrapping_mul(seed)).collect();
    let mut wav = b"RIFF".to_vec();
    wav.extend((36 + data.len() as u32).to_le_bytes());
    wav.extend(b"WAVEfmt ");
    wav.extend(16u32.to_le_bytes());
    wav.extend([1, 0, 1, 0]);
    wav.extend(8000u32.to_le_bytes());
    wav.extend(16000u32.to_le_bytes());
    wav.extend([2, 0, 8, 0]);
    wav.extend(b"data");
    wav.extend((data.len() as u32).to_le_bytes());
    wav.extend(data);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, wav).unwrap();
}

fn manifest(file: &str, sha: &str, derived: Option<Value>, annotations: Value) -> Value {
    let beats: Vec<f64> = (0..17).map(|i| i as f64 * 0.5).collect();
    let warp: Vec<Value> = beats
        .iter()
        .enumerate()
        .map(|(i, s)| json!({"seconds": s, "beat": i}))
        .collect();
    let mut m = json!({
        "apricity_manifest": 2,
        "source": {"path": file, "sha256": sha, "sample_rate": 8000, "channels": 1, "duration": 8.0},
        "analysis": {"analyzed_at": "2026-09-23T23:27:34+00:00"},
        "rhythm": {"bpm": 120.0, "bpm_stability": 0.9, "beats": beats, "meter": 4, "warp_markers": warp, "beat_loudness": vec![-20.0; 16]},
        "tonal": {"key": {"tonic": "F", "mode": "major", "camelot": "7B"}, "tuning_cents": 3.0, "pitch_class_profile": vec![0.1; 12],
                  "segments": [{"start": 0.0, "end": 8.0, "key": {"tonic": "F", "mode": "major"}}]},
        "notes": [{"start": 0.0, "end": 0.5, "midi": 60, "velocity": 0.5}],
        "annotations": annotations,
    });
    if let Some(d) = derived {
        m["derived_from"] = d;
    }
    m
}

fn write_json(path: &Path, v: &Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_string_pretty(v).unwrap()).unwrap();
}

/// samples/ (piece + drums stem), library/ (candidates, verdicts, crates) and examples/song.apr.
fn build_repo() -> TempDir {
    let dir = TempDir::new().unwrap();
    let r = dir.path();
    let mb = r.join("samples/marine-band");
    write_wav(&mb.join("Piece.wav"), 3);
    write_wav(&mb.join("stems/Piece/drums.wav"), 5);
    let annotations = json!({
        "clips": [
            {"name": "loop-1", "start": 0.0, "end": 2.0, "source": "ml", "tags": ["loop", "2.0s"]},
            {"name": "loop-2", "start": 2.0, "end": 4.0, "source": "ml", "tags": ["loop"]},
            {"name": "brk-1", "start": 4.0, "end": 6.0, "source": "curated", "tags": ["break", "dusty"], "candidate": "c-0000000001", "stars": 4},
        ],
        "markers": [{"name": "section A", "seconds": 0.0, "source": "ml", "note": "4 bars"}, {"name": "section A", "seconds": 4.0, "source": "ml"}],
    });
    write_json(
        &mb.join("Piece.wav.apricity.json"),
        &manifest("Piece.wav", PIECE_SHA, None, annotations),
    );
    let derived =
        json!({"source": "samples/marine-band/Piece.wav", "stem": "drums", "model": "htdemucs"});
    write_json(
        &mb.join("stems/Piece/drums.wav.apricity.json"),
        &manifest("drums.wav", STEM_SHA, Some(derived), json!({})),
    );
    write_json(
        &r.join("samples/sources.json"),
        &json!({"files": [
            {"path": "marine-band/Piece.wav", "title": "The Piece", "performer": "The Band", "composed": 1896, "credit": "Band credit", "rights": "Public domain", "source_page": "https://example.com/piece"},
            {"path": "marine-band/scores/Piece.pdf", "kind": "score", "title": "The Piece", "url": "https://example.com/piece.pdf"},
        ]}),
    );
    write_json(
        &r.join("library/candidates.json"),
        &json!({"candidates": [
            {"id": "c-0000000001", "clip": "marine-band/Piece.wav", "start": 4.0, "end": 6.0, "kind": "break", "name": "break-1", "recording": "Piece",
             "context": {"seconds": 2.0, "bpm": 120.0, "beats": 4.0, "key": "F major", "stem": null},
             "proposers": [{"by": "analyzer:a", "score": 0.4, "why": "steady", "evidence": {"x": 1}, "at": "2026-09-24T03:55:46+00:00"},
                           {"by": "agent:b", "score": 0.7, "why": "clean", "at": "2026-09-24T04:00:00+00:00"}]},
            {"id": "c-0000000002", "clip": "marine-band/Piece.wav", "start": 0.0, "end": 1.0, "kind": "hit", "proposers": [{"by": "analyzer:a", "score": 0.1, "why": "loud", "at": "2026-09-24T03:55:46+00:00"}]},
        ]}),
    );
    write_json(
        &r.join("library/verdicts.json"),
        &json!({"verdicts": {"c-0000000001": {"verdict": "keep", "at": "2026-09-24T05:00:00+00:00", "by": "person", "stars": 4, "tags": ["dusty"], "name": "brk-1"}}}),
    );
    write_json(
        &r.join("library/crates.json"),
        &json!({"crates": {"breaks": {"items": ["c-0000000001", "c-0000000002"], "note": "for later"}}}),
    );
    fs::create_dir_all(r.join("examples")).unwrap();
    fs::write(r.join("examples/song.apr"), SCORE).unwrap();
    dir
}

struct Migrated {
    _repo: TempDir,
    repo: PathBuf,
    lib_dir: TempDir,
    lib: Library,
    report: MigrationReport,
}

impl Migrated {
    fn new(link: bool) -> Self {
        let repo = build_repo();
        Self::from_repo(repo, link)
    }

    fn from_repo(repo: TempDir, link: bool) -> Self {
        let lib_dir = TempDir::new().unwrap();
        let mut lib = Library::create(lib_dir.path().join("lib")).unwrap();
        let path = lib.path().to_path_buf();
        let report = migrate(repo.path(), lib.engine_mut(), &path, link).unwrap();
        Migrated {
            repo: repo.path().to_path_buf(),
            _repo: repo,
            lib_dir,
            lib,
            report,
        }
    }

    fn get(&mut self, model: &str, args: Value) -> Value {
        let id = Identity::User {
            sub: "local".into(),
            username: "test".into(),
            groups: vec!["members".into()],
        };
        let (data, errors) = self
            .lib
            .engine_mut()
            .call(model, "get", &args, &id)
            .unwrap();
        assert!(errors.is_none_or(|e| e.is_empty()));
        data
    }

    fn files(&self) -> PathBuf {
        self.lib.path().join("files")
    }

    fn rerun(&mut self, link: bool) -> MigrationReport {
        let path = self.lib.path().to_path_buf();
        migrate(&self.repo, self.lib.engine_mut(), &path, link).unwrap()
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[test]
fn counts_and_report() {
    let m = Migrated::new(false);
    let r = &m.report;
    assert_eq!(
        r.recordings, 1,
        "one recording per Marine Band piece, stem included"
    );
    assert_eq!((r.clips, r.slices, r.markers), (2, 3, 2));
    assert_eq!(
        (r.candidates, r.verdicts, r.crates, r.crate_items),
        (2, 1, 1, 2)
    );
    assert_eq!((r.scores, r.score_refs), (1, 2));
    assert_eq!(r.files, 4, "two audio files and two analysis attachments");
    assert!(r.unresolved.is_empty(), "{:?}", r.unresolved);
    assert!(
        r.skipped.iter().any(|s| s.contains("Piece.pdf")),
        "the absent PDF is reported: {:?}",
        r.skipped
    );
    assert!(r.display().contains("Clips: 2"));
}

#[test]
fn clips_recordings_and_stems() {
    let mut m = Migrated::new(false);
    let piece = clip_id(PIECE_SHA);
    let stem = stem_clip_id(&piece, "drums", "htdemucs");
    let rec = m.get("Recording", json!({"id": "rec_Piece"}));
    assert_eq!(
        (
            rec["title"].as_str(),
            rec["performer"].as_str(),
            rec["composed"].as_i64()
        ),
        (Some("The Piece"), Some("The Band"), Some(1896))
    );
    assert_eq!(rec["collection"], "marine-band");

    let c = m.get("Clip", json!({"id": piece}));
    assert_eq!(
        (
            c["path"].as_str(),
            c["role"].as_str(),
            c["recordingId"].as_str()
        ),
        (
            Some("marine-band/Piece.wav"),
            Some("source"),
            Some("rec_Piece")
        )
    );
    assert_eq!(c["aliases"], json!(["samples/marine-band/Piece.wav"]));
    assert_eq!(
        (
            c["key"].as_str(),
            c["camelot"].as_str(),
            c["meter"].as_i64(),
            c["noteCount"].as_i64()
        ),
        (Some("F major"), Some("7B"), Some(4), Some(1))
    );
    assert_eq!(c["keysOverTime"], json!(["F major"]));
    let counters: Value = serde_json::from_str(c["nameCounters"].as_str().unwrap()).unwrap();
    assert_eq!(
        counters,
        json!({"loop": 2}),
        "loop-N names are never reused"
    );

    let s = m.get("Clip", json!({"id": stem}));
    assert_eq!(
        (
            s["role"].as_str(),
            s["stem"].as_str(),
            s["stemModel"].as_str()
        ),
        (Some("stem"), Some("drums"), Some("htdemucs"))
    );
    assert_eq!(s["parentClipId"].as_str(), Some(piece.as_str()));
    assert_eq!(s["recordingId"], "rec_Piece");
}

#[test]
fn audio_is_copied_byte_equal_and_analysis_is_content_addressed() {
    let mut m = Migrated::new(false);
    let piece = clip_id(PIECE_SHA);
    let src = m.repo.join("samples/marine-band/Piece.wav");
    let dst = m.files().join(format!("audio/{piece}/Piece.wav"));
    assert_eq!(fs::read(&src).unwrap(), fs::read(&dst).unwrap());
    assert_ne!(
        fs::metadata(&src).unwrap().ino(),
        fs::metadata(&dst).unwrap().ino(),
        "a copy, not a link"
    );

    let clip = m.get("Clip", json!({"id": piece}));
    assert_eq!(
        clip["audio"]["sha256"].as_str(),
        Some(sha256_hex(&fs::read(&src).unwrap()).as_str())
    );
    assert_eq!(
        clip["audio"]["key"].as_str(),
        Some(format!("audio/{piece}/Piece.wav").as_str())
    );

    let key = clip["analysis"]["key"].as_str().unwrap().to_string();
    let sha = clip["analysis"]["sha256"].as_str().unwrap();
    assert_eq!(key, format!("analysis/{piece}/{sha}.json"));
    let bytes = fs::read(m.files().join(&key)).unwrap();
    assert_eq!(
        sha256_hex(&bytes),
        sha,
        "the filename is the sha256 of the content"
    );
    assert_eq!(clip["analysis"]["size"].as_u64(), Some(bytes.len() as u64));
    let analysis: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(
        analysis.get("annotations").is_none(),
        "annotations live in Slice and Marker records"
    );
    assert_eq!(analysis["rhythm"]["bpm"], 120.0);
}

#[test]
fn link_shares_the_inode() {
    let m = Migrated::new(true);
    let piece = clip_id(PIECE_SHA);
    let src = fs::metadata(m.repo.join("samples/marine-band/Piece.wav")).unwrap();
    let dst = fs::metadata(m.files().join(format!("audio/{piece}/Piece.wav"))).unwrap();
    assert_eq!((src.dev(), src.ino()), (dst.dev(), dst.ino()));
}

#[test]
fn second_run_changes_nothing() {
    for link in [false, true] {
        let mut m = Migrated::new(link);
        let piece = clip_id(PIECE_SHA);
        let audio = m.files().join(format!("audio/{piece}/Piece.wav"));
        let before = fs::metadata(&audio).unwrap();
        let again = m.rerun(link);
        assert_eq!(again.total_changes(), 0, "link={link}: {again:?}");
        let after = fs::metadata(&audio).unwrap();
        assert_eq!(
            (before.ino(), before.mtime(), before.mtime_nsec()),
            (after.ino(), after.mtime(), after.mtime_nsec()),
            "link={link}: no re-copy"
        );
        // ...and it is still idempotent from a reopened library.
        let path = m.lib.path().to_path_buf();
        let mut reopened = Library::open(&path, None).unwrap();
        assert_eq!(
            migrate(&m.repo, reopened.engine_mut(), &path, link)
                .unwrap()
                .total_changes(),
            0,
            "link={link}, reopened"
        );
    }
}

#[test]
fn changed_input_is_picked_up() {
    let mut m = Migrated::new(false);
    let mb = m.repo.join("samples/marine-band");
    let mut manifest: Value =
        serde_json::from_str(&fs::read_to_string(mb.join("Piece.wav.apricity.json")).unwrap())
            .unwrap();
    manifest["annotations"]["clips"][0]["end"] = json!(2.5);
    write_json(&mb.join("Piece.wav.apricity.json"), &manifest);
    let again = m.rerun(false);
    assert_eq!(
        (
            again.slices,
            again.score_refs,
            again.clips,
            again.files,
            again.total_changes()
        ),
        (1, 1, 0, 0, 2),
        "the edited slice and the score reference that records its span change; the analysis attachment is untouched: {again:?}"
    );
}

#[test]
fn candidates_verdicts_crates_and_curated_slices() {
    let mut m = Migrated::new(false);
    let piece = clip_id(PIECE_SHA);
    let cid = candidate_id(&piece, 4.0, 6.0, "break");
    let cand = m.get("Candidate", json!({"id": cid}));
    assert_eq!(
        (
            cand["legacyId"].as_str(),
            cand["clipId"].as_str(),
            cand["recordingId"].as_str()
        ),
        (
            Some("c-0000000001"),
            Some(piece.as_str()),
            Some("rec_Piece")
        )
    );
    assert_eq!(
        (
            cand["kind"].as_str(),
            cand["baseScore"].as_f64(),
            cand["proposers"].as_array().map(Vec::len)
        ),
        (Some("break"), Some(0.7), Some(2))
    );
    assert_eq!(cand["context"]["key"], "F major");

    let v = m.get("Verdict", json!({"candidateId": cid, "judge": "local"}));
    assert_eq!(
        (
            v["verdict"].as_str(),
            v["stars"].as_i64(),
            v["name"].as_str(),
            v["judgedAt"].as_str()
        ),
        (
            Some("keep"),
            Some(4),
            Some("brk-1"),
            Some("2026-09-24T05:00:00+00:00")
        )
    );

    let slice = m.get("Slice", json!({"id": curated_slice_id(&cid)}));
    assert_eq!(
        (
            slice["name"].as_str(),
            slice["source"].as_str(),
            slice["candidateId"].as_str(),
            slice["kind"].as_str()
        ),
        (
            Some("brk-1"),
            Some("curated"),
            Some(cid.as_str()),
            Some("break")
        )
    );

    let other = candidate_id(&piece, 0.0, 1.0, "hit");
    let first = m.get("CrateItem", json!({"id": format!("citm_crt_breaks_{cid}")}));
    let second = m.get(
        "CrateItem",
        json!({"id": format!("citm_crt_breaks_{other}")}),
    );
    assert_eq!(
        (first["position"].as_str(), second["position"].as_str()),
        (Some("a0"), Some("a1"))
    );
    assert_eq!(
        first["sliceId"].as_str(),
        Some(curated_slice_id(&cid).as_str()),
        "a kept candidate's item points at its curated slice"
    );
    assert!(second.get("sliceId").is_none());
    assert_eq!(
        m.get("Crate", json!({"id": "crt_breaks"}))["note"],
        "for later"
    );
}

#[test]
fn score_refs_resolve_by_alias_and_slice_name() {
    let mut m = Migrated::new(false);
    let piece = clip_id(PIECE_SHA);
    let score = m.get("Score", json!({"id": "scr_examples_song_apr"}));
    assert_eq!(
        (
            score["folder"].as_str(),
            score["format"].as_str(),
            score["legacyPath"].as_str(),
            score["text"].as_str()
        ),
        (
            Some("examples"),
            Some("apr"),
            Some("examples/song.apr"),
            Some(SCORE)
        )
    );
    let slice_id = apricity_data::migrated_slice_id(&piece, "loop-1");
    let r = m.get("ScoreRef", json!({"id": "sref_scr_examples_song_apr_a"}));
    assert_eq!(
        (
            r["clipId"].as_str(),
            r["clipPath"].as_str(),
            r["sliceName"].as_str(),
            r["sliceId"].as_str()
        ),
        (
            Some(piece.as_str()),
            Some("marine-band/Piece.wav"),
            Some("loop-1"),
            Some(slice_id.as_str())
        )
    );
    assert_eq!(
        (r["start"].as_f64(), r["end"].as_f64()),
        (Some(0.0), Some(2.0))
    );
}

/// Serialise a Timeline with the library's audio paths mapped back to the samples they came from.
fn timeline_json(tl: &impl serde::Serialize, lib_files: &Path, repo: &Path) -> String {
    let mut s = serde_json::to_string_pretty(tl).unwrap();
    for (rel, lib_rel) in [
        (
            "marine-band/Piece.wav",
            format!("audio/{}/Piece.wav", clip_id(PIECE_SHA)),
        ),
        (
            "marine-band/stems/Piece/drums.wav",
            format!(
                "audio/{}/drums.wav",
                stem_clip_id(&clip_id(PIECE_SHA), "drums", "htdemucs")
            ),
        ),
    ] {
        s = s.replace(
            &lib_files.join(lib_rel).to_string_lossy().to_string(),
            &repo.join("samples").join(rel).to_string_lossy(),
        );
    }
    s
}

#[test]
fn library_timeline_equals_file_timeline() {
    let mut m = Migrated::new(true);
    let score_path = m.repo.join("examples/song.apr");
    let from_files = compile_file(&score_path).unwrap();
    assert!(from_files.events.iter().any(|_| true));

    let mut load = loader::make(&mut m.lib, &m.repo).unwrap();
    let from_library = compile_text(SCORE, &score_path, &mut load).unwrap();
    assert_eq!(
        timeline_json(&from_files, &m.files(), &m.repo),
        timeline_json(&from_library, &m.files(), &m.repo)
    );

    // Regression: the loader once wrote annotations under `slices` while the manifest reads
    // `clips`, dropping every slice; and the audio it points at must be the library's own copy.
    let clip = load(&m.repo.join("samples/marine-band/Piece.wav")).unwrap();
    let names: Vec<&str> = clip
        .manifest
        .annotations
        .clips
        .iter()
        .map(|c| c.name.as_str())
        .collect();
    assert_eq!(names, ["loop-1", "loop-2", "brk-1"]);
    assert_eq!(
        clip.manifest.annotations.markers.len(),
        2,
        "both `section A` markers survive"
    );
    assert!(clip.audio.starts_with(m.files()));
    assert!(m.lib_dir.path().exists());
}

#[test]
fn loader_resolves_repo_relative_alias_and_reports_unknown_paths() {
    let mut m = Migrated::new(false);
    let mut load = loader::make(&mut m.lib, &m.repo).unwrap();
    // The audio does not have to exist on disk: the library holds it.
    let via_alias = load(&m.repo.join("samples/marine-band/Piece.wav")).unwrap();
    let via_catalog = load(&m.repo.join("marine-band/Piece.wav")).unwrap();
    assert_eq!(via_alias.audio, via_catalog.audio);
    let err = load(&m.repo.join("samples/marine-band/Nope.wav"))
        .err()
        .unwrap();
    assert!(err.contains("not found in library"), "{err}");
}

#[test]
fn unresolved_references_are_reported_not_hidden() {
    let repo = build_repo();
    fs::write(
        repo.path().join("examples/broken.apr"),
        "tempo 120\nkey F major\nsamples ../samples\n\nchords I . . . | IV . . .\n\nclip a = marine-band/Missing.wav\nclip b = marine-band/Piece.wav  no-such-slice\n\ntrack a at 1 1\ntrack b at 2 1\n",
    )
    .unwrap();
    let m = Migrated::from_repo(repo, false);
    assert_eq!(m.report.unresolved.len(), 2, "{:?}", m.report.unresolved);
    assert!(
        m.report
            .unresolved
            .iter()
            .any(|u| u.contains("Missing.wav"))
    );
    assert!(
        m.report
            .unresolved
            .iter()
            .any(|u| u.contains("no-such-slice"))
    );
    assert_eq!(m.report.scores, 2, "the score is still stored");
    assert!(m.report.display().contains("UNRESOLVED"));
}

#[test]
fn verdict_for_unknown_candidate_is_unresolved() {
    let repo = build_repo();
    write_json(
        &repo.path().join("library/verdicts.json"),
        &json!({"verdicts": {"c-ffffffffff": {"verdict": "skip", "at": "2026-09-24T05:00:00+00:00"}}}),
    );
    let m = Migrated::from_repo(repo, false);
    assert_eq!(m.report.unresolved.len(), 1);
    assert!(m.report.unresolved[0].contains("c-ffffffffff"));
    assert_eq!(m.report.verdicts, 0);
}

#[test]
fn edited_score_drops_stale_refs() {
    let mut m = Migrated::new(false);
    fs::write(m.repo.join("examples/song.apr"), "tempo 120\nkey F major\nsamples ../samples\n\nchords I . . . | IV . . .\n\nclip d = marine-band/stems/Piece/drums.wav\n\ntrack d at 1 1\n").unwrap();
    let again = m.rerun(false);
    assert_eq!(
        (again.scores, again.score_refs),
        (1, 1),
        "the score changed and its reference to clip `a` was dropped: {again:?}"
    );
    let old = m.get("ScoreRef", json!({"id": "sref_scr_examples_song_apr_a"}));
    assert!(old.is_null(), "the reference to clip `a` is gone");
}

#[test]
fn empty_repo_migrates_nothing() {
    let dir = TempDir::new().unwrap();
    let m = Migrated::from_repo(dir, false);
    assert_eq!(m.report.total_changes(), 0);
    assert!(m.report.unresolved.is_empty());
}

#[test]
fn stem_of_unknown_parent_is_an_error() {
    let repo = build_repo();
    let mb = repo.path().join("samples/marine-band");
    let derived =
        json!({"source": "samples/marine-band/Gone.wav", "stem": "bass", "model": "htdemucs"});
    write_wav(&mb.join("stems/Piece/bass.wav"), 7);
    write_json(
        &mb.join("stems/Piece/bass.wav.apricity.json"),
        &manifest("bass.wav", "cccc", Some(derived), json!({})),
    );
    let lib_dir = TempDir::new().unwrap();
    let mut lib = Library::create(lib_dir.path()).unwrap();
    let path = lib.path().to_path_buf();
    let err = migrate(repo.path(), lib.engine_mut(), &path, false).unwrap_err();
    assert!(err.to_string().contains("Gone.wav"), "{err}");
}
