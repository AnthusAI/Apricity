/// Score reference resolution: extract and catalog samples and clips referenced in a score.
/// Implements features/data/domain/score_refs.feature and design/storage.md §1, §5.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A catalog reference: a sample or clip referenced in a score, with resolved paths and ids.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRef {
    /// Suffix for the ScoreRef id: sref_<scoreId>_<id_suffix>
    pub id_suffix: String,
    /// The clip alias declared in the score
    pub alias: String,
    /// Source path exactly as written: "marine-band/stems/Thunderer/drums.wav" or "@smp_abc123"
    pub source: String,
    /// Resolved catalog path (catalog-relative), if the source is a path and resolved
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog_path: Option<String>,
    /// Sample id if source is @smp_...
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_id: Option<String>,
    /// Clip name if the reference includes a clip (and not @clp_...)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clip_name: Option<String>,
    /// Clip id if source is @clp_...
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clip_id: Option<String>,
    /// Kit pad if this is a reference from a kit (e.g., "drums.kick" or "b" for a chopped kit)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kit_pad: Option<String>,
}

/// Extract catalog references from score text.
///
/// # Arguments
/// * `text` - The score text (APR or YAML format)
/// * `folder` - The folder containing the score file (e.g., "scores", "examples")
/// * `file` - The score filename (e.g., "test.apr")
///
/// # Returns
/// A sorted list of CatalogRef with deterministic ids, or parse errors.
///
/// # Catalog-path resolution
/// - If source starts with "@smp_" → sample_id, no catalog_path
/// - If score has no "samples" directive → source is already catalog-relative
/// - If score has "samples <dir>" → resolve normalize(folder/dir/source)
///   - If result starts with "samples/" → strip that prefix
///   - Otherwise use the normalized path unchanged (unresolved)
pub fn catalog_refs(text: &str, folder: &str, file: &str) -> Result<Vec<CatalogRef>, Vec<String>> {
    let file_path = format!("{}/{}", folder, file);

    // Parse the score
    let (score, _) = apricity_score::parse_score(text, Path::new(&file_path))
        .map_err(|errs| errs.iter().map(|s| s.to_string()).collect::<Vec<_>>())?;

    // Extract references
    let base_dir = Path::new(&file_path).parent().unwrap_or(Path::new("."));
    let refs = apricity_score::references(&score, base_dir);

    // Resolve catalog paths and build CatalogRef structs
    let mut catalog_refs: Vec<CatalogRef> = refs
        .iter()
        .map(|r| {
            let (catalog_path, sample_id) = resolve_catalog_path(&r.source, &score, folder);

            let (clip_name, clip_id) = match &r.slice {
                Some(s) if s.starts_with("@clp_") => (None, Some(s[1..].to_string())),
                Some(s) => (Some(s.clone()), None),
                None => (None, None),
            };

            CatalogRef {
                id_suffix: String::new(), // Will be filled in after sorting and deduplication
                alias: r.alias.clone(),
                source: r.source.clone(),
                catalog_path,
                sample_id,
                clip_name,
                clip_id,
                kit_pad: r.kit_pad.clone(),
            }
        })
        .collect();

    // Sort by (alias, kit_pad, clip_name, source)
    // Option already orders None before Some
    catalog_refs.sort_by(|a, b| {
        a.alias
            .cmp(&b.alias)
            .then_with(|| a.kit_pad.cmp(&b.kit_pad))
            .then_with(|| a.clip_name.cmp(&b.clip_name))
            .then_with(|| a.source.cmp(&b.source))
    });

    // Assign id_suffix with deduplication
    let mut suffix_counts: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for ref_mut in &mut catalog_refs {
        let base_suffix = if let Some(kit_pad) = &ref_mut.kit_pad {
            format!("{}_{}", ref_mut.alias, kit_pad)
        } else {
            ref_mut.alias.clone()
        };

        let count = suffix_counts.entry(base_suffix.clone()).or_insert(0);
        *count += 1;

        ref_mut.id_suffix = if *count == 1 {
            base_suffix
        } else {
            format!("{}_{}", base_suffix, count)
        };
    }

    Ok(catalog_refs)
}

