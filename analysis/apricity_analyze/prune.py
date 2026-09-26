"""apricity-prune: remove what the curators rated one star.

  PYTHONPATH=analysis python3 -m apricity_analyze.prune                 # plan only: nothing changes
  PYTHONPATH=analysis python3 -m apricity_analyze.prune --apply         # do it

Reads the ratings from the production backend (the Rating table behind the GraphQL API) using your AWS
access, because the API itself only hands a person their own ratings and sign-in is Google-only. Only
ratings made by members of the `curators` Cognito group count, and a sample or clip is pruned only when every
such rating of it is one star. A visitor's rating never removes anything.

A pruned sample goes from everywhere it lives: its backend rows (clips, markers, candidates, verdicts, crate
items, ratings, comments, tallies, and the recording when it was the last sample), its bucket objects
(records and files), the local library folder, and the repo (audio, manifest, catalog entries), and it is
written to samples/pruned.json so an importer never brings it back. Refused, and reported, when a saved score
or a file in examples/ still uses it. When a denoised copy (X.clean.wav) was made from the file, the file stays
as the copy's source and only the sample is removed. Needs boto3 for the real run (`pip install boto3`).
"""
from __future__ import annotations

import argparse
import datetime
import json
import pathlib
import sys
from collections import defaultdict
from dataclasses import dataclass, field

KEY = {"Verdict": ("candidateId", "judge")}  # every other model is keyed by `id`
SYNCED = ("Recording", "Sample", "Clip", "Marker", "Candidate", "Verdict", "CrateItem")  # records also kept in the bucket
MODELS = ("Rating", "Recording", "Sample", "Clip", "Marker", "Candidate", "Verdict", "CrateItem", "ScoreRef", "Comment", "Tally")
CONTENT_DIRS = ("examples", "web/src/breakdowns")  # where a sample path in a file means something still uses it


def owner_sub(owner: str) -> str:
    return (owner or "").split("::")[0]


def row_key(model: str, row: dict) -> dict:
    return {k: row[k] for k in KEY.get(model, ("id",))}


def object_key(model: str, row: dict) -> str:
    return f"{model}/{'__'.join(str(row[k]) for k in KEY.get(model, ('id',)))}.json"


@dataclass
class Item:
    kind: str  # sample | clip | rating (a rating whose target is already gone)
    id: str
    label: str
    blocked: list[str] = field(default_factory=list)
    rows: list[tuple[str, dict]] = field(default_factory=list)  # (model, row) to delete from the backend
    objects: list[str] = field(default_factory=list)  # bucket keys
    files: list[pathlib.Path] = field(default_factory=list)  # local files to delete
    catalog_paths: list[str] = field(default_factory=list)  # sources.json paths to drop
    tombstones: list[dict] = field(default_factory=list)
    manifest_edits: list[tuple[pathlib.Path, str]] = field(default_factory=list)  # (manifest, clip name to remove)
    candidate_clips: list[str] = field(default_factory=list)  # paths whose curation candidates in library/candidates.json go
    notes: list[str] = field(default_factory=list)


def one_star_targets(ratings: list[dict], trusted: set[str]) -> list[tuple[str, str]]:
    """(type, id) of samples and clips whose every trusted rating is one star."""
    seen: dict[tuple[str, str], list[int]] = defaultdict(list)
    for r in ratings:
        if r.get("targetType") in ("sample", "clip") and owner_sub(r.get("owner", "")) in trusted:
            seen[(r["targetType"], r["targetId"])].append(int(r["stars"]))
    return sorted(k for k, v in seen.items() if v and all(s == 1 for s in v))


def _manifest(audio: pathlib.Path) -> pathlib.Path:
    return audio.with_name(audio.name + ".apricity.json")


def _refs_in_content(repo: pathlib.Path, path: str) -> list[str]:
    hits = []
    for d in CONTENT_DIRS:
        base = repo / d
        for f in sorted(base.rglob("*")) if base.exists() else []:
            if f.is_file() and f.suffix in (".apr", ".yaml", ".yml", ".json", ".md"):
                try:
                    if path in f.read_text(errors="ignore"):
                        hits.append(str(f.relative_to(repo)))
                except OSError:
                    pass
    return hits


