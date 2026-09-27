//! Harmony v2: octave-aware note salience (a sparse-kernel CQT + NNLS harmonic-template
//! decomposition) and chord recognition. A direct port of the Python reference,
//! `analysis/apricity_analyze/harmony2_ref.py` (Kanbus `apricitus-e5cb09`); see that module's
//! docstring and `spec-harmony-v2.md` secs 2.1-2.3, 2.7 for the design this implements.
//!
//! Like the reference, this crate folds the CQT to one bin per semitone (84 rows) before NNLS,
//! rather than the full 252-row decomposition sec 2.1 describes: the reference's docstring has
//! the reasoning. The Rust and Python sides are kept identical on purpose so the parity test
//! (`tests/parity.rs`) means something; the full-resolution version is future work on both sides.
//!
//! All arithmetic is `f64`, matching the reference (numpy defaults to `float64`).

pub mod cqt;
pub mod nnls;
pub mod notes;
pub mod pitch;

pub use cqt::{cqt, N_BINS, SR};
pub use notes::{chord_match_score, fold_to_semitones, recognise_chord, transposition_map, N_SEMITONES};
pub use pitch::{cents_offset, cents_offset_from_cqt};
