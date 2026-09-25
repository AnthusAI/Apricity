//! Apricity scores: a declarative description of a piece built from analyzed clips, compiled
//! into a timeline of warped, transposed events.

pub mod beat;
pub mod compile;
pub mod dsl;
pub mod manifest;
pub mod score;

pub use compile::{compile, compile_file, compile_text, compile_with, parse_score, normalize, source_paths, references, ChordSpan, Event, Timeline, TrackInfo};
pub use manifest::Clip;
pub use score::{Score, Ref};
