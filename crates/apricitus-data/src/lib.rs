/// Pure domain logic for apricitus data: ids, ranking, markup merge, and score references.
/// No storage engine dependency.

pub mod ids;
pub mod markup;
pub mod rank;
pub mod score_refs;

pub use ids::{candidate_id, clip_id, curated_slice_id, migrated_slice_id, stem_clip_id};
pub use rank::{rank, Ranked};
pub use score_refs::{catalog_refs, CatalogRef};