def _denoise_survivors(audio: pathlib.Path, pruned_paths: set[pathlib.Path]) -> list[pathlib.Path]:
    """Denoised copies made from `audio` that are not themselves being pruned."""
    out = []
    for m in audio.parent.glob("*.clean.wav.apricity.json"):
        try:
            src = json.loads(m.read_text())["source"].get("denoise", {})
        except (OSError, ValueError, KeyError):
            continue
        clean = m.with_name(m.name.removesuffix(".apricity.json"))
        if src.get("original") == audio.name and clean not in pruned_paths:
            out.append(clean)
    return out


def build_plan(db: dict[str, list[dict]], trusted: set[str], repo: pathlib.Path, library: pathlib.Path | None) -> list[Item]:
    samples = {s["id"]: s for s in db["Sample"]}
    clips = {c["id"]: c for c in db["Clip"]}
    by = lambda model, field_: _index(db[model], field_)  # noqa: E731
    refs_by_sample, refs_by_clip = by("ScoreRef", "sampleId"), by("ScoreRef", "clipId")
    children = by("Sample", "parentSampleId")
    targets = one_star_targets(db["Rating"], trusted)
    plan: list[Item] = []
    pruned_sample_ids: set[str] = set()

    sample_targets = [t for kind, t in targets if kind == "sample"]
    for sid in sample_targets:
        if sid not in samples:
            continue
        group = [sid]
        for g in group:  # stems and anything else derived from it
            group += [c["id"] for c in children.get(g, []) if c["id"] not in group]
        pruned_sample_ids.update(group)

    pruned_paths = {repo / "samples" / samples[i]["path"] for i in pruned_sample_ids}
    for sid in sample_targets:
        s = samples.get(sid)
        if not s:
            plan.append(_orphan_ratings(db, "sample", sid))
            continue
        item = Item("sample", sid, s["path"])
        group = [sid]
        for g in group:
            group += [c["id"] for c in children.get(g, []) if c["id"] not in group]
        group_clips = [c for i in group for c in _index(db["Clip"], "sampleId").get(i, [])]
        for i in group:
            for ref in refs_by_sample.get(i, []):
                item.blocked.append(f"used by score {ref['scoreId']}")
        for c in group_clips:
            for ref in refs_by_clip.get(c["id"], []):
                item.blocked.append(f"a clip of it is used by score {ref['scoreId']}")
        for i in group:
            for hit in _refs_in_content(repo, samples[i]["path"]):
                item.blocked.append(f"named in {hit}")
        item.blocked = sorted(set(item.blocked))
        if not item.blocked:
            _fill_sample(item, db, group, group_clips, samples, repo, library, pruned_paths)
        plan.append(item)

    for kind, cid in targets:
        if kind != "clip":
            continue
        c = clips.get(cid)
        if not c or c["sampleId"] in pruned_sample_ids:
            if not c:
                plan.append(_orphan_ratings(db, "clip", cid))
            continue
        item = Item("clip", cid, f"{c.get('name', cid)} (clip of {samples.get(c['sampleId'], {}).get('path', c['sampleId'])})")
        for ref in refs_by_clip.get(cid, []):
            item.blocked.append(f"used by score {ref['scoreId']}")
        if not item.blocked:
            _fill_clip(item, db, c, samples, repo, library)
        plan.append(item)
    return plan


def _index(rows: list[dict], field_: str) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        if r.get(field_) is not None:
            out[r[field_]].append(r)
    return out


def _orphan_ratings(db, kind: str, tid: str) -> Item:
    item = Item("rating", tid, f"{kind} {tid} (already removed)")
    item.rows += [("Rating", r) for r in db["Rating"] if r["targetId"] == tid]
    item.rows += [("Tally", r) for r in db["Tally"] if r.get("targetId") == tid]
    item.notes.append("its ratings are all that is left")
    return item


def _target_rows(db, target_ids: set[str]) -> list[tuple[str, dict]]:
    return [(m, r) for m in ("Rating", "Tally", "Comment") for r in db[m] if r.get("targetId") in target_ids]


def _fill_clip(item: Item, db, c: dict, samples: dict, repo, library) -> None:
    item.rows += [("Clip", c)] + _target_rows(db, {c["id"]}) + [("CrateItem", r) for r in db["CrateItem"] if r.get("clipId") == c["id"]]
    _finish(item, library)
    s = samples.get(c["sampleId"])
    if s:
        m = _manifest(repo / "samples" / s["path"])
        if m.exists():
            item.manifest_edits.append((m, c.get("name", "")))


