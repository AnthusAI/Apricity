//! Tests for references() and @id forms.
use apricity_score::{references, parse_score, Ref};
use std::path::Path;

fn assert_refs_match(got: Vec<Ref>, expected: Vec<(&str, &str, Option<&str>, Option<&str>, Option<&str>)>) {
    let mut got_sorted = got;
    got_sorted.sort_by(|a, b| {
        (a.alias.as_str(), a.source.as_str(), &a.kit_pad).cmp(&(b.alias.as_str(), b.source.as_str(), &b.kit_pad))
    });

    let expected_sorted: Vec<_> = expected.into_iter().collect();

    assert_eq!(
        got_sorted.len(),
        expected_sorted.len(),
        "expected {} references, got {}",
        expected_sorted.len(),
        got_sorted.len()
    );

    for (got_ref, (exp_alias, exp_source, exp_path, exp_slice, exp_kit_pad)) in got_sorted.iter().zip(expected_sorted.iter()) {
        assert_eq!(
            &got_ref.alias, exp_alias,
            "alias mismatch for source {}: got {:?}, expected {:?}",
            got_ref.source, got_ref.alias, exp_alias
        );
        assert_eq!(
            &got_ref.source, *exp_source,
            "source mismatch for alias {}: got {:?}, expected {:?}",
            got_ref.alias, got_ref.source, exp_source
        );
        if let Some(exp_p) = exp_path {
            assert!(
                got_ref.path.is_some(),
                "expected path for {} (source {}), got None",
                got_ref.alias, got_ref.source
            );
            let got_str = got_ref.path.as_ref().unwrap().to_string_lossy().to_string();
            // Normalize for comparison
            assert!(
                got_str.contains(exp_p) || exp_p.contains(&got_str),
                "path mismatch for {} (source {}): got {:?}, expected to contain {:?}",
                got_ref.alias, got_ref.source, got_str, exp_p
            );
        } else {
            assert_eq!(
                got_ref.path, None,
                "expected no path for {} (source {}), got {:?}",
                got_ref.alias, got_ref.source, got_ref.path
            );
        }
        assert_eq!(
            got_ref.slice.as_deref(), *exp_slice,
            "slice mismatch for {} (source {})",
            got_ref.alias, got_ref.source
        );
        assert_eq!(
            got_ref.kit_pad.as_deref(), *exp_kit_pad,
            "kit_pad mismatch for {} (source {})",
            got_ref.alias, got_ref.source
        );
    }
}

#[test]
fn test_chop_shop_apr_references() {
    let chop_shop_text = include_str!("../../../examples/chop-shop.apr");
    let path = Path::new("examples/chop-shop.apr");
    let (score, _map) = parse_score(chop_shop_text, path).expect("parse chop-shop.apr");

    let refs = references(&score, path.parent().unwrap());

    // Expected references (sorted by alias, source, kit_pad):
    // From clips:
    // 1. band, marine-band/Thunderer.mp3, None
    // 2. brk, marine-band/stems/Thunderer/drums.wav, loop-1, None
    // 3. horns, marine-band/stems/Thunderer/other.wav, loop-2, None
    // 4. pdrums, marine-band/stems/WashingtonPost/drums.wav, None, None
    // 5. tdrums, marine-band/stems/Thunderer/drums.wav, None, None
    // From chopped kits:
    // 6. brk, marine-band/stems/Thunderer/drums.wav, loop-1, kit_pad="b"
    // 7. horns, marine-band/stems/Thunderer/other.wav, loop-2, kit_pad="h"
    // From kit pads:
    // 8. band, marine-band/Thunderer.mp3, hit-3, kit_pad="drums.crash"
    // 9. pdrums, marine-band/stems/WashingtonPost/drums.wav, None, kit_pad="drums.snare"
    // 10. tdrums, marine-band/stems/Thunderer/drums.wav, None, kit_pad="drums.kick"

    let expected = vec![
        ("band", "marine-band/Thunderer.mp3", Some("marine-band/Thunderer.mp3"), None, None),
        ("band", "marine-band/Thunderer.mp3", Some("marine-band/Thunderer.mp3"), Some("hit-3"), Some("drums.crash")),
        ("brk", "marine-band/stems/Thunderer/drums.wav", Some("marine-band/stems/Thunderer/drums.wav"), Some("loop-1"), None),
        ("brk", "marine-band/stems/Thunderer/drums.wav", Some("marine-band/stems/Thunderer/drums.wav"), Some("loop-1"), Some("b")),
        ("horns", "marine-band/stems/Thunderer/other.wav", Some("marine-band/stems/Thunderer/other.wav"), Some("loop-2"), None),
        ("horns", "marine-band/stems/Thunderer/other.wav", Some("marine-band/stems/Thunderer/other.wav"), Some("loop-2"), Some("h")),
        ("pdrums", "marine-band/stems/WashingtonPost/drums.wav", Some("marine-band/stems/WashingtonPost/drums.wav"), None, None),
        ("pdrums", "marine-band/stems/WashingtonPost/drums.wav", Some("marine-band/stems/WashingtonPost/drums.wav"), None, Some("drums.snare")),
        ("tdrums", "marine-band/stems/Thunderer/drums.wav", Some("marine-band/stems/Thunderer/drums.wav"), None, None),
        ("tdrums", "marine-band/stems/Thunderer/drums.wav", Some("marine-band/stems/Thunderer/drums.wav"), None, Some("drums.kick")),
    ];

    assert_refs_match(refs, expected);
}

