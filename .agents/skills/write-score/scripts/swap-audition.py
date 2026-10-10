#!/usr/bin/env python3
"""Audition candidate clips for one clip line of a score: swap each in, render with stems, run the
harmony checker, and rank by objective (guards included).

    swap-audition.py examples/song.apr bright "ccmixter/A/x.mp3 loop-1" "ccmixter/B/y.mp3 sec-A2" ...

The clip named on the command line (e.g. `bright`) has its sample and saved clip replaced, and
the track that plays it is set to `transpose auto` so Apricity fits it to the chords. Lines tagged
`# only:<clip>` in the score are dropped for candidates (fixes specific to the original clip, such
as its notches). Prints a ranking; writes each candidate's score to renders/<name>-cand-N.apr.
"""
import pathlib, re, subprocess, sys, json

score, clipname, cands = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3:]
root = pathlib.Path(subprocess.check_output(["git", "-C", str(score.parent), "rev-parse", "--show-toplevel"], text=True).strip())
main = pathlib.Path(subprocess.check_output(["git", "-C", str(root), "rev-parse", "--path-format=absolute", "--git-common-dir"], text=True).strip()).parent
binp = root / "target/release/apricity"
py = main / "analysis/.venv/bin/python"
text = score.read_text()
base = root / "renders" / f"{score.stem}.baseline.json"
results = []
for n, cand in enumerate(["(original)"] + cands):
    t = text
    if cand != "(original)":
        sample, saved = cand.split()
        t = re.sub(rf"^(clip\s+{clipname}\s*=\s*)\S+\s+\S+.*$", rf"\g<1>{sample}  {saved}", t, flags=re.M)
        t = re.sub(rf"^(track\s+{clipname}\b[^\n]*?)\s+transpose\s+\S+", r"\1", t, flags=re.M)
        t = "\n".join(l for l in t.splitlines() if f"# only:{clipname}" not in l) + "\n"
    out = root / "renders" / f"{score.stem}-cand-{n}.apr"
    out.write_text(t.replace("samples ../samples", f"samples {pathlib.Path('..') / 'samples'}"))
    stems = root / "renders" / f"{score.stem}-cand-{n}.stems"
    subprocess.run(["rm", "-rf", str(stems)])
    r = subprocess.run([str(binp), "render", str(out), "-o", str(stems) + ".wav", "--stems", str(stems)], capture_output=True, text=True)
    if r.returncode:
        results.append((-1, cand, r.stderr.strip().splitlines()[-1][:120])); continue
    c = subprocess.run([str(py), str(root / "scripts/check-stems.py"), str(stems), "--json", "--baseline", str(base), "--log", "/dev/null"], capture_output=True, text=True)
    try:
        rep = json.loads(c.stdout)
        results.append((rep["objective"], cand, f"consonance {rep['consonance']:.1f}  penalties {rep.get('penalties')}"))
    except Exception as e:
        results.append((-1, cand, f"check failed: {c.stderr.strip()[-120:]}"))
    print(f"  {results[-1][0]:6.1f}  {cand}", flush=True)
print("\nranking:")
for obj, cand, note in sorted(results, key=lambda r: -r[0]):
    print(f"  {obj:6.1f}  {cand:70}  {note}")