def _fill_sample(item: Item, db, group: list[str], group_clips: list[dict], samples: dict, repo, library, pruned_paths: set[pathlib.Path]) -> None:
    gset = set(group)
    cands = [c for c in db["Candidate"] if c.get("sampleId") in gset]
    cand_ids = {c["id"] for c in cands}
    rows = [("Sample", samples[i]) for i in group]
    rows += [("Clip", c) for c in group_clips]
    rows += [("Marker", m) for m in db["Marker"] if m.get("sampleId") in gset]
    rows += [("Candidate", c) for c in cands]
    rows += [("Verdict", v) for v in db["Verdict"] if v.get("candidateId") in cand_ids]
    rows += [("CrateItem", r) for r in db["CrateItem"] if r.get("sampleId") in gset or r.get("candidateId") in cand_ids]
    rows += _target_rows(db, gset | {c["id"] for c in group_clips})
    remaining = {s["recordingId"] for s in db["Sample"] if s["id"] not in gset}
    for rid in sorted({samples[i]["recordingId"] for i in group} - remaining):
        rows += [("Recording", r) for r in db["Recording"] if r["id"] == rid]
    item.rows += rows
    for i in group:
        s = samples[i]
        for ref in ("audio", "analysis"):
            if s.get(ref, {}).get("key"):
                item.objects.append(f"files/{s[ref]['key']}")
        audio = repo / "samples" / s["path"]
        item.candidate_clips.append(s["path"])
        item.files.append(_manifest(audio))
        if audio.name.endswith(".clean.wav"):  # a derived copy: its original stays
            item.files.append(audio)
        elif s.get("parentSampleId"):  # a stem
            item.files.append(audio)
        else:
            keep = _denoise_survivors(audio, pruned_paths)
            if keep:
                item.notes.append(f"kept {audio.name}: it is the source of {keep[0].name}")
            else:
                item.files.append(audio)
                item.catalog_paths.append(s["path"])
                item.tombstones.append({"path": s["path"], "sha256": s.get("audio", {}).get("sha256"), "title": s.get("title"),
                                        "reason": "rated one star by the curators", "at": datetime.date.today().isoformat()})
    _finish(item, library)


def _finish(item: Item, library: pathlib.Path | None) -> None:
    for model, row in item.rows:
        if model in SYNCED:
            item.objects.append(object_key(model, row))
            if library:
                item.files.append(library / object_key(model, row))
    if library:
        item.files += [library / o for o in item.objects if o.startswith("files/")]
    item.objects = sorted(dict.fromkeys(item.objects))
    item.files = list(dict.fromkeys(item.files))


def describe(plan: list[Item]) -> str:
    if not plan:
        return "Nothing is rated one star by a curator."
    lines = []
    for it in plan:
        head = f"{it.kind:6} {it.label}  [{it.id}]"
        if it.blocked:
            lines.append(f"KEEP   {head}\n         not pruned: " + "; ".join(it.blocked))
            continue
        by_model: dict[str, int] = defaultdict(int)
        for m, _ in it.rows:
            by_model[m] += 1
        lines.append(f"PRUNE  {head}\n         backend rows: " + (", ".join(f"{n} {m}" for m, n in sorted(by_model.items())) or "none")
                     + f"; {len(it.objects)} bucket objects; {sum(1 for f in it.files if f.exists())} local files"
                     + ("; catalog entry removed and tombstoned" if it.catalog_paths else ""))
        lines += [f"         note: {n}" for n in it.notes]
    n = sum(1 for it in plan if not it.blocked)
    lines.append(f"\n{n} to prune, {len(plan) - n} kept because something still uses them. Run again with --apply to do it.")
    return "\n".join(lines)


