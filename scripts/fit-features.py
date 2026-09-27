#!/usr/bin/env python3
"""Compute the fit-feature sidecars for every sample manifest in the library (Kanbus
apricitus-798704, the stochastic mash-up optimizer's per-beat feature precompute; design in the
apricitus-7e51f2 epic's first comment, section 2b).

    scripts/fit-features.py [--samples DIR] [--only PATTERN] [--no-clap] [--workers N]
                             [--force] [--probe PROMPT]

For every `samples/**/<file>.apricity.json` under `--samples` (default: the repo's own
`samples/`), incrementally writes, next to the manifest (`apricity_analyze.features.
sidecar_path_for` / `apricity_analyze.clap.sidecar_path_for` are the single source of truth for
where):

  <file>.fitfeat.npz   per-beat tonalness, quarter-beat log-band energy, quarter-beat onset
                        strength/count, per-beat bass share -- see `apricity_analyze.features`'s
                        module docstring for the array shapes/units. Keyed by the manifest's own
                        `source.sha256`; a sample whose sidecar's stored sha already matches is
                        skipped (`--force` recomputes anyway).
  <file>.clap.npz       CLAP audio embeddings, one per saved clip and one per 4-bar window on the
                        sample's bar grid (skipped with `--no-clap`) -- see
                        `apricity_analyze.clap`'s module docstring. Both suffixes are git-ignored
                        (`.gitignore`'s `/samples/**/*.fitfeat.npz` / `*.clap.npz`); the default
                        `--samples` root is the *main checkout's* samples/ (not this worktree's),
                        so this script must run against the checkout that actually holds the audio.

The fitfeat-only pass (`--no-clap`) is cheap (pure numpy/essentia/librosa) and runs as one process
pool of `--workers` (default 4). CLAP is not: it loads a ~620 MB checkpoint per process, and a
single long-lived process's RSS has been observed to climb past the 6 GB safe-run cap partway
through the library (root cause not fully pinned down -- essentia/librosa allocator fragmentation
over many files in one process is the leading suspect). So when CLAP is on, this script runs each
chunk of at most `--chunk-size` manifests (default 25; a chunk never spans two top-level `samples/
<folder>/` directories, so e.g. all of `marine-band/` stays in one chunk if it's under the limit)
in its own fresh subprocess, sequentially, and aggregates the summary; each chunk's peak RSS is
reported. The non-CLAP path is unaffected by this (still one pool, `--workers` wide).

`--probe "prompt"` (repeatable) ranks every saved clip's CLAP embedding against each prompt and
prints the top 5 -- a quick sanity check that the embeddings separate genres/timbres sensibly,
without a formal eval.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import fnmatch
import itertools
import json
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))

DEFAULT_SAMPLES = pathlib.Path("/Users/home/Projects/Apricity/samples")
DEFAULT_CHUNK_SIZE = 25


# --------------------------------------------------------------------------- per-sample work

def _process_one(args: tuple) -> dict:
    """Top-level (picklable) worker: compute+write both sidecars for one manifest, next to it.
    Returns a small status dict (never raises -- a per-sample failure is reported, not fatal)."""
    manifest_str, do_clap, force = args
    import numpy as np

    from apricity_analyze import clap as clap_mod
    from apricity_analyze import features

    manifest_path = pathlib.Path(manifest_str)
    t0 = time.time()
    name = manifest_path.name[: -len(".apricity.json")]
    audio_path = manifest_path.parent / name

    try:
        manifest = json.loads(manifest_path.read_text())
    except Exception as e:  # noqa: BLE001
        return {"name": name, "status": "error", "error": f"unreadable manifest: {e}", "seconds": time.time() - t0}
    sha = manifest["source"]["sha256"]
    if not audio_path.exists():
        return {"name": name, "status": "error", "error": "audio file missing", "seconds": time.time() - t0}

    fit_path = features.sidecar_path_for(manifest_path)
    fit_status = "skipped"
    fit_bytes = fit_path.stat().st_size if fit_path.exists() else 0
    beats = manifest["rhythm"].get("beats", [])
    if force or not features.is_up_to_date(fit_path, sha):
        feats = features.compute_features(audio_path, beats, sha)
        if feats is None:
            fit_status = "no-beat-grid"
        else:
            features.write_sidecar(fit_path, feats)
            fit_bytes = fit_path.stat().st_size
            fit_status = "done"

    clap_status = "skipped"
    clap_bytes = 0
    if do_clap:
        clap_path = clap_mod.sidecar_path_for(manifest_path)
        clap_bytes = clap_path.stat().st_size if clap_path.exists() else 0
        if force or not clap_mod.is_up_to_date(clap_path, sha):
            clips = manifest.get("annotations", {}).get("clips", [])
            import essentia.standard as es

            audio = es.MonoLoader(filename=str(audio_path), sampleRate=44100)()
            sr = 44100
            clip_arrays = [audio[int(c["start"] * sr):int(c["end"] * sr)] for c in clips]
            clip_arrays = [a if len(a) else np.zeros(1, dtype=audio.dtype) for a in clip_arrays]
            clip_embeddings = clap_mod.embed_audio_batch(clip_arrays, sr) if clip_arrays else np.zeros((0, clap_mod.EMBED_DIM), dtype=np.float32)
            windows = clap_mod.bar_grid_windows(manifest["rhythm"].get("downbeats", []), beats)
            window_embeddings = clap_mod.embed_windows(audio, sr, windows) if windows else np.zeros((0, clap_mod.EMBED_DIM), dtype=np.float32)
            clap_mod.write_sidecar(clap_path, sha256=sha, checkpoint=clap_mod.CHECKPOINT,
                                    clip_names=[c["name"] for c in clips], clip_embeddings=clip_embeddings,
                                    windows=windows, window_embeddings=window_embeddings)
            clap_bytes = clap_path.stat().st_size
            clap_status = "done"

    return {"name": name, "status": fit_status, "clap_status": clap_status,
            "fit_bytes": fit_bytes, "clap_bytes": clap_bytes, "seconds": time.time() - t0}


def _run_one_process(manifests: list[pathlib.Path], do_clap: bool, force: bool, workers: int) -> list[dict]:
    """Process `manifests` in *this* process (optionally with a pool) -- used directly for the
    non-CLAP path, and as the body of each CLAP subprocess chunk (see `_run_clap_chunked`)."""
    jobs = [(str(m), do_clap, force) for m in manifests]
    results = []
    if workers <= 1 or len(jobs) <= 1:
        for j in jobs:
            results.append(_process_one(j))
            r = results[-1]
            print(f"  {r['name'][:60]:60} {r['status']:12} clap={r.get('clap_status', '-'):10} {r['seconds']:5.1f}s")
    else:
        with concurrent.futures.ProcessPoolExecutor(max_workers=workers) as pool:
            for r in pool.map(_process_one, jobs):
                results.append(r)
                print(f"  {r['name'][:60]:60} {r['status']:12} clap={r.get('clap_status', '-'):10} {r['seconds']:5.1f}s")
    return results


# --------------------------------------------------------------------------- CLAP: chunked subprocesses

def _chunk_manifests(manifests: list[pathlib.Path], samples_root: pathlib.Path, chunk_size: int) -> list[list[pathlib.Path]]:
    """Group `manifests` (already sorted) into chunks of at most `chunk_size`, never spanning two
    top-level `samples_root/<folder>/` directories (so e.g. all of `marine-band/` is one chunk
    when it fits, keeping error/RSS reporting readable per library folder)."""
    def top_folder(m: pathlib.Path) -> str:
        parts = m.relative_to(samples_root).parts
        return parts[0] if len(parts) > 1 else ""

    chunks = []
    for _, group_iter in itertools.groupby(manifests, key=top_folder):
        group = list(group_iter)
        for i in range(0, len(group), chunk_size):
            chunks.append(group[i:i + chunk_size])
    return chunks


def _track_peak_rss_kb(proc: subprocess.Popen) -> int:
    """Poll `proc`'s RSS (kB) until it exits, returning the observed peak. Same technique as the
    safe-run watchdog this script is run under, just recording instead of killing."""
    peak = 0
    while True:
        r = subprocess.run(["ps", "-o", "rss=", "-p", str(proc.pid)], capture_output=True, text=True)
        val = r.stdout.strip()
        if val:
            try:
                peak = max(peak, int(val))
            except ValueError:
                pass
        if proc.poll() is not None:
            break
        time.sleep(0.5)
    return peak


def _run_clap_chunk_subprocess(chunk: list[pathlib.Path], samples_root: pathlib.Path, force: bool,
                                results_path: pathlib.Path) -> tuple[int, int]:
    """Run one chunk's CLAP (+fitfeat) pass in a fresh subprocess (`--_manifests-file` + `--_results-file`,
    this script's own internal re-entry point -- see `main`). Returns `(returncode, peak_rss_kb)`."""
    list_path = results_path.with_suffix(".manifests.txt")
    list_path.write_text("\n".join(str(m.relative_to(samples_root)) for m in chunk) + "\n")
    cmd = [sys.executable, "-u", str(pathlib.Path(__file__).resolve()),
           "--samples", str(samples_root), "--_manifests-file", str(list_path), "--_results-file", str(results_path)]
    if force:
        cmd.append("--force")
    proc = subprocess.Popen(cmd)
    peak_kb = _track_peak_rss_kb(proc)
    return proc.returncode, peak_kb


