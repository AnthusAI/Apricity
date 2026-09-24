/// Pure domain logic for apricitus data: ids, ranking, markup merge, score references, and positions.
/// No storage engine dependency.

pub mod ids;
pub mod markup;
pub mod position;
pub mod rank;
pub mod score_refs;

pub use ids::{candidate_id, clip_id, curated_slice_id, migrated_slice_id, stem_clip_id};
pub use position::{
    generate_key_between, generate_key_between_with_alphabets, generate_n_keys_between,
    generate_n_keys_between_with_alphabets,
};
pub use rank::{rank, Ranked};
pub use score_refs::{catalog_refs, CatalogRef};
