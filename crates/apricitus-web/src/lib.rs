//! Raw C-ABI exports for the browser. One module, three users:
//!
//! - the page compiles scores (`rw_sources`, `rw_compile`),
//! - the render worker warps events with Rubber Band (`rw_renderer_*`, `rw_arrange`),
//! - the AudioWorklet runs the real-time mixer (`rw_engine_*`).
//!
//! Strings go in as (ptr, len) UTF-8 in wasm memory the caller allocated with `rw_alloc_bytes`;
//! JSON results come back through `rw_result_ptr` / `rw_result_len` (valid until the next call).

use apricitus_engine::{engine, Arrangement, Audio, Command, Controller, Mixer, Placement, Renderer, SwapAt};
use apricitus_score::score::MasterSpec;
use apricitus_score::{Clip, Timeline};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::path::Path;
use std::sync::Arc;

// Link as a WASI "reactor": JS calls `_initialize` once (running C++ static constructors for
// Rubber Band), then calls exports freely.
#[cfg(target_family = "wasm")]
unsafe extern "C" {
    fn __wasm_call_ctors();
}

#[cfg(target_family = "wasm")]
#[unsafe(no_mangle)]
pub extern "C" fn _initialize() {
    unsafe { __wasm_call_ctors() };
}

// ------------------------------------------------------------------ memory + results

#[unsafe(no_mangle)]
pub extern "C" fn rw_alloc_bytes(len: usize) -> *mut u8 {
    let mut v = vec![0u8; len];
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// From `rw_alloc_bytes(len)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rw_free_bytes(ptr: *mut u8, len: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, len, len)) };
}

#[unsafe(no_mangle)]
pub extern "C" fn rw_alloc(len: usize) -> *mut f32 {
    let mut v = vec![0.0f32; len];
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// From `rw_alloc(len)` or a float buffer this module returned with that length.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rw_free(ptr: *mut f32, len: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, len, len)) };
}

thread_local! {
    static RESULT: RefCell<String> = const { RefCell::new(String::new()) };
    static RENDERER: RefCell<Option<Renderer>> = const { RefCell::new(None) };
    static ENGINE: RefCell<Option<(Controller, Mixer)>> = const { RefCell::new(None) };
}

fn set_result(v: Value) {
    RESULT.with(|r| *r.borrow_mut() = v.to_string());
}

#[unsafe(no_mangle)]
pub extern "C" fn rw_result_ptr() -> *const u8 {
    RESULT.with(|r| r.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn rw_result_len() -> usize {
    RESULT.with(|r| r.borrow().len())
}

unsafe fn str_arg<'a>(ptr: *const u8, len: usize) -> &'a str {
    std::str::from_utf8(unsafe { std::slice::from_raw_parts(ptr, len) }).unwrap_or("")
}

// ------------------------------------------------------------------ compiler (page)

/// Audio paths (repo-relative) the score needs manifests for.
/// Result: `{"sources": [...]}` or `{"errors": [...]}`.
///
/// # Safety
/// UTF-8 (ptr, len) pairs in wasm memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rw_sources(yaml: *const u8, yaml_len: usize, path: *const u8, path_len: usize) {
    let (yaml, path) = unsafe { (str_arg(yaml, yaml_len), str_arg(path, path_len)) };
    let path = Path::new(path);
    set_result(match apricitus_score::parse_score(yaml, path) {
        Ok((score, _)) => json!({ "sources": apricitus_score::source_paths(&score, path.parent().unwrap_or(Path::new(""))) }),
        Err(errors) => json!({ "errors": errors }),
    });
}

/// Compile with manifests supplied as `{ "<audio path>": <manifest object> }`.
/// Result: `{"timeline": ..., "explain": "..."}` or `{"errors": [...]}`.
///
/// # Safety
/// UTF-8 (ptr, len) pairs in wasm memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rw_compile(yaml: *const u8, yaml_len: usize, path: *const u8, path_len: usize, manifests: *const u8, manifests_len: usize) {
    let (yaml, path, manifests) = unsafe { (str_arg(yaml, yaml_len), str_arg(path, path_len), str_arg(manifests, manifests_len)) };
    let manifests: serde_json::Map<String, Value> = serde_json::from_str(manifests).unwrap_or_default();
    let result = apricitus_score::compile_text(yaml, Path::new(path), &mut |p: &Path| match manifests.get(&p.to_string_lossy().to_string()) {
        Some(m) => Clip::from_json(p, &m.to_string()),
        None => Err(format!("{} has no analysis yet (or doesn't exist)", p.display())),
    });
    set_result(match result {
        Ok(tl) => json!({ "explain": tl.explain(), "timeline": tl }),
        Err(errors) => json!({ "errors": errors }),
    });
}

// ------------------------------------------------------------------ renderer (worker)

#[unsafe(no_mangle)]
pub extern "C" fn rw_renderer_new(sample_rate: u32) {
    RENDERER.with(|r| {
        *r.borrow_mut() = Some(Renderer::new(sample_rate, |p: &Path| Err(format!("{} wasn't loaded into the renderer", p.display()))));
    });
}

