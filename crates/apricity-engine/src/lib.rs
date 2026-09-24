//! Apricity's playback engine.
//!
//! "Render ahead, mix live": the control thread (`Renderer`) turns a compiled timeline into an
//! `Arrangement` of pre-warped stereo buffers; the audio thread (`Mixer`) loops it and swaps in
//! new arrangements at the next bar line. `Mixer::process` is real-time safe.

pub mod arrangement;
#[cfg(feature = "decode")]
pub mod decode;
pub mod master;
pub mod mix;
pub mod mixer;
pub mod render;

pub use arrangement::{Arrangement, Placement, Stem, Stereo, TrackControl, MAX_STEMS};
pub use master::{MasterChain, MasterParams};
pub use mix::Mix;
pub use mixer::{engine, Command, Controller, Mixer, Status, SwapAt};
pub use render::{Audio, Renderer};
