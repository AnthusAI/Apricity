/// Pure domain logic for apricitus data: ids, ranking, and markup merge.
/// No storage engine dependency.

pub mod ids;
pub mod markup;
pub mod rank;

pub use ids::{candidate_id, clip_id, curated_slice_id, migrated_slice_id, stem_clip_id};
pub use rank::{rank, Ranked};
