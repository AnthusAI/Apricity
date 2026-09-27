#!/usr/bin/env python3
"""Deterministic grading for write-score evals: compile, render, harmony checker, task-specific rules.

    grade.py <iteration dir>      # writes grading.json into each <eval>/<config>/ run dir

Every check is a script, not an opinion, so runs can be compared without a human. The harmony
checker's objective (render --stems + scripts/check-stems.py) is the main quality number.
"""
import glob, json, os, pathlib, re, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parents[4]          # the repo root (…/.claude/skills/write-score/evals)
BIN = ROOT / "target/release/apricity"
PY = pathlib.Path("/Users/home/Projects/Apricity/analysis/.venv/bin/python")


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def rated_clips(min_stars=4):
    lib = pathlib.Path.home() / "Apricity-Library"
    clips = {json.load(open(f))["id"]: json.load(open(f)) for f in glob.glob(str(lib / "Clip/*.json"))}
    samples = {json.load(open(f))["id"]: json.load(open(f)) for f in glob.glob(str(lib / "Sample/*.json"))}
    out = set()
    for f in glob.glob(str(lib / "Rating/*.json")):
        r = json.load(open(f))
        if r.get("stars", 0) >= min_stars and r.get("targetType") == "clip" and r["targetId"] in clips:
            c = clips[r["targetId"]]
            s = samples.get(c["sampleId"], {})
            out.add((s.get("path", ""), c["name"]))
    return out


def grade(run_dir: pathlib.Path, eval_name: str):
    out = run_dir / "outputs"
    exps = []

    def check(text, passed, evidence):
        exps.append({"text": text, "passed": bool(passed), "evidence": str(evidence)[:300]})

    scores = sorted(out.glob("*.apr"))
    check("wrote a score (.apr) in outputs", scores, [p.name for p in scores])
    if not scores:
        return exps, {}
    score = max(scores, key=lambda p: p.stat().st_mtime)
    text = score.read_text()
    comp = run([str(BIN), "compile", str(score)])
    check("the score compiles", comp.returncode == 0, comp.stderr.strip()[-200:] or "ok")
    tl = json.loads(comp.stdout) if comp.returncode == 0 else {}
    check("an .m4a to send exists", list(out.glob("*.m4a")), [p.name for p in out.glob("*.m4a")])
    notes = out / "notes.md"
    check("notes.md describes the piece by bars", notes.exists() and re.search(r"\bbars?\b[^\n]{0,40}\d|\|\s*\d+\s*[-–]\s*\d+\s*\|", notes.read_text(), re.I), notes.exists())

    metrics = {}
    if tl:
        stems = out / "_grade.stems"
        run(["rm", "-rf", str(stems)])
        r = run([str(BIN), "render", str(score), "-o", str(out / "_grade.wav"), "--stems", str(stems)])
        silent = [l.split()[1] for l in r.stdout.splitlines() + r.stderr.splitlines() if l.strip().startswith("track") and "silent" in l]
        check("renders with no silent tracks", r.returncode == 0 and not silent, silent or "ok")
        if r.returncode == 0:
            c = run([str(PY), str(ROOT / "scripts/check-stems.py"), str(stems), "--json", "--baseline", str(out / "_grade.baseline.json"), "--log", "/dev/null"])
            try:
                rep = json.loads(c.stdout)
                metrics = {"objective": rep["objective"], "consonance": rep["consonance"], "penalties": rep.get("penalties")}
                check("harmony checker objective >= 70", rep["objective"] >= 70, f"objective {rep['objective']}, consonance {rep['consonance']}")
            except Exception as e:
                check("harmony checker ran", False, c.stderr[-200:])
        bars = tl.get("length_beats", 0) / tl.get("meter", 4)
        metrics["bars"] = bars
        metrics["tempo"] = tl.get("tempo")

    # task-specific rules
    if eval_name == "deep-house-from-ratings":
        rated = rated_clips()
        paths = dict(re.findall(r"^clip\s+(\S+)\s*=\s*(\S+)", text, re.M))
        used = set(re.findall(r"^clip\s+\S+\s*=\s*(\S+)\s+(\S+)", text, re.M))
        # clips used through kit pads: "  pad = <clip> <saved clip>"
        used |= {(paths[c], n) for c, n in re.findall(r"^\s+\S+\s*=\s*(\S+)\s+(\S+)", text, re.M) if c in paths}
        hit = [u for u in used if any(u[0].endswith(p) and u[1] == n for p, n in rated)]
        check("uses at least one clip the user rated 4+ stars", hit, hit or used)
        check("about 16 bars (12-24)", 12 <= metrics.get("bars", 0) <= 24, metrics.get("bars"))
        check("house tempo (115-128 bpm)", 115 <= (metrics.get("tempo") or 0) <= 128, metrics.get("tempo"))
    elif eval_name == "blues-shuffle-marine-band":
        check("12-bar form (length a multiple of 12 bars)", metrics.get("bars", 0) and metrics["bars"] % 12 == 0, metrics.get("bars"))
        ch = " ".join(re.findall(r"^chords\s+(.*)$", text, re.M))
        check("uses I7, IV7 and V7", all(x in ch for x in ("I7", "IV7", "V7")), ch[:120])
        check("tempo around 90 (85-95)", 85 <= (metrics.get("tempo") or 0) <= 95, metrics.get("tempo"))
        check("swung", re.search(r"\bswing\s+(5[5-9]|6\d|7[0-5])", text), re.findall(r"swing\s+\S+", text)[:3])
        check("uses marine-band stems", "marine-band/stems/" in text, "yes" if "marine-band/stems/" in text else "no")
    elif eval_name == "radio-edit-fork":
        diff = run(["git", "-C", str(ROOT), "diff", "--quiet", "--", "examples/ave-house.apr"])
        check("the original examples/ave-house.apr is untouched", diff.returncode == 0, "clean" if diff.returncode == 0 else "modified")
        check("16 bars", abs(metrics.get("bars", 0) - 16) < 0.01, metrics.get("bars"))
        kick_bars = [e["start_beat"] / tl.get("meter", 4) + 1 for e in tl.get("events", []) if e.get("track", "").endswith("kick")] if tl else []
        check("the drop (kick) arrives by bar 8", kick_bars and min(kick_bars) <= 8, min(kick_bars) if kick_bars else "no kick")
        check("keeps the credits (Ave, Funky Nurykabe, Salamander)", all(k in text for k in ("Ave", "Nurykabe", "Salamander")), "credits")
    return exps, metrics


def main(it: str):
    for d in sorted(pathlib.Path(it).glob("eval-*/*/run-*")) or sorted(pathlib.Path(it).glob("eval-*/*")):
        if not (d / "outputs").is_dir():
            continue
        name = next(p.name for p in d.parents if p.name.startswith("eval-")).removeprefix("eval-")
        exps, metrics = grade(d, name)
        passed = sum(e["passed"] for e in exps)
        g = {"expectations": exps, "summary": {"passed": passed, "failed": len(exps) - passed, "total": len(exps), "pass_rate": round(passed / max(len(exps), 1), 3)}, "metrics": metrics}
        json.dump(g, open(d / "grading.json", "w"), indent=2)
        print(f"{name:28} {d.name:14} {passed}/{len(exps)}  {metrics.get('objective', '-')}")


if __name__ == "__main__":
    main(sys.argv[1])