/// # Safety
/// UTF-8 (ptr, len) in wasm memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rw_renderer_has_source(path: *const u8, path_len: usize) -> bool {
    let path = unsafe { str_arg(path, path_len) };
    RENDERER.with(|r| r.borrow().as_ref().is_some_and(|r| r.has_source(Path::new(path))))
}

/// Hand the renderer decoded audio: `channels` planar channels of `frames` floats, back to back.
///
/// # Safety
/// `data` holds `frames * channels` floats; the path is UTF-8 (ptr, len).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rw_renderer_add_source(path: *const u8, path_len: usize, data: *const f32, frames: usize, channels: usize, sample_rate: u32) {
    let path = unsafe { str_arg(path, path_len) };
    let data = unsafe { std::slice::from_raw_parts(data, frames * channels) };
    let audio = Audio { sr: sample_rate, channels: data.chunks(frames).map(|c| c.to_vec()).collect() };
    RENDERER.with(|r| {
        if let Some(r) = r.borrow_mut().as_mut() {
            r.insert_source(Path::new(path), audio);
        }
    });
}

/// Render a compiled timeline (JSON from `rw_compile`) and bounce it to one stereo loop.
/// With `normalize` (`master` would be a better name) true the loop goes through the score's
/// master chain and loudness target. With it false you get the raw sum of the track stems (track
/// effects and pan applied), so partial renders from several workers can be summed and handed to
/// `rw_engine_load_mastered`, which runs the master chain live. Give each worker whole tracks:
/// track effects (a compressor) need the whole track.
/// Returns a planar buffer (left then right, `frames` each; free with `rw_free(ptr, 2 * frames)`)
/// and sets the result to `{frames, frames_per_beat, beats_per_bar, rendered, reused}` or `{error}`.
///
/// # Safety
/// UTF-8 (ptr, len) in wasm memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rw_arrange(timeline: *const u8, timeline_len: usize, normalize: bool) -> *mut f32 {
    let timeline = unsafe { str_arg(timeline, timeline_len) };
    let tl: Timeline = match serde_json::from_str(timeline) {
        Ok(t) => t,
        Err(e) => {
            set_result(json!({ "error": format!("bad timeline: {e}") }));
            return std::ptr::null_mut();
        }
    };
    RENDERER.with(|r| {
        let mut r = r.borrow_mut();
        let Some(r) = r.as_mut() else {
            set_result(json!({ "error": "renderer not created" }));
            return std::ptr::null_mut();
        };
        match r.arrange(&tl, None) {
            Ok((arr, stats)) => {
                let [l, rr] = if normalize { arr.bounce() } else { arr.bounce_raw() };
                let frames = l.len();
                let mut flat = l;
                flat.extend_from_slice(&rr);
                let mut flat = flat.into_boxed_slice().into_vec();
                let p = flat.as_mut_ptr();
                std::mem::forget(flat);
                set_result(json!({ "frames": frames, "frames_per_beat": arr.frames_per_beat, "beats_per_bar": arr.beats_per_bar,
                                   "rendered": stats.rendered, "reused": stats.reused }));
                p
            }
            Err(e) => {
                set_result(json!({ "error": e }));
                std::ptr::null_mut()
            }
        }
    })
}

// ------------------------------------------------------------------ mixer (AudioWorklet)
//
// In an AudioWorklet the message handler and `process()` run on the same thread, so the
// Controller and Mixer live side by side here. `rw_engine_load` and `rw_engine_gc` allocate and
// free (call them from the message handler); `rw_engine_process` never does.

#[unsafe(no_mangle)]
pub extern "C" fn rw_engine_new() {
    ENGINE.with(|e| *e.borrow_mut() = Some(engine()));
}

/// Take ownership of a planar stereo loop (from `rw_alloc(2 * frames)`) and queue it.
///
/// # Safety
/// `data` must come from `rw_alloc(2 * frames)`; the engine frees it.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rw_engine_load(data: *mut f32, frames: usize, frames_per_beat: f64, beats_per_bar: u32, sample_rate: u32, at_next_bar: bool) -> bool {
    let flat = unsafe { Vec::from_raw_parts(data, 2 * frames, 2 * frames) };
    let (l, r) = flat.split_at(frames);
    let placement = Placement { start: 0, skip: 0, buf: Arc::new([l.to_vec(), r.to_vec()]), gain: 1.0 };
    drop(flat);
    let arr = Arrangement::new(sample_rate, frames_per_beat, beats_per_bar, frames, vec![placement]);
    ENGINE.with(|e| {
        e.borrow_mut().as_mut().is_some_and(|(ctl, _)| ctl.load(arr, if at_next_bar { SwapAt::NextBar } else { SwapAt::Now }).is_ok())
    })
}