#[test]
fn test_voice_layer_apr_references() {
    let voice_layer_text = include_str!("../../../examples/voice-layer.apr");
    let path = Path::new("examples/voice-layer.apr");
    let (score, _map) = parse_score(voice_layer_text, path).expect("parse voice-layer.apr");

    let refs = references(&score, path.parent().unwrap());

    // voice-layer.apr has:
    // clip brk = marine-band/stems/Thunderer/drums.wav slice loop-1
    // clip horns = marine-band/stems/Thunderer/other.wav slice loop-2
    // clip voice = voice/announcer.wav
    // clip quick = voice/announcer.wav speed 1.5x
    // kit b = chop brk
    // kit h = chop horns
    // kit words = chop voice
    // kit fast = chop quick
    // Expected references (8 total):
    // 1. brk from clips
    // 2. brk from kit b
    // 3. horns from clips
    // 4. horns from kit h
    // 5. quick from clips
    // 6. quick from kit fast
    // 7. voice from clips
    // 8. voice from kit words

    let expected = vec![
        ("brk", "marine-band/stems/Thunderer/drums.wav", Some("marine-band/stems/Thunderer/drums.wav"), Some("loop-1"), None),
        ("brk", "marine-band/stems/Thunderer/drums.wav", Some("marine-band/stems/Thunderer/drums.wav"), Some("loop-1"), Some("b")),
        ("horns", "marine-band/stems/Thunderer/other.wav", Some("marine-band/stems/Thunderer/other.wav"), Some("loop-2"), None),
        ("horns", "marine-band/stems/Thunderer/other.wav", Some("marine-band/stems/Thunderer/other.wav"), Some("loop-2"), Some("h")),
        ("quick", "voice/announcer.wav", Some("voice/announcer.wav"), None, None),
        ("quick", "voice/announcer.wav", Some("voice/announcer.wav"), None, Some("fast")),
        ("voice", "voice/announcer.wav", Some("voice/announcer.wav"), None, None),
        ("voice", "voice/announcer.wav", Some("voice/announcer.wav"), None, Some("words")),
    ];

    assert_refs_match(refs, expected);
}

#[test]
fn test_id_forms_in_yaml() {
    // Test that @clp_… and @slc_… forms can be parsed and round-trip
    let yaml_with_ids = "apricity: 0.1
tempo: 90
key: C
clips:
  a: {source: '@clp_abc123', slice: '@slc_def456'}
  b: {source: 'regular/path.wav'}
bars: 1
tracks: [{clip: a}]";

    let path = Path::new("test.yaml");
    let (score, _) = parse_score(yaml_with_ids, path).expect("parse yaml with ids");

    // Check that the id forms are preserved in the parsed score
    assert_eq!(score.clips["a"].source, "@clp_abc123");
    assert_eq!(score.clips["a"].slice, Some("@slc_def456".to_string()));
    assert_eq!(score.clips["b"].source, "regular/path.wav");

    // Check references
    let refs = references(&score, path.parent().unwrap());

    // a: @clp_abc123 should have source="@clp_abc123", path=None
    // b: regular/path.wav should have source="regular/path.wav", path=Some(...)
    let a_ref = refs.iter().find(|r| r.alias == "a" && r.kit_pad.is_none()).expect("missing ref for clip a");
    assert_eq!(a_ref.source, "@clp_abc123");
    assert_eq!(a_ref.path, None);
    assert_eq!(a_ref.slice, Some("@slc_def456".to_string()));

    let b_ref = refs.iter().find(|r| r.alias == "b").expect("missing ref for clip b");
    assert_eq!(b_ref.source, "regular/path.wav");
    assert!(b_ref.path.is_some());
}

#[test]
fn test_id_forms_in_apr() {
    // Test that @clp_… and @slc_… forms can be parsed in the text language
    let apr_with_ids = "tempo 90
key C

clip a = @clp_abc123 slice @slc_def456
clip b = regular/path.wav

bars 1
track a";

    let path = Path::new("test.apr");
    let (score, _) = parse_score(apr_with_ids, path).expect("parse apr with ids");

    assert_eq!(score.clips["a"].source, "@clp_abc123");
    assert_eq!(score.clips["a"].slice, Some("@slc_def456".to_string()));
    assert_eq!(score.clips["b"].source, "regular/path.wav");
}

#[test]
fn test_apr_roundtrip_with_ids() {
    // Test that id forms round-trip through format(parse(x)) == x
    use apricity_score::dsl;

    let apr_text = "tempo 90
key C

clip a = @clp_abc123 slice @slc_def456
clip b = regular/path.wav

bars 1
track a";

    let path = Path::new("test.apr");
    let (score, _) = parse_score(apr_text, path).expect("parse apr with ids");

    // Format it back
    let formatted = dsl::format(&score);

    // Parse the formatted version
    let (score2, _) = parse_score(&formatted, path).expect("parse formatted");

    // Should be identical
    assert_eq!(score.clips["a"].source, score2.clips["a"].source);
    assert_eq!(score.clips["a"].slice, score2.clips["a"].slice);
    assert_eq!(score.clips["b"].source, score2.clips["b"].source);
}
