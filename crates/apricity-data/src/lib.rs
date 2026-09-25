pub mod files;
/// Pure domain logic for apricity data: ids, ranking, markup merge, score references, and positions.
/// Storage engine integration via virtuus-amplify.
pub mod ids;
pub mod library;
pub mod loader;
pub mod markup;
pub mod position;
pub mod rank;
pub mod score_refs;

pub use files::{Files, FsFiles};
pub use ids::{candidate_id, clip_id, curated_slice_id, migrated_slice_id, stem_clip_id};
pub use library::Library;
pub use loader::make;
pub use position::{
    generate_key_between, generate_key_between_with_alphabets, generate_n_keys_between,
    generate_n_keys_between_with_alphabets,
};
pub use rank::{Ranked, rank};
pub use score_refs::{CatalogRef, catalog_refs};
