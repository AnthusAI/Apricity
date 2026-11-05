//! Public CLI acceptance tests for Live 11 set export. No Live installation is required.
use cucumber::{given, then, when, World};
use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Output},
};

#[derive(Debug, Default, World)]
struct W {
    dir: Option<tempfile::TempDir>,
    output: Option<Output>,
    first: Vec<u8>,
}
impl W {
    fn root(&self) -> &Path {
        self.dir.as_ref().unwrap().path()
    }
    fn dest(&self) -> PathBuf {
        self.root().join("out/Set.als")
    }
    fn xml(&self) -> String {
        let mut s = String::new();
        GzDecoder::new(fs::File::open(self.dest()).expect("set was not created"))
            .read_to_string(&mut s)
            .expect("set is not gzip XML");
        s
    }
    fn invoke(&mut self, flags: &[&str]) {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_apricity"));
        cmd.current_dir(self.root())
            .args(["export", "--daw-set", "score.apr", "-o"])
            .arg(self.dest())
            .args(flags);
        self.output = Some(cmd.output().unwrap());
    }
    fn stderr(&self) -> String {
        String::from_utf8_lossy(&self.output.as_ref().unwrap().stderr).to_lowercase()
    }
}
fn fixture(root: &Path, path: &str, variant: i16) {
    let wav = root.join(path);
    fs::create_dir_all(wav.parent().unwrap()).unwrap();
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 8000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(&wav, spec).unwrap();
    for i in 0..64000 {
        writer
            .write_sample(if i % 4000 == 0 {
                10000 + variant
            } else {
                variant
            })
            .unwrap();
    }
    writer.finalize().unwrap();
    let digest = format!("{:x}", Sha256::digest(fs::read(&wav).unwrap()));
    let markers: Vec<_> = (0..=16)
        .map(|i| serde_json::json!({"seconds": i as f64 / 2.0, "beat": i}))
        .collect();
    let beats: Vec<_> = (0..=16).map(|i| i as f64 / 2.0).collect();
    let manifest = serde_json::json!({"source":{"path":path,"sha256":digest,"duration":8.0},"rhythm":{"bpm":120,"beats":beats,"meter":4,"warp_markers":markers,"beat_loudness":vec![-18;16]},"tonal":{"key":{"tonic":"A","mode":"minor"},"tuning_cents":23,"pitch_class_profile":[0,0,0,0,0,0,0,0,0,1,0,0]}});
    fs::write(
        format!("{}.apricity.json", wav.display()),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
}
fn setup(w: &mut W, reverse: bool, collision: bool) {
    w.dir = Some(tempfile::tempdir().unwrap());
    fixture(w.root(), "a/tone.wav", 0);
    if collision {
        fixture(w.root(), "b/tone.wav", 1);
    }
    let second = if collision {
        "clip other = b/tone.wav seconds 0..8 warp beats\ntrack other transpose 0\n"
    } else {
        ""
    };
    let rev = if reverse { " reverse" } else { "" };
    fs::write(w.root().join("score.apr"), format!("tempo 99.5\nkey A minor\nsamples .\nclip tone = a/tone.wav seconds 0..8 warp beats\nchords i | iv | V | i\ntrack tone transpose 5 volume -6{rev}\n{second}")).unwrap();
    fs::create_dir(w.root().join("out")).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_apricity"))
        .current_dir(w.root())
        .args(["compile", "score.apr"])
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "fixture compile failed: {}",
        String::from_utf8_lossy(&compiled.stderr)
    );
}
fn val<'a>(node: roxmltree::Node<'a, 'a>, name: &str) -> &'a str {
    node.descendants()
        .find(|n| n.has_tag_name(name))
        .unwrap_or_else(|| panic!("missing {name}"))
        .attribute("Value")
        .unwrap()
}
fn close(actual: &str, expected: f64) {
    assert!(
        (actual.parse::<f64>().unwrap() - expected).abs() < 0.0001,
        "{actual} != {expected}"
    );
}
#[given("a synthetic four-bar score")]
async fn score(w: &mut W) {
    setup(w, false, false);
}
#[given("a synthetic four-bar score with a reversed event")]
async fn reverse(w: &mut W) {
    setup(w, true, false);
}
#[given("a score with two different samples named alike")]
async fn collision(w: &mut W) {
    setup(w, false, true);
}
#[given("an existing destination")]
async fn existing(w: &mut W) {
    fs::write(w.dest(), b"existing set").unwrap();
}
#[given("the source sample is missing")]
async fn missing(w: &mut W) {
    fs::remove_file(w.root().join("a/tone.wav")).unwrap();
}
#[when("I export the score")]
async fn export(w: &mut W) {
    w.invoke(&[]);
}
#[when("I export the score with force")]
async fn force(w: &mut W) {
    w.invoke(&["--force"]);
}
#[when("I export the score without collecting")]
async fn no_collect(w: &mut W) {
    w.invoke(&["--no-collect"]);
}
#[when("I export the score twice to the same destination")]
async fn twice(w: &mut W) {
    w.invoke(&[]);
    assert!(
        w.output.as_ref().unwrap().status.success(),
        "first export failed: {}",
        w.stderr()
    );
    w.first = fs::read(w.dest()).unwrap();
    w.invoke(&["--force"]);
}
#[then("the export succeeds")]
async fn success(w: &mut W) {
    assert!(
        w.output.as_ref().unwrap().status.success(),
        "export failed: {}",
        w.stderr()
    );
}
#[then("the set bytes are identical")]
async fn identical(w: &mut W) {
    assert_eq!(w.first, fs::read(w.dest()).unwrap());
}
#[then("the existing destination is unchanged")]
async fn unchanged(w: &mut W) {
    assert_eq!(fs::read(w.dest()).unwrap(), b"existing set");
}
#[then("the export fails with a destination diagnostic")]
async fn dest_error(w: &mut W) {
    assert!(!w.output.as_ref().unwrap().status.success());
    let e = w.stderr();
    assert!(e.contains("exist") || e.contains("destination"), "{e}");
}
#[then("the export fails with a missing source diagnostic")]
async fn source_error(w: &mut W) {
    assert!(!w.output.as_ref().unwrap().status.success());
    let e = w.stderr();
    assert!(
        e.contains("tone.wav")
            && (e.contains("missing") || e.contains("not found") || e.contains("no such")),
        "{e}"
    );
}
#[then("the export fails with an unsupported event diagnostic naming the track")]
async fn unsupported(w: &mut W) {
    assert!(!w.output.as_ref().unwrap().status.success());
    let e = w.stderr();
    assert!(
        e.contains("tone")
            && e.contains("reverse")
            && (e.contains("unsupported") || e.contains("not support")),
        "{e}"
    );
}
#[then("the set contains four editable arrangement clips at the score positions")]
async fn clips(w: &mut W) {
    let s = w.xml();
    let d = roxmltree::Document::parse(&s).unwrap();
    assert!(d.descendants().any(|n| n.has_tag_name("MasterTrack")));
    let clips: Vec<_> = d
        .descendants()
        .filter(|n| {
            n.has_tag_name("AudioClip")
                && n.ancestors().any(|a| a.has_tag_name("ArrangerAutomation"))
        })
        .collect();
    let tracks: Vec<_> = d
        .descendants()
        .filter(|n| {
            n.has_tag_name("AudioTrack")
                && n.descendants().any(|c| {
                    c.has_tag_name("AudioClip")
                        && c.ancestors().any(|a| a.has_tag_name("ArrangerAutomation"))
                })
        })
        .collect();
    assert_eq!(tracks.len(), 1);
    assert_eq!(val(tracks[0], "UserName"), "tone");
    assert_eq!(clips.len(), 4);
    for (i, c) in clips.iter().enumerate() {
        close(c.attribute("Time").unwrap(), i as f64 * 4.0);
        close(val(*c, "CurrentStart"), i as f64 * 4.0);
        close(val(*c, "CurrentEnd"), (i + 1) as f64 * 4.0);
    }
}
#[then("the set preserves tempo meter and loop")]
async fn transport(w: &mut W) {
    let s = w.xml();
    let d = roxmltree::Document::parse(&s).unwrap();
    let master = d
        .descendants()
        .find(|n| n.has_tag_name("MasterTrack"))
        .unwrap();
    let tempo = master
        .descendants()
        .find(|n| n.has_tag_name("Tempo"))
        .unwrap();
    close(val(tempo, "Manual"), 99.5);
    let meter = master
        .descendants()
        .find(|n| n.has_tag_name("TimeSignature"))
        .unwrap();
    close(val(meter, "Manual"), 201.0);
    for (parameter, event, expected) in [(tempo, "FloatEvent", 99.5), (meter, "EnumEvent", 201.0)] {
        let target = parameter
            .descendants()
            .find(|n| n.has_tag_name("AutomationTarget"))
            .unwrap()
            .attribute("Id")
            .unwrap();
        let envelope = master
            .descendants()
            .filter(|n| n.has_tag_name("AutomationEnvelope"))
            .find(|e| {
                e.descendants()
                    .any(|n| n.has_tag_name("PointeeId") && n.attribute("Value") == Some(target))
            })
            .expect("master parameter envelope");
        let sentinel = envelope
            .descendants()
            .find(|n| n.has_tag_name(event) && n.attribute("Time") == Some("-63072000"))
            .expect("master sentinel event");
        close(sentinel.attribute("Value").unwrap(), expected);
    }
    let t = d
        .descendants()
        .find(|n| n.has_tag_name("Transport"))
        .unwrap();
    assert_eq!(val(t, "LoopOn"), "true");
    close(val(t, "LoopStart"), 0.0);
    close(val(t, "LoopLength"), 16.0);
}
#[then("the clips preserve warp pitch detune and gain")]
async fn warp(w: &mut W) {
    let s = w.xml();
    let d = roxmltree::Document::parse(&s).unwrap();
    let clips: Vec<_> = d
        .descendants()
        .filter(|n| {
            n.has_tag_name("AudioClip")
                && n.ancestors().any(|a| a.has_tag_name("ArrangerAutomation"))
        })
        .collect();
    assert_eq!(clips.len(), 4);
    for (i, c) in clips.iter().enumerate() {
        assert_eq!(val(*c, "IsWarped"), "true");
        close(val(*c, "WarpMode"), 0.0);
        close(val(*c, "PitchCoarse"), 5.0);
        close(val(*c, "PitchFine"), -23.0);
        close(val(*c, "SampleVolume"), 10f64.powf(-8.0 / 20.0));
        let markers: Vec<_> = c
            .descendants()
            .filter(|n| n.has_tag_name("WarpMarker"))
            .collect();
        assert!(markers.len() >= 5);
        for j in 0..5 {
            close(
                markers[j].attribute("SecTime").unwrap(),
                i as f64 * 2.0 + j as f64 * 0.5,
            );
            close(markers[j].attribute("BeatTime").unwrap(), j as f64);
        }
    }
}
#[then("the set has chord change locators")]
async fn locators(w: &mut W) {
    let s = w.xml();
    let d = roxmltree::Document::parse(&s).unwrap();
    let ls: Vec<_> = d
        .descendants()
        .filter(|n| n.has_tag_name("Locator"))
        .collect();
    assert_eq!(ls.len(), 4);
    for (i, l) in ls.iter().enumerate() {
        close(val(*l, "Time"), i as f64 * 4.0);
        assert_eq!(val(*l, "Name"), ["i (Am)", "iv (Dm)", "V (E)", "i (Am)"][i]);
    }
}
#[then("the project collects the sample with a portable reference")]
async fn collected(w: &mut W) {
    let s = w.xml();
    let d = roxmltree::Document::parse(&s).unwrap();
    let f = d
        .descendants()
        .find(|n| {
            n.has_tag_name("FileRef")
                && n.ancestors().any(|a| {
                    a.has_tag_name("AudioClip")
                        && a.ancestors().any(|p| p.has_tag_name("ArrangerAutomation"))
                })
        })
        .unwrap();
    assert_eq!(val(f, "RelativePathType"), "3");
    let rel = val(f, "RelativePath");
    assert!(rel.starts_with("Samples/Imported/"));
    let copy = w.root().join("out").join(rel);
    assert_eq!(
        fs::read(&copy).unwrap(),
        fs::read(w.root().join("a/tone.wav")).unwrap()
    );
    assert_eq!(
        fs::canonicalize(val(f, "Path")).unwrap(),
        fs::canonicalize(&copy).unwrap()
    );
    close(
        val(f, "OriginalFileSize"),
        fs::metadata(copy).unwrap().len() as f64,
    );
    assert!(w.root().join("out/Ableton Project Info").is_dir());
}
#[then("the set references the original sample without copying it")]
async fn uncollected(w: &mut W) {
    let s = w.xml();
    let d = roxmltree::Document::parse(&s).unwrap();
    let f = d
        .descendants()
        .find(|n| {
            n.has_tag_name("FileRef")
                && n.ancestors().any(|a| {
                    a.has_tag_name("AudioClip")
                        && a.ancestors().any(|p| p.has_tag_name("ArrangerAutomation"))
                })
        })
        .unwrap();
    assert_eq!(val(f, "RelativePathType"), "1");
    let p = w.root().join("out").join(val(f, "RelativePath"));
    assert_eq!(
        fs::canonicalize(p).unwrap(),
        fs::canonicalize(w.root().join("a/tone.wav")).unwrap()
    );
    assert!(!w.root().join("out/Samples/Imported").exists());
}
#[then("both different sample files are collected and referenced")]
async fn collisions(w: &mut W) {
    let s = w.xml();
    let d = roxmltree::Document::parse(&s).unwrap();
    let mut paths: Vec<_> = d
        .descendants()
        .filter(|n| {
            n.has_tag_name("FileRef")
                && n.ancestors().any(|a| {
                    a.has_tag_name("AudioClip")
                        && a.ancestors().any(|p| p.has_tag_name("ArrangerAutomation"))
                })
        })
        .map(|f| val(f, "RelativePath").to_string())
        .collect();
    paths.sort();
    paths.dedup();
    assert_eq!(paths.len(), 2);
    let mut actual: Vec<_> = paths
        .iter()
        .map(|p| fs::read(w.root().join("out").join(p)).unwrap())
        .collect();
    actual.sort();
    let mut expected = vec![
        fs::read(w.root().join("a/tone.wav")).unwrap(),
        fs::read(w.root().join("b/tone.wav")).unwrap(),
    ];
    expected.sort();
    assert_eq!(actual, expected);
}
#[given("a three-beat score with a repeated chord")]
async fn three_beat(w: &mut W) {
    setup(w, false, false);
    let path = w.root().join("score.apr");
    let score = fs::read_to_string(&path)
        .unwrap()
        .replace("tempo 99.5", "tempo 99.5\ntime 3/4")
        .replace("chords i | iv | V | i", "chords i | i | V | i");
    fs::write(path, score).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_apricity"))
        .current_dir(w.root())
        .args(["compile", "score.apr"])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "fixture compile failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
}
#[then("the set preserves three-beat meter and chord changes")]
async fn three_beat_set(w: &mut W) {
    let s = w.xml();
    let d = roxmltree::Document::parse(&s).unwrap();
    let master = d
        .descendants()
        .find(|n| n.has_tag_name("MasterTrack"))
        .unwrap();
    let meter = master
        .descendants()
        .find(|n| n.has_tag_name("TimeSignature"))
        .unwrap();
    close(val(meter, "Manual"), 200.0);
    let transport = d
        .descendants()
        .find(|n| n.has_tag_name("Transport"))
        .unwrap();
    close(val(transport, "LoopLength"), 12.0);
    let ls: Vec<_> = d
        .descendants()
        .filter(|n| n.has_tag_name("Locator"))
        .collect();
    assert_eq!(ls.len(), 3);
    for (locator, (beat, name)) in ls
        .iter()
        .zip([(0.0, "i (Am)"), (6.0, "V (E)"), (9.0, "i (Am)")])
    {
        close(val(*locator, "Time"), beat);
        assert_eq!(val(*locator, "Name"), name);
    }
}
fn sets_in(path: &Path) -> usize {
    fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .map(|path| {
            if path.is_dir() {
                sets_in(&path)
            } else if path.extension().is_some_and(|ext| ext == "als") {
                1
            } else {
                0
            }
        })
        .sum()
}
#[when("I export the score without an output option")]
async fn default_output(w: &mut W) {
    w.output = Some(
        Command::new(env!("CARGO_BIN_EXE_apricity"))
            .current_dir(w.root())
            .args(["export", "--daw-set", "score.apr"])
            .output()
            .unwrap(),
    );
}
#[when("I export the score to an output folder")]
async fn folder_output(w: &mut W) {
    w.output = Some(
        Command::new(env!("CARGO_BIN_EXE_apricity"))
            .current_dir(w.root())
            .args(["export", "--daw-set", "score.apr", "-o", "out"])
            .output()
            .unwrap(),
    );
}
#[then("a set exists in the working directory")]
async fn default_exists(w: &mut W) {
    assert_eq!(sets_in(w.root()), 1);
}
#[then("a set exists in the output folder")]
async fn folder_exists(w: &mut W) {
    assert_eq!(sets_in(&w.root().join("out")), 1);
}
fn main() {
    futures::executor::block_on(W::run("../../features/daw/set.feature"));
}
