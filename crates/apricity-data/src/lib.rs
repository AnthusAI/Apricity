/// Pure domain logic for apricity data: ids, ranking, markup merge, score references, and positions.
/// Storage engine integration via virtuus-amplify.
pub mod domain;
pub mod files;
pub mod ids;
pub mod library;
pub mod loader;
pub mod markup;
pub mod migration;
pub mod position;
pub mod rank;
pub mod s3;
pub mod score_refs;
pub mod sync;

pub use domain::{DomainError, JudgeInput, Proposal, apply_markup_merge, judge, save_score_impl};
pub use files::{FileMeta, FileRef, Files, FsFiles};
pub use ids::{candidate_id, clip_id, curated_slice_id, migrated_marker_id, migrated_slice_id, stem_clip_id};
pub use library::Library;
pub use loader::make;
pub use migration::{MigrationError, MigrationReport, migrate};
pub use position::{
    generate_key_between, generate_key_between_with_alphabets, generate_n_keys_between,
    generate_n_keys_between_with_alphabets,
};
pub use rank::{Ranked, rank};
pub use score_refs::{CatalogRef, catalog_refs};