def _run_clap_chunked(manifests: list[pathlib.Path], samples_root: pathlib.Path, force: bool,
                       chunk_size: int, tmp_dir: pathlib.Path) -> list[dict]:
    chunks = _chunk_manifests(manifests, samples_root, chunk_size)
    all_results: list[dict] = []
    for idx, chunk in enumerate(chunks):
        label = chunk[0].relative_to(samples_root).parts[0] if len(chunk[0].relative_to(samples_root).parts) > 1 else "(root)"
        print(f"=== chunk {idx + 1}/{len(chunks)}: {label} ({len(chunk)} manifests) ===")
        results_path = tmp_dir / f"chunk-{idx:03d}.json"
        rc, peak_kb = _run_clap_chunk_subprocess(chunk, samples_root, force, results_path)
        print(f"  chunk {idx + 1}/{len(chunks)} peak RSS: {peak_kb / 1e6:.2f} GB (subprocess exit {rc})")
        if results_path.exists():
            all_results.extend(json.loads(results_path.read_text()))
        else:
            # The subprocess died before writing results (e.g. killed by an outer safe-run):
            # report every manifest in the chunk as an error rather than silently dropping it.
            for m in chunk:
                all_results.append({"name": m.name[: -len(".apricity.json")], "status": "error",
                                     "error": f"chunk subprocess exited {rc} without writing results", "seconds": 0.0})
    return all_results