/// Resolve a source path to catalog_path and optional sample_id.
fn resolve_catalog_path(
    source: &str,
    score: &apricity_score::Score,
    folder: &str,
) -> (Option<String>, Option<String>) {
    // Rule (a): @smp_... → sample_id
    if source.starts_with("@smp_") {
        return (None, Some(source[1..].to_string()));
    }

    // Rule (b): no samples directive
    if score.samples.is_none() {
        // Source is already catalog-relative
        let normalized = normalize(&PathBuf::from(source));
        return (Some(normalized.to_string_lossy().to_string()), None);
    }

    // Rule (c): has samples directive
    let samples_dir = score.samples.as_deref().unwrap_or(".");
    let samples_path = Path::new(folder).join(samples_dir);
    let full_path = samples_path.join(source);
    let normalized = normalize(&full_path);

    // If it starts with "samples/", strip that prefix
    let normalized_str = normalized.to_string_lossy().to_string();
    if normalized_str.starts_with("samples/") {
        let catalog_path = normalized_str[8..].to_string(); // Strip "samples/"
        (Some(catalog_path), None)
    } else {
        // Unresolved: return the normalized path
        (Some(normalized_str), None)
    }
}

/// Normalize a path by resolving `.` and `..`.
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rule_a_smp_id() {
        let text = r#"
tempo 90
key C
bars 1
clip source = @smp_abc123
track source
"#;
        let result = catalog_refs(text, "scores", "test.apr").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].source, "@smp_abc123");
        assert_eq!(result[0].sample_id, Some("smp_abc123".to_string()));
        assert_eq!(result[0].catalog_path, None);
    }

    #[test]
    fn test_rule_b_no_samples() {
        let text = r#"
tempo 90
key C
bars 1
clip beat = marine-band/stems/Thunderer/drums.wav
track beat
"#;
        let result = catalog_refs(text, "scores", "test.apr").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].source, "marine-band/stems/Thunderer/drums.wav");
        assert_eq!(
            result[0].catalog_path,
            Some("marine-band/stems/Thunderer/drums.wav".to_string())
        );
        assert_eq!(result[0].sample_id, None);
    }

    #[test]
    fn test_rule_c_samples_directive() {
        let text = r#"
tempo 90
key C
samples ../samples
bars 1
clip beat = marine-band/x.wav
track beat
"#;
        let result = catalog_refs(text, "examples", "test.apr").unwrap();
        assert_eq!(result.len(), 1);
        // folder="examples", samples="../samples", source="marine-band/x.wav"
        // normalize(examples/../samples/marine-band/x.wav) = samples/marine-band/x.wav
        // Strip "samples/" prefix → "marine-band/x.wav"
        assert_eq!(
            result[0].catalog_path,
            Some("marine-band/x.wav".to_string())
        );
    }

    #[test]
    fn test_kit_pad_references() {
        let text = r#"
tempo 90
key C
bars 1
clip band = marine-band/Thunderer.mp3
kit drums
  crash = band hit-3
track drums  steps "crash . . ."
"#;
        let result = catalog_refs(text, "scores", "test.apr").unwrap();
        // Should have: clip "band" reference and kit pad "drums.crash" reference
        // They should be in order: band (no kit_pad), then band with drums.crash kit_pad
        assert_eq!(result.len(), 2);

        // First ref: band without kit pad
        assert_eq!(result[0].alias, "band");
        assert_eq!(result[0].source, "marine-band/Thunderer.mp3");
        assert_eq!(result[0].kit_pad, None);
        assert_eq!(result[0].id_suffix, "band");

        // Second ref: band with drums.crash kit pad and clip
        assert_eq!(result[1].alias, "band");
        assert_eq!(result[1].source, "marine-band/Thunderer.mp3");
        assert_eq!(result[1].clip_name, Some("hit-3".to_string()));
        assert_eq!(result[1].kit_pad, Some("drums.crash".to_string()));
        assert_eq!(result[1].id_suffix, "band_drums.crash");
    }

    #[test]
    fn test_duplicate_numbering_collision() {
        // Real collision: clip brk + clip brk_b + sliced kit b on brk
        // Sorted: (brk, None), (brk, b), (brk_b, None)
        // Suffixes: brk, brk_b, brk_b → collision! Second brk_b becomes brk_b_2
        let text = r#"
tempo 90
key C
bars 1
clip brk = marine-band/drums.wav
clip brk_b = marine-band/bass.wav
kit b = slice brk by beats 0.5
track brk
"#;
        let result = catalog_refs(text, "scores", "test.apr").unwrap();
        assert_eq!(result.len(), 3);

        // First ref: clip brk, no kit_pad
        assert_eq!(result[0].alias, "brk");
        assert_eq!(result[0].kit_pad, None);
        assert_eq!(result[0].id_suffix, "brk");

        // Second ref: clip brk with kit b, gets brk_b suffix (no collision yet)
        assert_eq!(result[1].alias, "brk");
        assert_eq!(result[1].kit_pad, Some("b".to_string()));
        assert_eq!(result[1].id_suffix, "brk_b");

        // Third ref: clip brk_b, no kit_pad, collides on brk_b → becomes brk_b_2
        assert_eq!(result[2].alias, "brk_b");
        assert_eq!(result[2].kit_pad, None);
        assert_eq!(result[2].id_suffix, "brk_b_2");
    }

    #[test]
    fn test_clip_id_form() {
        let text = r#"
tempo 90
key C
bars 1
clip beat = @smp_abc @clp_xyz
track beat
"#;
        let result = catalog_refs(text, "scores", "test.apr").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].sample_id, Some("smp_abc".to_string()));
        assert_eq!(result[0].clip_id, Some("clp_xyz".to_string()));
        assert_eq!(result[0].clip_name, None);
    }

    #[test]
    fn test_parse_error() {
        let text = "this is not valid apr";
        let result = catalog_refs(text, "scores", "test.apr");
        assert!(result.is_err());
        assert!(!result.unwrap_err().is_empty());
    }

    #[test]
    fn test_samples_escape_elsewhere() {
        // samples ../elsewhere from folder examples
        // normalize(examples/../elsewhere/marine-band/x.wav) = elsewhere/marine-band/x.wav
        // Doesn't start with "samples/" so stays unresolved
        let text = r#"
tempo 90
key C
samples ../elsewhere
bars 1
clip beat = marine-band/x.wav
track beat
"#;
        let result = catalog_refs(text, "examples", "test.apr").unwrap();
        assert_eq!(result.len(), 1);
        // Should be unresolved (doesn't start with samples/)
        assert_eq!(
            result[0].catalog_path,
            Some("elsewhere/marine-band/x.wav".to_string())
        );
    }

    #[test]
    fn test_samples_escape_root() {
        // Real escape: folder examples, samples ../../x, source marine-band/x.wav
        // normalize(examples/../../x/marine-band/x.wav)
        // examples -> pop -> empty, can't pop -> [..]
        // x -> push -> [.., x]
        // marine-band -> push -> [.., x, marine-band]
        // x.wav -> push -> [.., x, marine-band, x.wav]
        // Result: ../x/marine-band/x.wav (leading .. is kept)
        let text = r#"
tempo 90
key C
samples ../../x
bars 1
clip beat = marine-band/x.wav
track beat
"#;
        let result = catalog_refs(text, "examples", "test.apr").unwrap();
        assert_eq!(result.len(), 1);
        // Escapes root, keeps leading ..
        assert_eq!(
            result[0].catalog_path,
            Some("../x/marine-band/x.wav".to_string())
        );
    }

    #[test]
    fn test_idempotent() {
        let text = r#"
tempo 90
key C
bars 1
clip beat = marine-band/x.wav
track beat
"#;
        let result1 = catalog_refs(text, "scores", "test.apr").unwrap();
        let result2 = catalog_refs(text, "scores", "test.apr").unwrap();
        assert_eq!(result1, result2);
    }
}
