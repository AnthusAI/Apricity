"""The listener's verdicts on explorer results, kept where they can't be lost.

The explorer proposes; a person listens and judges (design/framework.md: "machines propose; people
judge"). Until now a run's notebook lived under `renders/` (ignored by git, local to one worktree), so
every run and every verdict vanished with its worktree. Verdicts now go to the library, append-only:

    ~/Apricity-Library/notebooks/
      verdicts.jsonl          one verdict per line, never rewritten
      explore/<run>/          the text of each run, mirrored by the notebook (not its audio)

A verdict is one of:
    stars   an experiment rated 1–5
    pick    one experiment preferred over others (`over`: the experiment ids it beat)
    none    nothing proposed was better than what was there (`over`: the ones it beat)
with the run, the experiment, what it cast (sample and clip, when the experiment says), the score's
hash, who judged, when, and a note in the listener's own words.

`taste(sample, clip)` turns them into the layer validator's taste term (a penalty: 0 loved, 1
disliked, 0.5 unrated), smoothed toward 0.5 until there are enough verdicts to believe.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import hashlib
import json
import pathlib

KINDS = ("stars", "pick", "none")
PRIOR = 2.0  # verdicts' worth of "unrated" (0.5) that a clip's taste starts from


def library_dir(library: pathlib.Path | None = None) -> pathlib.Path:
    return (library or pathlib.Path.home() / "Apricity-Library").expanduser()


def notebooks_dir(library: pathlib.Path | None = None) -> pathlib.Path:
    return library_dir(library) / "notebooks"


@dataclasses.dataclass
class Verdict:
    kind: str
    run: str
    experiment: str | None = None
    stars: int | None = None
    over: list[str] = dataclasses.field(default_factory=list)
    #: what each of `over` cast, [sample, clip] (filled in from the run's files), so a loss counts against it
    over_casts: list[list[str]] = dataclasses.field(default_factory=list)
    sample: str | None = None
    clip: str | None = None
    score_sha: str | None = None
    note: str = ""
    by: str = "person"
    at: str = ""
    id: str = ""

    def check(self) -> None:
        if self.kind not in KINDS:
            raise ValueError(f"verdict kind {self.kind!r}: one of {', '.join(KINDS)}")
        if self.kind == "stars" and not (self.stars is not None and 1 <= int(self.stars) <= 5):
            raise ValueError("a stars verdict needs 1–5 stars")
        if self.kind != "stars" and self.stars is not None:
            raise ValueError("only a stars verdict has stars")
        if self.kind in ("stars", "pick") and not self.experiment:
            raise ValueError(f"a {self.kind} verdict names the experiment it judges")
        if self.kind == "none" and self.experiment:
            raise ValueError("a none verdict judges no experiment (it says none of `over` was better)")
        if self.kind in ("pick", "none") and not self.over:
            raise ValueError(f"a {self.kind} verdict says what it was preferred over")


def _cast_of(run_dir: pathlib.Path | None, experiment: str | None) -> tuple[str | None, str | None, str | None]:
    """What an experiment cast (sample, clip) and its score's hash, from its saved files, when they're there."""
    if not run_dir or not experiment:
        return None, None, None
    d = run_dir / experiment
    sample = clip = sha = None
    exp = d / "experiment.json"
    if exp.exists():
        for op in json.loads(exp.read_text()).get("ops", []):
            if op.get("op") == "cast.swap":  # the role's clip, pointed at another sample's saved clip
                sample, clip = op.get("sample", sample), op.get("clip", clip)
    score = d / "score.apr"
    if score.exists():
        sha = hashlib.sha256(score.read_bytes()).hexdigest()[:16]
    return sample, clip, sha


def record(v: Verdict, *, library: pathlib.Path | None = None, run_dir: pathlib.Path | None = None) -> Verdict:
    """Append a verdict (filling in what the run's files say about the experiment). Returns it as stored."""
    v.check()
    run_dir = run_dir or notebooks_dir(library) / "explore" / v.run
    sample, clip, sha = _cast_of(run_dir, v.experiment)
    v.sample, v.clip, v.score_sha = v.sample or sample, v.clip or clip, v.score_sha or sha
    if not v.over_casts:
        v.over_casts = [[s, c] for s, c, _ in (_cast_of(run_dir, o) for o in v.over) if s and c]
    v.at = v.at or dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    v.id = v.id or hashlib.sha256(f"{v.run}|{v.experiment}|{v.kind}|{v.at}|{v.note}".encode()).hexdigest()[:12]
    path = notebooks_dir(library) / "verdicts.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write(json.dumps(dataclasses.asdict(v), ensure_ascii=False) + "\n")
    return v


def read(*, library: pathlib.Path | None = None, run: str | None = None) -> list[Verdict]:
    path = notebooks_dir(library) / "verdicts.jsonl"
    if not path.exists():
        return []
    out = [Verdict(**json.loads(line)) for line in path.read_text().splitlines() if line.strip()]
    return [v for v in out if run is None or v.run == run]


def _liking(v: Verdict, sample: str, clip: str) -> list[float]:
    """What a verdict says about one clip, 0 (disliked) to 1 (loved): a rating, a win, or a loss."""
    out: list[float] = []
    if v.sample == sample and v.clip == clip:
        if v.kind == "stars":
            out.append((int(v.stars) - 1) / 4)
        elif v.kind == "pick":
            out.append(1.0)
    out += [0.0 for s, c in v.over_casts if s == sample and c == clip]
    return out


def taste(sample: str, clip: str, verdicts: list[Verdict] | None = None, *, library: pathlib.Path | None = None) -> float:
    """The layer validator's taste term for a clip: 1 − liking, smoothed toward 0.5 (unrated) by PRIOR
    verdicts' worth, so one rating moves it but doesn't decide it."""
    vs = read(library=library) if verdicts is None else verdicts
    likings = [x for v in vs for x in _liking(v, sample, clip)]
    liking = (0.5 * PRIOR + sum(likings)) / (PRIOR + len(likings))
    return round(1.0 - liking, 4)