# --------------------------------------------------------------------------- probe

def run_probe(manifests: list[pathlib.Path], prompts: list[str]) -> None:
    import numpy as np

    from apricity_analyze import clap as clap_mod

    all_names, all_vecs = [], []
    for mpath in manifests:
        cpath = clap_mod.sidecar_path_for(mpath)
        if not cpath.exists():
            continue
        with np.load(cpath, allow_pickle=True) as z:
            clip_names = [str(n) for n in z["clip_names"]]
            embs = z["clip_embeddings"]
        name = mpath.name[: -len(".apricity.json")]
        for cn, vec in zip(clip_names, embs):
            all_names.append(f"{mpath.parent.name}/{name}:{cn}")
            all_vecs.append(vec)
    if not all_vecs:
        print("probe: no clip embeddings found (run with CLAP enabled first)")
        return
    mat = np.stack(all_vecs).astype(np.float32)
    for prompt in prompts:
        q = clap_mod.embed_text(prompt)
        sims = mat @ q
        top = np.argsort(-sims)[:5]
        print(f"\nprompt: {prompt!r}")
        for i in top:
            print(f"  {sims[i]:+.4f}  {all_names[i]}")


# --------------------------------------------------------------------------- main

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="fit-features.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--samples", type=pathlib.Path, default=DEFAULT_SAMPLES, help="samples root (default: %(default)s)")
    ap.add_argument("--only", default=None, help="glob against the manifest's relative path (fnmatch)")
    ap.add_argument("--no-clap", action="store_true", help="skip CLAP embeddings")
    ap.add_argument("--workers", type=int, default=4, help="process pool size for the non-CLAP (fitfeat-only) pass (default: 4)")
    ap.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE,
                     help="max manifests per CLAP subprocess chunk (default: %(default)s)")
    ap.add_argument("--force", action="store_true", help="recompute sidecars even if already up to date")
    ap.add_argument("--probe", action="append", default=[], metavar="PROMPT",
                     help="after processing, rank saved clips against this CLAP text prompt (repeatable)")
    # Internal re-entry point used by the CLAP chunking orchestrator (_run_clap_chunk_subprocess)
    # to run exactly one chunk in a fresh subprocess; not meant to be passed by hand.
    ap.add_argument("--_manifests-file", type=pathlib.Path, default=None, help=argparse.SUPPRESS)
    ap.add_argument("--_results-file", type=pathlib.Path, default=None, help=argparse.SUPPRESS)
    args = ap.parse_args(argv)

    if not args.samples.is_dir():
        ap.error(f"--samples {args.samples} is not a directory")

    if args._manifests_file is not None:
        manifests = [args.samples / line.strip() for line in args._manifests_file.read_text().splitlines() if line.strip()]
    else:
        manifests = sorted(args.samples.rglob("*.apricity.json"))
        if args.only:
            manifests = [m for m in manifests if fnmatch.fnmatch(str(m.relative_to(args.samples)), args.only)]
    if not manifests:
        print("no manifests matched")
        return 0

    # A chunk subprocess (--_results-file given): do the work, write results as JSON, done. No
    # further chunking, no probe -- the orchestrator (the top-level invocation) handles those.
    if args._results_file is not None:
        results = _run_one_process(manifests, not args.no_clap, args.force, workers=1)
        args._results_file.write_text(json.dumps(results))
        return 1 if any(r["status"] == "error" for r in results) else 0

    t0 = time.time()
    if args.no_clap:
        results = _run_one_process(manifests, do_clap=False, force=args.force, workers=max(1, args.workers))
    else:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="fit-features-chunks-") as tmp:
            results = _run_clap_chunked(manifests, args.samples, args.force, max(1, args.chunk_size), pathlib.Path(tmp))
    wall = time.time() - t0

    done = sum(1 for r in results if r["status"] == "done")
    skipped = sum(1 for r in results if r["status"] == "skipped")
    no_grid = sum(1 for r in results if r["status"] == "no-beat-grid")
    errors = [r for r in results if r["status"] == "error"]
    clap_done = sum(1 for r in results if r.get("clap_status") == "done")
    fit_total = sum(r.get("fit_bytes", 0) for r in results)
    clap_total = sum(r.get("clap_bytes", 0) for r in results)

    print(f"\n{len(manifests)} manifests: {done} computed, {skipped} skipped (up to date), "
          f"{no_grid} no beat grid, {len(errors)} errors")
    if not args.no_clap:
        print(f"CLAP: {clap_done} computed")
    print(f"wall time: {wall:.1f}s")
    print(f"fitfeat sidecars: {fit_total / 1e6:.2f} MB total")
    if not args.no_clap:
        print(f"clap sidecars:    {clap_total / 1e6:.2f} MB total")
    for r in errors:
        print(f"  ERROR {r['name']}: {r['error']}")

    if args.probe:
        run_probe(manifests, args.probe)

    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
