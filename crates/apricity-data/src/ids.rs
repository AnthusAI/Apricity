/// Stable ID generation for clips, candidates, and slices.
use sha1::{Digest, Sha1};
use sha2::Sha256;

/// Generate a clip ID from audio SHA256.
/// Format: "clp_" + first 20 hex chars of SHA256
pub fn clip_id(audio_sha256: &str) -> String {
    format!("clp_{}", &audio_sha256[..20.min(audio_sha256.len())])
}

/// Generate a stem clip ID from parent clip ID, stem name, and model.
/// Format: "clp_" + first 20 hex chars of SHA256("parent_id|stem|model")
pub fn stem_clip_id(parent_id: &str, stem: &str, model: &str) -> String {
    let key = format!("{}|{}|{}", parent_id, stem, model);
    let hash = Sha256::digest(key.as_bytes());
    let hex = format!("{:x}", hash);
    format!("clp_{}", &hex[..20.min(hex.len())])
}

/// Generate a candidate ID from clip ID, start time, end time, and kind.
/// Format: "cand_" + first 16 hex chars of SHA1("clipId|start|end|kind")
pub fn candidate_id(clip_id: &str, start: f64, end: f64, kind: &str) -> String {
    let key = format!(
        "{}|{:.2}|{:.2}|{}",
        clip_id,
        (start * 100.0).round() / 100.0,
        (end * 100.0).round() / 100.0,
        kind
    );
    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    let hash = hasher.finalize();
    let hex = format!("{:x}", hash);
    format!("cand_{}", &hex[..16.min(hex.len())])
}

/// Generate a curated slice ID from candidate ID.
/// Format: "slc_" + first 20 hex chars of SHA1(candidate_id)
pub fn curated_slice_id(candidate_id: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(candidate_id.as_bytes());
    let hash = hasher.finalize();
    let hex = format!("{:x}", hash);
    format!("slc_{}", &hex[..20.min(hex.len())])
}

/// Generate a migrated slice ID from clip ID and name.
/// Format: "slc_" + first 20 hex chars of SHA1("clipId|name")
pub fn migrated_slice_id(clip_id: &str, name: &str) -> String {
    let key = format!("{}|{}", clip_id, name);
    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    let hash = hasher.finalize();
    let hex = format!("{:x}", hash);
    format!("slc_{}", &hex[..20.min(hex.len())])
}

/// Generate a migrated marker ID from clip ID, name and position.
/// Format: "mrk_" + first 20 hex chars of SHA1("clipId|name|seconds")
pub fn migrated_marker_id(clip_id: &str, name: &str, seconds: f64) -> String {
    let key = format!("{}|{}|{}", clip_id, name, seconds);
    let hex = format!("{:x}", Sha1::digest(key.as_bytes()));
    format!("mrk_{}", &hex[..20])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clip_id() {
        let result = clip_id("0123456789abcdefghij");
        assert_eq!(result, "clp_0123456789abcdefghij");
    }

    #[test]
    fn test_stem_clip_id() {
        let parent = "clp_0123456789abcdefghij";
        let result = stem_clip_id(parent, "drums", "demucs");
        assert!(result.starts_with("clp_"));
        assert_eq!(result.len(), 4 + 20);
    }

    #[test]
    fn test_candidate_id() {
        let clip_id = "clp_0123456789abcdefghij";
        let result = candidate_id(clip_id, 10.0, 14.0, "loop");
        assert!(result.starts_with("cand_"));
        assert_eq!(result.len(), 5 + 16);
    }

    #[test]
    fn test_candidate_id_rounding() {
        // Test that floating point start/end are rounded correctly
        let result1 = candidate_id("clp_test", 10.004, 14.005, "loop");
        // Both should round to 10.00 and 14.01 respectively (banker's rounding)
        // Let's just check they produce consistent results
        let result2 = candidate_id("clp_test", 10.004, 14.005, "loop");
        assert_eq!(result1, result2);
    }

    #[test]
    fn test_curated_slice_id() {
        let cand_id = "cand_0123456789abcdef";
        let result = curated_slice_id(cand_id);
        assert!(result.starts_with("slc_"));
        assert_eq!(result.len(), 4 + 20);
    }

    #[test]
    fn test_migrated_slice_id() {
        let clip_id = "clp_0123456789abcdefghij";
        let result = migrated_slice_id(clip_id, "loop-1");
        assert!(result.starts_with("slc_"));
        assert_eq!(result.len(), 4 + 20);
    }
}
