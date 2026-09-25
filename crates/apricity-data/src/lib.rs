/// Pure domain logic for apricity data: ids, ranking, markup merge, score references, and positions.
/// Storage engine integration via virtuus-amplify.
#[cfg(feature = "storage")]
pub mod domain;
#[cfg(feature = "storage")]
pub mod files;
pub mod ids;
#[cfg(feature = "storage")]
pub mod library;
#[cfg(feature = "storage")]
pub mod loader;
pub mod markup;
#[cfg(feature = "storage")]
pub mod migration;
pub mod position;
pub mod rank;
#[cfg(feature = "storage")]
pub mod s3;
pub mod score_refs;
#[cfg(feature = "storage")]
pub mod sync;

#[cfg(feature = "storage")]
pub use domain::{DomainError, JudgeInput, Proposal, apply_markup_merge, judge, save_score_impl};
#[cfg(feature = "storage")]
pub use files::{FileMeta, FileRef, Files, FsFiles};
pub use ids::{candidate_id, clip_id, curated_slice_id, migrated_marker_id, migrated_slice_id, stem_clip_id};
#[cfg(feature = "storage")]
pub use library::Library;
#[cfg(feature = "storage")]
pub use loader::make;
#[cfg(feature = "storage")]
pub use migration::{MigrationError, MigrationReport, migrate};
pub use position::{
    generate_key_between, generate_key_between_with_alphabets, generate_n_keys_between,
    generate_n_keys_between_with_alphabets,
};
pub use rank::{Ranked, rank};
pub use score_refs::{CatalogRef, catalog_refs};
