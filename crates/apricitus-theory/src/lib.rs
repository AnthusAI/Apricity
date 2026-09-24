//! Music theory for Apricitus: pitch classes, keys and modes, chords from roman numerals or
//! symbols, key finding, and the harmonic-fit solver that transposes clips onto chords.

pub mod chord;
pub mod harmony;
pub mod key;
pub mod pitch;

pub use chord::{Chord, Member, Quality};
pub use harmony::{solve, Fit, Role, Voice, VoiceFit, Weights};
pub use key::{rank_keys, Key, Mode};
pub use pitch::PitchClass;