/// The master chain's loudness make-up (dB) for a raw mix (`rw_arrange(…, false)`, summed):
/// `master` is the timeline's `master` object as JSON (`{"effects": [...], "loudness": -16}`).
/// Slow-ish (tens of milliseconds for a long loop), so call it in a render worker, not the
/// worklet. NaN on bad input.
///
/// # Safety
/// `data` holds `2 * frames` floats (planar); `master` is UTF-8 (ptr, len).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rw_master_gain(data: *const f32, frames: usize, sample_rate: u32, master: *const u8, master_len: usize) -> f64 {
    let data = unsafe { std::slice::from_raw_parts(data, 2 * frames) };
    let master = unsafe { str_arg(master, master_len) };
    let Ok(spec) = serde_json::from_str::<MasterSpec>(master) else { return f64::NAN };
    let (l, r) = data.split_at(frames);
    let params = apricitus_engine::master::params(&spec.effects, true);
    let target = spec.loudness.unwrap_or(apricitus_score::compile::DEFAULT_LOUDNESS);
    apricitus_engine::master::loudness_gain(&[l.to_vec(), r.to_vec()], params, sample_rate as f64, target)
}

/// Like `rw_engine_load`, but the loop is a raw mix and the engine runs the score's master chain
/// on it live (so a fader never pushes past the limiter's ceiling). `master` is the timeline's
/// `master` JSON and `gain_db` its make-up gain from `rw_master_gain`. Returns false on bad input
/// (the loop is freed either way).
///
/// # Safety
/// `data` must come from `rw_alloc(2 * frames)`; the engine frees it. `master` is UTF-8 (ptr, len).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rw_engine_load_mastered(
    data: *mut f32, frames: usize, frames_per_beat: f64, beats_per_bar: u32, sample_rate: u32, at_next_bar: bool,
    master: *const u8, master_len: usize, gain_db: f64,
) -> bool {
    let flat = unsafe { Vec::from_raw_parts(data, 2 * frames, 2 * frames) };
    let master = unsafe { str_arg(master, master_len) };
    let Ok(spec) = serde_json::from_str::<MasterSpec>(master) else { return false };
    let (l, r) = flat.split_at(frames);
    let stem = apricitus_engine::Stem { name: "mix".into(), buf: Arc::new([l.to_vec(), r.to_vec()]), pan: 0.0, solo_safe: false };
    drop(flat);
    let mut params = apricitus_engine::master::params(&spec.effects, true);
    params.gain_db = if gain_db.is_finite() { gain_db.clamp(-24.0, 24.0) } else { 0.0 };
    let arr = Arrangement::from_stems(sample_rate, frames_per_beat, beats_per_bar, frames, vec![stem], params);
    ENGINE.with(|e| {
        e.borrow_mut().as_mut().is_some_and(|(ctl, _)| ctl.load(arr, if at_next_bar { SwapAt::NextBar } else { SwapAt::Now }).is_ok())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn rw_engine_play(play: bool) {
    ENGINE.with(|e| {
        if let Some((ctl, _)) = e.borrow_mut().as_mut() {
            let _ = ctl.send(if play { Command::Play } else { Command::Pause });
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn rw_engine_seek(frame: usize) {
    ENGINE.with(|e| {
        if let Some((ctl, _)) = e.borrow_mut().as_mut() {
            let _ = ctl.send(Command::Seek(frame));
        }
    });
}

/// Free arrangements the mixer has finished with (message handler only).
#[unsafe(no_mangle)]
pub extern "C" fn rw_engine_gc() -> usize {
    ENGINE.with(|e| e.borrow_mut().as_mut().map_or(0, |(ctl, _)| ctl.collect_garbage()))
}

/// Fill `frames` of planar stereo at `out` (left then right). Real-time safe.
///
/// # Safety
/// `out` holds `2 * frames` floats.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rw_engine_process(out: *mut f32, frames: usize) {
    let buf = unsafe { std::slice::from_raw_parts_mut(out, 2 * frames) };
    let (l, r) = buf.split_at_mut(frames);
    ENGINE.with(|e| {
        if let Some((_, mixer)) = e.borrow_mut().as_mut() {
            mixer.process(&mut [l, r]);
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn rw_engine_position() -> f64 {
    ENGINE.with(|e| e.borrow().as_ref().map_or(0.0, |(ctl, _)| ctl.status.position.load(std::sync::atomic::Ordering::Relaxed) as f64))
}

#[unsafe(no_mangle)]
pub extern "C" fn rw_engine_pending() -> bool {
    ENGINE.with(|e| e.borrow().as_ref().is_some_and(|(ctl, _)| ctl.status.pending_swap.load(std::sync::atomic::Ordering::Relaxed)))
}

#[unsafe(no_mangle)]
pub extern "C" fn rw_engine_swaps() -> f64 {
    ENGINE.with(|e| e.borrow().as_ref().map_or(0.0, |(ctl, _)| ctl.status.swaps.load(std::sync::atomic::Ordering::Relaxed) as f64))
}
