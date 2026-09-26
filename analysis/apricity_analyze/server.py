"""Local server for the Apricity web app.

    PYTHONPATH=analysis analysis/.venv/bin/python -m apricity_analyze.server

Serves the repo's samples, manifests, scores and schema read-only; writes only what the web app
edits (clip annotations, scores) and new uploads. Listens on 127.0.0.1 only. In production mode
it also serves the built app (web/dist) with the cross-origin isolation headers that
SharedArrayBuffer needs.
"""

from __future__ import annotations

import json
import pathlib
import re
import threading
import time

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse

ROOT = pathlib.Path(__file__).resolve().parents[2]
SAMPLES = ROOT / "samples"
READABLE = ("samples", "examples", "scores", "schema")
SCORE_DIRS = ("examples", "scores")
AUDIO = {".wav", ".mp3", ".flac", ".aif", ".aiff", ".ogg", ".m4a"}
CLIP_NAME = re.compile(r"^[A-Za-z0-9_-]+$")

app = FastAPI(title="Apricity")


def resolve(rel: str, allowed: tuple[str, ...]) -> pathlib.Path:
    """Map a repo-relative path to disk, refusing anything outside the allowed top-level folders."""
    p = (ROOT / rel).resolve()
    try:
        top = p.relative_to(ROOT).parts[0]
    except (ValueError, IndexError):
        raise HTTPException(403, f"{rel}: outside the project")
    if top not in allowed:
        raise HTTPException(403, f"{rel}: only {', '.join(allowed)} are available here")
    return p


@app.middleware("http")
async def isolation_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    resp.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
    resp.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    resp.headers.setdefault("Cache-Control", "no-store")
    return resp


# ------------------------------------------------------------------ clips

def _credits() -> dict[str, dict]:
    src = SAMPLES / "sources.json"
    if not src.exists():
        return {}
    return {f["path"]: f for f in json.loads(src.read_text())["files"] if f.get("kind") != "score"}


def _summary(manifest_path: pathlib.Path, credits: dict) -> dict:
    m = json.loads(manifest_path.read_text())
    audio_rel = str(manifest_path.relative_to(ROOT))[: -len(".apricity.json")]
    in_samples = str(manifest_path.relative_to(SAMPLES))[: -len(".apricity.json")]
    dn = m["source"].get("denoise")  # a noise-reduced copy takes its original's credits
    c = credits.get(in_samples) or (credits.get(str(pathlib.PurePosixPath(in_samples).with_name(dn["original"]))) if dn else None) or {}
    k = m["tonal"]["key"]
    segs = []
    for s in m["tonal"].get("segments", []):
        label = s["key"]["tonic"] + ("m" if s["key"]["mode"] == "minor" else "")
        if not segs or segs[-1] != label:
            segs.append(label)
    title = c.get("title") or pathlib.Path(audio_rel).stem.replace("-", " ").replace("_", " ")
    stem = m.get("derived_from")
    if stem:  # e.g. "The Washington Post · bass"
        parent = credits.get(stem["source"].removeprefix("samples/"), {})
        title = f"{parent.get('title') or pathlib.Path(stem['source']).stem} · {stem['stem']}"
        c = parent
    return {
        "path": audio_rel,
        "title": title,
        "group": in_samples.split("/")[0] if "/" in in_samples else "",
        "excerpt_start": c.get("excerpt_start"),
        "credit": c.get("credit"),
        "rights": c.get("rights"),
        "duration": m["source"]["duration"],
        "bpm": m["rhythm"]["bpm"],
        "stability": m["rhythm"].get("bpm_stability"),
        "meter": m["rhythm"].get("meter"),
        "key": k["tonic"] + ("m" if k["mode"] == "minor" else ""),
        "camelot": k.get("camelot"),
        "keys_over_time": segs,
        "tuning_cents": m["tonal"].get("tuning_cents"),
        "notes": len(m.get("notes", [])),
        "clips": len(m.get("annotations", {}).get("clips", [])),
        "markers": len(m.get("annotations", {}).get("markers", [])),
        "stem": stem["stem"] if stem else None,
    }


@app.get("/api/samples")
def samples():
    credits = _credits()
    # Modern, full-length recordings first; then the archive excerpts; then uploads.
    order = {"marine-band": 0, "citizen-dj": 1, "uploads": 2}
    # A recording with a noise-reduced copy (<name>.clean.wav) shows the copy; the original stays on disk.
    def superseded(audio: pathlib.Path) -> bool:
        return ".clean." not in audio.name and audio.with_suffix(".clean.wav").exists()

    out = sorted((_summary(p, credits) for p in SAMPLES.rglob("*.apricity.json")
                  if not superseded(p.with_name(p.name.removesuffix(".apricity.json")))), key=lambda c: (order.get(c["group"], 3), c["path"]))
    pending = [str(p.relative_to(ROOT)) for p in sorted(SAMPLES.rglob("*")) if p.suffix.lower() in AUDIO and not superseded(p) and not p.with_name(p.name + ".apricity.json").exists()]
    return {"samples": out, "unanalyzed": pending, "jobs": list(JOBS.values())}


