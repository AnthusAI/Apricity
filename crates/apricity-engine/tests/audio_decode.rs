#![cfg(feature = "decode")]

use apricity_engine::decode;
use std::path::Path;

#[test]
fn decodes_vorbis_opus_and_oga_audio() {
    for file in ["tone.ogg", "tone.opus", "tone.oga"] {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(file);
        let audio = decode::decode(&path).unwrap_or_else(|error| panic!("{file}: {error}"));
        assert!(audio.sr > 0, "{file}: sample rate");
        assert!(!audio.channels.is_empty(), "{file}: channels");
        assert!(!audio.channels[0].is_empty(), "{file}: decoded samples");
        assert!(audio.channels[0].iter().all(|sample| sample.is_finite()), "{file}: finite audio");
    }
}
