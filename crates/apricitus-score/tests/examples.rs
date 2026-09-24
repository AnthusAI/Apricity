//! Every example written in both formats must mean exactly the same score.

use apricitus_score::parse_score;
use std::path::Path;

#[test]
fn apricitus_and_yaml_examples_agree() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples");
    let mut compared = 0;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "apr") {
            let yaml = path.with_extension("yaml");
            if !yaml.exists() {
                continue;
            }
            let (a, _) = parse_score(&std::fs::read_to_string(&path).unwrap(), &path).unwrap();
            let (b, _) = parse_score(&std::fs::read_to_string(&yaml).unwrap(), &yaml).unwrap();
            assert_eq!(a, b, "{} and {} differ", path.display(), yaml.display());
            compared += 1;
        }
    }
    assert!(compared >= 2, "expected paired examples in {}", dir.display());
}

#[test]
fn every_example_round_trips_through_both_formats() {
    // .apr → YAML → score, and .apr → .apr → score, must give back the same score.
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples");
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|e| e != "apr") {
            continue;
        }
        let (score, _) = parse_score(&std::fs::read_to_string(&path).unwrap(), &path).unwrap();
        let yaml = serde_yaml::to_string(&score).unwrap();
        let (from_yaml, _) = parse_score(&yaml, Path::new("x.yaml")).unwrap_or_else(|e| panic!("{}: YAML doesn't read back: {e:?}\n{yaml}", path.display()));
        assert_eq!(score, from_yaml, "{} changed going through YAML", path.display());
        let apr = apricitus_score::dsl::format(&score);
        let (from_apr, _) = parse_score(&apr, Path::new("x.apr")).unwrap_or_else(|e| panic!("{}: .apr doesn't read back: {e:?}\n{apr}", path.display()));
        assert_eq!(score, from_apr, "{} changed going through .apr", path.display());
    }
}

#[test]
fn chop_into_round_trips() {
    let src = "tempo 90\nkey C\nclip a = x.wav\nkit e = chop a into 8\nbars 1\ntrack e steps \"1 2\"\n";
    let (score, _) = parse_score(src, Path::new("t.apr")).unwrap();
    let yaml = serde_yaml::to_string(&score).unwrap();
    assert!(yaml.contains("into: 8\n"), "{yaml}");
    assert_eq!(parse_score(&yaml, Path::new("t.yaml")).unwrap().0, score);
}
