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

pub mod chord;
pub mod cqt;
pub mod nnls;
pub mod notes;
pub mod pitch;
pub mod quality;
pub mod steer;

pub use chord::{chord_inversion, detect_extensions, notes_from_activation, recognise_chord_full, Heard};
pub use cqt::{cqt, N_BINS, SR};
pub use notes::{beat_aggregate, chord_match_score, fold_to_semitones, frame_times, recognise_chord, transposition_map, N_SEMITONES};
pub use pitch::{cents_offset, cents_offset_from_cqt};
pub use quality::{check_span_guards, compute_q, consonance_v1_ported_per_beat, fold_activation_to_chroma, objective_v2_for_span, window_objective, written_quality_from_tones, SpanResult, WindowResult, PITCH_NAMES, Q};
pub use steer::{pitch_name_pc, steer_regions, steer_suggestions, wrong_notes_for_span, RegionSpan, Suggestion, SuggestSpan, WrongNote};