def apply(plan: list[Item], backend, repo: pathlib.Path) -> None:
    """Backend rows leaf-first, then bucket objects, then local files and the repo. Ratings go last so an
    interrupted run can be repeated: what is left over is found again as ratings of a missing target."""
    for it in plan:
        if it.blocked:
            continue
        ordered = sorted(it.rows, key=lambda r: (r[0] in ("Rating", "Tally", "Comment"), r[0] == "Sample", r[0] == "Recording"))
        for model, row in ordered:
            backend.delete_row(model, row_key(model, row))
        for key in it.objects:
            backend.delete_object(key)
        for f in it.files:
            if f.exists():
                f.unlink()
        for manifest, name in it.manifest_edits:
            _drop_manifest_clip(manifest, name)
        if it.candidate_clips:
            _drop_candidates(repo, it.candidate_clips)
        if it.catalog_paths:
            _drop_catalog(repo, it.catalog_paths)
        if it.tombstones:
            _add_tombstones(repo, it.tombstones)


def _drop_manifest_clip(manifest: pathlib.Path, name: str) -> None:
    m = json.loads(manifest.read_text())
    clips = m.get("annotations", {}).get("clips", [])
    kept = [c for c in clips if c.get("name") != name]
    if len(kept) != len(clips):
        m["annotations"]["clips"] = kept
        manifest.write_text(json.dumps(m, indent=1) + "\n")


def _drop_candidates(repo: pathlib.Path, clips: list[str]) -> None:
    """Curation candidates for a pruned file would be re-created by the next migrate."""
    p = repo / "library/candidates.json"
    if not p.exists():
        return
    d = json.loads(p.read_text())
    kept = [c for c in d.get("candidates", []) if c.get("clip") not in clips]
    if len(kept) != len(d.get("candidates", [])):
        d["candidates"] = kept
        p.write_text(json.dumps(d, indent=1, ensure_ascii=False) + "\n")


def _drop_catalog(repo: pathlib.Path, paths: list[str]) -> None:
    flat = repo / "samples/sources.json"
    if flat.exists():
        d = json.loads(flat.read_text())
        d["files"] = [f for f in d["files"] if f["path"] not in paths]
        flat.write_text(json.dumps(d, indent=2, ensure_ascii=False))
    cat = repo / "crates/apricity-sources/catalog/sources.json"
    if cat.exists():
        sources = json.loads(cat.read_text())
        out = []
        for s in sources:
            if s.get("archive"):  # one file cannot be taken out of an archive download
                out.append(s)
                continue
            s["files"] = [f for f in s["files"] if f["path"] not in paths]
            if s["files"]:
                out.append(s)
        cat.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")


def tombstone_path(repo: pathlib.Path) -> pathlib.Path:
    return repo / "samples/pruned.json"


def _add_tombstones(repo: pathlib.Path, entries: list[dict]) -> None:
    p = tombstone_path(repo)
    d = json.loads(p.read_text()) if p.exists() else {"about": "Samples the curators pruned (one star). Importers refuse these.", "pruned": []}
    have = {e["path"] for e in d["pruned"]}
    d["pruned"] += [e for e in entries if e["path"] not in have]
    p.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n")


def is_pruned(repo: pathlib.Path, path: str | None = None, sha256: str | None = None) -> bool:
    p = tombstone_path(repo)
    if not p.exists():
        return False
    return any((path and e["path"] == path) or (sha256 and e.get("sha256") == sha256) for e in json.loads(p.read_text())["pruned"])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="apricity-prune", description=__doc__.split("\n\n")[0])
    ap.add_argument("--apply", action="store_true", help="really delete; without it only the plan is printed")
    ap.add_argument("--repo", type=pathlib.Path, default=pathlib.Path("."))
    ap.add_argument("--library", type=pathlib.Path, default=pathlib.Path.home() / "Apricity-Library")
    ap.add_argument("--region", default="us-east-1")
    ap.add_argument("--curators-only", dest="owners", action="store_const", const=None, help=argparse.SUPPRESS)
    ap.add_argument("--owner", action="append", help="count this Cognito sub instead of the curators group (repeatable)")
    a = ap.parse_args(argv)
    from .prune_aws import AwsBackend

    backend = AwsBackend(a.region)
    trusted = set(a.owner or backend.curator_subs())
    if not trusted:
        print("no curators found: nothing to trust", file=sys.stderr)
        return 1
    db = {m: backend.scan(m) for m in MODELS}
    plan = build_plan(db, trusted, a.repo.resolve(), a.library if a.library.exists() else None)
    print(describe(plan))
    if a.apply and plan:
        apply(plan, backend, a.repo.resolve())
        print("done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