@app.put("/api/annotations")
async def put_annotations(path: str, request: Request):
    """Replace a sample's annotations (saved clips, markers, tags). Validated so nothing out of range is saved."""
    audio = resolve(path, ("samples",))
    mpath = audio.with_name(audio.name + ".apricity.json")
    if not mpath.exists():
        raise HTTPException(404, f"{path} has no manifest")
    ann = await request.json()
    m = json.loads(mpath.read_text())
    dur = m["source"]["duration"]
    problems = []
    names = set()
    for i, s in enumerate(ann.get("clips", [])):
        if not CLIP_NAME.match(str(s.get("name", ""))):
            problems.append(f"clips[{i}]: name {s.get('name')!r} must be letters, digits, - or _")
        if s.get("name") in names:
            problems.append(f"clips[{i}]: name {s.get('name')!r} is used twice")
        names.add(s.get("name"))
        if not (0 <= s.get("start", -1) < s.get("end", -1) <= dur + 1e-6):
            problems.append(f"clips[{i}] {s.get('name')!r}: [{s.get('start')}, {s.get('end')}] must satisfy 0 ≤ start < end ≤ {dur}")
    for i, mk in enumerate(ann.get("markers", [])):
        if not (0 <= mk.get("seconds", -1) <= dur + 1e-6):
            problems.append(f"markers[{i}]: {mk.get('seconds')} is outside the sample (0..{dur})")
    if problems:
        return JSONResponse({"errors": problems}, status_code=422)
    m["annotations"] = {k: v for k, v in ann.items() if k in ("markers", "clips", "tags")}
    m["apricity_manifest"] = 2
    from .analyze import validate

    try:
        validate(m)
    except Exception as e:  # jsonschema detail
        return JSONResponse({"errors": [str(e).splitlines()[0]]}, status_code=422)
    mpath.write_text(json.dumps(m, indent=1) + "\n")
    return {"ok": True}


# ------------------------------------------------------------------ scores

@app.get("/api/scores")
def scores():
    out = []
    for d in SCORE_DIRS:
        for p in sorted([*(ROOT / d).glob("*.yaml"), *(ROOT / d).glob("*.apr")]):
            out.append({"path": str(p.relative_to(ROOT)), "modified": p.stat().st_mtime})
    return {"scores": out}


@app.put("/api/score")
async def put_score(path: str, request: Request):
    p = resolve(path, SCORE_DIRS)
    if p.suffix not in (".yaml", ".apr"):
        raise HTTPException(400, "scores are .apr or .yaml files")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text((await request.body()).decode("utf-8"))
    return {"ok": True, "modified": p.stat().st_mtime}


# ------------------------------------------------------------------ ingest

JOBS: dict[str, dict] = {}
_analysis_lock = threading.Lock()


def _analyze_job(audio: pathlib.Path, key: str):
    from .analyze import analyze, write

    JOBS[key] = {"path": key, "state": "analyzing", "started": time.time()}
    try:
        with _analysis_lock:  # one at a time: the models are big
            write(analyze(audio, with_notes=True), audio)
            from .markup import run as markup

            markup(audio)  # sections, loops, hits (source: ml)
        JOBS[key] = {"path": key, "state": "done"}
    except Exception as e:
        JOBS[key] = {"path": key, "state": "failed", "error": str(e)}


@app.post("/api/upload")
async def upload(file: UploadFile):
    name = pathlib.Path(file.filename or "").name
    if pathlib.Path(name).suffix.lower() not in AUDIO:
        raise HTTPException(400, f"{name!r}: expected one of {', '.join(sorted(AUDIO))}")
    dest = SAMPLES / "uploads" / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(await file.read())
    key = str(dest.relative_to(ROOT))
    threading.Thread(target=_analyze_job, args=(dest, key), daemon=True).start()
    return {"path": key, "state": "queued"}


@app.post("/api/analyze")
def analyze_existing(path: str):
    audio = resolve(path, ("samples",))
    if not audio.exists():
        raise HTTPException(404, path)
    threading.Thread(target=_analyze_job, args=(audio, path), daemon=True).start()
    return {"path": path, "state": "queued"}


# ------------------------------------------------------------------ files + app

@app.get("/files/{rel:path}")
def files(rel: str):
    p = resolve(rel, READABLE)
    if not p.is_file():
        raise HTTPException(404, rel)
    if p.suffix in (".yaml", ".apr"):
        return PlainTextResponse(p.read_text(), media_type="text/plain; charset=utf-8")
    return FileResponse(p)


DIST = ROOT / "web" / "dist"
WASM = ROOT / "target" / "wasm32-wasip1" / "release" / "apricity_web.wasm"


@app.get("/apricity_web.wasm")
def wasm():
    return FileResponse(WASM, media_type="application/wasm")


@app.get("/{rel:path}")
def app_files(rel: str):
    p = (DIST / (rel or "index.html")).resolve()
    if not p.is_relative_to(DIST) or not p.is_file():
        p = DIST / "index.html"
    if not p.exists():
        return PlainTextResponse("web app not built; run `npm run build` in web/ (or use `npm run dev`)", status_code=404)
    return FileResponse(p)


def main():
    import uvicorn

    import os

    # 5181 unless the launcher assigns another port (PORT); the web dev server proxies to APRICITY_API_PORT.
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT") or 5181), log_level="warning")


if __name__ == "__main__":
    main()
